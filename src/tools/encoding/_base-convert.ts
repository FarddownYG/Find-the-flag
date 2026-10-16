import { ToolError } from '../../core/errors';
import { toolT } from '../../i18n/tool-text';
import { isValidUtf8, latin1Decode, utf8Decode, utf8Encode } from '../../lib/bytes';
import { readability } from '../../lib/readability';
import { parseNumber } from '../misc/number-base';
import { binaryDecode, binaryEncode } from './binary';
import { charcodeEncode, parseCharcodes } from './charcode';
import { hexDecode, hexEncode } from './hex';

const T = toolT('base-convert');

/**
 * The analysis behind the "Binary / Octal / Decimal / Hex" tool. It parses with the engines of
 * the Binary, Hex, Char codes and Number / base tools (nothing is parsed here), then ranks every
 * way the input can be read by how much the result looks like text.
 */

export type Radix = 2 | 8 | 10 | 16;
export type InputChoice = 'auto' | 'text' | '2' | '8' | '10' | '16';
export type Confidence = 'high' | 'medium' | 'low';

/**
 * Bases in the order they win a tie. Decimal codes are by far the most common in challenges,
 * then hex, then octal (Unix escapes), then binary, whose long 0/1 groups rarely tie.
 */
const RADICES: readonly Radix[] = [10, 16, 8, 2];

/**
 * - text: the characters as typed, read as UTF-8 bytes;
 * - codes: a list of character codes (one number or group per character);
 * - number: the whole input is one number;
 * - numbers: a list of numbers too large to be characters.
 */
export type ReadingKind = 'text' | 'codes' | 'number' | 'numbers';

export interface Reading {
  kind: ReadingKind;
  /** The bases in which the digits give exactly these values (several when they coincide). */
  radices: Radix[];
  /** Binary groups only: the group size that was used. */
  bits?: 7 | 8;
  values: bigint[];
  /** Every value as a byte, when they all fit in one. */
  bytes: Uint8Array | null;
  /** The characters the values spell; null for numbers. */
  text: string | null;
  /** 0..100: how plausible this reading is (readability of the text, for codes). */
  score: number;
}

export interface Analysis {
  /** Best first, never empty. */
  readings: Reading[];
  /** Everything the input is made of could be a number (so "text" is only one of the readings). */
  codeLike: boolean;
  confidence: Confidence;
}

/** Upper bound on the input: the output is several times longer than the input. */
export const MAX_INPUT = 100_000;

// ---------- how much a text looks like text ----------

const PUNCTUATION = new Set('.,;:!?\'"-_(){}[]');

/**
 * 1 for a letter, digit or space; less for punctuation and symbols; 0 for control characters.
 * `utf8`: the characters come from valid multi-byte UTF-8, which random bytes almost never form,
 * so accented letters, kanji and the like are as likely to be meant as ASCII symbols are.
 */
function charWeight(ch: string, utf8: boolean): number {
  const c = ch.codePointAt(0)!;
  if (c === 0x20) return 1;
  if (c === 9 || c === 10 || c === 13) return 0.9;
  if (c < 0x20 || (c >= 0x7f && c < 0xa0)) return 0;
  if (c < 0x7f) {
    if (/[A-Za-z0-9]/.test(ch)) return 1;
    return PUNCTUATION.has(ch) ? 0.8 : 0.45;
  }
  if (/\p{L}/u.test(ch)) return utf8 ? 0.85 : 0.4;
  if (/\p{N}/u.test(ch)) return utf8 ? 0.7 : 0.3;
  return /[\p{P}\p{S}]/u.test(ch) ? (utf8 ? 0.5 : 0.15) : 0;
}

const SAMPLE = 2000;

/**
 * 0..100: how much `text` reads as text. Mostly the share of ordinary characters (letters,
 * digits, spaces, usual punctuation) so that a clean ASCII string beats one full of symbols, plus
 * the French / English readability for real words. `utf8`: see charWeight.
 */
export function textQuality(text: string, utf8 = false): number {
  const sample = text.length > SAMPLE ? text.slice(0, SAMPLE) : text;
  let sum = 0;
  let count = 0;
  for (const ch of sample) {
    sum += charWeight(ch, utf8);
    count++;
  }
  if (count === 0) return 0;
  const share = sum / count;
  const words = Math.min(1, readability(sample, ['en', 'fr']).score / 50);
  return Math.round(100 * (0.7 * share * share + 0.3 * words));
}

// ---------- reading the input ----------

