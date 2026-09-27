import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Bike,
  Check,
  Clock,
  CreditCard,
  LocateFixed,
  Mail,
  Map as MapIcon,
  MessageCircle,
  Phone,
  RefreshCw,
  Repeat,
  ShieldCheck,
  Star,
  XCircle,
} from 'lucide-react';
import { BillRow, CenterSpinner, ErrorCard, Modal, PageHeader, Spinner, toast } from '../components/ui';
import { TrackingMap } from '../components/MapView';
import {
  createRazorpayOrder,
  getAddressById,
  getDeliveryAssignment,
  getDeliveryPartner,
  getOrderById,
  getOrderItems,
  getOrderStatusHistory,
  getReviewedOrderIds,
  isAssignmentAccepted,
  reorder,
  submitDeliveryPartnerReview,
  submitVendorReview,
  verifyRazorpayPayment,
} from '../lib/repository';
import { openUpiCheckout } from '../lib/razorpay';
import type { CustomerAddress, DeliveryAssignment, DeliveryPartner, Order, OrderItem, OrderStatusHistory } from '../lib/types';
import { capitalize, errorMessage, rupees, shortDateTime } from '../lib/utils';
import { useSession } from '../store/session';

const ACTIVE = ['pending', 'confirmed', 'preparing', 'ready', 'out_for_delivery'];
const POLL_MS = 18_000;
const SUPPORT_PHONE = '+919353461742';
const SUPPORT_WHATSAPP = '919110604033';
const SUPPORT_EMAIL = 'sndmartt@gmail.com';

const STEPS: [string, string][] = [
  ['pending', 'Order Placed'],
  ['confirmed', 'Order Confirmed'],
  ['preparing', 'Preparing Food / Packing'],
  ['ready', 'Ready for Dispatch'],
  ['out_for_delivery', 'Out for Delivery'],
  ['delivered', 'Delivered'],
];

