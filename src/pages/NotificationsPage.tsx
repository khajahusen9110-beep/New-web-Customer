import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  Bell,
  Bike,
  CheckCheck,
  CheckCircle2,
  Megaphone,
  PackageCheck,
  ShoppingBag,
  Truck,
  User,
  UtensilsCrossed,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import { EmptyState, ErrorCard, ListSkeleton, PageHeader, Spinner, toast } from '../components/ui';
import { getCustomerNotifications, markAllNotificationsAsRead, markNotificationAsRead } from '../lib/repository';
import type { CustomerNotification } from '../lib/types';
import { errorMessage, formatRelativeTime, notificationBody, notificationOrderId, notificationTitle } from '../lib/utils';
import { useSession } from '../store/session';

const PAGE = 20;

function meta(title: string, body: string): { Icon: LucideIcon; cls: string } {
  const c = `${title} ${body}`.toLowerCase();
  if (c.includes('delivered')) return { Icon: PackageCheck, cls: 'text-success' };
  if (c.includes('out for delivery')) return { Icon: Truck, cls: 'text-blue' };
  if (c.includes('picked up')) return { Icon: Bike, cls: 'text-warning' };
  if (c.includes('delivery partner') || c.includes('assigned')) return { Icon: User, cls: 'text-primary' };
  if (c.includes('ready')) return { Icon: ShoppingBag, cls: 'text-primary' };
  if (c.includes('preparing')) return { Icon: UtensilsCrossed, cls: 'text-warning' };
  if (c.includes('confirmed')) return { Icon: CheckCircle2, cls: 'text-success' };
  if (c.includes('cancel')) return { Icon: XCircle, cls: 'text-danger' };
  return { Icon: Megaphone, cls: 'text-primary' };
}

export default function NotificationsPage() {
  const navigate = useNavigate();
  const userId = useSession((s) => s.userId);
  const setUnread = useSession((s) => s.setUnreadNotificationCount);
  const [items, setItems] = useState<CustomerNotification[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const unread = items.filter((n) => !n.is_read).length;

  const load = useCallback(
    async (reset: boolean) => {
      if (!userId) return;
      if (reset) {
        setLoading(true);
        setError(null);
      } else setLoadingMore(true);
      try {
        const list = await getCustomerNotifications(userId, PAGE, reset ? 0 : items.length);
        setItems((cur) => (reset ? list : [...cur, ...list]));
        setHasMore(list.length >= PAGE);
      } catch (e) {
        if (reset) setError(errorMessage(e, 'Failed to load notifications'));
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [userId, items.length],
  );

  useEffect(() => {
    void load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  return (
    <div className="page">
      <PageHeader
        title="Notifications"
        subtitle={unread > 0 ? `${unread} unread` : undefined}
        actions={
          unread > 0 && (
            <button
              className="btn btn-text btn-sm"
              onClick={async () => {
                if (!userId) return;
                try {
                  await markAllNotificationsAsRead(userId);
                  setItems((cur) => cur.map((n) => ({ ...n, is_read: true })));
                  setUnread(0);
                } catch {
                  toast('Could not mark all as read');
                }
              }}
            >
              <CheckCheck size={16} /> Mark all read
            </button>
          )
        }
      />
      <div className="content-pad narrow">
        {loading && items.length === 0 ? (
          <ListSkeleton count={5} height={90} />
        ) : error && items.length === 0 ? (
          <ErrorCard message={error} onRetry={() => void load(true)} />
        ) : items.length === 0 ? (
          <EmptyState
            icon={<Bell size={56} />}
            title="No notifications yet"
            text="Order status updates, live delivery tracking, and city announcements will appear right here."
          />
        ) : (
          <div className="stack-sm">
            {items.map((n) => {
              const title = notificationTitle(n);
              const body = notificationBody(n);
              const { Icon, cls } = meta(title, body);
              const orderId = notificationOrderId(n);
              return (
                <button
                  key={n.id}
                  className={`card notif-card${n.is_read ? '' : ' unread'}`}
                  onClick={() => {
                    if (!n.is_read) {
                      void markNotificationAsRead(n.id);
                      setItems((cur) => cur.map((x) => (x.id === n.id ? { ...x, is_read: true } : x)));
                    }
                    if (orderId) navigate(`/orders/${orderId}`);
                  }}
                >
                  <span className={`icon-circle ${cls}`}>
                    <Icon size={20} />
                  </span>
                  <span className="grow">
                    <span className="row between">
                      <strong>{title}</strong>
                      {!n.is_read && <span className="unread-dot" />}
                    </span>
                    <span className="small block">{body}</span>
                    <span className="row between mt-8">
                      <span className="muted small">{formatRelativeTime(n.created_at)}</span>
                      {orderId && (
                        <span className="small text-primary bold row gap-4">
                          View Order <ArrowRight size={14} />
                        </span>
                      )}
                    </span>
                  </span>
                </button>
              );
            })}
            {hasMore && (
              <div className="center-pad">
                {loadingMore ? (
                  <Spinner />
                ) : (
                  <button className="btn btn-outline" onClick={() => void load(false)}>
                    Load More Notifications (20)
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
