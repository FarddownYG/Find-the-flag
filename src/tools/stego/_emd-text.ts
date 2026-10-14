import { ToolError } from '../../core/errors';
import { toolT } from '../../i18n/tool-text';
import { fromHex, isValidUtf8, toHex, utf8Decode } from '../../lib/bytes';
import { readability } from '../../lib/readability';

const T = toolT('emd');

/**
 * Turning EMD digits into text has no standard. Three families are common:
 *  - fixed:   k digits per byte with k = ceil(8 / log2(base)), enough for any byte (base 5: 4);
 *  - minimal: the fewest digits that reach ASCII 'z' (base 5: 3 digits, 5^3 = 125);
 *  - bignum:  the whole stream is one big number in the base, written out as bytes.
 * Each one with the first digit of a group most (msd) or least (lsd) significant.
 */
export type Grouping = 'fixed' | 'minimal' | 'bignum';
export type DigitOrder = 'msd' | 'lsd';
export interface Convention {
  grouping: Grouping;
  order: DigitOrder;
}

/** Longest stream the big-number reading will convert (the cost grows faster than linearly). */
export const BIG_MAX_DIGITS = 50_000;
/** 'minimal' has to reach 'z' (122). */
const MINIMAL_REACH = 123;

function smallestPower(base: number, atLeast: number): number {
  let k = 1;
  for (let v = base; v < atLeast; v *= base) k++;
  return k;
}

export const fixedDigits = (base: number) => smallestPower(base, 256);
export const minimalDigits = (base: number) => smallestPower(base, MINIMAL_REACH);

/** Digits per character of a convention; null for the big-number reading. */
export function charDigits(grouping: Grouping, base: number): number | null {
  if (grouping === 'fixed') return fixedDigits(base);
  if (grouping === 'minimal') return minimalDigits(base);
  return null;
}

/** Fewest base-`base` digits that can hold any number of `chars` bytes. */
export function bigDigits(base: number, chars: number): number {
  if (chars <= 0) return 0;
  let d = Math.ceil((chars * 8) / Math.log2(base));
  // Far beyond the big-number limit: the estimate is enough, and exact maths would be slow.
  if (d > BIG_MAX_DIGITS + 8) return d;
  const need = 1n << BigInt(8 * chars);
  const b = BigInt(base);
  while (d > 1 && b ** BigInt(d - 1) >= need) d--;
  while (b ** BigInt(d) < need) d++;
  return d;
}

/** Digits needed to read `chars` characters (0 = no limit is expressed by the caller). */
export function digitsNeeded(grouping: Grouping, base: number, chars: number): number {
  const k = charDigits(grouping, base);
  return k === null ? bigDigits(base, chars) : chars * k;
}

function digitsToBig(seq: Uint8Array, base: number): bigint {
  const chunk = Math.max(1, Math.floor(30 / Math.log2(base)));
  let acc = 0n;
  for (let i = 0; i < seq.length; i += chunk) {
    const m = Math.min(chunk, seq.length - i);
    let part = 0;
    for (let j = 0; j < m; j++) part = part * base + seq[i + j]!;
    acc = acc * BigInt(base ** m) + BigInt(part);
  }
  return acc;
}

function bigToBytes(v: bigint): Uint8Array {
  if (v === 0n) return new Uint8Array(0);
  let hex = v.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  return fromHex(hex);
}

/**
 * Digits (base `base`) to bytes. `chars` limits the output to that many characters (0 = as many
 * as the digits give). A digit group worth more than 255 becomes 0xFF. Returns null when the
 * big-number reading would be too long to convert.
 */
export function digitsToBytes(
  digits: Uint8Array,
  base: number,
  conv: Convention,
  chars: number,
): Uint8Array | null {
  const k = charDigits(conv.grouping, base);
  if (k !== null) {
    const whole = Math.floor(digits.length / k);
    const count = chars > 0 ? Math.min(chars, whole) : whole;
    const out = new Uint8Array(count);
    for (let c = 0; c < count; c++) {
      const o = c * k;
      let v = 0;
      if (conv.order === 'msd') for (let j = 0; j < k; j++) v = v * base + digits[o + j]!;
      else for (let j = k - 1; j >= 0; j--) v = v * base + digits[o + j]!;
      out[c] = v > 255 ? 255 : v;
    }
    return out;
  }
  const use = chars > 0 ? Math.min(digits.length, bigDigits(base, chars)) : digits.length;
  if (use > BIG_MAX_DIGITS) return null;
  let seq = digits.subarray(0, use);
  if (conv.order === 'lsd') seq = Uint8Array.from(seq).reverse();
  const bytes = bigToBytes(digitsToBig(seq, base));
  if (chars <= 0) return bytes;
  const out = new Uint8Array(chars);
  if (bytes.length >= chars) out.set(bytes.subarray(bytes.length - chars));
  else out.set(bytes, chars - bytes.length);
  return out;
}

