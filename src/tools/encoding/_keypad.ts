/**
 * Phone keypad helpers for the phone-keypad tool: multi-tap (222 = C), T9 (one key per letter)
 * and vanity numbers (FLOWERS = 3569377). Letters are lower case inside this module; the tool
 * applies the "Case" option at the very end.
 */
import { ToolError } from '../../core/errors';
import { toolT } from '../../i18n/tool-text';
import { foldAccents, readability, wordRank, wordSplit, type Lang } from '../../lib/readability';
import { EN_WORDS } from '../../lib/wordlists/en';
import { FR_WORDS } from '../../lib/wordlists/fr';

const T = toolT('phone-keypad');

export type Separator = 'auto' | 'dash' | 'space' | 'comma' | 'pipe' | 'none';
export type SepKind = 'dash' | 'space' | 'comma' | 'pipe' | 'slash';
export type CaseMode = 'upper' | 'lower';

/** The standard keypad (ITU E.161). Key 1 has no letters and 0 is the space. */
export const KEYPAD: Readonly<Record<string, string>> = {
  '2': 'abc',
  '3': 'def',
  '4': 'ghi',
  '5': 'jkl',
  '6': 'mno',
  '7': 'pqrs',
  '8': 'tuv',
  '9': 'wxyz',
};

const KEY_OF = new Map<string, { key: string; presses: number }>();
for (const [key, letters] of Object.entries(KEYPAD)) {
  [...letters].forEach((letter, i) => KEY_OF.set(letter, { key, presses: i + 1 }));
}

export const applyCase = (text: string, mode: CaseMode): string =>
  mode === 'lower' ? text.toLowerCase() : text.toUpperCase();

/** The a-z letters a character stands for ("é" → "e", "ß" → "ss"), or '' when it has none. */
function lettersOf(ch: string): string {
  const folded = foldAccents(ch);
  return /^[a-z]+$/.test(folded) ? folded : '';
}

const clip = (s: string, max = 12): string => (s.length > max ? `${s.slice(0, max)}…` : s);

// ---------------------------------------------------------------------------------------------
// Encode: text → multi-tap and T9

const SEPARATOR_STRING: Record<Separator, string> = {
  auto: ' ',
  space: ' ',
  dash: '-',
  comma: ',',
  pipe: '|',
  none: '',
};

export interface Encoded {
  multitap: string;
  t9: string;
  /** Letters that were encoded. */
  letters: number;
  /** Characters with no letter on the keypad (digits, punctuation…), each listed once. */
  skipped: string[];
  /** Two neighbouring letters sit on the same key: unreadable without a separator. */
  sameKey: boolean;
}

/**
 * HELLO → "44 33 555 555 666" (multi-tap) and "43556" (T9). Words are joined with the 0 key.
 * Accents are dropped (é = E); anything that is not a letter or a space is skipped.
 */
export function encodeText(input: string, separator: Separator): Encoded {
  const words: string[][] = [[]];
  const skipped: string[] = [];
  for (const ch of input) {
    if (/\s/.test(ch)) {
      if (words[words.length - 1]!.length) words.push([]);
      continue;
    }
    const letters = lettersOf(ch);
    if (!letters) {
      if (!skipped.includes(ch)) skipped.push(ch);
      continue;
    }
    words[words.length - 1]!.push(...letters);
  }
  const used = words.filter((w) => w.length);
  const groups: string[] = [];
  let sameKey = false;
  used.forEach((word, i) => {
    if (i) groups.push('0');
    let previous = '';
    for (const letter of word) {
      const { key, presses } = KEY_OF.get(letter)!;
      if (key === previous) sameKey = true;
      previous = key;
      groups.push(key.repeat(presses));
    }
  });
  return {
    multitap: groups.join(SEPARATOR_STRING[separator]),
    t9: used.map((word) => word.map((l) => KEY_OF.get(l)!.key).join('')).join(' 0 '),
    letters: used.reduce((sum, w) => sum + w.length, 0),
    skipped,
    sameKey,
  };
}

