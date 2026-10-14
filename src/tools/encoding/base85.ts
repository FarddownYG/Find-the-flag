import { defineTool, bool, toggle } from '../../core/define';
import { ToolError } from '../../core/errors';
import { printableRatio, utf8Decode } from '../../lib/bytes';
import { bytesResult, showChar, stripSpace } from './_common';

export type Base85Variant = 'ascii85' | 'z85' | 'rfc1924';

/** Ascii85 uses the 85 characters from "!" (33) to "u" (117). */
const ASCII85 = Array.from({ length: 85 }, (_, i) => String.fromCharCode(33 + i)).join('');
/** ZeroMQ's Z85: printable and safe to paste in source code (no quote, backslash...). */
const Z85 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-:+=^!/*?&<>()[]{}@%$#';
/** RFC 1924 (IPv6 in 20 chars), the alphabet of Python's base64.b85encode and git. */
const RFC1924 =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_`{|}~';

export const BASE85_ALPHABETS: Record<Base85Variant, string> = {
  ascii85: ASCII85,
  z85: Z85,
  rfc1924: RFC1924,
};

const NAMES: Record<Base85Variant, string> = {
  ascii85: 'Ascii85',
  z85: 'Z85',
  rfc1924: 'RFC 1924 Base85',
};

/**
 * Encode 4-byte groups as 5 digits. A final group of n bytes (1-3) is zero-padded and
 * written as n + 1 digits, like Ascii85 and Python's b85encode (also used for Z85 here
 * although the ZeroMQ spec only defines whole groups).
 * Ascii85 writes "z" for a group of four zero bytes; `adobe` wraps the result in <~ ~>.
 */
export function base85Encode(
  bytes: Uint8Array,
  variant: Base85Variant = 'ascii85',
  adobe = false,
): string {
  const abc = BASE85_ALPHABETS[variant];
  let out = '';
  for (let i = 0; i < bytes.length; i += 4) {
    const n = Math.min(4, bytes.length - i);
    let v = 0;
    for (let j = 0; j < 4; j++) v = v * 256 + (j < n ? bytes[i + j]! : 0);
    if (v === 0 && n === 4 && variant === 'ascii85') {
      out += 'z';
      continue;
    }
    const digits = new Array<string>(5);
    for (let j = 4; j >= 0; j--) {
      digits[j] = abc[v % 85]!;
      v = Math.floor(v / 85);
    }
    out += digits.slice(0, n + 1).join('');
  }
  return adobe && variant === 'ascii85' ? `<~${out}~>` : out;
}

/**
 * Whitespace is ignored. Ascii85 accepts the optional <~ ~> frame and the "z" shortcut.
 * A final group of 2-4 characters yields 1-3 bytes. Throws ToolError on a character outside
 * the alphabet, a lone trailing character, or a group that overflows 32 bits.
 */
export function base85Decode(text: string, variant: Base85Variant = 'ascii85'): Uint8Array {
  const abc = BASE85_ALPHABETS[variant];
  let s = stripSpace(text);
  if (variant === 'ascii85') {
    if (s.startsWith('<~')) s = s.slice(2);
    if (s.endsWith('~>')) s = s.slice(0, -2);
  }
  const map = new Int8Array(128).fill(-1);
  for (let i = 0; i < 85; i++) map[abc.charCodeAt(i)] = i;

  const out: number[] = [];
  const group: number[] = [];
  const flush = (size: number) => {
    let v = 0;
    for (let j = 0; j < 5; j++) v = v * 85 + (j < size ? group[j]! : 84);
    if (v > 0xffffffff) {
      throw new ToolError(
        `Not ${NAMES[variant]}: a group of 5 characters is too large for 4 bytes. Wrong variant, or corrupted data?`,
      );
    }
    const n = size === 5 ? 4 : size - 1;
    for (let j = 0; j < n; j++) out.push(Math.floor(v / 256 ** (3 - j)) & 0xff);
    group.length = 0;
  };

  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === 'z' && variant === 'ascii85') {
      if (group.length)
        throw new ToolError(`Not Ascii85: "z" in the middle of a group (position ${i + 1}).`);
      out.push(0, 0, 0, 0);
      continue;
    }
    const c = ch.charCodeAt(0);
    const d = c < 128 ? map[c]! : -1;
    if (d < 0) {
      throw new ToolError(
        `Not ${NAMES[variant]}: "${showChar(ch)}" at position ${i + 1} is not in its alphabet. Try another variant.`,
      );
    }
    group.push(d);
    if (group.length === 5) flush(5);
  }
  if (group.length === 1) {
    throw new ToolError(
      `Truncated ${NAMES[variant]}: one character is left over (groups of 5 hold 4 bytes). Check for missing characters.`,
    );
  }
  if (group.length) flush(group.length);
  return Uint8Array.from(out);
}

const VARIANTS: Base85Variant[] = ['ascii85', 'rfc1924', 'z85'];

export default defineTool({
  id: 'base85',
  name: 'Base85',
  category: 'encoding',
  description: 'Encode or decode Ascii85 (Adobe, <~ ~>), Z85 (ZeroMQ) or RFC 1924 (Python b85).',
  tags: ['b85', 'ascii85', 'a85', 'z85', 'rfc1924', 'btoa', 'zeromq', 'From Base85', 'To Base85'],
  input: 'bytes',
  placeholder: '<~Ao(mgHXUu*Bk]Oa?YORgA7]Y"ATE2~>',
  live: true,
  options: {
    mode: toggle('Mode', ['decode', 'encode']),
    variant: toggle('Variant', [
      { value: 'ascii85', label: 'Ascii85 (Adobe)' },
      { value: 'rfc1924', label: 'RFC 1924 / Python b85' },
      { value: 'z85', label: 'Z85 (ZeroMQ)' },
    ]),
    adobe: bool('Wrap in <~ ~>', false, {
      showIf: (v) => v.mode === 'encode' && v.variant === 'ascii85',
    }),
  },
  examples: [
    {
      label: 'Ascii85 with <~ ~>',
      input: '<~Ao(mgHXUu*Bk]Oa?YORgA7]Y"ATE2~>',
      expect: 'flag{ascii85_is_denser}',
    },
    {
      label: 'Python b85decode',
      input: 'W^7?+dva!DF*!0cUu<b>WnX7$bbS',
      options: { variant: 'rfc1924' },
      expect: 'flag{rfc1924_like_git}',
    },
    {
      label: 'Z85',
      input: 'w]7)*DWomzz/6G3Dn)^g',
      options: { variant: 'z85' },
      expect: 'flag{zeromq_z85}',
    },
    {
      label: 'Encode text',
      input: 'hello',
      options: { mode: 'encode', variant: 'ascii85', adobe: true },
      expect: '<~BOu!rDZ~>',
    },
  ],
  detect({ text }) {
    const t = text?.trim() ?? '';
    if (/^<~[\s\S]*~>$/.test(t) && t.length >= 6) {
      return {
        score: 0.92,
        options: { mode: 'decode', variant: 'ascii85' },
        reason: '<~ ~> frame',
      };
    }
    if (t.length < 10 || t.length > 20000 || /[ \t]/.test(t)) return null;
    for (const variant of VARIANTS) {
      try {
        const out = base85Decode(t, variant);
        if (out.length >= 4 && printableRatio(out) >= 0.95) {
          return {
            score: 0.5,
            options: { mode: 'decode', variant },
            reason: `Decodes to text as ${NAMES[variant]}`,
          };
        }
      } catch {
        continue;
      }
    }
    return null;
  },
  run({ bytes }, { mode, variant, adobe }) {
    if (mode === 'encode') return [{ type: 'text', value: base85Encode(bytes, variant, adobe) }];
    return bytesResult(base85Decode(utf8Decode(bytes), variant));
  },
});