function toValues(bytesOrCodes: ArrayLike<number>): bigint[] {
  return Array.from(bytesOrCodes, (n) => BigInt(n));
}

/** The characters a list of codes spells: UTF-8 when they are bytes of valid UTF-8, else code points. */
function spell(codes: readonly bigint[]): {
  text: string;
  bytes: Uint8Array | null;
  /** The bytes are valid UTF-8 with at least one multi-byte character. */
  multibyte: boolean;
} {
  if (codes.every((v) => v <= 255n)) {
    const bytes = Uint8Array.from(codes, Number);
    const valid = isValidUtf8(bytes);
    return {
      text: valid ? utf8Decode(bytes) : latin1Decode(bytes),
      bytes,
      multibyte: valid && bytes.some((b) => b > 127),
    };
  }
  let text = '';
  for (let i = 0; i < codes.length; i += 4096) {
    text += String.fromCodePoint(...codes.slice(i, i + 4096).map(Number));
  }
  return { text, bytes: null, multibyte: false };
}

const TOKEN_SPLIT = /[^0-9a-zA-Z]+/;
const CODE_TOKEN = /^(?:0[xXbBoO]|[xX])?[0-9a-fA-F]+$/;

function tokensOf(input: string): string[] {
  return input.replace(/U\+/gi, ' 0x').split(TOKEN_SPLIT).filter(Boolean);
}

