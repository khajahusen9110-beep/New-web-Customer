import { Construction, RefreshCw } from 'lucide-react';
import { Spinner } from '../components/ui';

export default function MaintenancePage({
  message,
  isChecking,
  onRetry,
  onDismiss,
}: {
  message: string;
  isChecking: boolean;
  onRetry: () => void;
  onDismiss?: () => void;
}) {
  return (
    <div className="center-fill pad">
      <div className="maintenance">
        <div className="hero-circle warning">
          <Construction size={48} />
        </div>
        <h1>Under Maintenance</h1>
        <div className="card pad center">
          <p className="bold">{message || 'Service temporarily unavailable. Please try again shortly.'}</p>
          <p className="muted small">
            We are performing routine maintenance to improve service quality and performance. Thank you for your patience.
          </p>
        </div>
        <button className="btn btn-primary btn-lg w-full" disabled={isChecking} onClick={onRetry}>
          {isChecking ? (
            <>
              <Spinner size={20} light /> Checking Status...
            </>
          ) : (
            <>
              <RefreshCw size={18} /> Check Again
            </>
          )}
        </button>
        {onDismiss && (
          <button className="btn btn-outline w-full" onClick={onDismiss}>
            Go Back
          </button>
        )}
        <p className="muted small">Orders will resume as soon as maintenance concludes.</p>
      </div>
    </div>
  );
}
