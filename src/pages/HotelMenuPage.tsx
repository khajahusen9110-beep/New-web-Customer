import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { BadgeCheck, Clock, Flame, Info, RefreshCw, Search, Share2, ShoppingCart, Utensils, UtensilsCrossed } from 'lucide-react';
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
import { OfferBanner } from '../components/OfferBanner';
import { HotelItemCarousel } from './HomePage';
import {
  getFreeDeliveryThreshold,
  getHotelCategories,
  getHotelExtras,
  getVendorTopProducts,
  getHotelFeaturedItems,
  getHotelMenuAvailability,
  getHotelProducts,
  getVendor,
  getVendorOperatingSlots,
  HOTEL_MENU_PAGE,
  peekHotelExtras,
  peekHotelMenu,
  type TopItem,
} from '../lib/repository';
import type { Category, CartItem, OperatingSlot, ResolvedProduct, Vendor } from '../lib/types';
import { useFreshCart, useInfiniteSentinel } from '../lib/hooks';
import {
  cartTotal,
  defaultMenuTab,
  errorMessage,
  hotelClosedMessage,
  clockLabel,
  isHotelItemAvailable,
  isCityOpenNow,
  isVendorOpenNow,
  isWithinAnySlot,
  menuTabs,
  vendorHours,
  type MenuTab,
} from '../lib/utils';
import { useSession } from '../store/session';
import { cartCount, useCart } from '../store/cart';
import { trackEvent } from '../lib/analytics';

const PAGE = HOTEL_MENU_PAGE;
// Synthetic tab id: not a real category, shows this hotel's real top-selling items (by sales,
// not just featured/recent) instead of a server-paginated category fetch.
const RECOMMENDED_TAB_ID = '__recommended__';

function MenuItemCard({
  product,
  quantity,
  hotelOpen,
  slots,
  onIncrease,
  onDecrease,
  onView,
}: {
  product: ResolvedProduct;
  quantity: number;
  hotelOpen: boolean;
  slots: OperatingSlot[];
  onIncrease: () => void;
  onDecrease: () => void;
  onView: () => void;
}) {
  const available = hotelOpen && isHotelItemAvailable(product, slots);
  return (
    <div className={`card menu-item${available ? '' : ' dimmed'}`} onClick={onView}>
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
        <PriceDisplay price={product.effectivePrice} mrp={product.effectiveMrp} unit={product.unit} kind="food" />
      </div>
      {available ? (
        <div onClick={(e) => e.stopPropagation()}>
          <QuantityStepper quantity={quantity} onIncrease={onIncrease} onDecrease={onDecrease} />
        </div>
      ) : (
        <span className="oos-pill small">{hotelOpen ? 'Unavailable' : 'Closed'}</span>
      )}
    </div>
  );
}

// Dish grid card for the main menu list — same visual shape as the grocery product grid
// (.product-card/.product-img), so dishes below the category tabs show as a 2-column grid
// (photo, name, price, Add) instead of the horizontal list row MenuItemCard renders.
function MenuGridCard({
  product,
  quantity,
  hotelOpen,
  slots,
  onIncrease,
  onDecrease,
  onView,
}: {
  product: ResolvedProduct;
  quantity: number;
  hotelOpen: boolean;
  slots: OperatingSlot[];
  onIncrease: () => void;
  onDecrease: () => void;
  onView: () => void;
}) {
  const available = hotelOpen && isHotelItemAvailable(product, slots);
  return (
    <div className={`card product-card${available ? '' : ' dimmed'}`} onClick={onView}>
      <div className="product-img">
        <ProductImage url={product.imageUrl} alt={product.name} width={200} />
        {available && product.isFeatured && <span className="tag tag-blue">FEATURED</span>}
        {!available && (
          <div className="img-overlay">
            <span className="tag tag-red">{hotelOpen ? 'UNAVAILABLE' : 'CLOSED'}</span>
          </div>
        )}
      </div>
      <div className={`product-name ellipsis${available ? '' : ' muted'}`} title={product.name}>
        {product.name}
      </div>
      <PriceDisplay price={product.effectivePrice} mrp={product.effectiveMrp} unit={product.unit} kind="food" />
      <div className="product-action" onClick={(e) => e.stopPropagation()}>
        {available ? (
          <QuantityStepper quantity={quantity} onIncrease={onIncrease} onDecrease={onDecrease} full />
        ) : (
          <div className="oos-pill">{hotelOpen ? 'Unavailable' : 'Closed'}</div>
        )}
      </div>
    </div>
  );
}

