import { useNavigate } from 'react-router-dom';
import { BadgeCheck, Bike, ChevronRight, MapPin, Plus, Star, Store as StoreIcon } from 'lucide-react';
import { kmLabel, MIN_REVIEWS_FOR_STARS, type StoreCardInfo, type StoreListItem, type StoreProductHit } from '../../lib/stores';

const rupee = (n: number) => `₹${Number.isInteger(n) ? n : n.toFixed(2)}`;

export function StoreCard({ s, info }: { s: StoreListItem; info?: StoreCardInfo }) {
  const navigate = useNavigate();
  const open = () => navigate(`/stores/s/${s.store_id}`);
  const hasRating = info?.avg_rating != null && info.review_count >= MIN_REVIEWS_FOR_STARS;
  const isNew = !!info && !hasRating;
  const free = info?.free_delivery === true;
  const nearby = !s.is_nearest && s.distance_km != null && s.distance_km <= 2;
  return (
    <div className={`store-card2${s.is_open ? '' : ' closed'}`} role="link" tabIndex={0} onClick={open} onKeyDown={(e) => e.key === 'Enter' && open()} data-testid="store-card">
      <span className="sc2-photo">{s.banner_url ? <img src={s.banner_url} alt="" loading="lazy" /> : <StoreIcon size={34} />}</span>
      <span className="sc2-body">
        <span className="sc2-name"><strong>{s.name}</strong><BadgeCheck size={20} className="sc2-verified" aria-label="Verified shop" /></span>
        <span className="sc2-sub">{s.category_name}{s.distance_km != null ? ` · ${kmLabel(s.distance_km)}` : ''}</span>
        {(hasRating || isNew || free) && (
          <span className="sc2-meta">
            {hasRating && <span className="sc2-rating"><Star size={15} fill="currentColor" /> <b>{info!.avg_rating!.toFixed(1)}</b> <span>({info!.review_count})</span></span>}
            {isNew && <span className="sc2-new">✨ New</span>}
            {(hasRating || isNew) && free && <span className="sc2-sep" />}
            {free && <span className="sc2-free"><Bike size={15} /> Free Delivery{info!.free_over ? ` ₹${Math.trunc(info!.free_over)}+` : ''}</span>}
          </span>
        )}
        <span className="sc2-foot">
          <span className="store-badges">
            {s.is_nearest && <span className="nearest-badge"><MapPin size={12} /> Nearest</span>}
            {nearby && <span className="nearby-badge"><MapPin size={12} /> Nearby</span>}
            <span className={s.is_open ? 'open-badge' : 'closed-badge'}>{s.is_open ? '● Open' : 'Closed'}</span>
          </span>
          <span className="sc2-view">View Store <ChevronRight size={16} /></span>
        </span>
      </span>
    </div>
  );
}

export function StoreProductRow({ hit, onAdd, busy }: { hit: StoreProductHit; onAdd?: () => void; busy?: boolean }) {
  const navigate = useNavigate();
  return (
    <button className="store-product-row" onClick={() => navigate(`/stores/s/${hit.store_id}`)}>
      <span className="store-product-img">{hit.image_url ? <img src={hit.image_url} alt="" loading="lazy" /> : <StoreIcon size={22} />}</span>
      <span className="grow">
        <strong className="block">{hit.name}</strong>
        <span className="muted small block">{hit.unit ?? ''}{hit.unit && hit.unit_price != null ? ' · ' : ''}{hit.unit_price != null ? `${rupee(hit.unit_price)}/${hit.unit_label}` : ''}</span>
        <span className="muted small block">{hit.store_name}{hit.distance_km != null ? ` · ${kmLabel(hit.distance_km)}` : ''}</span>
      </span>
      <span className="store-product-price">
        {rupee(hit.price)}
        {hit.mrp != null && hit.mrp > hit.price && <s className="muted small block">{rupee(hit.mrp)}</s>}
        {onAdd && (
          <span role="button" tabIndex={0} className="store-add-btn" aria-label={`Add ${hit.name}`}
            onClick={(e) => { e.stopPropagation(); if (!busy) onAdd(); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); if (!busy) onAdd(); } }}>
            <Plus size={14} /> {busy ? '...' : 'Add'}
          </span>
        )}
      </span>
    </button>
  );
}
