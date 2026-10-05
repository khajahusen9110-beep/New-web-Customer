import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Clock, Info, RefreshCw, ShoppingCart, Utensils, UtensilsCrossed } from 'lucide-react';
import {
  ConfirmDialog,
  ErrorCard,
  FloatingCartButton,
  ListSkeleton,
  PageHeader,
  PriceDisplay,
  ProductImage,
  ResizedImg,
  QuantityStepper,
  Spinner,
  toast,
} from '../components/ui';
import {
  getHotelCategories,
  getHotelFeaturedItems,
  getHotelMenuAvailability,
  getHotelProducts,
  getVendor,
  getVendorOperatingSlots,
  HOTEL_MENU_PAGE,
  peekHotelMenu,
} from '../lib/repository';
import type { Category, CartItem, OperatingSlot, ResolvedProduct, Vendor } from '../lib/types';
import { useFreshCart, useInfiniteSentinel } from '../lib/hooks';
import {
  cartTotal,
  defaultMenuTab,
  errorMessage,
  hotelClosedMessage,
  isHotelItemAvailable,
  isVendorOpenNow,
  isWithinAnySlot,
  menuTabs,
  vendorHours,
  type MenuTab,
} from '../lib/utils';
import { useSession } from '../store/session';
import { cartCount, useCart } from '../store/cart';