export default function HotelMenuPage() {
  const { vendorId = '' } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const cityId = useSession((s) => s.selectedCity?.id ?? '');
  const city = useSession((s) => s.selectedCity);
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
  const [dishQuery, setDishQuery] = useState('');
  const [vendorTopProducts, setVendorTopProducts] = useState<ResolvedProduct[]>([]);
  const reqId = useRef(0);

  const [freeDeliveryAt, setFreeDeliveryAt] = useState<number | null>(null);
  useEffect(() => {
    if (!cityId) return;
    let cancelled = false;
    getFreeDeliveryThreshold(cityId)
      .then((v) => !cancelled && setFreeDeliveryAt(v))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [cityId]);

  // This hotel's real top-selling items (by sales), for the "Recommended" tab.
  useEffect(() => {
    if (!vendorId || !cityId) return;
    let cancelled = false;
    getVendorTopProducts(vendorId, cityId)
      .then((list) => !cancelled && setVendorTopProducts(list))
      .catch(() => !cancelled && setVendorTopProducts([]));
    return () => {
      cancelled = true;
    };
  }, [vendorId, cityId]);

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
      if (v.status === 'fulfilled') {
        setVendor(v.value);
        // "This hotel's menu was opened" — distinct from a per-dish `product_view` (fired on
        // tapping an individual item below), kept under its own name so neither signal is lost.
        trackEvent('vendor_menu_opened', { vendor_id: vendorId, vendor_name: v.value?.name, category: 'hotel' });
      }
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
      if (categoryId === RECOMMENDED_TAB_ID) {
        setProducts(vendorTopProducts);
        setHasMore(false);
        setLoadingProducts(false);
        setLoadingMore(false);
        return;
      }
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
    [vendorId, cityId, categoryId, products.length, vendorTopProducts],
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
  const hotelOpen = vendor ? isVendorOpenNow(vendor, slots, city) : withinHours && isCityOpenNow(city);

  // Top dish photos for the hero carousel (Swiggy-style), in place of the plain static banner
  // once at least 1 real item photo is known for this hotel.
  const [heroTopItems, setHeroTopItems] = useState<TopItem[]>(() => peekHotelExtras([vendorId]).topItems[vendorId] ?? []);
  useEffect(() => {
    setHeroTopItems(peekHotelExtras([vendorId]).topItems[vendorId] ?? []);
    let cancelled = false;
    getHotelExtras([vendorId])
      .then((extras) => !cancelled && setHeroTopItems(extras.topItems[vendorId] ?? []))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [vendorId]);

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

  const realTabs: MenuTab[] = useMemo(
    () =>
      availItems
        ? menuTabs(categories, availItems, hotelOpen, effectiveSlots)
        : menuTabs(categories, [], false, effectiveSlots).map((t) => ({ ...t, availableNow: hotelOpen, fromLabel: null })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [categories, availItems, hotelOpen, effectiveSlots, minute],
  );
  // "Recommended" sits first, ahead of the hotel's real categories, and only appears once this
  // hotel actually has real sales to show (never an empty/fabricated tab).
  const tabs: MenuTab[] = useMemo(() => {
    if (!vendorTopProducts.length) return realTabs;
    const recommendedTab: MenuTab = {
      category: { id: RECOMMENDED_TAB_ID, name: 'Recommended', image_url: null, sort_order: -1 },
      availableNow: hotelOpen,
      fromLabel: null,
    };
    return [recommendedTab, ...realTabs];
  }, [realTabs, vendorTopProducts.length, hotelOpen]);

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

  const sorted = useMemo(() => {
    const tier = (p: ResolvedProduct) => {
      const a = hotelOpen && isHotelItemAvailable(p, effectiveSlots);
      return a && p.isFeatured ? 0 : a ? 1 : 2;
    };
    // Recommended's whole point is sales ranking — keep products in that (stable-sort) order
    // instead of re-sorting it by price/name; only the availability tier still takes priority.
    const isRecommended = categoryId === RECOMMENDED_TAB_ID;
    return [...products].sort(
      (a, b) =>
        tier(a) - tier(b) ||
        (isRecommended
          ? 0
          : Number(b.isFeatured) - Number(a.isFeatured) ||
            a.effectivePrice - b.effectivePrice ||
            a.name.toLowerCase().localeCompare(b.name.toLowerCase())),
    );
  }, [products, hotelOpen, effectiveSlots, categoryId]);

  // Filters the already-loaded menu for this hotel only — no server round trip, the whole
  // category's items are small enough to filter client-side as the customer types.
  const trimmedQuery = dishQuery.trim().toLowerCase();
  const displayed = useMemo(
    () => (trimmedQuery ? sorted.filter((p) => p.name.toLowerCase().includes(trimmedQuery)) : sorted),
    [sorted, trimmedQuery],
  );

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

  const closedMessage = hotelClosedMessage(vendor, slots, city);

  const refresh = () => {
    void loadInitial(true);
    void loadProducts(true, true);
    loadAvailability(true);
    getHotelFeaturedItems(vendorId, cityId, true).then(setFeaturedItems).catch(() => undefined);
  };

  const timingText =
    vendor?.opening_time && vendor?.closing_time ? `${clockLabel(vendor.opening_time)} - ${clockLabel(vendor.closing_time)}` : null;

  const shareHotel = async () => {
    const url = `${window.location.origin}/hotel/${vendorId}?name=${encodeURIComponent(vendorName)}`;
    if (navigator.share) {
      try {
        await navigator.share({ title: vendorName, text: `Order from ${vendorName} on Sndmart!`, url });
      } catch {
        // Share sheet dismissed — not an error.
      }
    } else {
      await navigator.clipboard.writeText(url).catch(() => undefined);
      toast('Link copied!');
    }
  };

  return (
    <div className="page">
      <PageHeader
        title={
          <span className="hotel-title-row">
            {vendorName}
            <BadgeCheck size={16} className="hotel-verified-badge" aria-label="Verified" />
          </span>
        }
        subtitle={
          <span className={`hotel-open-badge ${hotelOpen ? 'is-open' : 'is-closed'}`}>
            {hotelOpen ? 'Open Now' : 'Closed'}
            {timingText && <span className="muted"> · {timingText}</span>}
          </span>
        }
        actions={
          <>
            <button className="icon-btn" aria-label="Share hotel" onClick={shareHotel}>
              <Share2 size={20} />
            </button>
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

      {vendor?.banner_url && (
        <div className="content-pad hotel-block">
          <div className="hotel-hero">
            {heroTopItems.length >= 1 ? (
              <HotelItemCarousel items={heroTopItems} name={vendorName} isOpen={hotelOpen} intervalMs={3200} imageWidth={800} />
            ) : (
              <ProductImage url={vendor.banner_url} alt={vendorName} width={800} priority />
            )}
          </div>
        </div>
      )}

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
          <div className="content-pad hotel-block"><OfferBanner kind="food" /></div>
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
                      onView={() => trackEvent('product_view', { product_id: p.id, product_name: p.name, category: 'hotel' })}
                    />
                  </div>
                ))}
              </div>
            </section>
          )}
          {menuShown && (products.length > 0 || trimmedQuery) && (
            <div className="content-pad hotel-block">
              <div className="search-bar">
                <Search size={18} className="muted" />
                <input
                  type="search"
                  placeholder="Search for dishes"
                  value={dishQuery}
                  onChange={(e) => setDishQuery(e.target.value)}
                  aria-label="Search for dishes in this hotel"
                />
              </div>
            </div>
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
                    <span className={`hotel-cat-img${c.id === RECOMMENDED_TAB_ID ? ' hotel-cat-recommended' : ''}`}>
                      {c.id === RECOMMENDED_TAB_ID ? (
                        <Flame size={24} />
                      ) : c.image_url ? (
                        <ResizedImg url={c.image_url} width={64} />
                      ) : (
                        <Utensils size={24} />
                      )}
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
                  {trimmedQuery
                    ? `No dishes match "${dishQuery.trim()}".`
                    : categories.length === 0
                      ? 'No menu items currently listed for this hotel.'
                      : 'No items found in this category.'}
                </p>
              </div>
            ) : (
              <div className="stack">
                <div className="product-grid">
                  {displayed.map((p) => (
                    <MenuGridCard
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
                      onView={() => trackEvent('product_view', { product_id: p.id, product_name: p.name, category: 'hotel' })}
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
          freeDeliveryAt={freeDeliveryAt}
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
