-- Apply coupons inside the checkout RPCs so the discount a customer sees is the
-- discount they are charged. Before this, checkout_* ignored coupons entirely:
-- orders.discount_amount was always 0 and coupons.used_count never increased.
--
-- Backward compatible: p_coupon_code is a new LAST parameter with DEFAULT NULL,
-- so existing callers (the Android app) that do not send it keep working
-- unchanged. The old signatures are dropped first so PostgREST never sees two
-- overloads for the same call.
--
-- Everything else in both functions is copied unchanged from the live definitions.

begin;

drop function if exists public.checkout_grocery_order(uuid, public.payment_method, jsonb, text);
drop function if exists public.checkout_food_order(uuid, uuid, public.payment_method, jsonb, text);

create function public.checkout_grocery_order(
  p_address_id uuid,
  p_payment_method payment_method,
  p_items jsonb,
  p_notes text default null::text,
  p_coupon_code text default null::text
)
 returns orders
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  o public.orders; a public.customer_addresses; me public.profiles; x jsonb;
  pr public.products; pv public.product_variants; vcs public.product_variant_city_stock; cs public.product_city_stock;
  qty numeric; unit numeric;
  v_subtotal numeric := 0; v_total numeric; v_delivery numeric := 0; v_handling numeric := 0;
  v_pickup_lat numeric; v_pickup_lng numeric; v_distance_km numeric;
  v_discount numeric := 0; c public.coupons;
