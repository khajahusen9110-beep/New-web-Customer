import { fallbackToOriginal, imageSrcSet, resizedImage } from '../lib/images';
import { useEffect, useState, type ReactNode } from 'react';
import { create } from 'zustand';
import { useNavigate } from 'react-router-dom';
import { AlertCircle, ArrowLeft, ArrowRight, ChevronDown, Minus, Plus, Utensils, X } from 'lucide-react';
import { rupees } from '../lib/utils';
import { usePromoFor, offerPrice, type PromoKind } from '../lib/promo';
import { feedback } from '../lib/feedback';

// ---------- Toast (Snackbar) ----------

interface ToastState {
  message: string | null;
  id: number;
  show: (m: string) => void;
  hide: () => void;
}

export const useToast = create<ToastState>()((set) => ({
  message: null,
  id: 0,
  show: (message) => set((s) => ({ message, id: s.id + 1 })),
  hide: () => set({ message: null }),
}));

export const toast = (m: string) => useToast.getState().show(m);

export function ToastHost() {
  const { message, id, hide } = useToast();
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(hide, 3500);
    return () => clearTimeout(t);
  }, [message, id, hide]);
  if (!message) return null;
  return (
    <div className="toast" role="status" onClick={hide}>
      {message}
    </div>
  );
}

// ---------- Layout ----------

export function PageHeader({
  title,
  subtitle,
  back = true,
  onBack,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  back?: boolean;
  onBack?: () => void;
  actions?: ReactNode;
}) {
  const navigate = useNavigate();
  return (
    <header className="page-header">
      {back && (
        <button className="icon-btn" aria-label="Back" onClick={onBack ?? (() => navigate(-1))}>
          <ArrowLeft size={22} />
        </button>
      )}
      <div className="page-header-title">
        <h1>{title}</h1>
        {subtitle && <div className="muted small">{subtitle}</div>}
      </div>
      <div className="page-header-actions">{actions}</div>
    </header>
  );
}

export function Spinner({ size = 28, light = false }: { size?: number; light?: boolean }) {
  return (
    <span
      className={`spinner${light ? ' spinner-light' : ''}`}
      style={{ width: size, height: size }}
      aria-label="Loading"
    />
  );
}

export function CenterSpinner() {
  return (
    <div className="center-fill">
      <Spinner size={36} />
    </div>
  );
}

export function ErrorCard({ message, onRetry, retryLabel = 'Retry' }: { message: string; onRetry?: () => void; retryLabel?: string }) {
  return (
    <div className="error-card">
      <AlertCircle size={30} className="text-danger" />
      <strong className="text-danger">Something went wrong</strong>
      <p className="muted small">{message}</p>
      {onRetry && (
        <button className="btn btn-primary btn-sm" onClick={onRetry}>
          {retryLabel}
        </button>
      )}
    </div>
  );
}

export function EmptyState({ icon, title, text, action }: { icon: ReactNode; title: string; text?: string; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      {text && <p className="muted small">{text}</p>}
      {action}
    </div>
  );
}

