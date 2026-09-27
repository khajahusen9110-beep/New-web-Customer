import { useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, CalendarDays, CheckCircle2, Info, LocateFixed, MapPin, Navigation, Plus, Zap } from 'lucide-react';
import { AddressPickerModal } from '../components/AddressPickerModal';
import { BillRow, ErrorCard, PageHeader, Spinner, toast } from '../components/ui';
import MaintenancePage from './MaintenancePage';
import {
  checkMaintenanceMode,
  MaintenanceError,
  createRazorpayOrder,
  getAddresses,
  getCityDeliverySettings,
  getDeliverySlots,
  getExpressDeliverySettings,
  placeOrder,
  resolveDeliveryDistanceKm,
  validateAndApplyCoupon,
  verifyRazorpayPayment,
} from '../lib/repository';
import { openUpiCheckout } from '../lib/razorpay';
import type { Coupon, CustomerAddress, DeliverySlot, ExpressDeliverySettings } from '../lib/types';
import { useFreshCart } from '../lib/hooks';
import {
  cartTotal,
  errorMessage,
  expressCharge,
  expressEstimatedMinutes,
  rupees,
  shortTime,
  slotAmountNeededForFree,
  slotFee,
  slotIsFreeEligible,
} from '../lib/utils';
import { useSession } from '../store/session';
import { useCart } from '../store/cart';

const PAYMENT_METHODS = [
  { key: 'cod', label: 'Cash on Delivery (COD)' },
  { key: 'upi', label: 'UPI / Instant Pay' },
] as const;
type PaymentKey = (typeof PAYMENT_METHODS)[number]['key'];
type DeliveryType = 'scheduled' | 'express' | 'none';

const DEFAULT_HANDLING_FEE = 5;
const PAYMENT_VERIFY_FAILED =
  'Payment could not be verified. If money was deducted, it will be refunded shortly - contact support if this persists.';

