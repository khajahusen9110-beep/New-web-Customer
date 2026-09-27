// Port of SndmartRepository.kt: the single data layer talking to Supabase.
import { supabase } from './supabase';
import { useSession } from '../store/session';
import { clearCartDirectly, useCart, type AddToCartResult } from '../store/cart';
import type {
  CartItem,
  CartItemUi,
  Category,
  City,
  CityDeliverySettings,
  CityLocationResult,
  Coupon,
  CouponValidationResult,
  CustomerAddress,
  CustomerNotification,
  DeliveryAssignment,
  DeliveryPartner,
  DeliveryPartnerReview,
  DeliverySlot,
  ExpressDeliverySettings,
  MaintenanceSettings,
  OperatingSlot,
  Order,
  OrderItem,
  OrderStatusHistory,
  Product,
  ProductCityStock,
  Profile,
  RazorpayOrderResponse,
  ResolvedProduct,
  ResolvedVariant,
  Vendor,
  VendorReview,
  WalletTransaction,
} from './types';
import { errorMessage, haversineKm, isHotelItemAvailable, isInStockAndActive, KNOWN_HUBS, toE164 } from './utils';

const CACHE_TTL_MS = 5 * 60 * 1000;
const SESSION_EXPIRED = 'Your session expired, please log in again';

type PgError = { code?: string; message?: string; status?: number } | null;

function fail(error: PgError, fallback: string): never {
  // PostgREST JWT errors mean the refresh token is gone too.
  if (error && (error.code === 'PGRST301' || /jwt/i.test(error.message ?? ''))) {
    useSession.getState().notifySessionExpired(SESSION_EXPIRED);
    throw new Error(SESSION_EXPIRED);
  }
  throw new Error(errorMessage(error, fallback));
}

// ---------- simple TTL cache ----------
const cache = new Map<string, { at: number; data: unknown }>();
function cacheGet<T>(key: string): T | null {
  const hit = cache.get(key);
  if (!hit || Date.now() - hit.at > CACHE_TTL_MS) return null;
  return hit.data as T;
}
const cacheSet = (key: string, data: unknown) => cache.set(key, { at: Date.now(), data });
export const clearCaches = () => cache.clear();
export function invalidateCache(prefix: string) {
  for (const k of Array.from(cache.keys())) if (k.startsWith(prefix)) cache.delete(k);
}

const num = (v: unknown, d = 0) => (v === null || v === undefined || v === '' ? d : Number(v));

// ---------- CITIES ----------

export async function getActiveCities(forceRefresh = false): Promise<City[]> {
  if (!forceRefresh) {
    const c = cacheGet<City[]>('cities');
    if (c) return c;
  }
  const { data, error } = await supabase
    .from('cities')
    .select('id,name,state,status,center_lat,center_lng,service_radius_km')
    .eq('status', 'active')
    .order('name', { ascending: true });
  if (error) fail(error, 'Unable to load cities from backend');
  const list = (data ?? []) as City[];
  cacheSet('cities', list);
  return list;
}

export async function findCityForLocation(lat: number, lng: number): Promise<CityLocationResult | null> {
  const { data, error } = await supabase.rpc('find_city_for_location', { p_lat: lat, p_lng: lng });
  if (error) fail(error, 'City detection failed');
  const rows = (data ?? []) as CityLocationResult[];
  return rows[0] ?? null;
}

export async function getCity(cityId: string): Promise<City | null> {
  const cities = await getActiveCities().catch(() => [] as City[]);
  const hit = cities.find((c) => c.id === cityId);
  if (hit) return hit;
  const { data } = await supabase.from('cities').select('*').eq('id', cityId).limit(1);
  return ((data ?? [])[0] as City) ?? null;
}

// ---------- PROFILE / AUTH ----------

export async function sendPhoneOtp(rawPhone: string) {
  const { error } = await supabase.auth.signInWithOtp({ phone: toE164(rawPhone) });
  if (error) throw new Error(errorMessage(error, 'Failed to send OTP. Please check your number.'));
}

export async function verifyPhoneOtp(rawPhone: string, token: string) {
  const { data, error } = await supabase.auth.verifyOtp({ phone: toE164(rawPhone), token, type: 'sms' });
  if (error || !data.user) throw new Error(errorMessage(error, 'OTP verification failed.'));
  return data;
}

export async function getProfile(userId: string, forceRefresh = false): Promise<Profile | null> {
  const key = `profile:${userId}`;
  if (!forceRefresh) {
    const c = cacheGet<Profile>(key);
    if (c) return c;
  }
  const { data, error } = await supabase.from('profiles').select('*').eq('id', userId).maybeSingle();
  if (error) fail(error, 'Failed to load profile.');
  if (data) cacheSet(key, data);
  return (data as Profile) ?? null;
}

export async function createProfile(profile: Profile): Promise<Profile> {
  const row = { ...profile, phone: profile.phone ? toE164(profile.phone) : profile.phone };
  const { data, error } = await supabase
    .from('profiles')
    .upsert(row, { onConflict: 'id' })
    .select()
    .maybeSingle();
  if (error) fail(error, 'Could not save profile. Please try again.');
  invalidateCache(`profile:${profile.id}`);
  return (data as Profile) ?? row;
}

