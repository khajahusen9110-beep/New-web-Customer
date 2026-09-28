import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  Bell,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  MapPin,
  RefreshCw,
  Search,
  ShoppingCart,
  Star,
  Store,
  Tag,
  Truck,
  X,
} from 'lucide-react';
import {
  EmptyState,
  ErrorCard,
  FloatingCartButton,
  GridSkeleton,
  ListSkeleton,
  Modal,
  PriceDisplay,
  ProductImage,
  QuantityStepper,
  Spinner,
  toast,
} from '../components/ui';
import { openCityPicker } from '../components/CityPicker';
import {
  getCompletedOrderCount,
  getPromoCoupon,
  getFreeDeliveryThreshold,
  getGroceryCategories,
  getHotelDishCategories,
  getHotels,
  getHotelsServingDish,
  type DishCategory,
  type DishMatch,
  getResolvedGroceryProducts,
  getVendorAverageRating,
  getVendorOperatingSlots,
  peekVendorExtras,
} from '../lib/repository';
import type { CartItem, Category, Coupon, OperatingSlot, ResolvedProduct, Vendor } from '../lib/types';
import { useDebounced, useFreshCart, useInfiniteSentinel } from '../lib/hooks';
import {
  cartTotal,
  errorMessage,
  isInStockAndActive,
  isWithinAnySlot,
  isWithinOperatingHours,
  rupees,
  startingPrice,
} from '../lib/utils';
import { shouldShowRatingPopup, useSession } from '../store/session';
import { cartCount, useCart } from '../store/cart';

const GROCERY_PAGE = 30;
const HOTEL_PAGE = 20;
let couponShownThisSession = false;

const sortGrocery = (list: ResolvedProduct[]) =>
  [...list].sort(
    (a, b) =>
      Number(isInStockAndActive(b)) - Number(isInStockAndActive(a)) ||
      a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
  );

function discountSummary(c: Coupon) {
  const part = c.discount_type === 'flat' ? `Flat Rs ${Math.trunc(c.discount_value)} OFF` : `${Math.trunc(c.discount_value)}% OFF`;
  const min = c.min_order_amount && c.min_order_amount > 0 ? ` on orders above Rs ${Math.trunc(c.min_order_amount)}` : '';
  return part + min;
}

function HomeTopBar({ onRefresh, showBack, onBack }: { onRefresh: () => void; showBack: boolean; onBack: () => void }) {
  const navigate = useNavigate();
  const city = useSession((s) => s.selectedCity);
  const label = useSession((s) => s.defaultAddressLabel);
  const unread = useSession((s) => s.unreadNotificationCount);
  const count = useCart((s) => cartCount(s.groceryCart) + cartCount(s.hotelCart));
  return (
    <header className="home-top">
      {showBack && (
        <button className="icon-btn" aria-label="Back to groceries" onClick={onBack}>
          <ArrowLeft size={22} />
        </button>
      )}
      <button className="deliver-to" onClick={openCityPicker}>
        <span className="icon-circle">
          <MapPin size={20} />
        </span>
        <span className="deliver-text">
          <span className="label-caps">Deliver to</span>
          <span className="deliver-city">
            {label ? `${label} • ` : ''}
            {city?.name ?? 'Select City'} <ChevronDown size={16} className="text-primary" />
          </span>
        </span>
      </button>
      <div className="row gap-6">
        <button className="icon-circle-btn" aria-label="Refresh" onClick={onRefresh}>
          <RefreshCw size={19} />
        </button>
        <button className="icon-circle-btn" aria-label="Notifications" onClick={() => navigate('/notifications')}>
          <Bell size={19} />
          {unread > 0 && <span className="badge">{unread > 99 ? '99+' : unread}</span>}
        </button>
        <button className="icon-circle-btn" aria-label="Cart" onClick={() => navigate('/cart')}>
          <ShoppingCart size={19} />
          {count > 0 && <span className="badge">{count}</span>}
        </button>
      </div>
    </header>
  );
}

function FreeDeliveryBanner({ threshold }: { threshold: number }) {
  return (
    <div className="free-banner">
      <Truck size={20} /> FREE Delivery on orders above Rs {Math.trunc(threshold)}!
    </div>
  );
}

function DealsBanner() {
  return (
    <div className="deals-banner">
      <span className="deco deco-1">🥬</span>
      <span className="deco deco-2">🍅</span>
      <div>
        <div className="deals-kicker">UP TO 40% OFF</div>
        <div className="deals-title">
          Organic Farm
          <br />
          Fresh Picks
        </div>
      </div>
      <span className="deals-cta">SHOP NOW</span>
    </div>
  );
}