export default function CheckoutPage() {
  const { type } = useParams();
  const isHotel = type === 'hotel';
  const navigate = useNavigate();
  const { userId, isLoggedIn, selectedCity, userPhone, userEmail } = useSession();
  const cart = useCart((s) => (isHotel ? s.hotelCart : s.groceryCart));
  const hotelCart = useCart((s) => s.hotelCart);

  const [addresses, setAddresses] = useState<CustomerAddress[]>([]);
  const [addressId, setAddressId] = useState<string | null>(null);
  const [loadingAddresses, setLoadingAddresses] = useState(true);
  const [showAddAddress, setShowAddAddress] = useState(false);
  const selectedAddress = addresses.find((a) => a.id === addressId) ?? null;
  const cityId = selectedAddress?.city_id || selectedCity?.id || null;

  const { fresh, loading: loadingCart } = useFreshCart(cart, cityId);
  const subtotal = cartTotal(fresh);

  const [slots, setSlots] = useState<DeliverySlot[]>([]);
  const [express, setExpress] = useState<ExpressDeliverySettings | null>(null);
  const [handlingFee, setHandlingFee] = useState(DEFAULT_HANDLING_FEE);
  const [loadingDelivery, setLoadingDelivery] = useState(true);
  const [deliveryType, setDeliveryType] = useState<DeliveryType>('scheduled');
  const [slotId, setSlotId] = useState<string | null>(null);
  const [distanceKm, setDistanceKm] = useState<number | null>(null);

  const [couponInput, setCouponInput] = useState('');
  const [coupon, setCoupon] = useState<Coupon | null>(null);
  const [discount, setDiscount] = useState(0);
  const [validatingCoupon, setValidatingCoupon] = useState(false);
  const [couponError, setCouponError] = useState<string | null>(null);

  const [payment, setPayment] = useState<PaymentKey>('cod');
  const [placing, setPlacing] = useState(false);
  const [placingMsg, setPlacingMsg] = useState('Placing Order...');
  const [placementError, setPlacementError] = useState<string | null>(null);
  const [maintenanceMsg, setMaintenanceMsg] = useState<string | null>(null);
  const [checkingMaintenance, setCheckingMaintenance] = useState(false);

  const hotelVendorId = isHotel
    ? hotelCart.find((i) => i.vendor_id)?.vendor_id ?? fresh.find((i) => i.product.vendorId)?.product.vendorId ?? null
    : null;

  const loadAddresses = useCallback(
    async (selectId?: string | null) => {
      if (!userId) {
        setLoadingAddresses(false);
        return;
      }
      setLoadingAddresses(true);
      try {
        const list = await getAddresses(userId);
        setAddresses(list);
        setAddressId((cur) => selectId ?? cur ?? (list.find((a) => a.is_default) ?? list[0])?.id ?? null);
      } catch (e) {
        toast(errorMessage(e, 'Failed to load addresses'));
      } finally {
        setLoadingAddresses(false);
      }
    },
    [userId],
  );

  useEffect(() => {
    void loadAddresses();
  }, [loadAddresses]);

  // Distance from hotel (food) or city hub (grocery) to the chosen address.
  useEffect(() => {
    if (!selectedAddress) return;
    let cancelled = false;
    resolveDeliveryDistanceKm(selectedAddress, cityId, hotelVendorId, isHotel).then((d) => !cancelled && setDistanceKm(d));
    return () => {
      cancelled = true;
    };
  }, [selectedAddress, cityId, hotelVendorId, isHotel]);

  // Delivery options for the effective city.
  useEffect(() => {
    if (!cityId) return;
    let cancelled = false;
    setLoadingDelivery(true);
    Promise.all([getDeliverySlots(cityId), getExpressDeliverySettings(cityId), getCityDeliverySettings(cityId)]).then(
      ([s, e, cds]) => {
        if (cancelled) return;
        setSlots(s);
        setExpress(e);
        if (cds?.handling_fee != null) setHandlingFee(Number(cds.handling_fee));
        const hasSlots = s.length > 0;
        const hasExpress = !!e?.is_active;
        setDeliveryType((cur) =>
          hasSlots && hasExpress ? (cur === 'express' ? 'express' : 'scheduled') : hasSlots ? 'scheduled' : hasExpress ? 'express' : 'none',
        );
        setSlotId((cur) => (cur && s.some((x) => x.id === cur) ? cur : s[0]?.id ?? null));
        setLoadingDelivery(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [cityId]);

  const applyCoupon = async (code: string) => {
    if (!cityId || !code.trim()) return;
    setValidatingCoupon(true);
    setCouponError(null);
    try {
      const r = await validateAndApplyCoupon(code, cityId, subtotal);
      if (r.isValid) {
        setCoupon(r.coupon ?? null);
        setDiscount(r.discountAmount);
      } else {
        setCoupon(null);
        setDiscount(0);
        setCouponError(r.errorMessage ?? 'Coupon is not valid for this order');
      }
    } catch (e) {
      setCoupon(null);
      setDiscount(0);
      setCouponError(errorMessage(e, 'Coupon validation failed'));
    } finally {
      setValidatingCoupon(false);
    }
  };

  const distance = distanceKm ?? 1;
  const hasSlots = slots.length > 0;
  const hasExpress = !!express?.is_active;
  const deliveryAvailable = hasSlots || hasExpress;
  const matchedSlot = slots.find((s) => s.id === slotId) ?? slots[0] ?? null;
  const expressCalc = express ? expressCharge(express, distance, subtotal) : { fee: 0, isFree: false };

  const deliveryFee: number | null = !deliveryAvailable
    ? null
    : deliveryType === 'express' && hasExpress
      ? expressCalc.fee
      : deliveryType === 'scheduled' && hasSlots && matchedSlot
        ? slotFee(matchedSlot, subtotal)
        : null;

  const expressMinNotMet =
    deliveryType === 'express' && express?.min_order_amount != null && subtotal < Number(express.min_order_amount);

  const total = deliveryFee != null ? Math.max(subtotal - discount + deliveryFee + handlingFee, 0) : null;

  const disabled =
    placing ||
    loadingDelivery ||
    loadingCart ||
    !deliveryAvailable ||
    (deliveryType === 'scheduled' && !matchedSlot) ||
    expressMinNotMet ||
    !addressId ||
    !cityId ||
    subtotal <= 0;

  const bottomNotice = useMemo(() => {
    if (placementError) return placementError;
    if (!deliveryAvailable && !loadingDelivery) return "Delivery isn't currently available in your area";
    if (expressMinNotMet) return `Minimum order ${rupees(express?.min_order_amount)} required for Express Delivery`;
    return null;
  }, [placementError, deliveryAvailable, loadingDelivery, expressMinNotMet, express]);

  async function runUpiPayment(orderId: string, orderNumber: string) {
    setPlacingMsg('Initiating UPI payment...');
    const rp = await createRazorpayOrder(orderId);
    const result = await openUpiCheckout({ order: rp, orderNumber, phone: userPhone, email: userEmail });
    if (result.kind === 'cancelled') {
      toast('Payment cancelled. You can retry from your Orders page.');
      navigate(`/orders/${orderId}`, { replace: true });
      return;
    }
    if (result.kind === 'error') {
      toast(result.message);
      navigate(`/orders/${orderId}`, { replace: true });
      return;
    }
    setPlacingMsg('Verifying payment...');
    const ok = await verifyRazorpayPayment({
      orderId,
      razorpayOrderId: result.orderId,
      razorpayPaymentId: result.paymentId,
      razorpaySignature: result.signature,
    });
    if (!ok) {
      setPlacementError(PAYMENT_VERIFY_FAILED);
      toast(PAYMENT_VERIFY_FAILED);
    }
    navigate(`/orders/${orderId}`, { replace: true });
  }

  async function onPlaceOrder() {
    if (!isLoggedIn || !userId) return navigate('/auth');
    if (!addressId) return toast('Please select or add a delivery address');
    if (!cityId) return toast('Please select a serviceable city');
    if (!deliveryAvailable) return toast("Delivery isn't currently available in your area");
    if (expressMinNotMet) return toast(`Minimum order ${rupees(express?.min_order_amount)} required for Express Delivery`);

    setPlacing(true);
    setPlacingMsg('Placing Order...');
    setPlacementError(null);
    try {
      // placeOrder checks maintenance mode itself right before checkout (no separate request here).
      const order = await placeOrder({ userId, isHotel, vendorId: hotelVendorId, addressId, paymentMethod: payment, coupon });
      if (payment === 'upi') {
        try {
          await runUpiPayment(order.id, order.order_number || order.id);
        } catch (e) {
          const msg = errorMessage(e, 'Could not start payment. Please try again.');
          toast(msg);
          navigate(`/orders/${order.id}`, { replace: true });
        }
      } else {
        navigate(`/orders/${order.id}`, { replace: true });
      }
    } catch (e) {
      if (e instanceof MaintenanceError) {
        setMaintenanceMsg(e.message);
        return;
      }
      const msg = errorMessage(e, 'Failed to place order');
      // Server rejected the coupon (no order created): drop it so the order can be placed without it.
      if (coupon && /coupon|minimum order amount/i.test(msg)) {
        setCoupon(null);
        setCouponError(msg);
      }
      setPlacementError(msg);
      toast(msg);
    } finally {
      setPlacing(false);
    }
  }

  if (maintenanceMsg) {
    return (
      <MaintenancePage
        message={maintenanceMsg}
        isChecking={checkingMaintenance}
        onRetry={async () => {
          setCheckingMaintenance(true);
          const m = await checkMaintenanceMode();
          setCheckingMaintenance(false);
          setMaintenanceMsg(m.enabled ? m.message ?? 'Service temporarily unavailable. Please try again shortly.' : null);
        }}
        onDismiss={() => setMaintenanceMsg(null)}
      />
    );
  }

  if (type !== 'hotel' && type !== 'grocery') return <Navigate to="/cart" replace />;
  if (cart.length === 0 && !placing) return <Navigate to="/cart" replace />;

  return (
    <div className="page">
      <PageHeader title="Checkout" subtitle={isHotel ? 'Hotel order' : 'Grocery order'} />
      <div className="content-pad checkout-layout">
        <div className="stack">
          {placementError && <ErrorCard message={placementError} onRetry={() => setPlacementError(null)} retryLabel="Dismiss" />}

          <div className="row gap-6">
            <MapPin size={18} className="text-primary" />
            <strong>Delivering in: {selectedCity?.name ?? 'Current City'}</strong>
            {distanceKm != null && distanceKm > 0 && <span className="muted small">(~{distanceKm.toFixed(1)} km away)</span>}
          </div>

          {/* Address */}
          <section className="card pad">
            <div className="row between">
              <h3>Delivery Address</h3>
              <div className="row gap-4">
                <button className="btn btn-text btn-sm" onClick={() => setShowAddAddress(true)}>
                  <LocateFixed size={15} /> Detect GPS
                </button>
                <button className="btn btn-text btn-sm" onClick={() => setShowAddAddress(true)}>
                  <Plus size={16} /> Add New
                </button>
              </div>
            </div>
            {loadingAddresses ? (
              <div className="center-pad">
                <Spinner />
              </div>
            ) : addresses.length === 0 ? (
              <div className="stack-sm">
                <p className="muted small">No address added yet. Use GPS to detect exact doorstep location.</p>
                <button className="btn btn-primary w-full" onClick={() => setShowAddAddress(true)}>
                  <LocateFixed size={18} /> Detect My Location
                </button>
              </div>
            ) : (
              <div className="stack-sm">
                {addresses.map((a) => (
                  <label key={a.id} className={`radio-card${addressId === a.id ? ' selected' : ''}`}>
                    <input type="radio" name="address" checked={addressId === a.id} onChange={() => setAddressId(a.id ?? null)} />
                    <span>
                      <span className="row gap-6">
                        <span className="pill">{a.label.toUpperCase()}</span>
                        <strong>{a.recipient_name}</strong>
                      </span>
                      <span className="small block">{a.address_line}</span>
                      {a.landmark && <span className="muted small block">Landmark: {a.landmark}</span>}
                      <span className="muted small block">Phone: {a.phone}</span>
                    </span>
                  </label>
                ))}
              </div>
            )}
          </section>

          {/* Delivery option */}
          <section className="card pad">
            <div className="row between">
              <h3>Delivery Option</h3>
              {loadingDelivery && (
                <span className="row gap-4 muted small">
                  <Spinner size={14} /> Updating...
                </span>
              )}
            </div>
            {loadingDelivery ? (
              <div className="stack-sm">
                <div className="skeleton" style={{ height: 56 }} />
                <div className="skeleton" style={{ height: 56 }} />
              </div>
            ) : !deliveryAvailable ? (
              <div className="alert alert-danger">
                <AlertTriangle size={20} /> Delivery isn't currently available in your area
              </div>
            ) : (
              <div className="stack-sm">
                {hasSlots && hasExpress && (
                  <div className="segmented">
                    <button
                      className={deliveryType === 'scheduled' ? 'active' : ''}
                      onClick={() => {
                        setDeliveryType('scheduled');
                        if (!slotId) setSlotId(slots[0]?.id ?? null);
                      }}
                    >
                      <CalendarDays size={15} /> Scheduled Delivery
                    </button>
                    <button className={deliveryType === 'express' ? 'active' : ''} onClick={() => setDeliveryType('express')}>
                      <Zap size={15} /> Express (~{express ? expressEstimatedMinutes(express) : 30} min)
                    </button>
                  </div>
                )}

                {deliveryType === 'scheduled' && hasSlots && (
                  <>
                    {!hasExpress && <strong className="small">Scheduled Delivery Slots</strong>}
                    {slots.map((s) => {
                      const picked = slotId === s.id;
                      const free = slotIsFreeEligible(s, subtotal);
                      const minOrder = Number(s.min_order_amount ?? 0);
                      const times = [shortTime(s.start_time), shortTime(s.end_time)].filter(Boolean).join(' - ');
                      return (
                        <label key={s.id} className={`radio-card${picked ? ' selected' : ''}`}>
                          <input type="radio" name="slot" checked={picked} onChange={() => setSlotId(s.id)} />
                          <span className="grow">
                            <strong className="block">{s.name}</strong>
                            {times && <span className="muted small block">{times}</span>}
                            {s.is_free_delivery && minOrder > 0 ? (
                              <span className={`small block ${free ? 'text-primary' : 'muted'}`}>
                                {free
                                  ? `Free delivery unlocked (Min order ${rupees(minOrder)})`
                                  : `Add ${rupees(slotAmountNeededForFree(s, subtotal))} more for free delivery (Min order ${rupees(minOrder)})`}
                              </span>
                            ) : (
                              minOrder > 0 && <span className="muted small block">Min order {rupees(minOrder)}</span>
                            )}
                          </span>
                          {free ? <span className="free-tag">FREE</span> : <strong>{rupees(slotFee(s, subtotal))}</strong>}
                        </label>
                      );
                    })}
                  </>
                )}

                {deliveryType === 'express' && hasExpress && express && (
                  <div className={`express-card${express.min_order_amount != null && subtotal < express.min_order_amount ? ' disabled' : ''}`}>
                    <div className="row between">
                      <span className="row gap-8">
                        <span className="icon-square orange">
                          <Zap size={20} />
                        </span>
                        <span>
                          <strong className="block">Express Delivery</strong>
                          <span className="muted small">Delivered within {expressEstimatedMinutes(express)} minutes</span>
                        </span>
                      </span>
                      {!expressMinNotMet &&
                        (expressCalc.isFree ? <span className="free-tag">FREE</span> : <strong className="text-orange">{rupees(expressCalc.fee)}</strong>)}
                    </div>
                    <div className="row gap-4 muted small mt-8">
                      <Navigation size={14} /> Distance: ~{distance.toFixed(1)} km from {isHotel ? 'hotel' : 'city dispatch hub'}
                    </div>
                    {expressMinNotMet ? (
                      <div className="alert alert-danger small mt-8">
                        <Info size={16} /> Minimum order {rupees(express.min_order_amount)} for Express Delivery
                      </div>
                    ) : expressCalc.isFree ? (
                      <div className="small text-primary mt-8">
                        Free delivery unlocked! (Order subtotal &gt; {rupees(express.free_delivery_min_order)} within{' '}
                        {Number(express.free_delivery_max_km ?? 0).toFixed(0)} km)
                      </div>
                    ) : (
                      express.base_km != null &&
                      express.base_charge != null && (
                        <div className="muted small mt-8">
                          {distance <= express.base_km
                            ? `Base fee ${rupees(express.base_charge)} up to ${Number(express.base_km).toFixed(0)} km`
                            : `Base ${rupees(express.base_charge)} + ${rupees(express.per_km_charge_beyond)}/km beyond ${Number(express.base_km).toFixed(0)} km`}
                        </div>
                      )
                    )}
                  </div>
                )}
              </div>
            )}
          </section>

          {/* Coupon */}
          <section className="card pad">
            <h3>Have a Coupon?</h3>
            {coupon ? (
              <div className="coupon-applied">
                <span className="row gap-8">
                  <CheckCircle2 size={20} className="text-primary" />
                  <span>
                    <strong className="block">Coupon {coupon.code} Applied!</strong>
                    <span className="small text-primary">You save {rupees(discount)}</span>
                  </span>
                </span>
                <button
                  className="btn btn-text text-danger"
                  onClick={() => {
                    setCoupon(null);
                    setDiscount(0);
                    setCouponInput('');
                  }}
                >
                  Remove
                </button>
              </div>
            ) : (
              <>
                <div className="row gap-8">
                  <input
                    className="input grow"
                    placeholder="Enter Coupon Code"
                    value={couponInput}
                    onChange={(e) => setCouponInput(e.target.value.toUpperCase())}
                  />
                  <button
                    className="btn btn-primary"
                    disabled={!couponInput.trim() || validatingCoupon || subtotal <= 0}
                    onClick={() => void applyCoupon(couponInput)}
                  >
                    {validatingCoupon ? <Spinner size={18} light /> : 'Apply'}
                  </button>
                </div>
                {couponError && <p className="text-danger small">{couponError}</p>}
              </>
            )}
          </section>

          {/* Payment */}
          <section className="card pad">
            <h3>Payment Method</h3>
            <div className="stack-sm">
              {PAYMENT_METHODS.map((m) => (
                <label key={m.key} className={`radio-card${payment === m.key ? ' selected' : ''}`}>
                  <input type="radio" name="payment" checked={payment === m.key} onChange={() => setPayment(m.key)} />
                  <span>{m.label}</span>
                </label>
              ))}
            </div>
          </section>
        </div>

        {/* Bill */}
        <aside className="stack checkout-aside">
          <section className="card pad">
            <h3>Bill Details</h3>
            {loadingCart && fresh.length === 0 ? (
              <div className="center-pad">
                <Spinner />
              </div>
            ) : (
              <>
                {fresh.map((i) => (
                  <BillRow key={`${i.cartItem.product_id}_${i.cartItem.variant_id ?? ''}`} label={`${i.displayName} × ${i.cartItem.quantity}`} value={rupees(i.totalPrice)} />
                ))}
                <hr />
                <BillRow label="Items Subtotal" value={rupees(subtotal)} />
                {discount > 0 && <BillRow label="Coupon Discount" value={`-${rupees(discount)}`} accent />}
                <BillRow
                  label="Delivery Fee"
                  value={
                    loadingDelivery ? (
                      <span className="muted">Calculating...</span>
                    ) : !deliveryAvailable ? (
                      <span className="text-danger">Unavailable</span>
                    ) : deliveryFee === 0 ? (
                      <span className="text-primary bold">FREE</span>
                    ) : deliveryFee != null ? (
                      rupees(deliveryFee)
                    ) : (
                      '--'
                    )
                  }
                />
                <BillRow label="Handling Fee" value={rupees(handlingFee)} />
                <hr />
                <BillRow label="To Pay" value={total != null && deliveryAvailable ? rupees(total) : '--'} bold accent />
              </>
            )}
          </section>
          <div className="checkout-cta">
            {bottomNotice && <p className="text-danger small bold">{bottomNotice}</p>}
            <button className="btn btn-primary btn-lg w-full" disabled={disabled} onClick={() => void onPlaceOrder()}>
              {placing || loadingDelivery ? (
                <>
                  <Spinner size={20} light /> {placing ? placingMsg : 'Loading Options...'}
                </>
              ) : (
                `${payment === 'upi' ? 'Pay via UPI' : 'Confirm & Place Order'}${total != null ? ` • ${rupees(total)}` : ''}`
              )}
            </button>
          </div>
        </aside>
      </div>

      {showAddAddress && (
        <AddressPickerModal
          open
          onClose={() => setShowAddAddress(false)}
          onSaved={(a) => {
            setShowAddAddress(false);
            void loadAddresses(a.id ?? null);
            useSession.getState().setHasSavedAddress(true);
          }}
        />
      )}
    </div>
  );
}
