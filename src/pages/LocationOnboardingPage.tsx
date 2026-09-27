import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  Building2,
  CheckCircle2,
  ChevronRight,
  Info,
  LocateFixed,
  MapPin,
  MapPinOff,
  Navigation,
  ShieldCheck,
  Store,
} from 'lucide-react';
import { PageHeader, Spinner } from '../components/ui';
import { PinPickerMap, type LatLng } from '../components/MapView';
import { ADDRESS_LABELS, PlaceSearch } from '../components/AddressPickerModal';
import { applyCity } from '../components/CityPicker';
import { getCurrentPosition, getPermissionState, GeoError, matchWithBackendCities, reverseGeocode } from '../lib/geo';
import { addAddress, findCityForLocation, getActiveCities, setDefaultAddress, updateProfileCityId } from '../lib/repository';
import type { City } from '../lib/types';
import { DEFAULT_CENTER, errorMessage, isValidIndianCoordinate, toE164 } from '../lib/utils';
import { useSession } from '../store/session';

type Phase = 'permission' | 'denied' | 'form';

export default function LocationOnboardingPage() {
  const navigate = useNavigate();
  const { userId, userName, userPhone, selectedCity, setSelectedCity, setHasSavedAddress } = useSession();

  const [phase, setPhase] = useState<Phase>('permission');
  const [detecting, setDetecting] = useState(false);
  const [city, setCity] = useState<City | null>(selectedCity);
  const [cityMessage, setCityMessage] = useState<string | null>(null);
  const [locality, setLocality] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [cities, setCities] = useState<City[]>([]);
  const [citiesError, setCitiesError] = useState<string | null>(null);
  const [loadingCities, setLoadingCities] = useState(true);

  const [gps, setGps] = useState<LatLng | null>(null);
  const [pin, setPin] = useState<LatLng>(
    selectedCity?.center_lat != null && selectedCity.center_lng != null
      ? [Number(selectedCity.center_lat), Number(selectedCity.center_lng)]
      : DEFAULT_CENTER,
  );
  const [flyKey, setFlyKey] = useState(0);
  const [geocoding, setGeocoding] = useState(false);

  const [label, setLabel] = useState('Home');
  const [recipientName, setRecipientName] = useState(userName ?? '');
  const [phone, setPhone] = useState(userPhone ?? '');
  const [addressLine, setAddressLine] = useState('');
  const [landmark, setLandmark] = useState('');
  const [manualEdit, setManualEdit] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    getActiveCities()
      .then(setCities)
      .catch((e) => setCitiesError(errorMessage(e, 'Could not load active cities.')))
      .finally(() => setLoadingCities(false));
  }, []);

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
      return g;
    },
    [manualEdit],
  );

  const chooseCity = useCallback(
    async (c: City, message: string) => {
      setCity(c);
      setCityMessage(message);
      setUnsupported(false);
      await applyCity(c);
    },
    [],
  );

  const detect = useCallback(async () => {
    setDetecting(true);
    setUnsupported(false);
    setFormError(null);
    try {
      const { lat, lng } = await getCurrentPosition();
      setPhase('form');
      setGps([lat, lng]);
      const geo = await movePin([lat, lng], true);
      setLocality(geo?.locality ?? geo?.subLocality ?? null);
      let found: City | null = null;
      try {
        const r = await findCityForLocation(lat, lng);
        if (r) {
          const all = await getActiveCities().catch(() => [] as City[]);
          found = all.find((c) => c.id === r.city_id) ?? { id: r.city_id, name: r.city_name, status: 'active' };
        }
      } catch {
        found = matchWithBackendCities(geo?.locality, lat, lng, await getActiveCities().catch(() => []));
      }
      if (found) await chooseCity(found, `Detected: ${found.name}`);
      else setUnsupported(true);
    } catch (e) {
      if (e instanceof GeoError && e.kind === 'denied') setPhase('denied');
      else {
        setPhase('form');
        setFormError(errorMessage(e, 'Could not detect your location. Set the pin manually.'));
      }
    } finally {
      setDetecting(false);
    }
  }, [movePin, chooseCity]);

  // If the browser already granted location, detect right away.
  useEffect(() => {
    getPermissionState().then((s) => {
      if (s === 'granted') void detect();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function pickCityManually(c: City) {
    await chooseCity(c, `Selected: ${c.name}`);
    if (c.center_lat != null && c.center_lng != null) {
      await movePin([Number(c.center_lat), Number(c.center_lng)], true);
    } else if (!addressLine) {
      setAddressLine(`${c.name}, ${c.state ?? ''}`);
    }
  }

  async function save() {
    const [lat, lng] = pin;
    if (!isValidIndianCoordinate(lat, lng)) return setFormError('This location looks incorrect. Please adjust the pin and try again.');
    const c = city ?? cities[0];
    if (!c) return setFormError('Please select or detect your delivery city first.');
    if (!recipientName.trim()) return setFormError("Please enter the recipient's name.");
    if (!phone.trim()) return setFormError('Please enter a valid phone number.');
    if (!addressLine.trim()) return setFormError('Please enter your complete street address or house number.');
    if (!userId) return setFormError('Session error: user ID missing. Please sign in again.');

    setSaving(true);
    setFormError(null);
    try {
      const saved = await addAddress({
        user_id: userId,
        label: label || 'Home',
        recipient_name: recipientName.trim(),
        phone: toE164(phone.trim()),
        address_line: addressLine.trim(),
        landmark: landmark.trim() || null,
        lat,
        lng,
        city_id: c.id,
        is_default: true,
      });
      await updateProfileCityId(userId, c.id);
      if (saved.id) await setDefaultAddress(userId, saved.id).catch(() => undefined);
      setSelectedCity(c);
      setHasSavedAddress(true, label || 'Home');
      navigate('/', { replace: true });
    } catch (e) {
      setFormError(errorMessage(e, 'An unexpected error occurred while saving your address.'));
    } finally {
      setSaving(false);
    }
  }

  if (phase === 'permission' || phase === 'denied') {
    const denied = phase === 'denied';
    return (
      <div className="narrow-page">
        <PageHeader title="Location Required" back={false} />
        <div className="center-col pad">
          <div className={`hero-circle${denied ? ' danger' : ''}`}>
            {denied ? <MapPinOff size={44} /> : <MapPin size={44} />}
          </div>
          <h2>{denied ? 'Location Access Required' : 'Location Permission Required'}</h2>
          <p className="muted center">
            Sndmart needs your location to show nearby hotels and groceries, and for accurate delivery.
          </p>
          {denied ? (
            <div className="alert alert-danger">
              <Info size={18} /> Location permission was denied. Allow location for this site in your browser settings
              (click the icon next to the address bar), then try again — or set your address manually below.
            </div>
          ) : (
            <div className="card pad stack">
              {[
                { Icon: Store, t: 'Discover Nearby Stores', d: 'Browse restaurants, fresh groceries and food vendors delivering near you.' },
                { Icon: Navigation, t: 'Accurate Doorstep Delivery', d: 'Our delivery partners navigate directly to your house without calling.' },
                { Icon: ShieldCheck, t: 'Privacy Guaranteed', d: 'Your location is only used to service active orders and find nearby hubs.' },
              ].map(({ Icon, t, d }) => (
                <div key={t} className="row gap-12 align-start">
                  <span className="icon-square">
                    <Icon size={20} />
                  </span>
                  <span>
                    <strong>{t}</strong>
                    <span className="muted small block">{d}</span>
                  </span>
                </div>
              ))}
            </div>
          )}
          <button className="btn btn-primary btn-lg w-full" onClick={() => void detect()} disabled={detecting}>
            {detecting ? <Spinner size={22} light /> : <LocateFixed size={20} />}
            {denied ? 'Try Again' : 'Allow Location Access'}
          </button>
          <button className="btn btn-outline w-full" onClick={() => setPhase('form')}>
            Enter Address Manually
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="narrow-page">
      <PageHeader title="Set Delivery Location" back={false} />
      <div className="stack pad">
        <div className="center-col">
          <div className="hero-icon">
            <MapPin size={36} />
          </div>
          <h2 className="text-primary">Where should we deliver?</h2>
          <p className="muted small center">
            Confirm your delivery location and pin your exact doorstep to view fresh groceries &amp; hotel menus in your area.
          </p>
        </div>

        {detecting && (
          <div className="card pad row gap-12">
            <Spinner size={24} />
            <span>
              <strong>Detecting your location via GPS...</strong>
              <span className="muted small block">Locating nearest Sndmart delivery hub</span>
            </span>
          </div>
        )}

        {!detecting && city && cityMessage && (
          <div className="card pad row between tinted">
            <span className="row gap-8">
              <CheckCircle2 size={22} className="text-primary" />
              <span>
                <strong className="text-primary">{cityMessage}</strong>
                {locality && <span className="muted small block">{locality}</span>}
              </span>
            </span>
            <button className="btn btn-text" onClick={() => setCity(null)}>
              Change
            </button>
          </div>
        )}

        {unsupported && (
          <div className="alert alert-warning">
            <strong>We're not available in your area yet.</strong> Sndmart is actively serving select hubs. Pick an
            active city below to explore and order.
          </div>
        )}

        {!city && !detecting && (
          <div className="card pad">
            <div className="row gap-8">
              <Building2 size={22} className="text-primary" />
              <span>
                <strong>Select Your Delivery City</strong>
                <span className="muted small block">Tap your city below to proceed to address confirmation</span>
              </span>
            </div>
            {citiesError && <p className="text-danger small">{citiesError}</p>}
            {loadingCities ? (
              <div className="center-pad">
                <Spinner />
              </div>
            ) : (
              <div className="stack-sm mt-12">
                {cities.map((c) => (
                  <button key={c.id} className="list-card" onClick={() => void pickCityManually(c)}>
                    <MapPin size={18} className="text-primary" />
                    <strong className="grow">{c.name}</strong>
                    <ChevronRight size={16} />
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="card pad stack">
          <div>
            <h3>Confirm Delivery Address</h3>
            <p className="muted small">Pin your exact doorstep &amp; confirm delivery details</p>
          </div>
          <PlaceSearch onPick={(r) => void movePin([r.lat, r.lng], true)} />
          <div className="map-wrap">
            <PinPickerMap position={pin} onChange={(p) => void movePin(p)} flyKey={flyKey} />
            <div className="map-pill">Drag pin or tap map to set exact spot</div>
            <button
              className="map-fab"
              aria-label="Center to my GPS"
              onClick={() => (gps ? void movePin(gps, true) : void detect())}
            >
              <LocateFixed size={20} />
            </button>
            {geocoding && (
              <div className="map-status">
                <Spinner size={12} /> Detecting address...
              </div>
            )}
          </div>

          {formError && <div className="alert alert-danger">{formError}</div>}

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
            <span>Recipient Name *</span>
            <input value={recipientName} onChange={(e) => setRecipientName(e.target.value)} />
          </label>
          <label className="field">
            <span>Contact Phone *</span>
            <input inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </label>
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
          <button className="btn btn-primary btn-lg w-full" disabled={saving} onClick={() => void save()}>
            {saving ? (
              <Spinner size={22} light />
            ) : (
              <>
                Confirm Location <ArrowRight size={18} />
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