/** Swiggy-style "What's on your mind?" row: dishes served by this city's hotels, with images. */
// A different starting dish on every visit, so other hotels' dishes come first too.
const DISH_ROTATION_SEED = Math.random();
const DISH_AUTO_SCROLL_MS = 2500;
const DISH_RESUME_AFTER_MS = 4000;

/**
 * Swiggy-style "What's on your mind?" row: dishes served by this city's hotels, in round images.
 * When the dishes do not fit on screen the row moves one dish every few seconds and wraps around
 * endlessly (a circle); touching, scrolling or hovering pauses it, and it stays still while a dish
 * is selected or when the device asks for reduced motion.
 */
function DishRow({
  dishes,
  selectedKey,
  onSelect,
}: {
  dishes: DishCategory[];
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
}) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const pausedUntil = useRef(0);
  const hovering = useRef(false);
  const [looping, setLooping] = useState(true);

  const ordered = useMemo(() => {
    if (dishes.length < 2) return dishes;
    const start = Math.floor(DISH_ROTATION_SEED * dishes.length);
    return [...dishes.slice(start), ...dishes.slice(0, start)];
  }, [dishes]);

  // Loop only when one copy of the dishes is wider than the screen.
  useEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    const check = () => {
      const oneCopy = looping ? el.scrollWidth / 2 : el.scrollWidth;
      setLooping(oneCopy > el.clientWidth + 4);
    };
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, [ordered, looping]);

  useEffect(() => {
    const el = rowRef.current;
    if (!el || !looping || selectedKey) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const t = window.setInterval(() => {
      if (hovering.current || Date.now() < pausedUntil.current || document.hidden) return;
      const card = el.querySelector<HTMLElement>('.dish-card');
      if (!card) return;
      const step = card.offsetWidth + 12;
      const half = el.scrollWidth / 2;
      // The second copy is identical, so jumping back by one copy is invisible.
      if (el.scrollLeft + step >= half) el.scrollLeft -= half;
      el.scrollBy({ left: step, behavior: 'smooth' });
    }, DISH_AUTO_SCROLL_MS);
    return () => window.clearInterval(t);
  }, [looping, selectedKey, ordered]);

  const pause = () => {
    pausedUntil.current = Date.now() + DISH_RESUME_AFTER_MS;
  };
  // Keep the manual scroll position inside the first copy so the loop never runs out.
  const onScroll = () => {
    const el = rowRef.current;
    if (!el || !looping) return;
    const half = el.scrollWidth / 2;
    if (el.scrollLeft >= half) el.scrollLeft -= half;
  };

  const renderCard = (d: DishCategory, copy: boolean) => {
    const selected = selectedKey === d.key;
    return (
      <button
        key={copy ? `${d.key}~copy` : d.key}
        role={copy ? undefined : 'listitem'}
        aria-hidden={copy || undefined}
        tabIndex={copy ? -1 : undefined}
        className={`dish-card${selected ? ' selected' : ''}`}
        aria-pressed={copy ? undefined : selected}
        onClick={() => onSelect(selected ? null : d.key)}
      >
        <span className="dish-img">
          <img src={d.imageUrl ?? ''} alt="" loading="lazy" decoding="async" />
        </span>
        <span className="dish-name">{d.name}</span>
      </button>
    );
  };

  return (
    <section className="dish-section">
      <h3 className="section-title">What's on your mind?</h3>
      <div
        ref={rowRef}
        className="dish-row"
        role="list"
        onPointerDown={pause}
        onTouchStart={pause}
        onWheel={pause}
        onScroll={onScroll}
        onMouseEnter={() => (hovering.current = true)}
        onMouseLeave={() => {
          hovering.current = false;
          pause();
        }}
      >
        {ordered.map((d) => renderCard(d, false))}
        {looping && ordered.map((d) => renderCard(d, true))}
      </div>
    </section>
  );
}

function offerHeadline(c: Coupon) {
  const isPercent = c.discount_type === 'percent' || c.discount_type === 'percentage';
  const value = Math.trunc(Number(c.discount_value));
  const cap = c.max_discount_amount != null && isPercent ? ` up to ₹${Math.trunc(Number(c.max_discount_amount))}` : '';
  return isPercent ? `${value}% OFF${cap}` : `Flat ₹${value} OFF`;
}

