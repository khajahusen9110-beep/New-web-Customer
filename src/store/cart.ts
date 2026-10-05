import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { supabase } from '../lib/supabase';
import type { CartItem } from '../lib/types';
import { useSession } from './session';

// In-memory carts are the UI source of truth; they are mirrored to the
// cart_items table (no prices stored) exactly like the Android app does.

export type AddToCartResult =
  | { kind: 'success' }
  | { kind: 'hotelConflict'; existingVendorId: string; newVendorId: string; pendingItem: CartItem };

interface CartState {
  groceryCart: CartItem[];
  hotelCart: CartItem[];
  /** User the locally cached cart belongs to. */
  ownerId: string | null;
  /** True while a local change has not yet been written to cart_items. */
  pendingSync: boolean;
  /** This visit's cart has been reconciled with the server (cart/checkout wait for it). */
  hydrated: boolean;
  addToCart: (p: {
    productId: string;
    vendorId?: string | null;
    cityId?: string | null;
    quantityDelta?: number;
    isHotel: boolean;
    variantId?: string | null;
  }) => AddToCartResult;
  forceClearHotelCartAndAdd: (item: CartItem) => void;
  updateQuantity: (productId: string, isHotel: boolean, newQty: number, variantId?: string | null) => void;
  /** Removes several lines in one change (e.g. all unavailable items). */
  removeItems: (isHotel: boolean, items: { product_id: string; variant_id?: string | null }[]) => void;
  clearCart: (isHotel: boolean) => void;
  clearAllCarts: () => void;
  clearLocal: () => void;
  syncFromBackend: () => Promise<void>;
  /** Loads the cart for a (newly) signed-in user, flushing unsynced local edits first. */
  hydrateForUser: (userId: string) => Promise<void>;
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
// Writes are chained so two syncs never interleave (delete + insert must stay atomic per write).
let writeChain: Promise<void> = Promise.resolve();

async function writeCartToBackend(userId: string, items: CartItem[]) {
  await supabase.from('cart_items').delete().eq('user_id', userId);
  if (items.length > 0) {
    const rows = items.map((i) => ({
      user_id: userId,
      product_id: i.product_id,
      variant_id: i.variant_id ?? null,
      vendor_id: i.vendor_id ?? null,
      city_id: i.city_id ?? null,
      quantity: i.quantity,
    }));
    await supabase.from('cart_items').insert(rows);
  }
}

/** Queues a write of the *current* cart snapshot for this user. */
function flushCart(userId: string): Promise<void> {
  writeChain = writeChain.then(async () => {
    const { groceryCart, hotelCart, ownerId } = useCart.getState();
    if (ownerId !== userId) return;
    try {
      await writeCartToBackend(userId, [...groceryCart, ...hotelCart]);
      if (!persistTimer) useCart.setState({ pendingSync: false });
    } catch (e) {
      console.warn('Failed to persist cart', e);
    }
  });
  return writeChain;
}

/** Debounced mirror of the cart to cart_items (coalesces rapid stepper taps). */
function persistCart() {
  const userId = useSession.getState().userId;
  if (!userId) return;
  useCart.setState({ ownerId: userId, pendingSync: true });
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void flushCart(userId);
  }, 300);
}

const same = (i: CartItem, productId: string, variantId?: string | null) =>
  i.product_id === productId && (i.variant_id ?? null) === (variantId ?? null);

function applyDelta(
  list: CartItem[],
  productId: string,
  variantId: string | null,
  delta: number,
  make: () => CartItem,
) {
  const existing = list.find((i) => same(i, productId, variantId));
  if (existing) {
    const q = existing.quantity + delta;
    return q <= 0
      ? list.filter((i) => !same(i, productId, variantId))
      : list.map((i) => (same(i, productId, variantId) ? { ...i, quantity: q } : i));
  }
  return delta > 0 ? [...list, make()] : list;
}