/** Vanity numbers: letters become keys, everything else is kept (1-800-FLOWERS → 1-800-3569377). */
export function lettersToDigits(input: string): { text: string; converted: number } {
  let text = '';
  let converted = 0;
  for (const ch of input) {
    const letters = lettersOf(ch);
    if (!letters) {
      text += ch;
      continue;
    }
    for (const letter of letters) text += KEY_OF.get(letter)!.key;
    converted += letters.length;
  }
  return { text, converted };
}

// ---------------------------------------------------------------------------------------------
// Decode: checking the characters

const DASHES = /[‐‑‒–—―−]/g;
const SEPARATOR_CHAR = /[\s\-,|/]/;
const SINGLE_KEY = /^([0-9])\1*$/;

function kindOf(ch: string): SepKind | null {
  if (ch === '-') return 'dash';
  if (ch === ',') return 'comma';
  if (ch === '|') return 'pipe';
  if (ch === '/') return 'slash';
  return /\s/.test(ch) ? 'space' : null;
}

const KIND_ORDER: SepKind[] = ['dash', 'space', 'comma', 'pipe', 'slash'];

/** Which separators the text uses, in a fixed order. */
function separatorKinds(s: string): SepKind[] {
  const found = new Set<SepKind>();
  for (const ch of s) {
    const kind = kindOf(ch);
    if (kind) found.add(kind);
  }
  return KIND_ORDER.filter((k) => found.has(k));
}

/** Translated name of a separator ("dash"), for notes and errors. */
export function separatorName(kind: SepKind): string {
  switch (kind) {
    case 'dash':
      return T('sep.dash');
    case 'space':
      return T('sep.space');
    case 'comma':
      return T('sep.comma');
    case 'pipe':
      return T('sep.pipe');
    case 'slash':
      return T('sep.slash');
  }
}

/** Throws a ToolError on the first character that is neither a key (2-9, 0) nor allowed. */
function checkKeys(s: string, allowed: RegExp): void {
  let pos = 0;
  for (const ch of s) {
    pos++;
    if (/[02-9]/.test(ch) || allowed.test(ch)) continue;
    if (ch === '1') throw new ToolError(T('error.keyOne', { pos }));
    throw new ToolError(T('error.notKeypad', { char: ch, pos }));
  }
}

// ---------------------------------------------------------------------------------------------
// Decode: multi-tap

export interface Reading {
  text: string;
  /** Readability 0..100 (see lib/readability). */
  score: number;
  lang: Lang | null;
}

export interface MultitapDecoded {
  /** The decoded text: the best reading when the splits had to be ranked. */
  text: string;
  /** Letter separators found in the input (separated input only). */
  separators: SepKind[];
  /** Groups with more presses than their key has letters; they wrap around like on a phone. */
  wraps: { count: number; example: string } | null;
  /** Ranked readings, best first, when the input had no separators (more than one reading). */
  readings: Reading[] | null;
  /** Number of ways to split the input into letters (saturates at 1e12). */
  total: number;
  /** Too many splits to try all of them: only a dictionary search was made. */
  capped: boolean;
  /** The groups mixed several keys, so separators were read as word breaks. */
  wordBreaks: boolean;
  /** Part of the best reading is not made of known words: the ranking is a guess. */
  weak: boolean;
}

/** Most splits of one word that are tried one by one. */
export const ENUM_CAP = 3000;
/** Most letters (candidates × length) that all the tries of one decoding may add up to. */
export const WORK_CAP = 60_000;
const TOP_READINGS = 10;
const HUGE = 1e12;

/** Number of ways to write `n` presses of a key with `size` letters as groups of 1..size. */
function countSplits(n: number, size: number): number {
  const counts = [1];
  for (let m = 1; m <= n; m++) {
    let sum = 0;
    for (let p = 1; p <= Math.min(size, m); p++) sum += counts[m - p]!;
    counts[m] = Math.min(HUGE, sum);
  }
  return counts[n]!;
}

