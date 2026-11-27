// Stores: local shops (kirana, vegetables, bakery, electronics ...) that sell through SND Mart next to Food.
// The server decides everything (which categories are on, which shops are inside the radius, the order of the
// list, the cheapest-first search). This file only calls it. When Stores is off for a city every call here answers
// "nothing", so the app looks exactly as it did before.
import { supabase } from './supabase';
import { getAddresses } from './repository';

export interface StoreCategory {
  id: string;
  key: string;
  name: string;
  name_kn: string | null;
  image_url: string | null;
  template: string;
  store_count: number;
}
export interface StoreDeliveryCfg {
  express_enabled: boolean;
  express_extra_fee: number;
  scheduled_enabled: boolean;
  scheduled_discount: number;
  slot_first_hour: number;
  slot_last_hour: number;
  slot_minutes: number;
  lead_minutes: number;
  max_days: number;
}
export interface StoresConfig {
  /** Express / Scheduled options of the city (older servers send none: Express only) */
  delivery?: StoreDeliveryCfg;
  stores_enabled: boolean;
  /** true: the old Groceries tab is replaced by Stores (which starts with the "SND Mart Store" card) */
  replace_grocery: boolean;
  radius_km: number;
  categories: StoreCategory[];
}
export interface StoreListItem {
  store_id: string;
  name: string;
  banner_url: string | null;
  address: string | null;
  category_id: string;
  category_name: string;
  category_name_kn: string | null;
  distance_km: number | null;
  is_open: boolean;
  is_nearest: boolean;
}
export interface StoreProductHit {
  product_id: string;
  name: string;
  price: number;
  mrp: number | null;
  unit: string | null;
  unit_price: number | null;
  unit_label: string | null;
  image_url: string | null;
  store_id: string;
  store_name: string;
  category_id: string;
  distance_km: number | null;
  total_count: number;
}
export type StoreSort = 'cheapest' | 'nearest' | 'relevance';

export interface StoreMenu {
  store: {
    id: string;
    name: string;
    banner_url: string | null;
    address: string | null;
    phone?: string | null;
    logo_url?: string | null;
    category_id: string | null;
    category_name: string | null;
    is_open: boolean;
    prep_minutes: number | null;
  };
  categories: { id: string; name: string }[];
  products: {
    id: string;
    name: string;
    description: string | null;
    image_url: string | null;
    price: number;
    mrp: number | null;
    unit: string | null;
    unit_price: number | null;
    unit_label: string | null;
    category_id: string | null;
    is_available: boolean;
    /** Made-to-order: the shop asks for a message and/or a photo, and may need notice */
    /** The shop quotes the price for this product (the customer asks first) */
    needs_quote?: boolean;
    is_customizable?: boolean;
    custom_allow_note?: boolean;
    custom_allow_photo?: boolean;
    custom_note_label?: string | null;
    custom_required?: boolean;
    custom_lead_hours?: number;
    /** Smallest order (default 1) and the extra charge per piece for customising */
    min_order_qty?: number;
    custom_extra_charge?: number;
    /** Sizes / options with their own price (empty or missing: a plain product) */
    variants?: { id: string; label: string; label_kn?: string | null; price: number; is_available: boolean }[];
  }[];
}

export interface Loc {
  lat: number;
  lng: number;
}

const OFF: StoresConfig = { stores_enabled: false, replace_grocery: false, radius_km: 5, categories: [] };
const cfgCache = new Map<string, { at: number; v: StoresConfig }>();

/** null/OFF on any problem, so a hiccup can never show a half-working Stores. */
export async function getStoresConfig(cityId: string | null | undefined, force = false): Promise<StoresConfig> {
  if (!cityId) return OFF;
  const hit = cfgCache.get(cityId);
  if (!force && hit && Date.now() - hit.at < 60_000) return hit.v;
  try {
    const { data, error } = await supabase.rpc('get_city_stores_config', { p_city_id: cityId });
    if (error || !data) return OFF;
    const d = data as Partial<StoresConfig>;
    const v: StoresConfig = {
      stores_enabled: d.stores_enabled === true,
      replace_grocery: d.replace_grocery === true,
      radius_km: Number(d.radius_km) || 5,
      categories: Array.isArray(d.categories) ? (d.categories as StoreCategory[]) : [],
      delivery: d.delivery,
    };
    cfgCache.set(cityId, { at: Date.now(), v });
    return v;
  } catch {
    return OFF;
  }
}

