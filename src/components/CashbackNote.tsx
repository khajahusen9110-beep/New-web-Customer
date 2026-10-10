import type { Order } from '../lib/types';
import { rupees } from '../lib/utils';

/** Cashback / wallet status line for an order (shared with the orders list). */
export function CashbackNote({ order }: { order: Order }) {
  const cashback = Number(order.cashback_amount ?? 0);
  const walletUsed = Number(order.wallet_used_amount ?? 0);
  const status = order.status?.toLowerCase();
  const cancelled = status === 'cancelled' || status === 'rejected';
  if (cancelled) {
    if (cashback <= 0 && walletUsed <= 0) return null;
    return (
      <p className="small muted mt-8">
        {cashback > 0 && 'Cashback cancelled. '}
        {walletUsed > 0 && `${rupees(walletUsed, 2)} returned to your wallet.`}
      </p>
    );
  }
  if (cashback <= 0) return null;
  return (
    <p className="small bold cashback-text mt-8">
      {status === 'delivered'
        ? `✅ ${rupees(cashback, 2)} cashback added to wallet`
        : `🎁 ${rupees(cashback, 2)} cashback after delivery`}
    </p>
  );
}
