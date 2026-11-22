import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Clock, Store as StoreIcon } from 'lucide-react';
import { CenterSpinner, EmptyState, ErrorCard, PageHeader } from '../../components/ui';
import { getStoreMenu, type StoreMenu } from '../../lib/stores';

const rupee = (n: number) => `₹${Number.isInteger(n) ? n : n.toFixed(2)}`;

/** One shop: its details and its products by category. (Adding to a cart comes with the store checkout.) */
export default function StorePage() {
  const { storeId = '' } = useParams();
  const [menu, setMenu] = useState<StoreMenu | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cat, setCat] = useState<string>('all');

  const load = async () => {
    setError(null);
    try { setMenu(await getStoreMenu(storeId)); } catch (e) { setError((e as Error).message); }
  };
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [storeId]);

  const shown = useMemo(() => (menu?.products ?? []).filter((p) => cat === 'all' || p.category_id === cat), [menu, cat]);

  if (error) return <div className="page"><PageHeader title="Shop" /><div className="content-pad narrow"><ErrorCard message={error} onRetry={() => void load()} /></div></div>;
  if (!menu) return <div className="page"><PageHeader title="Shop" /><CenterSpinner /></div>;
  const s = menu.store;
  return (
    <div className="page stores-page">
      <PageHeader title={s.name} subtitle={s.category_name ?? undefined} />
      <div className="content-pad narrow stack">
        {s.banner_url && <img className="store-banner" src={s.banner_url} alt="" />}
        <div className="store-meta">
          <span className={s.is_open ? 'open-badge' : 'closed-badge'}>{s.is_open ? 'Open now' : 'Closed now'}</span>
          {s.prep_minutes != null && <span className="muted small"><Clock size={13} /> packs in about {s.prep_minutes} min</span>}
          {s.address && <span className="muted small block">{s.address}</span>}
        </div>

        {menu.categories.length > 0 && (
          <div className="sort-chips" role="tablist" aria-label="Product categories">
            <button className={cat === 'all' ? 'active' : ''} onClick={() => setCat('all')}>All</button>
            {menu.categories.map((c) => <button key={c.id} className={cat === c.id ? 'active' : ''} onClick={() => setCat(c.id)}>{c.name}</button>)}
          </div>
        )}

        {shown.length === 0 && <EmptyState icon={<StoreIcon size={36} />} title="No products yet" text="This shop has not added products here." />}
        {shown.map((p) => (
          <div key={p.id} className={`store-product-row static${p.is_available ? '' : ' out'}`}>
            <span className="store-product-img">{p.image_url ? <img src={p.image_url} alt="" loading="lazy" /> : <StoreIcon size={22} />}</span>
            <span className="grow">
              <strong className="block">{p.name}</strong>
              <span className="muted small block">{p.unit ?? ''}{p.unit && p.unit_price != null ? ' · ' : ''}{p.unit_price != null ? `${rupee(p.unit_price)}/${p.unit_label}` : ''}</span>
              {!p.is_available && <span className="closed-badge">Out of stock</span>}
            </span>
            <span className="store-product-price">
              {rupee(p.price)}
              {p.mrp != null && p.mrp > p.price && <s className="muted small block">{rupee(p.mrp)}</s>}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