/** The input without the framing a paste brings: one trailing newline, a Python `b` before a quote. */
function normalise(raw: string): string {
  return raw.replace(/\r?\n$/, '').replace(/^\s*[bB](?=["'])/, '');
}

/** A base written out in front of the numbers (0x, \x, U+, 0b, 0o), when only one kind is used. */
function declaredRadix(input: string): Radix | null {
  const found: Radix[] = [];
  if (/(?:0x|\\x|u\+)[0-9a-f]/i.test(input)) found.push(16);
  if (/0b[01]/i.test(input)) found.push(2);
  if (/0o[0-7]/i.test(input)) found.push(8);
  return found.length === 1 ? found[0]! : null;
}

/**
 * The list of codes `radix` reads in the input, or null when it is not valid in that base. Binary
 * goes through the Binary tool (groups, or one string cut by `bits`), hex through the Hex tool
 * (bytes), decimal and octal through Char codes (one number per character). `fail` keeps the
 * first refusal, which is what a forced base reports.
 */
function codesIn(
  input: string,
  tokens: string[],
  radix: Radix,
  bits: 7 | 8,
  fail: { error: ToolError | null },
): bigint[] | null {
  try {
    if (radix === 2) return toValues(binaryDecode(input, bits));
    if (radix === 16) {
      const bare = tokens.map((t) => t.replace(/^(?:0[xX]|[xX])/, ''));
      const even = bare.every((t) => t.length % 2 === 0);
      if (even && !/u\+/i.test(input)) {
        try {
          return toValues(hexDecode(input));
        } catch {
          // An `x46` token or another form the Hex tool refuses: the Char codes parser takes it.
        }
      }
      return toValues(parseCharcodes(input, 'hex'));
    }
    return toValues(parseCharcodes(input, radix === 8 ? 'oct' : 'dec'));
  } catch (e) {
    if (!(e instanceof ToolError)) throw e;
    fail.error ??= e;
    return null;
  }
}

/** Numbers too large for characters: every token parsed as a whole number by Number / base. */
function numbersIn(
  input: string,
  radix: Radix,
  fail: { error: ToolError | null },
): bigint[] | null {
  try {
    const parts = input.split(/[\s,;]+/).filter(Boolean);
    return parts.map((p) => parseNumber(p, radix).value);
  } catch (e) {
    if (!(e instanceof ToolError)) throw e;
    fail.error ??= e;
    return null;
  }
}

/**
 * How plausible a lone number is in a base, from how it is written. A long string of 0 and 1, or
 * of hex digits, is more often bytes than an integer, so its score falls with its length and the
 * bytes it spells (scored on their text) take over.
 */
function numberScore(token: string, radix: Radix): number {
  const bare = token.replace(/^[+-]/, '');
  const prefix = /^0([xXbBoO])/.exec(bare)?.[1]?.toLowerCase();
  if (prefix) return { x: 16, b: 2, o: 8 }[prefix as 'x' | 'b' | 'o'] === radix ? 65 : 0;
  if (radix === 16) {
    if (!/[a-f]/i.test(bare)) return 30;
    return bare.length <= 8 ? 60 : bare.length <= 16 ? 55 : 45;
  }
  const bits = /^[01]+$/.test(bare) && bare.length >= 8;
  if (radix === 2) {
    if (!bits) return 25;
    if (bare.length % 8 !== 0) return 40;
    return bare.length <= 16 ? 58 : bare.length <= 32 ? 52 : 42;
  }
  if (radix === 10) return bits ? 40 : 50;
  return 25;
}

/** Bits per character the Binary tool used: 8 or 7 when every character is one such group. */
function groupBits(input: string, count: number): 7 | 8 | undefined {
  const digits = input.replace(/0b(?=[01])/gi, ' ').replace(/[^01]/g, '').length;
  return digits === count * 8 ? 8 : digits === count * 7 ? 7 : undefined;
}

/** Few characters prove little: a pair of letters is found in plenty of numbers. */
const SHORT = [0, 0.4, 0.6, 0.8, 0.9];
const evidence = (count: number): number => SHORT[count] ?? 1;

const mergeKey = (r: Reading): string => `${r.kind}:${r.values.join(',')}`;
const priority = (r: Reading): number => {
  const first = r.radices[0];
  return (
    { codes: 0, number: 10, numbers: 20, text: 30 }[r.kind] +
    (first === undefined ? 0 : RADICES.indexOf(first))
  );
};

/** Below this a reading is noise next to a good one; at or above it a reading reads as text. */
const JUNK = 5;
const GOOD = 40;
/** A list of codes that scores less than this does not spell text: its values are just numbers. */
const READABLE = 35;

function confidenceOf(ranked: Reading[]): Confidence {
  const best = ranked[0]!;
  const gap = best.score - (ranked[1]?.score ?? 0);
  if (best.score >= 65 && gap >= 15) return 'high';
  if (best.score >= 45 && gap >= 5) return 'medium';
  return 'low';
}

/**
 * Every reading of `raw`, best first. In Auto, text that cannot be numbers is simply text; a list
 * of numbers is read in every base that accepts it and ranked by what it decodes to. A forced
 * base reads only in that base, and says why when the input does not fit it.
 */
export function analyze(raw: string, choice: InputChoice, bits: 7 | 8): Analysis {
  const input = normalise(raw);
  if (!input.trim()) throw new ToolError(T('error.empty'));
  if (input.length > MAX_INPUT) {
    throw new ToolError(T('error.tooLong', { size: input.length, max: MAX_INPUT }));
  }

  const trimmed = input.trim();
  const tokens = tokensOf(input);
  const codeLike = tokens.length > 0 && tokens.every((t) => CODE_TOKEN.test(t));
  const single = /^[+-]?[0-9a-zA-Z_]+$/.test(trimmed);

  const text = (): Reading => {
    const bytes = utf8Encode(input);
    // Digits and spaces are never "words": a code-like input is only text if it reads as words.
    // One unbroken run of hex letters ("deadbeef", "face") is far more likely a number.
    const words = Math.min(1, readability(input.slice(0, SAMPLE), ['en', 'fr']).score / 50);
    const score = codeLike ? Math.round(100 * 0.9 * words * (single ? 0.5 : 1)) : 100;
    return { kind: 'text', radices: [], values: toValues(bytes), bytes, text: input, score };
  };

  if (choice === 'text' || (choice === 'auto' && !codeLike)) {
    const only = text();
    return { readings: [only], codeLike, confidence: 'high' };
  }

  const forced = choice === 'auto' ? null : (Number(choice) as Radix);
  const declared = forced ?? declaredRadix(input);
  const fail: { error: ToolError | null } = { error: null };

  const read = (radices: readonly Radix[]): Reading[] => {
    const found: Reading[] = [];
    for (const radix of radices) {
      if (single) {
        try {
          const value = parseNumber(trimmed, radix).value;
          const score = numberScore(trimmed, radix);
          if (score > 0) {
            found.push({
              kind: 'number',
              radices: [radix],
              values: [value],
              bytes: value >= 0n && value <= 255n ? Uint8Array.of(Number(value)) : null,
              text: null,
              score,
            });
          }
        } catch (e) {
          if (!(e instanceof ToolError)) throw e;
          fail.error ??= e;
        }
      }
      const widths: (7 | 8)[] = radix === 2 && single ? [bits, bits === 8 ? 7 : 8] : [bits];
      for (const width of widths) {
        const codes = codesIn(input, tokens, radix, width, fail);
        if (!codes || codes.length === 0 || (single && codes.length < 2)) continue;
        const spelled = spell(codes);
        const used = radix === 2 ? groupBits(input, codes.length) : undefined;
        found.push({
          kind: 'codes',
          radices: [radix],
          ...(used ? { bits: used } : {}),
          values: codes,
          bytes: spelled.bytes,
          text: spelled.text,
          score: Math.round(textQuality(spelled.text, spelled.multibyte) * evidence(codes.length)),
        });
      }
    }
    // A list that spells no text is a list of numbers (too large to be characters, or just
    // numbers): written in whatever base takes them.
    if (!single && !found.some((r) => r.kind === 'codes' && r.score >= READABLE)) {
      for (const radix of radices) {
        const numbers = numbersIn(input, radix, fail);
        if (numbers?.length) {
          found.push({
            kind: 'numbers',
            radices: [radix],
            values: numbers,
            bytes: null,
            text: null,
            score: 30,
          });
        }
      }
    }
    return found;
  };

  let found = read(declared ? [declared] : RADICES);
  // "0b" and friends can be digits of a longer word: when the stated base fails, try them all.
  if (!found.length && declared && !forced) found = read(RADICES);
  if (forced !== null && !found.length) {
    throw fail.error ?? new ToolError(T('error.noReading'));
  }
  if (choice === 'auto') found.push(text());

  // Readings with the same values in several bases are one reading.
  const merged = new Map<string, Reading>();
  for (const r of found) {
    const key = mergeKey(r);
    const known = merged.get(key);
    if (known) {
      known.radices = [...new Set([...known.radices, ...r.radices])].sort(
        (a, b) => RADICES.indexOf(a) - RADICES.indexOf(b),
      );
    } else merged.set(key, { ...r, radices: [...r.radices] });
  }
  const ranked = [...merged.values()].sort(
    (a, b) => b.score - a.score || priority(a) - priority(b),
  );
  // Readings that give nothing but control characters are valid but never what was meant.
  const best = ranked[0]!;
  const readings = ranked.filter((r, i) => i === 0 || r.score >= JUNK || best.score < GOOD);
  return { readings, codeLike, confidence: confidenceOf(readings) };
}

// ---------- writing the values in every base ----------

export type Separator = 'space' | 'comma' | 'newline' | 'none';
export interface WriteOptions {
  width: 7 | 8;
  separator: Separator;
  upper: boolean;
}
export interface Written {
  binary: string;
  octal: string;
  decimal: string;
  hex: string;
  /** 7-bit groups were asked for but a value is above 127: binary uses 8 bits. */
  over7: boolean;
}

const SEPARATOR: Record<Separator, string> = { space: ' ', comma: ',', newline: '\n', none: '' };
const MIN_DIGITS: Record<Radix, number> = { 2: 8, 8: 3, 10: 0, 16: 2 };

function wide(v: bigint, radix: Radix, pad: boolean, upper: boolean): string {
  const digits = (v < 0n ? -v : v).toString(radix).padStart(pad ? MIN_DIGITS[radix] : 0, '0');
  return (v < 0n ? '-' : '') + (upper && radix === 16 ? digits.toUpperCase() : digits);
}

/**
 * The values in binary, octal, decimal and hex. Bytes go through the encoders of the Binary, Hex
 * and Char codes tools; larger values (code points, big numbers) are written in full. `fixed` pads
 * every value to its usual width (8, 3, 2 digits); a lone number is not padded.
 */
export function write(values: readonly bigint[], o: WriteOptions, fixed: boolean): Written {
  const sep = SEPARATOR[o.separator];
  if (fixed && values.every((v) => v >= 0n && v <= 255n)) {
    const bytes = Uint8Array.from(values, Number);
    const over7 = o.width === 7 && bytes.some((b) => b > 127);
    const chars = latin1Decode(bytes);
    const codes = (base: 'oct' | 'dec') => charcodeEncode(chars, base, 'space', 'codepoint');
    return {
      binary: binaryEncode(bytes, o.width === 7 && !over7 ? 7 : 8, sep),
      octal: codes('oct').replace(/ /g, sep),
      decimal:
        o.separator === 'none'
          ? Array.from(bytes, (b) => String(b).padStart(3, '0')).join('')
          : codes('dec').replace(/ /g, sep),
      hex:
        o.separator === 'none'
          ? hexEncode(bytes, 'none', o.upper)
          : hexEncode(bytes, 'space', o.upper).replace(/ /g, sep),
      over7,
    };
  }
  const list = (radix: Radix) =>
    values.map((v) => wide(v, radix, fixed, o.upper)).join(o.separator === 'none' ? ' ' : sep);
  return { binary: list(2), octal: list(8), decimal: list(10), hex: list(16), over7: false };
}
