import { useEffect, useRef, useState } from 'react';
import { Camera, X } from 'lucide-react';
import { Modal, QuantityStepper, Spinner, toast } from '../../components/ui';
import { customPhotoUrl, uploadCustomPhoto, type StoreMenu } from '../../lib/stores';

type P = StoreMenu['products'][number];
export interface CustomiseResult { note: string | null; photoPath: string | null; quantity: number }

const rupee = (n: number) => `₹${Number.isInteger(n) ? n : n.toFixed(2)}`;

/** Made-to-order product: the customer writes a message and/or adds a photo, then adds it to the cart. */
export function CustomiseSheet({ product, userId, initial, editing, onClose, onDone }: {
  product: P | null;
  userId: string | null;
  initial?: { note: string | null; photoPath: string | null; quantity: number };
  /** true when changing a line that is already in the cart (no quantity stepper) */
  editing?: boolean;
  onClose: () => void;
  onDone: (r: CustomiseResult) => void;
}) {
  const [note, setNote] = useState('');
  const [photoPath, setPhotoPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [qty, setQty] = useState(1);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!product) return;
    setNote(initial?.note ?? '');
    setPhotoPath(initial?.photoPath ?? null);
    setPreview(null);
    setQty(initial?.quantity ?? 1);
    if (initial?.photoPath) void customPhotoUrl(initial.photoPath).then(setPreview);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product?.id]);

  if (!product) return null;
  const askNote = product.custom_allow_note !== false;
  const askPhoto = product.custom_allow_photo === true;
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
    const n = note.trim();
    if (required && askNote && !n) { toast('Please write the message'); return; }
    if (required && askPhoto && !photoPath) { toast('Please add a photo'); return; }
    onDone({ note: askNote && n ? n : null, photoPath: askPhoto ? photoPath : null, quantity: qty });
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={product.name}
      footer={
        <button className="btn btn-primary btn-lg" disabled={busy} onClick={submit}>
          {busy ? <Spinner size={18} light /> : editing ? 'Save changes' : `Add to cart · ${rupee(product.price * qty)}`}
        </button>
      }
    >
      <div className="stack">
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
            <QuantityStepper quantity={qty} onIncrease={() => setQty((q) => q + 1)} onDecrease={() => setQty((q) => Math.max(1, q - 1))} />
          </div>
        )}
      </div>
    </Modal>
  );
}
