import { defineTool, number, select, toggle } from '../../core/define';
import { ToolError } from '../../core/errors';
import type { Output } from '../../core/types';
import { toolT } from '../../i18n/tool-text';
import { isValidUtf8, utf8Decode, utf8Encode } from '../../lib/bytes';

const T = toolT('number-base');

/** 0-9, then A-Z, then a-z: the usual base62 alphabet. Bases up to 36 ignore case. */
const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const MAX_DIGITS = 100_000;
const MAX_NUMBERS = 2000;

const PREFIX_BASE: Record<string, number> = { x: 16, b: 2, o: 8 };
const BASE_PREFIX: Record<number, string> = { 16: 'x', 2: 'b', 8: 'o' };

function digitValue(ch: string, base: number): number {
  const i = base <= 36 ? parseInt(ch, 36) : DIGITS.indexOf(ch);
  return Number.isNaN(i) || i < 0 || i >= base ? -1 : i;
}

/** Parse the digits of one number (no sign, no prefix) in any base from 2 to 62. */
function parseDigits(digits: string, base: number, token: string): bigint {
  if (digits.length === 0) throw new ToolError(T('error.noDigits', { token }));
  if (digits.length > MAX_DIGITS)
    throw new ToolError(T('error.tooLong', { start: token.slice(0, 20), max: MAX_DIGITS }));
  for (const ch of digits) {
    if (digitValue(ch, base) < 0) {
      throw new ToolError(
        T('error.badDigit', {
          ch,
          base,
          token: token.length > 40 ? `${token.slice(0, 40)}…` : token,
        }),
      );
    }
  }
  if (base === 10) return BigInt(digits);
  if (base === 16 || base === 2 || base === 8) {
    return BigInt(`0${BASE_PREFIX[base]}${digits}`);
  }
  // Eight digits at a time keeps the big-number multiplications cheap (62^8 < 2^53, so exact).
  const step = 8;
  const bigBase = BigInt(base);
  let value = 0n;
  for (let i = 0; i < digits.length; i += step) {
    const chunk = digits.slice(i, i + step);
    let part = 0;
    for (const ch of chunk) part = part * base + digitValue(ch, base);
    value = value * bigBase ** BigInt(chunk.length) + BigInt(part);
  }
  return value;
}

interface Parsed {
  value: bigint;
  base: number;
  token: string;
}

export function parseNumber(raw: string, choice: number | 'auto'): Parsed {
  let s = raw.replace(/_/g, '');
  let negative = false;
  if (s[0] === '-' || s[0] === '+') {
    negative = s[0] === '-';
    s = s.slice(1);
  }
  const prefix = s.match(/^0([xXbBoO])/);
  let base: number;
  if (choice === 'auto') {
    if (prefix) {
      base = PREFIX_BASE[prefix[1]!.toLowerCase()]!;
      s = s.slice(2);
    } else base = /^\d+$/.test(s) ? 10 : /^[0-9a-f]+$/i.test(s) ? 16 : 0;
    if (base === 0) throw new ToolError(T('error.guessBase', { token: raw }));
  } else {
    base = choice;
    // 0x only means "hex prefix" when the chosen base is hex; otherwise it is plain digits (0b1 is valid hex).
    if (prefix && PREFIX_BASE[prefix[1]!.toLowerCase()] === base) s = s.slice(2);
  }
  const value = parseDigits(s, base, raw);
  return { value: negative ? -value : value, base, token: raw };
}

function toBase(n: bigint, base: number): string {
  if (base <= 36) return n.toString(base);
  const chunk = 8;
  const big = BigInt(base);
  const step = big ** BigInt(chunk);
  if (n === 0n) return '0';
  const groups: string[] = [];
  for (let v = n; v > 0n; v /= step) {
    let part = Number(v % step);
    let g = '';
    for (let i = 0; i < chunk; i++) {
      g = DIGITS[part % base]! + g;
      part = Math.floor(part / base);
    }
    groups.unshift(g);
  }
  return groups.join('').replace(/^0+(?=.)/, '');
}

