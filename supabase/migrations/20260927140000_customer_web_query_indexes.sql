-- Indexes for the customer website's queries that had no supporting index.
-- All additive (IF NOT EXISTS); no table, column or policy changes.

-- Hotel cards / menu: active operating hours for a set of vendors.
create index if not exists idx_vendor_operating_hours_vendor_active
  on public.vendor_operating_hours (vendor_id, is_active);

-- Hotel cards: ratings for a set of vendors.
create index if not exists idx_vendor_reviews_vendor
  on public.vendor_reviews (vendor_id);

-- My Reviews page: a customer's latest reviews.
create index if not exists idx_vendor_reviews_customer_created
  on public.vendor_reviews (customer_id, created_at desc);
create index if not exists idx_delivery_partner_reviews_customer_created
  on public.delivery_partner_reviews (customer_id, created_at desc);

-- Wallet page: a customer's latest transactions.
create index if not exists idx_wallet_transactions_customer_created
  on public.customer_wallet_transactions (customer_id, created_at desc);

-- My Orders: a customer's orders, newest placed first.
create index if not exists idx_orders_customer_placed
  on public.orders (customer_id, placed_at desc nulls last, created_at desc);

-- Grocery list: active city-wide (vendor_id is null) products of one category, by name.
create index if not exists idx_products_grocery_category_name
  on public.products (category_id, name)
  where vendor_id is null and is_active;