export async function updateProfile(userId: string, fullName: string | null, phone: string | null) {
  const body: Record<string, unknown> = {};
  if (fullName !== null) body.full_name = fullName;
  if (phone !== null) body.phone = phone.trim() ? toE164(phone) : null;
  const { error } = await supabase.from('profiles').update(body).eq('id', userId);
  if (error) fail(error, 'Failed to update profile');
  invalidateCache(`profile:${userId}`);
}

export async function updateProfileCityId(userId: string, cityId: string) {
  const { error } = await supabase.from('profiles').update({ city_id: cityId }).eq('id', userId);
  if (error) fail(error, 'Failed to update delivery city on profile.');
  invalidateCache(`profile:${userId}`);
}

/** Single device login: this browser becomes the account's active device. */
export async function registerDeviceSession(userId: string) {
  const deviceId = useSession.getState().deviceId;
  const { error } = await supabase.from('profiles').update({ current_device_session: deviceId }).eq('id', userId);
  if (error) console.warn('current_device_session update failed', error);
  const { error: e2 } = await supabase.auth.signOut({ scope: 'others' });
  if (e2) console.warn('signOut(others) failed', e2);
  invalidateCache(`profile:${userId}`);
}

/** Logs this browser out if the account was used on another device. Returns false when logged out. */
export async function checkStillActiveDevice(): Promise<boolean> {
  const { userId, isLoggedIn, deviceId } = useSession.getState();
  if (!userId || !isLoggedIn) return true;
  try {
    const profile = await getProfile(userId, true);
    if (profile?.current_device_session && profile.current_device_session !== deviceId) {
      await signOut('local');
      useSession.getState().notifySessionExpired(
        'You were logged out because your account was used on another device.',
      );
      return false;
    }
  } catch (e) {
    console.warn('Device session check failed', e);
  }
  return true;
}

export async function signOut(scope: 'global' | 'local' | 'others' = 'local') {
  useCart.getState().clearLocal();
  clearCaches();
  const { error } = await supabase.auth.signOut({ scope });
  if (error) console.warn('signOut failed', error);
}

/** Resolves profiles.city_id to an active City, or null (first-time flow). */
export async function resolveUserCity(userId: string): Promise<City | null> {
  try {
    const profile = await getProfile(userId, true);
    if (!profile?.city_id) return null;
    const cities = await getActiveCities();
    return cities.find((c) => c.id === profile.city_id) ?? null;
  } catch {
    return null;
  }
}

// ---------- CATEGORIES / VENDORS ----------

export async function getGroceryCategories(forceRefresh = false): Promise<Category[]> {
  if (!forceRefresh) {
    const c = cacheGet<Category[]>('groceryCategories');
    if (c) return c;
  }
  const { data, error } = await supabase
    .from('categories')
    .select('id,name,image_url,sort_order,vendor_type')
    .eq('is_active', true)
    .in('vendor_type', ['grocery', 'vegetable', 'fruit'])
    .is('vendor_id', null)
    .order('sort_order', { ascending: true });
  if (error) fail(error, 'Categories fetch error');
  const list = (data ?? []) as Category[];
  cacheSet('groceryCategories', list);
  return list;
}

const vendorRank = (v: Vendor) => (v.is_active && v.is_featured ? 0 : v.is_active ? 1 : 2);
const VENDOR_COLS =
  'id,name,banner_url,is_active,is_featured,is_open,address,latitude,longitude,opening_time,closing_time';

export async function getHotels(
  cityId: string,
  searchQuery: string | null,
  limit = 20,
  offset = 0,
  forceRefresh = false,
): Promise<Vendor[]> {
  const q = (searchQuery ?? '').trim().toLowerCase();
  const key = `hotels:${cityId}:${q}:${offset}`;
  if (!forceRefresh) {
    const c = cacheGet<Vendor[]>(key);
    if (c) return c;
  }
  let query = supabase
    .from('vendors')
    .select(VENDOR_COLS)
    .eq('city_id', cityId)
    .eq('vendor_type', 'hotel')
    .eq('approval_status', 'approved')
    .order('is_featured', { ascending: false })
    .range(offset, offset + limit - 1);
  if (q) query = query.ilike('name', `%${q}%`);
  const { data, error } = await query;
  if (error) fail(error, 'Could not fetch hotels');
  const list = ((data ?? []) as Vendor[]).sort(
    (a, b) => vendorRank(a) - vendorRank(b) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
  );
  cacheSet(key, list);
  return list;
}

export async function getVendor(vendorId: string): Promise<Vendor | null> {
  const { data } = await supabase.from('vendors').select(VENDOR_COLS).eq('id', vendorId).maybeSingle();
  return (data as Vendor) ?? null;
}

