import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, CheckCircle2, ShoppingCart, Trash2 } from 'lucide-react';
import { BillRow, CenterSpinner, EmptyState, ErrorCard, PageHeader, ProductImage, QuantityStepper, toast } from '../components/ui';
import { useFreshCart } from '../lib/hooks';
import { cartTotal, rupees } from '../lib/utils';
import { useSession } from '../store/session';
import { cartCount, useCart } from '../store/cart';

export default function CartPage() {
  const navigate = useNavigate();
  const city = useSession((s) => s.selectedCity);
  const { groceryCart, hotelCart, updateQuantity, clearCart } = useCart();
  const [isHotel, setIsHotel] = useState(() => cartCount(groceryCart) === 0 && cartCount(hotelCart) > 0);
  const items = isHotel ? hotelCart : groceryCart;
  const { fresh, loading, error, reload } = useFreshCart(items, city?.id);
  const subtotal = cartTotal(fresh);

  return (
    <div className="page">
      <PageHeader
        title="My Cart"
        back={false}
        actions={
          fresh.length > 0 && (
            <button
              className="icon-btn text-danger"
              aria-label="Clear cart"
              onClick={() => {
                clearCart(isHotel);
                toast('Cart cleared');
              }}
            >
              <Trash2 size={20} />
            </button>
          )
        }
      />
      <div className="content-pad narrow">
        <div className="segmented">
          <button className={!isHotel ? 'active' : ''} onClick={() => setIsHotel(false)}>
            Grocery Cart ({cartCount(groceryCart)})
          </button>
          <button className={isHotel ? 'active' : ''} onClick={() => setIsHotel(true)}>
            Hotel Cart ({cartCount(hotelCart)})
          </button>
        </div>

        {loading && fresh.length === 0 ? (
          <CenterSpinner />
        ) : error ? (
          <ErrorCard message={error} onRetry={reload} />
        ) : fresh.length === 0 ? (
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
            <div className="info-strip">
              <CheckCircle2 size={18} /> Prices verified live with {city?.name ?? 'your city'}'s current stock
            </div>
            {fresh.map((it) => (
              <div key={`${it.cartItem.product_id}_${it.cartItem.variant_id ?? 'base'}`} className="card cart-row">
                <div className="thumb">
                  <ProductImage url={it.product.imageUrl} alt={it.product.name} />
                </div>
                <div className="grow min-w-0">
                  <strong className="ellipsis block">{it.displayName}</strong>
                  <div className="muted small">
                    {rupees(it.effectivePrice)}
                    {!it.variant && it.product.unit ? ` / ${it.product.unit}` : ''}
                  </div>
                  <div className="small text-primary bold">Total: {rupees(it.totalPrice)}</div>
                </div>
                <QuantityStepper
                  quantity={it.cartItem.quantity}
                  onIncrease={() => updateQuantity(it.cartItem.product_id, isHotel, it.cartItem.quantity + 1, it.cartItem.variant_id)}
                  onDecrease={() => updateQuantity(it.cartItem.product_id, isHotel, it.cartItem.quantity - 1, it.cartItem.variant_id)}
                />
              </div>
            ))}
            <div className="card pad">
              <h3>Bill Details</h3>
              <BillRow label="Item Subtotal" value={rupees(subtotal, 2)} />
              <BillRow label="Delivery Fee" value={<span className="muted">Calculated at checkout</span>} />
              <hr />
              <BillRow label="Total to Pay" value={rupees(subtotal, 2)} bold accent />
            </div>
            <div className="sticky-bottom">
              <div>
                <div className="muted small">Total to Pay</div>
                <div className="total-big">{rupees(subtotal)}</div>
              </div>
              <button className="btn btn-primary btn-lg" onClick={() => navigate(`/checkout/${isHotel ? 'hotel' : 'grocery'}`)}>
                Proceed to Checkout <ArrowRight size={18} />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
