import { useState } from 'react';
import { Briefcase } from 'lucide-react';
import { ErrorCard, PageHeader, Spinner, toast } from '../components/ui';
import { applyAgentCode } from '../lib/repository';
import { errorMessage } from '../lib/utils';

/**
 * Manual fallback for applying an agent's code — most customers arrive via the agent's
 * shared link (auto-applied on login, see src/lib/agentCode.ts) and never see this page.
 * Deliberately separate from Refer & Earn: different program, different code, different
 * people involved (a Sndmart Agent, not a friend).
 */
export default function AgentCodePage() {
  const [code, setCode] = useState('');
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);

  const submit = async () => {
    if (!code.trim()) return;
    setApplying(true);
    setError(null);
    try {
      await applyAgentCode(code.trim());
      setApplied(true);
      toast('Agent code applied!');
    } catch (e) {
      setError(errorMessage(e, 'Could not apply code'));
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="page">
      <PageHeader title="Agent Code" />
      <div className="content-pad narrow stack">
        <div className="card pad refer-hero">
          <Briefcase size={32} className="text-primary" />
          <h2 className="big bold">Were you referred by a Sndmart Agent?</h2>
          <p className="muted small">
            If a Sndmart Agent gave you a code (not a friend's referral code), enter it here. This is a one-time, permanent link.
          </p>
        </div>

        <div className="card pad stack">
          {applied ? (
            <p className="text-success small">Agent code applied — thanks!</p>
          ) : (
            <>
              <div className="row gap-8">
                <input
                  className="input flex-1"
                  placeholder="Enter agent code"
                  value={code}
                  onChange={(e) => setCode(e.target.value.toUpperCase())}
                  maxLength={10}
                />
                <button className="btn btn-primary" onClick={submit} disabled={applying || !code.trim()}>
                  {applying ? <Spinner size={16} /> : 'Apply'}
                </button>
              </div>
              {error && <ErrorCard message={error} />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
