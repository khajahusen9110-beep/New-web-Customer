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
  MyWallet,
  RewardsPreview,
  WalletLedgerEntry,
  WalletUsable,
  PromoBanner,
  LocalAd,
} from './types';
import {
  defaultMenuTab,
  errorMessage,
  haversineKm,
  isHotelItemAvailable,
  isInStockAndActive,
  isVendorOpenNow,
  isWithinAnySlot,
  KNOWN_HUBS,
  menuTabs,
  sortGroceryProducts,
  toE164,
  vendorHours,
} from './utils';

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
const cacheSet = (key: string, data: unknown, ttl = CACHE_TTL_MS) => {
  cache.set(key, { at: Date.now(), ttl, data });
  persistSet(key, data);
};

// ---------- Instant start: last-seen lists kept on the device ----------
// What the home screen and menus show first (categories, first page of products and hotels,
// featured rows, hotel hours) is also saved in localStorage. On the next visit the page shows
// it immediately (stale-while-revalidate) while the same request runs and replaces it with fresh
// data within a moment. Prices and stock are always re-checked live in the cart and at checkout.
const PERSIST_PREFIX = 'sndmart-swr:';
const PERSIST_INDEX = 'sndmart-swr-index';
const PERSIST_MAX_KEYS = 80;
const PERSIST_RULES: [RegExp, number][] = [
  [/^groceryCategories$/, 7 * 24 * 3600e3],
  [/^grocery:[^:]+:[^:]+::0:\d+$/, 12 * 3600e3], // first page, no search
  [/^featuredGrocery:/, 12 * 3600e3],
  [/^hotels:[^:]+::0:\d+:\*$/, 12 * 3600e3], // first page, no search / dish filter
  [/^dishCats:/, 24 * 3600e3],
  [/^banners:/, 6 * 3600e3],
  [/^(slots|rating|vendor):/, 24 * 3600e3],
  [/^hotelCats:/, 24 * 3600e3],
  [/^hotelAvail:/, 12 * 3600e3],
  [/^hotelProducts:[^:]+:[^:]+:[^:]*:0:\d+$/, 12 * 3600e3],
];
const persistMaxAge = (key: string) => PERSIST_RULES.find(([re]) => re.test(key))?.[1] ?? 0;

function persistSet(key: string, data: unknown) {
  if (!persistMaxAge(key)) return;
  try {
    localStorage.setItem(PERSIST_PREFIX + key, JSON.stringify({ at: Date.now(), data }));
    const index = (JSON.parse(localStorage.getItem(PERSIST_INDEX) ?? '[]') as string[]).filter((k) => k !== key);
    index.push(key);
    for (const old of index.splice(0, Math.max(0, index.length - PERSIST_MAX_KEYS))) {
      localStorage.removeItem(PERSIST_PREFIX + old);
    }
    localStorage.setItem(PERSIST_INDEX, JSON.stringify(index));
  } catch {
    /* storage full or blocked: the in-memory cache still works */
  }
}

/** Last known value for a cache key, fresh or not (memory first, then this device's storage). */
function peek<T>(key: string): T | null {
  const hit = cache.get(key);
  if (hit) return hit.data as T;
  const maxAge = persistMaxAge(key);
  if (!maxAge) return null;
  try {
    const raw = localStorage.getItem(PERSIST_PREFIX + key);
    if (!raw) return null;
    const { at, data } = JSON.parse(raw) as { at: number; data: T };
    return Date.now() - at <= maxAge ? data : null;
  } catch {
    return null;
  }
}

/** Removes everything saved on this device (logout). */
export function clearPersistedLists() {
  try {
    const index = JSON.parse(localStorage.getItem(PERSIST_INDEX) ?? '[]') as string[];
    for (const k of index) localStorage.removeItem(PERSIST_PREFIX + k);
    localStorage.removeItem(PERSIST_INDEX);
  } catch {
    /* ignore */
  }
}
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
  clearPersistedLists();
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

export const peekGroceryCategories = () => peek<Category[]>('groceryCategories');

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
  'id,name,banner_url,is_active,is_featured,is_open,address,latitude,longitude,opening_time,closing_time,default_category_id';

/** Last-seen first page of hotels (no search/dish filter), shown while the fresh one loads. */
export const peekHotels = (cityId: string, limit: number) => peek<Vendor[]>(`hotels:${cityId}::0:${limit}:*`);

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

