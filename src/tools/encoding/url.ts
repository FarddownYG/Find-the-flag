import { defineTool, bool, select, toggle } from '../../core/define';
import { toolT } from '../../i18n/tool-text';
import { isValidUtf8, toHex, utf8Decode, utf8Encode } from '../../lib/bytes';
import type { Output } from '../../core/types';

const T = toolT('url');

export type UrlScope = 'component' | 'uri' | 'reserved' | 'all';

const UNRESERVED = /[A-Za-z0-9\-_.~]/;
const RESERVED = ":/?#[]@!$&'()*+,;=";
const MAX_PASSES = 20;

/** Percent-encode the UTF-8 bytes of one character. */
const percent = (ch: string): string =>
  Array.from(utf8Encode(ch), (b) => `%${b.toString(16).toUpperCase().padStart(2, '0')}`).join('');

/**
 * - component: everything except A-Z a-z 0-9 - _ . ~ (RFC 3986 unreserved)
 * - uri: like encodeURI — keeps reserved characters (: / ? # [ ] @ ! $ & ' ( ) * + , ; =)
 * - reserved: the opposite — only reserved characters and % are encoded, the rest stays as is
 * - all: every byte as %XX
 * `plusForSpace` writes a space as "+" (form encoding) instead of %20.
 */
export function urlEncode(
  text: string,
  scope: UrlScope = 'component',
  plusForSpace = false,
): string {
  let out = '';
  for (const ch of text) {
    if (ch === ' ' && plusForSpace && scope !== 'all') {
      out += '+';
    } else if (scope === 'all') {
      out += percent(ch);
    } else if (scope === 'reserved') {
      out += RESERVED.includes(ch) || ch === '%' ? percent(ch) : ch;
    } else if (UNRESERVED.test(ch) || (scope === 'uri' && RESERVED.includes(ch))) {
      out += ch;
    } else {
      out += percent(ch);
    }
  }
  return out;
}

