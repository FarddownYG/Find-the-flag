import { defineTool, toggle } from '../../core/define';
import { ToolError } from '../../core/errors';
import { utf8Decode, utf8Encode } from '../../lib/bytes';
import { bytesResult } from './_common';

export type CharBase = 'dec' | 'hex' | 'oct';
/** 'codepoint': each number is a Unicode code point. 'utf8': each number is one UTF-8 byte. */
export type CharUnit = 'codepoint' | 'utf8';
export type CharSeparator = 'space' | 'comma' | 'comma-space' | 'newline';

const RADIX: Record<CharBase, number> = { dec: 10, hex: 16, oct: 8 };
const NAME: Record<CharBase, string> = { dec: 'decimal', hex: 'hexadecimal', oct: 'octal' };
const DIGITS: Record<number, RegExp> = { 10: /^[0-9]+$/, 16: /^[0-9a-f]+$/i, 8: /^[0-7]+$/ };
const MAX_CODE_POINT = 0x10ffff;

function parseToken(tok: string, base: CharBase): number {
  let radix = RADIX[base];
  let digits = tok;
  const prefix = /^(0x|x|0o)(.+)$/i.exec(tok);
  if (prefix) {
    radix = prefix[1]!.toLowerCase() === '0o' ? 8 : 16;
    digits = prefix[2]!;
  }
  if (!DIGITS[radix]!.test(digits)) {
    const hint =
      radix !== 16 && DIGITS[16]!.test(digits)
        ? ' Those look like hex digits — set the base to Hexadecimal.'
        : '';
    throw new ToolError(`"${tok}" is not a ${NAME[base]} number.${hint}`);
  }
  const value = parseInt(digits, radix);
  if (value > MAX_CODE_POINT) {
    throw new ToolError(`${tok} is larger than the last Unicode code point (1114111 / 0x10FFFF).`);
  }
  return value;
}

/**
 * Split on any run of non-alphanumeric characters (space, comma, semicolon, newline, "\x",
 * "&#", "%", "U+"...), so the separator is detected for free. 0x / \x / 0o prefixes win over
 * `base`. Without any separator, text is cut into 3 digits (decimal, octal) or 2 digits (hex)
 * per character when its length allows; otherwise it is one single number.
 */
export function parseCharcodes(text: string, base: CharBase = 'dec'): number[] {
  const tokens = text
    .replace(/U\+/gi, ' 0x')
    .split(/[^0-9a-zA-Z]+/)
    .filter(Boolean);
  if (tokens.length === 1) {
    const only = tokens[0]!;
    const size = base === 'hex' ? 2 : 3;
    if (/^[0-9a-f]+$/i.test(only) && only.length > size && only.length % size === 0) {
      const chunks = only.match(new RegExp(`.{${size}}`, 'g'))!;
      return chunks.map((c) => parseToken(c, base));
    }
  }
  return tokens.map((t) => parseToken(t, base));
}

/** The decoded text as bytes: UTF-8 of the code points, or the numbers themselves as bytes. */
export function charcodeDecodeBytes(
  text: string,
  base: CharBase = 'dec',
  unit: CharUnit = 'codepoint',
): Uint8Array {
  const codes = parseCharcodes(text, base);
  if (unit === 'utf8') {
    const big = codes.find((c) => c > 255);
    if (big !== undefined) {
      throw new ToolError(
        `${big} does not fit in one byte (max 255). Switch to "Unicode code points" if these are characters.`,
      );
    }
    return Uint8Array.from(codes);
  }
  // Joined as one string so that UTF-16 surrogate halves (55357 56832) merge into one character.
  return utf8Encode(codes.map((c) => String.fromCodePoint(c)).join(''));
}

export function charcodeDecode(
  text: string,
  base: CharBase = 'dec',
  unit: CharUnit = 'codepoint',
): string {
  return utf8Decode(charcodeDecodeBytes(text, base, unit));
}

const SEPARATORS: Record<CharSeparator, string> = {
  space: ' ',
  comma: ',',
  'comma-space': ', ',
  newline: '\n',
};

