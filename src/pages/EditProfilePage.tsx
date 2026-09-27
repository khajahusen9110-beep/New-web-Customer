import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Phone, User } from 'lucide-react';
import { PageHeader, Spinner, toast } from '../components/ui';
import { updateProfile } from '../lib/repository';
import { errorMessage, toE164 } from '../lib/utils';
import { useSession } from '../store/session';

export default function EditProfilePage() {
  const navigate = useNavigate();
  const { userId, userName, userPhone, updateProfileInfo } = useSession();
  const [name, setName] = useState(userName ?? '');
  const [phone, setPhone] = useState(userPhone ?? '');
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!userId) return;
    setSaving(true);
    const fullName = name.trim() || null;
    const formattedPhone = phone.trim() ? toE164(phone.trim()) : null;
    try {
      await updateProfile(userId, fullName, formattedPhone);
      updateProfileInfo({ full_name: fullName, phone: formattedPhone });
      toast('Profile updated');
      navigate(-1);
    } catch (e) {
      toast(`Failed: ${errorMessage(e)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="page">
      <PageHeader title="Edit Profile" />
      <div className="content-pad narrow stack">
        <div className="card pad stack">
          <strong>Personal Details</strong>
          <label className="field">
            <span>Full Name</span>
            <div className="input-icon">
              <User size={18} className="muted" />
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </div>
          </label>
          <label className="field">
            <span>Phone Number</span>
            <div className="input-icon">
              <Phone size={18} className="muted" />
              <input inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
            </div>
          </label>
        </div>
        <button
          className="btn btn-primary btn-lg w-full"
          disabled={saving || (!name.trim() && !phone.trim())}
          onClick={() => void save()}
        >
          {saving ? <Spinner size={20} light /> : 'Save Changes'}
        </button>
      </div>
    </div>
  );
}
