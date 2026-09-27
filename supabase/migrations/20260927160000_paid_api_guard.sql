-- Paid / abusable API protection: per-subject and global rate limits, daily/hourly quotas,
-- cooldowns, an emergency kill switch per endpoint, usage logging (no phone numbers or
-- tokens stored, only keyed hashes) and alert de-duplication.
-- Only Edge Functions (service_role) can call api_guard_check(); only super admins can read
-- the logs or change the limits.

-- 1. Settings: one row per protected endpoint. enabled = false is the kill switch.
create table if not exists public.api_guard_config (
  endpoint text primary key,
  enabled boolean not null default true,
  per_subject_cooldown_seconds integer not null default 0,
  per_subject_hourly integer,
  per_subject_daily integer,
  global_hourly integer,
  global_daily integer,
  alert_hourly_threshold integer,
  est_cost_paise integer not null default 0,
  blocked_message text,
  note text,
  updated_at timestamptz not null default now()
);

-- 2. Usage log. subject_hash = HMAC of (endpoint, phone/user/order) with a private pepper.
create table if not exists public.api_usage_log (
  id bigint generated always as identity primary key,
  endpoint text not null,
  subject_hash text,
  user_id uuid,
  allowed boolean not null,
  reason text,
  est_cost_paise integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists idx_api_usage_log_subject on public.api_usage_log (endpoint, subject_hash, created_at desc);
create index if not exists idx_api_usage_log_endpoint on public.api_usage_log (endpoint, created_at desc);

-- 3. Alerts already sent (one per endpoint per hour per kind).
create table if not exists public.api_usage_alerts (
  endpoint text not null,
  alert_key text not null,
  detail jsonb,
  created_at timestamptz not null default now(),
  primary key (endpoint, alert_key)
);

-- 4. Private pepper for hashing identifiers (no API role can read it).
create table if not exists public.api_guard_private (
  id boolean primary key default true check (id),
  pepper text not null
);
insert into public.api_guard_private (pepper)
values (encode(extensions.gen_random_bytes(32), 'hex'))
on conflict (id) do nothing;

alter table public.api_guard_config enable row level security;
alter table public.api_usage_log enable row level security;
alter table public.api_usage_alerts enable row level security;
alter table public.api_guard_private enable row level security;

revoke all on public.api_guard_config, public.api_usage_log, public.api_usage_alerts, public.api_guard_private
  from public, anon, authenticated;
grant select, update on public.api_guard_config to authenticated;
grant select on public.api_usage_log, public.api_usage_alerts to authenticated;

drop policy if exists api_guard_config_super_admin_read on public.api_guard_config;
create policy api_guard_config_super_admin_read on public.api_guard_config
  for select to authenticated using (public.is_super_admin());
drop policy if exists api_guard_config_super_admin_update on public.api_guard_config;
create policy api_guard_config_super_admin_update on public.api_guard_config
  for update to authenticated using (public.is_super_admin()) with check (public.is_super_admin());
drop policy if exists api_usage_log_super_admin_read on public.api_usage_log;
create policy api_usage_log_super_admin_read on public.api_usage_log
  for select to authenticated using (public.is_super_admin());
drop policy if exists api_usage_alerts_super_admin_read on public.api_usage_alerts;
create policy api_usage_alerts_super_admin_read on public.api_usage_alerts
  for select to authenticated using (public.is_super_admin());
-- api_guard_private: RLS on and no policies -> unreadable through the API.

-- 5. Default limits (edit rows to tune; set enabled = false to stop an endpoint immediately).
insert into public.api_guard_config
  (endpoint, per_subject_cooldown_seconds, per_subject_hourly, per_subject_daily, global_hourly, global_daily,
   alert_hourly_threshold, est_cost_paise, blocked_message, note)
values
  ('sms_otp', 30, 5, 10, 300, 2000, 100, 25,
   'Too many OTP requests for this number. Please try again later.',
   'MSG91 OTP SMS (paid). Subject = phone number.'),
  ('razorpay_create_order', 3, 20, 60, 600, 5000, 300, 0,
   'Too many payment attempts. Please wait a moment and try again.',
   'Razorpay order creation. Subject = user id.'),
  ('razorpay_create_order_ip', 0, 60, 300, null, null, null, 0,
   'Too many payment attempts. Please wait a moment and try again.',
   'Same endpoint, per client IP.'),
  ('razorpay_verify', 0, 30, 100, 1000, 10000, null, 0,
   'Too many verification attempts. Please try again later.',
   'Razorpay signature verification. Subject = user id.'),
  ('telegram_order_alert', 0, null, 1, 300, 3000, 200, 0,
   null,
   'City admin Telegram alert. Subject = order number (one alert per order).')
on conflict (endpoint) do nothing;

-- 6. The check: counts, cooldown, quotas, kill switch, logging and alert de-duplication in one
-- call. Serialised per subject with an advisory lock so parallel requests cannot skip a limit.
create or replace function public.api_guard_check(p_endpoint text, p_subject text default null, p_user_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  c public.api_guard_config;
  v_hash text;
  v_sub_hour integer := 0;
  v_sub_day integer := 0;
  v_last timestamptz;
  v_glob_hour integer := 0;
  v_glob_day integer := 0;
  v_reason text;
  v_allowed boolean;
  v_alert text;
  v_retry integer;
begin
  select * into c from public.api_guard_config where endpoint = p_endpoint;
  if not found then
    -- Unknown endpoint: allow but record it so it shows up in monitoring.
    insert into public.api_usage_log (endpoint, user_id, allowed, reason) values (p_endpoint, p_user_id, true, 'unconfigured');
    return jsonb_build_object('allowed', true, 'reason', 'unconfigured');
  end if;

  if p_subject is not null and length(p_subject) > 0 then
    select encode(extensions.hmac(p_endpoint || ':' || p_subject, pepper, 'sha256'), 'hex')
      into v_hash from public.api_guard_private;
  end if;

  perform pg_advisory_xact_lock(hashtext('api_guard:' || p_endpoint || ':' || coalesce(v_hash, '')));

  if not c.enabled then
    v_reason := 'disabled';
  else
    if v_hash is not null then
      select count(*) filter (where created_at > now() - interval '1 hour'),
             count(*),
             max(created_at)
        into v_sub_hour, v_sub_day, v_last
        from public.api_usage_log
       where endpoint = p_endpoint and subject_hash = v_hash and allowed
         and created_at > now() - interval '1 day';
      if c.per_subject_cooldown_seconds > 0 and v_last is not null
         and v_last > now() - make_interval(secs => c.per_subject_cooldown_seconds) then
        v_reason := 'cooldown';
        v_retry := ceil(extract(epoch from (v_last + make_interval(secs => c.per_subject_cooldown_seconds) - now())));
      elsif c.per_subject_hourly is not null and v_sub_hour >= c.per_subject_hourly then
        v_reason := 'subject_hourly_limit';
      elsif c.per_subject_daily is not null and v_sub_day >= c.per_subject_daily then
        v_reason := 'subject_daily_limit';
      end if;
    end if;

    select count(*) filter (where created_at > now() - interval '1 hour'), count(*)
      into v_glob_hour, v_glob_day
      from public.api_usage_log
     where endpoint = p_endpoint and allowed and created_at > now() - interval '1 day';
    if v_reason is null then
      if c.global_hourly is not null and v_glob_hour >= c.global_hourly then
        v_reason := 'global_hourly_limit';
      elsif c.global_daily is not null and v_glob_day >= c.global_daily then
        v_reason := 'global_daily_limit';
      end if;
    end if;
  end if;

  v_allowed := v_reason is null;
  insert into public.api_usage_log (endpoint, subject_hash, user_id, allowed, reason, est_cost_paise)
  values (p_endpoint, v_hash, p_user_id, v_allowed, v_reason, case when v_allowed then c.est_cost_paise else 0 end);

  -- Alerts: usage crossing the hourly threshold, or a global limit being hit (once per hour each).
  if v_allowed and c.alert_hourly_threshold is not null and v_glob_hour + 1 >= c.alert_hourly_threshold then
    insert into public.api_usage_alerts (endpoint, alert_key, detail)
    values (p_endpoint, 'threshold:' || to_char(now(), 'YYYY-MM-DD"T"HH24'),
            jsonb_build_object('hourly_count', v_glob_hour + 1, 'threshold', c.alert_hourly_threshold))
    on conflict do nothing;
    if found then v_alert := 'threshold'; end if;
  elsif v_reason in ('global_hourly_limit', 'global_daily_limit') then
    insert into public.api_usage_alerts (endpoint, alert_key, detail)
    values (p_endpoint, 'global_limit:' || to_char(now(), 'YYYY-MM-DD"T"HH24'),
            jsonb_build_object('reason', v_reason, 'hourly_count', v_glob_hour, 'daily_count', v_glob_day))
    on conflict do nothing;
    if found then v_alert := v_reason; end if;
  end if;

  return jsonb_build_object(
    'allowed', v_allowed,
    'reason', v_reason,
    'message', case when v_allowed then null else coalesce(c.blocked_message, 'Too many requests. Please try again later.') end,
    'retry_after_seconds', v_retry,
    'hourly_count', v_glob_hour + case when v_allowed then 1 else 0 end,
    'daily_count', v_glob_day + case when v_allowed then 1 else 0 end,
    'alert', v_alert
  );
end;
$$;

revoke all on function public.api_guard_check(text, text, uuid) from public, anon, authenticated;
grant execute on function public.api_guard_check(text, text, uuid) to service_role;

-- 7. Monitoring views for the admin (RLS on the log applies: super admins only).
create or replace view public.api_usage_hourly with (security_invoker = true) as
select endpoint,
       date_trunc('hour', created_at) as hour,
       count(*) filter (where allowed) as allowed_calls,
       count(*) filter (where not allowed) as blocked_calls,
       count(distinct subject_hash) as distinct_subjects,
       round(sum(est_cost_paise) / 100.0, 2) as est_cost_rupees
  from public.api_usage_log
 where created_at > now() - interval '7 days'
 group by 1, 2;

create or replace view public.api_usage_daily with (security_invoker = true) as
select endpoint,
       date_trunc('day', created_at) as day,
       count(*) filter (where allowed) as allowed_calls,
       count(*) filter (where not allowed) as blocked_calls,
       count(distinct subject_hash) as distinct_subjects,
       round(sum(est_cost_paise) / 100.0, 2) as est_cost_rupees
  from public.api_usage_log
 where created_at > now() - interval '90 days'
 group by 1, 2;

revoke all on public.api_usage_hourly, public.api_usage_daily from public, anon;
grant select on public.api_usage_hourly, public.api_usage_daily to authenticated;

-- 8. Keep the log small: drop entries older than 90 days, daily.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'api-usage-log-cleanup';
    perform cron.schedule('api-usage-log-cleanup', '17 3 * * *',
      $cron$delete from public.api_usage_log where created_at < now() - interval '90 days';
            delete from public.api_usage_alerts where created_at < now() - interval '90 days';$cron$);
  end if;
end $$;

-- 9. Close database functions that anyone with the public anon key could call.
-- notify_city_admins had no permission check: anyone could push fake notifications to city
-- admins. check_rate_limit let anyone write rate-limit rows. Both are only used by other
-- SECURITY DEFINER functions (owned by postgres), which keep working.
revoke execute on function public.notify_city_admins(uuid, text, text, jsonb) from public, anon, authenticated;
revoke execute on function public.check_rate_limit(text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.notify_city_admins(uuid, text, text, jsonb) to service_role;
grant execute on function public.check_rate_limit(text, text, integer, integer) to service_role;
-- Reveals city admin assignments; only signed-in apps need it.
revoke execute on function public.get_city_admin_assignment(uuid, uuid) from public, anon;
grant execute on function public.get_city_admin_assignment(uuid, uuid) to authenticated, service_role;