export async function getVendorNames(ids: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const missing: string[] = [];
  for (const id of ids) {
    const n = cacheGet<string>(`vendorName:${id}`);
    if (n) out[id] = n;
    else missing.push(id);
  }
  if (missing.length) {
    const { data } = await supabase.from('vendors').select('id,name').in('id', Array.from(new Set(missing)));
    for (const v of (data ?? []) as { id: string; name: string }[]) {
      out[v.id] = v.name;
      cacheSet(`vendorName:${v.id}`, v.name);
    }
  }
  return out;
}

export async function getVendorOperatingSlots(vendorId: string): Promise<OperatingSlot[]> {
  const { data, error } = await supabase
    .from('vendor_operating_hours')
    .select('id,vendor_id,start_time,end_time,is_active')
    .eq('vendor_id', vendorId)
    .eq('is_active', true);
  if (error) return [];
  return (data ?? []) as OperatingSlot[];
}

export async function getVendorAverageRating(vendorId: string): Promise<number> {
  const { data, error } = await supabase.from('vendor_reviews').select('rating').eq('vendor_id', vendorId);
  if (error || !data?.length) return 0;
  const ratings = (data as { rating: number }[]).map((r) => Number(r.rating)).filter((r) => r > 0);
  return ratings.length ? ratings.reduce((a, b) => a + b, 0) / ratings.length : 0;
}

// ---------- PRODUCTS & CITY STOCK RESOLUTION ----------

const GROCERY_PRODUCT_COLS =
  'id,category_id,vendor_id,name,description,image_url,price,mrp,unit,stock_qty,is_available,is_active,is_featured,product_variants(id,label,is_active,product_variant_city_stock(price,stock_qty,is_available,city_id))';
const HOTEL_PRODUCT_COLS =
  'id,category_id,vendor_id,name,description,image_url,price,mrp,unit,stock_qty,is_available,is_active,is_featured,available_from,available_until';

function resolveVariants(prod: Product, cityId: string): ResolvedVariant[] {
  const variants = (prod.product_variants ?? []).filter((v) => v.is_active !== false);
  const out: ResolvedVariant[] = [];
  for (const v of variants) {
    const row = (v.product_variant_city_stock ?? []).find((s) => s.city_id === cityId || !s.city_id);
    if (row) {
      out.push({
        id: v.id,
        label: v.label,
        price: num(row.price),
        stockQty: num(row.stock_qty),
        isAvailable: row.is_available !== false,
      });
    }
  }
  return out.sort((a, b) => a.price - b.price);
}

// Grocery items (vendor_id IS NULL) are only sold where an active product_city_stock row
// exists; the checkout RPC rejects anything else. Hotel food is made to order, so city
// stock only overrides its price/availability.
function resolveProduct(
  prod: Product,
  override: ProductCityStock | undefined,
  cityId: string,
  stockLoadFailed = false,
): ResolvedProduct {
  const isGrocery = !prod.vendor_id;
  const available = isGrocery
    ? !!override && override.is_active !== false && override.is_available !== false
    : (override?.is_available ?? prod.is_available) !== false;
  const stockQty = isGrocery
    ? num(override?.stock_qty)
    : num(override?.stock_qty ?? prod.stock_qty ?? prod.stock_quantity);
  return {
    base: prod,
    id: prod.id,
    name: prod.name,
    description: prod.description,
    imageUrl: prod.image_url,
    unit: prod.unit,
    vendorId: prod.vendor_id,
    isFeatured: prod.is_featured === true,
    isActive: prod.is_active !== false,
    effectivePrice: num(override?.price ?? prod.price),
    effectiveMrp: override?.mrp ?? prod.mrp ?? null,
    effectiveStock: stockQty,
    effectiveIsAvailable: available,
    variants: resolveVariants(prod, cityId),
    stockLoadFailed: isGrocery && stockLoadFailed,
  };
}

/** City price/stock rows for the given products; `failed` means the request itself failed. */
async function getCityStockMap(cityId: string, productIds: string[]) {
  if (!productIds.length) return { map: new Map<string, ProductCityStock>(), failed: false };
  const { data, error } = await supabase
    .from('product_city_stock')
    .select('product_id,price,mrp,stock_qty,is_available,is_active')
    .eq('city_id', cityId)
    .in('product_id', productIds);
  if (error) console.warn('City stock request failed', error);
  return {
    map: new Map(((data ?? []) as ProductCityStock[]).map((s) => [s.product_id, s])),
    failed: !!error,
  };
}

export async function getResolvedGroceryProducts(p: {
  cityId: string;
  categoryId: string;
  searchQuery?: string | null;
  limit?: number;
  offset?: number;
  forceRefresh?: boolean;
}): Promise<ResolvedProduct[]> {
  const { cityId, categoryId, limit = 30, offset = 0, forceRefresh = false } = p;
  const q = (p.searchQuery ?? '').trim().toLowerCase();
  const key = `grocery:${cityId}:${categoryId}:${q}:${offset}`;
  if (!forceRefresh) {
    const c = cacheGet<ResolvedProduct[]>(key);
    if (c) return c;
  }
  let query = supabase
    .from('products')
    .select(GROCERY_PRODUCT_COLS)
    .eq('is_active', true)
    .eq('category_id', categoryId)
    .is('vendor_id', null)
    .range(offset, offset + limit - 1);
  if (q) query = query.ilike('name', `%${q}%`);
  const { data, error } = await query;
  if (error) fail(error, 'Could not fetch products');
  const products = (data ?? []) as unknown as Product[];
  const stock = await getCityStockMap(cityId, products.map((x) => x.id));
  const resolved = products
    .map((prod) => resolveProduct(prod, stock.map.get(prod.id), cityId, stock.failed))
    .sort(
      (a, b) =>
        Number(isInStockAndActive(b)) - Number(isInStockAndActive(a)) ||
        a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
    );
  // Never cache a page whose stock failed to load, so the next load retries.
  if (!stock.failed) cacheSet(key, resolved);
  return resolved;
}