/** Every letter string that `n` presses of a key can spell (key 5, n = 3: L, KJ, JK, JJJ). */
function allSplits(letters: string, n: number): string[] {
  const memo: string[][] = [['']];
  for (let m = 1; m <= n; m++) {
    const out: string[] = [];
    for (let p = 1; p <= Math.min(letters.length, m); p++) {
      for (const rest of memo[m - p]!) out.push(letters[p - 1]! + rest);
    }
    memo[m] = out;
  }
  return memo[n]!;
}

/** One group per letter: n presses of a key pick its nth letter, wrapping around past the last. */
function decodeGroups(groups: string[]): { text: string; wraps: MultitapDecoded['wraps'] } {
  let text = '';
  let count = 0;
  let example = '';
  for (const group of groups) {
    if (group[0] === '0') {
      if (text && !text.endsWith(' ')) text += ' ';
      continue;
    }
    const letters = KEYPAD[group[0]!]!;
    const letter = letters[(group.length - 1) % letters.length]!;
    if (group.length > letters.length) {
      if (!count) example = `${clip(group)} → ${letter.toUpperCase()}`;
      count++;
    }
    text += letter;
  }
  return { text: text.trimEnd(), wraps: count ? { count, example } : null };
}

const SPLITTERS: Record<'dash' | 'space' | 'comma' | 'pipe', RegExp> = {
  dash: /\s*-\s*/,
  space: /\s+/,
  comma: /\s*,\s*/,
  pipe: /\s*\|\s*/,
};

/**
 * Multi-tap: a group of n presses of one key is that key's nth letter (222 = C, 7777 = S), 0 is a
 * space. Letters are separated by a dash, space, comma, | or / ("auto" finds out which); a group
 * longer than its key has letters wraps around (2222 = A). With no separator, every way to split
 * a run of one key into letters is ranked by how much it reads as French or English.
 */
export function decodeMultitap(input: string, separator: Separator): MultitapDecoded {
  const s = input.replace(DASHES, '-').trim();
  if (!s) throw new ToolError(T('error.empty'));
  checkKeys(s, SEPARATOR_CHAR);
  const found = separatorKinds(s);

  if (separator === 'none' || (separator === 'auto' && !found.length)) {
    return unseparated(s.split(/[^02-9]+/), found.length > 0);
  }

  let groups: string[];
  if (separator === 'auto') {
    groups = s.split(/[\s\-,|/]+/).filter(Boolean);
  } else {
    groups = s.split(SPLITTERS[separator]).filter(Boolean);
    for (const group of groups) {
      const stray = [...group].find((ch) => kindOf(ch));
      if (stray) {
        throw new ToolError(
          T('error.separator', {
            found: separatorName(kindOf(stray)!),
            sep: separatorName(separator),
          }),
        );
      }
    }
  }
  const mixed = groups.find((g) => !SINGLE_KEY.test(g));
  if (mixed !== undefined) {
    if (separator === 'auto') return unseparated(groups, true);
    throw new ToolError(
      T('error.mixedGroup', { group: clip(mixed), sep: separatorName(separator) }),
    );
  }
  const { text, wraps } = decodeGroups(groups);
  if (!text) throw new ToolError(T('error.onlySpaces'));
  return {
    text,
    separators: separator === 'auto' ? found : [separator],
    wraps,
    readings: null,
    total: 1,
    capped: false,
    wordBreaks: false,
    weak: false,
  };
}

function unseparated(parts: string[], wordBreaks: boolean): MultitapDecoded {
  const words = parts.join('0').split(/0+/).filter(Boolean);
  if (!words.length) throw new ToolError(T('error.onlySpaces'));
  const ranked = rankSplits(words);
  return {
    text: ranked.readings[0]!.text,
    separators: [],
    wraps: null,
    readings: ranked.readings.length > 1 ? ranked.readings : null,
    total: ranked.total,
    capped: ranked.capped,
    wordBreaks,
    weak: ranked.weak,
  };
}

