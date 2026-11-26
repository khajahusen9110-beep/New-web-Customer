import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ChevronRight, Clock, LayoutGrid, MapPin, MoreHorizontal, Search, Store as StoreIcon } from 'lucide-react';
import { useSession } from '../../store/session';
import { ConfirmDialog, EmptyState, ErrorCard, ListSkeleton, toast } from '../../components/ui';
import { HomeBrandHeader, HomeMenuSheet, HomeModeTabs, HomePillSearch, HomeSectionHeader, openSupportWhatsApp, useOpen } from '../../components/HomeTop';
import { PromoCarousel } from '../../components/PromoCarousel';
import { getPromoBanners } from '../../lib/repository';
import { cartCount, useCart } from '../../store/cart';
import type { CartItem, PromoBanner } from '../../lib/types';
import {
  getCustomerLocation, getStoreCardInfo, getStoreMenu, getStoresConfig, listStores, searchStoreProducts,
  type Loc, type StoreCardInfo, type StoreListItem, type StoreProductHit, type StoreSort, type StoresConfig,
} from '../../lib/stores';
import { getHelperConfig } from '../../lib/helper';
import { StoreCard, StoreProductRow } from './parts';

const SORTS: { key: StoreSort; label: string }[] = [
  { key: 'cheapest', label: 'Cheapest' },
  { key: 'nearest', label: 'Nearest' },
  { key: 'relevance', label: 'Best match' },
];

