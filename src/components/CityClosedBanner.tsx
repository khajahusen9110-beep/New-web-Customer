import { useEffect } from 'react';
import { Clock, Siren } from 'lucide-react';
import { useSession } from '../store/session';
import { getCity } from '../lib/repository';
import { cityClosure } from '../lib/utils';

/**
 * Shown at the top of every page while the city is closed: outside the daily timings, or during an
 * Emergency Close (the reason is written by the City Admin). Refreshes the city every minute so a new
 * closure, or the shop opening again, shows up without a reload.
 */
export function CityClosedBanner() {
  const city = useSession((s) => s.selectedCity);
  const closure = cityClosure(city);
  const cityId = city?.id;

  useEffect(() => {
    if (!cityId) return;
    const refresh = () => {
      if (document.visibilityState !== 'visible') return;
      getCity(cityId, true)
        .then((fresh) => fresh && useSession.getState().setSelectedCity(fresh))
        .catch(() => undefined);
    };
    const timer = setInterval(refresh, 60_000);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [cityId]);

  if (!closure) return null;
  const Icon = closure.kind === 'emergency' ? Siren : Clock;
  return (
    <div className={`city-closed-banner ${closure.kind}`} role="status">
      <Icon size={20} />
      <div>
        <strong>{closure.title}</strong>
        <span>{closure.message}</span>
      </div>
    </div>
  );
}
