import { useEffect, useMemo, useRef, useState } from 'react';
import type { CartItem, CartItemUi, ResolvedProduct } from './types';
import { buildCartLines, getLiveCartProducts } from './repository';

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
    }, { rootMargin: '300px' });
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
export function useFreshCart(items: CartItem[], cityId: string | null | undefined) {
  const [live, setLive] = useState<Map<string, ResolvedProduct>>(() => new Map());
  const [loading, setLoading] = useState(items.length > 0 && !!cityId);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const forceNext = useRef(false);
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
  const reload = () => {
    forceNext.current = true;
    setTick((t) => t + 1);
  };
  return { fresh, loading, error, reload };
}