/** Python's long_to_bytes: big-endian, no leading zero byte (zero is one 0x00 byte). */
export function bigintToBytes(n: bigint): Uint8Array {
  let hex = n.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function bytesToBigint(b: Uint8Array): bigint {
  let hex = '';
  for (const x of b) hex += x.toString(16).padStart(2, '0');
  return hex ? BigInt(`0x${hex}`) : 0n;
}

const escapeByte = (b: number) => `\\x${b.toString(16).padStart(2, '0')}`;

/** Readable form of bytes: UTF-8 when it is valid, otherwise Python-style \xNN escapes. */
function showBytes(b: Uint8Array): string {
  if (isValidUtf8(b)) {
    return utf8Decode(b).replace(/\p{Cc}/gu, (c) =>
      c === '\n' || c === '\t' || c === '\r' ? c : escapeByte(c.charCodeAt(0)),
    );
  }
  let out = '';
  for (const x of b) out += x >= 0x20 && x < 0x7f ? String.fromCharCode(x) : escapeByte(x);
  return out;
}

const withSign = (n: bigint, prefix: string, base: number) =>
  `${n < 0n ? '-' : ''}${prefix}${toBase(n < 0n ? -n : n, base)}`;

interface Forms {
  decimal: string;
  hex: string;
  octal: string;
  binary: string;
  base36: string;
  base62: string;
  bits: number;
  bytes: Uint8Array | null;
  be: string;
  le: string;
}

function forms(n: bigint): Forms {
  const abs = n < 0n ? -n : n;
  const bytes = n < 0n ? null : bigintToBytes(n);
  return {
    decimal: n.toString(),
    hex: withSign(n, '0x', 16),
    octal: withSign(n, '0o', 8),
    binary: withSign(n, '0b', 2),
    base36: withSign(n, '', 36),
    base62: withSign(n, '', 62),
    bits: abs === 0n ? 1 : abs.toString(2).length,
    bytes,
    be: bytes ? showBytes(bytes) : T('value.negative'),
    le: bytes ? showBytes(Uint8Array.from(bytes).reverse()) : T('value.negative'),
  };
}

function numberOutputs(parsed: Parsed[]): Output[] {
  if (parsed.length === 1) {
    const p = parsed[0]!;
    const f = forms(p.value);
    const hexBytes = f.bytes
      ? Array.from(f.bytes, (x) => x.toString(16).padStart(2, '0')).join(' ')
      : T('value.negative');
    return [
      {
        type: 'kv',
        entries: [
          [T('kv.readAs'), T('value.base', { base: p.base })],
          [T('col.decimal'), f.decimal],
          [T('col.hex'), f.hex],
          [T('col.octal'), f.octal],
          [T('col.binary'), f.binary],
          [T('col.base36'), f.base36],
          [T('kv.base62'), f.base62],
          [T('kv.size'), T('value.bitsBytes', { bits: f.bits, bytes: Math.ceil(f.bits / 8) })],
          [T('kv.bytesHex'), hexBytes],
          [T('kv.textBE'), f.be],
          [T('kv.textLE'), f.le],
        ],
      },
    ];
  }
  const rows = parsed.map((p) => {
    const f = forms(p.value);
    return [p.token, f.decimal, f.hex, f.octal, f.binary, f.base36, f.be, f.le];
  });
  const out: Output[] = [
    {
      type: 'table',
      columns: [
        T('col.input'),
        T('col.decimal'),
        T('col.hex'),
        T('col.octal'),
        T('col.binary'),
        T('col.base36'),
        T('col.textBE'),
        T('col.textLE'),
      ],
      rows,
    },
  ];
  if (parsed.every((p) => p.value >= 0n)) {
    const all = parsed.flatMap((p) => Array.from(bigintToBytes(p.value)));
    out.push({
      type: 'text',
      label: T('label.joined'),
      value: showBytes(Uint8Array.from(all)),
    });
  }
  return out;
}

function textOutputs(input: string): Output[] {
  const text = input.replace(/\r?\n$/, '');
  if (text === '') throw new ToolError(T('error.emptyText'));
  const bytes = utf8Encode(text);
  const be = bytesToBigint(bytes);
  const le = bytesToBigint(Uint8Array.from(bytes).reverse());
  return [
    {
      type: 'kv',
      entries: [
        [T('kv.integerBE'), be.toString()],
        [T('kv.hexBE'), `0x${be.toString(16)}`],
        [T('kv.integerLE'), le.toString()],
        [T('kv.hexLE'), `0x${le.toString(16)}`],
        [T('kv.binaryBE'), `0b${be.toString(2)}`],
        [
          T('kv.size'),
          T('value.bytesBits', {
            bytes: bytes.length,
            bits: be === 0n ? 1 : be.toString(2).length,
          }),
        ],
      ],
    },
  ];
}

export default defineTool({
  id: 'number-base',
  name: 'Number / base converter',
  category: 'misc',
  description:
    'Convert big integers between bases and to bytes or text (long_to_bytes), or text to an integer.',
  tags: [
    'long_to_bytes',
    'bytes_to_long',
    'hex',
    'binary',
    'octal',
    'decimal',
    'base36',
    'base62',
    'bigint',
    'radix',
    'rsa',
    'integer',
    'int to string',
  ],
  input: 'text',
  placeholder: '0x666c61677b6e756d3262797465737d',
  options: {
    mode: toggle('Direction', [
      { value: 'number', label: 'Number → bases & text' },
      { value: 'text', label: 'Text → integer' },
    ]),
    base: select(
      'Input base',
      [
        { value: 'auto', label: 'Auto' },
        { value: '2', label: 'Binary (2)' },
        { value: '8', label: 'Octal (8)' },
        { value: '10', label: 'Decimal (10)' },
        { value: '16', label: 'Hex (16)' },
        { value: '36', label: 'Base36' },
        { value: '62', label: 'Base62' },
        { value: 'custom', label: 'Custom…' },
      ],
      'auto',
      {
        showIf: (v) => v.mode === 'number',
        hint: 'Auto: 0x / 0b / 0o prefix, else digits only = decimal, a-f letters = hex.',
      },
    ),
    custom: number('Custom base', 7, {
      min: 2,
      max: 62,
      showIf: (v) => v.mode === 'number' && v.base === 'custom',
    }),
  },
  examples: [
    {
      label: 'Hex → text (RSA result)',
      input: '0x666c61677b6e756d3262797465737d',
      expect: 'flag{num2bytes}',
    },
    {
      label: 'Huge decimal → text',
      input: '2511413510842060413510119088141712512283210298218286115709',
      expect: 'flag{rsa_small_e_attack}',
    },
    { label: 'Binary literal', input: '0b101010', expect: 'Decimal: 42' },
    {
      label: 'Base36 input',
      input: 'zz',
      options: { base: '36' },
      expect: 'Decimal: 1295',
    },
    {
      label: 'Text → integer',
      input: 'flag{x}',
      options: { mode: 'text' },
      expect: 'Integer (big-endian): 28829613228259453',
    },
  ],
  detect({ text }) {
    const t = text?.trim();
    if (!t || t.length > 20000) return null;
    if (/^\d{25,}$/.test(t)) return { score: 0.55, reason: T('detect.bigInteger') };
    if (/^0x[0-9a-f]{16,}$/i.test(t)) return { score: 0.55, reason: T('detect.hex') };
    return null;
  },
  run(input, { mode, base, custom }) {
    if (mode === 'text') return textOutputs(input);
    const tokens = input.split(/[\s,;]+/).filter(Boolean);
    if (tokens.length === 0) throw new ToolError(T('error.empty'));
    if (tokens.length > MAX_NUMBERS)
      throw new ToolError(T('error.tooMany', { n: tokens.length, max: MAX_NUMBERS }));
    let choice: number | 'auto' = 'auto';
    if (base === 'custom') {
      if (!Number.isInteger(custom) || custom < 2 || custom > 62)
        throw new ToolError(T('error.customBase'));
      choice = custom;
    } else if (base !== 'auto') choice = Number(base);
    return numberOutputs(tokens.map((t) => parseNumber(t, choice)));
  },
});