const PAGE = HOTEL_MENU_PAGE;

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
        <ProductImage url={product.imageUrl} alt={product.name} width={96} />
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

  // Last-seen menu (this visit's prefetch or an earlier visit) shows at once; fresh data follows.
  const [seen] = useState(() => peekHotelMenu(vendorId, cityId, null, PAGE));
  const [vendor, setVendor] = useState<Vendor | null>(seen.vendor);
  const [slots, setSlots] = useState<OperatingSlot[]>(seen.slots ?? []);
  const [categories, setCategories] = useState<Category[]>(seen.categories ?? []);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [products, setProducts] = useState<ResolvedProduct[]>([]);
  const [loadingInitial, setLoadingInitial] = useState(!seen.categories);
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
      if (force || !categories.length) setLoadingInitial(true);
      const [v, s, c] = await Promise.allSettled([
        getVendor(vendorId, force),
        getVendorOperatingSlots(vendorId, force),
        getHotelCategories(vendorId, force),
      ]);
      if (v.status === 'fulfilled') setVendor(v.value);
      if (s.status === 'fulfilled') setSlots(s.value);
      // The selected tab is chosen once the tab order is known (see below).
      if (c.status === 'fulfilled') setCategories(c.value);
      else setError(errorMessage(c.reason));
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
        const cachedPage = force ? null : peekHotelMenu(vendorId, cityId, categoryId, PAGE).products;
        if (cachedPage) setProducts(cachedPage);
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

  // Which categories have something orderable right now (one light request for the whole menu).
  // null = not loaded or failed; then the tabs keep their normal order and nothing is greyed.
  const [availItems, setAvailItems] = useState<ResolvedProduct[] | null>(seen.availability);
  const [availDone, setAvailDone] = useState(!!seen.availability);
  const loadAvailability = useCallback(
    (force = false) => {
      if (!cityId) return setAvailDone(true);
      getHotelMenuAvailability(vendorId, cityId, force)
        .then(setAvailItems)
        .catch(() => setAvailItems((cur) => cur))
        .finally(() => setAvailDone(true));
    },
    [vendorId, cityId],
  );
  useEffect(() => {
    loadAvailability();
  }, [loadAvailability]);

  // Re-check once a minute (item timings, hotel hours) and when the customer comes back to the tab.
  const [minute, setMinute] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      setMinute((m) => m + 1);
      loadAvailability(); // served from the 5-minute cache in between
    }, 60_000);
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      setMinute((m) => m + 1);
      loadAvailability(true);
      Promise.all([getVendor(vendorId, true), getVendorOperatingSlots(vendorId, true)])
        .then(([v, sl]) => {
          if (v) setVendor(v);
          setSlots(sl);
        })
        .catch(() => undefined);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [loadAvailability, vendorId]);

  const tabs: MenuTab[] = useMemo(
    () =>
      availItems
        ? menuTabs(categories, availItems, hotelOpen, effectiveSlots)
        : menuTabs(categories, [], false, effectiveSlots).map((t) => ({ ...t, availableNow: hotelOpen, fromLabel: null })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [categories, availItems, hotelOpen, effectiveSlots, minute],
  );

  // Default tab until the customer taps one; their choice is kept while the menu is open.
  const userPicked = useRef(false);
  const tabsReady = !loadingInitial && availDone;
  useEffect(() => {
    if (!tabsReady || !tabs.length) return;
    const stillThere = categoryId && tabs.some((t) => t.category.id === categoryId);
    if (userPicked.current && stillThere) return;
    const next = defaultMenuTab(tabs, vendor?.default_category_id);
    if (next !== categoryId) setCategoryId(next);
  }, [tabsReady, tabs, vendor?.default_category_id, categoryId]);

  const showSkeleton = (loadingInitial || loadingProducts || (!tabsReady && !error)) && products.length === 0;
  // The tab row is mounted only once the menu shows (not during the first skeleton).
  const menuShown = !showSkeleton && !(error && products.length === 0);

  // Keep the selected tab fully visible in the side-scrolling row.
  const tabRow = useRef<HTMLDivElement | null>(null);
  const tabOrder = tabs.map((t) => t.category.id).join(',');
  useEffect(() => {
    const row = tabRow.current;
    const el = row?.querySelector<HTMLElement>('.hotel-cat.selected');
    if (!row || !el) return;
    const left = el.getBoundingClientRect().left - row.getBoundingClientRect().left + row.scrollLeft;
    if (left < row.scrollLeft || left + el.offsetWidth > row.scrollLeft + row.clientWidth) {
      row.scrollTo({ left: Math.max(left - (row.clientWidth - el.offsetWidth) / 2, 0), behavior: 'smooth' });
    }
  }, [categoryId, tabOrder, menuShown]);

  // After a tap, show the start of that category's items (just below the sticky tabs).
  const itemsTop = useRef<HTMLDivElement | null>(null);
  const pickTab = (id: string) => {
    userPicked.current = true;
    setCategoryId(id);
    const row = tabRow.current;
    const top = itemsTop.current;
    if (!row || !top) return;
    const gap = top.getBoundingClientRect().top - row.getBoundingClientRect().bottom;
    if (gap < 0) window.scrollBy({ top: gap - 4 });
  };

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

  const closedMessage = hotelClosedMessage(vendor, slots);

  const refresh = () => {
    void loadInitial(true);
    void loadProducts(true, true);
    loadAvailability(true);
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

      {showSkeleton ? (
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
          {tabs.length > 0 && (
            <div className="hotel-cats" ref={tabRow} role="tablist">
              {tabs.map(({ category: c, availableNow, fromLabel }) => {
                // Greyed only while the hotel is open (a closed hotel keeps its normal tabs + banner).
                const later = hotelOpen && !availableNow;
                return (
                  <button
                    key={c.id}
                    role="tab"
                    aria-selected={categoryId === c.id}
                    className={`hotel-cat${categoryId === c.id ? ' selected' : ''}${later ? ' later' : ''}`}
                    onClick={() => pickTab(c.id)}
                  >
                    <span className="hotel-cat-img">
                      {c.image_url ? <ResizedImg url={c.image_url} width={64} /> : <Utensils size={24} />}
                    </span>
                    <span className="hotel-cat-name">{c.name}</span>
                    {later && fromLabel && (
                      <span className="hotel-cat-from">
                        <Clock size={10} /> {fromLabel}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
          <div className="content-pad hotel-items" ref={itemsTop}>
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
                    <ProductImage url={vendor.banner_url} alt={vendorName} width={800} priority />
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
