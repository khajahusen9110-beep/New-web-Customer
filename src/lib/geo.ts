// Browser replacement for LocationDetector / HighAccuracyLocationManager / MapLocationHelper.
// Uses the browser Geolocation API, and Google Places/Geocoding when a Google Maps key is set
// (see googleMaps.ts), otherwise OpenStreetMap Nominatim (no API key needed).
import type { City } from './types';
import { haversineKm, KNOWN_HUBS } from './utils';
import { googleLib, mapsProvider, reportGoogleFailure } from './googleMaps';
import { useSession } from '../store/session';

export interface Coords {
  lat: number;
  lng: number;
  accuracy?: number;
}

export type GeoErrorKind = 'denied' | 'unavailable' | 'timeout' | 'unsupported';

export class GeoError extends Error {
  constructor(public kind: GeoErrorKind, message: string) {
    super(message);
  }
}

export function getCurrentPosition(timeoutMs = 15000): Promise<Coords> {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      reject(new GeoError('unsupported', 'Location is not supported by this browser.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy }),
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          reject(new GeoError('denied', 'Location permission was denied.'));
        } else if (err.code === err.TIMEOUT) {
          reject(new GeoError('timeout', 'Timed out while detecting your location.'));
        } else {
          reject(new GeoError('unavailable', 'Your location is currently unavailable.'));
        }
      },
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 30_000 },
    );
  });
}

