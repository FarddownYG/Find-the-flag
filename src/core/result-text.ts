import type { ToolResult } from './types';
import { utf8Decode } from '../lib/bytes';

/** Links that open a location in a map site (a user-initiated navigation, not a request). */
export function mapLinks(lat: number, lon: number) {
  const la = lat.toFixed(6);
  const lo = lon.toFixed(6);
  return {
    google: `https://www.google.com/maps/search/?api=1&query=${la},${lo}`,
    osm: `https://www.openstreetmap.org/?mlat=${la}&mlon=${lo}#map=16/${la}/${lo}`,
  };
}

/** Flatten a result to plain text — what example `expect` strings are matched against. */
export function resultToText(result: ToolResult): string {
  const parts: string[] = [];
  for (const o of result) {
    if ('label' in o && o.label) parts.push(o.label);
    switch (o.type) {
      case 'text':
        parts.push(o.value);
        break;
      case 'bytes':
        parts.push(utf8Decode(o.value));
        break;
      case 'table':
        parts.push(o.columns.join('\t'), ...o.rows.map((r) => r.join('\t')));
        break;
      case 'kv':
        parts.push(...o.entries.map(([k, v]) => `${k}: ${v}`));
        break;
      case 'files':
        parts.push(...o.files.map((f) => `${f.name}${f.note ? ` ${f.note}` : ''}`));
        break;
      case 'note':
        parts.push(o.text);
        break;
      case 'image':
        parts.push(`[image ${o.image.width}x${o.image.height}]`);
        break;
      case 'picture':
        parts.push(`[picture ${o.mime}, ${o.data.length} bytes]`);
        break;
      case 'map':
        parts.push(`${o.lat.toFixed(6)}, ${o.lon.toFixed(6)}`, mapLinks(o.lat, o.lon).google);
        break;
      case 'actions':
        parts.push(...o.actions.map((a) => a.label));
        break;
      case 'reorder':
        parts.push(...o.items.map((i) => `${i.label}${i.detail ? ` ${i.detail}` : ''}`));
        break;
    }
  }
  return parts.join('\n');
}