/** Last-known hours/ratings for these hotels, without a request (fresh ones follow via getHotelExtras). */
export function peekHotelExtras(vendorIds: string[]) {
  const slots: Record<string, OperatingSlot[]> = {};
  const ratings: Record<string, number> = {};
  for (const id of vendorIds) {
    const sl = peek<OperatingSlot[]>(`slots:${id}`);
    if (sl) slots[id] = sl;
    const r = peek<number>(`rating:${id}`);
    if (r !== null) ratings[id] = r;
  }
  return { slots, ratings };
}

/** Already-fetched hours/rating for a vendor (filled by getHotels), without a request. */
export const peekVendorExtras = (vendorId: string) => ({
  slots: cacheGet<OperatingSlot[]>(`slots:${vendorId}`),
  rating: cacheGet<number>(`rating:${vendorId}`),
});

// ---------- PROMO BANNERS (set by the Super Admin) ----------

const BANNER_COLS =
  'id,city_id,placement,image_url,title,subtitle,cta_text,show_text,link_type,link_value,sort_order,starts_at,ends_at';
const MAX_BANNERS = 5;

/** Drops banners whose time window has passed since they were cached. */
const liveBanners = (list: PromoBanner[]) => {
  const now = Date.now();
  return list.filter((b) => (!b.starts_at || Date.parse(b.starts_at) <= now) && (!b.ends_at || Date.parse(b.ends_at) > now));
};

const bannerKey = (cityId: string, placement: 'grocery' | 'food') => `banners:${cityId}:${placement}`;

/** Last-seen banners (instant first paint); fresh ones come from getPromoBanners. */
export const peekPromoBanners = (cityId: string, placement: 'grocery' | 'food') => {
  const seen = peek<PromoBanner[]>(bannerKey(cityId, placement));
  return seen ? liveBanners(seen) : null;
};

/**
 * Banners for this city (or all cities) on the grocery home or the food tab. The database only
 * returns banners that are switched on and inside their start/end time. Cached for 5 minutes.
 */
