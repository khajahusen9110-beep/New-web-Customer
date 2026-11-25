import { useEffect, useState } from 'react';
import { BadgeCheck, Box, Clock, MapPin, Phone, Sparkles, Star, Store as StoreIcon, Tag, Bike } from 'lucide-react';
import { getStoreRatingSummary, MIN_REVIEWS_FOR_STARS, type StoreMenu, type StoreRatingSummary } from '../../lib/stores';

type Store = StoreMenu['store'];

/** Wide photo of the shop with the open / closed chip on it. */
export function StoreHero({ s }: { s: Store }) {
  return (
    <div className="store-hero" data-testid="store-hero">
      {s.banner_url ? <img src={s.banner_url} alt="" /> : <StoreIcon size={64} />}
      <span className="store-hero-shade" />
      <span className={`store-hero-chip ${s.is_open ? 'open' : 'closed'}`}>{s.is_open ? '● Open now' : 'Closed now'}</span>
    </div>
  );
}

/** Name, tick, category, stars and address as a card overlapping the photo, then the 3-fact strip. */
export function StoreInfo({ s }: { s: Store }) {
  const [r, setR] = useState<StoreRatingSummary | null>(null);
  useEffect(() => { let on = true; void getStoreRatingSummary(s.id).then((x) => on && setR(x)); return () => { on = false; }; }, [s.id]);
  const stars = r && r.review_count >= MIN_REVIEWS_FOR_STARS && r.avg_rating != null ? r : null;
  return (
    <>
      <div className="store-info-card">
        <div className="sic-name"><strong>{s.name}</strong><BadgeCheck size={22} className="sc2-verified" aria-label="Verified shop" /></div>
        {s.category_name && <div className="muted">{s.category_name}</div>}
        {stars ? <div className="sic-rate"><Star size={17} fill="currentColor" /> <b>{stars.avg_rating!.toFixed(1)}</b> <span>({stars.review_count} ratings)</span></div>
          : r ? <div className="sic-new"><Sparkles size={14} /> New on SND Mart</div> : null}
        {s.address && <div className="muted small"><MapPin size={14} /> {s.address}</div>}
      </div>
      <div className="store-strip">
        <div><Clock size={22} /><span>{s.is_open ? 'Open now' : 'Closed now'}</span><b>{s.is_open ? 'Taking orders' : 'Back soon'}</b></div>
        {s.prep_minutes != null && <div><Box size={22} /><span>Packs in</span><b>~{s.prep_minutes} min</b></div>}
        <div><Bike size={22} /><span>Delivery</span><b>Available</b></div>
      </div>
    </>
  );
}

/** Category tiles with the photo of one of their products; "Top Picks" first. */
export function StoreCatTiles({ menu, cat, onSelect }: { menu: StoreMenu; cat: string; onSelect: (id: string) => void }) {
  const photo = (id: string) => menu.products.find((p) => p.category_id === id && p.image_url)?.image_url ?? null;
  const tiles = [{ id: 'rec', name: 'Top Picks', url: menu.products.find((p) => p.image_url)?.image_url ?? null }, ...menu.categories.map((c) => ({ id: c.id, name: c.name, url: photo(c.id) }))];
  return (
    <div className="cat-tiles" role="tablist" aria-label="Product categories">
      {tiles.map((t) => (
        <button key={t.id} className={cat === t.id ? 'active' : ''} onClick={() => onSelect(t.id)}>
          <span className="ct-img">{t.url ? <img src={t.url} alt="" loading="lazy" /> : t.id === 'rec' ? <Star size={26} /> : <Tag size={26} />}</span>
          <span className="ct-name">{t.name}</span>
        </button>
      ))}
    </div>
  );
}

export function StoreCallPill({ phone }: { phone?: string | null }) {
  if (!phone) return null;
  return <a className="store-call" href={`tel:${phone}`} data-testid="store-call"><Phone size={18} /> Call</a>;
}
