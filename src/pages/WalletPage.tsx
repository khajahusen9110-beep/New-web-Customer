import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronDown, ChevronUp, Clock, Gift, RefreshCw, RotateCcw, ShoppingBag, Undo2, Wallet } from 'lucide-react';
import { ErrorCard, ListSkeleton, PageHeader, Spinner } from '../components/ui';
import { getMyWallet, getMyWalletHistory, getWalletTransactions } from '../lib/repository';
import type { MyWallet, WalletLedgerEntry, WalletTransaction } from '../lib/types';
import { errorMessage, rupees, shortDateTime } from '../lib/utils';
import { useSession } from '../store/session';

const PAGE = 30;

/** How each wallet history entry is shown. */
const ENTRY: Record<string, { label: string; sign: '+' | '−'; cls: string; Icon: typeof Gift }> = {
  cashback_credit: { label: 'Cashback received', sign: '+', cls: 'text-success', Icon: Gift },
  wallet_used: { label: 'Used on order', sign: '−', cls: 'text-danger', Icon: ShoppingBag },
  wallet_refund: { label: 'Refund (order cancelled)', sign: '+', cls: 'text-success', Icon: Undo2 },
  cashback_reversed: { label: 'Cashback reversed (order cancelled)', sign: '−', cls: 'text-danger', Icon: RotateCcw },
  expired: { label: 'Cashback expired', sign: '−', cls: 'muted', Icon: Clock },
};

const day = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '';

