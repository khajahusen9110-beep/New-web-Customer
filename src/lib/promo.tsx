import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { supabase } from './supabase';
import { useSession } from '../store/session';
import { rupees } from './utils';

// Promotional offer, fetched from the backend (public.get_active_promo). The discount % lives ONLY
// in promo_campaigns — one change there updates the banner, every item's strikethrough price, the
// badges and the checkout together. When no offer is active, every field is null and nothing shows.

export type PromoKind = 'food' | 'grocery';

export interface PromoInfo {
  percent: number;
  maxCap: number | null;
  minOrder: number;
  startsAt: string | null;
  endsAt: string | null;
  bannerNote: string | null;
}

interface PromoState {
  food: PromoInfo | null;
  grocery: PromoInfo | null;
  loaded: boolean;
}

const Ctx = createContext<PromoState>({ food: null, grocery: null, loaded: false });

async function fetchOne(cityId: string, type: PromoKind): Promise<PromoInfo | null> {
  try {
    const { data, error } = await supabase.rpc('get_active_promo', { p_city_id: cityId, p_type: type });
    if (error || !data || !data.length) return null;
    const r: any = data[0];
    const percent = Number(r.percent) || 0;
    if (percent <= 0) return null;
    return {
      percent,
      maxCap: r.max_discount_per_order != null ? Number(r.max_discount_per_order) : null,
      minOrder: Number(r.min_order_amount) || 0,
      startsAt: r.starts_at ?? null,
      endsAt: r.ends_at ?? null,
      bannerNote: r.banner_note ?? null,
    };
  } catch {
    return null;
  }
}

export function PromoProvider({ children }: { children: React.ReactNode }) {
  const cityId = useSession((s) => s.selectedCity?.id ?? '');
  const [state, setState] = useState<PromoState>({ food: null, grocery: null, loaded: false });

  const reload = useCallback(async () => {
    if (!cityId) {
      setState({ food: null, grocery: null, loaded: true });
      return;
    }
    const [food, grocery] = await Promise.all([fetchOne(cityId, 'food'), fetchOne(cityId, 'grocery')]);
    setState({ food, grocery, loaded: true });
  }, [cityId]);

  useEffect(() => {
    reload();
    const t = setInterval(reload, 60000); // pick up admin changes / expiry within a minute
    return () => clearInterval(t);
  }, [reload]);

  return <Ctx.Provider value={state}>{children}</Ctx.Provider>;
}

export const usePromo = () => useContext(Ctx);
export const usePromoFor = (kind?: PromoKind): PromoInfo | null => {
  const s = usePromo();
  if (kind === 'grocery') return s.grocery;
  if (kind === 'food') return s.food;
  return null;
};

/** Offer price for a single item (same rounding as the server item view). */
export const offerPrice = (price: number, percent: number) => Math.round((price * (100 - percent)) / 100);

/** Cart/checkout discount — mirrors the server promo_discount_for (percent, min order, max cap). */
export function cartPromoDiscount(subtotal: number, p: PromoInfo | null): number {
  if (!p || p.percent <= 0 || subtotal < p.minOrder) return 0;
  let d = Math.round(((subtotal * p.percent) / 100) * 100) / 100;
  if (p.maxCap != null) d = Math.min(d, p.maxCap);
  return Math.max(0, Math.min(d, subtotal));
}

/** Compact price for tight spots (grocery "Starting from", variant rows, dish matches):
 *  offer price with the original struck through. Plain spans, so it is safe inside <strong>/<div>. */
export function OfferInline({ price, kind, prefix }: { price: number; kind: PromoKind; prefix?: string }) {
  const p = usePromoFor(kind);
  if (!p || p.percent <= 0) return <>{prefix}{rupees(price)}</>;
  return (
    <>
      {prefix}
      <span>{rupees(offerPrice(price, p.percent))}</span>{' '}
      <span style={{ textDecoration: 'line-through', opacity: 0.55, fontWeight: 400 }}>{rupees(price)}</span>
    </>
  );
}