begin
  if public.is_maintenance_mode() then raise exception 'Service is temporarily unavailable for maintenance. Please try again shortly.'; end if;
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if not public.check_rate_limit(auth.uid()::text, 'checkout', 8, 120) then
    raise exception 'Too many checkout attempts — please wait a moment and try again';
  end if;
  select * into me from public.profiles where id=auth.uid() and is_active=true;
  if me.id is null or not public.has_app_role('customer'::public.app_role) then raise exception 'Customer access required'; end if;
  select * into a from public.customer_addresses where id=p_address_id and user_id=auth.uid();
  if a.id is null or (a.city_id is not null and a.city_id<>me.city_id) then raise exception 'Invalid address city'; end if;
  if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)=0 then raise exception 'Cart is empty'; end if;

  insert into public.orders(customer_id,vendor_id,address_id,city_id,city_name_snapshot,payment_method,payment_status,subtotal,discount_amount,delivery_fee,handling_fee,total_amount,commission_amount,vendor_amount,notes,placed_at)
  values(auth.uid(),null,a.id,me.city_id,(select name from public.cities where id=me.city_id),p_payment_method,'pending',0,0,0,0,0,0,0,p_notes,now())
  returning * into o;

  for x in select * from jsonb_array_elements(p_items) loop
    qty:=coalesce((x->>'quantity')::numeric,0);
    if qty<=0 then raise exception 'Invalid quantity'; end if;
    select * into pr from public.products where id=(x->>'product_id')::uuid and vendor_id is null and is_active=true;
    if pr.id is null then raise exception 'Product unavailable'; end if;

    if x ? 'variant_id' and nullif(x->>'variant_id','') is not null then
      select * into pv from public.product_variants where id=(x->>'variant_id')::uuid and product_id=pr.id and is_active=true;
      if pv.id is null then raise exception 'Variant unavailable'; end if;
      select * into vcs from public.product_variant_city_stock where variant_id=pv.id and city_id=me.city_id and is_active=true and is_available=true for update;
      if vcs.id is null then raise exception '% (%) is not available in your city',pr.name,pv.label; end if;
      if vcs.stock_qty<qty then raise exception '% (%) — only % in stock',pr.name,pv.label,vcs.stock_qty; end if;
      unit:=vcs.price;
      update public.product_variant_city_stock set stock_qty=stock_qty-qty,updated_at=now() where id=vcs.id;
      insert into public.order_items(order_id,product_id,variant_id,product_name,variant_label,quantity,unit_price,total_price,vendor_id)
        values(o.id,pr.id,pv.id,pr.name,pv.label,qty,unit,qty*unit,null);
    else
      select * into cs from public.product_city_stock where product_id=pr.id and city_id=me.city_id and is_active=true and is_available=true for update;
      if cs.id is null then raise exception '% is not available in your city',pr.name; end if;
      if cs.stock_qty<qty then raise exception '% — only % % in stock',pr.name,cs.stock_qty,coalesce(pr.unit,''); end if;
      unit:=cs.price;
      update public.product_city_stock set stock_qty=stock_qty-qty,updated_at=now() where id=cs.id;
      insert into public.order_items(order_id,product_id,variant_id,product_name,variant_label,quantity,unit_price,total_price,vendor_id)
        values(o.id,pr.id,null,pr.name,coalesce(pr.unit,''),qty,unit,qty*unit,null);
    end if;
    v_subtotal:=v_subtotal+(qty*unit);
  end loop;

  -- Real delivery fee from configured distance tiers + real handling fee from city settings
  select dz.center_latitude, dz.center_longitude into v_pickup_lat, v_pickup_lng
  from public.delivery_zones dz where dz.city_id=me.city_id and dz.is_active=true order by dz.created_at asc limit 1;

  if v_pickup_lat is not null and a.lat is not null then
    v_distance_km := (point(a.lng, a.lat) <-> point(v_pickup_lng, v_pickup_lat)) * 111.0; -- approx degrees to km
  else
    v_distance_km := 0;
  end if;

  v_delivery := public.calculate_delivery_fee(me.city_id, v_distance_km, v_subtotal);
  v_handling := public.get_handling_fee(me.city_id);

  -- Coupon: lock the row so concurrent orders cannot exceed usage_limit, then let the
  -- existing calculate_city_coupon_discount() validate it and compute the amount.
  if nullif(trim(p_coupon_code),'') is not null then
    select * into c from public.coupons
      where city_id=me.city_id and upper(code)=upper(trim(p_coupon_code)) and is_active=true
      for update;
    if c.id is null then raise exception 'Invalid or expired coupon'; end if;
    v_discount := public.calculate_city_coupon_discount(me.city_id, p_coupon_code, v_subtotal);
    update public.coupons set used_count=coalesce(used_count,0)+1 where id=c.id;
    insert into public.coupon_usages(coupon_id,user_id,order_id) values(c.id,auth.uid(),o.id);
  end if;

  v_total:=v_subtotal-v_discount+v_delivery+v_handling;
  perform set_config('sndmart.internal_checkout', 'true', true);
  update public.orders set subtotal=v_subtotal,discount_amount=v_discount,delivery_fee=v_delivery,handling_fee=v_handling,total_amount=v_total,commission_amount=0,vendor_amount=0,updated_at=now()
    where id=o.id returning * into o;
  return o;
end;
$function$;

create function public.checkout_food_order(
  p_vendor_id uuid,
  p_address_id uuid,
  p_payment_method payment_method,
  p_items jsonb,
  p_notes text default null::text,
  p_coupon_code text default null::text
)
 returns orders
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  o public.orders; v public.vendors; a public.customer_addresses; me public.profiles; x jsonb;
  pr public.products; pv public.product_variants;
  qty numeric; unit numeric;
  v_subtotal numeric := 0; v_total numeric; v_commission numeric; v_vendor_amt numeric;
  v_delivery numeric := 0; v_handling numeric := 0; v_distance_km numeric;
  v_discount numeric := 0; c public.coupons;
