import type { Output } from '../../core/types';
import { toolT } from '../../i18n/tool-text';
import { isValidUtf8 } from '../../lib/bytes';

/** Same note as the Base64 tool, so it shares its key. */
const T = toolT('base64');

/**
 * Result block for a decoder whose output may be binary: the bytes, plus a hint when they are
 * not UTF-8 text (same behaviour as the Base64 tool).
 */
export function bytesResult(value: Uint8Array, filename = 'decoded.bin'): Output[] {
  const out: Output[] = [{ type: 'bytes', value, filename }];
  if (value.length && !isValidUtf8(value)) {
    out.push({
      type: 'note',
      level: 'info',
      text: T('note.binary'),
    });
  }
  return out;
}

/** Remove every whitespace character. */
export const stripSpace = (s: string): string => s.replace(/\s+/g, '');

/** Printable-ASCII preview of a string for error messages: never dumps control characters. */
export function showChar(ch: string | undefined): string {
  if (ch === undefined) return '?';
  const c = ch.codePointAt(0) ?? 0;
  if (c < 0x20 || c === 0x7f) return `U+${c.toString(16).toUpperCase().padStart(4, '0')}`;
  return ch;
}
