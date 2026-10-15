import { bool, defineTool, select, toggle } from '../../core/define';
import { ToolError } from '../../core/errors';
import type { Output } from '../../core/types';
import { toolT } from '../../i18n/tool-text';
import { printableRatio, utf8Decode } from '../../lib/bytes';
import { bigBaseDecode, bigBaseEncode } from './_bigbase';
import { bytesResult, showChar } from './_common';

const T = toolT('base36');

export const BASE36_DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';
export const BASE26_DIGITS = 'abcdefghijklmnopqrstuvwxyz';

/** Lower-cases ASCII letters only, so that positions in error messages stay the same. */
const lowerAscii = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
const upperIf = (s: string, upper: boolean): string => (upper ? s.toUpperCase() : s);

// ---------------------------------------------------------------------------------------------
// Bytes as one big integer
// ---------------------------------------------------------------------------------------------

/**
 * The bytes are one big-endian integer written in base 36 (0-9 a-z); each leading 0x00 byte
 * becomes a leading "0", as in Base58 / Base62, so binary data round-trips.
 */
export function base36Encode(bytes: Uint8Array, upper = false): string {
  return upperIf(bigBaseEncode(bytes, BASE36_DIGITS), upper);
}

/** Case-insensitive, whitespace ignored. Throws ToolError on any other character. */
export function base36Decode(text: string): Uint8Array {
  return bigBaseDecode(lowerAscii(text), BASE36_DIGITS, 'Base36');
}

/** The same with 26 digits: a = 0 ... z = 25 (a leading "a" is a leading zero byte). */
export function base26Encode(bytes: Uint8Array, upper = false): string {
  return upperIf(bigBaseEncode(bytes, BASE26_DIGITS), upper);
}

export function base26Decode(text: string): Uint8Array {
  return bigBaseDecode(lowerAscii(text), BASE26_DIGITS, 'Base26');
}

// ---------------------------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------------------------

/** Digits of a non-negative integer in `alphabet` (any radix up to 36). */
export function numberToBase(n: bigint, alphabet: string): string {
  if (n < 0n) throw new ToolError(T('error.negative'));
  if (n === 0n) return alphabet[0]!;
  const radix = BigInt(alphabet.length);
  let out = '';
  while (n > 0n) {
    out = alphabet[Number(n % radix)]! + out;
    n /= radix;
  }
  return out;
}

/** `pos` is the position of the token's first character in the input, for error messages. */
export function baseToNumber(token: string, alphabet: string, name: string, pos = 1): bigint {
  const radix = BigInt(alphabet.length);
  let n = 0n;
  const s = lowerAscii(token);
  for (let i = 0; i < s.length; i++) {
    const d = alphabet.indexOf(s[i]!);
    if (d < 0) {
      throw new ToolError(T('error.digit', { name, char: showChar(token[i]), pos: pos + i }));
    }
    n = n * radix + BigInt(d);
  }
  return n;
}

/** Spreadsheet column names: A = 1 ... Z = 26, AA = 27 (bijective base 26, no zero). */
export function excelEncode(n: bigint): string {
  if (n < 1n) throw new ToolError(T('error.excelZero', { value: n.toString() }));
  let out = '';
  while (n > 0n) {
    n -= 1n;
    out = String.fromCharCode(65 + Number(n % 26n)) + out;
    n /= 26n;
  }
  return out;
}

export function excelDecode(token: string, pos = 1): bigint {
  let n = 0n;
  for (let i = 0; i < token.length; i++) {
    const c = token.charCodeAt(i);
    const v = c >= 65 && c <= 90 ? c - 64 : c >= 97 && c <= 122 ? c - 96 : 0;
    if (!v) {
      throw new ToolError(T('error.excelLetter', { char: showChar(token[i]), pos: pos + i }));
    }
    n = n * 26n + BigInt(v);
  }
  return n;
}

/** Decimal (or 0x hex) integer from text; a ToolError names the token and its position. */
function parseInteger(token: string, pos: number): bigint {
  if (/^\d+$/.test(token)) return BigInt(token);
  if (/^0x[0-9a-f]+$/i.test(token)) return BigInt(token);
  if (/^-\d+$/.test(token)) throw new ToolError(T('error.negative'));
  throw new ToolError(T('error.number', { token, pos }));
}

/** Tokens separated by whitespace, commas or semicolons, with their 1-based positions. */
function tokens(text: string): { token: string; pos: number }[] {
  return [...text.matchAll(/[^\s,;]+/g)].map((m) => ({ token: m[0], pos: m.index + 1 }));
}

const hexOf = (n: bigint): string => {
  const h = n.toString(16);
  return h.length % 2 ? `0${h}` : h;
};

// ---------------------------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------------------------

type Format = 'base36-bytes' | 'base36-numbers' | 'base26-bytes' | 'base26-numbers' | 'excel';
const MAX_ROWS = 200;