/**
 * Always-visible food promotion banner. Shows only real offers: the city's active coupon, else
 * the free-delivery threshold, else a plain invitation (never an invented discount).
 */
function FoodPromoBanner({
  coupon,
  threshold,
  imageUrl,
  onOrder,
}: {
  coupon: Coupon | null;
  threshold: number | null;
  imageUrl: string | null;
  onOrder: () => void;
}) {
  const style = imageUrl ? { backgroundImage: `linear-gradient(90deg, rgba(20,12,6,0.88) 0%, rgba(20,12,6,0.55) 55%, rgba(20,12,6,0.1) 100%), url("${imageUrl}")` } : undefined;
  if (coupon) {
    const min = coupon.min_order_amount && Number(coupon.min_order_amount) > 0 ? ` on orders above ₹${Math.trunc(Number(coupon.min_order_amount))}` : '';
    return (
      <div className="food-promo" style={style}>
        <div className="food-promo-kicker">TODAY'S OFFER</div>
        <div className="food-promo-title">{offerHeadline(coupon)}</div>
        <div className="food-promo-sub">
          Use code <strong>{coupon.code}</strong>
          {min}
        </div>
        <button
          className="food-promo-cta"
          onClick={() => {
            void navigator.clipboard?.writeText(coupon.code);
            toast(`Coupon code ${coupon.code} copied`);
          }}
        >
          <Copy size={13} /> COPY CODE
        </button>
      </div>
    );
  }
  return (
    <div className="food-promo" style={style}>
      <div className="food-promo-kicker">HOT &amp; FRESH</div>
      <div className="food-promo-title">
        {threshold != null ? `FREE delivery above ₹${Math.trunc(threshold)}` : 'Your favourite hotels, delivered'}
      </div>
      <div className="food-promo-sub">Biryani, meals, snacks &amp; more from local hotels</div>
      <button className="food-promo-cta" onClick={onOrder}>
        ORDER NOW <ChevronRight size={13} />
      </button>
    </div>
  );
}

