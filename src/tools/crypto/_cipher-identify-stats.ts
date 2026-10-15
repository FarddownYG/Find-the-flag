import { foldAccents, letterFrequencies, readability, type Lang } from '../../lib/readability';
import { plaintextScore } from '../../lib/english';
import { affineDecrypt } from './affine';
import { atbash } from './atbash';
import { rotate } from './caesar';

/**
 * The numbers behind the cipher identifier: everything it measures on a pasted text, with no
 * judgement attached (the judgement is in _cipher-identify-rank.ts). Pure and deterministic.
 */

export type { Lang };
export type LangChoice = 'auto' | Lang;

/** Reference index of coincidence of the letters of each language, and of random letters. */
export const IOC_REFERENCE = { en: 0.0667, fr: 0.0778, random: 1 / 26 } as const;

/** The longest text analysed; more than this is cut (and the tool says so). */
export const MAX_SYMBOLS = 100_000;
/** Characters read at most, spaces and all (a text with that many spaces is not a ciphertext). */
export const MAX_INPUT = 400_000;
/** The longest piece given to the readability score (it is the slowest measure here). */
const READABILITY_CHARS = 2400;
export const MAX_PERIOD = 20;

const FREQ: Record<Lang, number[]> = { en: letterFrequencies('en'), fr: letterFrequencies('fr') };

export interface PeriodRow {
  period: number;
  /** Mean index of coincidence of the columns when the letters are dealt into `period` columns. */
  ioc: number;
}

export interface KasiskiRow {
  factor: number;
  /** How many of the distances between repeated trigrams this number divides. */
  votes: number;
}

export interface Fit {
  /** Caesar: a = 1 and b the shift. Affine: the key (a, b). Atbash: a = b = 25. */
  a: number;
  b: number;
  /** Chi-squared of the letters decrypted with it, against the language's letter frequencies. */
  chi: number;
  /** (chi - 25) / letters: about 0 when the letters follow the language, about 1 for random ones. */
  excess: number;
  /** Readability (0..100) of the text decrypted with this key. */
  read: number;
}

export interface Stats {
  /** The language the letters are compared with (the one chosen, or the best fit). */
  lang: Lang;
  /** Characters of the text, and how many of them are not whitespace (the cipher's symbols). */
  chars: number;
  symbols: number;
  truncated: boolean;
  /** ASCII letters (accents folded), digits, other symbols, and the whitespace characters. */
  letters: number;
  digits: number;
  others: number;
  spaces: number;
  upper: number;
  lower: number;
  /** The distinct non-letter, non-digit symbols, in order of first use (at most 12). */
  otherSet: string[];
  /** Distinct symbols (case counts), and distinct letters (case folded). */
  distinct: number;
  distinctLetters: number;
  /** Letters absent from the text, in A..Z order. */
  missing: string[];
  letterShare: number;
  /** Letter values 0..25 in reading order. */
  values: number[];
  counts: number[];
  ioc: number;
  /** IoC of all the symbols (case counts), for texts that are not made of letters. */
  symbolIoc: number;
  entropy: number;
  entropyMax: number;
  /** Chi-squared of the letters against each language, and the excess per letter. */
  chi: Record<Lang, number>;
  excess: Record<Lang, number>;
  /** The best Caesar shift (1..25), the best affine key with a ≠ 1, and Atbash (language `lang`). */
  caesar: Fit;
  affine: Fit;
  atbash: Fit;
  /**
   * ROT47 on a text of printable ASCII that is not mostly letters: the shift that reads best and
   * the readability (0..100) of the text it gives.
   */
  rot47: { shift: number; read: number } | null;
  period: PeriodRow[];
  /** The smallest period 2..20 whose multiples all show a high IoC, with that mean IoC. */
  peak: { period: number; ioc: number; harmonic: number } | null;
  kasiski: { repeats: number; rows: KasiskiRow[]; votes: number[]; longest: number };
  doubles: { total: number; inPairs: number; between: number; pairs: number };
  /** Pairs of equal digraphs read from offset 0 and from offset 1 (blocks of two letters). */
  align2: { aligned: number; shifted: number; pairs: number };
  /** Equal trigraphs counted from offsets 0, 1 and 2 (blocks of three letters). */
  align3: number[];
  /** IoC of the pairs of letters as symbols of their own (ADFGX coordinates). */
  pairIoc: number;
  caseSwitches: number;
  /** Whitespace separated groups: how many, and their common length (null if they differ). */
  groups: { count: number; size: number | null };
  digitsOnly: boolean;
  /** For digits only: the digits used, and whether every pair of digits is a 1..6 coordinate. */
  digitSet: string[];
  coordinatePairs: boolean;
  /** Whitespace separated numbers: how many and their range (null when the text is not numbers). */
  numbers: { count: number; min: number; max: number } | null;
  /** The two symbols of a text made of two symbols only. */
  twoSymbols: string[] | null;
  /** The letters of a text made only of A D F G V X (ADFGX / ADFGVX), else null. */
  adfgvx: string[] | null;
  /** Whole divisors 2..20 of the number of symbols. */
  divisors: number[];
  /** Readability of the text as language (0..100) and the language that fits best. */
  readability: { score: number; lang: Lang | null; coverage: number };
}