begin
  if public.is_maintenance_mode() then raise exception 'Service is temporarily unavailable for maintenance. Please try again shortly.'; end if;
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if not public.check_rate_limit(auth.uid()::text, 'checkout', 8, 120) then
    raise exception 'Too many checkout attempts — please wait a moment and try again';
  end if;
  select * into me from public.profiles where id=auth.uid() and is_active=true;
  if me.id is null or not public.has_app_role('customer'::public.app_role) then raise exception 'Customer access required'; end if;
  select * into v from public.vendors where id=p_vendor_id and is_active=true;
  if v.id is null or v.city_id<>me.city_id then raise exception 'Vendor is outside your selected city'; end if;
  select * into a from public.customer_addresses where id=p_address_id and user_id=auth.uid();
  if a.id is null or (a.city_id is not null and a.city_id<>me.city_id) then raise exception 'Invalid address city'; end if;
  if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)=0 then raise exception 'Cart is empty'; end if;

  insert into public.orders(customer_id,vendor_id,address_id,city_id,city_name_snapshot,payment_method,payment_status,subtotal,discount_amount,delivery_fee,handling_fee,total_amount,commission_amount,vendor_amount,notes,placed_at)
  values(auth.uid(),v.id,a.id,v.city_id,(select name from public.cities where id=v.city_id),p_payment_method,'pending',0,0,0,0,0,0,0,p_notes,now())
  returning * into o;

  for x in select * from jsonb_array_elements(p_items) loop
    qty:=coalesce((x->>'quantity')::numeric,0);
    if qty<=0 then raise exception 'Invalid quantity'; end if;
    select * into pr from public.products where id=(x->>'product_id')::uuid and vendor_id=v.id and is_active=true and is_available=true;
    if pr.id is null then raise exception 'Product unavailable'; end if;
    unit:=pr.price;
    if x ? 'variant_id' and nullif(x->>'variant_id','') is not null then
      select * into pv from public.product_variants where id=(x->>'variant_id')::uuid and product_id=pr.id and is_active=true and is_available=true;
      if pv.id is null then raise exception 'Variant unavailable'; end if;
      unit:=pv.price;
    end if;
    insert into public.order_items(order_id,product_id,variant_id,product_name,variant_label,quantity,unit_price,total_price,vendor_id)
      values(o.id,pr.id,nullif(x->>'variant_id','')::uuid,pr.name,coalesce(pv.label,''),qty,unit,qty*unit,v.id);
    v_subtotal:=v_subtotal+(qty*unit);
  end loop;

  if v.latitude is not null and a.lat is not null then
    v_distance_km := (point(a.lng, a.lat) <-> point(v.longitude, v.latitude)) * 111.0;
  else
    v_distance_km := 0;
  end if;
  v_delivery := public.calculate_delivery_fee(v.city_id, v_distance_km, v_subtotal);
  v_handling := public.get_handling_fee(v.city_id);

  if nullif(trim(p_coupon_code),'') is not null then
    select * into c from public.coupons
      where city_id=v.city_id and upper(code)=upper(trim(p_coupon_code)) and is_active=true
      for update;
    if c.id is null then raise exception 'Invalid or expired coupon'; end if;
    v_discount := public.calculate_city_coupon_discount(v.city_id, p_coupon_code, v_subtotal);
    update public.coupons set used_count=coalesce(used_count,0)+1 where id=c.id;
    insert into public.coupon_usages(coupon_id,user_id,order_id) values(c.id,auth.uid(),o.id);
  end if;

  -- Commission stays on the food subtotal (unchanged); the coupon discount is platform-funded.
  v_commission:=round(v_subtotal*0.15,2);
  v_vendor_amt:=v_subtotal-v_commission;
  v_total:=v_subtotal-v_discount+v_delivery+v_handling;
  perform set_config('sndmart.internal_checkout', 'true', true);
  update public.orders set subtotal=v_subtotal,discount_amount=v_discount,delivery_fee=v_delivery,handling_fee=v_handling,total_amount=v_total,commission_amount=v_commission,vendor_amount=v_vendor_amt,updated_at=now()
    where id=o.id returning * into o;
  return o;
end;
$function$;

-- Same privileges as the live functions: callable by signed-in users only.
revoke all on function public.checkout_grocery_order(uuid, public.payment_method, jsonb, text, text) from public, anon;
revoke all on function public.checkout_food_order(uuid, uuid, public.payment_method, jsonb, text, text) from public, anon;
grant execute on function public.checkout_grocery_order(uuid, public.payment_method, jsonb, text, text) to authenticated, service_role;
grant execute on function public.checkout_food_order(uuid, uuid, public.payment_method, jsonb, text, text) to authenticated, service_role;

commit;

notify pgrst, 'reload schema';
