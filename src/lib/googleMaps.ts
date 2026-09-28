import { useSyncExternalStore } from 'react';

/**
 * Google Maps for the website (maps, place search, address lookup).
 *
 * The Maps JavaScript API always runs in the browser, so its key is visible by design. It must be
 * a *browser key* restricted in Google Cloud Console to this website's domain (HTTP referrers)
 * and to Maps JavaScript API + Places API (New) + Geocoding API, with daily quotas and a budget
 * alert (see SECURITY.md). Never put a server/unrestricted key here.
 *
 * Without a key, or if Google rejects it (billing off, wrong domain), the site falls back to
 * OpenStreetMap so maps and address search keep working.
 */
export const GOOGLE_MAPS_KEY = (import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined)?.trim() || '';

type Provider = 'google' | 'osm';
let failed = false;
const listeners = new Set<() => void>();

function markFailed() {
  if (failed) return;
  failed = true;
  listeners.forEach((l) => l());
}

export const mapsProvider = (): Provider => (GOOGLE_MAPS_KEY && !failed ? 'google' : 'osm');

/** Current map provider; switches to 'osm' if Google fails to load or rejects the key. */
export function useMapsProvider(): Provider {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    mapsProvider,
    mapsProvider,
  );
}

declare global {
  interface Window {
    gm_authFailure?: () => void;
    __sndmartGoogleMapsReady?: () => void;
  }
}

let loading: Promise<void> | null = null;

function loadScript(): Promise<void> {
  const g = (window as unknown as { google?: { maps?: { importLibrary?: unknown } } }).google;
  if (g?.maps?.importLibrary) return Promise.resolve();
  if (!loading) {
    loading = new Promise<void>((resolve, reject) => {
      // Google calls this when the key is invalid, restricted for this domain, or billing is off.
      window.gm_authFailure = () => {
        console.warn('Google Maps rejected the API key; using OpenStreetMap instead.');
        markFailed();
      };
      window.__sndmartGoogleMapsReady = () => resolve();
      const s = document.createElement('script');
      s.src =
        'https://maps.googleapis.com/maps/api/js' +
        `?key=${encodeURIComponent(GOOGLE_MAPS_KEY)}` +
        '&v=weekly&loading=async&language=en&region=IN&callback=__sndmartGoogleMapsReady';
      s.async = true;
      s.onerror = () => {
        loading = null;
        markFailed();
        reject(new Error('Google Maps could not be loaded'));
      };
      document.head.appendChild(s);
    });
  }
  return loading;
}

/** Loads one Google Maps library ('maps', 'marker', 'places', 'geocoding'), once. */
export async function googleLib<T>(name: string): Promise<T> {
  if (mapsProvider() !== 'google') throw new Error('Google Maps is not available');
  await loadScript();
  return (await google.maps.importLibrary(name)) as T;
}

/** For errors from individual Google calls (quota, billing) that should switch to OpenStreetMap. */
export function reportGoogleFailure(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  if (/REQUEST_DENIED|ApiNotActivated|BillingNotEnabled|RefererNotAllowed|InvalidKey|API key/i.test(msg)) markFailed();
}
