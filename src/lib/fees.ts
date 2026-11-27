// Delivery / handling / platform fee by order amount (City Admin "Delivery & Fees"). The server decides; this only asks.
// When a city has the fee rules OFF, rules_enabled is false and the old flat fees keep working.
import { supabase } from './supabase';

export interface FeeNudge { kind: 'free_delivery' | 'platform_fee'; add: number; saves: number; text: string }
export interface CheckoutFees {
  rules_enabled: boolean;
  delivery_fee: number;
  handling_fee: number;
  platform_fee: number;
  total_fees: number;
  nudges: FeeNudge[];
}

/** kind: 'food' (one hotel) or 'store' (shops, Kirana, Grocery); shops = shops in the cart; hasFood = a hotel is among them (platform fee). */
export async function getCheckoutFees(cityId: string | null | undefined, distanceKm: number | null, amount: number, kind: 'food' | 'store' = 'store', shops = 1, hasFood = false): Promise<CheckoutFees | null> {
  if (!cityId) return null;
  try {
    const { data, error } = await supabase.rpc('get_checkout_fees_v2', { p_city_id: cityId, p_distance_km: distanceKm ?? 0, p_amount: Math.max(amount, 0), p_kind: kind, p_shops: shops, p_has_food: hasFood });
    if (error || !data) return null;
    const d = data as CheckoutFees;
    return { ...d, delivery_fee: Number(d.delivery_fee), handling_fee: Number(d.handling_fee), platform_fee: Number(d.platform_fee), total_fees: Number(d.total_fees), nudges: (d.nudges ?? []).map((n) => ({ ...n, add: Number(n.add), saves: Number(n.saves) })) };
  } catch {
    return null;
  }
}
