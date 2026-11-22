import { useEffect, useRef, useState } from 'react';
import { Camera, X } from 'lucide-react';
import { Modal, QuantityStepper, Spinner, toast } from '../../components/ui';
import { customPhotoUrl, uploadCustomPhoto, type StoreMenu } from '../../lib/stores';

type P = StoreMenu['products'][number];
export interface CustomiseResult { variantId: string | null; note: string | null; photoPath: string | null; quantity: number }

const rupee = (n: number) => `₹${Number.isInteger(n) ? n : n.toFixed(2)}`;

/** Made-to-order product: the customer writes a message and/or adds a photo, then adds it to the cart. */
export function CustomiseSheet({ product, userId, initial, editing, onClose, onDone }: {
  product: P | null;
  userId: string | null;
  initial?: { variantId?: string | null; note: string | null; photoPath: string | null; quantity: number };
  /** true when changing a line that is already in the cart (no quantity stepper) */
  editing?: boolean;
  onClose: () => void;
  onDone: (r: CustomiseResult) => void;
}) {
  const [note, setNote] = useState('');
  const [photoPath, setPhotoPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [qty, setQty] = useState(1);
  const [variantId, setVariantId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!product) return;
    setNote(initial?.note ?? '');
    setPhotoPath(initial?.photoPath ?? null);
    setPreview(null);
    setQty(Math.max(initial?.quantity ?? 1, product.min_order_qty ?? 1));
    const vs = (product.variants ?? []).filter((v) => v.is_available);
    setVariantId(initial?.variantId ?? (vs.length === 1 ? vs[0].id : null));
    if (initial?.photoPath) void customPhotoUrl(initial.photoPath).then(setPreview);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product?.id]);

  if (!product) return null;
  const variants = (product.variants ?? []).filter((v) => v.is_available);
  const custom = product.is_customizable === true;
  const askNote = custom && product.custom_allow_note !== false;
  const askPhoto = custom && product.custom_allow_photo === true;
  const moq = Math.max(1, product.min_order_qty ?? 1);
  const extra = Number(product.custom_extra_charge ?? 0);
  // customising (a message or a photo) costs the shop's extra charge on top, per piece
  const customised = (askNote && note.trim().length > 0) || (askPhoto && !!photoPath);
  const unitPrice = (variants.find((v) => v.id === variantId)?.price ?? product.price) + (customised ? extra : 0);
  const required = product.custom_required === true;
  const lead = product.custom_lead_hours ?? 0;

  const pick = async (f: File | undefined) => {
    if (!f) return;
    if (!userId) { toast('Please log in first'); return; }
    setBusy(true);
    try {
      const path = await uploadCustomPhoto(userId, f);
      setPhotoPath(path);
      setPreview(URL.createObjectURL(f));
    } catch (e) {
      toast((e as Error).message || 'Photo upload failed');
    } finally {
      setBusy(false);
    }
  };

  const submit = () => {
    if (variants.length > 0 && !variantId) { toast('Please choose an option'); return; }
    const n = note.trim();
    if (required && askNote && !n) { toast('Please write the message'); return; }
    if (required && askPhoto && !photoPath) { toast('Please add a photo'); return; }
    onDone({ variantId, note: askNote && n ? n : null, photoPath: askPhoto ? photoPath : null, quantity: qty });
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={product.name}
      footer={
        <button className="btn btn-primary btn-lg" disabled={busy} onClick={submit}>
          {busy ? <Spinner size={18} light /> : editing ? 'Save changes' : `Add to cart · ${rupee(unitPrice * qty)}`}
        </button>
      }
    >
      <div className="stack">
        {variants.length > 0 && (
          <div>
            <strong className="block">Choose an option *</strong>
            <div className="row gap-8" style={{ flexWrap: 'wrap', marginTop: 6 }}>
              {variants.map((v) => (
                <button key={v.id} type="button" className={`chip ${variantId === v.id ? 'chip-on' : ''}`} onClick={() => setVariantId(v.id)}>
                  {v.label} · {rupee(v.price)}
                </button>
              ))}
            </div>
          </div>
        )}
        {moq > 1 && !editing && <p className="muted small">Minimum order: {moq}</p>}
        {extra > 0 && custom && <p className="muted small">Customising costs ₹{extra} extra per piece{customised ? ' (added)' : ''}. · ಕಸ್ಟಮೈಸ್ ಮಾಡಲು ಪ್ರತಿ ಒಂದಕ್ಕೆ ₹{extra} ಹೆಚ್ಚು.</p>}
        {lead > 0 && <p className="muted small">Made to order · needs {lead} hour{lead > 1 ? 's' : ''} notice, so choose a Scheduled time at checkout. · ಆರ್ಡರ್‌ಗೆ ತಯಾರಿಸಲಾಗುತ್ತದೆ, {lead} ಗಂಟೆ ಮುಂಚಿತವಾಗಿ ತಿಳಿಸಿ.</p>}
        {askNote && (
          <label className="block">
            <strong className="block">{product.custom_note_label || 'Message / name to write'}{required ? ' *' : ''}</strong>
            <textarea className="input" rows={3} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Happy Birthday Rahul" />
            <span className="muted small">{note.length}/300</span>
          </label>
        )}
        {askPhoto && (
          <div>
            <strong className="block">Photo{required ? ' *' : ''}</strong>
            <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => void pick(e.target.files?.[0])} />
            {preview ? (
              <div className="row gap-8">
                <img src={preview} alt="Your photo" style={{ width: 96, height: 96, objectFit: 'cover', borderRadius: 12 }} />
                <button className="btn btn-outline" onClick={() => { setPhotoPath(null); setPreview(null); }}><X size={14} /> Remove</button>
              </div>
            ) : (
              <button className="btn btn-outline" disabled={busy} onClick={() => fileRef.current?.click()}>
                {busy ? <Spinner size={16} /> : <Camera size={16} />} Add photo
              </button>
            )}
            <p className="muted small">Only you and the shop can see this photo.</p>
          </div>
        )}
        {!editing && (
          <div className="row between">
            <strong>Quantity</strong>
            <QuantityStepper quantity={qty} onIncrease={() => setQty((q) => q + 1)} onDecrease={() => setQty((q) => Math.max(moq, q - 1))} />
          </div>
        )}
      </div>
    </Modal>
  );
}
