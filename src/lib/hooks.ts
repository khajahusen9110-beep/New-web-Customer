import { useEffect, useRef, useState } from 'react';
import type { CartItem, CartItemUi } from './types';
import { getFreshCartItems } from './repository';

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

/** Live-priced cart lines, re-fetched whenever the cart or city changes. */
export function useFreshCart(items: CartItem[], cityId: string | null | undefined) {
  const [fresh, setFresh] = useState<CartItemUi[]>([]);
  const [loading, setLoading] = useState(items.length > 0 && !!cityId);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    if (!cityId || items.length === 0) {
      setFresh([]);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    getFreshCartItems(items, cityId)
      .then((r) => !cancelled && setFresh(r))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : 'Could not load live prices'))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [items, cityId, tick]);
  return { fresh, loading, error, reload: () => setTick((t) => t + 1) };
}
