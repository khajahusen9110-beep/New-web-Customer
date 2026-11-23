// Price quotes for custom shop orders: the customer asks, the shop sends a price, the customer accepts and orders at that price.
// The server holds every rule (who may ask, timing, one use only); checkout takes the quoted price from the server.
import { supabase } from './supabase';

export type QuoteStatus = 'requested' | 'quoted' | 'accepted' | 'declined' | 'cancelled' | 'expired' | 'used';
export interface StoreQuote {
  id: string;
  vendor_id: string;
  vendor_name: string;
  product_id: string;
  product_name: string;
  product_image: string | null;
  variant_id: string | null;
  variant_label: string | null;
  quantity: number;
  note: string | null;
  photo_path: string | null;
  status: QuoteStatus;
  quoted_unit_price: number | null;
  vendor_note: string | null;
  expires_at: string;
  valid_until: string | null;
  created_at: string;
  order_id: string | null;
}

export const QUOTE_LABEL: Record<QuoteStatus, string> = {
  requested: 'Waiting for the shop', quoted: 'Price received', accepted: 'Accepted', declined: 'Declined', cancelled: 'Cancelled', expired: 'Expired', used: 'Ordered',
};

export async function requestQuote(p: { vendorId: string; productId: string; variantId: string | null; quantity: number; note: string | null; photoPath: string | null }): Promise<void> {
  const { error } = await supabase.rpc('store_quote_request', {
    p_vendor_id: p.vendorId, p_product_id: p.productId, p_variant_id: p.variantId, p_quantity: p.quantity, p_note: p.note, p_photo_path: p.photoPath,
  });
  if (error) throw new Error(error.message || 'Could not send the request');
}

export async function myQuotes(): Promise<StoreQuote[]> {
  const { data, error } = await supabase.rpc('store_quotes_mine');
  if (error) throw new Error(error.message || 'Could not load your quotes');
  return ((data ?? []) as StoreQuote[]).map((q) => ({ ...q, quantity: Number(q.quantity), quoted_unit_price: q.quoted_unit_price == null ? null : Number(q.quoted_unit_price) }));
}

export async function answerQuote(id: string, accept: boolean): Promise<void> {
  const { error } = await supabase.rpc('store_quote_respond', { p_quote_id: id, p_accept: accept });
  if (error) throw new Error(error.message || 'Could not answer');
}

export async function cancelQuote(id: string): Promise<void> {
  const { error } = await supabase.rpc('store_quote_cancel', { p_quote_id: id });
  if (error) throw new Error(error.message || 'Could not cancel');
}