const isDigit = (c: number): boolean => c >= 48 && c <= 57;

/** Sum of c(c-1)/2 over the counts of equal items. */
function equalPairs(counts: Iterable<number>): number {
  let s = 0;
  for (const c of counts) s += (c * (c - 1)) / 2;
  return s;
}

export function iocOfCounts(counts: readonly number[], n: number): number {
  if (n < 2) return 0;
  let s = 0;
  for (const c of counts) s += c * (c - 1);
  return s / (n * (n - 1));
}

/** Chi-squared of letter counts against a language, the letters being read through `map`. */
function chiOf(counts: readonly number[], freq: readonly number[], map: (i: number) => number) {
  let n = 0;
  for (const c of counts) n += c;
  if (!n) return { chi: Infinity, excess: Infinity };
  let chi = 0;
  for (let i = 0; i < 26; i++) {
    const expected = (freq[i]! / 100) * n;
    chi += (counts[map(i)]! - expected) ** 2 / expected;
  }
  return { chi, excess: Math.max(0, chi - 25) / n };
}

const mod = (n: number, m: number): number => ((n % m) + m) % m;
const AFFINE_A = [1, 3, 5, 7, 9, 11, 15, 17, 19, 21, 23, 25];
const NO_FIT = { a: 0, b: 0, chi: Infinity, excess: Infinity };

type RawFit = typeof NO_FIT;

function bestFits(counts: readonly number[], lang: Lang) {
  const freq = FREQ[lang];
  let caesar: RawFit = NO_FIT;
  let affine: RawFit = NO_FIT;
  for (const a of AFFINE_A) {
    for (let b = 0; b < 26; b++) {
      if (a === 1 && b === 0) continue;
      // Plain letter i was enciphered as a·i + b: read the counts of those cipher letters.
      const r = chiOf(counts, freq, (i) => mod(a * i + b, 26));
      const fit: RawFit = { a, b, chi: r.chi, excess: r.excess };
      if (a === 1) {
        if (fit.chi < caesar.chi) caesar = fit;
      } else if (!(a === 25 && b === 25) && fit.chi < affine.chi) affine = fit;
    }
  }
  const r = chiOf(counts, freq, (i) => 25 - i);
  return { caesar, affine, atbash: { a: 25, b: 25, chi: r.chi, excess: r.excess } as RawFit };
}

/** Mean IoC of the columns when the values are dealt into `p` columns (pairs of equal letters). */
function columnIoc(values: readonly number[], p: number): number {
  let same = 0;
  let pairs = 0;
  for (let col = 0; col < p; col++) {
    const counts = new Array<number>(26).fill(0);
    let n = 0;
    for (let i = col; i < values.length; i += p) {
      counts[values[i]!]!++;
      n++;
    }
    same += equalPairs(counts);
    pairs += (n * (n - 1)) / 2;
  }
  return pairs ? same / pairs : 0;
}