function CategoryRow({
  categories,
  selectedId,
  onSelect,
}: {
  categories: Category[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <section>
      <h3 className="section-title">Shop by Category</h3>
      <div className="category-row">
        {categories.map((c) => (
          <button key={c.id} className={`category-card${selectedId === c.id ? ' selected' : ''}`} onClick={() => onSelect(c.id)}>
            <span className="category-img">
              {c.image_url ? <img src={c.image_url} alt="" loading="lazy" /> : <Store size={26} />}
            </span>
            <span className="category-name">{c.name}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function GroceryProductCard({
  product,
  quantity,
  onIncrease,
  onDecrease,
  onSelectSize,
}: {
  product: ResolvedProduct;
  quantity: number;
  onIncrease: () => void;
  onDecrease: () => void;
  onSelectSize: () => void;
}) {
  const inStock = isInStockAndActive(product);
  const hasVariants = product.variants.length > 0;
  return (
    <div className={`card product-card${inStock ? '' : ' dimmed'}`}>
      <div className="product-img">
        <ProductImage url={product.imageUrl} alt={product.name} />
        {inStock && product.isFeatured && <span className="tag tag-blue">FEATURED</span>}
        {!inStock && (
          <div className="img-overlay">
            <span className="tag tag-red">OUT OF STOCK</span>
          </div>
        )}
      </div>
      <div className="product-name" title={product.name}>
        {product.name}
      </div>
      {hasVariants ? (
        <div className="price">Starting from {rupees(startingPrice(product))}</div>
      ) : (
        <PriceDisplay price={product.effectivePrice} mrp={product.effectiveMrp} unit={product.unit} />
      )}
      <div className="product-action">
        {!inStock ? (
          <div className="oos-pill">Out of Stock</div>
        ) : hasVariants ? (
          <button className={`btn btn-sm w-full ${quantity > 0 ? 'btn-tonal' : 'btn-primary'}`} onClick={onSelectSize}>
            {quantity > 0 ? `Select Size (${quantity})` : 'Select Size'}
          </button>
        ) : (
          <QuantityStepper quantity={quantity} onIncrease={onIncrease} onDecrease={onDecrease} full />
        )}
      </div>
    </div>
  );
}

function VariantPicker({ product, cityId, onClose }: { product: ResolvedProduct; cityId: string; onClose: () => void }) {
  const groceryCart = useCart((s) => s.groceryCart);
  const addToCart = useCart((s) => s.addToCart);
  return (
    <Modal
      open
      onClose={onClose}
      title={product.name}
      footer={
        <button className="btn btn-primary w-full" onClick={onClose}>
          Done
        </button>
      }
    >
      <p className="muted small">Select quantity / size</p>
      <div className="stack-sm">
        {product.variants.map((v) => {
          const qty = groceryCart.find((i) => i.product_id === product.id && i.variant_id === v.id)?.quantity ?? 0;
          const inStock = v.isAvailable && v.stockQty > 0;
          return (
            <div key={v.id} className={`variant-row${qty > 0 ? ' active' : ''}`}>
              <div>
                <strong className={inStock ? '' : 'muted'}>{v.label}</strong>
                <div className={inStock ? 'price' : 'muted'}>{rupees(v.price)}</div>
              </div>
              {inStock ? (
                <QuantityStepper
                  quantity={qty}
                  onIncrease={() => addToCart({ productId: product.id, cityId, quantityDelta: 1, isHotel: false, variantId: v.id })}
                  onDecrease={() => addToCart({ productId: product.id, cityId, quantityDelta: -1, isHotel: false, variantId: v.id })}
                />
              ) : (
                <span className="oos-pill small">Out of Stock</span>
              )}
            </div>
          );
        })}
      </div>
    </Modal>
  );
}

/** "Chicken Biryani ₹190 · Special Chicken Biryani ₹266 · +1 more" under a hotel for the chosen dish. */
function DishMatches({ items }: { items: DishMatch[] }) {
  const shown = items.slice(0, 3);
  const more = items.length - shown.length;
  return (
    <div className="dish-matches">
      {shown.map((m) => (
        <span key={m.id} className={`dish-match${m.available ? '' : ' unavailable'}`}>
          {m.name} <strong>{rupees(m.price)}</strong>
        </span>
      ))}
      {more > 0 && <span className="dish-match more">+{more} more</span>}
    </div>
  );
}

function HotelCard({ vendor, onClick, matches }: { vendor: Vendor; onClick: () => void; matches?: DishMatch[] }) {
  // getHotels already fetched hours and ratings for the whole page; only ask again if they expired.
  const [slots, setSlots] = useState<OperatingSlot[]>(() => peekVendorExtras(vendor.id).slots ?? []);
  const [rating, setRating] = useState(() => peekVendorExtras(vendor.id).rating ?? 0);
  useEffect(() => {
    const known = peekVendorExtras(vendor.id);
    if (known.slots) setSlots(known.slots);
    else void getVendorOperatingSlots(vendor.id).then(setSlots);
    if (known.rating !== null) setRating(known.rating);
    else void getVendorAverageRating(vendor.id).then(setRating);
  }, [vendor.id]);
  const withinHours = slots.length ? isWithinAnySlot(slots) : isWithinOperatingHours(vendor.opening_time, vendor.closing_time);
  const isActive = vendor.is_active !== false;
  const isOpen = vendor.is_open !== false && isActive && withinHours;
  const hours = slots.length
    ? `Hours: ${slots.map((s) => `${s.start_time}-${s.end_time}`).join(', ')}`
    : vendor.opening_time && vendor.closing_time
      ? `Hours: ${vendor.opening_time} - ${vendor.closing_time}`
      : null;
  return (
    <button className={`card hotel-card${isOpen ? '' : ' dimmed'}`} onClick={onClick}>
      <div className="hotel-banner">
        <ProductImage url={vendor.banner_url} alt={vendor.name} grayscale={!isOpen} />
        <div className="hotel-tags">
          {isActive && vendor.is_featured ? <span className="tag tag-blue">FEATURED</span> : <span />}
          <span className={`tag ${!isActive ? 'tag-red' : isOpen ? 'tag-green' : 'tag-grey'}`}>
            {!isActive ? 'CURRENTLY CLOSED' : isOpen ? 'OPEN NOW' : 'CLOSED'}
          </span>
        </div>
      </div>
      <div className="hotel-info">
        <div className="row between">
          <strong className={isActive ? '' : 'muted'}>{vendor.name}</strong>
          <ChevronRight size={20} className="text-primary" />
        </div>
        {rating > 0 && (
          <div className="row gap-4 small">
            <Star size={14} className="text-warning" fill="currentColor" /> <strong>{rating.toFixed(1)}</strong>
          </div>
        )}
        {vendor.address && (
          <div className="row gap-4 small muted ellipsis">
            <MapPin size={14} /> <span className="ellipsis">{vendor.address}</span>
          </div>
        )}
        {hours && (
          <div className="row gap-4 small muted ellipsis">
            <Clock size={14} /> <span className="ellipsis">{hours}</span>
          </div>
        )}
        {matches && matches.length > 0 && <DishMatches items={matches} />}
      </div>
    </button>
  );
}

const NO_ITEMS: CartItem[] = [];

export default function HomePage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const mode = params.get('mode') === 'hotels' ? 'hotels' : 'grocery';
  const setMode = (m: 'grocery' | 'hotels') =>
    m === 'hotels' ? setParams({ mode: 'hotels' }) : setParams({}, { replace: false });

  const city = useSession((s) => s.selectedCity);
  const userId = useSession((s) => s.userId);
  const cityId = city?.id ?? null;
  const groceryCart = useCart((s) => s.groceryCart);
  const hotelCart = useCart((s) => s.hotelCart);
  const addToCart = useCart((s) => s.addToCart);

  const [search, setSearch] = useState('');
  const query = useDebounced(search.trim(), 350);

  // Grocery state
  const [categories, setCategories] = useState<Category[]>([]);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [products, setProducts] = useState<ResolvedProduct[]>([]);
  const [groceryLoading, setGroceryLoading] = useState(true);
  const [groceryMore, setGroceryMore] = useState(false);
  const [groceryHasMore, setGroceryHasMore] = useState(true);
  const [groceryError, setGroceryError] = useState<string | null>(null);
  const [variantProduct, setVariantProduct] = useState<ResolvedProduct | null>(null);

  // Hotel state
  const [hotels, setHotels] = useState<Vendor[]>([]);
  const [hotelsLoading, setHotelsLoading] = useState(false);
  const [hotelsMore, setHotelsMore] = useState(false);
  const [hotelsHasMore, setHotelsHasMore] = useState(true);
  const [hotelsError, setHotelsError] = useState<string | null>(null);
  const [dishes, setDishes] = useState<DishCategory[]>([]);
  const [dishKeySel, setDishKeySel] = useState<string | null>(null);
  const [promoCoupon, setPromoCoupon] = useState<Coupon | null>(null);
  const hotelsListRef = useRef<HTMLDivElement | null>(null);
  const selectedDish = dishes.find((d) => d.key === dishKeySel) ?? null;
  // Hotels serving the chosen dish + their matching items (null while none chosen / loading).
  const [dishServing, setDishServing] = useState<{
    key: string;
    vendorIds: string[];
    matches: Record<string, DishMatch[]>;
  } | null>(null);
  const dishPending = !!selectedDish && dishServing?.key !== selectedDish.key;

  const [threshold, setThreshold] = useState<number | null>(null);
  const [coupon, setCoupon] = useState<Coupon | null>(null);
  const [showRating, setShowRating] = useState(false);
  const completedRef = useRef(0);
  const reqId = useRef(0);

  const loadCategories = useCallback(async (force = false) => {
    try {
      const list = await getGroceryCategories(force);
      const filtered = list.filter((c) => /veg|fruit/i.test(c.name));
      const shown = (filtered.length ? filtered : list).sort(
        (a, b) => (/veg/i.test(a.name) ? 0 : 1) - (/veg/i.test(b.name) ? 0 : 1),
      );
      setCategories(shown);
      setCategoryId((cur) =>
        cur && shown.some((c) => c.id === cur) ? cur : (shown.find((c) => /veg/i.test(c.name)) ?? shown[0])?.id ?? null,
      );
      if (!shown.length) setGroceryLoading(false);
    } catch (e) {
      setGroceryError(errorMessage(e));
      setGroceryLoading(false);
    }
  }, []);

  const loadProducts = useCallback(
    async (reset: boolean, force = false) => {
      if (!cityId || !categoryId) return;
      const id = ++reqId.current;
      if (reset) {
        setGroceryLoading(true);
        setGroceryError(null);
      } else setGroceryMore(true);
      try {
        const offset = reset ? 0 : products.length;
        const list = await getResolvedGroceryProducts({ cityId, categoryId, searchQuery: query, limit: GROCERY_PAGE, offset, forceRefresh: force });
        if (id !== reqId.current) return;
        setProducts((cur) => {
          if (reset) return sortGrocery(list);
          const seen = new Set(cur.map((p) => p.id));
          return sortGrocery([...cur, ...list.filter((p) => !seen.has(p.id))]);
        });
        setGroceryHasMore(list.length >= GROCERY_PAGE);
      } catch (e) {
        if (id !== reqId.current) return;
        if (reset) {
          setProducts([]);
          setGroceryError(errorMessage(e));
        }
      } finally {
        if (id === reqId.current) {
          setGroceryLoading(false);
          setGroceryMore(false);
        }
      }
    },
    [cityId, categoryId, query, products.length],
  );

  const loadHotels = useCallback(
    async (reset: boolean, force = false) => {
      if (!cityId) return;
      const id = ++reqId.current;
      if (reset) {
        setHotelsLoading(true);
        setHotelsError(null);
      } else setHotelsMore(true);
      try {
        const offset = reset ? 0 : hotels.length;
        const list = await getHotels(cityId, query, HOTEL_PAGE, offset, force, dishServing?.vendorIds ?? null);
        if (id !== reqId.current) return;
        setHotels((cur) => {
          if (reset) return list;
          const seen = new Set(cur.map((h) => h.id));
          return [...cur, ...list.filter((h) => !seen.has(h.id))];
        });
        setHotelsHasMore(list.length >= HOTEL_PAGE);
      } catch (e) {
        if (id === reqId.current && reset) setHotelsError(errorMessage(e));
      } finally {
        if (id === reqId.current) {
          setHotelsLoading(false);
          setHotelsMore(false);
        }
      }
    },
    [cityId, query, hotels.length, dishServing],
  );

  useEffect(() => {
    void loadCategories();
  }, [loadCategories]);

  // Reload the active view when city / category / dish / search / mode changes.
  useEffect(() => {
    if (mode === 'grocery') void loadProducts(true);
    else void loadHotels(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, cityId, categoryId, query, dishServing]);

  // Choosing a dish: find every hotel whose items match it (not only hotels with a section named
  // after it), then the list above reloads with just those hotels.
  useEffect(() => {
    if (!selectedDish || !cityId) {
      setDishServing(null);
      return;
    }
    let cancelled = false;
    setHotelsLoading(true);
    getHotelsServingDish(cityId, selectedDish)
      .then((r) => !cancelled && setDishServing({ key: selectedDish.key, ...r }))
      .catch((e) => {
        if (cancelled) return;
        setHotelsError(errorMessage(e));
        setHotelsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedDish, cityId]);

  // Food tab only: dish categories and the promo coupon (not fetched while browsing grocery).
  useEffect(() => {
    if (mode !== 'hotels' || !cityId) return;
    let cancelled = false;
    getHotelDishCategories(cityId)
      .then((d) => !cancelled && setDishes(d))
      .catch(() => !cancelled && setDishes([]));
    getPromoCoupon(cityId).then((c) => !cancelled && setPromoCoupon(c));
    return () => {
      cancelled = true;
    };
  }, [mode, cityId]);

  // A dish from another city does not apply.
  useEffect(() => setDishKeySel(null), [cityId]);

  useEffect(() => {
    if (!cityId) return;
    getFreeDeliveryThreshold(cityId).then(setThreshold).catch(() => setThreshold(null));
    if (!couponShownThisSession) {
      getPromoCoupon(cityId).then((c) => {
        if (c && !couponShownThisSession) {
          couponShownThisSession = true;
          setCoupon(c);
        }
      });
    }
  }, [cityId]);

  useEffect(() => {
    if (!userId) return;
    getCompletedOrderCount(userId).then((n) => {
      completedRef.current = n;
      if (shouldShowRatingPopup(n) && !couponShownThisSession) {
        setShowRating(true);
        useSession.getState().recordRatingPopupShown();
      }
    });
  }, [userId]);

  const maybeShowRating = () => {
    if (shouldShowRatingPopup(completedRef.current)) {
      setShowRating(true);
      useSession.getState().recordRatingPopupShown();
    }
  };

  // Only price the cart of the tab being shown (no hotel requests while browsing grocery, and vice versa).
  const groceryFresh = useFreshCart(mode === 'grocery' ? groceryCart : NO_ITEMS, cityId);
  const hotelFresh = useFreshCart(mode === 'hotels' ? hotelCart : NO_ITEMS, cityId);
  const groceryTotal = useMemo(() => {
    if (groceryFresh.fresh.length) return cartTotal(groceryFresh.fresh);
    return groceryCart.reduce((sum, item) => {
      const p = products.find((x) => x.id === item.product_id);
      const v = p?.variants.find((x) => x.id === item.variant_id);
      return sum + (v?.price ?? p?.effectivePrice ?? 0) * item.quantity;
    }, 0);
  }, [groceryFresh.fresh, groceryCart, products]);
  const hotelTotal = cartTotal(hotelFresh.fresh);

  const isHotels = mode === 'hotels';
  const activeCount = isHotels ? cartCount(hotelCart) : cartCount(groceryCart);
  const activeTotal = isHotels ? hotelTotal : groceryTotal;

  const grocerySentinel = useInfiniteSentinel(
    () => groceryHasMore && !groceryMore && !groceryLoading && void loadProducts(false),
    mode === 'grocery' && groceryHasMore && products.length > 0,
  );
  const hotelSentinel = useInfiniteSentinel(
    () => hotelsHasMore && !hotelsMore && !hotelsLoading && void loadHotels(false),
    mode === 'hotels' && hotelsHasMore && hotels.length > 0,
  );

  const refresh = () => {
    if (mode === 'grocery') {
      void loadCategories(true);
      void loadProducts(true, true);
    } else void loadHotels(true, true);
  };

  return (
    <div className="page home-page">
      <HomeTopBar onRefresh={refresh} showBack={isHotels} onBack={() => setMode('grocery')} />

      <div className="home-controls">
        <div className="search-bar">
          <Search size={18} className="muted" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={isHotels ? 'Search hotels, restaurants, cuisines...' : 'Search groceries or hotels...'}
            aria-label="Search"
          />
          {search && (
            <button className="icon-btn sm" aria-label="Clear search" onClick={() => setSearch('')}>
              <X size={16} />
            </button>
          )}
        </div>
        <div className="mode-toggle">
          <button className={!isHotels ? 'active' : ''} onClick={() => setMode('grocery')}>
            Fresh Groceries &amp; Fruits
          </button>
          <button className={isHotels ? 'active' : ''} onClick={() => setMode('hotels')}>
            Hotel Food &amp; Dining
          </button>
        </div>
      </div>

      {!city ? (
        <EmptyState
          icon={<MapPin size={48} />}
          title="Please select your delivery city to view live stock & pricing"
          action={
            <button className="btn btn-primary" onClick={openCityPicker}>
              Choose City
            </button>
          }
        />
      ) : !isHotels ? (
        <div className="content-pad">
          {threshold != null && <FreeDeliveryBanner threshold={threshold} />}
          {!search && (
            <>
              <DealsBanner />
              <CategoryRow categories={categories} selectedId={categoryId} onSelect={setCategoryId} />
            </>
          )}
          {groceryLoading && products.length === 0 ? (
            <GridSkeleton count={6} />
          ) : groceryError && products.length === 0 ? (
            <ErrorCard
              message={groceryError}
              onRetry={() => {
                void loadCategories(true);
                void loadProducts(true, true);
              }}
            />
          ) : products.length === 0 ? (
            <p className="muted center-pad">No grocery products found.</p>
          ) : (
            <>
              {products.some((p) => p.stockLoadFailed) && (
                <button className="alert alert-danger w-full mb-12" onClick={() => void loadProducts(true, true)}>
                  Could not load stock for your city, so items can't be added right now. Tap to retry.
                </button>
              )}
              <div className="product-grid">
                {products.map((p) => (
                  <GroceryProductCard
                    key={p.id}
                    product={p}
                    quantity={groceryCart.filter((i) => i.product_id === p.id).reduce((s, i) => s + i.quantity, 0)}
                    onIncrease={() => addToCart({ productId: p.id, cityId, quantityDelta: 1, isHotel: false })}
                    onDecrease={() => addToCart({ productId: p.id, cityId, quantityDelta: -1, isHotel: false })}
                    onSelectSize={() => setVariantProduct(p)}
                  />
                ))}
              </div>
              {groceryHasMore && (
                <div ref={grocerySentinel} className="center-pad">
                  {groceryMore ? (
                    <Spinner />
                  ) : (
                    <button className="btn btn-outline" onClick={() => void loadProducts(false)}>
                      Load More Products (30)
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      ) : (
        <div className="content-pad">
          {threshold != null && <FreeDeliveryBanner threshold={threshold} />}
          {!search && dishes.length > 0 && (
            <DishRow
              dishes={dishes}
              selectedKey={dishKeySel}
              onSelect={(k) => {
                setDishKeySel(k);
                if (k) hotelsListRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }}
            />
          )}
          {!search && (
            <FoodPromoBanner
              coupon={promoCoupon}
              threshold={threshold}
              imageUrl={dishes.find((d) => d.key === 'biryani')?.imageUrl ?? dishes[0]?.imageUrl ?? null}
              onOrder={() => hotelsListRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
            />
          )}
          <div ref={hotelsListRef} className="row between hotels-heading">
            <h3 className="section-title">
              {selectedDish ? `Hotels serving ${selectedDish.name}` : search ? 'Search results' : 'All hotels & restaurants'}
            </h3>
            {selectedDish && (
              <button className="chip-clear" onClick={() => setDishKeySel(null)} aria-label="Clear dish filter">
                {selectedDish.name} <X size={14} />
              </button>
            )}
          </div>
          {(hotelsLoading && hotels.length === 0) || dishPending ? (
            <ListSkeleton count={4} height={220} />
          ) : hotelsError && hotels.length === 0 ? (
            <ErrorCard message={hotelsError} onRetry={() => void loadHotels(true, true)} />
          ) : hotels.length === 0 ? (
            <p className="muted center-pad">
              {selectedDish ? `No hotels serve ${selectedDish.name} right now.` : 'No hotels or restaurants available in this city.'}
            </p>
          ) : (
            <>
              <div className="hotel-grid">
                {hotels.map((h) => (
                  <HotelCard
                    key={h.id}
                    vendor={h}
                    matches={dishServing?.matches[h.id]}
                    onClick={() => navigate(`/hotel/${h.id}?name=${encodeURIComponent(h.name)}`)}
                  />
                ))}
              </div>
              {hotelsHasMore && (
                <div ref={hotelSentinel} className="center-pad">
                  {hotelsMore ? (
                    <Spinner />
                  ) : (
                    <button className="btn btn-outline" onClick={() => void loadHotels(false)}>
                      Load More Hotels (20)
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}

      <div className="floating-cart-wrap">
        <FloatingCartButton
          itemCount={activeCount}
          total={activeTotal}
          onClick={() => navigate(`/checkout/${isHotels ? 'hotel' : 'grocery'}`)}
        />
      </div>

      {variantProduct && cityId && (
        <VariantPicker product={variantProduct} cityId={cityId} onClose={() => setVariantProduct(null)} />
      )}

      <Modal
        open={!!coupon}
        onClose={() => {
          setCoupon(null);
          maybeShowRating();
        }}
      >
        {coupon && (
          <div className="center-col">
            <Tag size={48} className="text-orange" />
            <h2>Special Offer For You!</h2>
            <p className="muted center">{discountSummary(coupon)}</p>
            <button
              className="coupon-code"
              onClick={() => {
                void navigator.clipboard?.writeText(coupon.code);
                toast(`Coupon code ${coupon.code} copied to clipboard!`);
                setCoupon(null);
                maybeShowRating();
              }}
            >
              <span>{coupon.code}</span>
              <Copy size={18} />
            </button>
            <button
              className="btn btn-primary w-full"
              onClick={() => {
                setCoupon(null);
                maybeShowRating();
              }}
            >
              Start Shopping
            </button>
          </div>
        )}
      </Modal>

      <Modal open={showRating} onClose={() => setShowRating(false)}>
        <div className="center-col">
          <div className="row gap-4 text-warning">
            {Array.from({ length: 5 }).map((_, i) => (
              <Star key={i} size={28} fill="currentColor" />
            ))}
          </div>
          <h2>Enjoying Sndmart?</h2>
          <p className="muted center">
            Your feedback helps us improve and helps other people in Sindhanur discover us. A quick 5-star rating would
            mean a lot!
          </p>
          <button
            className="btn btn-primary w-full"
            onClick={() => {
              setShowRating(false);
              useSession.getState().recordUserRated();
              window.open('https://play.google.com/store/apps/details?id=in.sndmart.app', '_blank', 'noopener');
            }}
          >
            Rate Us Now
          </button>
          <div className="row between w-full">
            <button
              className="btn btn-text small"
              onClick={() => {
                setShowRating(false);
                useSession.getState().recordRatingPopupDismissedForever();
              }}
            >
              Don't Ask Again
            </button>
            <button className="btn btn-text small" onClick={() => setShowRating(false)}>
              Maybe Later
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
