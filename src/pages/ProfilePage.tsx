import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, Building2, ChevronRight, CircleHelp, LogOut, MapPin, Star, User, UserRound, Wallet } from 'lucide-react';
import { ConfirmDialog, PageHeader } from '../components/ui';
import { openCityPicker } from '../components/CityPicker';
import { signOut } from '../lib/repository';
import { useSession } from '../store/session';
import { rupees } from '../lib/utils';
import { useMyWallet } from '../lib/hooks';
import { WalletChip } from '../components/WalletChip';

export default function ProfilePage() {
  const wallet = useMyWallet();
  const navigate = useNavigate();
  const { userName, userEmail, userPhone, selectedCity, unreadNotificationCount, logout } = useSession();
  const [confirmLogout, setConfirmLogout] = useState(false);

  const items = [
    { Icon: User, title: 'Edit Profile', sub: 'Update your name and phone number', go: () => navigate('/profile/edit') },
    {
      Icon: Building2,
      title: 'Delivery City',
      sub: selectedCity ? `${selectedCity.name}${selectedCity.state ? `, ${selectedCity.state}` : ''}` : 'Not selected',
      go: openCityPicker,
    },
    {
      Icon: Bell,
      title: 'Notifications & Alerts',
      sub: unreadNotificationCount > 0 ? `${unreadNotificationCount} unread updates` : 'Order status & city updates',
      go: () => navigate('/notifications'),
    },
    { Icon: MapPin, title: 'Saved Addresses', sub: 'Manage delivery addresses', go: () => navigate('/addresses') },
    {
      Icon: Wallet,
      title: 'Sndmart Wallet',
      sub: wallet ? `Balance ${rupees(wallet.balance, 2)} · cashback & history` : 'Cashback balance & history',
      go: () => navigate('/wallet'),
    },
    { Icon: Star, title: 'My Reviews', sub: 'Reviews you have submitted', go: () => navigate('/reviews') },
    { Icon: CircleHelp, title: 'Help & Support', sub: 'Call, WhatsApp or email us', go: () => navigate('/help') },
  ];

  return (
    <div className="page">
      <PageHeader title="My Account" back={false} />
      <div className="content-pad narrow stack">
        <div className="card pad row gap-16">
          <span className="avatar">
            <UserRound size={32} />
          </span>
          <span>
            <strong className="block big">{userName?.trim() || 'Sndmart Customer'}</strong>
            {userEmail && <span className="muted small block">{userEmail}</span>}
            {userPhone && <span className="muted small block">{userPhone}</span>}
          </span>
          <span className="grow" />
          <WalletChip always />
        </div>
        <div className="card menu-list">
          {items.map(({ Icon, title, sub, go }) => (
            <button key={title} className="menu-row" onClick={go}>
              <Icon size={22} className="text-primary" />
              <span className="grow">
                <strong className="block">{title}</strong>
                <span className="muted small">{sub}</span>
              </span>
              <ChevronRight size={18} className="muted" />
            </button>
          ))}
        </div>
        <button className="btn btn-danger-soft btn-lg w-full" onClick={() => setConfirmLogout(true)}>
          <LogOut size={20} /> Log Out
        </button>
      </div>
      <ConfirmDialog
        open={confirmLogout}
        title="Log Out"
        text="Are you sure you want to log out of your Sndmart account?"
        confirmLabel="Log Out"
        danger
        onCancel={() => setConfirmLogout(false)}
        onConfirm={async () => {
          setConfirmLogout(false);
          logout();
          await signOut('local');
          navigate('/auth', { replace: true });
        }}
      />
    </div>
  );
}