/** Bytes to digits (base `base`), the inverse of digitsToBytes for the same convention. */
export function bytesToDigits(bytes: Uint8Array, base: number, conv: Convention): Uint8Array {
  const k = charDigits(conv.grouping, base);
  if (k !== null) {
    const limit = base ** k;
    const out = new Uint8Array(bytes.length * k);
    for (let c = 0; c < bytes.length; c++) {
      let v = bytes[c]!;
      if (v >= limit) {
        throw new ToolError(T('error.byteTooBig', { value: v, digits: k, base, max: limit - 1 }));
      }
      const o = c * k;
      if (conv.order === 'msd') {
        for (let j = k - 1; j >= 0; j--) {
          out[o + j] = v % base;
          v = Math.floor(v / base);
        }
      } else {
        for (let j = 0; j < k; j++) {
          out[o + j] = v % base;
          v = Math.floor(v / base);
        }
      }
    }
    return out;
  }
  if (!bytes.length) return new Uint8Array(0);
  const size = bigDigits(base, bytes.length);
  if (size > BIG_MAX_DIGITS) throw new ToolError(T('error.bigTooLong', { max: BIG_MAX_DIGITS }));
  const text = BigInt(`0x${toHex(bytes)}`)
    .toString(base)
    .padStart(size, '0');
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = parseInt(text[i]!, base);
  return conv.order === 'lsd' ? out.reverse() : out;
}

// ---------- reading the result ----------

const isPrintable = (b: number) => (b >= 0x20 && b < 0x7f) || b === 9 || b === 10 || b === 13;

/** Text view of bytes: UTF-8 when valid, else ASCII with a dot for anything unreadable. */
export function displayText(bytes: Uint8Array): string {
  let out = '';
  if (isValidUtf8(bytes)) {
    for (const ch of utf8Decode(bytes)) {
      const c = ch.codePointAt(0)!;
      out += c < 0x20 && c !== 9 && c !== 10 && c !== 13 ? '·' : c >= 0x7f && c < 0xa0 ? '·' : ch;
    }
    return out;
  }
  for (const b of bytes) out += isPrintable(b) ? String.fromCharCode(b) : '·';
  return out;
}

/** Only the part up to this many bytes is judged: ranking stays cheap on huge images. */
const JUDGED = 256;

export interface Assessment {
  /** Share of printable ASCII among the judged bytes (0..1). */
  printable: number;
  /** Longest stretch of printable bytes, and its text. */
  run: number;
  runText: string;
  /** French / English readability (0..100) of the longest printable stretch. */
  readability: number;
  lang: 'en' | 'fr' | null;
  /**
   * Bits of luck it would take for random digits to look this much like text under the same
   * convention. Base 5 read 3 digits at a time lands on printable bytes 3 times out of 4 by
   * chance, so a long printable run means little there; read 4 at a time it is rare.
   */
  evidence: number;
  /** Ranking score: the evidence plus a share of the readability. */
  score: number;
}

/** Probability that a random character is printable under a convention. */
export function printableChance(grouping: Grouping, base: number): number {
  const k = charDigits(grouping, base);
  if (k === null) return 98 / 256;
  const total = base ** k;
  let hits = 0;
  for (let v = 0; v < Math.min(total, 256); v++) if (isPrintable(v)) hits++;
  return hits / total;
}

/**
 * How much a reading looks like a message, given the chance `p` that a random character is
 * printable. A message shorter than the stream is followed by the cover's own noise, so both
 * the longest printable stretch and the overall share are weighed, as bits of evidence.
 */
export function assess(bytes: Uint8Array, p: number): Assessment {
  const head = bytes.subarray(0, JUDGED);
  const n = head.length;
  let printableCount = 0;
  let run = 0;
  let runAt = 0;
  let cur = 0;
  for (let i = 0; i < n; i++) {
    if (isPrintable(head[i]!)) {
      printableCount++;
      cur++;
      if (cur > run) {
        run = cur;
        runAt = i - cur + 1;
      }
    } else cur = 0;
  }
  const printable = n ? printableCount / n : 0;
  const runBytes = head.subarray(runAt, runAt + run);
  const runText = displayText(runBytes);
  const read = run >= 3 ? readability(runText) : null;

  const penalty = Math.log2(Math.max(2, n));
  // A flat channel gives one repeated digit, which can spell a repeated printable byte: no evidence.
  const flatRun = run >= 6 && new Set(runBytes).size <= 2;
  const flatAll = n >= 8 && new Set(head).size <= 2;
  const runBits = flatRun ? 0 : Math.max(0, run * -Math.log2(p) - penalty);
  let shareBits = 0;
  if (!flatAll && n && printable > p) {
    const q = printable;
    const kl = q * Math.log2(q / p) + (q < 1 ? (1 - q) * Math.log2((1 - q) / (1 - p)) : 0);
    shareBits = Math.max(0, n * kl - penalty);
  }
  const evidence = Math.max(runBits, shareBits);
  return {
    printable,
    run,
    runText,
    readability: read?.score ?? 0,
    lang: read?.lang ?? null,
    evidence,
    score: evidence + 0.3 * (read?.score ?? 0),
  };
}

/** Digits as text, grouped `group` at a time (a character's worth) and cut after `limit` digits. */
export function formatDigits(digits: Uint8Array, group: number, limit: number): string {
  const shown = Math.min(digits.length, group > 0 ? Math.floor(limit / group) * group : limit);
  const parts: string[] = [];
  const size = group > 0 ? group : shown || 1;
  for (let i = 0; i < shown; i += size) {
    let s = '';
    for (let j = i; j < Math.min(shown, i + size); j++) s += digits[j]!.toString(36);
    parts.push(s);
  }
  return parts.join(' ');
}

/** Digits as one string with no spaces (what the downloadable file holds). */
export function plainDigits(digits: Uint8Array): string {
  let s = '';
  for (let i = 0; i < digits.length; i += 0x4000) {
    s += Array.from(digits.subarray(i, i + 0x4000), (d) => d.toString(36)).join('');
  }
  return s;
}
