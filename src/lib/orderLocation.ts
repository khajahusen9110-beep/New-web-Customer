// The customer's exact position at the moment the order is placed, sent to the City Admin (and the delivery partner) with the
// order, with its accuracy. Many customers cannot place the address pin correctly; this is where they actually are.
// It runs next to the checkout call, never delays or blocks the order, and does nothing without the browser's permission.
import { supabase } from './supabase';

export interface LiveFix { lat: number; lng: number; accuracy: number }

/** Starts the position search now (returns at once). Resolves null without permission, on no fix or after about 12 seconds. */
export function startOrderLocation(): Promise<LiveFix | null> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return Promise.resolve(null);
  return new Promise((resolve) => {
    let best: LiveFix | null = null;
    let watchId: number | null = null;
    const done = () => {
      if (watchId != null) navigator.geolocation.clearWatch(watchId);
      window.clearTimeout(timer);
      resolve(best);
    };
    const timer = window.setTimeout(done, 12000);
    try {
      watchId = navigator.geolocation.watchPosition(
        (p) => {
          const fix = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy };
          if (!best || fix.accuracy < best.accuracy) best = fix;
          if (fix.accuracy <= 25) done();
        },
        () => done(),
        { enableHighAccuracy: true, maximumAge: 15000, timeout: 12000 },
      );
    } catch {
      done();
    }
  });
}

/** Waits for the search and attaches the position to the placed order; failures are ignored (the order is already placed). */
export async function attachOrderLocation(orderId: string, search: Promise<LiveFix | null>): Promise<void> {
  try {
    const fix = await search;
    if (!fix || !orderId || (fix.lat === 0 && fix.lng === 0)) return;
    await supabase.rpc('record_order_location', { p_order_id: orderId, p_lat: fix.lat, p_lng: fix.lng, p_accuracy_m: fix.accuracy });
  } catch { /* the order is placed; the position is a bonus */ }
}