function StatusStepper({ status, history }: { status: string; history: OrderStatusHistory[] }) {
  const current = status.toLowerCase();
  if (current === 'cancelled' || current === 'rejected') {
    const entry = history.find((h) => ['cancelled', 'rejected'].includes(h.status.toLowerCase()));
    return (
      <div className="alert alert-danger">
        <XCircle size={20} />
        <span>
          <strong className="block">This order was {current}.</strong>
          {entry?.created_at && <span className="small">{shortDateTime(entry.created_at)}</span>}
        </span>
      </div>
    );
  }
  // Done-state comes only from order_status_history rows (never inferred from orders.status).
  const byStatus = new Map(history.map((h) => [h.status.toLowerCase(), h]));
  const latest = history.length ? history[history.length - 1].status.toLowerCase() : current;
  return (
    <ol className="stepper-list">
      {STEPS.map(([key, label], i) => {
        const h = byStatus.get(key);
        const done = !!h;
        const nextDone = i < STEPS.length - 1 && byStatus.has(STEPS[i + 1][0]);
        return (
          <li key={key} className={done ? 'done' : ''}>
            <div className="step-rail">
              <span className="step-dot">{done ? <Check size={14} /> : i + 1}</span>
              {i < STEPS.length - 1 && <span className={`step-line${nextDone ? ' done' : ''}`} />}
            </div>
            <div className="step-text">
              <span className={key === latest ? 'bold' : ''}>{label}</span>
              {h?.created_at && <span className="muted small block">{shortDateTime(h.created_at)}</span>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function EtaBanner({ at, minutes, delivered }: { at?: string | null; minutes?: number | null; delivered: boolean }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  let label = 'Calculating arrival time...';
  if (delivered) label = 'Delivered';
  else if (at && !Number.isNaN(Date.parse(at))) {
    const remaining = Date.parse(at) - now;
    if (remaining <= 0) label = 'Arriving any moment';
    else {
      const mins = Math.max(1, Math.ceil(remaining / 60000));
      const h = Math.floor(mins / 60);
      label = h > 0 ? `Arriving in ~${h}h ${mins % 60}m` : `Arriving in ~${mins} min`;
    }
  } else if (minutes && minutes > 0) label = `Arriving in ~${minutes} min`;
  return (
    <div className="eta-banner">
      <span className="row gap-8">
        <span className="eta-icon">
          <Clock size={18} />
        </span>
        <span>
          <span className="label-caps">Estimated arrival</span>
          <strong className="block">{label}</strong>
        </span>
      </span>
      <span className="live-pill">
        <span className="live-dot" /> LIVE
      </span>
    </div>
  );
}

function Stars({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="row gap-4">
      {[1, 2, 3, 4, 5].map((s) => (
        <button key={s} className="star-btn" aria-label={`${s} stars`} onClick={() => onChange(s)}>
          <Star size={30} className="text-warning" fill={s <= value ? 'currentColor' : 'none'} />
        </button>
      ))}
    </div>
  );
}

export default function OrderDetailPage() {
  const { orderId = '' } = useParams();
  const navigate = useNavigate();
  const cityId = useSession((s) => s.selectedCity?.id);
  const [order, setOrder] = useState<Order | null>(null);
  const [items, setItems] = useState<OrderItem[]>([]);
  const [history, setHistory] = useState<OrderStatusHistory[]>([]);
  const [assignment, setAssignment] = useState<DeliveryAssignment | null>(null);
  const [partner, setPartner] = useState<DeliveryPartner | null>(null);
  const [address, setAddress] = useState<CustomerAddress | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reviewedIds, setReviewedIds] = useState<Set<string>>(new Set());
  const [reviewSubmitted, setReviewSubmitted] = useState(false);
  const [showReview, setShowReview] = useState(false);
  const [vendorRating, setVendorRating] = useState(5);
  const [vendorComment, setVendorComment] = useState('');
  const [partnerRating, setPartnerRating] = useState(5);
  const [partnerComment, setPartnerComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [reordering, setReordering] = useState(false);
  const [paying, setPaying] = useState(false);
  const [payMsg, setPayMsg] = useState('Starting payment...');
  const orderRef = useRef<Order | null>(null);

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      setError(null);
      try {
        const o = await getOrderById(orderId);
        setOrder(o);
        orderRef.current = o;
        const [its, hist, asg] = await Promise.all([
          getOrderItems(orderId),
          getOrderStatusHistory(orderId),
          getDeliveryAssignment(orderId),
        ]);
        setItems(its);
        setHistory(hist);
        setAssignment(asg);
        // Privacy: partner details only once the assignment is genuinely accepted.
        if (isAssignmentAccepted(asg)) {
          const pid = asg?.delivery_partner_id ?? o.delivery_partner_id;
          setPartner(pid ? await getDeliveryPartner(pid) : o.delivery_partners ?? null);
        } else setPartner(null);
        if (o.address_id) setAddress(await getAddressById(o.address_id));
        if (o.customer_id) setReviewedIds(await getReviewedOrderIds(o.customer_id));
      } catch (e) {
        if (!silent) setError(errorMessage(e, 'Failed to load order'));
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [orderId],
  );

  // Poll every 18s while the order is active.
  useEffect(() => {
    void load();
    const t = setInterval(() => {
      const st = orderRef.current?.status?.toLowerCase();
      if (st && !ACTIVE.includes(st)) return;
      void load(true);
    }, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const accepted = isAssignmentAccepted(assignment);
  const isActive = !!order && ACTIVE.includes(order.status.toLowerCase());
  const liveTracking = isActive && accepted && !!partner;

  // Rider location polling while tracking.
  useEffect(() => {
    if (!liveTracking || !partner?.id) return;
    const pid = partner.id;
    const t = setInterval(async () => {
      const p = await getDeliveryPartner(pid);
      if (p) setPartner(p);
    }, POLL_MS);
    return () => clearInterval(t);
  }, [liveTracking, partner?.id]);

  async function doReorder() {
    const city = cityId ?? order?.city_id ?? '';
    setReordering(true);
    try {
      toast(await reorder(items, city));
      navigate('/cart');
    } catch (e) {
      toast(`Failed to reorder: ${errorMessage(e)}`);
    } finally {
      setReordering(false);
    }
  }

  async function payNow() {
    if (!order) return;
    setPaying(true);
    setPayMsg('Initiating UPI payment...');
    try {
      const rp = await createRazorpayOrder(order.id);
      const s = useSession.getState();
      const r = await openUpiCheckout({ order: rp, orderNumber: order.order_number || order.id, phone: s.userPhone, email: s.userEmail });
      if (r.kind === 'cancelled') toast('Payment cancelled.');
      else if (r.kind === 'error') toast(r.message);
      else {
        setPayMsg('Verifying payment...');
        const ok = await verifyRazorpayPayment({
          orderId: order.id,
          razorpayOrderId: r.orderId,
          razorpayPaymentId: r.paymentId,
          razorpaySignature: r.signature,
        });
        if (ok) {
          toast('Payment successful and verified!');
          await load();
        } else {
          toast('Payment could not be verified. If money was deducted, it will be refunded shortly - contact support if this persists.');
        }
      }
    } catch (e) {
      toast(errorMessage(e, 'Could not start payment. Please try again.'));
    } finally {
      setPaying(false);
    }
  }

  async function submitReview() {
    if (!order) return;
    setSubmitting(true);
    try {
      if (order.vendor_id) {
        await submitVendorReview({
          vendor_id: order.vendor_id,
          customer_id: order.customer_id,
          order_id: order.id,
          rating: vendorRating,
          comment: vendorComment.trim() || null,
        });
      }
      if (order.delivery_partner_id) {
        await submitDeliveryPartnerReview({
          delivery_partner_id: order.delivery_partner_id,
          customer_id: order.customer_id,
          order_id: order.id,
          rating: partnerRating,
          comment: partnerComment.trim() || null,
        });
      }
      setShowReview(false);
      setReviewSubmitted(true);
      toast('Thank you for your rating!');
    } catch (e) {
      toast(errorMessage(e, 'Failed to submit review'));
    } finally {
      setSubmitting(false);
    }
  }

  const paymentLabel = (o: Order) => {
    switch (o.payment_method.toLowerCase()) {
      case 'cash':
        return o.payment_status.toLowerCase() === 'cod' ? 'Cash on Delivery (COD)' : 'Cash';
      case 'upi':
        return 'UPI';
      case 'card':
        return 'Card';
      case 'online':
        return 'Online';
      default:
        return o.payment_method.toUpperCase();
    }
  };

  const hasReviewed = reviewSubmitted || reviewedIds.has(orderId);
  const riderPos: [number, number] | null =
    partner?.latitude != null && partner.longitude != null ? [Number(partner.latitude), Number(partner.longitude)] : null;
  const destPos: [number, number] | null =
    address?.lat != null && address.lng != null && Number(address.lat) !== 0 ? [Number(address.lat), Number(address.lng)] : null;

  return (
    <div className="page">
      <PageHeader
        title={order?.order_number || 'Order Details'}
        actions={
          <button className="icon-btn" aria-label="Refresh" onClick={() => void load()}>
            <RefreshCw size={20} />
          </button>
        }
      />
      {loading ? (
        <CenterSpinner />
      ) : error ? (
        <div className="content-pad">
          <ErrorCard message={error} onRetry={() => void load()} />
        </div>
      ) : !order ? (
        <p className="center-pad muted">Order details not found</p>
      ) : (
        <div className="content-pad narrow stack">
          {liveTracking && order.status.toLowerCase() === 'out_for_delivery' && assignment?.delivery_otp && (
            <div className="otp-card">
              <span className="row gap-6 label-caps text-primary">
                <ShieldCheck size={18} /> Delivery verification OTP
              </span>
              <div className="otp-code">{assignment.delivery_otp}</div>
              <span className="muted small">Share this code with your delivery partner to confirm delivery.</span>
            </div>
          )}

          {isActive &&
            (accepted ? (
              partner ? (
                <section className="card pad stack">
                  <EtaBanner
                    at={assignment?.estimated_delivery_at}
                    minutes={assignment?.estimated_delivery_minutes}
                    delivered={order.status.toLowerCase() === 'delivered'}
                  />
                  <div className="partner-card">
                    <span className="row gap-12">
                      <span className="icon-circle lg">
                        <Bike size={26} />
                      </span>
                      <span>
                        <strong className="block">{partner.name || 'Delivery Partner'}</strong>
                        <span className="muted small">
                          {[partner.vehicle_type && capitalize(partner.vehicle_type), partner.vehicle_number].filter(Boolean).join(' • ') ||
                            'Delivery Partner'}
                        </span>
                      </span>
                    </span>
                    {partner.phone && (
                      <a className="btn btn-primary btn-sm" href={`tel:${partner.phone}`}>
                        <Phone size={16} /> Call
                      </a>
                    )}
                  </div>
                  {riderPos ? (
                    <div className="stack-sm">
                      <div className="row between">
                        <strong className="row gap-6">
                          <span className="live-dot" /> Live Delivery Tracking
                        </strong>
                        <span className="live-pill">Live GPS</span>
                      </div>
                      <TrackingMap
                        rider={riderPos}
                        destination={destPos}
                        riderLabel={`Delivery Partner: ${partner.name}`}
                        destinationLabel={`Delivery Address (${address?.label ?? 'Home'})`}
                      />
                      <div className="row between">
                        <span className="small">
                          <strong className="block">Rider: {partner.name}</strong>
                          {address?.address_line && <span className="muted ellipsis block">To: {address.address_line}</span>}
                        </span>
                        <a
                          className="btn btn-outline btn-sm"
                          href={`https://maps.google.com/?q=${riderPos[0]},${riderPos[1]}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          <MapIcon size={14} /> Open in Maps
                        </a>
                      </div>
                    </div>
                  ) : (
                    <div className="waiting-card">
                      <LocateFixed size={20} />
                      <span>
                        <strong className="block">Waiting for delivery partner to start sharing location...</strong>
                        <span className="muted small">Live GPS updates will appear automatically</span>
                      </span>
                    </div>
                  )}
                </section>
              ) : (
                <div className="card pad row gap-12">
                  <Spinner size={24} /> <span className="muted">Connecting with accepted delivery partner...</span>
                </div>
              )
            ) : (
              <div className="card pad row gap-12">
                <span className="finding">
                  <Spinner size={44} />
                  <Bike size={20} className="finding-icon" />
                </span>
                <span>
                  <strong className="block">Finding a delivery partner for your order...</strong>
                  <span className="muted small">
                    We are assigning the nearest available delivery partner. Driver details, live map, and arrival ETA
                    will appear once accepted.
                  </span>
                </span>
              </div>
            ))}

          <section className="card pad">
            <h3>Order Progress</h3>
            <StatusStepper status={order.status} history={history} />
          </section>

          <section className="card pad">
            <h3>Items Ordered ({items.length})</h3>
            {items.length === 0 ? (
              <p className="muted small">No items recorded for this order.</p>
            ) : (
              items.map((it) => (
                <div key={it.id ?? it.product_id} className="row between item-line">
                  <span>
                    <strong className="block">{it.product_name}</strong>
                    <span className="muted small">
                      {it.quantity} x {rupees(it.unit_price)}
                      {it.variant_label ? ` (${it.variant_label})` : ''}
                    </span>
                  </span>
                  <strong>{rupees(it.total_price)}</strong>
                </div>
              ))
            )}
          </section>

          <section className="card pad">
            <h3>Payment Summary</h3>
            <BillRow label="Payment Method" value={paymentLabel(order)} />
            <BillRow label="Payment Status" value={capitalize(order.payment_status)} />
            <hr />
            <BillRow label="Subtotal" value={rupees(order.subtotal, 2)} />
            {order.discount_amount > 0 && <BillRow label="Discount" value={`-${rupees(order.discount_amount, 2)}`} accent />}
            <BillRow label="Delivery Fee" value={rupees(order.delivery_fee, 2)} />
            <BillRow label="Handling Fee" value={rupees(order.handling_fee, 2)} />
            <hr />
            <BillRow label="Total Paid / Due" value={rupees(order.total_amount, 2)} bold accent />
            {order.payment_method.toLowerCase() === 'upi' &&
              order.payment_status.toLowerCase() !== 'paid' &&
              !['cancelled', 'rejected'].includes(order.status.toLowerCase()) && (
                <button className="btn btn-primary w-full mt-12" disabled={paying} onClick={() => void payNow()}>
                  {paying ? (
                    <>
                      <Spinner size={18} light /> {payMsg}
                    </>
                  ) : (
                    <>
                      <CreditCard size={18} /> Pay Now via UPI ({rupees(order.total_amount)})
                    </>
                  )}
                </button>
              )}
          </section>

          <section className="card pad">
            <h3>Need Help with this Order?</h3>
            <div className="help-row">
              <a className="btn btn-outline btn-sm" href={`tel:${SUPPORT_PHONE}`}>
                <Phone size={15} /> Call
              </a>
              <a
                className="btn btn-outline btn-sm"
                target="_blank"
                rel="noreferrer"
                href={`https://wa.me/${SUPPORT_WHATSAPP}?text=${encodeURIComponent(`I need help with order ${order.order_number}`)}`}
              >
                <MessageCircle size={15} /> WhatsApp
              </a>
              <a
                className="btn btn-outline btn-sm"
                href={`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(`Help with Order ${order.order_number}`)}`}
              >
                <Mail size={15} /> Email
              </a>
            </div>
          </section>

          <div className="sticky-bottom">
            <button className="btn btn-primary btn-lg grow" disabled={reordering} onClick={() => void doReorder()}>
              {reordering ? <Spinner size={20} light /> : <Repeat size={18} />} Reorder Items
            </button>
            {order.status.toLowerCase() === 'delivered' && !hasReviewed && (
              <button className="btn btn-outline btn-lg" onClick={() => setShowReview(true)}>
                <Star size={18} className="text-warning" /> Rate Order
              </button>
            )}
          </div>
        </div>
      )}

      <Modal
        open={showReview}
        onClose={() => setShowReview(false)}
        title="Rate Your Experience"
        footer={
          <>
            <button className="btn btn-text" onClick={() => setShowReview(false)}>
              Cancel
            </button>
            <button className="btn btn-primary" disabled={submitting} onClick={() => void submitReview()}>
              {submitting ? <Spinner size={18} light /> : 'Submit Review'}
            </button>
          </>
        }
      >
        <div className="stack">
          <strong>Hotel / Vendor Rating</strong>
          <Stars value={vendorRating} onChange={setVendorRating} />
          <label className="field">
            <span>Food / Item Feedback</span>
            <input value={vendorComment} onChange={(e) => setVendorComment(e.target.value)} />
          </label>
          <strong>Delivery Partner Rating</strong>
          <Stars value={partnerRating} onChange={setPartnerRating} />
          <label className="field">
            <span>Delivery Feedback</span>
            <input value={partnerComment} onChange={(e) => setPartnerComment(e.target.value)} />
          </label>
        </div>
      </Modal>
    </div>
  );
}
