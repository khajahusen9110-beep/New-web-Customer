import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CartItem, CartItemUi, MyWallet, OperatingSlot, ResolvedProduct, Vendor } from './types';
import { buildCartLines, getLiveCartProducts, getMyWallet, getVendor, getVendorOperatingSlots } from './repository';
import { cartTotal, checkCartLine, hotelClosedMessage, isVendorOpenNow, type CartLineCheck } from './utils';
import { useCart } from '../store/cart';

export function useDebounced<T>(value: T, ms = 350): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Calls `onVisible` when the returned ref's element scrolls into view (infinite scroll). */
export function useInfiniteSentinel(onVisible: () => void, enabled: boolean) {
  const ref = useRef<HTMLDivElement | null>(null);
  const cb = useRef(onVisible);
  cb.current = onVisible;
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) cb.current();
    }, { rootMargin: '1200px' }); // start well before the end (next page is usually prefetched already)
    io.observe(el);
    return () => io.disconnect();
  }, [enabled]);
  return ref;
}

/**
 * Live-priced cart lines. Prices are requested only when the set of products (or the city)
 * changes; quantity changes are priced locally from the already-fetched data, and pages showing
 * the same cart share one request through the repository cache.
 */
export function useFreshCart(items: CartItem[], cityId: string | null | undefined, forceOnMount = false) {
  const [live, setLive] = useState<Map<string, ResolvedProduct>>(() => new Map());
  const [loading, setLoading] = useState(items.length > 0 && !!cityId);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const forceNext = useRef(forceOnMount);
  const idsKey = useMemo(() => Array.from(new Set(items.map((i) => i.product_id))).sort().join(','), [items]);
  useEffect(() => {
    let cancelled = false;
    if (!cityId || !idsKey) {
      setLive(new Map());
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    const force = forceNext.current;
    forceNext.current = false;
    getLiveCartProducts(idsKey.split(','), cityId, force)
      .then((r) => !cancelled && setLive(r))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : 'Could not load live prices'))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [idsKey, cityId, tick]);
  const fresh = useMemo<CartItemUi[]>(() => buildCartLines(items, live), [items, live]);
  const reload = useCallback(() => {
    forceNext.current = true;
    setTick((t) => t + 1);
  }, []);
  return { fresh, loading, error, reload };
}

const NO_CART: CartItem[] = [];

export type CheckedCartLine = CartItemUi & CartLineCheck & { key: string; reducedTo: number | null };

export const cartLineKey = (i: CartItem) => `${i.product_id}_${i.variant_id ?? 'base'}`;

/**
 * Cart / checkout view of the cart: fresh data for every line (one batched request on open, on
 * return to the tab and every minute), each line marked ok / unavailable / out of stock, grocery
 * quantities above stock lowered automatically, and totals that count only orderable lines.
 */
export function useCartCheck(rawItems: CartItem[], cityId: string | null | undefined, isHotel: boolean) {
  // The site opens before the saved cart is reconciled with the server; never check, lower or
  // order a cart that may still change.
  const hydrated = useCart((s) => s.hydrated);
  const items = hydrated ? rawItems : NO_CART;
  const { fresh, loading: loadingLines, error, reload: reloadLines } = useFreshCart(items, cityId, true);
  const loading = loadingLines || !hydrated;
  const updateQuantity = useCart((s) => s.updateQuantity);
  const removeItems = useCart((s) => s.removeItems);

  // Hotel open/closed (hotel cart only), re-checked together with the items.
  const vendorId = isHotel ? items.find((i) => i.vendor_id)?.vendor_id ?? null : null;
  const [hotel, setHotel] = useState<{ vendor: Vendor | null; slots: OperatingSlot[] } | null>(null);
  const [vendorTick, setVendorTick] = useState(0);
  useEffect(() => {
    if (!vendorId) {
      setHotel(null);
      return;
    }
    let cancelled = false;
    // Always fresh: the hotel may have closed since the menu was opened.
    Promise.all([getVendor(vendorId, true), getVendorOperatingSlots(vendorId, true)])
      .then(([vendor, slots]) => !cancelled && setHotel({ vendor, slots }))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [vendorId, vendorTick]);

  // Item timings and hotel hours change with the clock.
  const [, setMinute] = useState(0);
  const reload = useCallback(() => {
    reloadLines();
    setVendorTick((t) => t + 1);
  }, [reloadLines]);
  useEffect(() => {
    const onVisible = () => document.visibilityState === 'visible' && reload();
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      setMinute((m) => m + 1);
      reload();
    }, 60_000);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [reload]);

  // "Only N left - quantity updated" notes, kept while the quantity stays at that number.
  const [reduced, setReduced] = useState<Record<string, number>>({});

  const checked: CheckedCartLine[] = fresh.map((l) => {
    const key = cartLineKey(l.cartItem);
    const r = reduced[key];
    return { ...l, ...checkCartLine(l, isHotel), key, reducedTo: r != null && r === l.cartItem.quantity ? r : null };
  });

  // Lower grocery quantities that are above the stock left.
  useEffect(() => {
    if (isHotel || loading) return;
    const over = checked.filter((l) => l.state === 'ok' && l.maxQty != null);
    if (!over.length) return;
    setReduced((cur) => {
      const next = { ...cur };
      for (const l of over) next[l.key] = l.maxQty!;
      return next;
    });
    for (const l of over) updateQuantity(l.cartItem.product_id, false, l.maxQty!, l.cartItem.variant_id);
  });

  const hotelOpen = !hotel?.vendor || isVendorOpenNow(hotel.vendor, hotel.slots);
  const hotelClosed = isHotel && !!hotel && !hotelOpen ? hotelClosedMessage(hotel.vendor, hotel.slots) : null;
  const available = checked.filter((l) => l.state === 'ok');
  const unavailable = checked.filter((l) => l.state !== 'ok');
  // Lines not in `fresh` yet (still loading) are neither; never order before every line is checked.
  const allChecked = hydrated && !loading && checked.length === items.length;

  const removeUnavailable = useCallback(() => {
    removeItems(isHotel, unavailable.map((l) => l.cartItem));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [removeItems, isHotel, unavailable.map((l) => l.key).join(',')]);

  return {
    lines: checked,
    available,
    unavailable,
    subtotal: cartTotal(available),
    hotelClosed,
    allChecked,
    loading,
    error,
    reload,
    removeUnavailable,
  };
}

/** The customer's wallet summary (shared, cached for a minute); null until loaded or if it fails. */
export function useMyWallet(enabled = true): MyWallet | null {
  const [wallet, setWallet] = useState<MyWallet | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    getMyWallet()
      .then((w) => !cancelled && setWallet(w))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return wallet;
}