interface Ranked {
  text: string;
  /** Higher is more likely (see rankKey). */
  key: number;
  /** The text is made of known words only. */
  full: boolean;
}

const FULL_BONUS = 100;
/** Readability below this is noise (letters that happen to contain a short word). */
const NOISE = 10;
/** Rank of a word that is a valid form but not in the frequency list (plural, conjugation). */
const UNLISTED_RANK = 3000;

/**
 * How likely a run of letters is the intended text. A text that splits entirely into French or
 * English words scores 100 + how unlikely that is by chance (bits, which grows with the length
 * of the words) − half the cost of the words themselves (rare words cost more). Anything else
 * scores its readability / 10, below every full match. On words from the lists (all split by
 * phone key, no separator) this puts the intended word first about 99 times in 100; the readability
 * score alone puts it first 2 times in 3 ("secret" loses to "sea a app pet").
 */
function rankKey(text: string): Ranked {
  const split = wordSplit(text);
  if (!split) {
    const score = readability(text).score;
    return { text, key: score >= NOISE ? score / 10 : 0, full: false };
  }
  // "a a a" or "i a" is not a reading: single letters split off anything.
  if (split.words.every((w) => w.length === 1)) return { text, key: 0, full: false };
  let cost = 0;
  for (const word of split.words) {
    for (const part of word.split("'")) {
      cost += wordCost(wordRank(part, split.lang) ?? UNLISTED_RANK, part.length);
    }
  }
  return { text, key: FULL_BONUS + split.bits - cost / 2, full: true };
}

/** Best first; on equal keys the reading with fewer letters (longer groups), then A-Z. */
const byKey = (a: Ranked, b: Ranked): number =>
  b.key - a.key || a.text.length - b.text.length || (a.text < b.text ? -1 : 1);

function displayReading(text: string): Reading {
  const r = readability(text);
  return { text, score: r.score, lang: r.score > 0 ? r.lang : null };
}

/**
 * The 0 key is a space, so the words of the input (digit strings without 0) are independent:
 * each is solved on its own and the phrase is the best reading of every word. A word is solved
 * exhaustively (every split of every run of one key, ranked by rankKey) while that stays small;
 * a bigger one is capped and gets the most word-like reading of a dictionary search instead.
 */
function rankSplits(words: string[]): {
  readings: Reading[];
  total: number;
  capped: boolean;
  weak: boolean;
} {
  let budget = WORK_CAP;
  let total = 1;
  let capped = false;
  const keep = words.length === 1 ? TOP_READINGS : 3;
  const solved = words.map((word): Ranked[] => {
    const slots: string[][] = [];
    let count = 1;
    for (const run of word.match(/([2-9])\1*/g) ?? []) {
      const letters = KEYPAD[run[0]!]!;
      count = Math.min(HUGE, count * countSplits(run.length, letters.length));
      // Lists are only built when they will be used: their size is bounded by `count`.
      slots.push(count <= ENUM_CAP ? allSplits(letters, run.length) : []);
    }
    total = Math.min(HUGE, total * count);
    if (count > ENUM_CAP || count * word.length > budget) {
      capped = true;
      return [rankKey(bestParse(word))];
    }
    budget -= count * word.length;
    let texts = [''];
    let fixed = '';
    for (const options of slots) {
      if (options.length === 1) {
        fixed += options[0];
        continue;
      }
      texts = texts.flatMap((t) => options.map((o) => t + fixed + o));
      fixed = '';
    }
    return texts
      .map((t) => rankKey(t + fixed))
      .sort(byKey)
      .slice(0, keep);
  });

  // The best phrase, and the phrases that change one word to its next best readings.
  const best = solved.map((ranked) => ranked[0]!);
  const bestKey = best.reduce((sum, r) => sum + r.key, 0);
  const phrases: Ranked[] = [{ text: best.map((r) => r.text).join(' '), key: bestKey, full: true }];
  solved.forEach((ranked, i) => {
    for (const alt of ranked.slice(1)) {
      phrases.push({
        text: best.map((r, k) => (k === i ? alt : r).text).join(' '),
        key: bestKey - best[i]!.key + alt.key,
        full: true,
      });
    }
  });
  phrases.sort(byKey);
  return {
    readings: phrases.slice(0, TOP_READINGS).map((p) => displayReading(p.text)),
    total,
    capped,
    weak: best.some((r) => !r.full),
  };
}

