import { defineTool, bool, select, toggle } from '../../core/define';
import { ToolError } from '../../core/errors';
import { concatBytes, isValidUtf8, utf8Decode, utf8Encode } from '../../lib/bytes';
import { bytesResult } from './_common';

export type EscapeStyle = 'u' | 'u-brace' | 'x' | 'U' | 'percent-u' | 'uplus' | 'octal';
export type EscapeScope = 'nonascii' | 'all';
/**
 * How \xHH and octal \NNN are read: 'codepoint' = the character with that number (JavaScript,
 * so \xe9 is é); 'bytes' = one byte of UTF-8 (C, Python bytes: \xc3\xa9 is é);
 * 'auto' = bytes when they form valid UTF-8, otherwise code points.
 */
export type ByteEscapeMode = 'auto' | 'codepoint' | 'bytes';

const HEX = '[0-9a-fA-F]';
const ESCAPE = new RegExp(
  [
    `\\\\u\\{(${HEX}{1,6})\\}`, // 1  \u{1F600}
    `\\\\u(${HEX}{4})`, //         2  é
    `\\\\U(${HEX}{8})`, //         3  \U0001F600
    `\\\\x(${HEX}{2})`, //         4  \xe9
    `%u(${HEX}{4})`, //            5  %u00e9
    `(?<![G-Zg-z_])U\\+(${HEX}{4,6})`, //     6  U+00E9
    `\\\\([0-3][0-7]{2})`, //      7  \351
    `\\\\(["'\\\\abfnrtv0])`, //   8  \n \t \\ ...
  ].join('|'),
  'g',
);
const SIMPLE: Record<string, number> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '0': 0 };
const MAX_CODE_POINT = 0x10ffff;

type Piece =
  | { kind: 'text'; text: string }
  | { kind: 'cp'; value: number; uplus?: boolean }
  | { kind: 'byte'; value: number };

function tokenize(input: string, simple: boolean): { pieces: Piece[]; escapes: number } {
  const pieces: Piece[] = [];
  let last = 0;
  let escapes = 0;
  for (const m of input.matchAll(ESCAPE)) {
    const at = m.index!;
    let piece: Piece;
    if (m[1] !== undefined) piece = { kind: 'cp', value: parseInt(m[1], 16) };
    else if (m[2] !== undefined) piece = { kind: 'cp', value: parseInt(m[2], 16) };
    else if (m[3] !== undefined) piece = { kind: 'cp', value: parseInt(m[3], 16) };
    else if (m[4] !== undefined) piece = { kind: 'byte', value: parseInt(m[4], 16) };
    else if (m[5] !== undefined) piece = { kind: 'cp', value: parseInt(m[5], 16) };
    else if (m[6] !== undefined) piece = { kind: 'cp', value: parseInt(m[6], 16), uplus: true };
    else if (m[7] !== undefined) piece = { kind: 'byte', value: parseInt(m[7], 8) };
    else if (simple) piece = { kind: 'cp', value: SIMPLE[m[8]!] ?? m[8]!.charCodeAt(0) };
    else continue;
    if (piece.kind === 'cp' && piece.value > MAX_CODE_POINT) {
      throw new ToolError(
        `${m[0]} is beyond the last Unicode code point (U+10FFFF). Check the digits.`,
      );
    }
    if (at > last) pieces.push({ kind: 'text', text: input.slice(last, at) });
    pieces.push(piece);
    last = at + m[0].length;
    escapes++;
  }
  if (last < input.length) pieces.push({ kind: 'text', text: input.slice(last) });

  // "U+0066 U+006C": whitespace between two U+ items is a separator, not text.
  const kept = pieces.filter((p, i) => {
    if (p.kind !== 'text' || !/^\s+$/.test(p.text)) return true;
    const a = pieces[i - 1];
    const b = pieces[i + 1];
    return !(a?.kind === 'cp' && a.uplus && b?.kind === 'cp' && b.uplus);
  });
  return { pieces: kept, escapes };
}

