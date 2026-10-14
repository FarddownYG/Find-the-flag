import { mapLinks } from '../core/result-text';
import type { Output } from '../core/types';
import { h } from './dom';

const TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

/** Degrees-minutes-seconds; the total is rounded first so 59.999″ never prints as "60″". */
export function dms(v: number, pos: string, neg: string): string {
  const total = Math.round(Math.abs(v) * 360000) / 100;
  const d = Math.floor(total / 3600);
  const m = Math.floor((total - d * 3600) / 60);
  const s = total - d * 3600 - m * 60;
  return `${d}° ${m}′ ${s.toFixed(2)}″ ${v < 0 ? neg : pos}`;
}

/**
 * Coordinates and outbound links need no network. The interactive map is opt-in: tiles come
 * from openstreetmap.org, which then learns the area being viewed, so nothing loads before a click.
 */
export function mapBlock(o: Extract<Output, { type: 'map' }>): HTMLElement {
  const links = mapLinks(o.lat, o.lon);
  const holder = h('div', { class: 'map-holder', hidden: true });
  const show: HTMLButtonElement = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-ghost',
      onclick: async () => {
        show.disabled = true;
        show.textContent = 'Loading map…';
        try {
          const [{ default: L }] = await Promise.all([
            import('leaflet'),
            import('leaflet/dist/leaflet.css'),
          ]);
          holder.hidden = false;
          const map = L.map(holder, { scrollWheelZoom: false }).setView(
            [o.lat, o.lon],
            o.zoom ?? 15,
          );
          // The default prefix is a bare link to leafletjs.com; keep the attribution text only.
          map.attributionControl.setPrefix(false);
          L.tileLayer(TILES, {
            maxZoom: 19,
            attribution: '© OpenStreetMap contributors',
            referrerPolicy: 'strict-origin-when-cross-origin',
          }).addTo(map);
          L.circleMarker([o.lat, o.lon], {
            radius: 9,
            color: '#1d1604',
            weight: 2,
            fillColor: '#f2c84b',
            fillOpacity: 1,
          }).addTo(map);
          show.remove();
          notice.remove();
        } catch {
          show.disabled = false;
          show.textContent = 'Map failed to load — retry';
        }
      },
    },
    'Show map',
  );
  const notice = h(
    'span',
    { class: 'fine' },
    'Loads tiles from openstreetmap.org, which will see this area. Your file never leaves the page.',
  );
  return h(
    'section',
    { class: 'out out-map', 'data-lat': o.lat, 'data-lon': o.lon },
    h(
      'div',
      { class: 'out-head' },
      h('span', { class: 'out-label' }, o.label ?? 'Location'),
      h('span', { class: 'out-meta' }, `${o.lat.toFixed(6)}, ${o.lon.toFixed(6)}`),
    ),
    h(
      'div',
      { class: 'map-info' },
      h('p', { class: 'map-coords' }, `${dms(o.lat, 'N', 'S')}  ${dms(o.lon, 'E', 'W')}`),
      h(
        'p',
        { class: 'map-links' },
        h(
          'a',
          {
            href: links.google,
            target: '_blank',
            rel: 'noopener noreferrer',
            class: 'btn btn-ghost',
          },
          'Open in Google Maps',
        ),
        h(
          'a',
          { href: links.osm, target: '_blank', rel: 'noopener noreferrer', class: 'btn btn-ghost' },
          'Open in OpenStreetMap',
        ),
        show,
      ),
      notice,
    ),
    holder,
  );
}
