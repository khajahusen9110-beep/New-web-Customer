import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Clock, MapPin, Plus, Search, Sparkles, Store as StoreIcon, X } from 'lucide-react';
import { CenterSpinner, ConfirmDialog, Modal, EmptyState, ErrorCard, FloatingCartButton, PageHeader, QuantityStepper, toast } from '../../components/ui';
import { getStoreMenu, type StoreMenu } from '../../lib/stores';
import { requestQuote } from '../../lib/quotes';
import { uploadCustomPhoto } from '../../lib/stores';
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
  const [qs, setQs] = useSearchParams();
  const cityId = useSession((s) => s.selectedCity?.id ?? null);
  const hotelCart = useCart((s) => s.hotelCart);
  const addToCart = useCart((s) => s.addToCart);
  const forceClearHotelCartAndAdd = useCart((s) => s.forceClearHotelCartAndAdd);
  const [conflict, setConflict] = useState<CartItem | null>(null);
  const [menu, setMenu] = useState<StoreMenu | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cat, setCat] = useState<string>('rec');
  const [find, setFind] = useState('');
  const userId = useSession((s) => s.userId);
  const [customising, setCustomising] = useState<StoreMenu['products'][number] | null>(null);
  const setCustomization = useCart((s) => s.setCustomization);
  const [quoting, setQuoting] = useState<StoreMenu['products'][number] | null>(null);

  const load = async () => {
    setError(null);
    try { setMenu(await getStoreMenu(storeId)); } catch (e) { setError((e as Error).message); }
  };
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [storeId]);
  useEffect(() => { if (menu) rememberStoreVendor(storeId, true); }, [menu, storeId]);
  // arriving from "+ Add" in the search: open the size / customise sheet of that product
  useEffect(() => {
    const want = qs.get('add');
    if (!menu || !want) return;
    const p = menu.products.find((x) => x.id === want);
    if (p && p.is_available && menu.store.is_open) setCustomising(p);
    setQs({}, { replace: true });
  }, [menu, qs, setQs]);

  // "Recommended" = the shop's best picks: products on offer first, then the rest in the shop's own order
  const shown = useMemo(() => {
    const all = menu?.products ?? [];
    const f = find.trim().toLowerCase();
    if (f) return all.filter((p) => p.name.toLowerCase().includes(f));
    if (cat === 'rec') {
      const off = (p: (typeof all)[number]) => (p.mrp != null && p.mrp > p.price ? 1 : 0);
      return all.filter((p) => p.is_available).map((p, i) => ({ p, i })).sort((a, b) => off(b.p) - off(a.p) || a.i - b.i).slice(0, 12).map((x) => x.p);
    }
    return all.filter((p) => p.category_id === cat);
  }, [menu, cat, find]);

  if (error) return <div className="page"><PageHeader title="Shop" /><div className="content-pad narrow"><ErrorCard message={error} onRetry={() => void load()} /></div></div>;
  if (!menu) return <div className="page"><PageHeader title="Shop" /><CenterSpinner /></div>;
  const s = menu.store;
  const thisItems = hotelCart.filter((i) => i.vendor_id === storeId);
  const lineUnit = (i: CartItem) => {
    const p = menu.products.find((x) => x.id === i.product_id);
    const extra = i.custom_note || i.custom_photo_path ? Number(p?.custom_extra_charge ?? 0) : 0;
    return (p?.variants?.find((v) => v.id === i.variant_id)?.price ?? p?.price ?? 0) + extra;
  };
  const thisTotal = thisItems.reduce((sum, i) => sum + lineUnit(i) * i.quantity, 0);
  const qtyOf = (id: string) => thisItems.filter((i) => i.product_id === id).reduce((n, i) => n + i.quantity, 0);
  const add = (productId: string, delta: number) => {
    // a shop's minimum order: the first add brings the minimum, and going below it removes the line
    const moq = Math.max(1, menu.products.find((x) => x.id === productId)?.min_order_qty ?? 1);
    const cur = qtyOf(productId);
    let d = delta;
    if (delta > 0 && cur === 0) d = moq;
    if (delta < 0 && cur > 0 && cur - 1 < moq) d = -cur;
    const r = addToCart({ productId, vendorId: storeId, cityId, quantityDelta: d, isHotel: true });
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
          {s.address && <span className="muted small block"><MapPin size={13} /> {s.address}</span>}
        </div>

        <div className="search-bar">
          <Search size={18} />
          <input value={find} onChange={(e) => setFind(e.target.value)} placeholder={`Search in ${s.name}`} aria-label="Search in this shop" />
          {find && <button className="icon-btn sm" aria-label="Clear search" onClick={() => setFind('')}><X size={16} /></button>}
        </div>

        {!find && (
          <div className="store-cats-sticky">
            <div className="sort-chips" role="tablist" aria-label="Product categories">
              <button className={cat === 'rec' ? 'active' : ''} onClick={() => setCat('rec')}><Sparkles size={13} /> Recommended</button>
              {menu.categories.map((c) => <button key={c.id} className={cat === c.id ? 'active' : ''} onClick={() => setCat(c.id)}>{c.name}</button>)}
            </div>
          </div>
        )}

        {shown.length === 0 && <EmptyState icon={<StoreIcon size={36} />} title="No products yet" text="This shop has not added products here." />}
        {shown.map((p) => (
          <div key={p.id} className={`store-product-row static${p.is_available ? '' : ' out'}`}>
            <span className="store-product-img">{p.image_url ? <img src={p.image_url} alt="" loading="lazy" /> : <StoreIcon size={22} />}</span>
            <span className="grow">
              <strong className="block">{p.name}</strong>
              <span className="muted small block">{p.unit ?? ''}{p.unit && p.unit_price != null ? ' · ' : ''}{p.unit_price != null ? `${rupee(p.unit_price)}/${p.unit_label}` : ''}</span>
              {(p.min_order_qty ?? 1) > 1 && <span className="muted small block">Minimum order {p.min_order_qty}</span>}
              {!p.is_available && <span className="closed-badge">Out of stock</span>}
            </span>
            <span className="store-product-price">
              {(p.variants ?? []).some((v) => v.is_available) ? `from ${rupee(Math.min(...(p.variants ?? []).filter((v) => v.is_available).map((v) => v.price)))}` : rupee(p.price)}
              {p.mrp != null && p.mrp > p.price && !(p.variants ?? []).some((v) => v.is_available) && (
                <>
                  <s className="muted small block">{rupee(p.mrp)}</s>
                  <span className="open-badge">{Math.round(((p.mrp - p.price) * 100) / p.mrp)}% OFF</span>
                </>
              )}
              {p.is_available && s.is_open && p.needs_quote && (
                <button className="store-add-btn" onClick={() => setQuoting(p)} aria-label={`Get a quote for ${p.name}`}>Get a quote</button>
              )}
              {p.is_available && s.is_open && !p.needs_quote && (
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

      {quoting && (
        <QuoteSheet
          product={quoting}
          storeId={storeId}
          userId={userId}
          onClose={() => setQuoting(null)}
          onSent={() => { setQuoting(null); toast('Request sent. The shop will send you a price.'); navigate('/quotes'); }}
        />
      )}

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

/** Ask the shop for a price: how many, what you want (message), and an optional photo. No payment now. */
function QuoteSheet({ product, storeId, userId, onClose, onSent }: { product: StoreMenu['products'][number]; storeId: string; userId: string | null; onClose: () => void; onSent: () => void }) {
  const variants = (product.variants ?? []).filter((v) => v.is_available);
  const [variantId, setVariantId] = useState<string | null>(variants[0]?.id ?? null);
  const [qty, setQty] = useState(Math.max(1, product.min_order_qty ?? 1));
  const [note, setNote] = useState('');
  const [photo, setPhoto] = useState<{ path: string; preview: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const pick = async (f?: File) => {
    if (!f || !userId) return;
    setBusy(true);
    try { setPhoto({ path: await uploadCustomPhoto(userId, f), preview: URL.createObjectURL(f) }); } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  };
  const send = async () => {
    if (!note.trim() && !photo) { toast('Describe what you need, or add a photo'); return; }
    setBusy(true);
    try { await requestQuote({ vendorId: storeId, productId: product.id, variantId, quantity: qty, note: note.trim() || null, photoPath: photo?.path ?? null }); onSent(); }
    catch (e) { toast((e as Error).message); setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={`Get a quote: ${product.name}`}>
      <div className="stack">
        {variants.length > 0 && (
          <div className="row gap-8" style={{ flexWrap: 'wrap' }}>
            {variants.map((v) => <button key={v.id} className={`btn ${variantId === v.id ? 'btn-primary' : 'btn-outline'}`} onClick={() => setVariantId(v.id)}>{v.label}</button>)}
          </div>
        )}
        <label className="small bold">How many
          <input className="input" type="number" min={Math.max(1, product.min_order_qty ?? 1)} value={qty} onChange={(e) => setQty(Math.max(1, Number(e.target.value) || 1))} /></label>
        <label className="small bold">What do you need?
          <textarea className="input" rows={4} maxLength={600} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Size, colour, message, date... anything the shop should know" /></label>
        {photo ? <img src={photo.preview} alt="Reference" style={{ width: 96, height: 96, objectFit: 'cover', borderRadius: 12 }} /> : (
          <label className="btn btn-outline" style={{ cursor: 'pointer' }}>{busy ? 'Uploading...' : 'Add a photo (optional)'}
            <input type="file" accept="image/*" hidden onChange={(e) => void pick(e.target.files?.[0])} /></label>
        )}
        <p className="muted small">No payment now. The shop sends you a price; you accept it and order. The price is valid for the time the shop sets.</p>
        <button className="btn btn-primary btn-lg" disabled={busy} onClick={() => void send()}>{busy ? 'Please wait...' : 'Send request'}</button>
      </div>
    </Modal>
  );
}