function assemble(pieces: Piece[], bytesMode: boolean): Uint8Array {
  const parts: Uint8Array[] = [];
  let highSurrogate: number | null = null;
  const flushLone = () => {
    if (highSurrogate !== null) parts.push(utf8Encode('�'));
    highSurrogate = null;
  };
  for (const p of pieces) {
    if (p.kind === 'text') {
      flushLone();
      parts.push(utf8Encode(p.text));
    } else if (p.kind === 'byte' && bytesMode) {
      flushLone();
      parts.push(Uint8Array.of(p.value));
    } else {
      const v = p.value;
      if (highSurrogate !== null && v >= 0xdc00 && v <= 0xdfff) {
        parts.push(
          utf8Encode(
            String.fromCodePoint(0x10000 + ((highSurrogate - 0xd800) << 10) + (v - 0xdc00)),
          ),
        );
        highSurrogate = null;
        continue;
      }
      flushLone();
      if (v >= 0xd800 && v <= 0xdbff) highSurrogate = v;
      else parts.push(utf8Encode(String.fromCodePoint(v)));
    }
  }
  flushLone();
  return concatBytes(...parts);
}

/**
 * Decodes \uXXXX (surrogate pairs combine), \u{...}, \UXXXXXXXX, \xHH, %uXXXX, U+XXXX, octal
 * \NNN and, when `simple` is on, \n \t \r \\ \" \' \0 \a \b \f \v. Everything else is kept.
 * Returns UTF-8 bytes. Throws ToolError when there is no escape at all or a code point is
 * out of range.
 */
export function unicodeUnescapeBytes(
  text: string,
  byteMode: ByteEscapeMode = 'auto',
  simple = true,
): Uint8Array {
  const { pieces, escapes } = tokenize(text, simple);
  if (escapes === 0) {
    throw new ToolError(
      'No escape sequences found. Looked for \\uXXXX, \\u{…}, \\xHH, \\UXXXXXXXX, %uXXXX, U+XXXX and octal \\NNN.',
    );
  }
  if (byteMode === 'codepoint') return assemble(pieces, false);
  const asBytes = assemble(pieces, true);
  if (byteMode === 'bytes' || isValidUtf8(asBytes)) return asBytes;
  return assemble(pieces, false);
}

export const unicodeUnescape = (
  text: string,
  byteMode: ByteEscapeMode = 'auto',
  simple = true,
): string => utf8Decode(unicodeUnescapeBytes(text, byteMode, simple));

