import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Clock, FileText } from 'lucide-react';
import { ConfirmDialog, EmptyState, ErrorCard, ListSkeleton, PageHeader, Spinner, toast } from '../../components/ui';
import { answerQuote, cancelQuote, myQuotes, QUOTE_LABEL, type StoreQuote } from '../../lib/quotes';
import { useCart } from '../../store/cart';
import { useSession } from '../../store/session';
import type { CartItem } from '../../lib/types';

const rupee = (n: number) => `₹${Number.isInteger(n) ? n : n.toFixed(2)}`;
const CHIP: Record<string, string> = { requested: '#fef3c7|#92400e', quoted: '#dbeafe|#1d4ed8', accepted: '#dcfce7|#166534', used: '#e0e7ff|#4338ca' };

/** My price quotes: waiting, price received (accept / decline), accepted (add to the cart), and the past ones. */
export default function QuotesPage() {
  const navigate = useNavigate();
  const cityId = useSession((s) => s.selectedCity?.id ?? null);
  const addToCart = useCart((s) => s.addToCart);
  const forceClearHotelCartAndAdd = useCart((s) => s.forceClearHotelCartAndAdd);
  const [list, setList] = useState<StoreQuote[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [conflict, setConflict] = useState<CartItem | null>(null);

  const load = useCallback(async () => { setError(null); try { setList(await myQuotes()); } catch (e) { setError((e as Error).message); } }, []);
  useEffect(() => { void load(); const t = window.setInterval(() => void load(), 30_000); return () => window.clearInterval(t); }, [load]);

  const toCart = (q: StoreQuote) => {
    const r = addToCart({ productId: q.product_id, vendorId: q.vendor_id, cityId, quantityDelta: q.quantity, isHotel: true, variantId: q.variant_id, customNote: q.note, customPhotoPath: q.photo_path, quoteId: q.id, quotePrice: q.quoted_unit_price });
    if (r.kind === 'hotelConflict') { setConflict({ ...r.pendingItem, quantity: q.quantity, quote_id: q.id, quote_price: q.quoted_unit_price }); return false; }
    return true;
  };
  const run = async (q: StoreQuote, fn: () => Promise<void>, done?: () => void) => {
    setBusy(q.id);
    try { await fn(); done?.(); await load(); } catch (e) { toast((e as Error).message); } finally { setBusy(null); }
  };
  const left = (iso: string | null) => {
    if (!iso) return '';
    const m = Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 60000));
    return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m left` : `${m}m left`;
  };

  return (
    <div className="page stores-page">
      <PageHeader title="My price quotes" subtitle="Ask a shop for a price on custom work" />
      <div className="content-pad narrow stack">
        {error && <ErrorCard message={error} onRetry={() => void load()} />}
        {list === null && !error && <ListSkeleton count={3} height={110} />}
        {list && list.length === 0 && <EmptyState icon={<FileText size={36} />} title="No quotes yet" text="On a custom product, tap “Get a quote” and the shop will send you a price." />}
        {list?.map((q) => {
          const [bg, fg] = (CHIP[q.status] ?? '#e5e7eb|#4b5563').split('|');
          const total = q.quoted_unit_price != null ? q.quoted_unit_price * q.quantity : null;
          return (
            <div key={q.id} className="card pad stack">
              <div className="row between" style={{ alignItems: 'center' }}>
                <strong>{q.product_name}{q.variant_label ? ` - ${q.variant_label}` : ''} × {q.quantity}</strong>
                <span className="helper-chip" style={{ background: bg, color: fg }}>{QUOTE_LABEL[q.status]}</span>
              </div>
              <span className="muted small">{q.vendor_name}</span>
              {q.note && <span className="small">✏️ {q.note}</span>}
              {q.photo_path && <span className="muted small">📷 Photo sent</span>}
              {q.status === 'requested' && <span className="muted small"><Clock size={12} /> The shop will answer within {left(q.expires_at)}</span>}
              {q.status === 'quoted' && total != null && (
                <div className="fee-nudge" style={{ background: '#eff6ff', borderColor: '#93c5fd' }}>
                  <span className="fee-nudge-text" style={{ color: '#1d4ed8' }}>Price: {rupee(q.quoted_unit_price!)} per piece · total {rupee(total)}</span>
                  {q.vendor_note && <span className="fee-nudge-save">“{q.vendor_note}”</span>}
                  <span className="fee-nudge-save">{left(q.valid_until)} to accept</span>
                </div>
              )}
              {q.status === 'accepted' && total != null && <span className="small bold">Accepted: {rupee(total)} total. Add it to your cart and order before it expires ({left(q.valid_until)}).</span>}
              {q.status === 'declined' && q.vendor_note && <span className="muted small">“{q.vendor_note}”</span>}
              <div className="row gap-8" style={{ flexWrap: 'wrap' }}>
                {q.status === 'quoted' && (
                  <>
                    <button className="btn btn-primary" disabled={busy === q.id} onClick={() => void run(q, () => answerQuote(q.id, true), () => { if (toCart(q)) { toast('Added to your cart at the quoted price'); navigate('/cart', { state: { isHotel: true } }); } })}>{busy === q.id ? <Spinner size={16} /> : 'Accept & add to cart'}</button>
                    <button className="btn btn-outline" disabled={busy === q.id} onClick={() => void run(q, () => answerQuote(q.id, false))}>Decline</button>
                  </>
                )}
                {q.status === 'accepted' && (
                  <button className="btn btn-primary" onClick={() => { if (toCart(q)) { toast('Added to your cart'); navigate('/cart', { state: { isHotel: true } }); } }}>Add to cart</button>
                )}
                {['requested', 'quoted', 'accepted'].includes(q.status) && <button className="btn btn-outline" disabled={busy === q.id} onClick={() => void run(q, () => cancelQuote(q.id))}>Cancel</button>}
                {q.status === 'used' && q.order_id && <button className="btn btn-outline" onClick={() => navigate(`/orders/${q.order_id}`)}>View order</button>}
              </div>
            </div>
          );
        })}
      </div>
      <ConfirmDialog
        open={!!conflict}
        title="Replace your cart?"
        text="Your cart already has items from another shop or hotel. Clear it and add this quoted item?"
        confirmLabel="Clear & Add"
        onCancel={() => setConflict(null)}
        onConfirm={() => { forceClearHotelCartAndAdd(conflict!); setConflict(null); toast('Cart cleared and item added'); navigate('/cart', { state: { isHotel: true } }); }}
      />
    </div>
  );
}
