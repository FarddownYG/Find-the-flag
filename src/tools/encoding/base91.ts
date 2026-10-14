import { defineTool, toggle } from '../../core/define';
import { ToolError } from '../../core/errors';
import { printableRatio, utf8Decode } from '../../lib/bytes';
import { bytesResult, showChar, stripSpace } from './_common';

/** basE91 by Joachim Henke: 91 printable characters, no space, "-", "'" or "\". */
export const BASE91_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#$%&()*+,./:;<=>?@[]^_`{|}~"';

export function base91Encode(bytes: Uint8Array): string {
  const abc = BASE91_ALPHABET;
  let out = '';
  let b = 0;
  let n = 0;
  for (const byte of bytes) {
    b |= byte << n;
    n += 8;
    if (n > 13) {
      let v = b & 8191;
      if (v > 88) {
        b >>= 13;
        n -= 13;
      } else {
        v = b & 16383;
        b >>= 14;
        n -= 14;
      }
      out += abc[v % 91]! + abc[Math.floor(v / 91)]!;
    }
  }
  if (n) {
    out += abc[b % 91]!;
    if (n > 7 || b > 90) out += abc[Math.floor(b / 91)]!;
  }
  return out;
}

/** Whitespace is ignored; any other character outside the alphabet throws a ToolError. */
export function base91Decode(text: string): Uint8Array {
  const s = stripSpace(text);
  const map = new Int8Array(128).fill(-1);
  for (let i = 0; i < 91; i++) map[BASE91_ALPHABET.charCodeAt(i)] = i;

  const out: number[] = [];
  let v = -1;
  let b = 0;
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const d = c < 128 ? map[c]! : -1;
    if (d < 0) {
      throw new ToolError(
        `Not basE91: "${showChar(s[i])}" at position ${i + 1} is not in the alphabet (no space, "-", "'" or "\\").`,
      );
    }
    if (v < 0) {
      v = d;
    } else {
      v += d * 91;
      b |= v << n;
      n += (v & 8191) > 88 ? 13 : 14;
      do {
        out.push(b & 255);
        b >>= 8;
        n -= 8;
      } while (n > 7);
      v = -1;
    }
  }
  if (v >= 0) out.push((b | (v << n)) & 255);
  return Uint8Array.from(out);
}

export default defineTool({
  id: 'base91',
  name: 'Base91',
  category: 'encoding',
  description: 'Encode or decode basE91 (Joachim Henke), about 23% denser than Base64.',
  tags: ['b91', 'base-91', 'basE91', 'henke', 'From Base91', 'To Base91'],
  input: 'bytes',
  placeholder: '@iH<,{,Hb%&@_@Elr}df6=8eEW',
  live: true,
  options: {
    mode: toggle('Mode', ['decode', 'encode']),
  },
  examples: [
    {
      label: 'Decode a flag',
      input: '@iH<,{,Hb%&@_@Elr}df6=8eEW',
      expect: 'flag{base91_is_dense}',
    },
    {
      label: 'Encode text',
      input: 'test',
      options: { mode: 'encode' },
      expect: 'fPNKd',
    },
  ],
  detect({ text }) {
    const t = text?.trim() ?? '';
    if (t.length < 12 || t.length > 20000 || /\s/.test(t)) return null;
    // Needs the punctuation that makes it different from Base64, otherwise Base64 wins.
    if (!/[!#$%&()*+,./:;<=>?@[\]^_`{|}~"]/.test(t)) return null;
    try {
      const out = base91Decode(t);
      if (out.length >= 6 && printableRatio(out) >= 0.95) {
        return { score: 0.6, options: { mode: 'decode' }, reason: 'Decodes to text as basE91' };
      }
    } catch {
      return null;
    }
    return null;
  },
  run({ bytes }, { mode }) {
    if (mode === 'encode') return [{ type: 'text', value: base91Encode(bytes) }];
    return bytesResult(base91Decode(utf8Decode(bytes)));
  },
});
