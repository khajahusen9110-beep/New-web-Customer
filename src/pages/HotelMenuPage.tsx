import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Info, RefreshCw, ShoppingCart, Utensils, UtensilsCrossed } from 'lucide-react';
import {
  ConfirmDialog,
  ErrorCard,
  FloatingCartButton,
  ListSkeleton,
  PageHeader,
  PriceDisplay,
  ProductImage,
  QuantityStepper,
  Spinner,
  toast,
} from '../components/ui';
import { getHotelCategories, getHotelFeaturedItems, getHotelProducts, getVendor, getVendorOperatingSlots } from '../lib/repository';
import type { Category, CartItem, OperatingSlot, ResolvedProduct, Vendor } from '../lib/types';
import { useFreshCart, useInfiniteSentinel } from '../lib/hooks';
import { cartTotal, errorMessage, isHotelItemAvailable, isVendorOpenNow, isWithinAnySlot, vendorHours } from '../lib/utils';
import { useSession } from '../store/session';
import { cartCount, useCart } from '../store/cart';

const PAGE = 25;

function MenuItemCard({
  product,
  quantity,
  hotelOpen,
  slots,
  onIncrease,
  onDecrease,
}: {
  product: ResolvedProduct;
  quantity: number;
  hotelOpen: boolean;
  slots: OperatingSlot[];
  onIncrease: () => void;
  onDecrease: () => void;
}) {
  const available = hotelOpen && isHotelItemAvailable(product, slots);
  return (
    <div className={`card menu-item${available ? '' : ' dimmed'}`}>
      <div className="menu-img">
        <ProductImage url={product.imageUrl} alt={product.name} />
        {available && product.isFeatured && <span className="tag tag-blue">FEATURED</span>}
        {!available && (
          <div className="img-overlay">
            <span className="tag tag-red">{hotelOpen ? 'UNAVAILABLE' : 'CLOSED'}</span>
          </div>
        )}
      </div>
      <div className="grow min-w-0">
        <strong className={`ellipsis block${available ? '' : ' muted'}`}>{product.name}</strong>
        {product.description && <p className="muted small clamp-2">{product.description}</p>}
        {product.base.available_from && product.base.available_until && (
          <div className={`small ${available ? 'text-primary' : 'text-danger'}`}>
            Available {product.base.available_from} - {product.base.available_until}
          </div>
        )}
        <PriceDisplay price={product.effectivePrice} mrp={product.effectiveMrp} unit={product.unit} />
      </div>
      {available ? (
        <QuantityStepper quantity={quantity} onIncrease={onIncrease} onDecrease={onDecrease} />
      ) : (
        <span className="oos-pill small">{hotelOpen ? 'Unavailable' : 'Closed'}</span>
      )}
    </div>
  );
}