export async function getHotelCategories(vendorId: string, forceRefresh = false): Promise<Category[]> {
  const key = `hotelCats:${vendorId}`;
  if (!forceRefresh) {
    const c = cacheGet<Category[]>(key);
    if (c) return c;
  }
  const { data, error } = await supabase
    .from('categories')
    .select('id,name,image_url,vendor_id,is_active,sort_order')
    .eq('vendor_id', vendorId)
    .eq('is_active', true)
    .order('sort_order', { ascending: true });
  if (error) fail(error, 'Could not fetch hotel categories');
  const list = (data ?? []) as Category[];
  cacheSet(key, list);
  return list;
}

export async function getHotelProducts(p: {
  vendorId: string;
  cityId: string;
  categoryId?: string | null;
  limit?: number;
  offset?: number;
  forceRefresh?: boolean;
}): Promise<ResolvedProduct[]> {
  const { vendorId, cityId, categoryId, limit = 25, offset = 0, forceRefresh = false } = p;
  const key = `hotelProducts:${vendorId}:${cityId}:${categoryId ?? ''}:${offset}`;
  if (!forceRefresh) {
    const c = cacheGet<ResolvedProduct[]>(key);
    if (c) return c;
  }
  let query = supabase
    .from('products')
    .select(HOTEL_PRODUCT_COLS)
    .eq('is_active', true)
    .eq('vendor_id', vendorId)
    .order('is_featured', { ascending: false })
    .range(offset, offset + limit - 1);
  if (categoryId) query = query.eq('category_id', categoryId);
  const { data, error } = await query;
  if (error) fail(error, 'Could not fetch hotel products');
  const products = (data ?? []) as unknown as Product[];
  const stock = await getCityStockMap(cityId, products.map((x) => x.id));
  const tier = (x: ResolvedProduct) => {
    const avail = isHotelItemAvailable(x);
    return avail && x.isFeatured ? 0 : avail ? 1 : 2;
  };
  const resolved = products
    .map((prod) => ({ ...resolveProduct(prod, stock.map.get(prod.id), cityId), variants: [] }))
    .sort((a, b) => tier(a) - tier(b) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  cacheSet(key, resolved);
  return resolved;
}

// ---------- FRESH CART PRICING ----------

/** Re-fetches current price/stock for every cart item (prices are never cached in the cart). */
export async function getFreshCartItems(items: CartItem[], cityId: string): Promise<CartItemUi[]> {
  if (!items.length) return [];
  const ids = Array.from(new Set(items.map((i) => i.product_id).filter(Boolean)));
  const [prodRes, stock] = await Promise.all([
    supabase.from('products').select(GROCERY_PRODUCT_COLS).in('id', ids),
    getCityStockMap(cityId, ids),
  ]);
  if (prodRes.error) fail(prodRes.error, 'Could not load live prices');
  if (stock.failed) throw new Error('Could not refresh prices');
  const products = new Map(((prodRes.data ?? []) as unknown as Product[]).map((x) => [x.id, x]));
  const out: CartItemUi[] = [];
  for (const item of items) {
    const prod = products.get(item.product_id);
    if (!prod) continue;
    const rp = resolveProduct(prod, stock.map.get(prod.id), cityId);
    const variant = item.variant_id ? rp.variants.find((v) => v.id === item.variant_id) ?? null : null;
    const price = variant?.price ?? rp.effectivePrice;
    out.push({
      cartItem: item,
      product: rp,
      variant,
      effectivePrice: price,
      totalPrice: price * item.quantity,
      displayName: variant?.label ? `${rp.name} - ${variant.label}` : rp.name,
    });
  }
  return out;
}

// ---------- DELIVERY ----------

export async function getDeliverySlots(cityId: string): Promise<DeliverySlot[]> {
  const { data, error } = await supabase
    .from('delivery_slots')
    .select('id,name,start_time,end_time,min_order_amount,is_free_delivery,delivery_fee,is_active,city_id')
    .eq('city_id', cityId)
    .eq('is_active', true)
    .order('start_time', { ascending: true });
  if (error) return [];
  return (data ?? []) as DeliverySlot[];
}

export async function getExpressDeliverySettings(cityId: string): Promise<ExpressDeliverySettings | null> {
  const { data, error } = await supabase
    .from('express_delivery_settings')
    .select('*')
    .eq('city_id', cityId)
    .eq('is_active', true);
  if (error) return null;
  return ((data ?? [])[0] as ExpressDeliverySettings) ?? null;
}

export async function getCityDeliverySettings(cityId: string): Promise<CityDeliverySettings | null> {
  const { data, error } = await supabase
    .from('city_delivery_settings')
    .select('city_id,free_delivery_min_order_amount,handling_fee')
    .eq('city_id', cityId)
    .maybeSingle();
  if (error) return null;
  return (data as CityDeliverySettings) ?? null;
}

export async function getFreeDeliveryThreshold(cityId: string): Promise<number | null> {
  const s = await getCityDeliverySettings(cityId);
  if (s?.free_delivery_min_order_amount != null) return Number(s.free_delivery_min_order_amount);
  const express = await getExpressDeliverySettings(cityId);
  return express?.free_delivery_min_order ?? null;
}

async function getPickupPoint(vendorId: string | null, cityId: string | null) {
  if (vendorId) {
    const v = await getVendor(vendorId);
    if (v?.latitude != null && v.longitude != null) return { lat: Number(v.latitude), lng: Number(v.longitude) };
  }
  if (cityId) {
    const c = await getCity(cityId);
    if (c?.center_lat != null && c.center_lng != null) return { lat: Number(c.center_lat), lng: Number(c.center_lng) };
  }
  return null;
}

/**
 * Hotel orders: distance from the hotel. Grocery orders: from the city centre
 * (the city's virtual dispatch hub). Same rules as the Android app.
 */
export async function resolveDeliveryDistanceKm(
  address: CustomerAddress | null,
  cityId: string | null,
  vendorId: string | null,
  isHotel: boolean,
): Promise<number> {
  if (!address || address.lat == null || address.lng == null) return 1;
  const lat = Number(address.lat);
  const lng = Number(address.lng);
  const pickup = await getPickupPoint(isHotel ? vendorId : null, cityId);
  if (pickup) {
    const d = haversineKm(lat, lng, pickup.lat, pickup.lng);
    if (d > 0) return d;
  }
  try {
    const r = await findCityForLocation(lat, lng);
    if (r?.distance_km && r.distance_km > 0) return Number(r.distance_km);
  } catch {
    /* fall through */
  }
  const cities = await getActiveCities().catch(() => [] as City[]);
  const city = cities.find((c) => c.id === cityId) ?? cities[0];
  if (city?.center_lat != null && city.center_lng != null) {
    return haversineKm(lat, lng, Number(city.center_lat), Number(city.center_lng));
  }
  const hub = KNOWN_HUBS[(city?.name ?? 'sindhanur').trim().toLowerCase()] ?? KNOWN_HUBS.sindhanur;
  return haversineKm(lat, lng, hub[0], hub[1]);
}

// ---------- COUPONS ----------

export async function getCoupons(cityId: string): Promise<Coupon[]> {
  const { data, error } = await supabase.from('coupons').select('*').eq('city_id', cityId).eq('is_active', true);
  if (error) return [];
  return (data ?? []) as Coupon[];
}

export async function validateAndApplyCoupon(
  code: string,
  cityId: string,
  subtotal: number,
): Promise<CouponValidationResult> {
  const trimmed = code.trim().toUpperCase();
  if (!trimmed) return { isValid: false, discountAmount: 0, errorMessage: 'Please enter a coupon code' };
  const { data, error } = await supabase
    .from('coupons')
    .select('*')
    .eq('city_id', cityId)
    .eq('is_active', true)
    .eq('code', trimmed)
    .limit(1);
  if (error) fail(error, 'Coupon validation failed');
  const coupon = ((data ?? [])[0] as Coupon) ?? null;
  const bad = (msg: string): CouponValidationResult => ({ isValid: false, coupon, discountAmount: 0, errorMessage: msg });
  if (!coupon) return bad('Invalid or inactive coupon for this city');
  if (!coupon.is_active) return bad('This coupon is no longer active');
  const now = Date.now();
  // The database treats a coupon without a start date as not active.
  if (!coupon.starts_at || now < Date.parse(coupon.starts_at)) return bad('Coupon is not active yet');
  if (coupon.expires_at && now > Date.parse(coupon.expires_at)) return bad('Coupon has expired');
  const minOrder = num(coupon.min_order_amount);
  if (subtotal < minOrder) return bad(`Minimum order of ₹${minOrder.toFixed(0)} required for this coupon`);
  if (coupon.usage_limit != null && num(coupon.used_count) >= coupon.usage_limit) {
    return bad('Coupon usage limit reached');
  }
  // Same maths as calculate_city_coupon_discount() in the database, which the checkout
  // RPC uses to charge the order: 'percent' (rounded to paise) or 'flat'.
  const isPercent = coupon.discount_type === 'percent' || coupon.discount_type === 'percentage';
  let discount = isPercent
    ? Math.round(subtotal * num(coupon.discount_value)) / 100
    : num(coupon.discount_value);
  if (coupon.max_discount_amount != null && discount > coupon.max_discount_amount) {
    discount = Number(coupon.max_discount_amount);
  }
  discount = Math.min(discount, subtotal);
  return { isValid: true, coupon, discountAmount: discount };
}

// ---------- ADDRESSES ----------

export async function getAddresses(userId: string): Promise<CustomerAddress[]> {
  const { data, error } = await supabase
    .from('customer_addresses')
    .select('*')
    .eq('user_id', userId)
    .order('is_default', { ascending: false })
    .order('id', { ascending: false });
  if (error) fail(error, 'Failed to load addresses');
  return (data ?? []) as CustomerAddress[];
}

export async function getAddressById(id: string): Promise<CustomerAddress | null> {
  const { data } = await supabase.from('customer_addresses').select('*').eq('id', id).maybeSingle();
  return (data as CustomerAddress) ?? null;
}

export async function addAddress(address: CustomerAddress): Promise<CustomerAddress> {
  const { id: _omit, ...row } = address;
  void _omit;
  const { data, error } = await supabase.from('customer_addresses').insert(row).select().single();
  if (error) fail(error, 'Failed to save delivery address.');
  return data as CustomerAddress;
}

export async function updateAddress(id: string, fields: Partial<CustomerAddress>) {
  const { error } = await supabase.from('customer_addresses').update(fields).eq('id', id);
  if (error) fail(error, 'Failed to update address');
}

export async function deleteAddress(id: string) {
  const { error } = await supabase.from('customer_addresses').delete().eq('id', id);
  if (error) fail(error, 'Failed to delete address');
}

/** Only one default address: unset the previous default first. */
export async function setDefaultAddress(userId: string, addressId: string) {
  const current = await getAddresses(userId);
  for (const prev of current.filter((a) => a.is_default && a.id !== addressId)) {
    if (prev.id) await updateAddress(prev.id, { is_default: false });
  }
  await updateAddress(addressId, { is_default: true });
}

// ---------- CHECKOUT (backend-authoritative RPCs) ----------

// Returns null when the response has no order id; never invent one.
function parseOrderFromRpc(data: unknown): Order | null {
  const fallback = (id: string): Order => ({
    id,
    order_number: '',
    customer_id: '',
    status: 'confirmed',
    payment_method: 'cash',
    payment_status: 'pending',
    subtotal: 0,
    discount_amount: 0,
    delivery_fee: 0,
    handling_fee: 0,
    total_amount: 0,
  });
  if (typeof data === 'string') {
    const id = data.replace(/^"|"$/g, '').trim();
    return id ? fallback(id) : null;
  }
  const obj = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null | undefined;
  if (!obj || typeof obj !== 'object') return null;
  const id = (obj.id ?? obj.order_id) as string | undefined;
  if (!id) return null;
  return { ...fallback(id), ...(obj as Partial<Order>), id };
}

export async function checkMaintenanceMode(): Promise<MaintenanceSettings> {
  const { data, error } = await supabase.from('app_settings').select('value').eq('key', 'maintenance_mode').limit(1);
  if (error || !data?.length) return { enabled: false };
  const value = (data[0] as { value: unknown }).value;
  if (value && typeof value === 'object') {
    const v = value as { enabled?: boolean; message?: string | null };
    return { enabled: v.enabled === true, message: v.message?.trim() ? v.message : null };
  }
  return { enabled: value === true };
}

export async function placeOrder(p: {
  userId: string;
  isHotel: boolean;
  vendorId: string | null;
  addressId: string;
  paymentMethod: 'cod' | 'upi';
  coupon: Coupon | null;
}): Promise<Order> {
  const { groceryCart, hotelCart } = useCart.getState();
  const raw = (p.isHotel ? hotelCart : groceryCart).filter((i) => i.quantity > 0);
  if (!raw.length) throw new Error('Cart is empty');
  if (!p.addressId) throw new Error('Please select a delivery address');

  const maintenance = await checkMaintenanceMode();
  if (maintenance.enabled) {
    throw new Error(maintenance.message ?? 'Service temporarily unavailable. Please try again shortly.');
  }

  // Only COD and UPI (Razorpay) have a working payment flow; never create an unpaid "card" order.
  if ((p.paymentMethod as string) === 'card') {
    throw new Error('Card payment is not available. Please choose UPI or Cash on Delivery.');
  }
  const paymentMethod = p.paymentMethod === 'cod' ? 'cash' : p.paymentMethod;
  const items = raw.map((i) => ({ product_id: i.product_id, variant_id: i.variant_id ?? null, quantity: i.quantity }));
  const args: Record<string, unknown> = {
    p_address_id: p.addressId,
    p_payment_method: paymentMethod,
    p_items: items,
    p_notes: null,
  };
  // The checkout RPC validates the coupon, applies the discount to the order total and
  // records the usage itself, so the customer is charged exactly what checkout showed.
  // Do not send p_slot_id / p_delivery_type: the RPCs do not accept them yet.
  args.p_coupon_code = p.coupon?.code?.trim().toUpperCase() || null;
  if (p.isHotel) {
    const vendorId = p.vendorId || raw.find((i) => i.vendor_id)?.vendor_id;
    if (!vendorId) throw new Error('Hotel / Vendor ID is missing for this order');
    args.p_vendor_id = vendorId;
  }
  const fn = p.isHotel ? 'checkout_food_order' : 'checkout_grocery_order';

  // One retry for transient network errors only; DB/validation errors are final.
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { data, error } = await supabase.rpc(fn, args);
      if (error) throw Object.assign(new Error(errorMessage(error, 'Failed to place order')), { final: true });
      // The RPC succeeded, so the order exists: nothing after this point may retry (duplicate order).
      const order = parseOrderFromRpc(data);
      if (!order) {
        throw Object.assign(new Error('Order status unknown. Please check My Orders before trying again.'), { final: true });
      }
      try {
        await clearCartDirectly(p.isHotel);
      } catch {
        // Cart cleanup failing must not hide a placed order.
      }
      return order;
    } catch (e) {
      if ((e as { final?: boolean }).final) throw e;
      lastErr = e;
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  throw new Error(errorMessage(lastErr, 'Failed to place order'));
}

// ---------- RAZORPAY (edge functions) ----------

export async function createRazorpayOrder(orderId: string): Promise<RazorpayOrderResponse> {
  const { data, error } = await supabase.functions.invoke('create-razorpay-order', { body: { order_id: orderId } });
  if (error) throw new Error('Could not start payment. Please try again.');
  const json = (typeof data === 'string' ? JSON.parse(data) : data) as Record<string, unknown>;
  const rzpOrderId = (json.razorpay_order_id ?? json.order_id ?? json.id) as string | undefined;
  if (!rzpOrderId) throw new Error((json.message ?? json.error ?? 'Could not create payment order') as string);
  return {
    keyId: (json.key_id ?? json.key ?? '') as string,
    amount: Number(json.amount ?? 0),
    currency: (json.currency ?? 'INR') as string,
    razorpayOrderId: rzpOrderId,
  };
}

export async function verifyRazorpayPayment(p: {
  orderId: string;
  razorpayOrderId: string;
  razorpayPaymentId: string;
  razorpaySignature: string;
}): Promise<boolean> {
  const { data, error } = await supabase.functions.invoke('verify-razorpay-payment', {
    body: {
      order_id: p.orderId,
      razorpay_order_id: p.razorpayOrderId,
      razorpay_payment_id: p.razorpayPaymentId,
      razorpay_signature: p.razorpaySignature,
    },
  });
  if (error) return false;
  const json = (typeof data === 'string' ? JSON.parse(data) : data) as { success?: boolean };
  return json?.success === true;
}

// ---------- ORDERS ----------

export async function getOrders(userId: string, limit = 20, offset = 0): Promise<Order[]> {
  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .eq('customer_id', userId)
    .order('placed_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) fail(error, 'Failed to fetch orders');
  return (data ?? []) as Order[];
}

export async function getCompletedOrderCount(userId: string): Promise<number> {
  const { count, error } = await supabase
    .from('orders')
    .select('id', { count: 'exact', head: true })
    .eq('customer_id', userId)
    .eq('status', 'delivered');
  if (error) return 0;
  return count ?? 0;
}

export async function getOrderById(orderId: string): Promise<Order> {
  const joined = await supabase
    .from('orders')
    .select('*,delivery_partners(id,name,phone,latitude,longitude,vehicle_type,vehicle_number)')
    .eq('id', orderId)
    .maybeSingle();
  if (!joined.error && joined.data) return joined.data as unknown as Order;
  const plain = await supabase.from('orders').select('*').eq('id', orderId).maybeSingle();
  if (plain.error) fail(plain.error, 'Failed to load order');
  if (!plain.data) throw new Error(`Order not found: ${orderId}`);
  return plain.data as Order;
}

export async function getOrderItems(orderId: string): Promise<OrderItem[]> {
  const { data } = await supabase.from('order_items').select('*').eq('order_id', orderId);
  return ((data ?? []) as OrderItem[]).map((i) => ({ ...i, quantity: Number(i.quantity) }));
}

export async function getOrderStatusHistory(orderId: string): Promise<OrderStatusHistory[]> {
  const { data } = await supabase
    .from('order_status_history')
    .select('*')
    .eq('order_id', orderId)
    .order('created_at', { ascending: true });
  return (data ?? []) as OrderStatusHistory[];
}

export async function getDeliveryAssignment(orderId: string): Promise<DeliveryAssignment | null> {
  const { data } = await supabase
    .from('delivery_assignments')
    .select('status,accepted_at,estimated_delivery_minutes,estimated_delivery_at,delivery_otp,delivery_partner_id,order_id')
    .eq('order_id', orderId)
    .order('created_at', { ascending: false })
    .limit(1);
  return ((data ?? [])[0] as DeliveryAssignment) ?? null;
}

export const isAssignmentAccepted = (a: DeliveryAssignment | null) => {
  const s = a?.status?.toLowerCase().trim();
  return s === 'accepted' || s === 'picked_up' || s === 'out_for_delivery';
};

export async function getDeliveryPartner(partnerId: string): Promise<DeliveryPartner | null> {
  const { data } = await supabase
    .from('delivery_partners')
    .select('id,name,phone,latitude,longitude,vehicle_type,vehicle_number')
    .eq('id', partnerId)
    .maybeSingle();
  return (data as DeliveryPartner) ?? null;
}

/** Copies order items back into the cart after re-checking availability. */
export async function reorder(orderItems: OrderItem[], cityId: string): Promise<string> {
  const ids = Array.from(new Set(orderItems.map((i) => i.product_id).filter(Boolean)));
  if (!ids.length) return 'No items to reorder.';
  const [prodRes, stock] = await Promise.all([
    supabase.from('products').select('id,vendor_id,is_active,is_available').in('id', ids),
    getCityStockMap(cityId, ids),
  ]);
  if (prodRes.error || stock.failed) throw new Error('Could not check item availability. Please try again.');
  const products = new Map(((prodRes.data ?? []) as Product[]).map((x) => [x.id, x]));
  let added = 0;
  const skipped: string[] = [];
  for (const item of orderItems) {
    const prod = products.get(item.product_id);
    // Same city rule as the product lists: grocery items need an active city stock row.
    const avail = !!prod && resolveProduct(prod, stock.map.get(item.product_id), cityId).effectiveIsAvailable;
    if (prod && prod.is_active !== false && avail) {
      const res: AddToCartResult = useCart.getState().addToCart({
        productId: item.product_id,
        vendorId: item.vendor_id ?? null,
        cityId,
        quantityDelta: item.quantity,
        isHotel: !!item.vendor_id,
      });
      if (res.kind === 'hotelConflict') skipped.push(`'${item.product_name}' conflicts with your current hotel cart.`);
      else added++;
    } else {
      skipped.push(`'${item.product_name}' is no longer available.`);
    }
  }
  return `${added} of ${orderItems.length} items added to cart.${skipped.length ? ' ' + skipped.join(' ') : ''}`;
}

// ---------- REVIEWS ----------

export async function submitVendorReview(r: VendorReview) {
  const { error } = await supabase.from('vendor_reviews').insert(r);
  if (error) fail(error, 'Failed to submit review');
}

export async function submitDeliveryPartnerReview(r: DeliveryPartnerReview) {
  const { error } = await supabase.from('delivery_partner_reviews').insert(r);
  if (error) fail(error, 'Failed to submit review');
}

export async function getMyVendorReviews(customerId: string, limit = 20): Promise<VendorReview[]> {
  const { data, error } = await supabase
    .from('vendor_reviews')
    .select('*')
    .eq('customer_id', customerId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) fail(error, 'Failed to load reviews');
  return (data ?? []) as VendorReview[];
}

export async function getMyDeliveryPartnerReviews(customerId: string, limit = 20): Promise<DeliveryPartnerReview[]> {
  const { data, error } = await supabase
    .from('delivery_partner_reviews')
    .select('*')
    .eq('customer_id', customerId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) fail(error, 'Failed to load reviews');
  return (data ?? []) as DeliveryPartnerReview[];
}

export async function getReviewedOrderIds(customerId: string): Promise<Set<string>> {
  const ids = new Set<string>();
  const [v, d] = await Promise.all([
    getMyVendorReviews(customerId, 200).catch(() => []),
    getMyDeliveryPartnerReviews(customerId, 200).catch(() => []),
  ]);
  for (const r of [...v, ...d]) if (r.order_id) ids.add(r.order_id);
  return ids;
}

// ---------- WALLET ----------

export async function getWalletTransactions(customerId: string, limit = 20, offset = 0): Promise<WalletTransaction[]> {
  const { data, error } = await supabase
    .from('customer_wallet_transactions')
    .select('*')
    .eq('customer_id', customerId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) fail(error, 'Failed to load wallet');
  return (data ?? []) as WalletTransaction[];
}

// ---------- NOTIFICATIONS ----------

export async function getCustomerNotifications(userId: string, limit = 20, offset = 0): Promise<CustomerNotification[]> {
  const { data, error } = await supabase
    .from('notifications')
    .select('id,user_id,title,body,data,is_read,created_at')
    .eq('user_id', userId)
    .eq('user_type', 'customer')
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) fail(error, 'Failed to load notifications');
  return (data ?? []) as CustomerNotification[];
}

export async function refreshUnreadNotificationCount(userId: string) {
  const { count, error } = await supabase
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('user_type', 'customer')
    .eq('is_read', false);
  if (!error) useSession.getState().setUnreadNotificationCount(count ?? 0);
}

export async function markNotificationAsRead(id: string) {
  const { error } = await supabase.from('notifications').update({ is_read: true }).eq('id', id);
  if (!error) useSession.getState().decrementUnread();
}

export async function markAllNotificationsAsRead(userId: string) {
  const { error } = await supabase
    .from('notifications')
    .update({ is_read: true })
    .eq('user_id', userId)
    .eq('user_type', 'customer')
    .eq('is_read', false);
  if (error) fail(error, 'Could not mark all as read');
  useSession.getState().setUnreadNotificationCount(0);
}