// ---------- Modal / bottom sheet ----------

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  wide = false,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    document.body.classList.add('no-scroll');
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.classList.remove('no-scroll');
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? ' modal-wide' : ''}`} role="dialog" aria-modal="true">
        {title && (
          <div className="modal-head">
            <h2>{title}</h2>
            <button className="icon-btn" aria-label="Close" onClick={onClose}>
              <X size={20} />
            </button>
          </div>
        )}
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  open,
  title,
  text,
  confirmLabel,
  cancelLabel = 'Cancel',
  danger,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  text: string;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      footer={
        <>
          <button className="btn btn-text" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </>
      }
    >
      <p>{text}</p>
    </Modal>
  );
}

// ---------- Commerce widgets ----------

export function QuantityStepper({
  quantity,
  onIncrease,
  onDecrease,
  full = false,
}: {
  quantity: number;
  onIncrease: () => void;
  onDecrease: () => void;
  full?: boolean;
}) {
  const inc = () => {
    feedback.add();
    onIncrease();
  };
  const dec = () => {
    feedback.remove();
    onDecrease();
  };
  if (quantity === 0) {
    return (
      <button data-fb="none" className={`btn btn-sm stepper-add${full ? ' w-full' : ''}`} onClick={inc}>
        ADD <Plus size={15} strokeWidth={3} />
      </button>
    );
  }
  return (
    <div data-fb="none" className={`stepper${full ? ' w-full' : ''}`}>
      <button aria-label="Decrease" onClick={dec}>
        <Minus size={16} strokeWidth={3} />
      </button>
      <span key={quantity} className="stepper-qty">{quantity}</span>
      <button aria-label="Increase" onClick={inc}>
        <Plus size={16} strokeWidth={3} />
      </button>
    </div>
  );
}

export function PriceDisplay({ price, mrp, unit, kind }: { price: number; mrp?: number | null; unit?: string | null; kind?: PromoKind }) {
  const promo = usePromoFor(kind);
  // Active offer: show the discounted price, with the original struck through and a % badge.
  // The % comes from the backend (promo_campaigns) — change it once and it updates everywhere.
  if (promo && promo.percent > 0) {
    const np = offerPrice(price, promo.percent);
    return (
      <div className="price-row">
        <span className="price offer-price">{rupees(np)}</span>
        <span className="mrp">{rupees(price)}</span>
        <span className="off-badge">{Math.round(promo.percent)}% OFF</span>
        {unit && <span className="muted small">/ {unit}</span>}
      </div>
    );
  }
  const off = mrp && mrp > price ? Math.floor(((mrp - price) / mrp) * 100) : 0;
  return (
    <div className="price-row">
      <span className="price">{rupees(price)}</span>
      {mrp != null && mrp > price && <span className="mrp">{rupees(mrp)}</span>}
      {off > 0 && <span className="off-badge">{off}% OFF</span>}
      {unit && <span className="muted small">/ {unit}</span>}
    </div>
  );
}

export function ProductImage({
  url,
  alt,
  grayscale = false,
  width = 160,
  priority = false,
}: {
  url?: string | null;
  alt: string;
  grayscale?: boolean;
  /** About how wide it is shown, in CSS pixels (picks the resized image). */
  width?: number;
  /** Above the fold: load right away instead of lazily. */
  priority?: boolean;
}) {
  if (!url) {
    return (
      <div className="img-fallback">
        <Utensils size={30} />
      </div>
    );
  }
  // Lazy + async decode: off-screen images are not downloaded until scrolled near, and decoding
  // never blocks scrolling.
  return (
    <img
      className={`cover-img${grayscale ? ' grayscale' : ''}`}
      src={resizedImage(url, width)}
      srcSet={imageSrcSet(url, width)}
      alt={alt}
      loading={priority ? 'eager' : 'lazy'}
      {...(priority ? { fetchpriority: 'high' } : {})}
      decoding="async"
      onError={fallbackToOriginal(url)}
    />
  );
}

/** Plain image from Supabase Storage, resized for about `width` CSS pixels (category/dish icons). */
export function ResizedImg({ url, width, alt = '' }: { url: string; width: number; alt?: string }) {
  return (
    <img
      src={resizedImage(url, width)}
      srcSet={imageSrcSet(url, width)}
      alt={alt}
      loading="lazy"
      decoding="async"
      onError={fallbackToOriginal(url)}
    />
  );
}

export function BillRow({ label, value, bold, accent }: { label: ReactNode; value: ReactNode; bold?: boolean; accent?: boolean }) {
  return (
    <div className={`bill-row${bold ? ' bold' : ''}`}>
      <span>{label}</span>
      <span className={accent ? 'text-primary' : ''}>{value}</span>
    </div>
  );
}

/**
 * Handling Fee + Platform Fee, collapsed behind a "Taxes & Charges" toggle row by default
 * (their sum shown collapsed) — tap to expand and see each one, like Swiggy/Zomato.
 */
export function FeesBreakdownRow({ handlingFee, platformFee }: { handlingFee: number; platformFee?: number | null }) {
  const [open, setOpen] = useState(false);
  const pf = platformFee ?? 0;
  const total = handlingFee + pf;
  return (
    <div className="fees-breakdown">
      <button type="button" className="bill-row fees-toggle" onClick={() => setOpen((v) => !v)}>
        <span className="fees-toggle-label">
          Taxes & Charges
          <ChevronDown size={14} className={`fees-toggle-chevron${open ? ' open' : ''}`} />
        </span>
        <span>{rupees(total)}</span>
      </button>
      {open && (
        <div className="fees-breakdown-detail">
          <BillRow label="Handling Fee" value={rupees(handlingFee)} />
          {pf > 0 && <BillRow label="Platform Fee" value={rupees(pf)} />}
        </div>
      )}
    </div>
  );
}

export function FloatingCartButton({
  itemCount,
  total,
  onClick,
  freeDeliveryAt,
}: {
  itemCount: number;
  total: number;
  onClick: () => void;
  /** City's free-delivery order amount; shows a progress strip towards it when set. */
  freeDeliveryAt?: number | null;
}) {
  if (itemCount <= 0) return null;
  const goal = freeDeliveryAt != null && freeDeliveryAt > 0 ? freeDeliveryAt : null;
  const left = goal != null ? Math.max(0, Math.ceil(goal - total)) : 0;
  const pct = goal != null ? Math.min(100, Math.round((total / goal) * 100)) : 0;
  return (
    <div className="floating-cart-box">
      {goal != null && (
        <div className={`fd-progress${left === 0 ? ' done' : ''}`}>
          <span className="fd-progress-text">
            {left === 0 ? (
              <>🎉 FREE delivery amount reached</>
            ) : (
              <>
                Add <strong>{rupees(left)}</strong> more for FREE delivery
              </>
            )}
          </span>
          <span className="fd-progress-bar">
            <i style={{ width: `${pct}%` }} />
          </span>
        </div>
      )}
      <button className="floating-cart" onClick={onClick}>
        <span key={itemCount} className="floating-cart-count">
          {itemCount} item{itemCount > 1 ? 's' : ''} • {rupees(total)}
        </span>
        <span className="row gap-6">
          Checkout <ArrowRight size={20} />
        </span>
      </button>
    </div>
  );
}

/** First-load screen: the brand mark breathing, instead of a bare spinner. */
export function BrandSplash() {
  return (
    <div className="brand-splash" role="status" aria-label="Loading Sndmart">
      <img src="/sndmart-icon.jpg" alt="" />
      <strong>Sndmart</strong>
      <span className="brand-splash-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
    </div>
  );
}

// ---------- Skeletons ----------

export function GridSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="product-grid">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="card skeleton-card">
          <div className="skeleton" style={{ height: 115 }} />
          <div className="skeleton" style={{ height: 14, width: '70%' }} />
          <div className="skeleton" style={{ height: 14, width: '40%' }} />
          <div className="skeleton" style={{ height: 32 }} />
        </div>
      ))}
    </div>
  );
}

export function ListSkeleton({ count = 4, height = 96 }: { count?: number; height?: number }) {
  return (
    <div className="stack">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="skeleton" style={{ height, borderRadius: 16 }} />
      ))}
    </div>
  );
}

// ---------- Order placed celebration ----------

interface OrderSuccessState {
  shownAt: number | null;
  show: () => void;
  hide: () => void;
}

export const useOrderSuccess = create<OrderSuccessState>()((set) => ({
  shownAt: null,
  show: () => set({ shownAt: Date.now() }),
  hide: () => set({ shownAt: null }),
}));

/** Call right after the server confirms the order (or the payment): chime + full-screen tick. */
export function celebrateOrder() {
  feedback.success();
  useOrderSuccess.getState().show();
}

const CONFETTI = Array.from({ length: 26 }, (_, i) => i);
const CONFETTI_COLORS = ['#7c4dff', '#22c55e', '#f59e0b', '#ef4444', '#06b6d4', '#ec4899'];

/** Full-screen "Order placed" moment: drawn tick, confetti burst, then fades by itself. */
export function OrderSuccessOverlay() {
  const shownAt = useOrderSuccess((s) => s.shownAt);
  const hide = useOrderSuccess((s) => s.hide);
  useEffect(() => {
    if (!shownAt) return;
    const t = setTimeout(hide, 2600);
    return () => clearTimeout(t);
  }, [shownAt, hide]);
  if (!shownAt) return null;
  return (
    <div className="order-success" role="status" aria-live="polite" onClick={hide}>
      <div className="order-success-burst" aria-hidden="true">
        {CONFETTI.map((i) => (
          <i
            key={i}
            style={{
              ['--a' as string]: `${(360 / CONFETTI.length) * i}deg`,
              ['--d' as string]: `${90 + ((i * 37) % 80)}px`,
              ['--c' as string]: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
              animationDelay: `${0.35 + (i % 5) * 0.03}s`,
            }}
          />
        ))}
      </div>
      <svg className="order-success-tick" viewBox="0 0 96 96" aria-hidden="true">
        <circle cx="48" cy="48" r="44" />
        <path d="M28 49.5 42 63l27-29" />
      </svg>
      <div className="order-success-title">Order Placed!</div>
      <div className="order-success-sub">ನಿಮ್ಮ ಆರ್ಡರ್ ಯಶಸ್ವಿಯಾಗಿದೆ</div>
    </div>
  );
}
