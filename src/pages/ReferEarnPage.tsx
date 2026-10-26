import { useEffect, useState } from 'react';
import { Check, Copy, Gift, MessageCircle, Share2, Users, Wallet } from 'lucide-react';
import { ErrorCard, PageHeader, Spinner, toast } from '../components/ui';
import { applyReferralCode, getMyReferralStats, getOrCreateReferralCode, type ReferralStats } from '../lib/repository';
import { errorMessage, rupees } from '../lib/utils';

const SHARE_URL = 'https://sndmart.in';
const REFERRER_REWARD = 50;
const FRIEND_REWARD = 30;

export default function ReferEarnPage() {
  const [stats, setStats] = useState<ReferralStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [applyCode, setApplyCode] = useState('');
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        let s = await getMyReferralStats();
        if (!s.referral_code) {
          const code = await getOrCreateReferralCode();
          s = { ...s, referral_code: code };
        }
        setStats(s);
      } catch (e) {
        setError(errorMessage(e, 'Failed to load referral info'));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const code = stats?.referral_code ?? '';
  const message = `Sndmart se order karo aur ${FRIEND_REWARD} rupaye paao! Mera referral code use karo: ${code}\n${SHARE_URL}`;

  const copyCode = () => {
    if (!code) return;
    navigator.clipboard?.writeText(code).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const share = () => {
    if (navigator.share) {
      navigator.share({ title: 'Sndmart Refer & Earn', text: message }).catch(() => undefined);
    } else {
      window.open(`https://wa.me/?text=${encodeURIComponent(message)}`, '_blank', 'noopener,noreferrer');
    }
  };

  const whatsappShare = () => {
    window.open(`https://wa.me/?text=${encodeURIComponent(message)}`, '_blank', 'noopener,noreferrer');
  };

  const submitApply = async () => {
    if (!applyCode.trim()) return;
    setApplying(true);
    setApplyError(null);
    try {
      await applyReferralCode(applyCode.trim());
      setApplied(true);
      toast('Referral code applied!');
    } catch (e) {
      setApplyError(errorMessage(e, 'Could not apply code'));
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="page">
      <PageHeader title="Refer & Earn" />
      <div className="content-pad narrow stack">
        {loading ? (
          <Spinner />
        ) : error ? (
          <ErrorCard message={error} />
        ) : (
          <>
            <div className="card pad refer-hero">
              <Gift size={36} className="text-primary" />
              <h2 className="big bold">Refer friends, earn wallet cash</h2>
              <p className="muted small">
                Share your code — your friend gets ₹{FRIEND_REWARD} on their first order, and you get ₹{REFERRER_REWARD} in your
                Sndmart wallet.
              </p>
            </div>

            <div className="card pad stack">
              <span className="muted small">Your referral code</span>
              <div className="row gap-8 refer-code-row">
                <span className="refer-code">{code || '••••••'}</span>
                <button className="btn btn-sm btn-outline" onClick={copyCode} disabled={!code}>
                  {copied ? <Check size={16} /> : <Copy size={16} />} {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
              <div className="row gap-8">
                <button className="btn btn-primary flex-1" onClick={share} disabled={!code}>
                  <Share2 size={16} /> Share
                </button>
                <button className="btn btn-outline flex-1" onClick={whatsappShare} disabled={!code}>
                  <MessageCircle size={16} /> WhatsApp
                </button>
              </div>
            </div>

            <div className="card pad row gap-16">
              <div className="refer-stat">
                <Users size={20} className="text-primary" />
                <strong className="big">{stats?.total_referred ?? 0}</strong>
                <span className="muted small">Friends referred</span>
              </div>
              <div className="refer-stat">
                <Wallet size={20} className="text-primary" />
                <strong className="big">{rupees(stats?.total_earned ?? 0)}</strong>
                <span className="muted small">Total earned</span>
              </div>
            </div>

            {!stats?.total_referred && (
              <div className="card pad stack">
                <span className="muted small">Got a friend's code?</span>
                {applied ? (
                  <p className="text-success small">Code applied — place your first order to unlock ₹{FRIEND_REWARD} bonus.</p>
                ) : (
                  <>
                    <div className="row gap-8">
                      <input
                        className="input flex-1"
                        placeholder="Enter referral code"
                        value={applyCode}
                        onChange={(e) => setApplyCode(e.target.value.toUpperCase())}
                        maxLength={10}
                      />
                      <button className="btn btn-primary" onClick={submitApply} disabled={applying || !applyCode.trim()}>
                        {applying ? <Spinner size={16} /> : 'Apply'}
                      </button>
                    </div>
                    {applyError && <p className="text-danger small">{applyError}</p>}
                  </>
                )}
              </div>
            )}

            <div className="card pad stack">
              <strong>How it works</strong>
              <ol className="muted small refer-steps">
                <li>Share your code with a friend who hasn't ordered on Sndmart yet.</li>
                <li>They enter it on this page before placing their first order.</li>
                <li>When their first order (₹99+) is delivered, you both get wallet cash.</li>
              </ol>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
