import type {
  CartItemUi,
  CustomerNotification,
  DeliverySlot,
  ExpressDeliverySettings,
  OperatingSlot,
  ResolvedProduct,
  Vendor,
} from './types';

// ---------- Phone numbers (ported from PhoneUtils.kt) ----------

function stripCountryCode(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  return digits.startsWith('91') && digits.length > 10 ? digits.substring(2) : digits;
}

/** Always returns "+91XXXXXXXXXX". */
export function toE164(raw: string): string {
  return `+91${stripCountryCode(raw)}`;
}

export function to10Digits(raw: string): string {
  return stripCountryCode(raw).slice(0, 10);
}

export function isValidPhoneNumber(raw: string): boolean {
  return stripCountryCode(raw).length === 10;
}

// ---------- Money / dates ----------

export const rupees = (n: number | null | undefined, decimals = 0) =>
  `₹${(n ?? 0).toFixed(decimals)}`;

/** "2026-09-10T19:00:00Z" -> "2026-09-10 19:00" (same as the app's take(16)). */
export const shortDateTime = (iso?: string | null) =>
  iso ? iso.slice(0, 16).replace('T', ' ') : '';

export function formatRelativeTime(iso?: string | null): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const diff = Date.now() - t;
  if (diff < 60_000) return 'Just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 172_800_000) return 'Yesterday';
  return new Date(t).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export const capitalize = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

// ---------- Operating hours (ported from OperatingHoursUtil.kt) ----------

/** Parses "11:00", "11:00:00", "11:00 AM", "6:30PM" into minutes since midnight. */
export function parseTimeString(value: string): number | null {
  const clean = value.trim().replace(/\s+/g, ' ').toUpperCase();
  const m = clean.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s?(AM|PM)?$/);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const sec = m[3] ? parseInt(m[3], 10) : 0;
  const ampm = m[4];
  if (ampm) {
    if (h < 1 || h > 12) return null;
    if (ampm === 'AM' && h === 12) h = 0;
    if (ampm === 'PM' && h !== 12) h += 12;
  }
  if (h > 23 || min > 59 || sec > 59) return null;
  return h * 60 + min + sec / 60;
}

function nowMinutes(): number {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
}

/** True when there are no hours set or parsing fails (never block ordering by mistake). */
export function isWithinOperatingHours(open?: string | null, close?: string | null): boolean {
  if (!open || !close) return true;
  const o = parseTimeString(open);
  const c = parseTimeString(close);
  if (o === null || c === null) return true;
  const now = nowMinutes();
  return o <= c ? now >= o && now <= c : now >= o || now <= c;
}

export function isWithinAnySlot(slots: OperatingSlot[]): boolean {
  if (slots.length === 0) return true;
  return slots.some((s) => isWithinOperatingHours(s.start_time, s.end_time));
}

export const shortTime = (t?: string | null) => {
  if (!t) return '';
  return t.length >= 8 && t.split(':').length === 3 ? t.slice(0, 5) : t;
};

// ---------- Product helpers (ported from ResolvedProduct) ----------

export function isInStockAndActive(p: ResolvedProduct): boolean {
  if (p.variants.length > 0) {
    return p.isActive && p.variants.some((v) => v.isAvailable && v.stockQty > 0);
  }
  return p.isActive && p.effectiveIsAvailable && p.effectiveStock > 0;
}

export function isHotelItemAvailable(p: ResolvedProduct, vendorSlots: OperatingSlot[] = []): boolean {
  if (!p.isActive || !p.effectiveIsAvailable) return false;
  if (p.base.available_from && p.base.available_until) {
    return isWithinOperatingHours(p.base.available_from, p.base.available_until);
  }
  return isWithinAnySlot(vendorSlots);
}

// ---------- Featured / open-now ordering ----------

/** A hotel's operating hours: its hour slots, else opening/closing time, else none (= always open). */
export function vendorHours(v: Vendor, slots?: OperatingSlot[] | null): OperatingSlot[] {
  if (slots && slots.length) return slots;
  if (v.opening_time && v.closing_time) {
    return [{ id: 'vendor', vendor_id: v.id, start_time: v.opening_time, end_time: v.closing_time }];
  }
  return [];
}

/**
 * Open right now: active, not switched off by the hotel, and inside its hours. The single check
 * behind the OPEN NOW / CLOSED badge, the grayscale card, the menu page and the list order.
 */
export function isVendorOpenNow(v: Vendor, slots?: OperatingSlot[] | null): boolean {
  return v.is_active !== false && v.is_open !== false && isWithinAnySlot(vendorHours(v, slots));
}

/** 0 open + featured, 1 open, 2 closed + featured, 3 closed. Featured never beats open. */
export function hotelTier(v: Vendor, slots?: OperatingSlot[] | null): number {
  const open = isVendorOpenNow(v, slots);
  const featured = v.is_featured === true;
  return open && featured ? 0 : open ? 1 : featured ? 2 : 3;
}

