import { NavLink, Outlet } from 'react-router-dom';
import { ReceiptText, ShoppingCart, Store, User } from 'lucide-react';
import { useCart, cartCount } from '../store/cart';

const TABS = [
  { to: '/', label: 'Home', Icon: Store, end: true },
  { to: '/cart', label: 'Cart', Icon: ShoppingCart, end: false },
  { to: '/orders', label: 'Orders', Icon: ReceiptText, end: false },
  { to: '/profile', label: 'Profile', Icon: User, end: false },
];

function CartBadge() {
  const count = useCart((s) => cartCount(s.groceryCart) + cartCount(s.hotelCart));
  return count > 0 ? <span className="badge">{count}</span> : null;
}

/** Shell for the four top-level tabs: bottom bar on phones, top bar on desktop. */
export function TabLayout() {
  return (
    <div className="tab-layout">
      <nav className="desktop-nav">
        <div className="desktop-nav-inner">
          <NavLink to="/" className="brand">
            <img src="/sndmart-icon.jpg" alt="" />
            <span>Sndmart</span>
          </NavLink>
          <div className="desktop-links">
            {TABS.map(({ to, label, Icon, end }) => (
              <NavLink key={to} to={to} end={end} className="desktop-link">
                <span className="icon-wrap">
                  <Icon size={18} />
                  {to === '/cart' && <CartBadge />}
                </span>
                {label}
              </NavLink>
            ))}
          </div>
        </div>
      </nav>
      <main className="tab-content">
        <Outlet />
      </main>
      <nav className="bottom-nav">
        {TABS.map(({ to, label, Icon, end }) => (
          <NavLink key={to} to={to} end={end} className="bottom-link">
            <span className="icon-wrap">
              <Icon size={22} />
              {to === '/cart' && <CartBadge />}
            </span>
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

/** Shell for detail pages (no tab bar). */
export function PlainLayout() {
  return (
    <main className="plain-content">
      <Outlet />
    </main>
  );
}