export default function WalletPage() {
  const navigate = useNavigate();
  const userId = useSession((s) => s.userId);
  const [wallet, setWallet] = useState<MyWallet | null>(null);
  const [history, setHistory] = useState<WalletLedgerEntry[]>([]);
  const [older, setOlder] = useState<WalletTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHow, setShowHow] = useState(false);

  const load = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    setError(null);
    try {
      const [w, h, old] = await Promise.all([
        getMyWallet(true),
        getMyWalletHistory(PAGE, null),
        getWalletTransactions(userId, 20, 0).catch(() => [] as WalletTransaction[]),
      ]);
      setWallet(w);
      setHistory(h);
      setHasMore(h.length >= PAGE);
      setOlder(old);
    } catch (e) {
      setError(errorMessage(e, 'Failed to load wallet'));
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadMore = async () => {
    const last = history[history.length - 1];
    if (!last) return;
    setLoadingMore(true);
    try {
      const more = await getMyWalletHistory(PAGE, last.created_at);
      setHistory((cur) => [...cur, ...more.filter((m) => !cur.some((c) => c.id === m.id))]);
      setHasMore(more.length >= PAGE);
    } catch {
      /* keep what is shown */
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="page">
      <PageHeader
        title="Sndmart Wallet"
        actions={
          <button className="icon-btn" aria-label="Refresh" onClick={() => void load()}>
            <RefreshCw size={20} />
          </button>
        }
      />
      <div className="content-pad narrow">
        {loading && !wallet ? (
          <ListSkeleton count={3} />
        ) : error && !wallet ? (
          <ErrorCard message={error} onRetry={() => void load()} />
        ) : wallet ? (
          <div className="stack">
            {!wallet.enabled && <div className="info-strip muted-strip">Wallet is paused right now</div>}

            <div className="wallet-card">
              <span className="row gap-8 label-caps">
                <Wallet size={20} /> Wallet balance
              </span>
              <div className="wallet-balance">{rupees(wallet.balance, 2)}</div>
              <span className="small">
                Cashback earned {rupees(wallet.total_cashback_earned, 2)} · Used {rupees(wallet.total_used, 2)}
              </span>
            </div>

            {wallet.expiring_soon && wallet.expiring_soon.amount > 0 && (
              <div className="free-banner">
                <Clock size={18} /> {rupees(wallet.expiring_soon.amount, 2)} expires on {day(wallet.expiring_soon.first_expiry)}. Use it on
                your next order!
              </div>
            )}

            {wallet.pending.length > 0 && (
              <section className="card pad">
                <h3>Pending cashback</h3>
                {wallet.pending.map((p, i) => (
                  <button
                    key={`${p.order_id ?? i}`}
                    className="wallet-row"
                    onClick={() => p.order_id && navigate(`/orders/${p.order_id}`)}
                    disabled={!p.order_id}
                  >
                    <Gift size={18} className="cashback-text" />
                    <span className="grow">
                      <strong>{rupees(p.amount, 2)}</strong>
                      {p.order_number ? ` · Order #${p.order_number}` : ''}
                      <span className="muted small block">Credited after delivery</span>
                    </span>
                  </button>
                ))}
              </section>
            )}

            {wallet.lots.length > 0 && (
              <section className="card pad">
                <h3>Available cashback</h3>
                {wallet.lots.map((l, i) => (
                  <div key={i} className="row between small item-line">
                    <span>{rupees(l.amount, 2)}</span>
                    <span className="muted">Expires {day(l.expires_at)}</span>
                  </div>
                ))}
              </section>
            )}

            <section className="card pad">
              <button className="row between w-full" onClick={() => setShowHow((v) => !v)} aria-expanded={showHow}>
                <strong>How it works</strong>
                {showHow ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
              </button>
              {showHow && (
                <ul className="how-list small">
                  <li>Cashback coupons add money to your wallet when the order is delivered.</li>
                  <li>Use up to {Math.trunc(wallet.max_use_percent)}% of item total per order.</li>
                  {wallet.min_order > 0 && <li>Minimum order {rupees(wallet.min_order)}.</li>}
                  <li>Cashback expires as shown above.</li>
                  <li>Wallet money can't be withdrawn or topped up.</li>
                </ul>
              )}
            </section>

            <h3>History</h3>
            {history.length === 0 ? (
              <div className="card pad center muted">
                No wallet balance yet. Use a cashback coupon to earn money back on your order.
              </div>
            ) : (
              history.map((e) => {
                const kind = ENTRY[e.entry_type] ?? {
                  label: e.note || 'Wallet update',
                  sign: e.amount < 0 ? '−' : '+',
                  cls: e.amount < 0 ? 'text-danger' : 'text-success',
                  Icon: Wallet,
                };
                const label = e.entry_type === 'wallet_used' && e.order_number ? `Used on order #${e.order_number}` : kind.label;
                return (
                  <button
                    key={e.id}
                    className="card pad wallet-row"
                    onClick={() => e.order_id && navigate(`/orders/${e.order_id}`)}
                    disabled={!e.order_id}
                  >
                    <kind.Icon size={20} className={kind.cls} />
                    <span className="grow">
                      <strong className="block">{label}</strong>
                      <span className="muted small block">
                        {shortDateTime(e.created_at)}
                        {e.order_number && e.entry_type !== 'wallet_used' ? ` · Order #${e.order_number}` : ''}
                      </span>
                    </span>
                    <strong className={kind.cls}>
                      {kind.sign}
                      {rupees(Math.abs(e.amount), 2)}
                    </strong>
                  </button>
                );
              })
            )}
            {hasMore && (
              <div className="center-pad">
                {loadingMore ? (
                  <Spinner />
                ) : (
                  <button className="btn btn-outline" onClick={() => void loadMore()}>
                    Load more
                  </button>
                )}
              </div>
            )}

            {older.length > 0 && (
              <>
                <h3>Earlier refunds</h3>
                {older.map((t) => {
                  const credit = t.type.toLowerCase() === 'credit';
                  return (
                    <div key={t.id} className="card pad row between">
                      <span>
                        <strong className="block">{t.reason || (credit ? 'Wallet credit' : 'Wallet debit')}</strong>
                        {t.created_at && <span className="muted small block">{shortDateTime(t.created_at)}</span>}
                      </span>
                      <strong className={credit ? 'text-success' : 'text-danger'}>
                        {credit ? '+' : '−'}
                        {rupees(t.amount, 2)}
                      </strong>
                    </div>
                  );
                })}
              </>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
