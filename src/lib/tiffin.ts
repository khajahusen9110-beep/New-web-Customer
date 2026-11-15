// Tiffin Pickup: a monthly plan where a delivery partner collects a home-made tiffin every chosen
// day and drops it at a school or office (optionally bringing the empty box back). The server
// computes every price and enforces every rule; this file only calls it.
import { supabase } from './supabase';
import { openSubscriptionCheckout } from './razorpay';

export type TiffinKind = 'school' | 'office' | 'other';
export type AutopayStatus = 'none' | 'created' | 'authenticated' | 'active' | 'pending' | 'halted' | 'cancelled' | 'completed';
export type TiffinStatus = 'pending_payment' | 'active' | 'paused' | 'completed' | 'cancelled';

export interface TiffinConfig {
  enabled: boolean;
  slabs: { up_to_km: number; price: number; return_price: number }[];
  full_month_trips: number;
  earliest_pickup: string; // "HH:MM"
  latest_pickup: string;
  latest_return_pickup: string;
  skip_cutoff_hour: number;
  trial_enabled?: boolean;
  trial_days?: number;
  trial_price?: number;
}

export interface TiffinQuote {
  ok: boolean;
  message?: string;
  distance_km?: number;
  trips?: number;
  price_one_way?: number;
  price_return?: number;
  total?: number;
  trial_available?: boolean;
  trial_days?: number;
  trial_price?: number;
  trial_trips?: number;
  first_charge_date?: string;
}

export interface TiffinTrip {
  id: string;
  trip_date: string;
  leg: 'drop' | 'return';
  status: 'scheduled' | 'picked_up' | 'delivered' | 'missed' | 'cancelled';
  scheduled_time: string;
  picked_up_at: string | null;
  delivered_at: string | null;
  delivered_photo_url: string | null;
}

export interface TiffinSubscription {
  id: string;
  kind: TiffinKind;
  recipient_name: string;
  recipient_detail: string | null;
  handover_note: string | null;
  pickup_address: string;
  drop_label: string | null;
  drop_address: string;
  days: number[]; // ISO weekdays, 1 = Monday
  pickup_time: string; // "HH:MM:SS"
  return_trip: boolean;
  return_pickup_time: string | null;
  distance_km: number;
  total_amount: number;
  trips_total: number;
  trips_remaining: number;
  start_date: string;
  end_date: string;
  status: TiffinStatus;
  is_trial: boolean;
  trial_days: number | null;
  trial_fee: number;
  trial_end_date: string | null;
  autopay_status: AutopayStatus;
  billing_cycles_paid: number;
  next_charge_date: string | null;
  partner: { name: string; phone: string | null } | null;
  skips: string[];
  trips: TiffinTrip[];
}

export interface TiffinPlanInput {
  pickupAddressId: string;
  dropAddressId: string;
  kind: TiffinKind;
  recipientName: string;
  recipientDetail: string;
  handoverNote: string;
  days: number[];
  pickupTime: string; // "HH:MM"
  returnTrip: boolean;
  returnPickupTime: string;
  startDate: string; // "YYYY-MM-DD"
}

function fail(error: { message?: string } | null, fallback: string): never {
  throw new Error(error?.message || fallback);
}

/** Null when the feature cannot be read (e.g. the backend does not have it yet): treat as off. */
export async function getTiffinConfig(cityId: string): Promise<TiffinConfig | null> {
  const { data, error } = await supabase.rpc('tiffin_get_config', { p_city_id: cityId });
  if (error || !data) return null;
  return data as TiffinConfig;
}

export async function getTiffinQuote(
  pickupAddressId: string,
  dropAddressId: string,
  days: number[],
  returnTrip: boolean,
  startDate: string,
): Promise<TiffinQuote> {
  const { data, error } = await supabase.rpc('tiffin_quote', {
    p_pickup_address_id: pickupAddressId,
    p_drop_address_id: dropAddressId,
    p_days: days,
    p_return: returnTrip,
    p_start_date: startDate,
  });
  if (error) fail(error, 'Could not get the price');
  return data as TiffinQuote;
}

export async function createTiffinPlan(input: TiffinPlanInput): Promise<string> {
  const { data, error } = await supabase.rpc('tiffin_subscribe', {
    p_pickup_address_id: input.pickupAddressId,
    p_drop_address_id: input.dropAddressId,
    p_kind: input.kind,
    p_recipient_name: input.recipientName,
    p_recipient_detail: input.recipientDetail,
    p_handover_note: input.handoverNote,
    p_days: input.days,
    p_pickup_time: input.pickupTime,
    p_return: input.returnTrip,
    p_return_pickup_time: input.returnTrip ? input.returnPickupTime : null,
    p_start_date: input.startDate,
  });
  if (error) fail(error, 'Could not create the plan');
  return (data as { id: string }).id;
}