/** One decoding pass. Invalid escapes (a lone "%" or "%zz") are left as they are. */
export function urlDecodeOnce(text: string, plusAsSpace = false): Uint8Array {
  const out: number[] = [];
  const isHex = (c: number) =>
    (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
  for (let i = 0; i < text.length;) {
    const c = text.charCodeAt(i);
    if (
      c === 0x25 &&
      i + 2 < text.length &&
      isHex(text.charCodeAt(i + 1)) &&
      isHex(text.charCodeAt(i + 2))
    ) {
      out.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 3;
    } else if (c === 0x2b && plusAsSpace) {
      out.push(0x20);
      i++;
    } else if (c < 0x80) {
      out.push(c);
      i++;
    } else {
      const cp = text.codePointAt(i)!;
      out.push(...utf8Encode(String.fromCodePoint(cp)));
      i += cp > 0xffff ? 2 : 1;
    }
  }
  return Uint8Array.from(out);
}

export const hasPercentEscape = (text: string): boolean => /%[0-9a-fA-F]{2}/.test(text);

/**
 * Decode, optionally again and again until nothing changes (undoes double / triple encoding).
 * Stops when the result is not valid UTF-8 text or after 20 passes. Returns how many passes
 * actually changed something.
 */
export function urlDecode(
  text: string,
  plusAsSpace = false,
  repeat = false,
): { bytes: Uint8Array; passes: number } {
  let bytes = utf8Encode(text);
  let current = text;
  let passes = 0;
  while (passes < (repeat ? MAX_PASSES : 1)) {
    const next = urlDecodeOnce(current, plusAsSpace);
    if (next.length === bytes.length && next.every((b, i) => b === bytes[i])) break;
    bytes = next;
    passes++;
    if (!repeat || !isValidUtf8(bytes)) break;
    current = utf8Decode(bytes);
    if (!hasPercentEscape(current)) break;
  }
  return { bytes, passes };
}

export default defineTool({
  id: 'url',
  name: 'URL encode / decode',
  category: 'encoding',
  description: 'Percent-encode or decode text (%7B), including double-encoded and + as space.',
  tags: [
    'percent',
    'percent-encoding',
    'urlencode',
    'urldecode',
    'uri',
    'encodeURIComponent',
    '%20',
    'From URL',
    'To URL',
  ],
  input: 'text',
  placeholder: 'flag%7Burl_encoding_is_not_encryption%7D',
  options: {
    mode: toggle('Mode', ['decode', 'encode']),
    scope: select(
      'Encode',
      [
        { value: 'component', label: 'Everything except A-Z a-z 0-9 - _ . ~' },
        { value: 'uri', label: 'Like encodeURI (keep : / ? # & = ...)' },
        {
          value: 'reserved',
          label: "Only reserved characters (: / ? # [ ] @ ! $ & ' ( ) * + , ; = %)",
        },
        { value: 'all', label: 'Every character' },
      ],
      'component',
      { showIf: (v) => v.mode === 'encode' },
    ),
    plus: bool('Plus sign is a space', false, {
      hint: 'Form encoding: decode turns + into a space, encode writes spaces as +.',
    }),
    repeat: bool('Repeat until stable', false, {
      hint: 'Undo double or triple encoding (%2520 -> %20 -> space).',
      showIf: (v) => v.mode === 'decode',
    }),
  },
  examples: [
    {
      label: 'Decode a flag',
      input: 'flag%7Burl_encoding_is_not_encryption%7D',
      expect: 'flag{url_encoding_is_not_encryption}',
    },
    {
      label: 'Double-encoded',
      input: 'flag%257Bdouble%255Fencoded%257D',
      options: { repeat: true },
      expect: 'flag{double_encoded}',
    },
    {
      label: 'Form data (+ is a space)',
      input: 'flag%7Bhello+world%21%7D',
      options: { plus: true },
      expect: 'flag{hello world!}',
    },
    {
      label: 'Encode text',
      input: 'flag{a b/c}',
      options: { mode: 'encode' },
      expect: 'flag%7Ba%20b%2Fc%7D',
    },
    {
      label: 'Encode every character',
      input: 'flag',
      options: { mode: 'encode', scope: 'all' },
      expect: '%66%6C%61%67',
    },
  ],
  detect({ text }) {
    const t = text ?? '';
    const n = (t.match(/%[0-9a-fA-F]{2}/g) ?? []).length;
    if (n === 0 || t.length > 200000) return null;
    const double = /%25[0-9a-fA-F]{2}/.test(t);
    const score = n >= 3 ? 0.88 : n === 2 ? 0.75 : 0.55;
    return {
      score,
      options: { mode: 'decode', repeat: double, plus: /\+/.test(t) && /[?&]\w+=/.test(t) },
      reason: double ? T('detect.double') : T('detect.count', { count: n }),
    };
  },
  run(text, { mode, scope, plus, repeat }) {
    if (mode === 'encode') return [{ type: 'text', value: urlEncode(text, scope, plus) }];
    const { bytes, passes } = urlDecode(text, plus, repeat);
    const out: Output[] = [];
    if (isValidUtf8(bytes)) out.push({ type: 'text', value: utf8Decode(bytes) });
    else out.push({ type: 'bytes', value: bytes, filename: 'decoded.bin' });
    if (passes === 0) {
      out.push({
        type: 'note',
        level: 'info',
        text: plus ? T('note.nothingPlus') : T('note.nothing'),
      });
    } else if (passes > 1) {
      out.push({ type: 'note', level: 'info', text: T('note.passes', { count: passes }) });
    }
    if (!isValidUtf8(bytes)) {
      out.push({
        type: 'note',
        level: 'info',
        text: T('note.notUtf8', { hex: toHex(bytes.subarray(0, 8), ' ') }),
      });
    } else if (!repeat && hasPercentEscape(utf8Decode(bytes))) {
      out.push({
        type: 'note',
        level: 'warn',
        text: T('note.stillEncoded'),
      });
    }
    if (/%u[0-9a-fA-F]{4}/.test(text)) {
      out.push({
        type: 'note',
        level: 'info',
        text: T('note.percentU'),
      });
    }
    return out;
  },
});
