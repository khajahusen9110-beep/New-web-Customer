import { useCallback, useEffect, useState } from 'react';
import { create } from 'zustand';
import { CheckCircle2, ChevronRight, LocateFixed, MapPin, MapPinOff } from 'lucide-react';
import { ConfirmDialog, ErrorCard, Modal, Spinner, toast } from './ui';
import { findCityForLocation, getActiveCities, updateProfileCityId } from '../lib/repository';
import { getCurrentPosition, GeoError, matchWithBackendCities, reverseGeocode } from '../lib/geo';
import type { City } from '../lib/types';
import { errorMessage } from '../lib/utils';
import { useSession } from '../store/session';
import { cartCount, useCart } from '../store/cart';

// Global city UI state (MainActivity's showCityPicker / showLocationDialog / pendingAutoCityChange).
type DetectState = 'idle' | 'detecting' | 'success' | 'unsupported' | 'denied';

interface CityUiState {
  pickerOpen: boolean;
  detectOpen: boolean;
  detectState: DetectState;
  detectMessage: string | null;
  assignedCityName: string | null;
  pendingCity: City | null;
  set: (p: Partial<Omit<CityUiState, 'set'>>) => void;
}

export const useCityUi = create<CityUiState>()((set) => ({
  pickerOpen: false,
  detectOpen: false,
  detectState: 'idle',
  detectMessage: null,
  assignedCityName: null,
  pendingCity: null,
  set: (p) => set(p),
}));

export const openCityPicker = () => useCityUi.getState().set({ pickerOpen: true });

/** Switches the delivery city: clears the (city-specific) cart and saves profiles.city_id. */
export async function applyCity(city: City) {
  const s = useSession.getState();
  const changed = s.selectedCity?.id !== city.id;
  s.setSelectedCity(city);
  if (changed) useCart.getState().clearAllCarts();
  if (s.userId) {
    try {
      await updateProfileCityId(s.userId, city.id);
    } catch (e) {
      console.warn('Profile city update failed', e);
    }
  }
}

const cartHasItems = () => {
  const { groceryCart, hotelCart } = useCart.getState();
  return cartCount(groceryCart) + cartCount(hotelCart) > 0;
};

/** GPS -> find_city_for_location RPC -> (fallback) geocode + client-side match. */
export async function runCityDetection() {
  const ui = useCityUi.getState();
  ui.set({ detectOpen: true, detectState: 'detecting', detectMessage: null, pickerOpen: false });
  try {
    const { lat, lng } = await getCurrentPosition();
    let city: City | null = null;
    let rpcOk = true;
    try {
      const r = await findCityForLocation(lat, lng);
      if (r) city = { id: r.city_id, name: r.city_name, status: 'active' };
    } catch {
      rpcOk = false;
    }
    if (!rpcOk) {
      const [geo, cities] = await Promise.all([reverseGeocode(lat, lng), getActiveCities().catch(() => [])]);
      city = matchWithBackendCities(geo?.locality, lat, lng, cities);
    }
    if (!city) {
      ui.set({ detectState: 'unsupported' });
      return;
    }
    // Prefer the full city row (state / centre coordinates) when available.
    const full = (await getActiveCities().catch(() => [] as City[])).find((c) => c.id === city!.id) ?? city;
    const current = useSession.getState().selectedCity;
    if (current && current.id !== full.id && cartHasItems()) {
      ui.set({ detectOpen: false, pendingCity: full });
      return;
    }
    await applyCity(full);
    ui.set({ detectState: 'success', assignedCityName: full.name });
  } catch (e) {
    if (e instanceof GeoError && e.kind === 'denied') ui.set({ detectState: 'denied' });
    else ui.set({ detectState: 'unsupported', detectMessage: errorMessage(e, 'Unable to determine your location.') });
  }
}

