import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { AlertTriangle, ArrowRight, CheckCircle2, Info, RefreshCw, ShoppingCart, Trash2 } from 'lucide-react';
import { BillRow, CenterSpinner, EmptyState, ErrorCard, PageHeader, ProductImage, QuantityStepper, toast } from '../components/ui';
import { useCartCheck } from '../lib/hooks';
import { cartLineForError, rupees } from '../lib/utils';
import { useSession } from '../store/session';
import { cartCount, useCart } from '../store/cart';

/** Sent by checkout when the order was rejected because an item changed. */
export interface CartNavState {
  checkoutError?: string;
  isHotel?: boolean;
}

export default function CartPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const navState = (location.state ?? {}) as CartNavState;
  const city = useSession((s) => s.selectedCity);
  const { groceryCart, hotelCart, updateQuantity, removeItems, clearCart } = useCart();
  const [isHotel, setIsHotel] = useState(() =>
    navState.isHotel != null ? navState.isHotel : cartCount(groceryCart) === 0 && cartCount(hotelCart) > 0,
  );
  const [checkoutError, setCheckoutError] = useState<string | null>(navState.checkoutError ?? null);
  const items = isHotel ? hotelCart : groceryCart;
  const { lines, unavailable, subtotal, hotelClosed, allChecked, loading, error, reload, removeUnavailable } = useCartCheck(
    items,
    city?.id,
    isHotel,
  );

  // Clear the one-time error from history so a reload does not show it again.
  useEffect(() => {
    if (navState.checkoutError) navigate(location.pathname, { replace: true, state: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const flagged = checkoutError ? cartLineForError(checkoutError, lines) : null;
  // A line the checkout said is unavailable counts as unavailable until the customer removes it
  // (a stock error only highlights it: its quantity is lowered to the stock on refresh).
  const flaggedGone = !!flagged && /no longer available|not available in your city/i.test(checkoutError ?? '');
  const blocking =
    flagged && flaggedGone && !unavailable.some((l) => l.key === flagged.key) ? [...unavailable, flagged] : unavailable;
  const unavailableCount = blocking.length;

  const removeBlocking = () => {
    removeUnavailable();
    if (flagged) removeItems(isHotel, [flagged.cartItem]);
    setCheckoutError(null);
  };

  const proceed = () => {
    if (hotelClosed) return toast(hotelClosed);
    if (unavailableCount > 0) {
      const removedAll = unavailableCount === lines.length;
      removeBlocking();
      toast(`Removed ${unavailableCount} unavailable item${unavailableCount > 1 ? 's' : ''}`);
      if (removedAll) return;
    }
    navigate(`/checkout/${isHotel ? 'hotel' : 'grocery'}`);
  };

  return (
    <div className="page">
      <PageHeader
        title="My Cart"
        back={false}
        actions={
          lines.length > 0 && (
            <>
              <button className="icon-btn" aria-label="Refresh cart" onClick={reload} disabled={loading}>
                <RefreshCw size={20} className={loading ? 'spin' : undefined} />
              </button>
              <button
                className="icon-btn text-danger"
                aria-label="Clear cart"
                onClick={() => {
                  clearCart(isHotel);
                  setCheckoutError(null);
                  toast('Cart cleared');
                }}
              >
                <Trash2 size={20} />
              </button>
            </>
          )
        }
      />
      <div className="content-pad narrow">
        <div className="segmented">
          <button
            className={!isHotel ? 'active' : ''}
            onClick={() => {
              setIsHotel(false);
              setCheckoutError(null);
            }}
          >
            Grocery Cart ({cartCount(groceryCart)})
          </button>
          <button
            className={isHotel ? 'active' : ''}
            onClick={() => {
              setIsHotel(true);
              setCheckoutError(null);
            }}
          >
            Hotel Cart ({cartCount(hotelCart)})
          </button>
        </div>

        {loading && lines.length === 0 ? (
          <CenterSpinner />
        ) : error ? (
          <ErrorCard message={error} onRetry={reload} />
        ) : lines.length === 0 ? (
          <EmptyState
            icon={<ShoppingCart size={56} />}
            title={isHotel ? 'Your hotel cart is empty' : 'Your grocery cart is empty'}
            text="Explore items in your city and add them to cart."
            action={
              <button className="btn btn-primary" onClick={() => navigate(isHotel ? '/?mode=hotels' : '/')}>
                Start Shopping
              </button>
            }
          />
        ) : (
          <div className="stack">
            {checkoutError && (
              <div className="alert alert-danger" role="alert">
                <AlertTriangle size={20} /> {checkoutError}
              </div>
            )}
            {hotelClosed ? (
              <div className="alert alert-danger" role="alert">
                <Info size={20} /> {hotelClosed}
              </div>
            ) : unavailableCount > 0 ? (
              <div className="unavailable-banner" role="status">
                <span className="row gap-6">
                  <AlertTriangle size={18} />
                  <strong>
                    {unavailableCount} item{unavailableCount > 1 ? 's are' : ' is'} not available right now
                  </strong>
                </span>
                <button
                  className="btn btn-sm btn-danger"
                  onClick={() => {
                    removeBlocking();
                    toast('Unavailable items removed');
                  }}
                >
                  Remove unavailable items
                </button>
              </div>
            ) : (
              <div className="info-strip">
                <CheckCircle2 size={18} /> Prices verified live with {city?.name ?? 'your city'}'s current stock
              </div>
            )}
            {lines.map((it) => {
              const isFlagged = flagged?.key === it.key;
              const off = !!hotelClosed || it.state !== 'ok' || (isFlagged && flaggedGone);
              const label = hotelClosed ? null : it.state !== 'ok' ? it.label : isFlagged && flaggedGone ? 'Not available right now' : null;
              return (
                <div key={it.key} className={`card cart-row${off ? ' unavailable' : ''}${isFlagged ? ' flagged' : ''}`}>
                  <div className="thumb">
                    <ProductImage url={it.product.imageUrl} alt={it.product.name} />
                  </div>
                  <div className="grow min-w-0">
                    <strong className="ellipsis block">{it.displayName}</strong>
                    {it.state === 'ok' ? (
                      <>
                        <div className="muted small">
                          {rupees(it.effectivePrice)}
                          {!it.variant && it.product.unit ? ` / ${it.product.unit}` : ''}
                        </div>
                        <div className="small text-primary bold">Total: {rupees(it.totalPrice)}</div>
                      </>
                    ) : (
                      <div className="muted small">Qty {it.cartItem.quantity}</div>
                    )}
                    {label && <div className="small text-danger bold">{label}</div>}
                    {it.reducedTo != null && !label && (
                      <div className="small text-orange bold">Only {it.reducedTo} left - quantity updated</div>
                    )}
                  </div>
                  {it.state !== 'ok' || (isFlagged && flaggedGone) ? (
                    <button
                      className="btn btn-sm btn-danger-soft"
                      onClick={() => {
                        removeItems(isHotel, [it.cartItem]);
                        if (isFlagged) setCheckoutError(null);
                      }}
                    >
                      Remove
                    </button>
                  ) : (
                    <QuantityStepper
                      quantity={it.cartItem.quantity}
                      onIncrease={() => updateQuantity(it.cartItem.product_id, isHotel, it.cartItem.quantity + 1, it.cartItem.variant_id)}
                      onDecrease={() => updateQuantity(it.cartItem.product_id, isHotel, it.cartItem.quantity - 1, it.cartItem.variant_id)}
                    />
                  )}
                </div>
              );
            })}
            <div className="card pad">
              <h3>Bill Details</h3>
              <BillRow label="Item Subtotal" value={rupees(subtotal, 2)} />
              <BillRow label="Delivery Fee" value={<span className="muted">Calculated at checkout</span>} />
              <hr />
              <BillRow label="Total to Pay" value={rupees(subtotal, 2)} bold accent />
              {unavailableCount > 0 && !hotelClosed && <p className="muted small">Unavailable items are not included.</p>}
            </div>
            <div className="sticky-bottom">
              <div>
                <div className="muted small">Total to Pay</div>
                <div className="total-big">{rupees(subtotal)}</div>
              </div>
              <button className="btn btn-primary btn-lg" disabled={!!hotelClosed || !allChecked} onClick={proceed}>
                {hotelClosed ? (
                  'Hotel is closed'
                ) : unavailableCount > 0 ? (
                  'Remove unavailable items & continue'
                ) : (
                  <>
                    Proceed to Checkout <ArrowRight size={18} />
                  </>
                )}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
