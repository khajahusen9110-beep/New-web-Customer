-- Signed-in customers could not read city prices/stock: an earlier migration re-granted only
-- INSERT/UPDATE/DELETE to authenticated. The RLS policy product_city_stock_public_read already
-- allows everyone to read (anon has SELECT), so restore the missing table privilege.
grant select on public.product_city_stock to authenticated;
