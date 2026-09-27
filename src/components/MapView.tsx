import { useEffect, useMemo, useRef } from 'react';
import L from 'leaflet';
import { MapContainer, Marker, Polyline, TileLayer, Tooltip, useMap, useMapEvents } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';

// Bundlers break Leaflet's default icon URLs; point them at the imported assets.
L.Icon.Default.mergeOptions({ iconUrl: markerIcon, iconRetinaUrl: markerIcon2x, shadowUrl: markerShadow });

const riderIcon = L.divIcon({
  className: 'rider-marker',
  html: '<div class="rider-dot">🛵</div>',
  iconSize: [34, 34],
  iconAnchor: [17, 17],
});

export type LatLng = [number, number];

const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

/** Re-centres once per mount; the parent remounts it (via `key`) to fly somewhere new. */
function Recenter({ center, zoom }: { center: LatLng; zoom?: number }) {
  const map = useMap();
  useEffect(() => {
    map.setView(center, zoom ?? map.getZoom(), { animate: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

function ClickHandler({ onPick }: { onPick: (p: LatLng) => void }) {
  useMapEvents({ click: (e) => onPick([e.latlng.lat, e.latlng.lng]) });
  return null;
}

/** Map with a draggable pin; tap anywhere to move it. */
export function PinPickerMap({
  position,
  onChange,
  height = 270,
  zoom = 17,
  flyKey,
}: {
  position: LatLng;
  onChange: (p: LatLng) => void;
  height?: number;
  zoom?: number;
  /** Changing this re-centres the map on `position`. */
  flyKey?: string | number;
}) {
  const markerRef = useRef<L.Marker | null>(null);
  const handlers = useMemo(
    () => ({
      dragend: () => {
        const m = markerRef.current;
        if (m) {
          const ll = m.getLatLng();
          onChange([ll.lat, ll.lng]);
        }
      },
    }),
    [onChange],
  );
  return (
    <div className="map-box" style={{ height }}>
      <MapContainer center={position} zoom={zoom} scrollWheelZoom style={{ height: '100%', width: '100%' }}>
        <TileLayer url={TILE_URL} attribution={ATTRIBUTION} />
        <Marker position={position} draggable eventHandlers={handlers} ref={markerRef} />
        <ClickHandler onPick={onChange} />
        <Recenter key={String(flyKey ?? '')} center={position} zoom={zoom} />
      </MapContainer>
    </div>
  );
}

function FitBounds({ points }: { points: LatLng[] }) {
  const map = useMap();
  useEffect(() => {
    if (points.length === 1) map.setView(points[0], 15);
    else if (points.length > 1) map.fitBounds(L.latLngBounds(points), { padding: [40, 40] });
  }, [points, map]);
  return null;
}

/** Live tracking map: rider marker, destination marker and a straight route line. */
export function TrackingMap({
  rider,
  destination,
  riderLabel,
  destinationLabel,
  height = 220,
}: {
  rider: LatLng;
  destination?: LatLng | null;
  riderLabel: string;
  destinationLabel?: string;
  height?: number;
}) {
  const points = useMemo(() => (destination ? [rider, destination] : [rider]), [rider, destination]);
  return (
    <div className="map-box" style={{ height }}>
      <MapContainer center={rider} zoom={15} style={{ height: '100%', width: '100%' }}>
        <TileLayer url={TILE_URL} attribution={ATTRIBUTION} />
        <Marker position={rider} icon={riderIcon}>
          <Tooltip>{riderLabel}</Tooltip>
        </Marker>
        {destination && (
          <>
            <Marker position={destination}>
              <Tooltip>{destinationLabel ?? 'Delivery Address'}</Tooltip>
            </Marker>
            <Polyline positions={[rider, destination]} pathOptions={{ color: '#6750A4', weight: 5 }} />
          </>
        )}
        <FitBounds points={points} />
      </MapContainer>
    </div>
  );
}
