import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Bell, ChevronDown, MapPin, Menu, MessageCircle, Search, ShoppingCart, SlidersHorizontal, UtensilsCrossed, Wrench, X } from 'lucide-react';
import { useSession } from '../store/session';
import { openCityPicker } from './CityPicker';

// The top of the home screens in the new look (same as the Android app): purple header (menu, city, logo, bell, WhatsApp),
// Grocery / Food tabs with a pointer, a white pill search box and a "Shop Categories" style heading.
// Used by the Grocery (Stores) page and by the Food / old Grocery home.

const SUPPORT_BOT_WHATSAPP = '917899787976';

/** Opens the SND Mart WhatsApp chat. */
export function openSupportWhatsApp() {
  window.open(`https://wa.me/${SUPPORT_BOT_WHATSAPP}?text=${encodeURIComponent('Hi SND Mart')}`, '_blank', 'noopener');
}

/** Purple bar: menu (or a back arrow) · city picker · SND Mart logo · bell with count · WhatsApp. */
export function HomeBrandHeader({
  onMenu, onBack, backLabel,
}: { onMenu: () => void; onBack?: () => void; backLabel?: string }) {
  const navigate = useNavigate();
  const city = useSession((s) => s.selectedCity);
  const unread = useSession((s) => s.unreadNotificationCount);
  return (
    <header className="brand-header" data-testid="home-brand-header">
      {onBack ? (
        <button className="bh-btn" aria-label={backLabel ?? 'Back'} onClick={onBack}><ArrowLeft size={24} /></button>
      ) : (
        <button className="bh-btn" aria-label="Menu" onClick={onMenu}><Menu size={26} /></button>
      )}
      <button className="bh-city" onClick={openCityPicker} aria-label="Change city">
        <MapPin size={19} />
        <span className="bh-city-name">{city?.name ?? 'Select city'}</span>
        <ChevronDown size={18} />
      </button>
      <span className="bh-spacer" />
      <span className="bh-logo" aria-label="SND Mart">
        <img src="/icon-192.png" alt="" />
        <span className="bh-wordmark"><b>SND</b><b className="mart">Mart</b></span>
      </span>
      <span className="bh-spacer" />
      <button className="bh-btn" aria-label="Notifications" onClick={() => navigate('/notifications')}>
        <Bell size={24} />
        {unread > 0 && <span className="bh-badge">{unread > 99 ? '99+' : unread}</span>}
      </button>
      <button className="bh-btn" aria-label="Chat with us on WhatsApp" onClick={openSupportWhatsApp}><MessageCircle size={24} /></button>
    </header>
  );
}

/** Grocery / Food tabs (and Quick Helper when the city has it); the chosen one is purple with a pointer under it. */
export function HomeModeTabs({
  foodSelected, helperOn, groceryEnabled = true, foodEnabled = true, onGrocery, onFood, onHelper,
}: {
  foodSelected: boolean; helperOn: boolean; groceryEnabled?: boolean; foodEnabled?: boolean;
  onGrocery: () => void; onFood: () => void; onHelper: () => void;
}) {
  const Tab = ({ icon, title, sub, selected, enabled = true, onClick, id }: { icon: ReactNode; title: string; sub: string; selected: boolean; enabled?: boolean; onClick: () => void; id: string }) => (
    <button className={`mt-tab${selected ? ' selected' : ''}`} disabled={!enabled} onClick={onClick} data-testid={id} aria-pressed={selected}>
      <span className="mt-icon">{icon}</span>
      <span className="mt-text"><b>{title}</b><small>{enabled ? sub : 'Coming soon'}</small></span>
    </button>
  );
  return (
    <div className={`mode-tabs${helperOn ? ' three' : ''}`} data-testid="home-mode-tabs">
      <Tab id="toggle-grocery" icon={<ShoppingCart size={24} />} title="Grocery" sub="Daily Needs" selected={!foodSelected} enabled={groceryEnabled} onClick={onGrocery} />
      <Tab id="toggle-hotels" icon={<UtensilsCrossed size={24} />} title="Food" sub={helperOn ? 'Hot meals' : 'Delicious Food'} selected={foodSelected} enabled={foodEnabled} onClick={onFood} />
      {helperOn && <Tab id="toggle-helper" icon={<Wrench size={24} />} title="Helper" sub="Any request" selected={false} onClick={onHelper} />}
    </div>
  );
}

/** White pill search box; the filter button shows only when [onFilter] is given and nothing is typed. */
export function HomePillSearch({
  value, onChange, hint, onFilter, filterActive, label,
}: { value: string; onChange: (v: string) => void; hint: string; onFilter?: () => void; filterActive?: boolean; label?: string }) {
  return (
    <div className="pill-search">
      <Search size={20} />
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={hint} aria-label={label ?? 'Search'} />
      {value ? (
        <button className="icon-btn sm" aria-label="Clear search" onClick={() => onChange('')}><X size={16} /></button>
      ) : onFilter ? (
        <button className={`icon-btn sm${filterActive ? ' on' : ''}`} aria-label="Filters" onClick={onFilter}><SlidersHorizontal size={19} /></button>
      ) : null}
    </div>
  );
}

/** "Shop Categories" heading with a "See All →" link. */
export function HomeSectionHeader({ title, action = 'See All', onAction }: { title: string; action?: string | null; onAction?: () => void }) {
  return (
    <div className="hs-header">
      <h3>{title}</h3>
      {action && <button className="hs-see-all" onClick={onAction}>{action} →</button>}
    </div>
  );
}

/** The menu that opens from the header: a list of rows in a bottom sheet. */
export function HomeMenuSheet({ open, items, onClose }: { open: boolean; items: { label: string; onClick: () => void }[]; onClose: () => void }) {
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="menu-sheet-backdrop" onClick={onClose} role="presentation">
      <div className="menu-sheet" role="dialog" aria-label="Menu" onClick={(e) => e.stopPropagation()} data-testid="home-menu-sheet">
        {items.map((it) => (
          <button key={it.label} className="menu-sheet-row" onClick={() => { onClose(); it.onClick(); }}>{it.label}</button>
        ))}
      </div>
    </div>
  );
}

/** A small hook for the menu's open state. */
export function useOpen(): [boolean, () => void, () => void] {
  const [o, set] = useState(false);
  return [o, () => set(true), () => set(false)];
}
