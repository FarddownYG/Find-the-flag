import { defineTool, toggle } from '../../core/define';
import { ToolError } from '../../core/errors';
import { toolT } from '../../i18n/tool-text';
import { printableRatio, utf8Decode } from '../../lib/bytes';
import { bigBaseDecode, bigBaseEncode } from './_bigbase';
import { bytesResult } from './_common';

const T = toolT('base58');

export const BASE58_ALPHABETS = {
  bitcoin: '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz',
  flickr: '123456789abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ',
  ripple: 'rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz',
} as const;

export type Base58Alphabet = keyof typeof BASE58_ALPHABETS;

/** Base58 of the bytes as one big-endian integer; each leading 0x00 byte becomes a leading "1". */
export function base58Encode(bytes: Uint8Array, alphabet: Base58Alphabet = 'bitcoin'): string {
  return bigBaseEncode(bytes, BASE58_ALPHABETS[alphabet]);
}

/** Whitespace is ignored. Throws ToolError on a character outside the alphabet (0, O, I, l...). */
export function base58Decode(text: string, alphabet: Base58Alphabet = 'bitcoin'): Uint8Array {
  const abc = BASE58_ALPHABETS[alphabet];
  try {
    return bigBaseDecode(text, abc, 'Base58');
  } catch (e) {
    if (e instanceof ToolError && /"[0OIl]"/.test(e.message) && !abc.includes('0')) {
      throw new ToolError(T('error.lookalikes', { message: e.message }));
    }
    throw e;
  }
}

export default defineTool({
  id: 'base58',
  name: 'Base58',
  category: 'encoding',
  description: 'Encode or decode Base58 (Bitcoin, Flickr or Ripple alphabet), leading zeros kept.',
  tags: ['b58', 'base-58', 'bitcoin', 'btc', 'address', 'ipfs', 'From Base58', 'To Base58'],
  input: 'bytes',
  placeholder: '48uXsVXpkFDMtHVURyP3maKiZdwgoeM5BR3S',
  live: true,
  options: {
    mode: toggle('Mode', ['decode', 'encode']),
    alphabet: toggle('Alphabet', [
      { value: 'bitcoin', label: 'Bitcoin' },
      { value: 'flickr', label: 'Flickr' },
      { value: 'ripple', label: 'Ripple' },
    ]),
  },
  examples: [
    {
      label: 'Decode a flag',
      input: '48uXsVXpkFDMtHVURyP3maKiZdwgoeM5BR3S',
      expect: 'flag{base58_no_lookalikes}',
    },
    {
      label: 'Encode text',
      input: 'Hello World!',
      options: { mode: 'encode' },
      expect: '2NEpo7TZRRrLZSi2U',
    },
    {
      label: 'Flickr alphabet',
      input: 'Hello World!',
      options: { mode: 'encode', alphabet: 'flickr' },
      expect: '2nePN7syqqRkyrH2t',
    },
  ],
  detect({ text }) {
    const t = text?.trim() ?? '';
    if (t.length < 12 || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(t)) return null;
    try {
      const out = base58Decode(t);
      if (printableRatio(out) >= 0.9) {
        return {
          score: 0.8,
          options: { mode: 'decode' },
          reason: T('detect.text'),
        };
      }
      return { score: 0.3, options: { mode: 'decode' }, reason: T('detect.charset') };
    } catch {
      return null;
    }
  },
  run({ bytes }, { mode, alphabet }) {
    if (mode === 'encode') return [{ type: 'text', value: base58Encode(bytes, alphabet) }];
    return bytesResult(base58Decode(utf8Decode(bytes), alphabet));
  },
});
