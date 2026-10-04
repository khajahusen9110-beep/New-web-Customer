import { useEffect, type ReactNode } from 'react';
import { create } from 'zustand';
import { useNavigate } from 'react-router-dom';
import { AlertCircle, ArrowLeft, ArrowRight, Minus, Plus, Utensils, X } from 'lucide-react';
import { rupees } from '../lib/utils';

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
  if (quantity === 0) {
    return (
      <button className={`btn btn-primary btn-sm stepper-add${full ? ' w-full' : ''}`} onClick={onIncrease}>
        <Plus size={16} /> ADD
      </button>
    );
  }
  return (
    <div className={`stepper${full ? ' w-full' : ''}`}>
      <button aria-label="Decrease" onClick={onDecrease}>
        <Minus size={16} />
      </button>
      <span>{quantity}</span>
      <button aria-label="Increase" onClick={onIncrease}>
        <Plus size={16} />
      </button>
    </div>
  );
}

export function PriceDisplay({ price, mrp, unit }: { price: number; mrp?: number | null; unit?: string | null }) {
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

export function ProductImage({ url, alt, grayscale = false }: { url?: string | null; alt: string; grayscale?: boolean }) {
  if (!url) {
    return (
      <div className="img-fallback">
        <Utensils size={30} />
      </div>
    );
  }
  // Lazy + async decode: off-screen images are not downloaded until scrolled near, and decoding
  // never blocks scrolling.
  return <img className={`cover-img${grayscale ? ' grayscale' : ''}`} src={url} alt={alt} loading="lazy" decoding="async" />;
}

export function BillRow({ label, value, bold, accent }: { label: ReactNode; value: ReactNode; bold?: boolean; accent?: boolean }) {
  return (
    <div className={`bill-row${bold ? ' bold' : ''}`}>
      <span>{label}</span>
      <span className={accent ? 'text-primary' : ''}>{value}</span>
    </div>
  );
}

export function FloatingCartButton({ itemCount, total, onClick }: { itemCount: number; total: number; onClick: () => void }) {
  if (itemCount <= 0) return null;
  return (
    <button className="floating-cart" onClick={onClick}>
      <span>
        {itemCount} item{itemCount > 1 ? 's' : ''} • {rupees(total)}
      </span>
      <span className="row gap-6">
        Checkout <ArrowRight size={20} />
      </span>
    </button>
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
