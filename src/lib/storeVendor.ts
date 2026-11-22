// Is this vendor a store (a local shop) or a hotel? Stores use their own checkout function on the server.
// Kept in its own tiny file so the cart/checkout code can use it without a circular import.
import { supabase } from './supabase';

const known = new Map<string, boolean>();

export async function isStoreVendor(vendorId: string | null | undefined): Promise<boolean> {
  if (!vendorId) return false;
  const hit = known.get(vendorId);
  if (hit !== undefined) return hit;
  try {
    const { data, error } = await supabase.rpc('is_store_vendor', { p_vendor_id: vendorId });
    if (error) return false; // older server without Stores: it is a hotel
    const v = data === true;
    known.set(vendorId, v);
    return v;
  } catch {
    return false;
  }
}

export function rememberStoreVendor(vendorId: string, isStore: boolean) {
  known.set(vendorId, isStore);
}
