import { mapLinks } from '../core/result-text';
import type { Output } from '../core/types';
import { t } from '../i18n';
import { copyText, h } from './dom';
import { externalLink } from './links';

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
        show.textContent = t('ui.map.loading');
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
          show.textContent = t('ui.map.failed');
        }
      },
    },
    t('ui.map.show'),
  );
  const notice = h('span', { class: 'fine' }, t('ui.map.notice'));
  const decimal = `${o.lat.toFixed(6)}, ${o.lon.toFixed(6)}`;
  const dmsText = `${dms(o.lat, 'N', 'S')}  ${dms(o.lon, 'E', 'W')}`;
  const row = (label: string, value: string) => {
    const copy: HTMLButtonElement = h(
      'button',
      { type: 'button', class: 'btn btn-ghost', onclick: () => void copyText(value, copy) },
      t('ui.out.copy'),
    );
    return h(
      'p',
      { class: 'map-row' },
      h('span', { class: 'fine' }, label),
      h('span', { class: 'map-coords' }, value),
      copy,
    );
  };
  // A position off the globe is shown as found, with no way to open it anywhere.
  const usable = o.problem !== 'range';
  return h(
    'section',
    { class: 'out out-map', 'data-lat': o.lat, 'data-lon': o.lon },
    h(
      'div',
      { class: 'out-head' },
      h('span', { class: 'out-label' }, o.label ?? t('ui.map.localisation')),
      h('span', { class: 'out-meta' }, decimal),
    ),
    h(
      'div',
      { class: 'map-info' },
      o.problem
        ? h('p', { class: 'map-warn' }, t(o.problem === 'zero' ? 'ui.map.fake' : 'ui.map.invalid'))
        : null,
      row(t('ui.map.decimal'), decimal),
      usable ? row(t('ui.map.dms'), dmsText) : null,
      o.altitude
        ? h(
            'p',
            { class: 'map-row' },
            h('span', { class: 'fine' }, t('ui.map.altitude')),
            o.altitude,
          )
        : null,
      o.time
        ? h('p', { class: 'map-row' }, h('span', { class: 'fine' }, t('ui.map.time')), o.time)
        : null,
      usable
        ? h(
            'p',
            { class: 'map-links' },
            externalLink(links.google, t('ui.map.google'), { class: 'btn btn-ghost' }),
            externalLink(links.osm, t('ui.map.osm'), { class: 'btn btn-ghost' }),
            show,
          )
        : null,
      usable ? h('p', { class: 'fine' }, t('ui.map.privacy')) : null,
      usable ? notice : null,
    ),
    holder,
  );
}
