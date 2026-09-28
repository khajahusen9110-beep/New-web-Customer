import { useCallback, useEffect, useRef, useState } from 'react';
import { Briefcase, Check, Home, LocateFixed, MapPin, Search, X } from 'lucide-react';
import { Modal, Spinner } from './ui';
import { PinPickerMap, type LatLng } from './MapView';
import { getCurrentPosition, resolvePlace, reverseGeocode, searchPlaces, type PickedPlace, type PlaceResult } from '../lib/geo';
import { addAddress, updateAddress } from '../lib/repository';
import type { CustomerAddress } from '../lib/types';
import { DEFAULT_CENTER, errorMessage, isValidIndianCoordinate, toE164 } from '../lib/utils';
import { useSession } from '../store/session';

export const ADDRESS_LABELS = [
  { label: 'Home', Icon: Home },
  { label: 'Work', Icon: Briefcase },
  { label: 'Other', Icon: MapPin },
] as const;

/** Debounced place search box with a suggestion dropdown. */
export function PlaceSearch({ onPick }: { onPick: (p: PickedPlace) => void }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PlaceResult[]>([]);
  const [loading, setLoading] = useState(false);
  const skipNext = useRef(false);

  useEffect(() => {
    if (skipNext.current) {
      skipNext.current = false;
      return;
    }
    if (query.trim().length < 3) {
      setResults([]);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        setResults(await searchPlaces(query, ctrl.signal));
      } catch {
        /* aborted or offline */
      } finally {
        setLoading(false);
      }
    }, 400);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [query]);

  return (
    <div className="place-search">
      <div className="input-icon">
        <Search size={18} className="text-primary" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search for area, street..."
          aria-label="Search for area or street"
        />
        {loading ? (
          <Spinner size={16} />
        ) : (
          query && (
            <button className="icon-btn sm" aria-label="Clear" onClick={() => setQuery('')}>
              <X size={16} />
            </button>
          )
        )}
      </div>
      {results.length > 0 && (
        <ul className="suggestions">
          {results.map((r) => (
            <li key={r.id}>
              <button
                onClick={async () => {
                  skipNext.current = true;
                  setQuery(r.primaryText);
                  setResults([]);
                  setLoading(true);
                  const picked = await resolvePlace(r);
                  setLoading(false);
                  if (picked) onPick(picked);
                }}
              >
                <MapPin size={16} className="text-primary" />
                <span>
                  <strong>{r.primaryText}</strong>
                  {r.secondaryText && <span className="muted small ellipsis">{r.secondaryText}</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Add / edit a delivery address with a draggable map pin (port of AddressPickerDialog). */
export function AddressPickerModal({
  open,
  existing,
  onClose,
  onSaved,
}: {
  open: boolean;
  existing?: CustomerAddress | null;
  onClose: () => void;
  onSaved: (a: CustomerAddress) => void;
}) {
  const { userId, userName, userPhone, selectedCity } = useSession();
  const initial: LatLng =
    existing?.lat != null && existing.lng != null && Number(existing.lat) !== 0
      ? [Number(existing.lat), Number(existing.lng)]
      : selectedCity?.center_lat != null && selectedCity.center_lng != null
        ? [Number(selectedCity.center_lat), Number(selectedCity.center_lng)]
        : DEFAULT_CENTER;

  const [pin, setPin] = useState<LatLng>(initial);
  const [flyKey, setFlyKey] = useState(0);
  const [label, setLabel] = useState(existing?.label ?? 'Home');
  const [recipientName, setRecipientName] = useState(existing?.recipient_name ?? userName ?? '');
  const [phone, setPhone] = useState(existing?.phone ?? userPhone ?? '');
  const [addressLine, setAddressLine] = useState(existing?.address_line ?? '');
  const [landmark, setLandmark] = useState(existing?.landmark ?? '');
  const [manualEdit, setManualEdit] = useState(!!existing);
  const [geocoding, setGeocoding] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const movePin = useCallback(
    async (p: LatLng, fly = false) => {
      setPin(p);
      if (fly) setFlyKey((k) => k + 1);
      setGeocoding(true);
      const g = await reverseGeocode(p[0], p[1]);
      setGeocoding(false);
      if (g) {
        setAddressLine((cur) => (!manualEdit || !cur.trim() ? g.addressLine : cur));
        setLandmark((cur) => (cur || !g.featureName || g.featureName === g.subLocality ? cur : g.featureName));
      }
    },
    [manualEdit],
  );

  const detect = useCallback(async () => {
    setDetecting(true);
    setError(null);
    try {
      const c = await getCurrentPosition();
      await movePin([c.lat, c.lng], true);
    } catch (e) {
      setError(errorMessage(e, 'Could not detect your location.'));
    } finally {
      setDetecting(false);
    }
  }, [movePin]);

  // New address: try GPS immediately (like the app's auto-detect on open).
  useEffect(() => {
    if (open && !existing) void detect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function save() {
    if (!userId) return setError('Session error: please sign in again.');
    if (!addressLine.trim()) return setError('Please enter complete address');
    if (!isValidIndianCoordinate(pin[0], pin[1])) {
      return setError('This location looks incorrect. Please adjust the pin and try again.');
    }
    setSaving(true);
    setError(null);
    const formattedPhone = phone.trim() ? toE164(phone.trim()) : '';
    try {
      if (existing?.id) {
        const fields = {
          label: label || 'Home',
          recipient_name: recipientName.trim() || 'Customer',
          phone: formattedPhone,
          address_line: addressLine.trim(),
          landmark: landmark.trim() || null,
          lat: pin[0],
          lng: pin[1],
        };
        await updateAddress(existing.id, fields);
        onSaved({ ...existing, ...fields });
      } else {
        const saved = await addAddress({
          user_id: userId,
          label: label || 'Home',
          recipient_name: recipientName.trim() || 'Customer',
          phone: formattedPhone,
          address_line: addressLine.trim(),
          landmark: landmark.trim() || null,
          lat: pin[0],
          lng: pin[1],
          city_id: selectedCity?.id ?? null,
          is_default: false,
        });
        onSaved(saved);
      }
    } catch (e) {
      setError(errorMessage(e, 'Failed to save address'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title={existing ? 'Edit Delivery Address' : 'Add Delivery Address'}
      footer={
        <button className="btn btn-primary w-full" disabled={saving || !addressLine.trim()} onClick={save}>
          {saving ? <Spinner size={20} light /> : <Check size={18} />}
          {saving ? 'Saving Address...' : 'Save Delivery Address'}
        </button>
      }
    >
      <div className="stack">
        <PlaceSearch onPick={(r) => void movePin([r.lat, r.lng], true)} />
        <div className="map-wrap">
          <PinPickerMap position={pin} onChange={(p) => void movePin(p)} flyKey={flyKey} />
          <div className="map-pill">Drag pin or tap map to set exact spot</div>
          <button className="map-fab" onClick={detect} aria-label="Use my current location" disabled={detecting}>
            {detecting ? <Spinner size={18} /> : <LocateFixed size={20} />}
          </button>
          {geocoding && (
            <div className="map-status">
              <Spinner size={12} /> Detecting address...
            </div>
          )}
        </div>

        {error && <div className="alert alert-danger">{error}</div>}

        <div>
          <div className="label-caps">Save as</div>
          <div className="chip-row">
            {ADDRESS_LABELS.map(({ label: l, Icon }) => (
              <button key={l} className={`chip${label === l ? ' chip-active' : ''}`} onClick={() => setLabel(l)}>
                <Icon size={15} /> {l}
              </button>
            ))}
          </div>
        </div>
        <label className="field">
          <span>House / Flat / Street / Area *</span>
          <textarea
            rows={2}
            value={addressLine}
            onChange={(e) => {
              setAddressLine(e.target.value);
              setManualEdit(true);
            }}
          />
        </label>
        <label className="field">
          <span>Landmark (Optional)</span>
          <input value={landmark} onChange={(e) => setLandmark(e.target.value)} />
        </label>
        <div className="grid-2">
          <label className="field">
            <span>Recipient Name</span>
            <input value={recipientName} onChange={(e) => setRecipientName(e.target.value)} />
          </label>
          <label className="field">
            <span>Phone Number</span>
            <input inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </label>
        </div>
      </div>
    </Modal>
  );
}
