import { useCallback, useEffect, useState } from 'react';
import { Bike, RefreshCw, Star, Store } from 'lucide-react';
import { EmptyState, ErrorCard, ListSkeleton, PageHeader } from '../components/ui';
import { getMyDeliveryPartnerReviews, getMyVendorReviews } from '../lib/repository';
import { errorMessage, shortDateTime } from '../lib/utils';
import { useSession } from '../store/session';

interface ReviewRow {
  type: 'vendor' | 'partner';
  rating: number;
  comment?: string | null;
  orderId?: string | null;
  createdAt?: string | null;
}

export default function MyReviewsPage() {
  const userId = useSession((s) => s.userId);
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    setError(null);
    const [v, d] = await Promise.allSettled([getMyVendorReviews(userId), getMyDeliveryPartnerReviews(userId)]);
    const out: ReviewRow[] = [];
    if (v.status === 'fulfilled')
      v.value.forEach((r) => out.push({ type: 'vendor', rating: r.rating, comment: r.comment, orderId: r.order_id, createdAt: r.created_at }));
    if (d.status === 'fulfilled')
      d.value.forEach((r) => out.push({ type: 'partner', rating: r.rating, comment: r.comment, orderId: r.order_id, createdAt: r.created_at }));
    out.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
    setRows(out);
    const failed = [v, d].find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
    setError(failed ? errorMessage(failed.reason) : null);
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="page">
      <PageHeader
        title="My Reviews"
        actions={
          <button className="icon-btn" aria-label="Refresh" onClick={() => void load()}>
            <RefreshCw size={20} />
          </button>
        }
      />
      <div className="content-pad narrow">
        {loading && rows.length === 0 ? (
          <ListSkeleton count={3} />
        ) : error && rows.length === 0 ? (
          <ErrorCard message={error} onRetry={() => void load()} />
        ) : rows.length === 0 ? (
          <EmptyState icon={<Star size={56} />} title="No reviews yet" text="Reviews you submit after an order will appear here." />
        ) : (
          <div className="stack-sm">
            {rows.map((r, i) => (
              <div key={`${r.type}-${r.orderId}-${r.createdAt}-${i}`} className="card pad">
                <div className="row between">
                  <span className="chip">
                    {r.type === 'vendor' ? <Store size={14} /> : <Bike size={14} />}
                    {r.type === 'vendor' ? 'Hotel / Vendor' : 'Delivery Partner'}
                  </span>
                  <span className="row text-warning">
                    {[1, 2, 3, 4, 5].map((s) => (
                      <Star key={s} size={18} fill={s <= r.rating ? 'currentColor' : 'none'} />
                    ))}
                  </span>
                </div>
                <p className={r.comment ? '' : 'muted small'}>{r.comment || 'No written comment.'}</p>
                <span className="muted small">
                  {shortDateTime(r.createdAt)}
                  {r.orderId ? ` • Order #${r.orderId.slice(0, 8)}` : ''}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