export const useCart = create<CartState>()(
  persist(
    (set, get) => ({
      groceryCart: [],
      hotelCart: [],
      ownerId: null,
      pendingSync: false,
      hydrated: false,

      addToCart: ({ productId, vendorId = null, cityId = null, quantityDelta = 1, isHotel, variantId = null }) => {
        const userId = useSession.getState().userId ?? 'guest';
        const make = (): CartItem => ({
          id: crypto.randomUUID?.() ?? String(Date.now()),
          user_id: userId,
          product_id: productId,
          variant_id: variantId,
          vendor_id: isHotel ? vendorId : null,
          city_id: cityId,
          quantity: quantityDelta,
        });
        if (isHotel) {
          const list = get().hotelCart;
          const existingVendor = list.find((i) => i.vendor_id)?.vendor_id;
          if (existingVendor && vendorId && existingVendor !== vendorId) {
            return {
              kind: 'hotelConflict',
              existingVendorId: existingVendor,
              newVendorId: vendorId,
              pendingItem: make(),
            };
          }
          set({ hotelCart: applyDelta(list, productId, variantId, quantityDelta, make) });
        } else {
          set({ groceryCart: applyDelta(get().groceryCart, productId, variantId, quantityDelta, make) });
        }
        persistCart();
        return { kind: 'success' };
      },

      forceClearHotelCartAndAdd: (item) => {
        set({ hotelCart: [item] });
        persistCart();
      },

      updateQuantity: (productId, isHotel, newQty, variantId = null) => {
        const key = isHotel ? 'hotelCart' : 'groceryCart';
        const list = get()[key];
        const next =
          newQty <= 0
            ? list.filter((i) => !same(i, productId, variantId))
            : list.map((i) => (same(i, productId, variantId) ? { ...i, quantity: newQty } : i));
        set({ [key]: next } as Pick<CartState, typeof key>);
        persistCart();
      },

      removeItems: (isHotel, items) => {
        if (!items.length) return;
        const key = isHotel ? 'hotelCart' : 'groceryCart';
        const next = get()[key].filter((i) => !items.some((r) => same(i, r.product_id, r.variant_id)));
        set({ [key]: next } as Pick<CartState, typeof key>);
        persistCart();
      },

      clearCart: (isHotel) => {
        set(isHotel ? { hotelCart: [] } : { groceryCart: [] });
        persistCart();
      },

      clearAllCarts: () => {
        set({ groceryCart: [], hotelCart: [] });
        persistCart();
      },

      clearLocal: () => {
        if (persistTimer) clearTimeout(persistTimer);
        persistTimer = null;
        set({ groceryCart: [], hotelCart: [], ownerId: null, pendingSync: false });
      },

      syncFromBackend: async () => {
        const userId = useSession.getState().userId;
        if (!userId) return;
        const { data, error } = await supabase
          .from('cart_items')
          .select('id,user_id,product_id,variant_id,vendor_id,city_id,quantity')
          .eq('user_id', userId);
        if (error || !data) return;
        const items = (data as CartItem[]).map((i) => ({ ...i, quantity: Number(i.quantity) }));
        set({
          groceryCart: items.filter((i) => !i.vendor_id),
          hotelCart: items.filter((i) => !!i.vendor_id),
          ownerId: userId,
          pendingSync: false,
        });
      },

      hydrateForUser: async (userId) => {
        const { ownerId, pendingSync } = get();
        if (ownerId !== userId) {
          get().clearLocal();
        } else if (pendingSync) {
          // Local edits never reached the server (e.g. page reloaded mid-debounce): push them.
          await flushCart(userId);
          set({ hydrated: true });
          return;
        }
        await get().syncFromBackend();
        set({ hydrated: true });
      },
    }),
    {
      name: 'sndmart-cart',
      partialize: (s) => ({
        groceryCart: s.groceryCart,
        hotelCart: s.hotelCart,
        ownerId: s.ownerId,
        pendingSync: s.pendingSync,
      }),
    },
  ),
);

/** Clears one checked-out cart locally and on the backend immediately (no debounce). */
export async function clearCartDirectly(isHotel: boolean) {
  useCart.setState(isHotel ? { hotelCart: [] } : { groceryCart: [] });
  const userId = useSession.getState().userId;
  if (!userId) return;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = null;
  useCart.setState({ ownerId: userId, pendingSync: true });
  await flushCart(userId);
}

export const cartCount = (items: CartItem[]) => items.reduce((s, i) => s + i.quantity, 0);