export function charcodeEncode(
  text: string,
  base: CharBase = 'dec',
  separator: CharSeparator = 'space',
  unit: CharUnit = 'codepoint',
): string {
  const values =
    unit === 'utf8' ? Array.from(utf8Encode(text)) : Array.from(text, (ch) => ch.codePointAt(0)!);
  const pad = base === 'hex' ? 2 : base === 'oct' ? 3 : 0;
  return values.map((v) => v.toString(RADIX[base]).padStart(pad, '0')).join(SEPARATORS[separator]);
}

export default defineTool({
  id: 'charcode',
  name: 'Char codes',
  category: 'encoding',
  description: 'Turn text into decimal, hex or octal character codes and back (any separator).',
  tags: [
    'ascii',
    'ord',
    'chr',
    'fromcharcode',
    'code points',
    'codepoint',
    'unicode',
    'decimal',
    'octal',
    'From Charcode',
    'To Charcode',
  ],
  input: 'text',
  placeholder: '102 108 97 103 123 125   (separators are detected: space, comma, newline...)',
  options: {
    mode: toggle('Mode', ['decode', 'encode']),
    base: toggle('Numbers', [
      { value: 'dec', label: 'Decimal' },
      { value: 'hex', label: 'Hex' },
      { value: 'oct', label: 'Octal' },
    ]),
    unit: toggle('Each number is', [
      { value: 'codepoint', label: 'A Unicode character' },
      { value: 'utf8', label: 'One UTF-8 byte' },
    ]),
    separator: toggle(
      'Separator',
      [
        { value: 'space', label: 'Space' },
        { value: 'comma', label: 'Comma' },
        { value: 'comma-space', label: 'Comma + space' },
        { value: 'newline', label: 'Newline' },
      ],
      'space',
      { showIf: (v) => v.mode === 'encode' },
    ),
  },
  examples: [
    {
      label: 'Decimal codes',
      input: '102 108 97 103 123 99 104 97 114 99 111 100 101 125',
      expect: 'flag{charcode}',
    },
    {
      label: 'Hex codes',
      input: '66 6c 61 67 7b 63 68 61 72 63 6f 64 65 7d',
      options: { base: 'hex' },
      expect: 'flag{charcode}',
    },
    {
      label: 'Octal codes',
      input: '146 154 141 147 173 143 150 141 162 143 157 144 145 175',
      options: { base: 'oct' },
      expect: 'flag{charcode}',
    },
    {
      label: 'Beyond ASCII (code points)',
      input: '102, 108, 97, 103, 123, 115, 110, 111, 119, 9731, 125',
      expect: 'flag{snow☃}',
    },
    {
      label: 'Encode text',
      input: 'flag{ok}',
      options: { mode: 'encode', separator: 'comma-space' },
      expect: '102, 108, 97, 103, 123, 111, 107, 125',
    },
  ],
  detect({ text }) {
    const t = text?.trim() ?? '';
    if (!/^\d{1,3}(?:[\s,;]+\d{1,3}){3,}$/.test(t)) return null;
    const nums = t.split(/[\s,;]+/).map(Number);
    if (nums.every((n) => n >= 32 && n <= 126)) {
      return {
        score: 0.82,
        options: { mode: 'decode', base: 'dec' },
        reason: 'Numbers 32–126: ASCII codes',
      };
    }
    if (nums.every((n) => n <= 255) && nums.length >= 6) {
      return {
        score: 0.5,
        options: { mode: 'decode', base: 'dec' },
        reason: 'List of byte values',
      };
    }
    return null;
  },
  run(text, { mode, base, unit, separator }) {
    if (mode === 'encode') {
      return [{ type: 'text', value: charcodeEncode(text, base, separator, unit) }];
    }
    if (!text.trim()) throw new ToolError('Paste a list of character codes, e.g. 102 108 97 103.');
    return bytesResult(charcodeDecodeBytes(text, base, unit));
  },
});
