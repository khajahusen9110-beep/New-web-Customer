import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Wallet } from 'lucide-react';
import { ErrorCard, ListSkeleton, PageHeader, Spinner } from '../components/ui';
import { getWalletTransactions } from '../lib/repository';
import type { WalletTransaction } from '../lib/types';
import { errorMessage, rupees, shortDateTime } from '../lib/utils';
import { useSession } from '../store/session';

const PAGE = 20;

export default function WalletPage() {
  const userId = useSession((s) => s.userId);
  const [txns, setTxns] = useState<WalletTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (reset: boolean) => {
      if (!userId) return;
      if (reset) {
        setLoading(true);
        setError(null);
      } else setLoadingMore(true);
      try {
        const list = await getWalletTransactions(userId, PAGE, reset ? 0 : txns.length);
        setTxns((cur) => (reset ? list : [...cur, ...list]));
        setHasMore(list.length >= PAGE);
      } catch (e) {
        if (reset) setError(errorMessage(e));
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [userId, txns.length],
  );

  useEffect(() => {
    void load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  // Balance is derived from the loaded transactions, same as the app.
  const balance = Math.max(
    0,
    txns.reduce((acc, t) => (t.type.toLowerCase() === 'credit' ? acc + Number(t.amount) : acc - Number(t.amount)), 0),
  );

  return (
    <div className="page">
      <PageHeader
        title="My Wallet"
        actions={
          <button className="icon-btn" aria-label="Refresh" onClick={() => void load(true)}>
            <RefreshCw size={20} />
          </button>
        }
      />
      <div className="content-pad narrow">
        {loading && txns.length === 0 ? (
          <ListSkeleton count={3} />
        ) : error && txns.length === 0 ? (
          <ErrorCard message={error} onRetry={() => void load(true)} />
        ) : (
          <div className="stack">
            <div className="wallet-card">
              <span className="row gap-8 label-caps">
                <Wallet size={20} /> Sndmart wallet balance
              </span>
              <div className="wallet-balance">{rupees(balance, 2)}</div>
              <span className="small">Refunds from cancelled orders are credited here automatically.</span>
            </div>
            <h3>Transaction History</h3>
            {txns.length === 0 ? (
              <div className="card pad center muted">No wallet transactions recorded.</div>
            ) : (
              txns.map((t) => {
                const credit = t.type.toLowerCase() === 'credit';
                return (
                  <div key={t.id} className="card pad row between">
                    <span>
                      <strong className="block">{t.reason || (credit ? 'Wallet Credit' : 'Wallet Debit')}</strong>
                      {t.order_id && <span className="muted small block">Order #{t.order_id.slice(0, 8)}</span>}
                      {t.created_at && <span className="muted small block">{shortDateTime(t.created_at)}</span>}
                    </span>
                    <strong className={credit ? 'text-success' : 'text-danger'}>
                      {credit ? '+' : '-'}
                      {rupees(t.amount, 2)}
                    </strong>
                  </div>
                );
              })
            )}
            {hasMore && txns.length > 0 && (
              <div className="center-pad">
                {loadingMore ? (
                  <Spinner />
                ) : (
                  <button className="btn btn-outline" onClick={() => void load(false)}>
                    Load More Transactions (20)
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