function numbersOutput(text: string, format: Format, mode: 'decode' | 'encode', upper: boolean) {
  const list = tokens(text);
  if (!list.length) throw new ToolError(T('error.empty'));
  const alphabet = format === 'base36-numbers' ? BASE36_DIGITS : BASE26_DIGITS;
  const name = format === 'base36-numbers' ? 'Base36' : 'Base26';

  if (mode === 'encode') {
    const words = list.map(({ token, pos }) => {
      const n = parseInteger(token, pos);
      return format === 'excel' ? excelEncode(n) : upperIf(numberToBase(n, alphabet), upper);
    });
    return [{ type: 'text', value: words.join(' ') }] satisfies Output[];
  }

  const values = list.map(({ token, pos }) =>
    format === 'excel' ? excelDecode(token, pos) : baseToNumber(token, alphabet, name, pos),
  );
  const out: Output[] = [{ type: 'text', value: values.map(String).join(' ') }];
  out.push({
    type: 'table',
    columns: [T('col.input'), T('col.decimal'), T('col.hex')],
    rows: list
      .slice(0, MAX_ROWS)
      .map(({ token }, i) => [token, values[i]!.toString(), hexOf(values[i]!)]),
  });
  if (list.length > MAX_ROWS) {
    out.push({
      type: 'note',
      level: 'info',
      text: T('note.rows', { count: MAX_ROWS, total: list.length }),
    });
  }
  return out;
}

export default defineTool({
  id: 'base36',
  name: 'Base36 / Base26',
  category: 'encoding',
  description:
    'Base36 (0-9 a-z) and base26 letters: numbers, or bytes read as one big integer; also spreadsheet column names.',
  tags: [
    'b36',
    'base-36',
    'base-26',
    'alphanumeric',
    'bigint',
    'parseInt 36',
    'toString(36)',
    'excel column',
    'a1',
    'letters to number',
    'From Base36',
    'To Base36',
  ],
  input: 'bytes',
  placeholder: '5pzcszu7',
  live: true,
  options: {
    mode: toggle('Mode', ['decode', 'encode']),
    format: select(
      'Format',
      [
        { value: 'base36-bytes', label: 'Base36 · bytes (one big integer)' },
        { value: 'base36-numbers', label: 'Base36 · numbers' },
        { value: 'base26-bytes', label: 'Base26 a–z · bytes (one big integer)' },
        { value: 'base26-numbers', label: 'Base26 a–z · numbers (a = 0)' },
        { value: 'excel', label: 'Spreadsheet columns · numbers (A = 1, AA = 27)' },
      ],
      'base36-bytes',
      { hint: 'For plain integers in any base from 2 to 36, see the Number / base converter.' },
    ),
    upper: bool('Upper case output', false, {
      showIf: (v) => v.mode === 'encode' && v.format !== 'excel',
    }),
  },
  examples: [
    {
      label: 'Decode a flag',
      input: '1okh233vdr1fz2nano6oob99ewq1z1',
      expect: 'flag{base36_bigint}',
    },
    { label: 'Encode text', input: 'hello', options: { mode: 'encode' }, expect: '5pzcszu7' },
    {
      label: 'Numbers: base36 to decimal',
      input: 'zz 1k8 10',
      options: { format: 'base36-numbers' },
      expect: '1295 2024 36',
    },
    {
      label: 'Spreadsheet columns to numbers',
      input: 'A Z AA AZ XFD',
      options: { format: 'excel' },
      expect: '1 26 27 52 16384',
    },
    {
      label: 'Letters as base26 (a = 0)',
      input: 'hello',
      options: { mode: 'encode', format: 'base26-bytes' },
      expect: 'cdvlxlttn',
    },
  ],
  detect({ text }) {
    const t = text?.trim() ?? '';
    if (t.length < 8) return null;
    const mixed =
      /^(?=.*\d)(?=.*[a-z])[0-9a-z]+$/.test(t) || /^(?=.*\d)(?=.*[A-Z])[0-9A-Z]+$/.test(t);
    const letters = /^(?:[a-z]+|[A-Z]+)$/.test(t) && t.length >= 12;
    if (!mixed && !letters) return null;
    try {
      const out = mixed ? base36Decode(t) : base26Decode(t);
      if (out.length < 4 || printableRatio(out) < 0.9) return null;
      // Eight readable bytes by chance are very unlikely, and then this beats the generic Base64
      // guess that every digits-and-letters token gets.
      const sure = out.length >= 8 && printableRatio(out) >= 0.95;
      return {
        score: mixed ? (sure ? 0.88 : 0.6) : sure ? 0.8 : 0.45,
        options: { mode: 'decode', format: mixed ? 'base36-bytes' : 'base26-bytes' },
        reason: T(mixed ? 'detect.base36' : 'detect.base26'),
      };
    } catch {
      return null;
    }
  },
  run({ bytes }, { mode, format, upper }) {
    if (format === 'base36-numbers' || format === 'base26-numbers' || format === 'excel') {
      return numbersOutput(utf8Decode(bytes), format, mode, upper);
    }
    const base36 = format === 'base36-bytes';
    if (mode === 'encode') {
      const text = base36 ? base36Encode(bytes, upper) : base26Encode(bytes, upper);
      return [{ type: 'text', value: text }];
    }
    const decoded = base36 ? base36Decode(utf8Decode(bytes)) : base26Decode(utf8Decode(bytes));
    const out = bytesResult(decoded);
    let zeros = 0;
    while (zeros < decoded.length && decoded[zeros] === 0) zeros++;
    if (zeros)
      out.push({ type: 'note', level: 'info', text: T('note.leadingZeros', { count: zeros }) });
    return out;
  },
});