export default function HotelMenuPage() {
  const { vendorId = '' } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const cityId = useSession((s) => s.selectedCity?.id ?? '');
  const hotelCart = useCart((s) => s.hotelCart);
  const addToCart = useCart((s) => s.addToCart);
  const forceClearHotelCartAndAdd = useCart((s) => s.forceClearHotelCartAndAdd);

  const [vendor, setVendor] = useState<Vendor | null>(null);
  const [slots, setSlots] = useState<OperatingSlot[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [products, setProducts] = useState<ResolvedProduct[]>([]);
  const [loadingInitial, setLoadingInitial] = useState(true);
  const [loadingProducts, setLoadingProducts] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<CartItem | null>(null);
  const reqId = useRef(0);

  const vendorName = vendor?.name ?? params.get('name') ?? 'Hotel';

  const loadInitial = useCallback(
    async (force = false) => {
      setError(null);
      setLoadingInitial(true);
      const [v, s, c] = await Promise.allSettled([
        getVendor(vendorId),
        getVendorOperatingSlots(vendorId),
        getHotelCategories(vendorId, force),
      ]);
      if (v.status === 'fulfilled') setVendor(v.value);
      if (s.status === 'fulfilled') setSlots(s.value);
      if (c.status === 'fulfilled') {
        setCategories(c.value);
        setCategoryId((cur) => (cur && c.value.some((x) => x.id === cur) ? cur : c.value[0]?.id ?? null));
      } else setError(errorMessage(c.reason));
      setLoadingInitial(false);
    },
    [vendorId],
  );

  const loadProducts = useCallback(
    async (reset: boolean, force = false) => {
      if (!categoryId) return;
      const id = ++reqId.current;
      if (reset) {
        setLoadingProducts(true);
        setError(null);
      } else setLoadingMore(true);
      try {
        const list = await getHotelProducts({
          vendorId,
          cityId,
          categoryId,
          limit: PAGE,
          offset: reset ? 0 : products.length,
          forceRefresh: force,
        });
        if (id !== reqId.current) return;
        setProducts((cur) => {
          if (reset) return list;
          const seen = new Set(cur.map((p) => p.id));
          return [...cur, ...list.filter((p) => !seen.has(p.id))];
        });
        setHasMore(list.length >= PAGE);
      } catch (e) {
        if (id === reqId.current && reset) setError(errorMessage(e));
      } finally {
        if (id === reqId.current) {
          setLoadingProducts(false);
          setLoadingMore(false);
        }
      }
    },
    [vendorId, cityId, categoryId, products.length],
  );

  useEffect(() => {
    void loadInitial();
  }, [loadInitial]);

  useEffect(() => {
    if (categoryId) void loadProducts(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categoryId]);

  const effectiveSlots: OperatingSlot[] = useMemo(() => (vendor ? vendorHours(vendor, slots) : slots), [slots, vendor]);

  const withinHours = isWithinAnySlot(effectiveSlots);
  // Same check as the OPEN NOW badge on Home (active, not switched off, inside hours).
  const hotelOpen = vendor ? isVendorOpenNow(vendor, slots) : withinHours;

  // "Featured" row: this hotel's featured items that can be ordered right now (max 10).
  const [featuredItems, setFeaturedItems] = useState<ResolvedProduct[]>([]);
  useEffect(() => {
    let cancelled = false;
    getHotelFeaturedItems(vendorId, cityId)
      .then((list) => !cancelled && setFeaturedItems(list))
      .catch(() => !cancelled && setFeaturedItems([]));
    return () => {
      cancelled = true;
    };
  }, [vendorId, cityId]);
  const featuredNow = useMemo(
    () => (hotelOpen ? featuredItems.filter((p) => isHotelItemAvailable(p, effectiveSlots)).slice(0, 10) : []),
    [featuredItems, hotelOpen, effectiveSlots],
  );

  const displayed = useMemo(() => {
    const tier = (p: ResolvedProduct) => {
      const a = hotelOpen && isHotelItemAvailable(p, effectiveSlots);
      return a && p.isFeatured ? 0 : a ? 1 : 2;
    };
    return [...products].sort(
      (a, b) =>
        tier(a) - tier(b) ||
        Number(b.isFeatured) - Number(a.isFeatured) ||
        a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
    );
  }, [products, hotelOpen, effectiveSlots]);

  const thisHotelItems = useMemo(
    () => hotelCart.filter((i) => i.vendor_id === vendorId || !i.vendor_id),
    [hotelCart, vendorId],
  );
  const fresh = useFreshCart(hotelCart, cityId);
  const thisTotal = useMemo(() => {
    const f = fresh.fresh.filter((i) => i.cartItem.vendor_id === vendorId || !i.cartItem.vendor_id);
    if (f.length) return cartTotal(f);
    return thisHotelItems.reduce(
      (s, i) => s + (products.find((p) => p.id === i.product_id)?.effectivePrice ?? 0) * i.quantity,
      0,
    );
  }, [fresh.fresh, thisHotelItems, products, vendorId]);

  const sentinel = useInfiniteSentinel(
    () => hasMore && !loadingMore && !loadingProducts && void loadProducts(false),
    hasMore && products.length > 0,
  );

  const closedMessage = !withinHours
    ? slots.length
      ? `This hotel is currently closed outside operating hours (${slots.map((s) => `${s.start_time}-${s.end_time}`).join(', ')}). Ordering is unavailable.`
      : vendor?.opening_time
        ? `This hotel is currently closed. Opens at ${vendor.opening_time}.`
        : 'This hotel is currently closed outside operating hours. Ordering is unavailable.'
    : 'This restaurant is currently closed. You can browse the menu, but ordering is unavailable.';

  const refresh = () => {
    void loadInitial(true);
    void loadProducts(true, true);
    getHotelFeaturedItems(vendorId, cityId, true).then(setFeaturedItems).catch(() => undefined);
  };

  return (
    <div className="page">
      <PageHeader
        title={vendorName}
        subtitle="Hotel Menu"
        actions={
          <>
            <button className="icon-btn" aria-label="Refresh menu" onClick={refresh}>
              <RefreshCw size={20} />
            </button>
            <button className="icon-btn with-badge" aria-label="View cart" onClick={() => navigate('/cart')}>
              <ShoppingCart size={20} />
              {cartCount(hotelCart) > 0 && <span className="badge">{cartCount(hotelCart)}</span>}
            </button>
          </>
        }
      />

      {(loadingInitial || loadingProducts) && products.length === 0 ? (
        <div className="content-pad">
          <ListSkeleton count={5} />
        </div>
      ) : error && products.length === 0 ? (
        <div className="content-pad">
          <ErrorCard message={error} onRetry={refresh} />
        </div>
      ) : (
        <>
          {!hotelOpen && (
            <div className="content-pad">
              <div className="alert alert-danger">
                <Info size={18} /> {closedMessage}
              </div>
            </div>
          )}
          {featuredNow.length > 0 && (
            <section className="content-pad featured-section">
              <h3 className="section-title">Featured</h3>
              <div className="featured-row">
                {featuredNow.map((p) => (
                  <div key={p.id} className="featured-item featured-menu-item">
                    <MenuItemCard
                      product={p}
                      quantity={hotelCart.find((i) => i.product_id === p.id)?.quantity ?? 0}
                      hotelOpen={hotelOpen}
                      slots={effectiveSlots}
                      onIncrease={() => {
                        const r = addToCart({ productId: p.id, vendorId, cityId, quantityDelta: 1, isHotel: true });
                        if (r.kind === 'hotelConflict') setConflict(r.pendingItem);
                      }}
                      onDecrease={() => addToCart({ productId: p.id, vendorId, cityId, quantityDelta: -1, isHotel: true })}
                    />
                  </div>
                ))}
              </div>
            </section>
          )}
          {categories.length > 0 && (
            <div className="hotel-cats">
              {categories.map((c) => (
                <button
                  key={c.id}
                  className={`hotel-cat${categoryId === c.id ? ' selected' : ''}`}
                  onClick={() => setCategoryId(c.id)}
                >
                  <span className="hotel-cat-img">
                    {c.image_url ? <img src={c.image_url} alt="" loading="lazy" /> : <Utensils size={24} />}
                  </span>
                  <span className="hotel-cat-name">{c.name}</span>
                </button>
              ))}
            </div>
          )}
          <div className="content-pad">
            {displayed.length === 0 ? (
              <div className="empty-state">
                <UtensilsCrossed size={48} className="muted" />
                <p className="muted">
                  {categories.length === 0 ? 'No menu items currently listed for this hotel.' : 'No items found in this category.'}
                </p>
              </div>
            ) : (
              <div className="stack">
                {vendor?.banner_url && (
                  <div className="hotel-hero">
                    <ProductImage url={vendor.banner_url} alt={vendorName} />
                  </div>
                )}
                <div className="menu-grid">
                  {displayed.map((p) => (
                    <MenuItemCard
                      key={p.id}
                      product={p}
                      quantity={hotelCart.find((i) => i.product_id === p.id)?.quantity ?? 0}
                      hotelOpen={hotelOpen}
                      slots={effectiveSlots}
                      onIncrease={() => {
                        const r = addToCart({ productId: p.id, vendorId, cityId, quantityDelta: 1, isHotel: true });
                        if (r.kind === 'hotelConflict') setConflict(r.pendingItem);
                      }}
                      onDecrease={() => addToCart({ productId: p.id, vendorId, cityId, quantityDelta: -1, isHotel: true })}
                    />
                  ))}
                </div>
                {hasMore && (
                  <div ref={sentinel} className="center-pad">
                    {loadingMore ? (
                      <Spinner />
                    ) : (
                      <button className="btn btn-outline" onClick={() => void loadProducts(false)}>
                        Load more items
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </>
      )}

      <div className="floating-cart-wrap">
        <FloatingCartButton
          itemCount={cartCount(thisHotelItems)}
          total={thisTotal}
          onClick={() => navigate('/checkout/hotel')}
        />
      </div>

      <ConfirmDialog
        open={!!conflict}
        title="Replace Hotel Cart Items?"
        text={`Your cart already contains items from another hotel. Clear existing items and add from ${vendorName}?`}
        confirmLabel="Clear & Add"
        onCancel={() => setConflict(null)}
        onConfirm={() => {
          forceClearHotelCartAndAdd(conflict!);
          setConflict(null);
          toast('Cart cleared and item added');
        }}
      />
    </div>
  );
}
