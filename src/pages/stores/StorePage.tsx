import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Clock, Plus, Store as StoreIcon } from 'lucide-react';
import { CenterSpinner, ConfirmDialog, EmptyState, ErrorCard, FloatingCartButton, PageHeader, QuantityStepper, toast } from '../../components/ui';
import { getStoreMenu, type StoreMenu } from '../../lib/stores';
import { rememberStoreVendor } from '../../lib/storeVendor';
import { cartCount, useCart } from '../../store/cart';
import { CustomiseSheet, type CustomiseResult } from './CustomiseSheet';
import { useSession } from '../../store/session';
import type { CartItem } from '../../lib/types';

const rupee = (n: number) => `₹${Number.isInteger(n) ? n : n.toFixed(2)}`;

/** One shop: its details, its products by category, and the cart (one shop at a time, like a hotel). */
export default function StorePage() {
  const { storeId = '' } = useParams();
  const navigate = useNavigate();
  const cityId = useSession((s) => s.selectedCity?.id ?? null);
  const hotelCart = useCart((s) => s.hotelCart);
  const addToCart = useCart((s) => s.addToCart);
  const forceClearHotelCartAndAdd = useCart((s) => s.forceClearHotelCartAndAdd);
  const [conflict, setConflict] = useState<CartItem | null>(null);
  const [menu, setMenu] = useState<StoreMenu | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cat, setCat] = useState<string>('all');
  const userId = useSession((s) => s.userId);
  const [customising, setCustomising] = useState<StoreMenu['products'][number] | null>(null);
  const setCustomization = useCart((s) => s.setCustomization);

  const load = async () => {
    setError(null);
    try { setMenu(await getStoreMenu(storeId)); } catch (e) { setError((e as Error).message); }
  };
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [storeId]);
  useEffect(() => { if (menu) rememberStoreVendor(storeId, true); }, [menu, storeId]);

  const shown = useMemo(() => (menu?.products ?? []).filter((p) => cat === 'all' || p.category_id === cat), [menu, cat]);

  if (error) return <div className="page"><PageHeader title="Shop" /><div className="content-pad narrow"><ErrorCard message={error} onRetry={() => void load()} /></div></div>;
  if (!menu) return <div className="page"><PageHeader title="Shop" /><CenterSpinner /></div>;
  const s = menu.store;
  const thisItems = hotelCart.filter((i) => i.vendor_id === storeId);
  const lineUnit = (i: CartItem) => {
    const p = menu.products.find((x) => x.id === i.product_id);
    return p?.variants?.find((v) => v.id === i.variant_id)?.price ?? p?.price ?? 0;
  };
  const thisTotal = thisItems.reduce((sum, i) => sum + lineUnit(i) * i.quantity, 0);
  const qtyOf = (id: string) => thisItems.filter((i) => i.product_id === id).reduce((n, i) => n + i.quantity, 0);
  const add = (productId: string, delta: number) => {
    const r = addToCart({ productId, vendorId: storeId, cityId, quantityDelta: delta, isHotel: true });
    if (r.kind === 'hotelConflict') setConflict(r.pendingItem);
  };
  const addCustom = (r: CustomiseResult) => {
    if (!customising) return;
    const hasVariants = (customising.variants ?? []).some((v) => v.is_available);
    const inCart = !hasVariants && qtyOf(customising.id) > 0;
    if (inCart) {
      // editing a line already in the cart: only the message / photo change, the quantity stays
      setCustomization(customising.id, null, r.note, r.photoPath);
    } else {
      const res = addToCart({ productId: customising.id, vendorId: storeId, cityId, quantityDelta: r.quantity, isHotel: true, variantId: r.variantId, customNote: r.note, customPhotoPath: r.photoPath });
      if (res.kind === 'hotelConflict') { setConflict({ ...res.pendingItem, quantity: r.quantity, variant_id: r.variantId, custom_note: r.note, custom_photo_path: r.photoPath }); }
    }
    setCustomising(null);
  };
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
              {(p.variants ?? []).some((v) => v.is_available) ? `from ${rupee(Math.min(...(p.variants ?? []).filter((v) => v.is_available).map((v) => v.price)))}` : rupee(p.price)}
              {p.mrp != null && p.mrp > p.price && <s className="muted small block">{rupee(p.mrp)}</s>}
              {p.is_available && s.is_open && (
                p.is_customizable || (p.variants ?? []).some((v) => v.is_available) ? (
                  <button className="store-add-btn" onClick={() => setCustomising(p)} aria-label={`Choose ${p.name}`}>
                    {qtyOf(p.id) > 0 ? `${qtyOf(p.id)} in cart · ${(p.variants ?? []).length ? 'Add' : 'Edit'}` : (p.variants ?? []).length ? 'Choose' : 'Customise'}
                  </button>
                ) : qtyOf(p.id) > 0 ? (
                  <QuantityStepper quantity={qtyOf(p.id)} onIncrease={() => add(p.id, 1)} onDecrease={() => add(p.id, -1)} />
                ) : (
                  <button className="store-add-btn" onClick={() => add(p.id, 1)} aria-label={`Add ${p.name}`}><Plus size={14} /> Add</button>
                )
              )}
            </span>
          </div>
        ))}
        {thisItems.length > 0 && <div style={{ height: 84 }} />}
      </div>

      <div className="floating-cart-wrap">
        <FloatingCartButton itemCount={cartCount(thisItems)} total={thisTotal} onClick={() => navigate('/checkout/hotel')} />
      </div>

      <CustomiseSheet
        product={customising}
        userId={userId}
        initial={customising && !(customising.variants ?? []).some((v) => v.is_available) ? (() => { const it = thisItems.find((i) => i.product_id === customising.id); return it ? { note: it.custom_note ?? null, photoPath: it.custom_photo_path ?? null, quantity: it.quantity } : undefined; })() : undefined}
        editing={!!customising && !(customising.variants ?? []).some((v) => v.is_available) && qtyOf(customising.id) > 0}
        onClose={() => setCustomising(null)}
        onDone={addCustom}
      />

      <ConfirmDialog
        open={!!conflict}
        title="Replace your cart?"
        text={`Your cart already has items from another shop or hotel. Clear it and add from ${s.name}?`}
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
