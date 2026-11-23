import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ChevronRight, MapPin, Search, Sparkles, Store as StoreIcon, X } from 'lucide-react';
import { useSession } from '../../store/session';
import { EmptyState, ErrorCard, ListSkeleton, PageHeader } from '../../components/ui';
import {
  getCustomerLocation, getStoresConfig, listStores, searchStoreProducts,
  type Loc, type StoreListItem, type StoreProductHit, type StoreSort, type StoresConfig,
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

  const selectCat = (id: string) => setParams(id ? { c: id } : {}, { replace: true });
  const shops = useMemo(
    () => (stores ?? []).slice().sort((a, b) => Number(b.is_open) - Number(a.is_open) || (a.distance_km ?? 999) - (b.distance_km ?? 999) || a.name.localeCompare(b.name)),
    [stores],
  );
  const activeCat = cfg?.categories.find((c) => c.id === catId);
  const searchingNow = q.length >= 2;

  return (
    <div className="page stores-page">
      <PageHeader title="Grocery" subtitle={city?.name} back={false} />
      <div className="content-pad narrow stack">
        <div className={`mode-toggle${helperOn ? ' three' : ''}`}>
          <button className="active">Grocery</button>
          <button onClick={() => navigate('/?mode=hotels')}>Hotel Food</button>
          {helperOn && <button onClick={() => navigate('/helper')}>Quick Helper</button>}
        </div>

        <div className="search-bar">
          <Search size={18} />
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Search products in all shops" aria-label="Search products in shops" />
          {text && <button className="icon-btn sm" aria-label="Clear search" onClick={() => { setText(''); setParams(catId ? { c: catId } : {}, { replace: true }); }}><X size={16} /></button>}
        </div>

        {cfg && cfg.categories.length > 0 && !searchingNow && (
          <div className="cat-round-row" role="tablist" aria-label="Shop categories">
            <button role="tab" aria-selected={!catId} className={`cat-round${!catId ? ' active' : ''}`} onClick={() => selectCat('')}>
              <span className="cat-round-img"><Sparkles size={26} /></span>
              <span className="cat-round-name">Recommended</span>
            </button>
            {cfg.categories.map((c) => (
              <button key={c.id} role="tab" aria-selected={catId === c.id} className={`cat-round${catId === c.id ? ' active' : ''}`} onClick={() => selectCat(c.id)}>
                <span className="cat-round-img">{c.image_url ? <img src={c.image_url} alt="" loading="lazy" /> : <b>{c.name.charAt(0)}</b>}</span>
                <span className="cat-round-name">{c.name}</span>
              </button>
            ))}
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
            {hits && hits.map((h) => <StoreProductRow key={`${h.store_id}:${h.product_id}`} hit={h} />)}
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
            {shops.map((s) => <StoreCard key={s.store_id} s={s} />)}
            {shops.length > 0 && <p className="muted small center">Open shops first{loc ? ' · nearest first' : ''} · within {cfg?.radius_km ?? 5} km.</p>}
          </>
        )}
      </div>
    </div>
  );
}
