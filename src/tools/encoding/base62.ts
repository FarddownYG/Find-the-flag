import { defineTool, toggle } from '../../core/define';
import { toolT } from '../../i18n/tool-text';
import { printableRatio, utf8Decode } from '../../lib/bytes';
import { bigBaseDecode, bigBaseEncode } from './_bigbase';
import { bytesResult } from './_common';

const T = toolT('base62');

export const BASE62_ALPHABETS = {
  /** 0-9 A-Z a-z: the usual one (Python "base62", most URL shorteners). */
  digitsUpper: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
  /** 0-9 a-z A-Z: the ASCII-reversed case order used by some libraries (Go, PHP gmp). */
  digitsLower: '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ',
  /** A-Z a-z 0-9: Base64 order without the symbols. */
  lettersFirst: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
} as const;

export type Base62Alphabet = keyof typeof BASE62_ALPHABETS;

/** The bytes are one big-endian integer written in base 62; leading 0x00 bytes become "0"s. */
export function base62Encode(bytes: Uint8Array, alphabet: Base62Alphabet = 'digitsUpper'): string {
  return bigBaseEncode(bytes, BASE62_ALPHABETS[alphabet]);
}

/** Whitespace is ignored. Throws ToolError on any character outside A-Z a-z 0-9. */
export function base62Decode(text: string, alphabet: Base62Alphabet = 'digitsUpper'): Uint8Array {
  return bigBaseDecode(text, BASE62_ALPHABETS[alphabet], 'Base62');
}

export default defineTool({
  id: 'base62',
  name: 'Base62',
  category: 'encoding',
  description: 'Encode or decode Base62 (0-9, A-Z, a-z) as one big integer, in either case order.',
  tags: ['b62', 'base-62', 'bigint', 'url shortener', 'From Base62', 'To Base62'],
  input: 'bytes',
  placeholder: 'Ec4uB45OsTQcNl9MM3lq1utLgFh',
  live: true,
  options: {
    mode: toggle('Mode', ['decode', 'encode']),
    alphabet: toggle('Order', [
      { value: 'digitsUpper', label: '0-9 A-Z a-z' },
      { value: 'digitsLower', label: '0-9 a-z A-Z' },
      { value: 'lettersFirst', label: 'A-Z a-z 0-9' },
    ]),
  },
  examples: [
    {
      label: 'Decode a flag',
      input: 'Ec4uB45OsTQcNl9MM3lq1utLgFh',
      expect: 'flag{base62_big_int}',
    },
    {
      label: 'Other case order',
      input: 'eC4Ub45oStqCnL9mm3LQ1UTlGfH',
      options: { alphabet: 'digitsLower' },
      expect: 'flag{base62_big_int}',
    },
    {
      label: 'Encode text',
      input: 'flag{base62_big_int}',
      options: { mode: 'encode' },
      expect: 'Ec4uB45OsTQcNl9MM3lq1utLgFh',
    },
  ],
  detect({ text }) {
    const t = text?.trim() ?? '';
    if (t.length < 12 || t.length > 20000 || !/^[0-9A-Za-z]+$/.test(t)) return null;
    // Base62 text is also valid Base58/64: only claim it when the result reads as text.
    for (const alphabet of Object.keys(BASE62_ALPHABETS) as Base62Alphabet[]) {
      const out = base62Decode(t, alphabet);
      if (out.length >= 6 && printableRatio(out) >= 0.95) {
        return {
          score: 0.45,
          options: { mode: 'decode', alphabet },
          reason: T('detect.text'),
        };
      }
    }
    return null;
  },
  run({ bytes }, { mode, alphabet }) {
    if (mode === 'encode') return [{ type: 'text', value: base62Encode(bytes, alphabet) }];
    return bytesResult(base62Decode(utf8Decode(bytes), alphabet));
  },
});