export function CityPickerModal() {
  const { pickerOpen, set } = useCityUi();
  const currentCity = useSession((s) => s.selectedCity);
  const [cities, setCities] = useState<City[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmCity, setConfirmCity] = useState<City | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setCities(await getActiveCities(true));
    } catch (e) {
      setError(errorMessage(e, 'Unable to load cities from backend'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (pickerOpen) void load();
  }, [pickerOpen, load]);

  const close = () => set({ pickerOpen: false });

  const choose = async (city: City) => {
    if (currentCity?.id === city.id) return close();
    if (cartHasItems()) return setConfirmCity(city);
    await applyCity(city);
    close();
  };

  return (
    <>
      <Modal open={pickerOpen && !confirmCity} onClose={close} title="Select Delivery City">
        <p className="muted small">Active delivery cities</p>
        <button className="list-card" onClick={() => void runCityDetection()}>
          <span className="icon-circle">
            <LocateFixed size={20} />
          </span>
          <span className="grow">
            <strong>Detect My Location</strong>
            <span className="muted small">Using your device GPS</span>
          </span>
          <ChevronRight size={18} />
        </button>
        {loading ? (
          <div className="center-pad">
            <Spinner />
          </div>
        ) : error ? (
          <ErrorCard message={error} onRetry={load} />
        ) : cities.length === 0 ? (
          <p className="muted center-pad">No active cities found.</p>
        ) : (
          <div className="stack-sm">
            {cities.map((c) => {
              const sel = currentCity?.id === c.id;
              return (
                <button key={c.id} className={`list-card${sel ? ' selected' : ''}`} onClick={() => void choose(c)}>
                  <MapPin size={20} className="text-primary" />
                  <span className="grow">
                    <strong>{c.name}</strong>
                    {c.state && <span className="muted small">{c.state}</span>}
                  </span>
                  {sel && <CheckCircle2 size={20} className="text-primary" />}
                </button>
              );
            })}
          </div>
        )}
      </Modal>
      <ConfirmDialog
        open={!!confirmCity}
        title="Change Delivery City?"
        text={`Changing your city to ${confirmCity?.name} will clear your current cart items, as prices and stock are city-specific. Do you wish to continue?`}
        confirmLabel="Change City & Clear Cart"
        onCancel={() => setConfirmCity(null)}
        onConfirm={async () => {
          const c = confirmCity!;
          setConfirmCity(null);
          await applyCity(c);
          close();
        }}
      />
    </>
  );
}

export function LocationDetectDialog() {
  const { detectOpen, detectState, detectMessage, assignedCityName, pendingCity, set } = useCityUi();
  const close = () => set({ detectOpen: false });

  return (
    <>
      <Modal open={detectOpen} onClose={close} title="Delivery Location">
        {detectState === 'detecting' && (
          <div className="center-col">
            <Spinner size={40} />
            <strong>Detecting your location...</strong>
            <span className="muted small">Locating the nearest Sndmart delivery hub</span>
          </div>
        )}
        {detectState === 'success' && (
          <div className="center-col">
            <CheckCircle2 size={44} className="text-success" />
            <strong>Delivering to {assignedCityName}</strong>
            <button className="btn btn-primary" onClick={close}>
              Start Shopping
            </button>
          </div>
        )}
        {detectState === 'denied' && (
          <div className="center-col">
            <MapPinOff size={44} className="text-danger" />
            <strong>Location permission denied</strong>
            <span className="muted small center">
              Allow location access for this site in your browser settings, or choose your city manually.
            </span>
            <div className="row gap-8">
              <button className="btn btn-outline" onClick={() => void runCityDetection()}>
                Try Again
              </button>
              <button className="btn btn-primary" onClick={() => set({ detectOpen: false, pickerOpen: true })}>
                Select City Manually
              </button>
            </div>
          </div>
        )}
        {detectState === 'unsupported' && (
          <div className="center-col">
            <MapPinOff size={44} className="text-warning" />
            <strong>We're not available in your area yet</strong>
            <span className="muted small center">
              {detectMessage ?? 'Sndmart is actively serving select hubs. You can pick an active city manually.'}
            </span>
            <div className="row gap-8">
              <button
                className="btn btn-outline"
                onClick={() => {
                  close();
                  toast("We'll notify you when Sndmart launches in your area!");
                }}
              >
                Notify Me
              </button>
              <button className="btn btn-primary" onClick={() => set({ detectOpen: false, pickerOpen: true })}>
                Pick a City
              </button>
            </div>
          </div>
        )}
      </Modal>
      <ConfirmDialog
        open={!!pendingCity}
        title={`Switch to ${pendingCity?.name}?`}
        text={`Your location suggests you're in ${pendingCity?.name}. Switching your delivery city will clear your current cart items, as prices and stock are city-specific. Do you wish to continue?`}
        confirmLabel="Switch & Clear Cart"
        cancelLabel="Stay in Current City"
        onCancel={() => set({ pendingCity: null })}
        onConfirm={async () => {
          const c = pendingCity!;
          set({ pendingCity: null });
          await applyCity(c);
          toast(`Delivery city updated to ${c.name}`);
        }}
      />
    </>
  );
}
