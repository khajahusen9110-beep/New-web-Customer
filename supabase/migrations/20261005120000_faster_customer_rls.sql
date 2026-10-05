-- Faster customer reads: same permissions, evaluated once per query instead of once per row.
--
-- vendors_customer_city_read looked up the caller's profile (with the profiles policies) for
-- every vendor row, which cost ~300 ms on every hotel list and on every policy that checks
-- "vendor_id IN (SELECT id FROM vendors ...)". The caller's city is now read once through a
-- SECURITY DEFINER helper (only the caller's own row, exactly what the old EXISTS could see).
-- Session-only functions are wrapped in (select ...) so Postgres runs them once per statement.

create or replace function public.rls_my_city_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$ select city_id from public.profiles where id = auth.uid() $$;

revoke all on function public.rls_my_city_id() from public, anon;
grant execute on function public.rls_my_city_id() to authenticated;

alter policy vendors_customer_city_read on public.vendors
  using (
    (select public.is_admin())
    or user_id = (select auth.uid())
    or (city_id is not null and city_id = (select public.rls_my_city_id()))
  );

alter policy vendors_admin_all on public.vendors
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

alter policy orders_customer_own_read on public.orders
  using (customer_id = (select auth.uid()));

alter policy orders_select_role on public.orders
  using (
    (select public.is_admin())
    or customer_id = (select auth.uid())
    or (vendor_id = (select public.current_vendor_id())
        and (payment_method <> 'upi'::payment_method or payment_status = 'paid'::payment_status))
    or delivery_partner_id = (select public.current_delivery_partner_id())
  );

alter policy cart_items_owner_all on public.cart_items
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
