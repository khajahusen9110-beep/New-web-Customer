-- Home-screen promotional banners managed by the Super Admin (image + text + where a tap goes).
-- Customers can read only banners that are switched on and inside their start/end time;
-- only super admins can create, edit or delete them (table and image bucket).

create table if not exists public.promo_banners (
  id uuid primary key default gen_random_uuid(),
  city_id uuid references public.cities(id) on delete cascade,          -- null = every city
  placement text not null default 'grocery' check (placement in ('grocery', 'food', 'both')),
  image_url text not null check (image_url ~ '^https://'),
  title text check (char_length(title) <= 60),
  subtitle text check (char_length(subtitle) <= 90),
  cta_text text check (char_length(cta_text) <= 24),
  show_text boolean not null default true,                              -- false: the image already has its text
  link_type text not null default 'none' check (link_type in ('none', 'category', 'hotel', 'url')),
  link_value text,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  starts_at timestamptz,
  ends_at timestamptz,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint promo_banners_dates check (starts_at is null or ends_at is null or ends_at > starts_at),
  constraint promo_banners_link check (
    link_type = 'none'
    or (link_type in ('category', 'hotel') and link_value ~ '^[0-9a-fA-F-]{36}$')
    or (link_type = 'url' and link_value ~ '^https://')
  )
);

create index if not exists promo_banners_live_idx on public.promo_banners (is_active, placement, sort_order);

drop trigger if exists promo_banners_updated_at on public.promo_banners;
create trigger promo_banners_updated_at before update on public.promo_banners
  for each row execute function public.set_updated_at();

alter table public.promo_banners enable row level security;

drop policy if exists promo_banners_live_read on public.promo_banners;
create policy promo_banners_live_read on public.promo_banners
  for select to anon, authenticated
  using (is_active and (starts_at is null or starts_at <= now()) and (ends_at is null or ends_at > now()));

drop policy if exists promo_banners_super_admin_all on public.promo_banners;
create policy promo_banners_super_admin_all on public.promo_banners
  for all to authenticated
  using ((select public.is_super_admin()))
  with check ((select public.is_super_admin()));

grant select on public.promo_banners to anon, authenticated;
grant insert, update, delete on public.promo_banners to authenticated;

-- Image bucket: public read (shown on the website), uploads by super admins only, images up to 5 MB.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('promo-banners', 'promo-banners', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists promo_banners_img_read on storage.objects;
create policy promo_banners_img_read on storage.objects
  for select to anon, authenticated using (bucket_id = 'promo-banners');

drop policy if exists promo_banners_img_insert on storage.objects;
create policy promo_banners_img_insert on storage.objects
  for insert to authenticated with check (bucket_id = 'promo-banners' and (select public.is_super_admin()));

drop policy if exists promo_banners_img_update on storage.objects;
create policy promo_banners_img_update on storage.objects
  for update to authenticated
  using (bucket_id = 'promo-banners' and (select public.is_super_admin()))
  with check (bucket_id = 'promo-banners' and (select public.is_super_admin()));

drop policy if exists promo_banners_img_delete on storage.objects;
create policy promo_banners_img_delete on storage.objects
  for delete to authenticated using (bucket_id = 'promo-banners' and (select public.is_super_admin()));
