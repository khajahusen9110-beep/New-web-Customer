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
import { errorMessage, haversineKm, isHotelItemAvailable, isInStockAndActive, KNOWN_HUBS, sortGroceryProducts, toE164 } from './utils';

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

// ---------- TTL cache + in-flight request sharing ----------
// Stable data (cities, categories, city settings) lives longer than lists.
const STABLE_TTL_MS = 30 * 60 * 1000;
const cache = new Map<string, { at: number; ttl: number; data: unknown }>();
const inflight = new Map<string, Promise<unknown>>();
function cacheGet<T>(key: string): T | null {
  const hit = cache.get(key);
  if (!hit || Date.now() - hit.at > hit.ttl) return null;
  return hit.data as T;
}
const cacheSet = (key: string, data: unknown, ttl = CACHE_TTL_MS) => cache.set(key, { at: Date.now(), ttl, data });
export const clearCaches = () => {
  cache.clear();
  inflight.clear();
};
export function invalidateCache(prefix: string) {
  for (const k of Array.from(cache.keys())) if (k.startsWith(prefix)) cache.delete(k);
  for (const k of Array.from(inflight.keys())) if (k.startsWith(prefix)) inflight.delete(k);
}

/**
 * Returns the cached value for `key`, or runs `load` once: callers asking for the same key
 * while a request is running share that request instead of sending a duplicate.
 * `load` may return `{ value, cache: false }` to skip caching (e.g. partial failures).
 */
async function cached<T>(
  key: string,
  ttl: number,
  load: () => Promise<T | { value: T; cache: false }>,
  force = false,
): Promise<T> {
  if (!force) {
    const hit = cacheGet<T>(key);
    if (hit !== null) return hit;
    const running = inflight.get(key);
    if (running) return running as Promise<T>;
  }
  const p = (async () => {
    const r = await load();
    if (r && typeof r === 'object' && (r as { cache?: unknown }).cache === false) return (r as { value: T }).value;
    cacheSet(key, r, ttl);
    return r as T;
  })();
  inflight.set(key, p);
  try {
    return await p;
  } finally {
    if (inflight.get(key) === p) inflight.delete(key);
  }
}

const num = (v: unknown, d = 0) => (v === null || v === undefined || v === '' ? d : Number(v));

// ---------- CITIES ----------

const CITY_COLS = 'id,name,state,status,center_lat,center_lng,service_radius_km';

export function getActiveCities(forceRefresh = false): Promise<City[]> {
  return cached(
    'cities',
    STABLE_TTL_MS,
    async () => {
      const { data, error } = await supabase
        .from('cities')
        .select(CITY_COLS)
        .eq('status', 'active')
        .order('name', { ascending: true });
      if (error) fail(error, 'Unable to load cities from backend');
      return (data ?? []) as City[];
    },
    forceRefresh,
  );
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
  const { data } = await supabase.from('cities').select(CITY_COLS).eq('id', cityId).limit(1);
  return ((data ?? [])[0] as City) ?? null;
}

// ---------- PROFILE / AUTH ----------

/** `captchaToken` is required once CAPTCHA is enabled in Supabase Auth (see Turnstile.tsx). */
export async function sendPhoneOtp(rawPhone: string, captchaToken?: string | null) {
  const { error } = await supabase.auth.signInWithOtp({
    phone: toE164(rawPhone),
    options: captchaToken ? { captchaToken } : undefined,
  });
  if (error) throw new Error(errorMessage(error, 'Failed to send OTP. Please check your number.'));
}

export async function verifyPhoneOtp(rawPhone: string, token: string) {
  const { data, error } = await supabase.auth.verifyOtp({ phone: toE164(rawPhone), token, type: 'sms' });
  if (error || !data.user) throw new Error(errorMessage(error, 'OTP verification failed.'));
  return data;
}

const PROFILE_COLS = 'id,role,full_name,email,phone,city_id,current_device_session';

export function getProfile(userId: string, forceRefresh = false): Promise<Profile | null> {
  return cached(
    `profile:${userId}`,
    CACHE_TTL_MS,
    async () => {
      const { data, error } = await supabase.from('profiles').select(PROFILE_COLS).eq('id', userId).maybeSingle();
      if (error) fail(error, 'Failed to load profile.');
      // Do not cache "no profile yet": the first-login flow creates it right after.
      return data ? (data as Profile) : { value: null, cache: false as const };
    },
    forceRefresh,
  );
}

