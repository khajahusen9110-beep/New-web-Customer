import { useCallback, useEffect, useState } from 'react';
import { ChevronRight, LocateFixed, MapPin, MapPinned, Pencil, Plus, Trash2 } from 'lucide-react';
import { AddressPickerModal } from '../components/AddressPickerModal';
import { CenterSpinner, ConfirmDialog, EmptyState, ErrorCard, PageHeader, toast } from '../components/ui';
import { deleteAddress, getAddresses, setDefaultAddress } from '../lib/repository';
import type { CustomerAddress } from '../lib/types';
import { errorMessage } from '../lib/utils';
import { useSession } from '../store/session';

export default function AddressBookPage() {
  const userId = useSession((s) => s.userId);
  const setHasSavedAddress = useSession((s) => s.setHasSavedAddress);
  const [addresses, setAddresses] = useState<CustomerAddress[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<CustomerAddress | null>(null);
  const [showEditor, setShowEditor] = useState(false);
  const [toDelete, setToDelete] = useState<CustomerAddress | null>(null);

  const load = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    setError(null);
    try {
      const list = await getAddresses(userId);
      setAddresses(list);
      const def = list.find((a) => a.is_default) ?? list[0];
      setHasSavedAddress(list.length > 0, def?.label ?? null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [userId, setHasSavedAddress]);

  useEffect(() => {
    void load();
  }, [load]);

  const openNew = () => {
    setEditing(null);
    setShowEditor(true);
  };

  return (
    <div className="page">
      <PageHeader
        title="Saved Addresses"
        actions={
          <button className="icon-btn" aria-label="Add address" onClick={openNew}>
            <Plus size={22} />
          </button>
        }
      />
      <div className="content-pad narrow">
        {loading ? (
          <CenterSpinner />
        ) : error ? (
          <ErrorCard message={error} onRetry={() => void load()} />
        ) : addresses.length === 0 ? (
          <EmptyState
            icon={<MapPin size={56} />}
            title="No saved addresses"
            text="Detect your location via GPS to set exact doorstep delivery."
            action={
              <button className="btn btn-primary" onClick={openNew}>
                <LocateFixed size={18} /> Detect My Location
              </button>
            }
          />
        ) : (
          <div className="stack">
            <button className="list-card" onClick={openNew}>
              <span className="icon-circle">
                <LocateFixed size={20} />
              </span>
              <span className="grow">
                <strong className="block">Detect My Current Location</strong>
                <span className="muted small">Using your device GPS for doorstep pin</span>
              </span>
              <ChevronRight size={18} />
            </button>
            {addresses.map((a) => (
              <div key={a.id} className={`card pad${a.is_default ? ' selected-border' : ''}`}>
                <div className="row between">
                  <strong className="row gap-6">
                    <MapPin size={18} className="text-primary" /> {a.label}
                  </strong>
                  {a.is_default && <span className="pill">Default</span>}
                </div>
                <strong className="block mt-8">{a.recipient_name || 'Recipient'}</strong>
                {a.phone && <span className="muted small block">{a.phone}</span>}
                <span className="block">{a.address_line}</span>
                {a.landmark && <span className="muted small block">Landmark: {a.landmark}</span>}
                {a.lat != null && a.lng != null && Number(a.lat) !== 0 && (
                  <span className="small text-primary row gap-4">
                    <MapPinned size={14} /> Map Pin: {Number(a.lat).toFixed(4)}, {Number(a.lng).toFixed(4)}
                  </span>
                )}
                <div className="row gap-8 wrap mt-12">
                  {!a.is_default && (
                    <button
                      className="btn btn-outline btn-sm"
                      onClick={async () => {
                        try {
                          await setDefaultAddress(userId!, a.id!);
                          toast('Default address updated');
                          void load();
                        } catch (e) {
                          toast(`Failed: ${errorMessage(e)}`);
                        }
                      }}
                    >
                      Set Default
                    </button>
                  )}
                  <button
                    className="btn btn-outline btn-sm"
                    onClick={() => {
                      setEditing(a);
                      setShowEditor(true);
                    }}
                  >
                    <Pencil size={14} /> Edit on Map
                  </button>
                  <button className="btn btn-outline btn-sm text-danger" onClick={() => setToDelete(a)}>
                    <Trash2 size={14} /> Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {showEditor && (
        <AddressPickerModal
          open
          existing={editing}
          onClose={() => {
            setShowEditor(false);
            setEditing(null);
          }}
          onSaved={() => {
            setShowEditor(false);
            setEditing(null);
            void load();
          }}
        />
      )}
      <ConfirmDialog
        open={!!toDelete}
        title="Delete Address?"
        text={`Remove "${toDelete?.label}" – ${toDelete?.address_line ?? ''}?`}
        confirmLabel="Delete"
        danger
        onCancel={() => setToDelete(null)}
        onConfirm={async () => {
          const a = toDelete!;
          setToDelete(null);
          try {
            await deleteAddress(a.id!);
            toast('Address deleted');
            void load();
          } catch (e) {
            toast(errorMessage(e, 'Failed to delete address'));
          }
        }}
      />
    </div>
  );
}
