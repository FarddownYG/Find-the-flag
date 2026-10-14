/**
 * Shared pieces of the text analyzer: pass and candidate types, text helpers, the cached
 * readability scorer and the ranking that decides which pass outputs stand out.
 *
 * Ranking is relative to the input: a pass whose output merely re-reads the input (every other
 * line, the words in reverse order, a cipher that changed almost nothing) inherits the input's
 * readability and is discounted, the untouched input itself is never ranked, and very short
 * outputs must score higher to count.
 */
import { DEFAULT_FLAG_PATTERN } from '../../core/flags';
import { toolT } from '../../i18n/tool-text';
import {
  foldAccents,
  phraseFit,
  readability,
  wordRank,
  wordSplit,
  type Lang,
  type Readability,
} from '../../lib/readability';
import { flagForm } from '../crypto/_classical';

const T = toolT('text-analyzer');

export type Family = 'acrostic' | 'structure' | 'invisible' | 'encoding' | 'cipher';

/**
 * How a pass builds its output, which decides what it can inherit from the input:
 * - select: picks letters or words of the input (acrostics); words are expected to exist;
 * - reorder: the input's own words in another order (odd lines, reversed word order…);
 * - transform: the input rewritten (ciphers, leet, entities): words it keeps are inherited;
 * - payload: data decoded from marks or tokens, unrelated to the visible words.
 */
export type Mode = 'select' | 'reorder' | 'transform' | 'payload';

export interface Pass {
  family: Family;
  label: string;
  /** The pass output, or null when the pass does not apply to this text. */
  result: string | null;
  /** Detail of the reading (offset, key, scheme), or why the pass does not apply. */
  note: string;
  mode: Mode;
  /** Score multiplier; above 1 for the canonical techniques, below for chained guesses. */
  prior?: number;
  /**
   * What a selecting pass picks: whole words (always dictionary words, so only a phrase that
   * holds together counts) or letters (a word they spell is the evidence).
   */
  pick?: 'words' | 'letters';
  /** Word picks: share of the input's words the pass picked (a list read back is no message). */
  share?: number;
  /**
   * Passes that keep the best of many tries (offsets, keys, columns): marginFactor() of the
   * best try against the best different one. Chance makes one of many tries look good; a real
   * hit stands out of the rest.
   */
  margin?: number;
  /**
   * Passes that weigh themselves against the input (a line order, a reversal): 0..1, how much
   * better the reading fits than the text as written. It replaces what the reading would
   * inherit from the input: the score is its readability times this.
   */
  evidence?: number;
  /**
   * Letter picks: how many similar readings were tried along with this one (the four nth
   * letters of each line, the offsets of every Nth character…). The more tries, the more one
   * of them spells words by chance.
   */
  tries?: number;
}

export interface Scored {
  pass: Pass;
  result: string;
  /** Final score 0..100 used for ranking. */
  score: number;
  /** readability() of the output (or of its decoded reading), before any adjustment. */
  raw: number;
  lang: Lang | null;
  /** How the output reads when it differs from the output itself (segmented, leet decoded). */
  reading: string | null;
  /** Position of the pass in the run, for stable tie-breaking. */
  order: number;
}

/** Scores at or above this are highlighted as "stands out". */
export const STRONG = 55;
/** Only this many characters of a candidate are scored (keeps long inputs linear)… */
const SCORE_PREFIX = 3000;
/** … and of a candidate without spaces, which is split into words letter by letter. */
const SPACELESS_PREFIX = 1000;
/** The input's own words and word pairs are collected from this many characters. */
const BASELINE_SCOPE = 100_000;