export async function listStores(cityId: string, loc: Loc | null, categoryId?: string | null): Promise<StoreListItem[]> {
  const { data, error } = await supabase.rpc('stores_list', {
    p_city_id: cityId,
    p_lat: loc?.lat ?? null,
    p_lng: loc?.lng ?? null,
    p_category_id: categoryId ?? null,
  });
  if (error) throw new Error(error.message || 'Could not load the shops');
  return ((data ?? []) as StoreListItem[]).map((r) => ({ ...r, distance_km: r.distance_km == null ? null : Number(r.distance_km) }));
}

export async function searchStoreProducts(
  cityId: string,
  loc: Loc | null,
  query: string,
  sort: StoreSort,
  categoryId?: string | null,
): Promise<StoreProductHit[]> {
  const { data, error } = await supabase.rpc('stores_search', {
    p_city_id: cityId,
    p_lat: loc?.lat ?? null,
    p_lng: loc?.lng ?? null,
    p_query: query,
    p_category_id: categoryId ?? null,
    p_sort: sort,
    p_limit: 40,
    p_offset: 0,
  });
  if (error) throw new Error(error.message || 'Search failed');
  return ((data ?? []) as StoreProductHit[]).map((r) => ({
    ...r,
    price: Number(r.price),
    mrp: r.mrp == null ? null : Number(r.mrp),
    unit_price: r.unit_price == null ? null : Number(r.unit_price),
    distance_km: r.distance_km == null ? null : Number(r.distance_km),
  }));
}

export async function getStoreMenu(storeId: string): Promise<StoreMenu> {
  const { data, error } = await supabase.rpc('get_store_menu', { p_store_id: storeId });
  if (error || !data) throw new Error(error?.message || 'Could not load this shop');
  const m = data as StoreMenu;
  return {
    ...m,
    categories: m.categories ?? [],
    products: (m.products ?? []).map((p) => ({ ...p, price: Number(p.price), mrp: p.mrp == null ? null : Number(p.mrp), unit_price: p.unit_price == null ? null : Number(p.unit_price) })),
  };
}

/** The customer's default saved address with a map pin; null when there is none (then the list is not ranked by distance). */
export async function getCustomerLocation(userId: string | null): Promise<Loc | null> {
  if (!userId) return null;
  try {
    const list = await getAddresses(userId);
    const a = list.find((x) => x.is_default && x.lat != null && x.lng != null) ?? list.find((x) => x.lat != null && x.lng != null);
    return a && a.lat != null && a.lng != null ? { lat: Number(a.lat), lng: Number(a.lng) } : null;
  } catch {
    return null;
  }
}