export async function getPromoBanners(cityId: string, placement: 'grocery' | 'food', forceRefresh = false): Promise<PromoBanner[]> {
  const list = await cached(
    bannerKey(cityId, placement),
    CACHE_TTL_MS,
    async () => {
      const { data, error } = await supabase
        .from('promo_banners')
        .select(BANNER_COLS)
        .in('placement', [placement, 'both'])
        .or(`city_id.is.null,city_id.eq.${cityId}`)
        .order('sort_order', { ascending: true })
        .limit(MAX_BANNERS);
      // No banners table yet / offline: the page shows its default banner.
      if (error) return { value: [] as PromoBanner[], cache: false as const };
      return ((data ?? []) as PromoBanner[]).filter((b) => /^https:\/\//.test(b.image_url));
    },
    forceRefresh,
  );
  return liveBanners(list);
}

// ---------- LOCAL ADS (paid banners from local businesses, set per-city by City Admin) ----------

const LOCAL_AD_COLS =
  'id,city_id,advertiser_name,image_url,placement,ad_type,link_type,link_value,sort_order,starts_at,ends_at';
const MAX_LOCAL_ADS = 5;

const localAdsKey = (cityId: string, placement: 'home' | 'food_bottom' | 'grocery_bottom') => `localAds:${cityId}:${placement}`;

const liveLocalAds = (list: LocalAd[]) => {
  const now = Date.now();
  return list.filter((a) => (!a.starts_at || Date.parse(a.starts_at) <= now) && (!a.ends_at || Date.parse(a.ends_at) > now));
};

/** Last-seen local ads (instant first paint); fresh ones come from getLocalAds. */
export const peekLocalAds = (cityId: string, placement: 'home' | 'food_bottom' | 'grocery_bottom') => {
  const seen = peek<LocalAd[]>(localAdsKey(cityId, placement));
  return seen ? liveLocalAds(seen) : null;
};

/**
 * Paid local-business ads for a placement ('home' top banner, or the bottom of the food /
 * grocery lists). The database only returns ads switched on and inside their schedule.
 */
export async function getLocalAds(
  cityId: string,
  placement: 'home' | 'food_bottom' | 'grocery_bottom',
  forceRefresh = false,
): Promise<LocalAd[]> {
  const list = await cached(
    localAdsKey(cityId, placement),
    CACHE_TTL_MS,
    async () => {
      const { data, error } = await supabase
        .from('local_ads')
        .select(LOCAL_AD_COLS)
        .eq('city_id', cityId)
        .in('placement', [placement, 'all'])
        .order('sort_order', { ascending: true })
        .limit(MAX_LOCAL_ADS);
      if (error) return { value: [] as LocalAd[], cache: false as const };
      return ((data ?? []) as LocalAd[]).filter((a) => /^https:\/\//.test(a.image_url));
    },
    forceRefresh,
  );
  return liveLocalAds(list);
}

/** Opens a local ad's link (website/map in a new tab, WhatsApp chat, or the dialer). Does nothing for a Fixed ad. */
export function openLocalAdLink(ad: LocalAd) {
  if (ad.ad_type !== 'clickable' || !ad.link_value) return;
  if (ad.link_type === 'call') {
    window.location.href = ad.link_value;
  } else {
    window.open(ad.link_value, '_blank', 'noopener,noreferrer');
  }
}

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
export const peekHotelDishCategories = (cityId: string) => peek<DishCategory[]>(`dishCats:${cityId}`);

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

/**
 * Hotels to show for a free-text food search: those whose own name matches, PLUS those
 * serving a menu item whose name matches (so "biryani" finds hotels that cook biryani,
 * not only a hotel literally named "Biryani"). Returns the matching vendor ids.
 */
export async function searchHotelVendorIds(cityId: string, searchQuery: string): Promise<string[]> {
  const q = searchQuery.trim();
  if (!q) return [];
  // Server RPC: exact (hotel name / dish name) match first, then typo-tolerant
  // fuzzy fallback — so "Biriyani" still finds "Chicken Biryani".
  const { data, error } = await supabase.rpc('search_hotel_vendor_ids', {
    p_city_id: cityId,
    p_query: q,
  });
  if (error) {
    console.warn('Hotel search notice, falling back to name match:', error.message);
    const { data: byName } = await supabase
      .from('vendors')
      .select('id')
      .eq('city_id', cityId)
      .eq('vendor_type', 'hotel')
      .eq('approval_status', 'approved')
      .ilike('name', `%${q}%`)
      .limit(200);
    return (byName ?? []).map((v: { id: string }) => v.id);
  }
  const ids = new Set<string>();
  for (const r of (data ?? []) as { vendor_id: string | null }[]) if (r.vendor_id) ids.add(r.vendor_id);
  return Array.from(ids);
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

/** Last-seen first page of a grocery category (no search), shown while the fresh one loads. */
export const peekGroceryProducts = (cityId: string, categoryId: string, limit: number) =>
  peek<ResolvedProduct[]>(`grocery:${cityId}:${categoryId}::0:${limit}`);
export const peekFeaturedGroceryProducts = (cityId: string) => peek<ResolvedProduct[]>(`featuredGrocery:${cityId}`);
export const peekTopSellingGroceryProducts = (cityId: string) => peek<ResolvedProduct[]>(`topGrocery:${cityId}`);
export const peekTopSellingFoodProducts = (cityId: string) => peek<ResolvedProduct[]>(`topFood:${cityId}`);
/** Last-seen menu pieces for a hotel (instant open; the page refreshes them). */
export const peekHotelMenu = (vendorId: string, cityId: string, categoryId: string | null, limit: number) => ({
  vendor: peek<Vendor>(`vendor:${vendorId}`),
  slots: peek<OperatingSlot[]>(`slots:${vendorId}`),
  categories: peek<Category[]>(`hotelCats:${vendorId}`),
  products: categoryId ? peek<ResolvedProduct[]>(`hotelProducts:${vendorId}:${cityId}:${categoryId}:0:${limit}`) : null,
  availability: peek<ResolvedProduct[]>(`hotelAvail:${vendorId}:${cityId}`),
});

export function getResolvedGroceryProducts(p: {
  cityId: string;
  /** A category id browses that category; '' / null searches across ALL grocery products. */
  categoryId: string | null;
  searchQuery?: string | null;
  limit?: number;
  offset?: number;
  forceRefresh?: boolean;
}): Promise<ResolvedProduct[]> {
  const { cityId, limit = 30, offset = 0, forceRefresh = false } = p;
  const categoryId = p.categoryId || ''; // '' = every category (used while searching)
  const q = (p.searchQuery ?? '').trim().toLowerCase();
  return cached(
    `grocery:${cityId}:${categoryId}:${q}:${offset}:${limit}`,
    CACHE_TTL_MS,
    async () => {
      // One page of grocery products with this city's stock embedded, filtered in the database.
      // When searching (no category), we match by name across every category instead.
      let base = supabase
        .from('products')
        .select(GROCERY_PRODUCT_COLS)
        .eq('is_active', true)
        .is('vendor_id', null);
      if (categoryId) base = base.eq('category_id', categoryId);
      let query = withCityStock(base, cityId)
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
/**
 * Up to 10 most-selling grocery products in this city (by units sold), for the "Most Selling" row.
 * The RPC ranks product ids + units sold; one products request then loads their city stock/price.
 */
export function getTopSellingGroceryProducts(cityId: string, forceRefresh = false): Promise<ResolvedProduct[]> {
  return cached(
    `topGrocery:${cityId}`,
    CACHE_TTL_MS,
    async () => {
      const { data: ranked, error: rErr } = await supabase.rpc('get_top_grocery_products', {
        p_city_id: cityId,
        p_limit: 10,
      });
      if (rErr || !ranked || !ranked.length) return [];
      const soldById = new Map<string, number>(
        (ranked as { product_id: string; units_sold: number }[]).map((r) => [r.product_id, Number(r.units_sold) || 0]),
      );
      const ids = Array.from(soldById.keys());
      const { data, error } = await withCityStock(
        supabase.from('products').select(GROCERY_PRODUCT_COLS).in('id', ids).is('vendor_id', null),
        cityId,
      );
      if (error) return [];
      const resolved = ((data ?? []) as unknown as Product[])
        .map((prod) => resolveProduct(prod, cityStockOf(prod), cityId))
        .filter(isInStockAndActive)
        .map((p) => ({ ...p, soldCount: soldById.get(p.id) ?? 0 }));
      // Keep the RPC's best-selling order.
      resolved.sort((a, b) => (b.soldCount ?? 0) - (a.soldCount ?? 0));
      return resolved;
    },
    forceRefresh,
  );
}

/**
 * Up to 10 most-ordered hotel dishes in this city (by units sold), for the food "Most Ordered" row.
 * The RPC ranks product ids + their hotel + units sold; one products request resolves price/stock.
 */
export function getTopSellingFoodProducts(cityId: string, forceRefresh = false): Promise<ResolvedProduct[]> {
  return cached(
    `topFood:${cityId}`,
    CACHE_TTL_MS,
    async () => {
      const { data: ranked, error: rErr } = await supabase.rpc('get_top_food_products', {
        p_city_id: cityId,
        p_limit: 10,
      });
      if (rErr || !ranked || !ranked.length) return [];
      const metaById = new Map<string, { sold: number; vendorName: string }>(
        (ranked as { product_id: string; units_sold: number; vendor_name: string }[]).map((r) => [
          r.product_id,
          { sold: Number(r.units_sold) || 0, vendorName: r.vendor_name },
        ]),
      );
      const ids = Array.from(metaById.keys());
      // HOTEL_PRODUCT_COLS has no product_variants embed, so variants must be off (false),
      // otherwise the variant-stock filter errors and nothing comes back.
      const { data, error } = await withCityStock(
        supabase.from('products').select(HOTEL_PRODUCT_COLS).in('id', ids),
        cityId,
        false,
      );
      if (error) return [];
      return ((data ?? []) as unknown as Product[])
        .map((prod) => {
          const r = resolveProduct(prod, cityStockOf(prod), cityId);
          const meta = metaById.get(prod.id);
          return { ...r, variants: [], soldCount: meta?.sold ?? 0, vendorName: meta?.vendorName };
        })
        .filter((p) => p.isActive)
        .sort((a, b) => (b.soldCount ?? 0) - (a.soldCount ?? 0));
    },
    forceRefresh,
  );
}

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

/**
 * Food search by dish: returns matching hotel ITEMS directly (so results show dishes,
 * not just the hotels). Exact name match first, then a typo-tolerant fuzzy fallback.
 * Each dish carries its hotel name (vendorName) and the current open/closed state.
 */
export async function searchHotelDishes(cityId: string, query: string, limit = 60): Promise<ResolvedProduct[]> {
  const q = query.trim();
  if (!q || !cityId) return [];
  const { data: rows, error } = await supabase.rpc('search_hotel_dishes', { p_city_id: cityId, p_query: q });
  if (error) {
    console.warn('Dish search notice:', error.message);
    return [];
  }
  const meta = new Map<string, { vendorName: string; open: boolean; order: number }>();
  (rows ?? []).forEach((r: any, i: number) =>
    meta.set(r.product_id, { vendorName: r.vendor_name, open: !!r.vendor_is_open, order: i }),
  );
  const ids = Array.from(meta.keys()).slice(0, limit);
  if (!ids.length) return [];
  const { data, error: pErr } = await withCityStock(
    supabase.from('products').select(HOTEL_PRODUCT_COLS).eq('is_active', true).in('id', ids),
    cityId,
    false,
  );
  if (pErr) fail(pErr, 'Could not load dishes');
  const products = (data ?? []) as unknown as Product[];
  return products
    .map((prod) => {
      const m = meta.get(prod.id);
      return {
        ...resolveProduct(prod, cityStockOf(prod), cityId),
        variants: [],
        vendorName: m?.vendorName,
        hotelOpen: m?.open ?? false,
      } as ResolvedProduct;
    })
    // preserve the RPC's relevance order (open hotels + best matches first)
    .sort((a, b) => (meta.get(a.id)?.order ?? 999) - (meta.get(b.id)?.order ?? 999));
}

// Only what the menu tabs need to know which categories have something orderable right now.
const HOTEL_AVAILABILITY_COLS =
  'id,category_id,vendor_id,name,price,is_available,is_active,available_from,available_until,' + CITY_STOCK_EMBED;

/**
 * Every active item of a hotel (no descriptions/images), with this city's availability, so the menu
 * can order and grey out its category tabs. One request, cached for 5 minutes.
 */
export function getHotelMenuAvailability(vendorId: string, cityId: string, forceRefresh = false): Promise<ResolvedProduct[]> {
  return cached(
    `hotelAvail:${vendorId}:${cityId}`,
    CACHE_TTL_MS,
    async () => {
      const { data, error } = await withCityStock(
        supabase.from('products').select(HOTEL_AVAILABILITY_COLS).eq('is_active', true).eq('vendor_id', vendorId),
        cityId,
        false,
      ).limit(1000);
      if (error) fail(error, 'Could not load menu availability');
      return ((data ?? []) as unknown as Product[]).map((prod) => ({
        ...resolveProduct(prod, cityStockOf(prod), cityId),
        variants: [],
      }));
    },
    forceRefresh,
  );
}

/** Items per page in a hotel menu category (the menu page uses the same, so prefetches are reused). */
export const HOTEL_MENU_PAGE = 25;

const menuPrefetchedAt = new Map<string, number>();
/**
 * Starts loading a hotel's menu (hours, categories, availability, featured items and the first
 * page of the tab it will open on) when the customer is about to open it (finger down / hover),
 * so the menu usually appears instantly. Each piece goes into the normal cache; at most once a minute.
 */
export function prefetchHotelMenu(vendorId: string, cityId: string) {
  const key = `${vendorId}:${cityId}`;
  if (Date.now() - (menuPrefetchedAt.get(key) ?? 0) < 60_000) return;
  menuPrefetchedAt.set(key, Date.now());
  void (async () => {
    const [vendor, slots, categories, items] = await Promise.all([
      getVendor(vendorId),
      getVendorOperatingSlots(vendorId),
      getHotelCategories(vendorId),
      getHotelMenuAvailability(vendorId, cityId),
      getHotelFeaturedItems(vendorId, cityId),
    ]);
    const open = vendor ? isVendorOpenNow(vendor, slots) : isWithinAnySlot(slots);
    const hours = vendor ? vendorHours(vendor, slots) : slots;
    const first = defaultMenuTab(menuTabs(categories, items, open, hours), vendor?.default_category_id);
    if (first) await getHotelProducts({ vendorId, cityId, categoryId: first, limit: HOTEL_MENU_PAGE, offset: 0 });
  })().catch(() => menuPrefetchedAt.delete(key));
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

/**
 * Whether this customer may pay Cash on Delivery. Blocked after repeated cancelled orders
 * (or by an admin). Fails open — the server still enforces it when the order is placed.
 */
export async function getMyCodAllowed(): Promise<boolean> {
  try {
    const { data, error } = await supabase.rpc('my_cod_status');
    if (error) return true;
    return (data as { cod_allowed?: boolean } | null)?.cod_allowed !== false;
  } catch {
    return true;
  }
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
  'id,code,description,discount_type,discount_value,min_order_amount,max_discount_amount,usage_limit,used_count,starts_at,expires_at,is_active,city_id,' +
  'reward_type,per_user_limit,cashback_valid_days';

/** The one coupon the home screen advertises: a single active, already-started, unexpired row. */
export function getPromoCoupon(cityId: string): Promise<Coupon | null> {
  // Shared by the home popup and the food promo banner (one request per 5 minutes).
  return cached(`promoCoupon:${cityId}`, CACHE_TTL_MS, () => fetchPromoCoupon(cityId));
}

async function fetchPromoCoupon(cityId: string): Promise<Coupon | null> {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('coupons')
    .select(COUPON_COLS)
    .eq('city_id', cityId)
    .eq('is_active', true)
    .lte('starts_at', now)
    .or(`expires_at.is.null,expires_at.gt."${now}"`)
    .limit(1);
  if (error) return null;
  return ((data ?? [])[0] as unknown as Coupon) ?? null;
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
  const coupon = ((data ?? [])[0] as unknown as Coupon) ?? null;
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
  /** Coupon code the server validates and applies (instant discount or wallet cashback). */
  couponCode: string | null;
  /** Lines to order (checkout passes only the available ones); defaults to the whole cart. */
  items?: CartItem[];
  /** Pay part of the order from the Sndmart Wallet (the server decides how much). */
  useWallet?: boolean;
  /** Cooking instructions for the vendor (e.g. "kam teekha"). */
  cookingInstructions?: string | null;
  /** Delivery instructions for the delivery partner (e.g. "gate pe call karein"). */
  deliveryInstructions?: string | null;
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
  args.p_coupon_code = p.couponCode?.trim().toUpperCase() || null;
  args.p_use_wallet = p.useWallet === true;
  if (p.isHotel) {
    const vendorId = p.vendorId || raw.find((i) => i.vendor_id)?.vendor_id;
    if (!vendorId) throw new Error('Hotel / Vendor ID is missing for this order');
    args.p_vendor_id = vendorId;
  }
  // v2 = the same checkout plus coupons with wallet cashback and paying part from the wallet.
  const fn = p.isHotel ? 'checkout_food_order_v2' : 'checkout_grocery_order_v2';

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
      // Cooking (vendor) + delivery (partner) instructions — best-effort, never fail the order.
      const cooking = p.cookingInstructions?.trim() || null;
      const delivery = p.deliveryInstructions?.trim() || null;
      if (cooking || delivery) {
        try {
          await supabase.rpc('set_order_instructions', { p_order_id: order.id, p_cooking: cooking, p_delivery: delivery });
        } catch {
          /* instructions are best-effort; the order is already placed */
        }
      }
      try {
        await clearCartDirectly(p.isHotel);
      } catch {
        // Cart cleanup failing must not hide a placed order.
      }
      invalidateCache('myWallet'); // wallet used / cashback pending changed
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

/** Minutes an unpaid UPI order is kept before the backend cancels it (cancel_unpaid_upi_orders). */
export const UPI_PAYMENT_WINDOW_MIN = 15;
export const UPI_TIMEOUT_REASON = 'UPI payment not received within 15 minutes';

/** UPI order still waiting for its payment (the order page shows the countdown banner). */
export const isAwaitingUpiPayment = (o: Pick<Order, 'payment_method' | 'payment_status' | 'status'>) =>
  o.payment_method?.toLowerCase() === 'upi' &&
  ['pending', 'failed'].includes(o.payment_status?.toLowerCase() ?? '') &&
  ['pending', 'confirmed'].includes(o.status?.toLowerCase() ?? '');

/**
 * Asks Razorpay (through the sync-razorpay-payment function) whether this order was paid and marks
 * it paid if so. Covers payments whose success callback never arrived (tab closed while switching
 * to the UPI app). Returns the payment status, or null if it could not be checked.
 */
export async function syncRazorpayPayment(orderId: string): Promise<string | null> {
  try {
    const { data, error } = await supabase.functions.invoke('sync-razorpay-payment', { body: { order_id: orderId } });
    if (error) return null;
    const json = (typeof data === 'string' ? JSON.parse(data) : data) as { payment_status?: string } | null;
    return json?.payment_status ?? null;
  } catch {
    return null;
  }
}

let lastPendingSync = 0;
/**
 * On opening the site / coming back to it: checks this customer's recent UPI orders that are still
 * unpaid with Razorpay (at most once a minute, at most 3 orders).
 */
export async function syncPendingUpiOrders(userId: string) {
  if (Date.now() - lastPendingSync < 60_000) return;
  lastPendingSync = Date.now();
  const since = new Date(Date.now() - (UPI_PAYMENT_WINDOW_MIN + 5) * 60_000).toISOString();
  const { data, error } = await supabase
    .from('orders')
    .select('id')
    .eq('customer_id', userId)
    .eq('payment_method', 'upi')
    .in('payment_status', ['pending', 'failed'])
    .in('status', ['pending', 'confirmed'])
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(3);
  if (error || !data) return;
  for (const o of data as { id: string }[]) await syncRazorpayPayment(o.id);
}

/** Why an order was cancelled (order_cancellations.reason), if recorded. */
export async function getOrderCancellationReason(orderId: string): Promise<string | null> {
  const { data } = await supabase
    .from('order_cancellations')
    .select('reason,created_at')
    .eq('order_id', orderId)
    .order('created_at', { ascending: false })
    .limit(1);
  return ((data ?? [])[0] as { reason?: string | null } | undefined)?.reason ?? null;
}

// ---------- ORDERS ----------

// List rows only need what the order card shows.
const ORDER_LIST_COLS =
  'id,order_number,customer_id,vendor_id,status,payment_method,payment_status,total_amount,wallet_used_amount,cashback_amount,placed_at,created_at';
const ORDER_DETAIL_COLS =
  'id,order_number,customer_id,vendor_id,delivery_partner_id,address_id,slot_id,status,payment_method,payment_status,' +
  'subtotal,discount_amount,delivery_fee,handling_fee,total_amount,wallet_used_amount,cashback_amount,city_id,delivery_type,placed_at,created_at';

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

// ---------- SNDMART WALLET (cashback) ----------
// Everything is calculated by the server; the app never writes wallet tables.

/** Coupon + wallet preview for the checkout bill (debounced by the caller). */
export async function previewCheckoutRewards(p: {
  subtotal: number;
  couponCode: string | null;
  payableBeforeWallet: number;
}): Promise<RewardsPreview> {
  const { data, error } = await supabase.rpc('preview_checkout_rewards', {
    p_subtotal: Math.max(0, Math.round(p.subtotal * 100) / 100),
    p_coupon_code: p.couponCode?.trim() ? p.couponCode.trim().toUpperCase() : null,
    p_payable_before_wallet: Math.max(0, Math.round(p.payableBeforeWallet * 100) / 100),
  });
  if (error) fail(error, 'Could not check coupon and wallet');
  const r = (data ?? {}) as Partial<RewardsPreview>;
  const w = (r.wallet ?? {}) as Partial<WalletUsable>;
  return {
    coupon: r.coupon
      ? {
          ...r.coupon,
          discount: num(r.coupon.discount),
          cashback: num(r.coupon.cashback),
        }
      : null,
    wallet: {
      enabled: w.enabled === true,
      balance: num(w.balance),
      usable: num(w.usable),
      max_use_percent: num(w.max_use_percent),
      min_order: num(w.min_order),
      reason: w.reason ?? null,
    },
  };
}

/** The customer's wallet summary (cached briefly; refreshed after orders and on the wallet page). */
export function getMyWallet(forceRefresh = false): Promise<MyWallet> {
  return cached(
    'myWallet',
    60 * 1000,
    async () => {
      const { data, error } = await supabase.rpc('get_my_wallet');
      if (error) fail(error, 'Failed to load wallet');
      const w = (data ?? {}) as Partial<MyWallet>;
      return {
        city_id: w.city_id ?? null,
        enabled: w.enabled === true,
        balance: num(w.balance),
        pending_cashback: num(w.pending_cashback),
        total_cashback_earned: num(w.total_cashback_earned),
        total_used: num(w.total_used),
        max_use_percent: num(w.max_use_percent),
        min_order: num(w.min_order),
        expiring_soon: w.expiring_soon ? { amount: num(w.expiring_soon.amount), first_expiry: w.expiring_soon.first_expiry ?? null } : null,
        lots: (w.lots ?? []).map((l) => ({ amount: num(l.amount), expires_at: l.expires_at })),
        pending: (w.pending ?? []).map((x) => ({ ...x, amount: num(x.amount) })),
      };
    },
    forceRefresh,
  );
}

/** Wallet history, newest first; pass the last row's created_at for the next page. */
export async function getMyWalletHistory(limit = 30, before: string | null = null): Promise<WalletLedgerEntry[]> {
  const { data, error } = await supabase.rpc('get_my_wallet_history', { p_limit: limit, p_before: before });
  if (error) fail(error, 'Failed to load wallet history');
  return ((data ?? []) as WalletLedgerEntry[]).map((e) => ({ ...e, amount: num(e.amount) }));
}

/** Older refund records from before the cashback wallet (shown read-only under the history). */
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

// ---------- REFER & EARN ----------

export interface ReferralStats {
  referral_code: string | null;
  total_referred: number;
  total_rewarded: number;
  total_earned: number;
  /** This city's current reward amounts (set by City Admin — may change over time). */
  referrer_reward: number;
  friend_reward: number;
  min_order_amount: number;
}

/** The caller's referral code (created on first call) + how many friends they've earned from. */
export async function getMyReferralStats(): Promise<ReferralStats> {
  const { data, error } = await supabase.rpc('get_my_referral_stats_v2');
  if (error) fail(error, 'Failed to load referral info');
  const row = (Array.isArray(data) ? data[0] : data) as ReferralStats | undefined;
  return {
    referral_code: row?.referral_code ?? null,
    total_referred: num(row?.total_referred ?? 0),
    total_rewarded: num(row?.total_rewarded ?? 0),
    total_earned: num(row?.total_earned ?? 0),
    referrer_reward: num(row?.referrer_reward ?? 50),
    friend_reward: num(row?.friend_reward ?? 30),
    min_order_amount: num(row?.min_order_amount ?? 99),
  };
}

/** Ensures the caller has a referral code, creating one if needed. */
export async function getOrCreateReferralCode(): Promise<string> {
  const { data, error } = await supabase.rpc('get_my_referral_code');
  if (error) fail(error, 'Failed to create referral code');
  return data as string;
}

/** Applies a friend's referral code to the caller's own account (one-time, before first order). */
export async function applyReferralCode(code: string): Promise<void> {
  const { error } = await supabase.rpc('apply_referral_code', { p_code: code });
  if (error) fail(error, 'Could not apply referral code');
}

// ---------- AGENT PROGRAM (separate from Refer & Earn — see apply_agent_code) ----------

/** Links the caller to an agent by their code (one-time, permanent). Independent of Refer & Earn. */
export async function applyAgentCode(code: string): Promise<void> {
  const { error } = await supabase.rpc('apply_agent_code', { p_code: code });
  if (error) fail(error, 'Could not apply agent code');
}

// ---------- SCRATCH CARD (post-order reward) ----------

export interface ScratchCard {
  id: string;
  order_id: string;
  amount: number;
  is_scratched: boolean;
  status: 'pending' | 'credited' | 'voided';
}

/** The scratch card for an order, or null if none was generated (e.g. order below the minimum). */
export async function getMyScratchCard(orderId: string): Promise<ScratchCard | null> {
  const { data, error } = await supabase.rpc('get_my_scratch_card', { p_order_id: orderId });
  if (error) fail(error, 'Failed to load scratch card');
  if (!data) return null;
  const d: any = data;
  return { id: d.id, order_id: d.order_id, amount: num(d.amount), is_scratched: !!d.is_scratched, status: d.status };
}

/** Marks the card scratched (idempotent — calling again just returns the already-revealed amount). */
export async function scratchMyCard(orderId: string): Promise<ScratchCard> {
  const { data, error } = await supabase.rpc('scratch_my_card', { p_order_id: orderId });
  if (error) fail(error, 'Failed to reveal scratch card');
  const d: any = data;
  return { id: d.id, order_id: d.order_id, amount: num(d.amount), is_scratched: !!d.is_scratched, status: d.status };
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