export async function createProfile(profile: Profile): Promise<Profile> {
  const row = { ...profile, phone: profile.phone ? toE164(profile.phone) : profile.phone };
  const { data, error } = await supabase
    .from('profiles')
    .upsert(row, { onConflict: 'id' })
    .select(PROFILE_COLS)
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
    // Runs every 2 minutes, so read just the one column instead of the whole profile.
    const { data, error } = await supabase.from('profiles').select('current_device_session').eq('id', userId).maybeSingle();
    if (error) throw error;
    const active = (data as { current_device_session?: string | null } | null)?.current_device_session;
    if (active && active !== deviceId) {
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

export function getGroceryCategories(forceRefresh = false): Promise<Category[]> {
  return cached(
    'groceryCategories',
    STABLE_TTL_MS,
    async () => {
      const { data, error } = await supabase
        .from('categories')
        .select('id,name,image_url,sort_order,vendor_type')
        .eq('is_active', true)
        .in('vendor_type', ['grocery', 'vegetable', 'fruit'])
        .is('vendor_id', null)
        .order('sort_order', { ascending: true });
      if (error) fail(error, 'Categories fetch error');
      return (data ?? []) as Category[];
    },
    forceRefresh,
  );
}

const VENDOR_COLS =
  'id,name,banner_url,is_active,is_featured,is_open,address,latitude,longitude,opening_time,closing_time';

export function getHotels(
  cityId: string,
  searchQuery: string | null,
  limit = 20,
  offset = 0,
  forceRefresh = false,
  /** Only these hotels (e.g. the ones serving a chosen dish). */
  vendorIds?: string[] | null,
): Promise<Vendor[]> {
  const q = (searchQuery ?? '').trim().toLowerCase();
  const ids = vendorIds ? Array.from(new Set(vendorIds)).sort() : null;
  if (ids && !ids.length) return Promise.resolve([]);
  return cached(
    `hotels:${cityId}:${q}:${offset}:${limit}:${ids ? ids.join(',') : '*'}`,
    CACHE_TTL_MS,
    async () => {
      let query = supabase
        .from('vendors')
        .select(VENDOR_COLS)
        .eq('city_id', cityId)
        .eq('vendor_type', 'hotel')
        .eq('approval_status', 'approved')
        .order('is_featured', { ascending: false })
        .order('name', { ascending: true })
        .range(offset, offset + limit - 1);
      if (q) query = query.ilike('name', `%${q}%`);
      if (ids) query = query.in('id', ids);
      const { data, error } = await query;
      if (error) fail(error, 'Could not fetch hotels');
      // Server order (featured, name) keeps paging stable; the page orders by open-now + featured
      // (sortHotels) once it has the hours, and re-orders as hotels open and close.
      const list = (data ?? []) as Vendor[];
      // Hotel cards need hours and rating: fetch both for the whole page in 2 requests
      // (instead of 2 per card) and keep them in the cache for the cards and the menu page.
      await Promise.all([primeOperatingSlots(list.map((v) => v.id)), primeAverageRatings(list.map((v) => v.id))]);
      for (const v of list) cacheSet(`vendor:${v.id}`, v);
      return list;
    },
    forceRefresh,
  );
}

export function getVendor(vendorId: string, forceRefresh = false): Promise<Vendor | null> {
  return cached(
    `vendor:${vendorId}`,
    CACHE_TTL_MS,
    async () => {
      const { data } = await supabase.from('vendors').select(VENDOR_COLS).eq('id', vendorId).maybeSingle();
      return data ? (data as Vendor) : { value: null, cache: false as const };
    },
    forceRefresh,
  );
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

/** One request for the operating hours of many vendors; results are cached per vendor. */
async function primeOperatingSlots(vendorIds: string[]) {
  const missing = vendorIds.filter((id) => cacheGet(`slots:${id}`) === null);
  if (!missing.length) return;
  const { data, error } = await supabase
    .from('vendor_operating_hours')
    .select('id,vendor_id,start_time,end_time,is_active')
    .in('vendor_id', missing)
    .eq('is_active', true);
  if (error) return; // cards fall back to opening/closing time; the menu page retries
  const rows = (data ?? []) as OperatingSlot[];
  for (const id of missing) cacheSet(`slots:${id}`, rows.filter((r) => r.vendor_id === id));
}

export async function getVendorOperatingSlots(vendorId: string, forceRefresh = false): Promise<OperatingSlot[]> {
  return cached(`slots:${vendorId}`, CACHE_TTL_MS, async () => {
    const { data, error } = await supabase
      .from('vendor_operating_hours')
      .select('id,vendor_id,start_time,end_time,is_active')
      .eq('vendor_id', vendorId)
      .eq('is_active', true);
    if (error) return { value: [] as OperatingSlot[], cache: false as const };
    return (data ?? []) as OperatingSlot[];
  }, forceRefresh);
}

/** One request for the ratings of many vendors; averages are cached per vendor. */
async function primeAverageRatings(vendorIds: string[]) {
  const missing = vendorIds.filter((id) => cacheGet(`rating:${id}`) === null);
  if (!missing.length) return;
  const { data, error } = await supabase.from('vendor_reviews').select('vendor_id,rating').in('vendor_id', missing);
  if (error) return;
  const sums = new Map<string, { total: number; n: number }>();
  for (const r of (data ?? []) as { vendor_id: string; rating: number }[]) {
    const rating = Number(r.rating);
    if (!(rating > 0)) continue;
    const cur = sums.get(r.vendor_id) ?? { total: 0, n: 0 };
    sums.set(r.vendor_id, { total: cur.total + rating, n: cur.n + 1 });
  }
  for (const id of missing) {
    const s = sums.get(id);
    cacheSet(`rating:${id}`, s ? s.total / s.n : 0);
  }
}

export async function getVendorAverageRating(vendorId: string): Promise<number> {
  const hit = cacheGet<number>(`rating:${vendorId}`);
  if (hit !== null) return hit;
  await primeAverageRatings([vendorId]);
  return cacheGet<number>(`rating:${vendorId}`) ?? 0;
}

/**
 * Hours and ratings for a list of hotels: whatever is not cached yet is fetched for all of them in
 * one request each (never one per card). A vendor missing from `slots` means its hours could not be
 * loaded; callers then use its opening/closing time.
 */
export async function getHotelExtras(vendorIds: string[]) {
  const ids = Array.from(new Set(vendorIds));
  await Promise.all([primeOperatingSlots(ids), primeAverageRatings(ids)]);
  const slots: Record<string, OperatingSlot[]> = {};
  const ratings: Record<string, number> = {};
  for (const id of ids) {
    const s = cacheGet<OperatingSlot[]>(`slots:${id}`);
    if (s) slots[id] = s;
    ratings[id] = cacheGet<number>(`rating:${id}`) ?? 0;
  }
  return { slots, ratings };
}

/** Already-fetched hours/rating for a vendor (filled by getHotels), without a request. */
export const peekVendorExtras = (vendorId: string) => ({
  slots: cacheGet<OperatingSlot[]>(`slots:${vendorId}`),
  rating: cacheGet<number>(`rating:${vendorId}`),
});

// ---------- HOTEL DISH CATEGORIES ("What's on your mind?") ----------

export interface DishCategory {
  key: string;
  name: string;
  imageUrl: string | null;
  vendorIds: string[];
  /** Hotel menu sections grouped under this dish (e.g. each hotel's "Biryani's"). */
  categoryIds: string[];
}

/** A hotel's items that match a dish, cheapest first, with this city's price. */
export interface DishMatch {
  id: string;
  name: string;
  price: number;
  available: boolean;
}

// Menu sections that are not a dish people look for.
const GENERIC_SECTIONS = new Set(['general', 'dish', 'dishe', 'other', 'misc', 'uncategorized', 'mud', 'kaju', 'papad', 'naati']);

/** Section name without noise words: "HALF BIRIYANI'S" -> "biriyani", "RICE ITEMS" -> "rice". */
function cleanSectionName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/['’]s\b/g, '')
    .replace(/[^a-z\s&-]/g, ' ')
    .replace(/\b(half|full|items?|variet(y|ies)|verit(y|ies)|veriety|special|spl|combo)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Groups hotels' own menu sections ("Rotis", "ROTI", "HALF BIRIYANI'S") into one dish name. */
function dishKey(raw: string): string {
  let k = cleanSectionName(raw);
  if (/b[ie]r[iy]?y?ani|briyani/.test(k)) return 'biryani';
  if (/\b(mocktail|moctail|mojito)/.test(k)) return 'mocktail';
  if (/\bshakes?\b|milkshake/.test(k)) return 'shake';
  if (/\b(see|sea) ?food/.test(k)) return 'seafood';
  if (/\bice[- ]?cream/.test(k)) return 'ice cream';
  if (/\b(roti|parota|paratha|naan|chapati)/.test(k)) return 'roti';
  if (/\bfries\b/.test(k)) return 'fries';
  if (/\bmomo|\bmamo/.test(k)) return 'momos';
  // Singular last word: curries -> curry, rolls -> roll, burgers -> burger.
  k = k.replace(/ies$/, 'y').replace(/([^s])s$/, '$1');
  return k;
}

const DISH_LABELS: Record<string, string> = {
  biryani: 'Biryani',
  mocktail: 'Mocktails',
  shake: 'Shakes',
  'ice cream': 'Ice Cream',
  roti: 'Roti & Parota',
  fries: 'Fries',
  momos: 'Momos',
  seafood: 'Seafood',
};
const titleCase = (s: string) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());

/**
 * Dish categories across this city's approved hotels, with an image each, most common first.
 * One request (hotel menu sections joined to their hotel); cached like other stable data.
 */
export function getHotelDishCategories(cityId: string, forceRefresh = false): Promise<DishCategory[]> {
  return cached(
    `dishCats:${cityId}`,
    STABLE_TTL_MS,
    async () => {
      const query = supabase
        .from('categories')
        .select(DISH_CATEGORY_COLS)
        .eq('is_active', true)
        .not('vendor_id', 'is', null)
        .eq('vendors.city_id', cityId)
        .eq('vendors.vendor_type', 'hotel')
        .eq('vendors.approval_status', 'approved')
        .limit(1000);
      const { data, error } = (await query) as {
        data: { id: string; name: string; image_url: string | null; vendor_id: string }[] | null;
        error: PgError;
      };
      if (error) fail(error, 'Could not load dishes');
      const groups = new Map<string, DishCategory>();
      for (const row of data ?? []) {
        const key = dishKey(row.name ?? '');
        if (!key || key.length < 3 || GENERIC_SECTIONS.has(key)) continue;
        const g = groups.get(key) ?? {
          key,
          name: DISH_LABELS[key] ?? titleCase(cleanSectionName(row.name ?? '')),
          imageUrl: null,
          vendorIds: [],
          categoryIds: [],
        };
        g.imageUrl ??= row.image_url ?? null;
        if (!g.vendorIds.includes(row.vendor_id)) g.vendorIds.push(row.vendor_id);
        g.categoryIds.push(row.id);
        groups.set(key, g);
      }
      return Array.from(groups.values())
        .filter((g) => g.imageUrl)
        .sort((a, b) => b.vendorIds.length - a.vendorIds.length || a.name.localeCompare(b.name));
    },
    forceRefresh,
  );
}
const DISH_CATEGORY_COLS: string = 'id,name,image_url,vendor_id,vendors!inner(id)';

/** Words that identify a dish in item names ("Chicken Dum Biryani" is a biryani wherever it is listed). */
function dishSearchTerms(key: string): string[] {
  const synonyms: Record<string, string[]> = {
    biryani: ['biryani', 'biriyani', 'briyani'],
    roti: ['roti', 'parota', 'paratha', 'naan', 'chapati', 'kulcha'],
    shake: ['shake'],
    mocktail: ['mocktail', 'moctail', 'mojito'],
    'ice cream': ['ice cream', 'icecream', 'ice-cream'],
    fries: ['fries'],
    momos: ['momo', 'mamo'],
    seafood: ['fish', 'prawn', 'seafood'],
  };
  if (synonyms[key]) return synonyms[key];
  // curry -> "curr" also finds "curries"; others as they are (noodle finds noodles).
  return [key.endsWith('y') ? key.slice(0, -1) : key];
}

const DISH_PRODUCT_COLS: string =
  'id,name,price,vendor_id,category_id,is_available,is_active,is_featured,available_from,available_until,' +
  'product_city_stock(product_id,price,mrp,stock_qty,is_available,is_active),vendors!inner(id)';

/**
 * Hotels in this city serving a dish, and which of their items match (by item name, or by being
 * in a menu section of that dish), with this city's prices. One request, cached for 5 minutes.
 */
export function getHotelsServingDish(
  cityId: string,
  dish: DishCategory,
): Promise<{ vendorIds: string[]; matches: Record<string, DishMatch[]> }> {
  return cached(`dishHotels:${cityId}:${dish.key}`, CACHE_TTL_MS, async () => {
    const quote = (v: string) => `"${v.replace(/"/g, '')}"`;
    const filters = dishSearchTerms(dish.key).map((t) => `name.ilike.${quote(`*${t}*`)}`);
    if (dish.categoryIds.length) filters.push(`category_id.in.(${dish.categoryIds.join(',')})`);
    const query = supabase
      .from('products')
      .select(DISH_PRODUCT_COLS)
      .eq('is_active', true)
      .not('vendor_id', 'is', null)
      .or(filters.join(','))
      .eq('vendors.city_id', cityId)
      .eq('vendors.vendor_type', 'hotel')
      .eq('vendors.approval_status', 'approved')
      .eq('product_city_stock.city_id', cityId)
      .limit(500);
    const { data, error } = (await query) as { data: Product[] | null; error: PgError };
    if (error) fail(error, 'Could not load hotels for this dish');
    const matches: Record<string, DishMatch[]> = {};
    for (const prod of data ?? []) {
      if (!prod.vendor_id) continue;
      const rp = resolveProduct(prod, cityStockOf(prod), cityId);
      (matches[prod.vendor_id] ??= []).push({
        id: rp.id,
        name: rp.name,
        price: rp.effectivePrice,
        available: isHotelItemAvailable(rp),
      });
    }
    for (const list of Object.values(matches)) {
      list.sort((a, b) => Number(b.available) - Number(a.available) || a.price - b.price);
    }
    return { vendorIds: Object.keys(matches), matches };
  });
}

// ---------- PRODUCTS & CITY STOCK RESOLUTION ----------

// City price/stock is embedded in the product request (one round trip instead of two) and
// filtered to the current city by withCityStock().
const CITY_STOCK_EMBED = 'product_city_stock(product_id,price,mrp,stock_qty,is_available,is_active)';
const GROCERY_PRODUCT_COLS =
  'id,category_id,vendor_id,name,description,image_url,price,mrp,unit,stock_qty,is_available,is_active,is_featured,' +
  'product_variants(id,label,is_active,product_variant_city_stock(price,stock_qty,is_available,is_active,city_id)),' +
  CITY_STOCK_EMBED;
const HOTEL_PRODUCT_COLS =
  'id,category_id,vendor_id,name,description,image_url,price,mrp,unit,stock_qty,is_available,is_active,is_featured,available_from,available_until,' +
  CITY_STOCK_EMBED;
// Cart lines can hold grocery and hotel items.
const CART_PRODUCT_COLS =
  'id,category_id,vendor_id,name,description,image_url,price,mrp,unit,stock_qty,is_available,is_active,is_featured,available_from,available_until,' +
  'product_variants(id,label,is_active,product_variant_city_stock(price,stock_qty,is_available,is_active,city_id)),' +
  CITY_STOCK_EMBED;

/** Limits the embedded stock rows to this city (variant rows: this city or city-less). */
function withCityStock<Q>(query: Q, cityId: string, variants = true): Q {
  // Loosely typed on purpose: the builder's full generic type is too deep for TypeScript here.
  type Filters = {
    eq: (column: string, value: string) => Filters;
    or: (filters: string, opts: { referencedTable: string }) => Filters;
  };
  let q = (query as unknown as Filters).eq('product_city_stock.city_id', cityId);
  if (variants) {
    q = q.or(`city_id.eq.${cityId},city_id.is.null`, { referencedTable: 'product_variants.product_variant_city_stock' });
  }
  return q as unknown as Q;
}

const REORDER_PRODUCT_COLS = 'id,vendor_id,is_active,is_available,' + CITY_STOCK_EMBED;

const cityStockOf = (prod: Product) => (prod.product_city_stock ?? [])[0];

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
        isAvailable: row.is_available !== false && row.is_active !== false,
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

export function getResolvedGroceryProducts(p: {
  cityId: string;
  categoryId: string;
  searchQuery?: string | null;
  limit?: number;
  offset?: number;
  forceRefresh?: boolean;
}): Promise<ResolvedProduct[]> {
  const { cityId, categoryId, limit = 30, offset = 0, forceRefresh = false } = p;
  const q = (p.searchQuery ?? '').trim().toLowerCase();
  return cached(
    `grocery:${cityId}:${categoryId}:${q}:${offset}:${limit}`,
    CACHE_TTL_MS,
    async () => {
      // Only this category's page, with this city's stock embedded, filtered in the database.
      let query = withCityStock(
        supabase
          .from('products')
          .select(GROCERY_PRODUCT_COLS)
          .eq('is_active', true)
          .eq('category_id', categoryId)
          .is('vendor_id', null),
        cityId,
      )
        .order('is_featured', { ascending: false })
        .order('name', { ascending: true })
        .range(offset, offset + limit - 1);
      if (q) query = query.ilike('name', `%${q}%`);
      const { data, error } = await query;
      if (error) fail(error, 'Could not fetch products');
      const products = (data ?? []) as unknown as Product[];
      return sortGroceryProducts(products.map((prod) => resolveProduct(prod, cityStockOf(prod), cityId)));
    },
    forceRefresh,
  );
}

/**
 * Up to 10 featured grocery products that are in stock and available in this city, for the
 * "Featured Products" row. One request (city stock embedded), cached for 5 minutes.
 */
export function getFeaturedGroceryProducts(cityId: string, forceRefresh = false): Promise<ResolvedProduct[]> {
  return cached(
    `featuredGrocery:${cityId}`,
    CACHE_TTL_MS,
    async () => {
      const { data, error } = await withCityStock(
        supabase
          .from('products')
          .select(GROCERY_PRODUCT_COLS)
          .eq('is_active', true)
          .eq('is_featured', true)
          .is('vendor_id', null),
        cityId,
      )
        .order('name', { ascending: true })
        .limit(40);
      if (error) fail(error, 'Could not load featured products');
      return ((data ?? []) as unknown as Product[])
        .map((prod) => resolveProduct(prod, cityStockOf(prod), cityId))
        .filter(isInStockAndActive)
        .slice(0, 10);
    },
    forceRefresh,
  );
}

/**
 * A hotel's featured menu items (all categories), with this city's price/availability. The menu
 * page keeps only those orderable right now. One request, cached for 5 minutes.
 */
export function getHotelFeaturedItems(vendorId: string, cityId: string, forceRefresh = false): Promise<ResolvedProduct[]> {
  return cached(
    `hotelFeatured:${vendorId}:${cityId}`,
    CACHE_TTL_MS,
    async () => {
      const { data, error } = await withCityStock(
        supabase
          .from('products')
          .select(HOTEL_PRODUCT_COLS)
          .eq('is_active', true)
          .eq('is_featured', true)
          .eq('vendor_id', vendorId),
        cityId,
        false,
      )
        .order('name', { ascending: true })
        .limit(30);
      if (error) fail(error, 'Could not load featured items');
      return ((data ?? []) as unknown as Product[]).map((prod) => ({
        ...resolveProduct(prod, cityStockOf(prod), cityId),
        variants: [],
      }));
    },
    forceRefresh,
  );
}

export function getHotelCategories(vendorId: string, forceRefresh = false): Promise<Category[]> {
  return cached(
    `hotelCats:${vendorId}`,
    STABLE_TTL_MS,
    async () => {
      const { data, error } = await supabase
        .from('categories')
        .select('id,name,image_url,vendor_id,is_active,sort_order')
        .eq('vendor_id', vendorId)
        .eq('is_active', true)
        .order('sort_order', { ascending: true });
      if (error) fail(error, 'Could not fetch hotel categories');
      return (data ?? []) as Category[];
    },
    forceRefresh,
  );
}

export function getHotelProducts(p: {
  vendorId: string;
  cityId: string;
  categoryId?: string | null;
  limit?: number;
  offset?: number;
  forceRefresh?: boolean;
}): Promise<ResolvedProduct[]> {
  const { vendorId, cityId, categoryId, limit = 25, offset = 0, forceRefresh = false } = p;
  return cached(
    `hotelProducts:${vendorId}:${cityId}:${categoryId ?? ''}:${offset}:${limit}`,
    CACHE_TTL_MS,
    async () => {
      let query = withCityStock(
        supabase.from('products').select(HOTEL_PRODUCT_COLS).eq('is_active', true).eq('vendor_id', vendorId),
        cityId,
        false,
      )
        .order('is_featured', { ascending: false })
        .order('name', { ascending: true })
        .range(offset, offset + limit - 1);
      if (categoryId) query = query.eq('category_id', categoryId);
      const { data, error } = await query;
      if (error) fail(error, 'Could not fetch hotel products');
      const products = (data ?? []) as unknown as Product[];
      const tier = (x: ResolvedProduct) => {
        const avail = isHotelItemAvailable(x);
        return avail && x.isFeatured ? 0 : avail ? 1 : 2;
      };
      return products
        .map((prod) => ({ ...resolveProduct(prod, cityStockOf(prod), cityId), variants: [] }))
        .sort((a, b) => tier(a) - tier(b) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    },
    forceRefresh,
  );
}

// ---------- FRESH CART PRICING ----------

// Live prices are shared by every page showing the cart (home bar, hotel menu, cart,
// checkout) for a short time, so changing a quantity does not re-download the cart.
const LIVE_PRICE_TTL_MS = 30 * 1000;

/**
 * Current price/stock for the given cart products. Only products without a fresh entry are
 * requested; `force` re-fetches all of them (e.g. the cart page's retry).
 */
export async function getLiveCartProducts(
  productIds: string[],
  cityId: string,
  force = false,
): Promise<Map<string, ResolvedProduct>> {
  const ids = Array.from(new Set(productIds.filter(Boolean))).sort();
  const key = (id: string) => `live:${cityId}:${id}`;
  const missing = force ? ids : ids.filter((id) => cacheGet(key(id)) === null);
  if (missing.length) {
    await cached(
      `liveBatch:${cityId}:${missing.join(',')}`,
      1,
      async () => {
        const { data, error } = await withCityStock(
          supabase.from('products').select(CART_PRODUCT_COLS).in('id', missing),
          cityId,
        );
        if (error) fail(error, 'Could not load live prices');
        const found = new Set<string>();
        for (const prod of (data ?? []) as unknown as Product[]) {
          found.add(prod.id);
          cacheSet(key(prod.id), resolveProduct(prod, cityStockOf(prod), cityId), LIVE_PRICE_TTL_MS);
        }
        // Deleted or hidden products still need a cart line so the customer can remove them.
        for (const id of missing) {
          if (!found.has(id)) cacheSet(key(id), missingProduct(id), LIVE_PRICE_TTL_MS);
        }
        return { value: true, cache: false as const };
      },
      force,
    );
  }
  const out = new Map<string, ResolvedProduct>();
  for (const id of ids) {
    const rp = cacheGet<ResolvedProduct>(key(id));
    if (rp) out.set(id, rp);
  }
  return out;
}

function missingProduct(id: string): ResolvedProduct {
  return {
    base: { id, name: 'This item', price: 0, is_active: false, is_available: false },
    id,
    name: 'This item',
    isFeatured: false,
    isActive: false,
    effectivePrice: 0,
    effectiveStock: 0,
    effectiveIsAvailable: false,
    variants: [],
    missing: true,
  };
}

/** Builds priced cart lines from the cart and already-fetched live products (no request). */
export function buildCartLines(items: CartItem[], live: Map<string, ResolvedProduct>): CartItemUi[] {
  const out: CartItemUi[] = [];
  for (const item of items) {
    const rp = live.get(item.product_id);
    if (!rp) continue;
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

/** Re-fetches current price/stock for every cart item (prices are never stored in the cart). */
export async function getFreshCartItems(items: CartItem[], cityId: string, force = false): Promise<CartItemUi[]> {
  if (!items.length) return [];
  return buildCartLines(items, await getLiveCartProducts(items.map((i) => i.product_id), cityId, force));
}

// ---------- DELIVERY ----------

// City delivery settings change rarely: cached for 5 minutes and shared by home and checkout.
// Failed requests are not cached, so the next page retries.
export function getDeliverySlots(cityId: string): Promise<DeliverySlot[]> {
  return cached(`slotsCity:${cityId}`, CACHE_TTL_MS, async () => {
    const { data, error } = await supabase
      .from('delivery_slots')
      .select('id,name,start_time,end_time,min_order_amount,is_free_delivery,delivery_fee,is_active,city_id')
      .eq('city_id', cityId)
      .eq('is_active', true)
      .order('start_time', { ascending: true });
    if (error) return { value: [] as DeliverySlot[], cache: false as const };
    return (data ?? []) as DeliverySlot[];
  });
}

export function getExpressDeliverySettings(cityId: string): Promise<ExpressDeliverySettings | null> {
  return cached(`express:${cityId}`, CACHE_TTL_MS, async () => {
    const { data, error } = await supabase
      .from('express_delivery_settings')
      .select(
        'city_id,is_active,max_delivery_minutes,base_km,base_charge,per_km_charge_beyond,free_delivery_min_order,free_delivery_max_km,min_order_amount',
      )
      .eq('city_id', cityId)
      .eq('is_active', true)
      .limit(1);
    if (error) return { value: null, cache: false as const };
    return ((data ?? [])[0] as ExpressDeliverySettings) ?? null;
  });
}

export function getCityDeliverySettings(cityId: string): Promise<CityDeliverySettings | null> {
  return cached(`citySettings:${cityId}`, CACHE_TTL_MS, async () => {
    const { data, error } = await supabase
      .from('city_delivery_settings')
      .select('city_id,free_delivery_min_order_amount,handling_fee')
      .eq('city_id', cityId)
      .maybeSingle();
    if (error) return { value: null, cache: false as const };
    return (data as CityDeliverySettings) ?? null;
  });
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

const COUPON_COLS =
  'id,code,description,discount_type,discount_value,min_order_amount,max_discount_amount,usage_limit,used_count,starts_at,expires_at,is_active,city_id';

/** The one coupon the home screen advertises: a single active, already-started, unexpired row. */
export function getPromoCoupon(cityId: string): Promise<Coupon | null> {
  // Shared by the home popup and the food promo banner (one request per 5 minutes).
  return cached(`promoCoupon:${cityId}`, CACHE_TTL_MS, () => fetchPromoCoupon(cityId));
}

async function fetchPromoCoupon(cityId: string): Promise<Coupon | null> {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('coupons')
    .select('id,code,description,discount_type,discount_value,max_discount_amount,min_order_amount,is_active')
    .eq('city_id', cityId)
    .eq('is_active', true)
    .lte('starts_at', now)
    .or(`expires_at.is.null,expires_at.gt."${now}"`)
    .limit(1);
  if (error) return null;
  return ((data ?? [])[0] as Coupon) ?? null;
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
    .select(COUPON_COLS)
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

const ADDRESS_COLS = 'id,user_id,label,recipient_name,phone,address_line,landmark,lat,lng,city_id,is_default';

// Addresses are read at login, on checkout and in the address book: one cached copy per user,
// dropped after any change so every page sees the update.
export function getAddresses(userId: string, forceRefresh = false): Promise<CustomerAddress[]> {
  return cached(
    `addresses:${userId}`,
    CACHE_TTL_MS,
    async () => {
      const { data, error } = await supabase
        .from('customer_addresses')
        .select(ADDRESS_COLS)
        .eq('user_id', userId)
        .order('is_default', { ascending: false })
        .order('id', { ascending: false });
      if (error) fail(error, 'Failed to load addresses');
      return (data ?? []) as CustomerAddress[];
    },
    forceRefresh,
  );
}

export async function getAddressById(id: string): Promise<CustomerAddress | null> {
  const { data } = await supabase.from('customer_addresses').select(ADDRESS_COLS).eq('id', id).maybeSingle();
  return (data as CustomerAddress) ?? null;
}

export async function addAddress(address: CustomerAddress): Promise<CustomerAddress> {
  const { id: _omit, ...row } = address;
  void _omit;
  const { data, error } = await supabase.from('customer_addresses').insert(row).select(ADDRESS_COLS).single();
  if (error) fail(error, 'Failed to save delivery address.');
  invalidateCache('addresses:');
  return data as CustomerAddress;
}

export async function updateAddress(id: string, fields: Partial<CustomerAddress>) {
  const { error } = await supabase.from('customer_addresses').update(fields).eq('id', id);
  invalidateCache('addresses:');
  if (error) fail(error, 'Failed to update address');
}

export async function deleteAddress(id: string) {
  const { error } = await supabase.from('customer_addresses').delete().eq('id', id);
  invalidateCache('addresses:');
  if (error) fail(error, 'Failed to delete address');
}

/** Only one default address: unset the previous default(s) in one request, then set the new one. */
export async function setDefaultAddress(userId: string, addressId: string) {
  const { error } = await supabase
    .from('customer_addresses')
    .update({ is_default: false })
    .eq('user_id', userId)
    .eq('is_default', true)
    .neq('id', addressId);
  if (error) {
    invalidateCache('addresses:');
    fail(error, 'Failed to update address');
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

/** Thrown by placeOrder when the service is in maintenance, so checkout can show its maintenance screen. */
export class MaintenanceError extends Error {}

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
  /** Lines to order (checkout passes only the available ones); defaults to the whole cart. */
  items?: CartItem[];
}): Promise<Order> {
  const { groceryCart, hotelCart } = useCart.getState();
  const raw = (p.items ?? (p.isHotel ? hotelCart : groceryCart)).filter((i) => i.quantity > 0);
  if (!raw.length) throw new Error('Cart is empty');
  if (!p.addressId) throw new Error('Please select a delivery address');

  const maintenance = await checkMaintenanceMode();
  if (maintenance.enabled) {
    throw new MaintenanceError(maintenance.message ?? 'Service temporarily unavailable. Please try again shortly.');
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

// List rows only need what the order card shows.
const ORDER_LIST_COLS = 'id,order_number,customer_id,vendor_id,status,payment_method,payment_status,total_amount,placed_at,created_at';
const ORDER_DETAIL_COLS =
  'id,order_number,customer_id,vendor_id,delivery_partner_id,address_id,slot_id,status,payment_method,payment_status,' +
  'subtotal,discount_amount,delivery_fee,handling_fee,total_amount,city_id,delivery_type,placed_at,created_at';

export async function getOrders(userId: string, limit = 20, offset = 0): Promise<Order[]> {
  const { data, error } = await supabase
    .from('orders')
    .select(ORDER_LIST_COLS)
    .eq('customer_id', userId)
    .order('placed_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) fail(error, 'Failed to fetch orders');
  return (data ?? []) as Order[];
}

export function getCompletedOrderCount(userId: string): Promise<number> {
  // Only drives the rating popup: once per 5 minutes is plenty (not on every home visit).
  return cached(`completedCount:${userId}`, CACHE_TTL_MS, async () => {
    const { count, error } = await supabase
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('customer_id', userId)
      .eq('status', 'delivered');
    if (error) return { value: 0, cache: false as const };
    return count ?? 0;
  });
}

export async function getOrderById(orderId: string): Promise<Order> {
  const joined = await supabase
    .from('orders')
    .select(`${ORDER_DETAIL_COLS},delivery_partners(id,name,phone,latitude,longitude,vehicle_type,vehicle_number)`)
    .eq('id', orderId)
    .maybeSingle();
  if (!joined.error && joined.data) return joined.data as unknown as Order;
  const plain = await supabase.from('orders').select(ORDER_DETAIL_COLS).eq('id', orderId).maybeSingle();
  if (plain.error) fail(plain.error, 'Failed to load order');
  if (!plain.data) throw new Error(`Order not found: ${orderId}`);
  return plain.data as unknown as Order;
}

export async function getOrderItems(orderId: string): Promise<OrderItem[]> {
  const { data } = await supabase
    .from('order_items')
    .select('id,order_id,product_id,variant_id,product_name,variant_label,quantity,unit_price,total_price,vendor_id')
    .eq('order_id', orderId);
  return ((data ?? []) as OrderItem[]).map((i) => ({ ...i, quantity: Number(i.quantity) }));
}

export async function getOrderStatusHistory(orderId: string): Promise<OrderStatusHistory[]> {
  const { data } = await supabase
    .from('order_status_history')
    .select('id,order_id,status,note,created_at')
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
  const prodRes = await supabase
    .from('products')
    .select(REORDER_PRODUCT_COLS)
    .in('id', ids)
    .eq('product_city_stock.city_id', cityId);
  if (prodRes.error) throw new Error('Could not check item availability. Please try again.');
  const products = new Map(((prodRes.data ?? []) as unknown as Product[]).map((x) => [x.id, x]));
  let added = 0;
  const skipped: string[] = [];
  for (const item of orderItems) {
    const prod = products.get(item.product_id);
    // Same city rule as the product lists: grocery items need an active city stock row.
    const avail = !!prod && resolveProduct(prod, cityStockOf(prod), cityId).effectiveIsAvailable;
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
    .select('vendor_id,customer_id,order_id,rating,comment,created_at')
    .eq('customer_id', customerId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) fail(error, 'Failed to load reviews');
  return (data ?? []) as VendorReview[];
}

export async function getMyDeliveryPartnerReviews(customerId: string, limit = 20): Promise<DeliveryPartnerReview[]> {
  const { data, error } = await supabase
    .from('delivery_partner_reviews')
    .select('delivery_partner_id,customer_id,order_id,rating,comment,created_at')
    .eq('customer_id', customerId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) fail(error, 'Failed to load reviews');
  return (data ?? []) as DeliveryPartnerReview[];
}

/** Which of the given orders this customer already reviewed (only the order_id column, only these orders). */
export async function getReviewedOrderIds(customerId: string, orderIds: string[]): Promise<Set<string>> {
  const ids = new Set<string>();
  if (!orderIds.length) return ids;
  const [v, d] = await Promise.all([
    supabase.from('vendor_reviews').select('order_id').eq('customer_id', customerId).in('order_id', orderIds),
    supabase.from('delivery_partner_reviews').select('order_id').eq('customer_id', customerId).in('order_id', orderIds),
  ]);
  for (const r of [...(v.data ?? []), ...(d.data ?? [])] as { order_id: string | null }[]) if (r.order_id) ids.add(r.order_id);
  return ids;
}

// ---------- WALLET ----------

export async function getWalletTransactions(customerId: string, limit = 20, offset = 0): Promise<WalletTransaction[]> {
  const { data, error } = await supabase
    .from('customer_wallet_transactions')
    .select('id,customer_id,order_id,type,amount,reason,created_at')
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