export async function getPermissionState(): Promise<PermissionState | 'unknown'> {
  try {
    const status = await navigator.permissions?.query({ name: 'geolocation' as PermissionName });
    return status?.state ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

const NOMINATIM = 'https://nominatim.openstreetmap.org';

export interface PlaceResult {
  id: string;
  primaryText: string;
  secondaryText: string;
  /** Known up front for OpenStreetMap; Google results get them from resolvePlace(). */
  lat?: number;
  lng?: number;
  /** Google: fetches the chosen place's coordinates (ends the billing session). */
  resolve?: () => Promise<{ lat: number; lng: number } | null>;
}

export type PickedPlace = PlaceResult & { lat: number; lng: number };

/** Coordinates for a picked suggestion (one Place Details request for Google results). */
export async function resolvePlace(r: PlaceResult): Promise<PickedPlace | null> {
  if (r.lat != null && r.lng != null) return { ...r, lat: r.lat, lng: r.lng };
  const c = await r.resolve?.().catch(() => null);
  return c ? { ...r, ...c } : null;
}

export interface GeocodeResult {
  addressLine: string;
  featureName?: string | null;
  subLocality?: string | null;
  locality?: string | null;
  postalCode?: string | null;
}

interface NominatimAddress {
  road?: string;
  house_number?: string;
  neighbourhood?: string;
  suburb?: string;
  village?: string;
  town?: string;
  city?: string;
  county?: string;
  state_district?: string;
  postcode?: string;
  amenity?: string;
  building?: string;
}

// ---- Google (Places API New + Geocoding) ----

// One Autocomplete session per search: all keystrokes + the final Place Details are billed as a
// single session. The token is dropped after a place is picked.
let sessionToken: google.maps.places.AutocompleteSessionToken | null = null;
const reverseCache = new Map<string, GeocodeResult | null>();

async function googleSearch(query: string, signal?: AbortSignal): Promise<PlaceResult[]> {
  const { AutocompleteSuggestion, AutocompleteSessionToken } = await googleLib<google.maps.PlacesLibrary>('places');
  sessionToken ??= new AutocompleteSessionToken();
  const city = useSession.getState().selectedCity;
  const request: google.maps.places.AutocompleteRequest = {
    input: query.trim().slice(0, 100),
    sessionToken,
    includedRegionCodes: ['in'],
    language: 'en',
    region: 'in',
  };
  if (city?.center_lat != null && city.center_lng != null) {
    request.locationBias = { center: { lat: Number(city.center_lat), lng: Number(city.center_lng) }, radius: 30000 };
  }
  const { suggestions } = await AutocompleteSuggestion.fetchAutocompleteSuggestions(request);
  if (signal?.aborted) return [];
  return suggestions.slice(0, 6).flatMap((sug) => {
    const p = sug.placePrediction;
    if (!p) return [];
    return [
      {
        id: p.placeId,
        primaryText: p.mainText?.text ?? p.text.text,
        secondaryText: p.secondaryText?.text ?? '',
        resolve: async () => {
          const place = p.toPlace();
          await place.fetchFields({ fields: ['location'] });
          sessionToken = null;
          const loc = place.location;
          return loc ? { lat: loc.lat(), lng: loc.lng() } : null;
        },
      },
    ];
  });
}

const component = (r: google.maps.GeocoderResult, ...types: string[]) =>
  types.map((t) => r.address_components.find((c) => c.types.includes(t))?.long_name).find(Boolean) ?? null;

async function googleReverse(lat: number, lng: number): Promise<GeocodeResult | null> {
  const { Geocoder } = await googleLib<google.maps.GeocodingLibrary>('geocoding');
  const { results } = await new Geocoder().geocode({ location: { lat, lng }, language: 'en', region: 'in' });
  const best = results.find((r) => !r.types.includes('plus_code')) ?? results[0];
  if (!best) return null;
  return {
    addressLine: best.formatted_address,
    featureName: component(best, 'premise', 'point_of_interest', 'establishment', 'street_number'),
    subLocality: component(best, 'sublocality_level_1', 'sublocality', 'neighborhood'),
    locality: component(best, 'locality', 'administrative_area_level_3', 'administrative_area_level_2'),
    postalCode: component(best, 'postal_code'),
  };
}

// ---- Public API (Google when available, OpenStreetMap otherwise or on failure) ----

export async function searchPlaces(query: string, signal?: AbortSignal): Promise<PlaceResult[]> {
  if (query.trim().length < 3) return [];
  if (mapsProvider() === 'google') {
    try {
      return await googleSearch(query, signal);
    } catch (e) {
      reportGoogleFailure(e);
      if (signal?.aborted) return [];
    }
  }
  return nominatimSearch(query, signal);
}

export async function reverseGeocode(lat: number, lng: number): Promise<GeocodeResult | null> {
  // ~1 m precision: the same pin position is never looked up twice.
  const key = `${lat.toFixed(5)},${lng.toFixed(5)}`;
  if (reverseCache.has(key)) return reverseCache.get(key) ?? null;
  let result: GeocodeResult | null = null;
  if (mapsProvider() === 'google') {
    try {
      result = await googleReverse(lat, lng);
    } catch (e) {
      reportGoogleFailure(e);
    }
  }
  result ??= await nominatimReverse(lat, lng);
  if (result) {
    if (reverseCache.size > 200) reverseCache.clear();
    reverseCache.set(key, result);
  }
  return result;
}

// ---- OpenStreetMap Nominatim ----

async function nominatimSearch(query: string, signal?: AbortSignal): Promise<PlaceResult[]> {
  const url = `${NOMINATIM}/search?format=jsonv2&addressdetails=1&limit=6&countrycodes=in&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { signal, headers: { 'Accept-Language': 'en' } });
  if (!res.ok) return [];
  const rows = (await res.json()) as { place_id: number; display_name: string; lat: string; lon: string; name?: string }[];
  return rows.map((r) => {
    const parts = r.display_name.split(', ');
    return {
      id: String(r.place_id),
      primaryText: r.name || parts[0],
      secondaryText: parts.slice(1).join(', '),
      lat: parseFloat(r.lat),
      lng: parseFloat(r.lon),
    };
  });
}

async function nominatimReverse(lat: number, lng: number): Promise<GeocodeResult | null> {
  try {
    const url = `${NOMINATIM}/reverse?format=jsonv2&addressdetails=1&zoom=18&lat=${lat}&lon=${lng}`;
    const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
    if (!res.ok) return null;
    const json = (await res.json()) as { display_name?: string; name?: string; address?: NominatimAddress };
    if (!json.display_name) return null;
    const a = json.address ?? {};
    return {
      addressLine: json.display_name,
      featureName: json.name || a.amenity || a.building || null,
      subLocality: a.suburb || a.neighbourhood || null,
      locality: a.city || a.town || a.village || a.county || a.state_district || null,
      postalCode: a.postcode ?? null,
    };
  } catch {
    return null;
  }
}

/** Client-side fallback when the find_city_for_location RPC fails. Never invents cities. */
export function matchWithBackendCities(
  detectedCityName: string | null | undefined,
  lat: number | null,
  lng: number | null,
  cities: City[],
): City | null {
  if (!cities.length) return null;
  if (detectedCityName?.trim()) {
    const d = detectedCityName.trim().toLowerCase();
    const exact = cities.find((c) => c.name.trim().toLowerCase() === d);
    if (exact) return exact;
    const contains = cities.find((c) => {
      const n = c.name.trim().toLowerCase();
      return d.includes(n) || n.includes(d);
    });
    if (contains) return contains;
  }
  if (lat != null && lng != null) {
    let best: City | null = null;
    let min = Number.MAX_VALUE;
    for (const c of cities) {
      const hub =
        c.center_lat != null && c.center_lng != null
          ? ([Number(c.center_lat), Number(c.center_lng)] as [number, number])
          : KNOWN_HUBS[c.name.trim().toLowerCase()];
      if (hub) {
        const dist = haversineKm(lat, lng, hub[0], hub[1]);
        if (dist < 60 && dist < min) {
          min = dist;
          best = c;
        }
      }
    }
    if (best) return best;
  }
  return cities.length === 1 ? cities[0] : null;
}
