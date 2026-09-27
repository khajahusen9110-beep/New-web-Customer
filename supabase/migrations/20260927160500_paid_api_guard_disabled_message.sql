-- When an endpoint is switched off (kill switch), say so instead of "too many requests".
do $$
declare src text;
begin
  select pg_get_functiondef('public.api_guard_check(text,text,uuid)'::regprocedure) into src;
  src := replace(src,
    $a$'message', case when v_allowed then null else coalesce(c.blocked_message, 'Too many requests. Please try again later.') end,$a$,
    $b$'message', case when v_allowed then null
                       when v_reason = 'disabled' then 'This service is temporarily unavailable. Please try again later.'
                       else coalesce(c.blocked_message, 'Too many requests. Please try again later.') end,$b$);
  if position('temporarily unavailable' in src) = 0 then raise exception 'patch did not apply'; end if;
  execute src;
end $$;