export async function getMyTiffinPlans(): Promise<TiffinSubscription[]> {
  const { data, error } = await supabase.rpc('tiffin_my_subscriptions');
  if (error) fail(error, 'Could not load your tiffin plans');
  return (data ?? []) as TiffinSubscription[];
}

export async function setTiffinDaySkipped(subscriptionId: string, date: string, skip: boolean): Promise<void> {
  const { error } = await supabase.rpc('tiffin_skip_day', { p_subscription_id: subscriptionId, p_date: date, p_skip: skip });
  if (error) fail(error, 'Could not change that day');
}

export async function setTiffinPaused(subscriptionId: string, paused: boolean): Promise<void> {
  const { error } = await supabase.rpc('tiffin_set_paused', { p_subscription_id: subscriptionId, p_paused: paused });
  if (error) fail(error, paused ? 'Could not pause the plan' : 'Could not resume the plan');
}

export async function cancelTiffinRequest(subscriptionId: string): Promise<void> {
  const { error } = await supabase.rpc('tiffin_cancel_request', { p_subscription_id: subscriptionId });
  if (error) fail(error, 'Could not cancel the request');
}

/** A short-lived link to a handover photo (the bucket is private; only the plan's owner can read it). */
export async function getTiffinPhotoUrl(path: string): Promise<string | null> {
  const { data } = await supabase.storage.from('delivery-proof-photos').createSignedUrl(path, 300);
  return data?.signedUrl ?? null;
}

// ---- dates: the service runs on India time, whatever the device clock says ----

/** Today in India as "YYYY-MM-DD". */
export function indiaToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** ISO weekday of a "YYYY-MM-DD" date: 1 = Monday .. 7 = Sunday. */
export function isoWeekday(date: string): number {
  const d = new Date(`${date}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

// Weekday and month names follow the language chosen on the Tiffin page.
let dateLocale = 'en-IN';
export function setTiffinDateLocale(lang: 'en' | 'kn') {
  dateLocale = lang === 'kn' ? 'kn-IN' : 'en-IN';
}

export function dayLabel(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(dateLocale, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/** "07:30:00" or "07:30" -> "7:30 AM". */
export function timeLabel(t: string | null | undefined): string {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  const hh = ((h + 11) % 12) + 1;
  return `${hh}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

/** The plan's next delivery days (from tomorrow), skipped ones included so they can be un-skipped. */
export function upcomingPlanDays(plan: Pick<TiffinSubscription, 'days' | 'start_date' | 'end_date'>, count = 7): string[] {
  const out: string[] = [];
  let d = addDays(indiaToday(), 1);
  if (d < plan.start_date) d = plan.start_date;
  for (let i = 0; i < 45 && out.length < count && d <= plan.end_date; i++, d = addDays(d, 1)) {
    if (plan.days.includes(isoWeekday(d))) out.push(d);
  }
  return out;
}

// ---- monthly auto-pay (trial fee now, then the monthly price) ----

export const isAutopayLive = (s: AutopayStatus) => s === 'authenticated' || s === 'active' || s === 'pending';

async function callAutopay(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.functions.invoke('tiffin-autopay', { body });
  if (error) {
    // The function answers with a readable { error } body on a refusal.
    let msg = 'Could not complete this. Please try again.';
    try {
      const ctx = (error as { context?: Response }).context;
      const j = ctx ? await ctx.json() : null;
      if (j?.error) msg = String(j.error);
    } catch {
      /* keep the generic message */
    }
    throw new Error(msg);
  }
  return (data ?? {}) as Record<string, unknown>;
}

export type AutopayOutcome = 'paid' | 'cancelled';

/** Opens the payment screen for a plan that is waiting for payment and activates it once paid. */
export async function payTiffinPlan(subscriptionId: string, phone?: string | null, email?: string | null): Promise<AutopayOutcome> {
  const r = await callAutopay({ action: 'create', subscription_id: subscriptionId });
  const result = await openSubscriptionCheckout({
    keyId: String(r.key_id),
    subscriptionId: String(r.razorpay_subscription_id),
    description: r.is_trial ? 'Tiffin Pickup trial, then monthly auto-pay' : 'Tiffin Pickup monthly plan',
    phone,
    email,
  });
  if (result.kind === 'cancelled') return 'cancelled';
  if (result.kind === 'error') throw new Error(result.message);
  await callAutopay({
    action: 'verify',
    subscription_id: subscriptionId,
    razorpay_payment_id: result.paymentId,
    razorpay_subscription_id: result.subscriptionId,
    razorpay_signature: result.signature,
  });
  return 'paid';
}

export async function stopTiffinAutopay(subscriptionId: string): Promise<void> {
  await callAutopay({ action: 'stop', subscription_id: subscriptionId });
}
