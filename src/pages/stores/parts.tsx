import { useNavigate } from 'react-router-dom';
import { ChevronRight, Store as StoreIcon } from 'lucide-react';
import { kmLabel, type StoreListItem, type StoreProductHit } from '../../lib/stores';

const rupee = (n: number) => `₹${Number.isInteger(n) ? n : n.toFixed(2)}`;

export function StoreCard({ s }: { s: StoreListItem }) {
  const navigate = useNavigate();
  return (
    <button className={`store-card${s.is_open ? '' : ' closed'}`} onClick={() => navigate(`/stores/s/${s.store_id}`)}>
      <span className="store-card-logo">{s.banner_url ? <img src={s.banner_url} alt="" loading="lazy" /> : <StoreIcon size={26} />}</span>
      <span className="grow">
        <strong className="block">{s.name}</strong>
        <span className="muted small block">{s.category_name}{s.distance_km != null ? ` · ${kmLabel(s.distance_km)}` : ''}</span>
        <span className="store-badges">
          {s.is_nearest && <span className="nearest-badge">Nearest</span>}
          <span className={s.is_open ? 'open-badge' : 'closed-badge'}>{s.is_open ? 'Open' : 'Closed'}</span>
        </span>
      </span>
      <ChevronRight size={20} className="muted" />
    </button>
  );
}

export function StoreProductRow({ hit }: { hit: StoreProductHit }) {
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
      </span>
    </button>
  );
}
