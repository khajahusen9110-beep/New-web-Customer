// Quick Helper: book a nearby helper for 30 / 60 / 90 minutes. The server computes the price and enforces every rule;
// this file only calls it.
import { supabase } from './supabase';

export interface HelperRuleItem { text: string; text_kn?: string | null; image_url?: string | null }

export interface HelperCategory {
  id: string;
  name: string;
  name_kn?: string | null;
  description: string;
  description_kn?: string | null;
  image_url?: string | null;
  photos_allowed: boolean;
  photo_required: boolean;
  task_placeholder: string;
  rate_per_30: number;
  durations: number[];
  /** minutes -> price */
  prices: Record<string, number>;
  dos: HelperRuleItem[];
  donts: HelperRuleItem[];
  /** the "Custom helper" option: the customer describes any task */
  is_custom?: boolean;
}

export type HelperPayMode = 'upi' | 'cash' | 'both';

export interface HelperConfig {
  enabled: boolean;
  rate_per_30?: number;
  durations?: number[];
  max_photos?: number;
  banned_note?: string;
  terms_text?: string;
  support_phone?: string;
  payment_mode?: HelperPayMode;
  min_lead_minutes?: number;
  max_days_ahead?: number;
  require_rules_ack?: boolean;
  refund_percent_after_accept?: number;
  extension_enabled?: boolean;
  extension_options?: number[];
  extension_mode?: 'auto' | 'helper_ok';
  max_extensions?: number;
  payment_window_minutes?: number;
  categories?: HelperCategory[];
}

export type HelperStatus = 'pending_payment' | 'requested' | 'accepted' | 'on_the_way' | 'started' | 'completed' | 'cancelled' | 'expired';

export interface HelperExtension {
  id: string;
  minutes: number;
  amount: number;
  status: 'pending_payment' | 'awaiting_helper' | 'applied' | 'declined' | 'expired' | 'cancelled';
  payment_method: 'upi' | 'cash';
  payment_status: 'unpaid' | 'paid' | 'refund_due' | 'refunded';
  expires_at: string | null;
}

export interface HelperBooking {
  id: string;
  category_id?: string | null;
  extensions?: HelperExtension[];
  booking_number: string;
  status: HelperStatus;
  task_type: string;
  task_description: string;
  photo_paths: string[];
  duration_minutes: number;
  requested_for: string | null;
  address_line: string;
  landmark: string | null;
  price_total: number;
  payment_method: string;
  payment_collected: boolean;
  payment_status: 'unpaid' | 'paid' | 'refund_due' | 'refunded';
  refund_amount: number;
  /** Shown to the customer only: the helper asks for it to start / end the work. */
  start_otp: string | null;
  end_otp: string | null;
  started_at: string | null;
  ends_at: string | null;
  completed_at: string | null;
  cancel_reason: string | null;
  rating: number | null;
  review: string | null;
  created_at: string;
  expires_at: string | null;
  helper: { name: string; phone: string | null; avg_rating: number | null; total_ratings: number | null } | null;
}

export const STATUS_LABEL: Record<HelperStatus, string> = {
  pending_payment: 'Payment pending',
  requested: 'Finding a helper',
  accepted: 'Helper accepted',
  on_the_way: 'Helper is on the way',
  started: 'Work in progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
  expired: 'No helper available',
};

export const isActive = (s: HelperStatus) => s === 'pending_payment' || s === 'requested' || s === 'accepted' || s === 'on_the_way' || s === 'started';

const configCache = new Map<string, { at: number; cfg: HelperConfig }>();

export async function getHelperConfig(cityId: string | null | undefined, force = false): Promise<HelperConfig> {
  if (!cityId) return { enabled: false };
  const hit = configCache.get(cityId);
  if (!force && hit && Date.now() - hit.at < 5 * 60_000) return hit.cfg;
  const { data, error } = await supabase.rpc('helper_get_config', { p_city_id: cityId });
  const cfg: HelperConfig = error || !data ? { enabled: false } : (data as HelperConfig);
  configCache.set(cityId, { at: Date.now(), cfg });
  return cfg;
}

export async function createHelperBooking(p: {
  cityId: string; addressId: string; categoryId: string; description: string; photoPaths: string[]; minutes: number; requestedFor: string | null;
  paymentMethod: 'upi' | 'cash'; rulesAccepted: boolean;
  /** The customer's real position and its accuracy (the nearest matching helper is chosen from it); optional. */
  live?: { lat: number; lng: number; accuracy: number } | null;
}): Promise<HelperBooking> {
  const { data, error } = await supabase.rpc('helper_create_booking_v2', {
    p_city_id: p.cityId, p_address_id: p.addressId, p_category_id: p.categoryId, p_description: p.description,
    p_photo_paths: p.photoPaths, p_minutes: p.minutes, p_requested_for: p.requestedFor,
    p_payment_method: p.paymentMethod, p_rules_accepted: p.rulesAccepted,
    p_live_lat: p.live?.lat ?? null, p_live_lng: p.live?.lng ?? null, p_live_accuracy: p.live?.accuracy ?? null,
  });
  if (error) throw new Error(error.message);
  return data as HelperBooking;
}

