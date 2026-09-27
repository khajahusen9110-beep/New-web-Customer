-- SECURITY FIX: any signed-in user could make themselves super admin.
-- The profiles RLS policy lets users update their own row (all columns), and
-- trg_sync_user_role_membership copies profiles.role into user_role_memberships, which
-- is_super_admin() trusts. So `update profiles set role = 'super_admin' where id = auth.uid()`
-- granted full admin rights. Same for vendors changing their own commission/approval.
--
-- These triggers only let privileged callers change the protected columns:
--   * database-side code (SECURITY DEFINER functions run as postgres, auth triggers) and
--     Edge Functions using the service role;
--   * super admins / admins; city admins for their own city where the apps already allow it.
-- Normal profile edits (name, phone, city, device session) and vendor edits (open/closed,
-- hours, banner, address...) keep working.

-- SECURITY INVOKER on purpose: current_user must be the caller's role, not the function owner.
create or replace function public.is_privileged_writer()
returns boolean
language sql
stable
set search_path = public
as $$
  select current_user in ('postgres', 'supabase_admin', 'service_role', 'supabase_auth_admin')
      or coalesce(public.is_super_admin(), false)
      or coalesce(public.is_admin(), false);
$$;
revoke all on function public.is_privileged_writer() from public, anon;
grant execute on function public.is_privileged_writer() to authenticated, service_role;

create or replace function public.guard_profile_privileged_columns()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if public.is_privileged_writer() then
    return new;
  end if;

  if tg_op = 'INSERT' then
    -- Self-created profiles are customers (the auth trigger creates the row with that default).
    if new.role is distinct from 'customer'::public.app_role then
      raise exception 'Not allowed to set this role' using errcode = '42501';
    end if;
    return new;
  end if;

  -- Low-privilege roles may still be set by the apps' own onboarding flows; staff roles never.
  if new.role is distinct from old.role
     and (new.role::text in ('admin', 'super_admin', 'city_admin') or old.role::text in ('admin', 'super_admin', 'city_admin')) then
    raise exception 'Not allowed to change this role' using errcode = '42501';
  end if;

  -- Account blocking is decided by admins (or the user's city admin), not by the user.
  if new.is_active is distinct from old.is_active
     and not (old.city_id is not null and public.is_city_admin_for(old.city_id)) then
    raise exception 'Not allowed to change account status' using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_guard_profile_privileged_columns on public.profiles;
create trigger trg_guard_profile_privileged_columns
  before insert or update on public.profiles
  for each row execute function public.guard_profile_privileged_columns();

create or replace function public.guard_vendor_privileged_columns()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if public.is_privileged_writer() or (old.city_id is not null and public.is_city_admin_for(old.city_id)) then
    return new;
  end if;
  if new.commission_percent is distinct from old.commission_percent
     or new.is_featured is distinct from old.is_featured
     or new.user_id is distinct from old.user_id
     or new.city_id is distinct from old.city_id
     or new.vendor_type is distinct from old.vendor_type
     or (new.approval_status is distinct from old.approval_status and new.approval_status::text <> 'pending') then
    raise exception 'Only an admin can change commission, approval, featured status, city or owner' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_vendor_privileged_columns on public.vendors;
create trigger trg_guard_vendor_privileged_columns
  before update on public.vendors
  for each row execute function public.guard_vendor_privileged_columns();