// ---------------------------------------------------------------------------------------------
// Dictionary search for inputs with too many splits

const UNKNOWN_COST = 10;
/** Same shape as the cost readability's word segmentation uses: frequent words are cheap. */
const wordCost = (rank: number, len: number): number =>
  Math.log(rank + 2) + 4 + (len === 1 ? 2.5 : 0);

interface CodeIndex {
  /** Multi-tap digits of a word (hello → 44 33 555 555 666 without gaps) → cheapest word. */
  words: Map<string, { word: string; cost: number }>;
  maxLen: number;
}
let codeCache: CodeIndex | null = null;

function multitapCode(word: string): string {
  let code = '';
  for (const letter of word) {
    const { key, presses } = KEY_OF.get(letter)!;
    code += key.repeat(presses);
  }
  return code;
}

function codeIndex(): CodeIndex {
  if (codeCache) return codeCache;
  const words = new Map<string, { word: string; cost: number }>();
  let maxLen = 1;
  for (const list of [EN_WORDS, FR_WORDS]) {
    let rank = 0;
    for (const raw of list.split(/\s+/)) {
      if (!raw) continue;
      const folded = foldAccents(raw);
      const r = rank++;
      if (!/^[a-z]+$/.test(folded) || folded.length > 20) continue;
      const code = multitapCode(folded);
      const cost = wordCost(r, folded.length);
      const known = words.get(code);
      if (!known || cost < known.cost) words.set(code, { word: folded, cost });
      if (code.length > maxLen) maxLen = code.length;
    }
  }
  codeCache = { words, maxLen };
  return codeCache;
}

/**
 * Cheapest way to read the digits (keys 2-9, no 0) as words of the two word lists, where letters
 * that fit no word cost more, in O(length × longest word). Words are joined without spaces.
 */
function bestParse(d: string): string {
  const { words: index, maxLen } = codeIndex();
  const n = d.length;
  const run = new Int32Array(n + 1);
  for (let i = n - 1; i >= 0; i--) run[i] = d[i + 1] === d[i] ? run[i + 1]! + 1 : 1;
  const cost = new Float64Array(n + 1).fill(Infinity);
  const from = new Int32Array(n + 1);
  const piece = new Array<string>(n + 1).fill('');
  cost[0] = 0;
  const relax = (to: number, c: number, at: number, text: string) => {
    if (c >= cost[to]!) return;
    cost[to] = c;
    from[to] = at;
    piece[to] = text;
  };
  for (let i = 0; i < n; i++) {
    const base = cost[i]!;
    const letters = KEYPAD[d[i]!]!;
    for (let k = 1; k <= Math.min(letters.length, run[i]!); k++) {
      relax(i + k, base + UNKNOWN_COST, i, letters[k - 1]!);
    }
    for (let j = i + 1; j <= Math.min(n, i + maxLen); j++) {
      const hit = index.get(d.slice(i, j));
      if (hit) relax(j, base + hit.cost, i, hit.word);
    }
  }
  const out: string[] = [];
  for (let j = n; j > 0; j = from[j]!) out.push(piece[j]!);
  return out.reverse().join('');
}

// ---------------------------------------------------------------------------------------------
// T9

export interface T9Token {
  /** The keys of the word (43556). */
  keys: string;
  /** Matching words of the French and English lists, most likely first (accents kept). */
  words: string[];
}

export interface T9Decoded {
  tokens: T9Token[];
  /** The word picked for each token; the letters of each key, in brackets, when none matched. */
  chosen: string[];
  text: string;
  /** Tokens (counted with repeats) that no word matches. */
  unknown: number;
}

interface T9Entry {
  word: string;
  /** Position in its list divided by the list length: comparable across languages. */
  rank: number;
}

