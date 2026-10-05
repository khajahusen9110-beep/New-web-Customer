import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronRight, RefreshCw, ShoppingBag, Store } from 'lucide-react';
import { EmptyState, ErrorCard, ListSkeleton, PageHeader, Spinner } from '../components/ui';
import { getOrders, getVendorNames, isAwaitingUpiPayment } from '../lib/repository';
import type { Order } from '../lib/types';
import { capitalize, errorMessage, rupees, shortDateTime } from '../lib/utils';
import { useSession } from '../store/session';

const PAGE = 20;

const STATUS_STYLES: Record<string, { cls: string; text: string }> = {
  pending: { cls: 'st-peach', text: 'Pending' },
  confirmed: { cls: 'st-sage', text: 'Confirmed' },
  preparing: { cls: 'st-peach', text: 'Preparing' },
  ready: { cls: 'st-mint', text: 'Ready' },
  out_for_delivery: { cls: 'st-sky', text: 'Out for Delivery' },
  delivered: { cls: 'st-sage', text: 'Delivered' },
  cancelled: { cls: 'st-coral', text: 'Cancelled' },
  rejected: { cls: 'st-coral', text: 'Rejected' },
};

export function OrderStatusBadge({ status }: { status: string }) {
  const s = STATUS_STYLES[status.toLowerCase()] ?? { cls: 'st-sand', text: capitalize(status) };
  return <span className={`status-badge ${s.cls}`}>{s.text}</span>;
}

export default function OrdersPage() {
  const navigate = useNavigate();
  const userId = useSession((s) => s.userId);
  const [orders, setOrders] = useState<Order[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (reset: boolean) => {
      if (!userId) return;
      if (reset) {
        setLoading(true);
        setError(null);
      } else setLoadingMore(true);
      try {
        const list = await getOrders(userId, PAGE, reset ? 0 : orders.length);
        setOrders((cur) => (reset ? list : [...cur, ...list]));
        setHasMore(list.length >= PAGE);
        const vendorIds = Array.from(new Set(list.map((o) => o.vendor_id).filter((x): x is string => !!x)));
        if (vendorIds.length) {
          const resolved = await getVendorNames(vendorIds);
          setNames((cur) => ({ ...cur, ...resolved }));
        }
      } catch (e) {
        if (reset) setError(errorMessage(e, 'Failed to fetch orders'));
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [userId, orders.length],
  );

  useEffect(() => {
    void load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  return (
    <div className="page">
      <PageHeader
        title="My Orders"
        back={false}
        actions={
          <button className="icon-btn" aria-label="Refresh orders" onClick={() => void load(true)}>
            <RefreshCw size={20} />
          </button>
        }
      />
      <div className="content-pad narrow">
        {loading && orders.length === 0 ? (
          <ListSkeleton count={4} height={130} />
        ) : error && orders.length === 0 ? (
          <ErrorCard message={error} onRetry={() => void load(true)} />
        ) : orders.length === 0 ? (
          <EmptyState
            icon={<ShoppingBag size={56} />}
            title="No orders yet"
            text="Your placed orders will appear here with live tracking."
          />
        ) : (
          <div className="stack">
            {orders.map((o) => (
              <button key={o.id} className="card order-card" onClick={() => navigate(`/orders/${o.id}`)}>
                <div className="row between align-start">
                  <div>
                    <strong className="block">{o.order_number}</strong>
                    {o.vendor_id && names[o.vendor_id] && (
                      <span className="row gap-4 small text-primary bold">
                        <Store size={13} /> {names[o.vendor_id]}
                      </span>
                    )}
                    <span className="muted small">{shortDateTime(o.placed_at ?? o.created_at)}</span>
                  </div>
                  <span className="stack-xs align-end">
                    <OrderStatusBadge status={o.status} />
                    {isAwaitingUpiPayment(o) && <span className="status-badge st-orange">Payment pending</span>}
                  </span>
                </div>
                <hr />
                <div className="row between">
                  <span>
                    <span className="muted small block">Total Amount</span>
                    <strong className="total-big">{rupees(o.total_amount, 2)}</strong>
                  </span>
                  <span className="row gap-4 text-primary small bold">
                    View Details <ChevronRight size={16} />
                  </span>
                </div>
              </button>
            ))}
            {hasMore && (
              <div className="center-pad">
                {loadingMore ? (
                  <Spinner />
                ) : (
                  <button className="btn btn-outline" onClick={() => void load(false)}>
                    Load More Orders (20)
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
