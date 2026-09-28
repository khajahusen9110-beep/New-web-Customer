import { useEffect, useRef } from 'react';
import { googleLib } from '../lib/googleMaps';
import type { LatLng } from './MapView';

type MapsLib = google.maps.MapsLibrary;
type MarkerLib = google.maps.MarkerLibrary;

const toLiteral = (p: LatLng): google.maps.LatLngLiteral => ({ lat: p[0], lng: p[1] });

const BASE_OPTIONS: google.maps.MapOptions = {
  disableDefaultUI: true,
  zoomControl: true,
  gestureHandling: 'greedy',
  clickableIcons: false,
};

/** Google map with a draggable pin; tap anywhere to move it. Same props as the Leaflet version. */
export function GooglePinPickerMap({
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
  flyKey?: string | number;
}) {
  const el = useRef<HTMLDivElement | null>(null);
  const map = useRef<google.maps.Map | null>(null);
  const marker = useRef<google.maps.Marker | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const posRef = useRef(position);
  posRef.current = position;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [{ Map }, { Marker }] = await Promise.all([googleLib<MapsLib>('maps'), googleLib<MarkerLib>('marker')]);
      if (cancelled || !el.current) return;
      map.current = new Map(el.current, { ...BASE_OPTIONS, center: toLiteral(posRef.current), zoom });
      marker.current = new Marker({ position: toLiteral(posRef.current), map: map.current, draggable: true });
      marker.current.addListener('dragend', () => {
        const p = marker.current?.getPosition();
        if (p) onChangeRef.current([p.lat(), p.lng()]);
      });
      map.current.addListener('click', (e: google.maps.MapMouseEvent) => {
        if (e.latLng) onChangeRef.current([e.latLng.lat(), e.latLng.lng()]);
      });
    })().catch(() => {
      /* provider switches to OpenStreetMap */
    });
    return () => {
      cancelled = true;
      marker.current?.setMap(null);
      marker.current = null;
      map.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the pin where the parent says it is.
  useEffect(() => {
    marker.current?.setPosition(toLiteral(position));
  }, [position]);

  // A new flyKey re-centres the map on the pin (search result, GPS button).
  useEffect(() => {
    if (!map.current) return;
    map.current.panTo(toLiteral(posRef.current));
    map.current.setZoom(zoom);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flyKey]);

  return <div className="map-box" style={{ height }} ref={el} />;
}

/** Live tracking on Google Maps: rider, destination and a straight line between them. */
export function GoogleTrackingMap({
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
  const el = useRef<HTMLDivElement | null>(null);
  const objs = useRef<{
    map: google.maps.Map;
    rider: google.maps.Marker;
    dest: google.maps.Marker;
    line: google.maps.Polyline;
  } | null>(null);
  const props = useRef({ rider, destination, riderLabel, destinationLabel });
  props.current = { rider, destination, riderLabel, destinationLabel };

  const sync = () => {
    const o = objs.current;
    if (!o) return;
    const { rider: r, destination: d, riderLabel: rl, destinationLabel: dl } = props.current;
    o.rider.setPosition(toLiteral(r));
    o.rider.setTitle(rl);
    if (d) {
      o.dest.setPosition(toLiteral(d));
      o.dest.setTitle(dl ?? 'Delivery Address');
      o.dest.setMap(o.map);
      o.line.setPath([toLiteral(r), toLiteral(d)]);
      o.line.setMap(o.map);
      const bounds = new google.maps.LatLngBounds();
      bounds.extend(toLiteral(r));
      bounds.extend(toLiteral(d));
      o.map.fitBounds(bounds, 40);
    } else {
      o.dest.setMap(null);
      o.line.setMap(null);
      o.map.setCenter(toLiteral(r));
      o.map.setZoom(15);
    }
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [{ Map, Polyline }, { Marker }] = await Promise.all([googleLib<MapsLib>('maps'), googleLib<MarkerLib>('marker')]);
      if (cancelled || !el.current) return;
      const map = new Map(el.current, { ...BASE_OPTIONS, center: toLiteral(props.current.rider), zoom: 15 });
      objs.current = {
        map,
        rider: new Marker({
          map,
          label: { text: '🛵', fontSize: '18px' },
          icon: {
            path: google.maps.SymbolPath.CIRCLE,
            scale: 16,
            fillColor: '#ffffff',
            fillOpacity: 1,
            strokeColor: '#6750A4',
            strokeWeight: 2,
          },
          zIndex: 2,
        }),
        dest: new Marker({ zIndex: 1 }),
        line: new Polyline({ strokeColor: '#6750A4', strokeWeight: 5, strokeOpacity: 0.9 }),
      };
      sync();
    })().catch(() => {
      /* provider switches to OpenStreetMap */
    });
    return () => {
      cancelled = true;
      const o = objs.current;
      o?.rider.setMap(null);
      o?.dest.setMap(null);
      o?.line.setMap(null);
      objs.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(sync, [rider, destination, riderLabel, destinationLabel]);

  return <div className="map-box" style={{ height }} ref={el} />;
}