/** Stores home: search (cheapest first), the categories the city switched on, and the shops near the customer. */
export default function StoresPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const city = useSession((s) => s.selectedCity);
  const userId = useSession((s) => s.userId);
  const cityId = city?.id ?? null;

  const [cfg, setCfg] = useState<StoresConfig | null>(null);
  const [loc, setLoc] = useState<Loc | null>(null);
  const [locDone, setLocDone] = useState(false);
  const [stores, setStores] = useState<StoreListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const catId = params.get('c') ?? '';
  const q = params.get('q') ?? '';
  const [text, setText] = useState(q);
  const [sort, setSort] = useState<StoreSort>('cheapest');
  const [hits, setHits] = useState<StoreProductHit[] | null>(null);
  const [searching, setSearching] = useState(false);

  const [helperOn, setHelperOn] = useState(false);
  const [cardInfo, setCardInfo] = useState<Record<string, StoreCardInfo>>({});
  const [menuOpen, openMenu, closeMenu] = useOpen();
  const [allCats, setAllCats] = useState(false);
  const [banners, setBanners] = useState<PromoBanner[]>([]);
  useEffect(() => { if (cityId) void getPromoBanners(cityId, 'grocery').then(setBanners).catch(() => undefined); }, [cityId]);
  const openBanner = (b: PromoBanner) => {
    if (!b.link_value) return;
    if (b.link_type === 'hotel') navigate(`/hotel/${b.link_value}`);
    else if (b.link_type === 'url' && /^https:\/\//.test(b.link_value)) window.open(b.link_value, '_blank', 'noopener,noreferrer');
    else if (b.link_type === 'category') setParams({ c: b.link_value }, { replace: true });
  };
  useEffect(() => { void getStoresConfig(cityId).then(setCfg); }, [cityId]);
  useEffect(() => { if (cityId) void getHelperConfig(cityId).then((c) => setHelperOn(c?.enabled === true)); }, [cityId]);
  useEffect(() => { void getCustomerLocation(userId).then((l) => { setLoc(l); setLocDone(true); }); }, [userId]);

  // Stores off for this city: nothing to show here
  useEffect(() => {
    if (cfg && !cfg.stores_enabled) navigate('/', { replace: true });
  }, [cfg, navigate]);

  const load = async () => {
    if (!cityId || !cfg?.stores_enabled || !locDone) return;
    setError(null);
    try { setStores(null); setStores(await listStores(cityId, loc, catId || null)); } catch (e) { setError((e as Error).message); }
  };
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [cityId, cfg?.stores_enabled, locDone, loc?.lat, loc?.lng, catId]);

  // search: wait a moment after typing stops
  useEffect(() => {
    const t = window.setTimeout(() => { if (text.trim() !== q) setParams(text.trim() ? { q: text.trim() } : catId ? { c: catId } : {}, { replace: true }); }, 350);
    return () => window.clearTimeout(t);
  }, [text, q, setParams]);
  useEffect(() => {
    if (!cityId || !cfg?.stores_enabled || !locDone || q.length < 2) { setHits(null); return; }
    let cancelled = false;
    setSearching(true);
    searchStoreProducts(cityId, loc, q, sort)
      .then((r) => !cancelled && setHits(r))
      .catch((e) => !cancelled && setError((e as Error).message))
      .finally(() => !cancelled && setSearching(false));
    return () => { cancelled = true; };
  }, [cityId, cfg?.stores_enabled, locDone, loc?.lat, loc?.lng, q, sort]);

  const hotelCart = useCart((s) => s.hotelCart);
  const addToCart = useCart((s) => s.addToCart);
  const forceClearHotelCartAndAdd = useCart((s) => s.forceClearHotelCartAndAdd);
  const [addingId, setAddingId] = useState<string | null>(null);
  const [conflict, setConflict] = useState<CartItem | null>(null);
  const [conflictShop, setConflictShop] = useState('');
  // "+ Add" in the search results: a plain product goes straight into the cart; sizes / customised products open on the shop page
  const addFromSearch = async (h: StoreProductHit) => {
    setAddingId(h.product_id);
    try {
      const menu = await getStoreMenu(h.store_id);
      const p = menu.products.find((x) => x.id === h.product_id);
      if (!p || !p.is_available) { toast('This product is not available right now'); return; }
      if (!menu.store.is_open) { toast(`${menu.store.name} is closed now`); return; }
      if (p.is_customizable || (p.variants ?? []).some((v) => v.is_available)) { navigate(`/stores/s/${h.store_id}?add=${h.product_id}`); return; }
      const moq = Math.max(1, p.min_order_qty ?? 1);
      const r = addToCart({ productId: p.id, vendorId: h.store_id, cityId, quantityDelta: moq, isHotel: true });
      if (r.kind === 'hotelConflict') { setConflictShop(h.store_name); setConflict(r.pendingItem); return; }
      toast(`${p.name} added`);
    } catch (e) { toast((e as Error).message || 'Could not add'); } finally { setAddingId(null); }
  };
  const cartItems = hotelCart;
  const selectCat = (id: string) => setParams(id ? { c: id } : {}, { replace: true });
  const shops = useMemo(
    () => (stores ?? []).slice().sort((a, b) => Number(b.is_open) - Number(a.is_open) || (a.distance_km ?? 999) - (b.distance_km ?? 999) || a.name.localeCompare(b.name)),
    [stores],
  );
  // rating and the free-delivery note of the shops on the page (the server decides; nothing is shown when there is none)
  useEffect(() => {
    if (!cityId || shops.length === 0) { setCardInfo({}); return; }
    let cancelled = false;
    void getStoreCardInfo(cityId, shops.map((x) => ({ store_id: x.store_id, distance_km: x.distance_km }))).then((m) => !cancelled && setCardInfo(m));
    return () => { cancelled = true; };
  }, [cityId, shops]);
  const activeCat = cfg?.categories.find((c) => c.id === catId);
  const searchingNow = q.length >= 2;

  return (
    <div className="page stores-page">
      <HomeBrandHeader onMenu={openMenu} />
      <HomeMenuSheet
        open={menuOpen}
        onClose={closeMenu}
        items={[
          { label: 'My price quotes', onClick: () => navigate('/quotes') },
          { label: 'Wallet', onClick: () => navigate('/wallet') },
          { label: 'Refer & Earn', onClick: () => navigate('/refer') },
          { label: 'Help & Support', onClick: () => navigate('/help') },
          { label: 'Chat on WhatsApp', onClick: openSupportWhatsApp },
        ]}
      />
      <HomeModeTabs foodSelected={false} helperOn={helperOn} onGrocery={() => undefined} onFood={() => navigate('/?mode=hotels')} onHelper={() => navigate('/helper')} />
      <HomePillSearch
        value={text}
        onChange={(v) => { setText(v); if (!v) setParams(catId ? { c: catId } : {}, { replace: true }); }}
        hint="Search products, stores or food"
        label="Search products in shops"
      />
      <div className="content-pad narrow stack">
        {!searchingNow && banners.length > 0 && <PromoCarousel banners={banners} onOpen={openBanner} />}

        <button className="list-card" onClick={() => navigate('/quotes')} style={{ padding: '10px 14px' }}>
          <span className="grow"><strong className="block">My price quotes</strong><span className="muted small">Ask a shop for a price on custom work</span></span>
          <ChevronRight size={20} className="muted" />
        </button>

        {cfg && cfg.categories.length > 0 && !searchingNow && <HomeSectionHeader title="Shop Categories" onAction={() => setAllCats(true)} />}
        {cfg && cfg.categories.length > 0 && !searchingNow && (
          <div className="cat-round-row" role="tablist" aria-label="Shop categories">
            <button role="tab" aria-selected={!catId} className={`cat-round${!catId ? ' active' : ''}`} onClick={() => selectCat('')}>
              <span className="cat-round-img"><LayoutGrid size={26} /></span>
              <span className="cat-round-name">All Categories</span>
            </button>
            {cfg.categories.map((c) => (
              <button key={c.id} role="tab" aria-selected={catId === c.id} className={`cat-round${catId === c.id ? ' active' : ''}`} onClick={() => selectCat(c.id)}>
                <span className="cat-round-img">{c.image_url ? <img src={c.image_url} alt="" loading="lazy" /> : <b>{c.name.charAt(0)}</b>}</span>
                <span className="cat-round-name">{c.name}</span>
              </button>
            ))}
            <button className="cat-round" onClick={() => setAllCats(true)}>
              <span className="cat-round-img"><MoreHorizontal size={26} /></span>
              <span className="cat-round-name">More</span>
            </button>
          </div>
        )}

        {allCats && cfg && (
          <div className="menu-sheet-backdrop" onClick={() => setAllCats(false)} role="presentation">
            <div className="menu-sheet all-cats" role="dialog" aria-label="All categories" onClick={(e) => e.stopPropagation()}>
              <h3 className="all-cats-title">All categories</h3>
              <div className="all-cats-grid">
                {cfg.categories.map((c) => (
                  <button key={c.id} className={`cat-round${catId === c.id ? ' active' : ''}`} onClick={() => { selectCat(c.id); setAllCats(false); }}>
                    <span className="cat-round-img">{c.image_url ? <img src={c.image_url} alt="" loading="lazy" /> : <b>{c.name.charAt(0)}</b>}</span>
                    <span className="cat-round-name">{c.name}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {locDone && !loc && (
          <button className="list-card" onClick={() => navigate('/addresses')}>
            <span className="icon-circle bg-sand text-primary"><MapPin size={20} /></span>
            <span className="grow"><strong className="block">Add your address</strong><span className="muted small">Then we show the shops nearest to you first.</span></span>
            <ChevronRight size={20} className="muted" />
          </button>
        )}

        {error && <ErrorCard message={error} onRetry={() => void load()} />}

        {searchingNow ? (
          <>
            <div className="sort-chips" role="tablist" aria-label="Sort results">
              {SORTS.map((s) => <button key={s.key} className={sort === s.key ? 'active' : ''} onClick={() => setSort(s.key)}>{s.label}</button>)}
            </div>
            {searching && !hits && <ListSkeleton count={4} height={72} />}
            {hits && hits.length === 0 && <EmptyState icon={<Search size={36} />} title="Nothing found" text={`No open shop near you has “${q}” right now.`} />}
            {hits && hits.map((h) => <StoreProductRow key={`${h.store_id}:${h.product_id}`} hit={h} busy={addingId === h.product_id} onAdd={() => void addFromSearch(h)} />)}
          </>
        ) : (
          <>
            {!catId && cfg?.replace_grocery && (
              <button className="store-card pinned" onClick={() => navigate('/?mode=grocery')}>
                <span className="store-card-logo"><StoreIcon size={26} /></span>
                <span className="grow"><strong className="block">SND Mart Store</strong><span className="muted small">Fresh groceries &amp; fruits from SND Mart</span></span>
                <ChevronRight size={20} className="muted" />
              </button>
            )}

            <h3 className="section-title">{activeCat ? activeCat.name : 'Recommended shops'}{shops.length > 0 ? <span className="muted small"> · {shops.length}</span> : null}</h3>
            {stores === null && !error && <ListSkeleton count={3} height={88} />}
            {stores && shops.length === 0 && (
              <EmptyState icon={<StoreIcon size={36} />} title="No shops here yet" text={`We show shops within ${cfg?.radius_km ?? 5} km of you. Please check again soon.`} />
            )}
            {shops.map((s) => <StoreCard key={s.store_id} s={s} info={cardInfo[s.store_id]} />)}
            {shops.length > 0 && <p className="stores-footnote"><Clock size={18} /> Open shops first{loc ? ' · nearest first' : ''} · within {cfg?.radius_km ?? 5} km</p>}
          </>
        )}
        {cartItems.length > 0 && <div style={{ height: 84 }} />}
      </div>
      {cartItems.length > 0 && (
        <div className="floating-cart-wrap">
          <button className="btn btn-primary btn-lg" style={{ width: '100%' }} onClick={() => navigate('/checkout/hotel')}>View cart · {cartCount(cartItems)} item{cartCount(cartItems) === 1 ? '' : 's'}</button>
        </div>
      )}
      <ConfirmDialog
        open={!!conflict}
        title="Replace your cart?"
        text={`Your cart already has the most shops you can order from at once (3). Clear it and add from ${conflictShop}?`}
        confirmLabel="Clear & Add"
        onCancel={() => setConflict(null)}
        onConfirm={() => { forceClearHotelCartAndAdd(conflict!); setConflict(null); toast('Cart cleared and item added'); }}
      />
    </div>
  );
}