export function sortHotels(list: Vendor[], slotsOf: (vendorId: string) => OperatingSlot[] | null | undefined): Vendor[] {
  return list
    .map((v) => ({ v, tier: hotelTier(v, slotsOf(v.id)) }))
    .sort((a, b) => a.tier - b.tier || a.v.name.toLowerCase().localeCompare(b.v.name.toLowerCase()))
    .map((x) => x.v);
}

/** 0 in stock + featured, 1 in stock, 2 unavailable + featured, 3 unavailable. */
export function groceryTier(p: ResolvedProduct): number {
  const inStock = isInStockAndActive(p);
  return inStock && p.isFeatured ? 0 : inStock ? 1 : p.isFeatured ? 2 : 3;
}

export function sortGroceryProducts(list: ResolvedProduct[]): ResolvedProduct[] {
  return [...list].sort((a, b) => groceryTier(a) - groceryTier(b) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

export const startingPrice = (p: ResolvedProduct) =>
  p.variants.length ? Math.min(...p.variants.map((v) => v.price)) : p.effectivePrice;

export const cartTotal = (items: CartItemUi[]) => items.reduce((s, i) => s + i.totalPrice, 0);

// ---------- Delivery fee helpers (ported from DeliverySlot / ExpressDeliverySettings) ----------

export function slotIsFreeEligible(slot: DeliverySlot, subtotal: number): boolean {
  const minOrder = slot.min_order_amount ?? 0;
  return slot.is_free_delivery === true && (minOrder <= 0 || subtotal >= minOrder);
}

export function slotFee(slot: DeliverySlot, subtotal: number): number {
  return slotIsFreeEligible(slot, subtotal) ? 0 : slot.delivery_fee ?? 0;
}

export function slotAmountNeededForFree(slot: DeliverySlot, subtotal: number): number {
  if (slot.is_free_delivery !== true) return 0;
  const minOrder = slot.min_order_amount ?? 0;
  if (minOrder <= 0) return 0;
  return Math.max(minOrder - subtotal, 0);
}

export function expressEstimatedMinutes(s: ExpressDeliverySettings): number {
  return s.max_delivery_minutes ?? 30;
}

export function expressCharge(
  s: ExpressDeliverySettings,
  distanceKm: number,
  subtotal: number,
): { fee: number; isFree: boolean } {
  const minFree = s.free_delivery_min_order;
  const maxFreeKm = s.free_delivery_max_km;
  if (minFree != null && maxFreeKm != null && subtotal >= minFree && distanceKm <= maxFreeKm) {
    return { fee: 0, isFree: true };
  }
  const baseKm = s.base_km ?? 0;
  const baseCharge = s.base_charge ?? 0;
  const perKm = s.per_km_charge_beyond ?? 0;
  const fee = distanceKm <= baseKm ? baseCharge : baseCharge + (distanceKm - baseKm) * perKm;
  return { fee: Math.max(fee, 0), isFree: false };
}

// ---------- Geo ----------

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return r * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export const isValidIndianCoordinate = (lat: number, lng: number) =>
  lat >= 6 && lat <= 38 && lng >= 68 && lng <= 98;

/** Regional hub coordinates used by the app as a fallback. */
export const KNOWN_HUBS: Record<string, [number, number]> = {
  sindhanur: [15.7667, 76.7583],
  raichur: [16.212, 77.3439],
  bellary: [15.1394, 76.9214],
  ballari: [15.1394, 76.9214],
  gangavathi: [15.4326, 76.5312],
  manvi: [15.9922, 77.0506],
  koppal: [15.3524, 76.1557],
};

export const DEFAULT_CENTER: [number, number] = KNOWN_HUBS.sindhanur;

// ---------- Notifications ----------

export const notificationTitle = (n: CustomerNotification) =>
  n.title?.trim() ? n.title : 'Order Update';

export const notificationBody = (n: CustomerNotification) =>
  n.body?.trim() ? n.body : 'Your order status has been updated.';

export function notificationOrderId(n: CustomerNotification): string | null {
  const data = n.data ?? {};
  const id = (data['order_id'] ?? data['orderId']) as unknown;
  return typeof id === 'string' && id.trim() ? id : null;
}

// ---------- Errors ----------

export function errorMessage(e: unknown, fallback = 'Something went wrong'): string {
  if (!e) return fallback;
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message || fallback;
  const obj = e as { message?: string; error_description?: string; details?: string; hint?: string };
  const msg = obj.message || obj.error_description || obj.details;
  if (!msg) return fallback;
  return obj.hint ? `${msg} (Hint: ${obj.hint})` : msg;
}