let t9Cache: Map<string, T9Entry[]> | null = null;

function t9Index(): Map<string, T9Entry[]> {
  if (t9Cache) return t9Cache;
  const best = new Map<string, { keys: string; rank: number }>();
  for (const list of [EN_WORDS, FR_WORDS]) {
    const items = list.split(/\s+/).filter(Boolean);
    items.forEach((raw, i) => {
      const word = raw.toLowerCase();
      const folded = foldAccents(word);
      if (!/^[a-z]+$/.test(folded)) return;
      const rank = i / items.length;
      const known = best.get(word);
      if (!known || rank < known.rank) {
        best.set(word, { keys: [...folded].map((l) => KEY_OF.get(l)!.key).join(''), rank });
      }
    });
  }
  const index = new Map<string, T9Entry[]>();
  for (const [word, { keys, rank }] of best) {
    const bucket = index.get(keys);
    if (bucket) bucket.push({ word, rank });
    else index.set(keys, [{ word, rank }]);
  }
  for (const bucket of index.values()) {
    bucket.sort((a, b) => a.rank - b.rank || (a.word < b.word ? -1 : 1));
  }
  t9Cache = index;
  return index;
}

/** Words per ambiguous token weighed against their neighbours: the widest that keeps the combinations few. */
const PHRASE_WIDTHS = [4, 3, 2];
const PHRASE_COMBOS = 1024;
/** A phrase must read this many points better (of 100) to override the frequency order. */
const PHRASE_MARGIN = 10;

/**
 * Picks one word per token. Most frequent first, unless another combination of the likeliest
 * words reads better as a phrase (the same keys spell "good", "home", "gone"…).
 */
function pickWords(tokens: T9Token[]): string[] {
  const choice = tokens.map(() => 0);
  const open = tokens.flatMap((t, i) => (t.words.length > 1 ? [i] : []));
  const width = PHRASE_WIDTHS.find(
    (w) => open.reduce((p, i) => p * Math.min(w, tokens[i]!.words.length), 1) <= PHRASE_COMBOS,
  );
  if (width !== undefined) {
    const sizes = open.map((i) => Math.min(width, tokens[i]!.words.length));
    const phrase = () =>
      tokens
        .map((t, i) => t.words[choice[i]!])
        .filter(Boolean)
        .join(' ');
    const base = readability(phrase()).score;
    let top = base;
    let topChoice = [...choice];
    const counter = open.map(() => 0);
    for (;;) {
      let k = 0;
      while (k < open.length && ++counter[k]! === sizes[k]) counter[k++] = 0;
      if (k === open.length) break;
      open.forEach((tokenIndex, j) => (choice[tokenIndex] = counter[j]!));
      const score = readability(phrase()).score;
      if (score > top && score > base + PHRASE_MARGIN) {
        top = score;
        topChoice = [...choice];
      }
    }
    topChoice.forEach((c, i) => (choice[i] = c));
  }
  return tokens.map((t, i) =>
    t.words.length
      ? t.words[choice[i]!]!
      : [...t.keys].map((digit) => `[${KEYPAD[digit]}]`).join(''),
  );
}

/**
 * T9 predictive text: one key per letter, words separated by 0 or spaces. Each word is looked up
 * in the French and English word lists the readability score uses.
 */
export function decodeT9(input: string): T9Decoded {
  const s = input.trim();
  if (!s) throw new ToolError(T('error.empty'));
  checkKeys(s, /[\s/|,]/);
  const keys = s.split(/[\s0/|,]+/).filter(Boolean);
  if (!keys.length) throw new ToolError(T('error.onlySpaces'));
  const index = t9Index();
  const tokens = keys.map((k) => ({ keys: k, words: (index.get(k) ?? []).map((e) => e.word) }));
  const chosen = pickWords(tokens);
  return {
    tokens,
    chosen,
    text: chosen.join(' '),
    unknown: tokens.filter((t) => !t.words.length).length,
  };
}
