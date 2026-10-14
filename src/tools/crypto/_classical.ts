import { ToolError } from '../../core/errors';
import { toolT } from '../../i18n/tool-text';

/** Helpers shared by the classical-cipher tools in this folder (not a tool itself). */

/** Only the Vigenère tool parses letter keys, so its error text lives in that namespace. */
const T = toolT('vigenere');

export const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export const mod = (n: number, m: number): number => ((n % m) + m) % m;

/** 0..25 for an ASCII letter of either case, -1 otherwise. */
export function letterIndex(ch: string): number {
  const c = ch.charCodeAt(0);
  if (c >= 65 && c <= 90) return c - 65;
  if (c >= 97 && c <= 122) return c - 97;
  return -1;
}

export const isUpper = (ch: string): boolean => ch >= 'A' && ch <= 'Z';

/** Upper- or lower-case letter for index 0..25 (copying the case of `like`). */
export function letterLike(index: number, like: string): string {
  return String.fromCharCode((isUpper(like) ? 65 : 97) + mod(index, 26));
}

/** Only the ASCII letters, upper-cased. */
export function lettersOnly(text: string): string {
  return text.replace(/[^A-Za-z]/g, '').toUpperCase();
}

/** Key text -> letter values 0..25 (non-letters ignored); `error` is thrown when it has none. */
export function parseLetterKey(key: string, error = T('error.keyLetters')): number[] {
  const out: number[] = [];
  for (const ch of key) {
    const i = letterIndex(ch);
    if (i >= 0) out.push(i);
  }
  if (!out.length) throw new ToolError(error);
  return out;
}

export const keyToString = (key: readonly number[]): string =>
  key.map((k) => ALPHABET[mod(k, 26)]).join('');

/** Smallest period p (dividing the length) such that the sequence is p-periodic. */
export function minimalPeriod<T>(seq: readonly T[]): number {
  const n = seq.length;
  for (let p = 1; p <= n; p++) {
    if (n % p) continue;
    let ok = true;
    for (let i = p; i < n && ok; i++) ok = seq[i] === seq[i - p];
    if (ok) return p;
  }
  return n;
}

/** One-line, length-limited preview for result tables. */
export function preview(s: string, max = 56): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

/** "FLAGSOMETHING" -> "flag{something}" (decoders that can only output letters). */
export function flagForm(letters: string): string | null {
  const t = letters.replace(/[^A-Za-z0-9]/g, '');
  if (t.length > 4 && /^flag/i.test(t))
    return `${t.slice(0, 4).toLowerCase()}{${t.slice(4).toLowerCase()}}`;
  return null;
}

/** English letter frequencies (a..z, percent), same table as lib/english. */
export const ENGLISH_FREQ = [
  8.2, 1.5, 2.8, 4.3, 12.7, 2.2, 2.0, 6.1, 7.0, 0.15, 0.77, 4.0, 2.4, 6.7, 7.5, 1.9, 0.095, 6.0,
  6.3, 9.1, 2.8, 0.98, 2.4, 0.15, 2.0, 0.074,
];

/** Letter counts (index 0..25) of a string, case-insensitive. */
export function letterCounts(text: string): number[] {
  const counts = new Array<number>(26).fill(0);
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i) | 0x20;
    if (c >= 97 && c <= 122) counts[c - 97]!++;
  }
  return counts;
}

/** Chi-squared of a letter-count vector against English (lower is more English). */
export function chiSquaredCounts(counts: readonly number[]): number {
  let total = 0;
  for (const c of counts) total += c;
  if (!total) return Infinity;
  let chi = 0;
  for (let i = 0; i < 26; i++) {
    const expected = (ENGLISH_FREQ[i]! / 100) * total;
    chi += (counts[i]! - expected) ** 2 / expected;
  }
  return chi;
}

/** Index of coincidence of a list of letter values 0..25. */
export function iocOfValues(values: readonly number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const counts = new Array<number>(26).fill(0);
  for (const v of values) counts[v]!++;
  return counts.reduce((a, k) => a + k * (k - 1), 0) / (n * (n - 1));
}

/** Average IoC of the columns when the letters are dealt into `len` columns. */
export function averageColumnIoc(values: readonly number[], len: number): number {
  const cols: number[][] = Array.from({ length: len }, () => []);
  values.forEach((v, i) => cols[i % len]!.push(v));
  let sum = 0;
  let used = 0;
  for (const col of cols) {
    if (col.length < 2) continue;
    sum += iocOfValues(col);
    used++;
  }
  return used ? sum / used : 0;
}

/**
 * Kasiski examination: distances between repeats of trigrams (and longer) and how many of
 * them each candidate key length divides. Returns lengths 2..max sorted by support.
 */
export function kasiski(letters: string, max: number): { length: number; votes: number }[] {
  const seen = new Map<string, number>();
  const votes = new Array<number>(max + 1).fill(0);
  for (let i = 0; i + 3 <= letters.length; i++) {
    const g = letters.slice(i, i + 3);
    const prev = seen.get(g);
    if (prev !== undefined) {
      const d = i - prev;
      for (let f = 2; f <= max; f++) if (d % f === 0) votes[f]!++;
    }
    seen.set(g, i);
  }
  const out: { length: number; votes: number }[] = [];
  for (let f = 2; f <= max; f++) if (votes[f]! > 0) out.push({ length: f, votes: votes[f]! });
  return out.sort((a, b) => b.votes - a.votes || a.length - b.length);
}

/** Deterministic PRNG (mulberry32). */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
