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
  ConfirmDialog,
  EmptyState,
  ErrorCard,
  FloatingCartButton,
  GridSkeleton,
  ListSkeleton,
  ResizedImg,
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
  searchHotelVendorIds,
  searchHotelDishes,
  type DishCategory,
  type DishMatch,
  getResolvedGroceryProducts,
  getFeaturedGroceryProducts,
  getTopSellingGroceryProducts,
  getTopSellingFoodProducts,
  getHotelExtras,
  prefetchHotelMenu,
  getPromoBanners,
  peekPromoBanners,
  getLocalAds,
  peekLocalAds,
  peekFeaturedGroceryProducts,
  peekTopSellingGroceryProducts,
  peekTopSellingFoodProducts,
  peekGroceryCategories,
  peekGroceryProducts,
  peekHotelDishCategories,
  peekHotelExtras,
  peekHotels,
} from '../lib/repository';
import type { CartItem, Category, Coupon, LocalAd, OperatingSlot, PromoBanner, ResolvedProduct, Vendor } from '../lib/types';
import { PromoCarousel } from '../components/PromoCarousel';
import { LocalAdStrip } from '../components/LocalAdStrip';
import { OfferBanner } from '../components/OfferBanner';
import { OfferInline } from '../lib/promo';
import { useDebounced, useFreshCart, useInfiniteSentinel, useMyWallet } from '../lib/hooks';
import { WalletChip } from '../components/WalletChip';
import {
  cartTotal,
  couponHeadline,
  couponTerms,
  errorMessage,
  isCashbackCoupon,
  isHotelItemAvailable,
  isInStockAndActive,
  isVendorOpenNow,
  rupees,
  sortGroceryProducts,
  sortHotels,
  startingPrice,
} from '../lib/utils';
import { shouldShowRatingPopup, useSession } from '../store/session';
import { cartCount, useCart } from '../store/cart';

const GROCERY_PAGE = 30;
const HOTEL_PAGE = 20;
let couponShownThisSession = false;

// In stock + featured, in stock, unavailable + featured, unavailable; then by name.
const sortGrocery = sortGroceryProducts;


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
        <WalletChip />
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
        <div className="deals-kicker">FARM FRESH DAILY</div>
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
const DISHES_PER_SET = 8; // 4 on top, 4 below
const DISH_SET_MS = 5 * 60 * 1000;
const currentDishSlot = () => Math.floor(Date.now() / DISH_SET_MS);

