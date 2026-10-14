import type { ToolResult } from './types';
import { utf8Decode } from '../lib/bytes';

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
    }
  }
  return parts.join('\n');
}
