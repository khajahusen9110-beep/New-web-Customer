import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, CalendarDays, CheckCircle2, Info, LocateFixed, MapPin, Navigation, Plus, Wallet as WalletIcon, Zap } from 'lucide-react';
import { AddressPickerModal } from '../components/AddressPickerModal';
import { BillRow, ErrorCard, Modal, PageHeader, Spinner, toast } from '../components/ui';
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
  syncRazorpayPayment,
  resolveDeliveryDistanceKm,
  previewCheckoutRewards,
  verifyRazorpayPayment,
} from '../lib/repository';
import { openUpiCheckout } from '../lib/razorpay';
import type { CustomerAddress, DeliverySlot, ExpressDeliverySettings, Order, RewardsPreview } from '../lib/types';
import { useCartCheck } from '../lib/hooks';
import type { CartNavState } from './CartPage';
import {
  errorMessage,
  isItemAvailabilityError,
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
// "Use wallet balance" is remembered for this visit only (default: unchecked).
let walletChoice = false;
const PAYMENT_VERIFY_FAILED =
  'Payment could not be verified. If money was deducted, it will be refunded shortly - contact support if this persists.';

export default function CheckoutPage() {
  const { type } = useParams();
  const isHotel = type === 'hotel';
  const navigate = useNavigate();
  const { userId, isLoggedIn, selectedCity, userPhone, userEmail } = useSession();
  const cart = useCart((s) => (isHotel ? s.hotelCart : s.groceryCart));
  const hotelCart = useCart((s) => s.hotelCart);
  const cartHydrated = useCart((s) => s.hydrated);

  const [addresses, setAddresses] = useState<CustomerAddress[]>([]);
  const [addressId, setAddressId] = useState<string | null>(null);
  const [loadingAddresses, setLoadingAddresses] = useState(true);
  const [showAddAddress, setShowAddAddress] = useState(false);
  const selectedAddress = addresses.find((a) => a.id === addressId) ?? null;
  const cityId = selectedAddress?.city_id || selectedCity?.id || null;

  const {
    lines: fresh,
    available,
    unavailable,
    subtotal,
    hotelClosed,
    allChecked,
    loading: loadingCart,
    removeUnavailable,
  } = useCartCheck(cart, cityId, isHotel);

  const [slots, setSlots] = useState<DeliverySlot[]>([]);
  const [express, setExpress] = useState<ExpressDeliverySettings | null>(null);
  const [handlingFee, setHandlingFee] = useState(DEFAULT_HANDLING_FEE);
  const [loadingDelivery, setLoadingDelivery] = useState(true);
  const [deliveryType, setDeliveryType] = useState<DeliveryType>('scheduled');
  const [slotId, setSlotId] = useState<string | null>(null);
  const [distanceKm, setDistanceKm] = useState<number | null>(null);

  const [couponInput, setCouponInput] = useState('');
  // Code the customer applied; the server preview says whether it is valid and what it gives.
  const [appliedCode, setAppliedCode] = useState<string | null>(null);
  const [preview, setPreview] = useState<RewardsPreview | null>(null);
  const [validatingCoupon, setValidatingCoupon] = useState(false);
  const [couponError, setCouponError] = useState<string | null>(null);
  const [useWallet, setUseWalletState] = useState(walletChoice);
  const setUseWallet = (v: boolean) => {
    walletChoice = v;
    setUseWalletState(v);
  };
  // Server amount differed from the estimate: shown before Razorpay opens.
  const [confirmPay, setConfirmPay] = useState<Order | null>(null);

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

  // Coupon + wallet as the server sees them for this cart (the server calculates everything).
  const previewCoupon = preview?.coupon?.valid && appliedCode && preview.coupon.code === appliedCode ? preview.coupon : null;
  const isCashback = previewCoupon?.reward_type === 'cashback';
  const discount = previewCoupon && !isCashback ? Number(previewCoupon.discount ?? 0) : 0;
  const cashback = previewCoupon && isCashback ? Number(previewCoupon.cashback ?? 0) : 0;
  const lastPreviewKey = useRef('');

  const runPreview = useCallback(
    async (code: string | null, payableBeforeWallet: number, force = false) => {
      if (subtotal <= 0) return null;
      const key = `${subtotal}|${code ?? ''}|${payableBeforeWallet.toFixed(2)}`;
      if (!force && key === lastPreviewKey.current) return null;
      lastPreviewKey.current = key;
      try {
        const r = await previewCheckoutRewards({ subtotal, couponCode: code, payableBeforeWallet });
        if (key !== lastPreviewKey.current) return null; // a newer preview started
        setPreview(r);
        if (code && r.coupon && !r.coupon.valid) {
          // Invalid for this cart: show why and stop sending it.
          setCouponError(r.coupon.error || 'This coupon cannot be used on this order');
          setAppliedCode(null);
        }
        return r;
      } catch (e) {
        if (code) setCouponError(errorMessage(e, 'Could not check the coupon'));
        return null;
      }
    },
    [subtotal],
  );

  const applyCoupon = async (code: string) => {
    const c = code.trim().toUpperCase();
    if (!cityId || !c) return;
    setValidatingCoupon(true);
    setCouponError(null);
    setAppliedCode(c);
    await runPreview(c, payableEstimateRef.current, true);
    setValidatingCoupon(false);
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

  // Items - instant discount + delivery + handling, before the wallet.
  const payableBeforeWallet = Math.max(subtotal - discount + (deliveryFee ?? 0) + handlingFee, 0);
  const payableEstimateRef = useRef(payableBeforeWallet);
  payableEstimateRef.current = payableBeforeWallet;
  const wallet = preview?.wallet ?? null;
  const showWallet = !!wallet && wallet.enabled && wallet.balance > 0;
  const walletApplied = showWallet && useWallet ? Math.min(wallet.usable, payableBeforeWallet) : 0;
  // Estimate only: after placing, the server's order.total_amount is what is charged.
  const total = deliveryFee != null ? Math.max(payableBeforeWallet - walletApplied, 0) : null;

  // Refresh the coupon/wallet preview when the cart, coupon or bill changes (debounced 400 ms).
  useEffect(() => {
    if (subtotal <= 0 || loadingDelivery) return;
    const t = setTimeout(() => void runPreview(appliedCode, payableBeforeWallet), 400);
    return () => clearTimeout(t);
  }, [subtotal, appliedCode, payableBeforeWallet, loadingDelivery, runPreview]);

  // Removing unavailable items is always possible; placing the order needs everything below.
  const removeMode = unavailable.length > 0 && !hotelClosed;
  const disabled = removeMode
    ? placing || !allChecked
    : placing ||
    loadingDelivery ||
    loadingCart ||
    !allChecked ||
    !!hotelClosed ||
    !deliveryAvailable ||
    (deliveryType === 'scheduled' && !matchedSlot) ||
    expressMinNotMet ||
    !addressId ||
    !cityId ||
    subtotal <= 0;

  const bottomNotice = useMemo(() => {
    if (placementError) return placementError;
    if (hotelClosed) return hotelClosed;
    if (unavailable.length) {
      return `${unavailable.length} item${unavailable.length > 1 ? 's are' : ' is'} not available right now and will not be ordered`;
    }
    if (!deliveryAvailable && !loadingDelivery) return "Delivery isn't currently available in your area";
    if (expressMinNotMet) return `Minimum order ${rupees(express?.min_order_amount)} required for Express Delivery`;
    return null;
  }, [placementError, hotelClosed, unavailable.length, deliveryAvailable, loadingDelivery, expressMinNotMet, express]);

  async function runUpiPayment(orderId: string, orderNumber: string) {
    setPlacingMsg('Initiating UPI payment...');
    const rp = await createRazorpayOrder(orderId);
    const result = await openUpiCheckout({ order: rp, orderNumber, phone: userPhone, email: userEmail });
    if (result.kind !== 'success') {
      // The payment may still have gone through in the UPI app: ask Razorpay before saying it failed.
      setPlacingMsg('Checking payment status...');
      if ((await syncRazorpayPayment(orderId)) === 'paid') {
        toast('Payment received!');
        navigate(`/orders/${orderId}`, { replace: true });
        return;
      }
    }
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
    // Also confirms with Razorpay directly, in case the verification request did not get through.
    const synced = await syncRazorpayPayment(orderId);
    if (!ok && synced !== 'paid') {
      setPlacementError(PAYMENT_VERIFY_FAILED);
      toast(PAYMENT_VERIFY_FAILED);
    }
    navigate(`/orders/${orderId}`, { replace: true });
  }

  async function onPlaceOrder() {
    if (!isLoggedIn || !userId) return navigate('/auth');
    if (hotelClosed) return toast(hotelClosed);
    if (unavailable.length) {
      // One tap removes them; the customer then sees the new total before placing the order.
      const n = unavailable.length;
      removeUnavailable();
      setPlacementError(null);
      toast(`Removed ${n} unavailable item${n > 1 ? 's' : ''}. Please check the new total.`);
      return;
    }
    if (!addressId) return toast('Please select or add a delivery address');
    if (!cityId) return toast('Please select a serviceable city');
    if (!deliveryAvailable) return toast("Delivery isn't currently available in your area");
    if (expressMinNotMet) return toast(`Minimum order ${rupees(express?.min_order_amount)} required for Express Delivery`);

    setPlacing(true);
    setPlacingMsg('Placing Order...');
    setPlacementError(null);
    try {
      // placeOrder checks maintenance mode itself right before checkout (no separate request here).
      // Only lines checked as available right now are sent.
      const order = await placeOrder({
        userId,
        isHotel,
        vendorId: hotelVendorId,
        addressId,
        paymentMethod: payment,
        couponCode: previewCoupon ? appliedCode : null,
        items: available.map((l) => l.cartItem),
        useWallet: walletApplied > 0,
      });
      // The server's total is the truth; if it differs from the estimate, show it before paying.
      const serverTotal = Number(order.total_amount ?? 0);
      const differs = total != null && serverTotal > 0 && Math.abs(serverTotal - total) > 1;
      if (differs) void runPreview(previewCoupon ? appliedCode : null, payableBeforeWallet, true);
      if (payment === 'upi' && differs) {
        setConfirmPay(order);
        return;
      }
      if (differs) toast(`Order placed. Amount to pay: ${rupees(serverTotal, 2)}`);
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
      // An item changed in the last seconds: back to the cart, refreshed, with that item highlighted.
      if (isItemAvailabilityError(msg)) {
        toast(msg);
        navigate('/cart', { replace: true, state: { checkoutError: msg, isHotel } satisfies CartNavState });
        return;
      }
      // Server rejected the coupon (no order created): drop it so the order can be placed without it.
      if (appliedCode && /coupon|minimum order amount/i.test(msg)) {
        setAppliedCode(null);
        setCouponError(msg);
      }
      // Wallet balance changed (used elsewhere / expired): refresh what can be used.
      if (/wallet/i.test(msg)) void runPreview(previewCoupon ? appliedCode : null, payableBeforeWallet, true);
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
  // Only once the saved cart is synced (a reloaded checkout starts with this device's copy).
  if (cartHydrated && cart.length === 0 && !placing) return <Navigate to="/cart" replace />;

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
            {previewCoupon ? (
              <div className="coupon-applied">
                <span className="row gap-8">
                  <CheckCircle2 size={20} className="text-primary" />
                  <span>
                    <strong className="block">Coupon {previewCoupon.code} Applied!</strong>
                    {isCashback ? (
                      <span className="small cashback-text">
                        🎁 {rupees(cashback, 2)} cashback after delivery
                        {previewCoupon.cashback_valid_days ? ` (valid ${previewCoupon.cashback_valid_days} days)` : ''}
                      </span>
                    ) : (
                      <span className="small text-primary">You save {rupees(discount, 2)}</span>
                    )}
                  </span>
                </span>
                <button
                  className="btn btn-text text-danger"
                  onClick={() => {
                    setAppliedCode(null);
                    setCouponInput('');
                    setCouponError(null);
                  }}
                >
                  Remove
                </button>
              </div>
            ) : null}
            {previewCoupon && isCashback && (
              // Kannada note so customers know the bill is not reduced now.
              <p className="cashback-kn" lang="kn">
                ಈ ಕೂಪನ್‌ನಿಂದ ಈಗ ಬಿಲ್‌ನಲ್ಲಿ ರಿಯಾಯಿತಿ ಇಲ್ಲ. ನಿಮ್ಮ ಆರ್ಡರ್ ಡೆಲಿವರಿ ಆದ ನಂತರ {rupees(cashback, 2)} ಕ್ಯಾಶ್‌ಬ್ಯಾಕ್ ನಿಮ್ಮ
                Sndmart ವಾಲೆಟ್‌ಗೆ ಜಮೆಯಾಗುತ್ತದೆ.
              </p>
            )}
            {previewCoupon ? null : (
              <>
                <div className="row gap-8">
                  <input
                    className="input grow"
                    placeholder="Enter Coupon Code"
                    value={couponInput}
                    onChange={(e) => {
                      setCouponInput(e.target.value.toUpperCase());
                      setCouponError(null);
                    }}
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
          {showWallet && wallet && (
            <section className="card pad wallet-use">
              <label className={`row gap-8 align-start${wallet.usable > 0 ? '' : ' disabled'}`}>
                <input
                  type="checkbox"
                  checked={useWallet && wallet.usable > 0}
                  disabled={wallet.usable <= 0}
                  onChange={(e) => setUseWallet(e.target.checked)}
                />
                <span>
                  <strong className="row gap-4">
                    <WalletIcon size={16} /> Use Wallet Balance
                  </strong>
                  <span className="small block">
                    {wallet.usable > 0
                      ? `Use ${rupees(wallet.usable, 2)} from wallet (Balance ${rupees(wallet.balance, 2)})`
                      : `Balance ${rupees(wallet.balance, 2)}`}
                  </span>
                  {wallet.usable <= 0 && wallet.reason && <span className="muted small block">{wallet.reason}</span>}
                  <span className="muted small block">Up to {Math.trunc(wallet.max_use_percent)}% of item total per order</span>
                </span>
              </label>
            </section>
          )}
          <section className="card pad">
            <h3>Bill Details</h3>
            {loadingCart && fresh.length === 0 ? (
              <div className="center-pad">
                <Spinner />
              </div>
            ) : (
              <>
                {fresh.map((i) =>
                  i.state === 'ok' && !hotelClosed ? (
                    <BillRow key={i.key} label={`${i.displayName} × ${i.cartItem.quantity}`} value={rupees(i.totalPrice)} />
                  ) : (
                    <BillRow
                      key={i.key}
                      label={<span className="bill-unavailable">{`${i.displayName} × ${i.cartItem.quantity}`}</span>}
                      value={<span className="text-danger small">{hotelClosed ? 'Closed' : i.label}</span>}
                    />
                  ),
                )}
                <hr />
                <BillRow label="Item total" value={rupees(subtotal, 2)} />
                {discount > 0 && <BillRow label={`Coupon discount (${previewCoupon?.code})`} value={`−${rupees(discount, 2)}`} accent />}
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
                {walletApplied > 0 && <BillRow label="Wallet" value={`−${rupees(walletApplied, 2)}`} accent />}
                <hr />
                <BillRow label="To Pay" value={total != null && deliveryAvailable ? rupees(total, 2) : '--'} bold accent />
                {cashback > 0 && <p className="small cashback-text bold">🎁 {rupees(cashback, 2)} cashback after delivery</p>}
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
              ) : hotelClosed ? (
                'Hotel is closed'
              ) : unavailable.length ? (
                'Remove unavailable items & continue'
              ) : (
                `${payment === 'upi' ? 'Pay via UPI' : 'Confirm & Place Order'}${total != null ? ` • ${rupees(total)}` : ''}`
              )}
            </button>
          </div>
        </aside>
      </div>

      <Modal
        open={!!confirmPay}
        onClose={() => {
          const o = confirmPay;
          setConfirmPay(null);
          if (o) navigate(`/orders/${o.id}`, { replace: true });
        }}
        title="Amount to pay"
      >
        {confirmPay && (
          <div className="stack-sm center-col">
            <p className="center">
              Your order {confirmPay.order_number} is placed. The final amount to pay is{' '}
              <strong>{rupees(confirmPay.total_amount, 2)}</strong>.
            </p>
            <button
              className="btn btn-primary btn-lg w-full"
              onClick={async () => {
                const o = confirmPay;
                setConfirmPay(null);
                setPlacing(true);
                try {
                  await runUpiPayment(o.id, o.order_number || o.id);
                } catch (e) {
                  toast(errorMessage(e, 'Could not start payment. Please try again.'));
                  navigate(`/orders/${o.id}`, { replace: true });
                } finally {
                  setPlacing(false);
                }
              }}
            >
              Pay {rupees(confirmPay.total_amount, 2)} via UPI
            </button>
          </div>
        )}
      </Modal>

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