export const kmLabel = (km: number | null) => (km == null ? '' : km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`);

// ---- Express / Scheduled delivery -------------------------------------------------------------------------------
export interface StoreSlot { startIso: string; label: string }
export interface StoreSlotDay { key: string; label: string; slots: StoreSlot[] }
const IST_MS = 5.5 * 3600_000;
const pad2 = (n: number) => String(n).padStart(2, '0');
const hm = (mins: number) => {
  const h = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  return `${h % 12 === 0 ? 12 : h % 12}${m ? ':' + pad2(m) : ''} ${h < 12 ? 'AM' : 'PM'}`;
};

/** Day + time windows the customer can pick (India time). The server checks the same rules again. */
export function buildStoreSlots(cfg: StoreDeliveryCfg, now: number = Date.now(), minLeadMinutes = 0): StoreSlotDay[] {
  const lead = Math.max(cfg.lead_minutes, minLeadMinutes);
  const maxDays = Math.max(cfg.max_days, Math.ceil(minLeadMinutes / 1440) + 1);
  const out: StoreSlotDay[] = [];
  const ist = new Date(now + IST_MS);
  for (let d = 0; d <= maxDays; d++) {
    const day = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + d));
    const slots: StoreSlot[] = [];
    for (let m = cfg.slot_first_hour * 60; m + cfg.slot_minutes <= cfg.slot_last_hour * 60; m += cfg.slot_minutes) {
      const startMs = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 0, m) - IST_MS;
      if (startMs < now + lead * 60_000) continue;
      slots.push({ startIso: new Date(startMs).toISOString(), label: `${hm(m)} - ${hm(m + cfg.slot_minutes)}` });
    }
    if (!slots.length) continue;
    const label = d === 0 ? 'Today' : d === 1 ? 'Tomorrow' : day.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
    out.push({ key: `${day.getUTCFullYear()}-${pad2(day.getUTCMonth() + 1)}-${pad2(day.getUTCDate())}`, label, slots });
  }
  return out;
}

// ---- Customised (made-to-order) products ------------------------------------------------------------------------
/** Shrinks a photo (long side 1280 px, JPEG) and stores it in the private bucket under the customer's own folder. Returns the path. */
export async function uploadCustomPhoto(userId: string, file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob: Blob = await new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Could not read the photo'))), 'image/jpeg', 0.82));
  const path = `${userId}/${crypto.randomUUID()}.jpg`;
  const { error } = await supabase.storage.from('custom-order-photos').upload(path, blob, { contentType: 'image/jpeg' });
  if (error) throw new Error(error.message || 'Photo upload failed');
  return path;
}

/** A short-lived link to show the customer their own photo again (e.g. when editing the cart). */
export async function customPhotoUrl(path: string): Promise<string | null> {
  const { data } = await supabase.storage.from('custom-order-photos').createSignedUrl(path, 600);
  return data?.signedUrl ?? null;
}

/** Stars, how many people gave each, and the latest written reviews of one shop. */
export interface StoreRatingSummary {
  avg_rating: number | null; review_count: number;
  distribution: Record<string, number>;
  recent: { rating: number; comment: string; name: string; created_at: string }[];
}
export async function getStoreRatingSummary(storeId: string): Promise<StoreRatingSummary | null> {
  try {
    const { data, error } = await supabase.rpc('store_rating_summary', { p_vendor_id: storeId });
    if (error || !data) return null;
    const d = data as StoreRatingSummary;
    return { ...d, avg_rating: d.avg_rating == null ? null : Number(d.avg_rating) };
  } catch { return null; }
}

/** The latest delivered order the customer has not rated yet (3 days, after a 20 minute wait); null when none. */
export interface PendingReview { order_id: string; vendor_id: string; vendor_name: string; order_number: string | null }
export async function getPendingReview(): Promise<PendingReview | null> {
  try {
    const { data, error } = await supabase.rpc('my_pending_review');
    if (error || !data) return null;
    return data as PendingReview;
  } catch { return null; }
}

/** A shop with fewer ratings than this shows "New" instead of stars, so one 5-star review cannot outrank an established shop. */
export const MIN_REVIEWS_FOR_STARS = 3;

/** Rating, review count and the free-delivery note of each shop card (server decides; nothing is invented). */
export interface StoreCardInfo { store_id: string; avg_rating: number | null; review_count: number; free_delivery: boolean; free_over: number | null; popular?: boolean; logo_url?: string | null }
export async function getStoreCardInfo(cityId: string, stores: { store_id: string; distance_km: number | null }[]): Promise<Record<string, StoreCardInfo>> {
  if (!stores.length) return {};
  try {
    const { data, error } = await supabase.rpc('stores_card_info', { p_city_id: cityId, p_stores: stores.map((x) => ({ id: x.store_id, distance_km: x.distance_km })) });
    if (error || !Array.isArray(data)) return {};
    const out: Record<string, StoreCardInfo> = {};
    for (const r of data as StoreCardInfo[]) out[r.store_id] = { ...r, avg_rating: r.avg_rating == null ? null : Number(r.avg_rating), free_over: r.free_over == null ? null : Number(r.free_over) };
    return out;
  } catch { return {}; }
}