/** True when the text contains at least one non-trivial escape (used to filter candidates). */
export const hasUnicodeEscape = (text: string): boolean =>
  /\\u\{?[0-9a-fA-F]|\\U[0-9a-fA-F]{8}|\\x[0-9a-fA-F]{2}|%u[0-9a-fA-F]{4}|(?<![G-Zg-z_])U\+[0-9a-fA-F]{4}|\\[0-3][0-7]{2}/.test(
    text,
  );

const hex = (n: number, width: number, upper = false): string => {
  const s = n.toString(16).padStart(width, '0');
  return upper ? s.toUpperCase() : s;
};

/**
 * Writes characters as escapes. `nonascii` leaves ASCII as it is, `all` escapes every
 * character. Styles `x` and `octal` escape the UTF-8 bytes, the others the code point
 * (astral characters become a surrogate pair for \u and %u).
 */
export function unicodeEscape(
  text: string,
  style: EscapeStyle = 'u',
  scope: EscapeScope = 'nonascii',
): string {
  const chars = Array.from(text);
  let out = '';
  chars.forEach((ch, i) => {
    const cp = ch.codePointAt(0)!;
    if (scope === 'nonascii' && cp < 128) {
      out += ch;
      return;
    }
    const units = (): number[] =>
      cp > 0xffff ? [0xd800 + ((cp - 0x10000) >> 10), 0xdc00 + ((cp - 0x10000) & 0x3ff)] : [cp];
    switch (style) {
      case 'u':
        out += units()
          .map((u) => `\\u${hex(u, 4)}`)
          .join('');
        break;
      case 'u-brace':
        out += `\\u{${hex(cp, 1)}}`;
        break;
      case 'U':
        out += `\\U${hex(cp, 8)}`;
        break;
      case 'percent-u':
        out += units()
          .map((u) => `%u${hex(u, 4)}`)
          .join('');
        break;
      case 'x':
        out += Array.from(utf8Encode(ch), (b) => `\\x${hex(b, 2)}`).join('');
        break;
      case 'octal':
        out += Array.from(utf8Encode(ch), (b) => `\\${b.toString(8).padStart(3, '0')}`).join('');
        break;
      case 'uplus': {
        // A following hex digit would be swallowed by the number: pad to 6 digits to stop it.
        const next = chars[i + 1];
        const width = next !== undefined && /[0-9a-fA-F]/.test(next) ? 6 : 4;
        out += `U+${hex(cp, width, true)}`;
        break;
      }
    }
  });
  return out;
}

export default defineTool({
  id: 'unicode-escape',
  name: 'Unicode escapes',
  category: 'encoding',
  description: 'Decode or write \\uXXXX, \\u{…}, \\xHH, %uXXXX, U+XXXX and octal escapes.',
  tags: [
    'unicode',
    'escape',
    'unescape',
    'utf-8',
    'utf-16',
    'js',
    'json',
    '\\u',
    '\\x',
    'U+',
    '%u',
    'octal',
    'From Unicode Escapes',
    'Escape Unicode Characters',
  ],
  input: 'text',
  placeholder: '\\u0066\\u006c\\u0061\\u0067\\u007b\\u2026\\u007d   \\xe2\\x9c\\x93   U+1F600',
  options: {
    mode: toggle('Mode', ['decode', 'encode']),
    bytes: toggle(
      '\\xHH and octal mean',
      [
        { value: 'auto', label: 'Auto' },
        { value: 'bytes', label: 'UTF-8 bytes' },
        { value: 'codepoint', label: 'Characters' },
      ],
      'auto',
      {
        hint: 'Bytes: \\xc3\\xa9 is é (C, Python bytes). Characters: \\xe9 is é (JavaScript).',
        showIf: (v) => v.mode === 'decode',
      },
    ),
    simple: bool('Also decode \\n \\t \\r \\\\ \\" \\\'', true, {
      showIf: (v) => v.mode === 'decode',
    }),
    style: select(
      'Style',
      [
        { value: 'u', label: '\\u00e9  (JS / JSON / Java)' },
        { value: 'u-brace', label: '\\u{e9}  (ES6)' },
        { value: 'x', label: '\\xc3\\xa9  (UTF-8 bytes)' },
        { value: 'U', label: '\\U000000e9  (Python)' },
        { value: 'percent-u', label: '%u00e9  (old URL style)' },
        { value: 'uplus', label: 'U+00E9' },
        { value: 'octal', label: '\\303\\251  (UTF-8 bytes, octal)' },
      ],
      'u',
      { showIf: (v) => v.mode === 'encode' },
    ),
    scope: toggle(
      'Escape',
      [
        { value: 'nonascii', label: 'Non-ASCII only' },
        { value: 'all', label: 'Every character' },
      ],
      'nonascii',
      { showIf: (v) => v.mode === 'encode' },
    ),
  },
  examples: [
    {
      label: 'Decode \\u escapes',
      input: '\\u0066\\u006c\\u0061\\u0067\\u007bunicode_\\x65scapes\\u007d',
      expect: 'flag{unicode_escapes}',
    },
    {
      label: 'UTF-8 bytes (\\xe2\\x98\\x83 is a snowman)',
      input: 'flag{\\xe2\\x98\\x83}',
      expect: 'flag{☃}',
    },
    {
      label: 'Octal escapes',
      input: '\\146\\154\\141\\147\\173octal\\175',
      expect: 'flag{octal}',
    },
    {
      label: 'U+ code points',
      input: 'U+0066 U+006C U+0061 U+0067 U+007B U+1F600 U+007D',
      expect: 'flag{😀}',
    },
    {
      label: 'Encode with \\u',
      input: 'flag{café ✓}',
      options: { mode: 'encode' },
      expect: 'flag{caf\\u00e9 \\u2713}',
    },
    {
      label: 'Encode every character',
      input: 'flag',
      options: { mode: 'encode', scope: 'all', style: 'x' },
      expect: '\\x66\\x6c\\x61\\x67',
    },
  ],
  detect({ text }) {
    const t = text ?? '';
    if (t.length > 500000) return null;
    const n = (
      t.match(
        /\\u\{?[0-9a-fA-F]{1,6}|\\U[0-9a-fA-F]{8}|\\x[0-9a-fA-F]{2}|%u[0-9a-fA-F]{4}|(?<![G-Zg-z_])U\+[0-9a-fA-F]{4}/g,
      ) ?? []
    ).length;
    if (n === 0) return null;
    return {
      score: n >= 3 ? 0.88 : n === 2 ? 0.75 : 0.55,
      options: { mode: 'decode' },
      reason: `${n} escape sequence${n === 1 ? '' : 's'}`,
    };
  },
  run(text, { mode, bytes, simple, style, scope }) {
    if (mode === 'encode') return [{ type: 'text', value: unicodeEscape(text, style, scope) }];
    const out = unicodeUnescapeBytes(text, bytes, simple);
    return isValidUtf8(out) ? [{ type: 'text', value: utf8Decode(out) }] : bytesResult(out);
  },
});