export async function myHelperBookings(): Promise<HelperBooking[]> {
  const { data, error } = await supabase.rpc('helper_my_bookings');
  if (error) throw new Error(error.message);
  return (data ?? []) as HelperBooking[];
}

export async function getHelperBooking(id: string): Promise<HelperBooking> {
  const { data, error } = await supabase.rpc('helper_get_booking', { p_id: id });
  if (error) throw new Error(error.message);
  return data as HelperBooking;
}

export async function cancelHelperBooking(id: string, reason?: string): Promise<void> {
  const { error } = await supabase.rpc('helper_cancel_booking', { p_id: id, p_reason: reason ?? null });
  if (error) throw new Error(error.message);
}

export async function rateHelperBooking(id: string, rating: number, review: string): Promise<void> {
  const { error } = await supabase.rpc('helper_rate_booking', { p_id: id, p_rating: rating, p_review: review || null });
  if (error) throw new Error(error.message);
}

/** Squeezes the photo (max 1280 px) and stores it in the customer's private folder. Returns the storage path. */
export async function uploadHelperPhoto(userId: string, file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob: Blob = await new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Could not read the photo'))), 'image/jpeg', 0.82));
  const path = `${userId}/${crypto.randomUUID()}.jpg`;
  const { error } = await supabase.storage.from('helper-task-photos').upload(path, blob, { contentType: 'image/jpeg' });
  if (error) throw new Error(error.message || 'Photo upload failed');
  return path;
}

export async function helperPhotoUrl(path: string): Promise<string | null> {
  const { data } = await supabase.storage.from('helper-task-photos').createSignedUrl(path, 600);
  return data?.signedUrl ?? null;
}

async function paymentCall<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('helper-payment', { body });
  if (error) {
    // the function answers with a plain message; read it when there is one
    let msg = 'Payment step failed. Please try again.';
    try { const j = await (error as { context?: Response }).context?.json(); if (j?.error) msg = j.error; } catch { /* keep the default */ }
    throw new Error(msg);
  }
  if (data?.error) throw new Error(data.error);
  return data as T;
}

/** The Razorpay order for a booking that waits for its advance payment. */
export async function createHelperPayment(bookingId: string): Promise<{ keyId: string; amount: number; currency: string; razorpayOrderId: string }> {
  const d = await paymentCall<{ key_id: string; amount: number; currency: string; razorpay_order_id: string }>({ action: 'create', booking_id: bookingId });
  return { keyId: d.key_id, amount: d.amount, currency: d.currency, razorpayOrderId: d.razorpay_order_id };
}

export async function verifyHelperPayment(bookingId: string, orderId: string, paymentId: string, signature: string): Promise<void> {
  await paymentCall({ action: 'verify', booking_id: bookingId, razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature });
}

/** Asks the server to check Razorpay (a payment the app never reported) and to send a refund that is due. Never throws. */
export async function syncHelperPayment(bookingId: string): Promise<void> {
  try { await paymentCall({ action: 'sync', booking_id: bookingId }); } catch { /* the next poll tries again */ }
}

/** The customer asks for more time while the work is running. The server works out the price. */
export async function requestHelperExtension(bookingId: string, minutes: number): Promise<HelperExtension> {
  const { data, error } = await supabase.rpc('helper_request_extension', { p_booking_id: bookingId, p_minutes: minutes });
  if (error) throw new Error(error.message);
  return data as HelperExtension;
}

export async function createExtensionPayment(extId: string): Promise<{ keyId: string; amount: number; currency: string; razorpayOrderId: string }> {
  const d = await paymentCall<{ key_id: string; amount: number; currency: string; razorpay_order_id: string }>({ action: 'create_ext', extension_id: extId });
  return { keyId: d.key_id, amount: d.amount, currency: d.currency, razorpayOrderId: d.razorpay_order_id };
}

export async function verifyExtensionPayment(extId: string, orderId: string, paymentId: string, signature: string): Promise<void> {
  await paymentCall({ action: 'verify_ext', extension_id: extId, razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature });
}

export async function syncExtensionPayment(extId: string): Promise<void> {
  try { await paymentCall({ action: 'sync_ext', extension_id: extId }); } catch { /* the next poll tries again */ }
}