// ---------------------------------------------------------------------------------------------
// Text helpers

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
/** Words: letters and digits, with inner apostrophes (l’honneur); hyphens split words. */
const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}\p{M}]*(?:['’][\p{L}\p{N}][\p{L}\p{N}\p{M}]*)*/gu;

export const isLetterOrDigit = (ch: string): boolean => LETTER_OR_DIGIT.test(ch);

export function wordsOf(text: string): string[] {
  return text.match(WORD_RE) ?? [];
}

/** Letters and digits of a string, one entry per code point. */
export function lettersOf(text: string): string[] {
  return Array.from(text).filter(isLetterOrDigit);
}

/** Lower case, no accents, only a-z and 0-9: the form results are compared in. */
export function foldKey(text: string): string {
  return foldAccents(text).replace(/[^a-z0-9]/g, '');
}

/** Folded words (a-z runs) in reading order. */
function foldedWords(text: string): string[] {
  return foldAccents(text).match(/[a-z0-9]+/g) ?? [];
}

/** 1st, 2nd, 3rd, 4th… 11th, 12th, 13th… 21st. */
export function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}

/**
 * A pass label with an ordinal ("Every 3rd character"). English writes the ordinal ({nth});
 * the other languages place the number themselves ({count}, plural forms).
 */
export const nthLabel = (key: string, n: number): string => T(key, { count: n, nth: ordinal(n) });

/** The facts of one note, listed ("12 lines, they rhyme"); empty parts are left out. */
export const joinNotes = (...parts: (string | false | null | undefined)[]): string =>
  parts.filter((p): p is string => !!p).join(T('text.listSep'));

/** The suffix of a note on a pass that reads only the start of the text (", first 4000 characters"). */
export const cutNote = (max: number): string => T('text.listSep') + T('note.firstChars', { max });

/** One line for a table cell: line breaks shown as " / ", cut after `max` characters. */
export function oneLine(text: string, max = 160): string {
  const flat = text.replace(/\r?\n/g, ' / ').replace(/\t/g, ' ');
  const chars = Array.from(flat);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : flat;
}

// ---------------------------------------------------------------------------------------------
// Leet speak

const LEET: Record<string, string> = {
  '0': 'o',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '8': 'b',
  '9': 'g',
  '@': 'a',
  $: 's',
};
/** A run of letters, digits and leet symbols: what leet speak is undone in. */
const LEET_WORD = /[\p{L}\p{N}@$]+/gu;
/** prefix{…}: flags are kept exactly as written, never "read" as leet. */
const FLAG_SPAN = /[A-Za-z][A-Za-z0-9_]{0,15}\{[^{}\n]{0,200}\}/g;

/** True when some word mixes letters with leet digits (fl4g, h3ll0); flags count if asked. */
export const hasLeet = (text: string, flags = false): boolean =>
  /\p{L}[0-9@$]|[0-9@$]\p{L}/u.test(flags ? text : text.replace(FLAG_SPAN, ' '));

const isKnownWord = (w: string) =>
  w.length >= 2 && (wordRank(w, 'en') !== null || wordRank(w, 'fr') !== null);

/**
 * One token with leet undone, or the token itself. A token that becomes a dictionary word is
 * always read (7h3 → the, m47 → mat; 15 → is only among other leet words). Otherwise only
 * words that mix letters and digits are, and kept as they are: words with a digit that has no
 * letter meaning (the 6 of "0x6c"), more digits than letters (the "11T08" of a timestamp, the
 * "9a47" of a UUID) and hex identifiers (c4d1e9b3). "1" is ambiguous: `one` says i or l.
 */
function deleetToken(token: string, one: 'i' | 'l', leetAround: boolean): string {
  const chars = Array.from(token);
  const isDigit = (ch: string) => /[0-9@$]/.test(ch);
  const digits = chars.filter(isDigit).length;
  if (!digits) return token;
  if (chars.some((ch) => isDigit(ch) && ch !== '1' && LEET[ch] === undefined)) return token;
  const read = chars.map((ch) => (ch === '1' ? one : (LEET[ch] ?? ch))).join('');
  if (isKnownWord(read.toLowerCase()) && (digits < chars.length || leetAround)) return read;
  if (digits === chars.length || digits > chars.length - digits) return token;
  if (chars.length >= 6 && /^[0-9a-f]+$/i.test(token)) return token;
  return read;
}

/**
 * Whether the text really is written in leet: some word mixing letters and digits reads as a
 * dictionary word once decoded (h1dd3n, p455w0rd). Timestamps and ids (11T08, 9a47) do not.
 */
function writtenInLeet(text: string, one: 'i' | 'l'): boolean {
  for (const m of text.replace(FLAG_SPAN, ' ').matchAll(LEET_WORD)) {
    const w = m[0];
    if (!/\p{L}/u.test(w) || !/[0-9@$]/.test(w)) continue;
    if (deleetToken(w, one, false) !== w && isKnownWord(deleetToken(w, one, false).toLowerCase())) {
      return true;
    }
  }
  return false;
}

/**
 * Undo leet speak, word by word (see deleetToken). Flags are left as they are, unless
 * `flags` (to score how a flag reads, never to show it).
 */
export function deleet(text: string, one: 'i' | 'l' = 'i', flags = false): string {
  const leetAround = writtenInLeet(text, one);
  if (flags) return text.replace(LEET_WORD, (t) => deleetToken(t, one, leetAround));
  let out = '';
  let last = 0;
  for (const m of text.matchAll(FLAG_SPAN)) {
    out += text.slice(last, m.index).replace(LEET_WORD, (t) => deleetToken(t, one, leetAround));
    out += m[0];
    last = m.index + m[0].length;
  }
  return out + text.slice(last).replace(LEET_WORD, (t) => deleetToken(t, one, leetAround));
}

/**
 * The leet phrases of a text, decoded: runs of words that leet changed (with short plain words
 * between them, "m33t m3 at th3 p4rk"), and how much of the text they make.
 */
export function leetPhrases(text: string, one: 'i' | 'l'): { phrases: string[]; share: number } {
  const leetAround = writtenInLeet(text, one);
  const words = [...text.replace(FLAG_SPAN, ' ').matchAll(LEET_WORD)].map((m) => m[0]);
  const read = words.map((w) => deleetToken(w, one, leetAround));
  const phrases: string[] = [];
  let run: string[] = [];
  let pending: string[] = [];
  let changed = 0;
  words.forEach((w, i) => {
    if (read[i] !== w) {
      changed++;
      run.push(...pending, read[i]!);
      pending = [];
    } else if (run.length && w.length <= 3 && pending.length < 1) pending.push(w);
    else {
      if (run.length) phrases.push(run.join(' '));
      run = [];
      pending = [];
    }
  });
  if (run.length) phrases.push(run.join(' '));
  return { phrases, share: words.length ? changed / words.length : 0 };
}

// ---------------------------------------------------------------------------------------------
// Scoring

export interface Reading {
  r: Readability;
  /** The text that was actually scored, when it is not the candidate itself. */
  reading: string | null;
  /** The reading undoes leet speak. */
  leet: boolean;
}

export interface Scorer {
  /** readability() of a text (prefix only), cached for the whole run. */
  read(text: string): Readability;
  /** Best reading of a candidate: as is, with leet speak undone, or FLAGXYZ as flag{xyz}. */
  reading(text: string): Reading;
}

export function makeScorer(): Scorer {
  const cache = new Map<string, Readability>();
  const read = (text: string): Readability => {
    const max = /\s/.test(text.slice(0, 200)) ? SCORE_PREFIX : SPACELESS_PREFIX;
    const key = text.length > max ? text.slice(0, max) : text;
    let r = cache.get(key);
    if (!r) {
      r = readability(key);
      cache.set(key, r);
    }
    return r;
  };
  return {
    read,
    reading(full) {
      const plain = read(full);
      let best: Reading = { r: plain, reading: plain.segmented, leet: false };
      // Only the scored prefix matters (a leet reading of a long text is cut to it too).
      const text = full.length > SCORE_PREFIX ? full.slice(0, SCORE_PREFIX) : full;
      const alternatives: [string, boolean][] = [];
      // Inside flags too: flag{1nv1s1bl3_1nk} reads as words. The reading is not shown then
      // (see shownReading): a flag must be displayed exactly as decoded.
      if (hasLeet(text, true)) {
        alternatives.push([deleet(text, 'i', true), true], [deleet(text, 'l', true), true]);
      }
      // Letter-only decoders (Bacon, Polybius, acrostics) cannot write the braces.
      const flag = /^[A-Za-z]+$/.test(text) ? flagForm(text) : null;
      if (flag) alternatives.push([flag, false]);
      for (const [alt, leet] of alternatives) {
        const r = read(alt);
        if (r.score > best.r.score) best = { r, reading: r.segmented ?? alt, leet };
      }
      return best;
    },
  };
}

export interface Picked<T> {
  best: T;
  score: number;
  /** Score of the best option that reads differently (0 when there is none). */
  runnerUp: number;
  /** marginFactor(score, runnerUp). */
  margin: number;
}

/**
 * The most readable of several candidate texts (ties keep the first), skipping empty ones and
 * any equal to `avoid` (a foldKey). `rate` replaces plain readability when given.
 */
export function pickBest<T extends { text: string }>(
  options: T[],
  scorer: Scorer,
  avoid = '',
  rate: (text: string) => number = (t) => scorer.reading(t).r.score,
): Picked<T> | null {
  const rated: { o: T; s: number; key: string }[] = [];
  for (const o of options) {
    if (!o.text.trim()) continue;
    const key = foldKey(o.text);
    if (avoid && key === avoid) continue;
    rated.push({ o, s: rate(o.text), key });
  }
  let top: { o: T; s: number; key: string } | null = null;
  for (const r of rated) if (!top || r.s > top.s) top = r;
  if (!top) return null;
  let runnerUp = 0;
  for (const r of rated) if (r.key !== top.key && r.s > runnerUp) runnerUp = r.s;
  return { best: top.o, score: top.s, runnerUp, margin: marginFactor(top.s, runnerUp) };
}

/**
 * Score multiplier of a best-of-many pass: 1 when the best try stands far above the others,
 * down to 0.3 when another try reads almost as well (chance at work).
 */
export function marginFactor(best: number, runnerUp: number): number {
  if (best <= 0) return 1;
  return Math.max(0.3, Math.min(1, 1 - (0.65 * runnerUp) / best));
}

/**
 * How much a run of picked words says (first word of each line…). Every pick is a dictionary
 * word, so what counts is whether the words form a phrase: classes that follow each other
 * (cette → nuit, not le → dans → et), set phrases, content words, and enough of them. A list
 * read back (the first word of one-to-three-word lines) is not a message.
 */
export function wordPickFactor(r: Readability, words: number, share: number): number {
  let f = 0.15 + 0.85 * phraseFit(r.coherence) ** 1.5;
  // Word classes only rule out the worst runs: words picked at random from verse or prose fit
  // together surprisingly often. A real message nearly always holds a set phrase.
  if (words <= 2) f *= r.attested ? 1.12 : 0.72;
  else if (words === 3) f *= r.attested ? 1.1 : 0.75;
  else f *= r.attested ? 0.96 + 0.04 * Math.min(3, r.attested) : 0.65;
  // Function words alone ("Dans Le Nous Bien") never make a message.
  if (!r.content) f *= 0.4;
  else if (r.stopwordShare >= 0.9) f *= 0.4;
  else if (r.stopwordShare > 0.75) f *= 0.7;
  if (share > 0.2) f *= Math.max(0.3, 1 - (share - 0.2) * 2.5);
  return f;
}

/**
 * Letters picked from a text that split entirely into words ("northgate", "hidethekeys"):
 * the score this alone deserves, from how unlikely such a split is by chance (wordSplit()),
 * less what the number of tries buys, plus set phrases and words that follow each other.
 * Seven bits or more stand out.
 */
function letterSplitFloor(text: string, r: Readability, tries: number): number {
  // Two or three letters spell a word too easily to count at all.
  if (!/^[a-z]{4,}$/.test(foldAccents(text))) return 0;
  const split = wordSplit(text);
  if (!split) return 0;
  // Words that follow each other say more the more joins there are; rare words make a
  // message less likely (chance picks any word, a message the usual ones).
  const joins = Math.min(1, (split.words.length - 1) / 2);
  let rare = 0;
  for (const w of split.words) {
    const rank = wordRank(w.replace(/'/g, ''), split.lang) ?? 0;
    rare += Math.max(0, Math.log2(rank + 1) - 10) / 2;
  }
  const bits =
    split.bits -
    Math.log2(Math.max(1, tries)) +
    3 * Math.min(2, r.attested) +
    4 * (phraseFit(r.coherence) - 0.5) * joins -
    rare;
  return bits < 3 ? 0 : Math.max(0, Math.min(90, 55 + 7 * (bits - 7)));
}

/** What a candidate is compared against. */
export interface Baseline {
  /** The visible input itself. */
  text: string;
  /** foldKey() of the input: an output equal to it is the input itself. */
  key: string;
  /** readability() of the input as written. */
  score: number;
  /** readability() of the input with leet speak undone (= score when there is none). */
  leetScore: number;
  /** Unordered pairs of adjacent words of the input ("a|b" with a <= b). */
  pairs: Set<string>;
  words: Set<string>;
}

const pairKey = (a: string, b: string) => (a <= b ? `${a}|${b}` : `${b}|${a}`);

export function baselineOf(text: string, scorer: Scorer): Baseline {
  const pairs = new Set<string>();
  const words = new Set<string>();
  // The passes read the start of a very long text: its words are what they can inherit.
  const head = text.length > BASELINE_SCOPE ? text.slice(0, BASELINE_SCOPE) : text;
  // Words written in leet (h1dd3n) are the input's words too once decoded.
  const readings = hasLeet(head) ? [head, deleet(head, 'i'), deleet(head, 'l')] : [head];
  for (const reading of readings) {
    const list = foldedWords(reading);
    for (let i = 1; i < list.length; i++) pairs.add(pairKey(list[i - 1]!, list[i]!));
    for (const w of list) if (w.length >= 2) words.add(w);
  }
  const score = scorer.read(text).score;
  const leetScore = Math.max(score, scorer.reading(text).r.score);
  return { text, key: foldKey(text), score, leetScore, pairs, words };
}

/**
 * Share (0..1) of the candidate's readability that comes from the input: adjacent word pairs
 * that are already adjacent in the input, and words of the input. Selecting passes (acrostics)
 * pick words from different places, so neither applies to them.
 */
function inherited(candidate: string, mode: Mode, base: Baseline): number {
  if (mode === 'select' || mode === 'payload') return 0;
  const words = foldedWords(candidate);
  let pairShare = 0;
  if (words.length >= 2) {
    let found = 0;
    for (let i = 1; i < words.length; i++) {
      if (base.pairs.has(pairKey(words[i - 1]!, words[i]!))) found++;
    }
    pairShare = found / (words.length - 1);
  }
  const long = words.filter((w) => w.length >= 2);
  const wordShare = long.length ? long.filter((w) => base.words.has(w)).length / long.length : 0;
  return Math.max(pairShare, wordShare);
}

/** Share of letters left in place above which a cipher output counts as the input itself. */
const NEAR_INPUT = 0.7;

/**
 * A cipher output that leaves most letters where they were (a Vigenère key of nearly all A, a
 * substitution that swapped two letters) is the input with typos, not a decoding.
 */
export function nearInput(pass: Pass, inputText: string): boolean {
  if (pass.family !== 'cipher' || pass.mode !== 'transform' || pass.result === null) return false;
  const out = foldAccents(pass.result).replace(/[^a-z]/g, '');
  if (out.length < 12) return false;
  const input = foldAccents(inputText.slice(0, pass.result.length * 2)).replace(/[^a-z]/g, '');
  if (input.length < out.length) return false;
  let same = 0;
  for (let i = 0; i < out.length; i++) if (out[i] === input[i]) same++;
  return same >= NEAR_INPUT * out.length;
}

const FLAG = new RegExp(DEFAULT_FLAG_PATTERN, 'g');
const KNOWN_FLAG = /^(?:flag|ctf|[a-z0-9]*ctf|htb|thm|key|secret)\{/i;

/**
 * A flag with a well-known prefix (flag{…}, CTF{…}, HTB{…}) that the pass produced and the
 * input does not show: the strongest sign there is, even when its words are not in the
 * dictionaries. Other prefix{…} shapes are left to readability (transpositions make them).
 * When the input already shows that prefix (a "format is CTF{...}" placeholder), a rewritten
 * copy of it ("CTF{:::}") is not new: only one with real content is.
 */
function newFlag(texts: (string | null)[], base: Baseline): boolean {
  const shown = base.text.toLowerCase();
  for (const t of texts) {
    if (!t) continue;
    for (const m of t.matchAll(FLAG)) {
      if (!KNOWN_FLAG.test(m[0]) || base.text.includes(m[0])) continue;
      const brace = m[0].indexOf('{');
      const prefix = m[0].slice(0, brace + 1).toLowerCase();
      const content = (m[0].slice(brace + 1).match(/[A-Za-z0-9]/g) ?? []).length;
      if (!shown.includes(prefix) || content >= 4) return true;
    }
  }
  return false;
}

/**
 * The reading to show next to a result, or null: never one that rewrites a flag (the leet of
 * flag{1nv1s1bl3_1nk} is part of the flag a CTF expects).
 */
function shownReading(result: string, reading: string | null): string | null {
  if (reading === null || reading === result) return null;
  for (const m of result.matchAll(FLAG_SPAN)) if (!reading.includes(m[0])) return null;
  return reading;
}

/** Score one pass output against the input. */
export function scorePass(
  pass: Pass,
  order: number,
  base: Baseline,
  scorer: Scorer,
): Scored | null {
  if (pass.result === null) return null;
  const key = foldKey(pass.result);
  if (!key) return null;
  const { r, reading, leet } = scorer.reading(pass.result);
  let score = r.score;
  if (key === base.key || nearInput(pass, base.text)) score = 0;
  else if (pass.evidence !== undefined) score *= pass.evidence;
  else {
    const share = inherited(reading ?? pass.result, pass.mode, base);
    // What the pass inherited counts for little; doing better than the input still counts
    // (against the input's leet-decoded reading when this output needed leet undone too).
    const before = leet ? base.leetScore : base.score;
    score = score * (1 - 0.9 * share) + share * Math.max(0, r.score - before);
  }
  // A handful of letters can spell a word by chance: short outputs need more evidence.
  const shown = reading ?? pass.result;
  const letters = foldKey(shown).length;
  if (letters < 8) score *= ((letters + 2) / 10) ** (letters < 4 ? 2 : 1);
  if (pass.pick === 'words') {
    score *= wordPickFactor(r, foldedWords(shown).length, pass.share ?? 0);
  }
  score *= pass.margin ?? 1;
  // The best of many tries reads well by chance more often (every 9th character, all 18
  // offsets): the more tries, the less a merely readable best one says.
  score /= 1 + 0.12 * Math.log2(Math.max(1, pass.tries ?? 1));
  // "no no no no…" is not a message: real text rarely repeats a few words over and over.
  const words = foldedWords(shown);
  if (words.length >= 6) {
    const variety = new Set(words).size / words.length;
    if (variety < 0.3) score *= variety / 0.3;
  }
  score *= pass.prior ?? 1;
  // Letters picked from the text, or decoded from marks or symbols (Bacon), that split into
  // words. Not the rewrites that weigh themselves against the input (leet, keyboard layouts).
  const letterLike =
    pass.pick === 'letters' || (pass.mode === 'payload' && pass.evidence === undefined);
  if (letterLike && key !== base.key && !/\s/.test(pass.result.trim())) {
    // The tries are counted in bits, so the margin (best try against the others) is not.
    score = Math.max(score, letterSplitFloor(pass.result, r, pass.tries ?? 1));
  }
  if (newFlag([pass.result, reading], base)) score = Math.max(score, 75 + 0.25 * r.score);
  score = Math.min(100, score);
  return {
    pass,
    result: pass.result,
    score: Math.round(score * 10) / 10,
    raw: r.score,
    lang: r.lang,
    reading: shownReading(pass.result, reading),
    order,
  };
}

/** Best first; identical outputs (accents, case and spacing ignored) are listed once. */
export function rankScored(list: Scored[], baseKey: string): Scored[] {
  const sorted = list
    .filter((s) => s.score > 0 && foldKey(s.result) !== baseKey)
    .sort((a, b) => b.score - a.score || a.order - b.order);
  const seen = new Set<string>();
  const out: Scored[] = [];
  for (const s of sorted) {
    const key = foldKey(s.result);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

const LANG_NAMES: Record<Lang, () => string> = {
  en: () => T('value.lang.en'),
  fr: () => T('value.lang.fr'),
};
export const langName = (lang: Lang): string => LANG_NAMES[lang]();
