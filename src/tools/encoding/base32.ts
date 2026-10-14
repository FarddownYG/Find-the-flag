import { defineTool, bool, toggle } from '../../core/define';
import { ToolError } from '../../core/errors';
import { toolT } from '../../i18n/tool-text';
import { printableRatio, utf8Decode } from '../../lib/bytes';
import { bytesResult, showChar, stripSpace } from './_common';

const T = toolT('base32');

export const BASE32_ALPHABETS = {
  std: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567',
  hex: '0123456789ABCDEFGHIJKLMNOPQRSTUV',
  crockford: '0123456789ABCDEFGHJKMNPQRSTVWXYZ',
} as const;

export type Base32Alphabet = keyof typeof BASE32_ALPHABETS;

/** RFC 4648 Base32 (standard or "extended hex"), or Crockford's variant (never padded). */
export function base32Encode(
  bytes: Uint8Array,
  alphabet: Base32Alphabet = 'std',
  pad = alphabet !== 'crockford',
): string {
  const abc = BASE32_ALPHABETS[alphabet];
  let out = '';
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += abc[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += abc[(acc << (5 - bits)) & 31];
  if (pad && alphabet !== 'crockford') while (out.length % 8) out += '=';
  return out;
}

/**
 * Lenient decoder: case-insensitive, ignores whitespace, padding optional. Crockford also
 * ignores hyphens and reads I/L as 1 and O as 0. Throws ToolError on any other character.
 */
export function base32Decode(text: string, alphabet: Base32Alphabet = 'std'): Uint8Array {
  const abc = BASE32_ALPHABETS[alphabet];
  let s = stripSpace(text).replace(/=+$/, '').toUpperCase();
  if (alphabet === 'crockford') s = s.replace(/-/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');

  const map = new Int8Array(128).fill(-1);
  for (let i = 0; i < 32; i++) map[abc.charCodeAt(i)] = i;

  const out = new Uint8Array(Math.floor((s.length * 5) / 8));
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const v = c < 128 ? map[c]! : -1;
    if (v < 0) {
      const p = { char: showChar(s[i]), pos: i + 1 };
      throw new ToolError(
        alphabet === 'std' && '0189'.includes(s[i]!) ? T('error.digit', p) : T('error.char', p),
      );
    }
    acc = ((acc << 5) | v) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >>> bits) & 0xff;
    }
  }
  if ([1, 3, 6].includes(s.length % 8)) {
    throw new ToolError(T('error.truncated', { count: s.length }));
  }
  return out.subarray(0, o);
}

export default defineTool({
  id: 'base32',
  name: 'Base32',
  category: 'encoding',
  description:
    'Encode or decode Base32 (RFC 4648, base32hex, Crockford); padding and case optional.',
  tags: ['b32', 'base-32', 'rfc4648', 'crockford', 'base32hex', 'From Base32', 'To Base32'],
  input: 'bytes',
  placeholder: 'MZWGCZ33MJQXGZJTGJPWS427NZXXIX3DOJ4XA5DPPU======',
  live: true,
  options: {
    mode: toggle('Mode', ['decode', 'encode']),
    alphabet: toggle('Alphabet', [
      { value: 'std', label: 'Standard A–Z 2–7' },
      { value: 'hex', label: 'base32hex 0–9 A–V' },
      { value: 'crockford', label: 'Crockford' },
    ]),
    pad: bool('Pad with =', true, {
      showIf: (v) => v.mode === 'encode' && v.alphabet !== 'crockford',
    }),
  },
  examples: [
    {
      label: 'Decode a flag',
      input: 'MZWGCZ33MJQXGZJTGJPWS427NZXXIX3DOJ4XA5DPPU======',
      expect: 'flag{base32_is_not_crypto}',
    },
    {
      label: 'Lowercase, no padding',
      input: 'mzwgcz33mjqxgzjtgjpws427nzxxix3doj4xa5dppu',
      expect: 'flag{base32_is_not_crypto}',
    },
    {
      label: 'base32hex flag',
      input: 'CPM62PRRC9GN6P9J69K6AU3T',
      options: { alphabet: 'hex' },
      expect: 'flag{base32hex}',
    },
    {
      label: 'Encode text',
      input: 'foobar',
      options: { mode: 'encode' },
      expect: 'MZXW6YTBOI======',
    },
  ],
  detect({ text }) {
    const raw = text?.trim() ?? '';
    if (!/^[A-Za-z2-7=\r\n]+$/.test(raw)) return null;
    const t = stripSpace(raw);
    if (t.length < 8 || !/^[A-Za-z2-7]+=*$/.test(t)) return null;
    if (/[a-z]/.test(t) && /[A-Z]/.test(t)) return null;
    try {
      const out = base32Decode(t);
      const printable = printableRatio(out) >= 0.9;
      const padded = t.includes('=') && t.length % 8 === 0;
      const score = printable ? 0.88 : padded ? 0.75 : 0.3;
      return { score, options: { mode: 'decode', alphabet: 'std' }, reason: T('detect.charset') };
    } catch {
      return null;
    }
  },
  run({ bytes }, { mode, alphabet, pad }) {
    if (mode === 'encode') {
      return [{ type: 'text', value: base32Encode(bytes, alphabet, pad) }];
    }
    return bytesResult(base32Decode(utf8Decode(bytes), alphabet));
  },
});
