import { bool, defineTool, toggle } from '../../core/define';
import { ToolError } from '../../core/errors';
import type { Output } from '../../core/types';
import { toolT } from '../../i18n/tool-text';
import { printableRatio, utf8Decode } from '../../lib/bytes';
import { isGzip, isZlib } from './_inflate';
import { bytesResult, showChar } from './_common';

const T = toolT('base45');

/** RFC 9285 table 1: the 45 characters a QR code can store in its compact "alphanumeric" mode. */
export const BASE45_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
const INDEX = new Map<string, number>([...BASE45_ALPHABET].map((c, i) => [c, i]));

/** Prefix of the EU digital COVID certificate: the rest is Base45 of zlib-compressed CBOR. */
export const HC1_PREFIX = 'HC1:';

/** Two bytes make three characters (little-endian digits), a last odd byte makes two. */
export function base45Encode(bytes: Uint8Array): string {
  const abc = BASE45_ALPHABET;
  let out = '';
  let i = 0;
  for (; i + 1 < bytes.length; i += 2) {
    const n = bytes[i]! * 256 + bytes[i + 1]!;
    out += abc[n % 45]! + abc[Math.floor(n / 45) % 45]! + abc[Math.floor(n / 2025)]!;
  }
  if (i < bytes.length) {
    const n = bytes[i]!;
    out += abc[n % 45]! + abc[Math.floor(n / 45)]!;
  }
  return out;
}

/**
 * Strict RFC 9285 decoder. Line breaks are ignored (wrapped QR text); a space is part of the
 * alphabet and is data. Throws ToolError on a character outside the alphabet, on a group that
 * stands for more than two bytes (> 65535) or one byte (> 255), and on a lone last character.
 * Positions count characters of the text as given (line breaks included).
 */
export function base45Decode(text: string, ignoreCase = false): Uint8Array {
  const values: number[] = [];
  const where: number[] = [];
  let pos = 0;
  for (const ch of text) {
    pos++;
    if (ch === '\n' || ch === '\r') continue;
    const v = INDEX.get(ignoreCase && /^[a-z]$/.test(ch) ? ch.toUpperCase() : ch);
    if (v === undefined) {
      const p = { char: showChar(ch), pos };
      throw new ToolError(/^[a-z]$/.test(ch) ? T('error.lower', p) : T('error.char', p));
    }
    values.push(v);
    where.push(pos);
  }

  const out = new Uint8Array(Math.floor(values.length / 3) * 2 + (values.length % 3 ? 1 : 0));
  let o = 0;
  let i = 0;
  const show = (from: number, to: number) =>
    values
      .slice(from, to)
      .map((v) => BASE45_ALPHABET[v]!)
      .join('');
  for (; i + 2 < values.length; i += 3) {
    const n = values[i]! + values[i + 1]! * 45 + values[i + 2]! * 2025;
    if (n > 0xffff) {
      throw new ToolError(
        T('error.group', { group: show(i, i + 3), from: where[i]!, to: where[i + 2]!, value: n }),
      );
    }
    out[o++] = n >> 8;
    out[o++] = n & 0xff;
  }
  const rest = values.length - i;
  if (rest === 1) {
    throw new ToolError(T('error.truncated', { pos: where[i]!, char: show(i, i + 1) }));
  }
  if (rest === 2) {
    const n = values[i]! + values[i + 1]! * 45;
    if (n > 0xff) {
      throw new ToolError(
        T('error.pair', { group: show(i, i + 2), from: where[i]!, to: where[i + 1]!, value: n }),
      );
    }
    out[o] = n;
  }
  return out;
}

/** Decode, dropping the "HC1:" prefix of an EU certificate first. `prefix` tells if it was there. */
export function base45DecodeText(
  text: string,
  ignoreCase = false,
): { bytes: Uint8Array; prefix: boolean } {
  const prefix = text.startsWith(HC1_PREFIX);
  return { bytes: base45Decode(prefix ? text.slice(HC1_PREFIX.length) : text, ignoreCase), prefix };
}

export default defineTool({
  id: 'base45',
  name: 'Base45',
  category: 'encoding',
  description: 'Encode or decode Base45 (RFC 9285): the QR-code alphabet of EU COVID certificates.',
  tags: [
    'b45',
    'base-45',
    'rfc9285',
    'qr',
    'qr code',
    'alphanumeric',
    'covid',
    'green pass',
    'hc1',
    'dcc',
    'From Base45',
    'To Base45',
  ],
  input: 'bytes',
  placeholder: '%69 VD92EX0',
  live: true,
  options: {
    mode: toggle('Mode', ['decode', 'encode']),
    ignoreCase: bool('Accept lower case', false, {
      hint: 'Base45 is upper case only: read a–z as A–Z instead of failing.',
      showIf: (v) => v.mode === 'decode',
    }),
  },
  examples: [
    { label: 'Decode "Hello!!" (RFC 9285)', input: '%69 VD92EX0', expect: 'Hello!!' },
    {
      label: 'Decode a flag',
      input: 'U.C5EC-QFHECXZCSX6X.CTKEHFEZ2',
      expect: 'flag{base45_for_qr}',
    },
    {
      label: 'Encode text',
      input: 'base-45',
      options: { mode: 'encode' },
      expect: 'UJCLQE7W581',
    },
    {
      label: 'EU certificate prefix HC1:',
      input: 'HC1:6BF8Q9:B96AM 592 HRZP5G6FIA2IDMO80-0',
      expect: 'The HC1: prefix was removed',
    },
  ],
  detect({ text }) {
    const t = (text ?? '').replace(/[\r\n]+/g, '');
    if (t.length < 6 || !/^[0-9A-Z $%*+\-./:]+$/.test(t)) return null;
    // Plain capital letters and spaces are just upper-case text, not Base45.
    if (/^[A-Z ]+$/.test(t)) return null;
    try {
      const { bytes, prefix } = base45DecodeText(t);
      if (prefix) return { score: 0.9, options: { mode: 'decode' }, reason: T('detect.hc1') };
      if (printableRatio(bytes) >= 0.9) {
        // Readable bytes by chance are unlikely, and this beats the generic Base64 guess that an
        // upper-case-and-digits token also gets.
        const score = bytes.length >= 5 ? 0.85 : 0.7;
        return { score, options: { mode: 'decode' }, reason: T('detect.text') };
      }
      if (isZlib(bytes) || isGzip(bytes)) {
        return { score: 0.7, options: { mode: 'decode' }, reason: T('detect.compressed') };
      }
      return null;
    } catch {
      return null;
    }
  },
  run({ bytes }, { mode, ignoreCase }) {
    if (mode === 'encode') return [{ type: 'text', value: base45Encode(bytes) }];
    const { bytes: decoded, prefix } = base45DecodeText(utf8Decode(bytes), ignoreCase);
    const out: Output[] = bytesResult(decoded);
    if (prefix) {
      out.push({
        type: 'note',
        level: 'info',
        text: T(isZlib(decoded) ? 'note.hc1Zlib' : 'note.hc1'),
      });
    }
    return out;
  },
});