/** Equal blocks of `size` letters read from offset `offset`, counted as pairs of equal blocks. */
function equalBlocks(values: readonly number[], size: number, offset: number): number {
  const seen = new Map<number, number>();
  for (let i = offset; i + size <= values.length; i += size) {
    let key = 0;
    for (let k = 0; k < size; k++) key = key * 26 + values[i + k]!;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return equalPairs(seen.values());
}

function kasiskiOf(values: readonly number[]): Stats['kasiski'] {
  const last = new Map<number, number>();
  const votes = new Array<number>(MAX_PERIOD + 1).fill(0);
  let repeats = 0;
  let longest = 0;
  for (let i = 0; i + 3 <= values.length; i++) {
    const key = (values[i]! * 26 + values[i + 1]!) * 26 + values[i + 2]!;
    const prev = last.get(key);
    if (prev !== undefined) {
      repeats++;
      const d = i - prev;
      for (let f = 2; f <= MAX_PERIOD; f++) if (d % f === 0) votes[f]!++;
      let len = 3;
      while (i + len < values.length && values[prev + len] === values[i + len] && len < 60) len++;
      longest = Math.max(longest, len);
    }
    last.set(key, i);
  }
  const rows: KasiskiRow[] = [];
  for (let f = 2; f <= MAX_PERIOD; f++) {
    if (votes[f]! > 0) rows.push({ factor: f, votes: votes[f]! });
  }
  rows.sort((a, b) => b.votes - a.votes || a.factor - b.factor);
  return { repeats, rows, votes, longest };
}

/**
 * The period 2..max whose multiples all show a high IoC (a key of length 5 lifts the columns of
 * 5, 10, 15 and 20 alike, which a chance peak at one length does not), as its mean IoC.
 */
function findPeak(period: readonly PeriodRow[]): Stats['peak'] {
  const max = period.length;
  const harmonic = new Map<number, number>();
  for (let p = 2; p <= max; p++) {
    let sum = 0;
    let k = 0;
    for (let q = p; q <= max; q += p) {
      sum += period[q - 1]!.ioc;
      k++;
    }
    harmonic.set(p, sum / k);
  }
  if (!harmonic.size) return null;
  const top = Math.max(...harmonic.values());
  for (let p = 2; p <= max; p++) {
    if (harmonic.get(p)! >= top - 0.004) {
      return { period: p, ioc: period[p - 1]!.ioc, harmonic: harmonic.get(p)! };
    }
  }
  return null;
}

function chooseLang(choice: LangChoice, excess: Record<Lang, number>, fits: Record<Lang, number>) {
  if (choice !== 'auto') return choice;
  const best: Record<Lang, number> = {
    en: Math.min(excess.en, fits.en),
    fr: Math.min(excess.fr, fits.fr),
  };
  if (Math.min(best.en, best.fr) < 0.5) return best.fr < best.en ? 'fr' : 'en';
  return 'en';
}

/** Everything the identifier measures. `text` may be of any length (it is cut at MAX_SYMBOLS). */
export function analyse(input: string, choice: LangChoice = 'auto'): Stats {
  // Whitespace around the text is not part of the cipher.
  const trimmed = input.trim();
  const text = trimmed.length > MAX_INPUT ? trimmed.slice(0, MAX_INPUT) : trimmed;
  let stream = '';
  let spaces = 0;
  let chars = 0;
  for (const ch of text) {
    chars++;
    if (/\s/u.test(ch)) spaces++;
    else if (stream.length < MAX_SYMBOLS) stream += ch;
  }
  const symbols = [...stream];
  const truncated = trimmed.length > text.length || chars - spaces > symbols.length;

  const symbolCounts = new Map<string, number>();
  const otherSet: string[] = [];
  let digits = 0;
  let others = 0;
  let upper = 0;
  let lower = 0;
  const values: number[] = [];
  let caseSwitches = 0;
  let lastCase = '';
  for (const s of symbols) {
    symbolCounts.set(s, (symbolCounts.get(s) ?? 0) + 1);
    const c = s.charCodeAt(0);
    if (s.length === 1 && isDigit(c)) {
      digits++;
      continue;
    }
    const base = c < 128 ? s : foldAccents(s);
    const letter = base.length === 1 && /[A-Za-z]/.test(base) ? base : null;
    if (letter) {
      const v = letter.toLowerCase().charCodeAt(0) - 97;
      values.push(v);
      const isUpper = letter !== letter.toLowerCase();
      if (isUpper) upper++;
      else lower++;
      const caseNow = isUpper ? 'U' : 'l';
      if (lastCase && caseNow !== lastCase) caseSwitches++;
      lastCase = caseNow;
    } else {
      others++;
      if (otherSet.length < 12 && !otherSet.includes(s)) otherSet.push(s);
    }
  }

  const counts = new Array<number>(26).fill(0);
  for (const v of values) counts[v]!++;
  const n = values.length;
  const ioc = iocOfCounts(counts, n);
  const total = symbols.length;
  const symbolIoc = iocOfCounts([...symbolCounts.values()], total);
  let entropy = 0;
  for (const c of symbolCounts.values()) entropy -= (c / total) * Math.log2(c / total);
  const distinct = symbolCounts.size;
  const missing: string[] = [];
  for (let i = 0; i < 26; i++) if (!counts[i]) missing.push(String.fromCharCode(65 + i));

  const chi = { en: 0, fr: 0 } as Record<Lang, number>;
  const excess = { en: 0, fr: 0 } as Record<Lang, number>;
  for (const lang of ['en', 'fr'] as const) {
    const r = chiOf(counts, FREQ[lang], (i) => i);
    chi[lang] = r.chi;
    excess[lang] = r.excess;
  }
  const fits = { en: bestFits(counts, 'en'), fr: bestFits(counts, 'fr') };
  const simpleBest = (lang: Lang) =>
    Math.min(fits[lang].caesar.excess, fits[lang].affine.excess, fits[lang].atbash.excess);
  const lang = chooseLang(choice, excess, { en: simpleBest('en'), fr: simpleBest('fr') });

  // What each simple key makes of the text, and how much of it reads as words.
  const readOf = (decrypted: string): number =>
    n >= 6 ? readability(decrypted.slice(0, READABILITY_CHARS).trim(), [lang]).score : 0;
  const c = fits[lang].caesar;
  const a = fits[lang].affine;
  const caesar: Fit = n ? { ...c, read: readOf(rotate(text, -c.b, 'letters')) } : { ...c, read: 0 };
  const affine: Fit = n ? { ...a, read: readOf(affineDecrypt(text, a.a, a.b)) } : { ...a, read: 0 };
  const mirror: Fit = n
    ? { ...fits[lang].atbash, read: readOf(atbash(text)) }
    : { ...fits[lang].atbash, read: 0 };

  // ROT47 turns printable ASCII into printable ASCII: only worth a look when letters are few.
  let rot47: Stats['rot47'] = null;
  if (total >= 8 && n / total < 0.75 && [...stream].every((s) => s >= '!' && s <= '~')) {
    let best = { shift: 0, score: -1 };
    for (let shift = 1; shift < 94; shift++) {
      const score = plaintextScore(rotate(stream.slice(0, 2000), shift, 'rot47'));
      if (score > best.score) best = { shift, score };
    }
    // Whitespace is not part of the symbols, so it is put back: the words are what is read.
    const shifted = rotate(text.slice(0, READABILITY_CHARS), best.shift, 'rot47');
    rot47 = { shift: best.shift, read: readability(shifted, [lang]).score };
  }

  // Periodic IoC.
  const period: PeriodRow[] = [];
  const maxPeriod = Math.min(MAX_PERIOD, Math.max(1, Math.floor(n / 4)));
  for (let p = 1; p <= maxPeriod; p++) period.push({ period: p, ioc: columnIoc(values, p) });

  // Doubled letters.
  let dTotal = 0;
  let dPairs = 0;
  for (let i = 0; i + 1 < n; i++) {
    if (values[i] === values[i + 1]) {
      dTotal++;
      if (i % 2 === 0) dPairs++;
    }
  }

  // IoC of the letters read two by two (coordinate pairs of ADFGX).
  const pairCounts = new Map<string, number>();
  for (let i = 0; i + 1 < n; i += 2) {
    const key = `${values[i]},${values[i + 1]}`;
    pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
  }
  const pairN = Math.floor(n / 2);
  const pairIoc = pairN > 1 ? (2 * equalPairs(pairCounts.values())) / (pairN * (pairN - 1)) : 0;

  const tokens = text.split(/\s+/u).filter(Boolean);
  const body = tokens.slice(0, -1);
  const size =
    body.length && body.every((t) => t.length === body[0]!.length) ? body[0]!.length : null;
  const last = tokens[tokens.length - 1];
  const groups = {
    count: tokens.length,
    size: size !== null && last !== undefined && last.length <= size ? size : null,
  };

  // Digits only: are they coordinates (row, column) of a 5 x 5 or 6 x 6 square?
  const digitsOnly = total > 0 && digits === total;
  const digitSet = digitsOnly ? [...new Set(symbols)].sort() : [];
  let coordinatePairs = false;
  if (digitsOnly) {
    const pairsOk = (s: string) => s.length % 2 === 0 && /^(?:[1-6]{2})+$/.test(s);
    coordinatePairs =
      tokens.length === 1 ? pairsOk(tokens[0]!) : tokens.every((t) => t.length === 2 && pairsOk(t));
  }

  let numbers: Stats['numbers'] = null;
  if (tokens.length >= 4 && tokens.every((t) => /^\d{1,4}$/.test(t))) {
    const nums = tokens.map(Number);
    numbers = { count: nums.length, min: Math.min(...nums), max: Math.max(...nums) };
  }

  const twoSymbols = distinct === 2 ? [...symbolCounts.keys()].sort() : null;
  let adfgvx: string[] | null = null;
  if (n > 0 && n === total && [...symbolCounts.keys()].every((s) => 'ADFGVXadfgvx'.includes(s))) {
    adfgvx = [...new Set(values.map((v) => String.fromCharCode(65 + v)))].sort();
  }

  const divisors: number[] = [];
  for (let d = 2; d <= 20; d++) if (total >= d && total % d === 0) divisors.push(d);

  const read = n >= 6 ? readability(text.slice(0, READABILITY_CHARS).trim(), [lang]) : null;

  return {
    lang,
    chars,
    symbols: total,
    truncated,
    letters: n,
    digits,
    others,
    spaces,
    upper,
    lower,
    otherSet,
    distinct,
    distinctLetters: 26 - missing.length,
    missing,
    letterShare: total ? n / total : 0,
    values,
    counts,
    ioc,
    symbolIoc,
    entropy,
    entropyMax: distinct > 1 ? Math.log2(distinct) : 0,
    chi,
    excess,
    caesar,
    affine,
    atbash: mirror,
    rot47,
    period,
    peak: findPeak(period),
    kasiski: kasiskiOf(values),
    doubles: { total: dTotal, inPairs: dPairs, between: dTotal - dPairs, pairs: Math.floor(n / 2) },
    align2: {
      aligned: equalBlocks(values, 2, 0),
      shifted: equalBlocks(values, 2, 1),
      pairs: Math.floor(n / 2),
    },
    align3: [0, 1, 2].map((o) => equalBlocks(values, 3, o)),
    pairIoc,
    caseSwitches,
    groups,
    digitsOnly,
    digitSet,
    coordinatePairs,
    numbers,
    twoSymbols,
    adfgvx,
    divisors,
    readability: read
      ? { score: read.score, lang: read.lang, coverage: read.coverage }
      : { score: 0, lang: null, coverage: 0 },
  };
}