/**
 * Swiggy-style "What's on your mind?": 8 dishes (4 x 2) in round images. Every 5 minutes the next
 * 8 dishes (other dish types, from other hotels) take their place, cycling through all of them.
 * The set does not change while a dish is selected.
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
  const [slot, setSlot] = useState(currentDishSlot);

  // Move to the next set at each 5-minute boundary (not while a dish is selected).
  useEffect(() => {
    if (selectedKey) return;
    setSlot(currentDishSlot());
    let t = 0;
    const schedule = () => {
      const wait = DISH_SET_MS - (Date.now() % DISH_SET_MS) + 50;
      t = window.setTimeout(() => {
        setSlot(currentDishSlot());
        schedule();
      }, wait);
    };
    schedule();
    return () => window.clearTimeout(t);
  }, [selectedKey]);

  const visible = useMemo(() => {
    const n = dishes.length;
    if (n <= DISHES_PER_SET) return dishes;
    const sets = Math.ceil(n / DISHES_PER_SET);
    const start = (slot % sets) * DISHES_PER_SET;
    // The last set is topped up from the beginning, so there are always 8.
    return Array.from({ length: DISHES_PER_SET }, (_, i) => dishes[(start + i) % n]);
  }, [dishes, slot]);

  return (
    <section className="dish-section">
      <h3 className="section-title">What's on your mind?</h3>
      <div key={slot} className="dish-grid" role="list">
        {visible.map((d) => {
          const selected = selectedKey === d.key;
          return (
            <button
              key={d.key}
              role="listitem"
              className={`dish-card${selected ? ' selected' : ''}`}
              aria-pressed={selected}
              onClick={() => onSelect(selected ? null : d.key)}
            >
              <span className="dish-img">
                {d.imageUrl && <ResizedImg url={d.imageUrl} width={76} />}
              </span>
              <span className="dish-name">{d.name}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
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
        <div className="food-promo-title">{couponHeadline(coupon)}</div>
        <div className="food-promo-sub">
          Use code <strong>{coupon.code}</strong>
          {min}
          {isCashbackCoupon(coupon) && ' · cashback to your wallet after delivery'}
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
              {c.image_url ? <ResizedImg url={c.image_url} width={72} /> : <Store size={26} />}
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
  priority = false,
}: {
  product: ResolvedProduct;
  quantity: number;
  onIncrease: () => void;
  onDecrease: () => void;
  onSelectSize: () => void;
  /** First cards on screen: image loads immediately. */
  priority?: boolean;
}) {
  const city = useSession((s) => s.selectedCity);
  const inStock = isInStockAndActive(product, city);
  const hasVariants = product.variants.length > 0;
  return (
    <div className={`card product-card${inStock ? '' : ' dimmed'}`}>
      <div className="product-img">
        <ProductImage url={product.imageUrl} alt={product.name} width={200} priority={priority} />
        {inStock && product.isFeatured && <span className="tag tag-blue">FEATURED</span>}
        {inStock && (product.soldCount ?? 0) > 0 && (
          <span className="sold-badge">🔥 {product.soldCount} sold</span>
        )}
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
        <div className="price"><OfferInline prefix="Starting from " price={startingPrice(product)} kind="grocery" /></div>
      ) : (
        <PriceDisplay price={product.effectivePrice} mrp={product.effectiveMrp} unit={product.unit} kind="grocery" />
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

// A food-search result: the dish itself (image, name, its hotel, price) with a direct Add.
function SearchDishCard({
  product,
  quantity,
  onIncrease,
  onDecrease,
  onOpenHotel,
}: {
  product: ResolvedProduct;
  quantity: number;
  onIncrease: () => void;
  onDecrease: () => void;
  onOpenHotel: () => void;
}) {
  const orderable = (product.hotelOpen ?? false) && isHotelItemAvailable(product);
  return (
    <div className={`card product-card${orderable ? '' : ' dimmed'}`}>
      <button className="product-img dish-img-btn" onClick={onOpenHotel} aria-label={`Open ${product.vendorName ?? 'hotel'}`}>
        <ProductImage url={product.imageUrl} alt={product.name} width={200} />
        {!orderable && (
          <div className="img-overlay">
            <span className="tag tag-red">{product.hotelOpen ? 'Not available' : 'Hotel closed'}</span>
          </div>
        )}
      </button>
      <div className="product-name" title={product.name}>
        {product.name}
      </div>
      <button className="dish-hotel-link muted small ellipsis" onClick={onOpenHotel} title={product.vendorName ?? ''}>
        <Store size={12} /> {product.vendorName}
      </button>
      <div className="price"><OfferInline price={product.effectivePrice} kind="food" /></div>
      <div className="product-action">
        {orderable ? (
          <QuantityStepper quantity={quantity} onIncrease={onIncrease} onDecrease={onDecrease} full />
        ) : (
          <button className="btn btn-sm btn-outline w-full" onClick={onOpenHotel}>
            View Hotel
          </button>
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
                <div className={inStock ? 'price' : 'muted'}>{inStock ? <OfferInline price={v.price} kind="grocery" /> : rupees(v.price)}</div>
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
          {m.name} <strong><OfferInline price={m.price} kind="food" /></strong>
        </span>
      ))}
      {more > 0 && <span className="dish-match more">+{more} more</span>}
    </div>
  );
}

function HotelCard({
  vendor,
  slots,
  rating,
  onClick,
  onIntent,
  matches,
  priority = false,
}: {
  vendor: Vendor;
  /** Finger down / mouse over: start loading the menu before the tap completes. */
  onIntent?: () => void;
  priority?: boolean;
  /** Hours loaded for the whole list in one request; undefined = use opening/closing time. */
  slots?: OperatingSlot[];
  rating: number;
  onClick: () => void;
  matches?: DishMatch[];
}) {
  const city = useSession((s) => s.selectedCity);
  const isActive = vendor.is_active !== false;
  const isOpen = isVendorOpenNow(vendor, slots, city);
  const hours = slots?.length
    ? `Hours: ${slots.map((s) => `${s.start_time}-${s.end_time}`).join(', ')}`
    : vendor.opening_time && vendor.closing_time
      ? `Hours: ${vendor.opening_time} - ${vendor.closing_time}`
      : null;
  return (
    <button
      className={`card hotel-card${isOpen ? '' : ' dimmed'}`}
      onClick={onClick}
      onPointerDown={onIntent}
      onMouseEnter={onIntent}
      onFocus={onIntent}
    >
      <div className="hotel-banner">
        <ProductImage url={vendor.banner_url} alt={vendor.name} grayscale={!isOpen} width={480} priority={priority} />
        <div className="hotel-tags">
          {vendor.is_featured ? <span className="tag tag-blue">FEATURED</span> : <span />}
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
const NO_BANNERS: PromoBanner[] = [];
const NO_LOCAL_ADS: LocalAd[] = [];

/** Vegetables and fruits only (vegetables first), like the app. */
function shownGroceryCategories(list: Category[]): Category[] {
  const filtered = list.filter((c) => /veg|fruit/i.test(c.name));
  return [...(filtered.length ? filtered : list)].sort((a, b) => (/veg/i.test(a.name) ? 0 : 1) - (/veg/i.test(b.name) ? 0 : 1));
}
const firstGroceryCategory = (shown: Category[]) => (shown.find((c) => /veg/i.test(c.name)) ?? shown[0])?.id ?? null;

/** Runs low-priority work (prefetching) when the browser is idle. */
function whenIdle(fn: () => void) {
  const idle = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
  if (idle) idle(fn, { timeout: 2000 });
  else setTimeout(fn, 300);
}

export default function HomePage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const city = useSession((s) => s.selectedCity);
  // Launch Mode (set by City Admin): a new city can go live Food-only or Grocery-only before
  // its other catalog is ready. No explicit ?mode= in the URL defers to that; an explicit
  // mode (from a link, a tab tap, or "Choose City") always wins.
  const serviceMode = city?.service_mode ?? 'both';
  const modeParam = params.get('mode');
  const mode: 'grocery' | 'hotels' =
    modeParam === 'hotels' ? 'hotels' : modeParam === 'grocery' ? 'grocery' : serviceMode === 'food_only' ? 'hotels' : 'grocery';
  const setMode = (m: 'grocery' | 'hotels') =>
    m === 'hotels' ? setParams({ mode: 'hotels' }) : setParams({ mode: 'grocery' }, { replace: false });

  const userId = useSession((s) => s.userId);
  const cityId = city?.id ?? null;
  const groceryCart = useCart((s) => s.groceryCart);
  const hotelCart = useCart((s) => s.hotelCart);
  const addToCart = useCart((s) => s.addToCart);
  const forceClearHotelCartAndAdd = useCart((s) => s.forceClearHotelCartAndAdd);
  // Food search shows matching DISHES directly (with their hotel + an Add button).
  const [dishResults, setDishResults] = useState<ResolvedProduct[]>([]);
  const [dishResultsLoading, setDishResultsLoading] = useState(false);
  const [dishConflict, setDishConflict] = useState<{ item: CartItem; hotel: string } | null>(null);

  const [search, setSearch] = useState('');
  const query = useDebounced(search.trim(), 350);

  // Grocery state
  // Last visit's categories (if any) let the product request start immediately.
  const [categories, setCategories] = useState<Category[]>(() => shownGroceryCategories(peekGroceryCategories() ?? []));
  const [categoryId, setCategoryId] = useState<string | null>(() => firstGroceryCategory(categories));
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
  // Hours + ratings for every loaded hotel (fetched in batches, never per card).
  const [hotelExtras, setHotelExtras] = useState<{ slots: Record<string, OperatingSlot[]>; ratings: Record<string, number> }>({
    slots: {},
    ratings: {},
  });
  // Re-evaluated every minute and when the tab comes back, since hotels open and close.
  const [clock, setClock] = useState(() => Date.now());
  const [featuredProducts, setFeaturedProducts] = useState<ResolvedProduct[]>([]);
  const [topSelling, setTopSelling] = useState<ResolvedProduct[]>([]);
  const [topFood, setTopFood] = useState<ResolvedProduct[]>([]);
  const [dishes, setDishes] = useState<DishCategory[]>([]);
  const [dishKeySel, setDishKeySel] = useState<string | null>(null);
  const [promoCoupon, setPromoCoupon] = useState<Coupon | null>(null);
  // Super-Admin banners for the tab being shown (last-seen ones appear at once).
  const [bannerState, setBannerState] = useState<{ placement: 'grocery' | 'food'; list: PromoBanner[] }>({ placement: 'grocery', list: [] });
  const placementNow = mode === 'hotels' ? 'food' : 'grocery';
  // Never show the other tab's banners while this tab's load.
  const banners = bannerState.placement === placementNow ? bannerState.list : NO_BANNERS;
  const setBanners = (placement: 'grocery' | 'food', list: PromoBanner[]) => setBannerState({ placement, list });
  // Local-business paid ads: 'home' banner + bottom-of-list strip for each tab.
  const [homeAds, setHomeAds] = useState<LocalAd[]>([]);
  const [bottomAdState, setBottomAdState] = useState<{ placement: 'grocery_bottom' | 'food_bottom'; list: LocalAd[] }>({
    placement: 'grocery_bottom',
    list: [],
  });
  const bottomAdsNow = mode === 'hotels' ? 'food_bottom' : 'grocery_bottom';
  const bottomAds = bottomAdState.placement === bottomAdsNow ? bottomAdState.list : NO_LOCAL_ADS;
  const groceryTopRef = useRef<HTMLDivElement | null>(null);
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
  // Wallet limits for the coupon terms ("Use max 20% of wallet per order").
  const walletPercent = useMyWallet()?.max_use_percent ?? null;
  const [showRating, setShowRating] = useState(false);
  const completedRef = useRef(0);
  const reqId = useRef(0);

  const loadCategories = useCallback(async (force = false) => {
    try {
      const list = await getGroceryCategories(force);
      const shown = shownGroceryCategories(list);
      setCategories(shown);
      setCategoryId((cur) => (cur && shown.some((c) => c.id === cur) ? cur : firstGroceryCategory(shown)));
      if (!shown.length) setGroceryLoading(false);
    } catch (e) {
      setGroceryError(errorMessage(e));
      setGroceryLoading(false);
    }
  }, []);

  const loadProducts = useCallback(
    async (reset: boolean, force = false) => {
      // A category is only needed while browsing; a search spans every category.
      if (!cityId || (!query && !categoryId)) return;
      const id = ++reqId.current;
      if (reset) {
        setGroceryLoading(true);
        setGroceryError(null);
        // Show last visit's first page at once; the fresh page below replaces it.
        const seen = !query && categoryId && !force ? peekGroceryProducts(cityId, categoryId, GROCERY_PAGE) : null;
        if (seen) {
          setProducts(sortGrocery(seen));
          setGroceryHasMore(seen.length >= GROCERY_PAGE);
        }
      } else setGroceryMore(true);
      try {
        const offset = reset ? 0 : products.length;
        // While searching, pass no category so the match spans all grocery products.
        const list = await getResolvedGroceryProducts({ cityId, categoryId: query ? '' : categoryId, searchQuery: query, limit: GROCERY_PAGE, offset, forceRefresh: force });
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
        const seen = !query && !dishServing && !force ? peekHotels(cityId, HOTEL_PAGE) : null;
        if (seen) {
          setHotels(seen);
          setHotelsHasMore(seen.length >= HOTEL_PAGE);
          const extras = peekHotelExtras(seen.map((h) => h.id));
          setHotelExtras((cur) => ({ slots: { ...extras.slots, ...cur.slots }, ratings: { ...extras.ratings, ...cur.ratings } }));
        }
      } else setHotelsMore(true);
      try {
        const offset = reset ? 0 : hotels.length;
        // Free-text search: match hotels by their name OR by a menu item (dish) they serve.
        // The matching vendor ids are resolved first, then paged like any hotel list.
        let ids = dishServing?.vendorIds ?? null;
        let nameFilter: string | null = query;
        if (query) {
          const matchIds = await searchHotelVendorIds(cityId, query);
          if (id !== reqId.current) return;
          ids = matchIds;
          nameFilter = null; // ids already encode name + dish matches — don't AND a name filter
        }
        const list =
          ids && !ids.length ? [] : await getHotels(cityId, nameFilter, HOTEL_PAGE, offset, force, ids);
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

  // Food search: fetch matching dishes directly (shown above the hotels list).
  useEffect(() => {
    if (mode !== 'hotels' || !cityId || !query) {
      setDishResults([]);
      setDishResultsLoading(false);
      return;
    }
    let cancelled = false;
    setDishResultsLoading(true);
    searchHotelDishes(cityId, query)
      .then((list) => {
        if (!cancelled) setDishResults(list);
      })
      .catch(() => {
        if (!cancelled) setDishResults([]);
      })
      .finally(() => {
        if (!cancelled) setDishResultsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [mode, cityId, query]);

  const addDishToCart = useCallback(
    (p: ResolvedProduct, delta: number) => {
      if (!p.vendorId || !cityId) return;
      const r = addToCart({ productId: p.id, vendorId: p.vendorId, cityId, quantityDelta: delta, isHotel: true });
      if (r.kind === 'hotelConflict') setDishConflict({ item: r.pendingItem, hotel: p.vendorName ?? 'this hotel' });
    },
    [addToCart, cityId],
  );

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
    const seenDishes = peekHotelDishCategories(cityId);
    if (seenDishes) setDishes(seenDishes);
    getHotelDishCategories(cityId)
      .then((d) => !cancelled && setDishes(d))
      .catch(() => !cancelled && setDishes([]));
    getPromoCoupon(cityId).then((c) => !cancelled && setPromoCoupon(c));
    return () => {
      cancelled = true;
    };
  }, [mode, cityId]);

  // Hours/ratings for hotels that do not have fresh ones yet (one request each for the whole list).
  const extrasFetched = useRef(new Set<string>());
  useEffect(() => {
    const missing = hotels.map((h) => h.id).filter((id) => !extrasFetched.current.has(id));
    missing.forEach((id) => extrasFetched.current.add(id));
    if (!missing.length) return;
    let cancelled = false;
    getHotelExtras(missing)
      .then((x) => {
        if (cancelled) return;
        setHotelExtras((cur) => ({ slots: { ...cur.slots, ...x.slots }, ratings: { ...cur.ratings, ...x.ratings } }));
      })
      .catch(() => {
        /* cards fall back to opening/closing time */
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hotels]);

  // Open/closed changes with the time: refresh the order every minute while the food list shows.
  useEffect(() => {
    if (mode !== 'hotels') return;
    const tick = () => setClock(Date.now());
    const t = window.setInterval(() => !document.hidden && tick(), 60_000);
    const onVisible = () => document.visibilityState === 'visible' && tick();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [mode]);

  // Open + featured, open, closed + featured, closed; then by name (search results too).
  const orderedHotels = useMemo(
    () => sortHotels(hotels, (id) => hotelExtras.slots[id]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hotels, hotelExtras, clock],
  );

  // Grocery tab only: featured products in stock in this city.
  useEffect(() => {
    if (mode !== 'grocery' || !cityId) return;
    let cancelled = false;
    const seenFeatured = peekFeaturedGroceryProducts(cityId);
    if (seenFeatured) setFeaturedProducts(seenFeatured);
    getFeaturedGroceryProducts(cityId)
      .then((list) => !cancelled && setFeaturedProducts(list))
      .catch(() => !cancelled && setFeaturedProducts([]));
    return () => {
      cancelled = true;
    };
  }, [mode, cityId]);

  // Grocery tab only: most-selling products in this city (by units sold).
  useEffect(() => {
    if (mode !== 'grocery' || !cityId) return;
    let cancelled = false;
    const seenTop = peekTopSellingGroceryProducts(cityId);
    if (seenTop) setTopSelling(seenTop);
    getTopSellingGroceryProducts(cityId)
      .then((list) => !cancelled && setTopSelling(list))
      .catch(() => !cancelled && setTopSelling([]));
    return () => {
      cancelled = true;
    };
  }, [mode, cityId]);

  // Food tab only: most-ordered hotel dishes in this city.
  useEffect(() => {
    if (mode !== 'hotels' || !cityId) return;
    let cancelled = false;
    const seenFood = peekTopSellingFoodProducts(cityId);
    if (seenFood) setTopFood(seenFood);
    getTopSellingFoodProducts(cityId)
      .then((list) => !cancelled && setTopFood(list))
      .catch(() => !cancelled && setTopFood([]));
    return () => {
      cancelled = true;
    };
  }, [mode, cityId]);

  useEffect(() => {
    if (!cityId) return;
    const placement = mode === 'hotels' ? 'food' : 'grocery';
    let cancelled = false;
    setBanners(placement, peekPromoBanners(cityId, placement) ?? []);
    getPromoBanners(cityId, placement)
      .then((b) => !cancelled && setBanners(placement, b))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [mode, cityId]);

  // Home-page ad banner — loads once per city (shown at the top, same spot on both tabs).
  useEffect(() => {
    if (!cityId) return;
    let cancelled = false;
    setHomeAds(peekLocalAds(cityId, 'home') ?? []);
    getLocalAds(cityId, 'home')
      .then((a) => !cancelled && setHomeAds(a))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [cityId]);

  // Bottom-of-list ad strip, per active tab.
  useEffect(() => {
    if (!cityId) return;
    const placement = mode === 'hotels' ? 'food_bottom' : 'grocery_bottom';
    let cancelled = false;
    setBottomAdState({ placement, list: peekLocalAds(cityId, placement) ?? [] });
    getLocalAds(cityId, placement)
      .then((a) => !cancelled && setBottomAdState({ placement, list: a }))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [mode, cityId]);

  const openBanner = (b: PromoBanner) => {
    if (!b.link_value) return;
    if (b.link_type === 'hotel') navigate(`/hotel/${b.link_value}`);
    else if (b.link_type === 'url' && /^https:\/\//.test(b.link_value)) window.open(b.link_value, '_blank', 'noopener,noreferrer');
    else if (b.link_type === 'category') {
      setSearch('');
      if (mode !== 'grocery') setMode('grocery');
      setCategoryId(b.link_value);
      setTimeout(() => groceryTopRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
    }
  };

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

  // Smart pagination: once a page is on screen, the next one is fetched in the background (idle
  // time), so scrolling down shows it instantly instead of waiting at the bottom.
  useEffect(() => {
    if (mode !== 'grocery' || groceryLoading || groceryMore || !groceryHasMore || !cityId || !categoryId || !products.length) return;
    const offset = products.length;
    whenIdle(() =>
      void getResolvedGroceryProducts({ cityId, categoryId: query ? '' : categoryId, searchQuery: query, limit: GROCERY_PAGE, offset }).catch(() => undefined),
    );
  }, [mode, groceryLoading, groceryMore, groceryHasMore, cityId, categoryId, query, products.length]);
  useEffect(() => {
    if (mode !== 'hotels' || hotelsLoading || hotelsMore || !hotelsHasMore || !cityId || !hotels.length || dishPending) return;
    const offset = hotels.length;
    const ids = dishServing?.vendorIds ?? null;
    whenIdle(() => void getHotels(cityId, query, HOTEL_PAGE, offset, false, ids).catch(() => undefined));
  }, [mode, hotelsLoading, hotelsMore, hotelsHasMore, cityId, query, hotels.length, dishServing, dishPending]);
  // The other grocery category (vegetables <-> fruits) is ready before it is tapped.
  useEffect(() => {
    if (mode !== 'grocery' || groceryLoading || !cityId || query) return;
    const others = categories.filter((c) => c.id !== categoryId).slice(0, 3);
    if (!others.length) return;
    whenIdle(() => {
      for (const c of others) {
        void getResolvedGroceryProducts({ cityId, categoryId: c.id, limit: GROCERY_PAGE, offset: 0 }).catch(() => undefined);
      }
    });
  }, [mode, groceryLoading, cityId, query, categories, categoryId]);

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
      if (cityId) getFeaturedGroceryProducts(cityId, true).then(setFeaturedProducts).catch(() => undefined);
      if (cityId) getPromoBanners(cityId, 'grocery', true).then((b) => setBanners('grocery', b)).catch(() => undefined);
    } else {
      setHotelExtras({ slots: {}, ratings: {} });
      extrasFetched.current.clear();
      void loadHotels(true, true);
      if (cityId) getPromoBanners(cityId, 'food', true).then((b) => setBanners('food', b)).catch(() => undefined);
    }
  };

  return (
    <div className="page home-page">
      <HomeTopBar onRefresh={refresh} showBack={isHotels && serviceMode !== 'food_only'} onBack={() => setMode('grocery')} />

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
          <button
            className={!isHotels ? 'active' : ''}
            disabled={serviceMode === 'food_only'}
            onClick={() => setMode('grocery')}
          >
            Fresh Groceries &amp; Fruits
            {serviceMode === 'food_only' && <span className="soon-badge">Coming Soon</span>}
          </button>
          <button
            className={isHotels ? 'active' : ''}
            disabled={serviceMode === 'grocery_only'}
            onClick={() => setMode('hotels')}
          >
            Hotel Food &amp; Dining
            {serviceMode === 'grocery_only' && <span className="soon-badge">Coming Soon</span>}
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
              {homeAds.length > 0 && <LocalAdStrip ads={homeAds} />}
              {banners.length ? <PromoCarousel banners={banners} onOpen={openBanner} /> : <DealsBanner />}
              <OfferBanner kind="grocery" />
              {topSelling.length > 0 && (
                <section className="featured-section">
                  <h3 className="section-title">🔥 Most Selling</h3>
                  <div className="featured-row">
                    {topSelling.map((p) => (
                      <div key={p.id} className="featured-item">
                        <GroceryProductCard
                          product={p}
                          quantity={groceryCart.filter((i) => i.product_id === p.id).reduce((s, i) => s + i.quantity, 0)}
                          onIncrease={() => addToCart({ productId: p.id, cityId, quantityDelta: 1, isHotel: false })}
                          onDecrease={() => addToCart({ productId: p.id, cityId, quantityDelta: -1, isHotel: false })}
                          onSelectSize={() => setVariantProduct(p)}
                        />
                      </div>
                    ))}
                  </div>
                </section>
              )}
              {featuredProducts.length > 0 && (
                <section className="featured-section">
                  <h3 className="section-title">Featured Products</h3>
                  <div className="featured-row">
                    {featuredProducts.map((p) => (
                      <div key={p.id} className="featured-item">
                        <GroceryProductCard
                          product={p}
                          quantity={groceryCart.filter((i) => i.product_id === p.id).reduce((s, i) => s + i.quantity, 0)}
                          onIncrease={() => addToCart({ productId: p.id, cityId, quantityDelta: 1, isHotel: false })}
                          onDecrease={() => addToCart({ productId: p.id, cityId, quantityDelta: -1, isHotel: false })}
                          onSelectSize={() => setVariantProduct(p)}
                        />
                      </div>
                    ))}
                  </div>
                </section>
              )}
              <div ref={groceryTopRef} />
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
                {products.map((p, i) => (
                  <GroceryProductCard
                    key={p.id}
                    priority={i < 4}
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
              {!groceryHasMore && bottomAds.length > 0 && <LocalAdStrip ads={bottomAds} />}
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
          {!search && banners.length > 0 && <PromoCarousel banners={banners} onOpen={openBanner} />}
          {!search && <OfferBanner kind="food" />}
          {!search && topFood.length > 0 && (
            <section className="featured-section">
              <h3 className="section-title">🔥 Most Ordered</h3>
              <div className="featured-row">
                {topFood.map((p) => (
                  <button
                    key={p.id}
                    className="card product-card food-order-card"
                    onClick={() => navigate(`/hotel/${p.vendorId}?name=${encodeURIComponent(p.vendorName ?? '')}`)}
                  >
                    <div className="product-img">
                      <ProductImage url={p.imageUrl} alt={p.name} width={200} />
                      {(p.soldCount ?? 0) > 0 && <span className="sold-badge">🔥 {p.soldCount} sold</span>}
                    </div>
                    <div className="product-name" title={p.name}>{p.name}</div>
                    <div className="muted small ellipsis">{p.vendorName}</div>
                    <div className="price"><OfferInline price={p.effectivePrice} kind="food" /></div>
                  </button>
                ))}
              </div>
            </section>
          )}
          {!search && !banners.length && (
            <FoodPromoBanner
              coupon={promoCoupon}
              threshold={threshold}
              imageUrl={dishes.find((d) => d.key === 'biryani')?.imageUrl ?? dishes[0]?.imageUrl ?? null}
              onOrder={() => hotelsListRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
            />
          )}
          {search && (
            <section className="dish-results">
              <h3 className="section-title">
                {dishResultsLoading ? 'Finding dishes…' : dishResults.length > 0 ? `Dishes matching "${search.trim()}"` : ''}
              </h3>
              {dishResultsLoading && dishResults.length === 0 ? (
                <GridSkeleton count={4} />
              ) : dishResults.length > 0 ? (
                <div className="product-grid">
                  {dishResults.map((p) => (
                    <SearchDishCard
                      key={p.id}
                      product={p}
                      quantity={hotelCart.find((i) => i.product_id === p.id)?.quantity ?? 0}
                      onIncrease={() => addDishToCart(p, 1)}
                      onDecrease={() => addDishToCart(p, -1)}
                      onOpenHotel={() => navigate(`/hotel/${p.vendorId}?name=${encodeURIComponent(p.vendorName ?? '')}`)}
                    />
                  ))}
                </div>
              ) : null}
            </section>
          )}
          <div ref={hotelsListRef} className="row between hotels-heading">
            <h3 className="section-title">
              {selectedDish ? `Hotels serving ${selectedDish.name}` : search ? 'Restaurants' : 'All hotels & restaurants'}
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
                {orderedHotels.map((h, i) => (
                  <HotelCard
                    key={h.id}
                    priority={i < 2}
                    onIntent={() => cityId && prefetchHotelMenu(h.id, cityId)}
                    vendor={h}
                    slots={hotelExtras.slots[h.id]}
                    rating={hotelExtras.ratings[h.id] ?? 0}
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
              {!hotelsHasMore && bottomAds.length > 0 && <LocalAdStrip ads={bottomAds} />}
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

      <ConfirmDialog
        open={!!dishConflict}
        title="Replace Hotel Cart Items?"
        text={`Your cart already contains items from another hotel. Clear existing items and add from ${dishConflict?.hotel ?? 'this hotel'}?`}
        confirmLabel="Clear & Add"
        onCancel={() => setDishConflict(null)}
        onConfirm={() => {
          if (dishConflict) forceClearHotelCartAndAdd(dishConflict.item);
          setDishConflict(null);
          toast('Cart cleared and item added');
        }}
      />

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
            <p className="muted center">{couponTerms(coupon, walletPercent)}</p>
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
