import { Wallet } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useMyWallet } from '../lib/hooks';
import { rupees } from '../lib/utils';

/** Small "₹320" wallet pill that opens the Wallet page. Hidden when the balance is 0 unless `always`. */
export function WalletChip({ always = false }: { always?: boolean }) {
  const navigate = useNavigate();
  const wallet = useMyWallet();
  if (!wallet || (!always && wallet.balance <= 0)) return null;
  return (
    <button className="wallet-chip" aria-label={`Sndmart Wallet ${rupees(wallet.balance)}`} onClick={() => navigate('/wallet')}>
      <Wallet size={15} /> {rupees(wallet.balance)}
    </button>
  );
}
