import { lazy, Suspense, type ComponentProps } from 'react';
import { useMapsProvider } from '../lib/googleMaps';

export type LatLng = [number, number];

// Each provider's code is downloaded only when it is used (Leaflet is not loaded with Google Maps).
const GooglePin = lazy(() => import('./GoogleMaps').then((m) => ({ default: m.GooglePinPickerMap })));
const GoogleTracking = lazy(() => import('./GoogleMaps').then((m) => ({ default: m.GoogleTrackingMap })));
const LeafletPin = lazy(() => import('./LeafletMaps').then((m) => ({ default: m.PinPickerMap })));
const LeafletTracking = lazy(() => import('./LeafletMaps').then((m) => ({ default: m.TrackingMap })));

type PinProps = ComponentProps<typeof GooglePin>;
type TrackingProps = ComponentProps<typeof GoogleTracking>;

const Placeholder = ({ height }: { height?: number }) => <div className="map-box" style={{ height: height ?? 270 }} />;

/** Map with a draggable pin: Google Maps when configured, otherwise OpenStreetMap. */
export function PinPickerMap(props: PinProps) {
  const provider = useMapsProvider();
  return (
    <Suspense fallback={<Placeholder height={props.height} />}>
      {provider === 'google' ? <GooglePin {...props} /> : <LeafletPin {...props} />}
    </Suspense>
  );
}

/** Live delivery tracking map: Google Maps when configured, otherwise OpenStreetMap. */
export function TrackingMap(props: TrackingProps) {
  const provider = useMapsProvider();
  return (
    <Suspense fallback={<Placeholder height={props.height ?? 220} />}>
      {provider === 'google' ? <GoogleTracking {...props} /> : <LeafletTracking {...props} />}
    </Suspense>
  );
}
