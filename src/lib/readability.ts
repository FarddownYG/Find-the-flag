/**
 * "Does this string look like real words?" — a French + English readability score used to rank
 * candidate decodings (acrostics, Caesar shifts, base-N outputs…). It does not understand text:
 * it measures how much of it is made of dictionary words, how frequent those words are, whether
 * function words appear in a natural proportion, whether neighbouring words can follow each
 * other (word classes, set phrases) and whether the letters follow the language's distribution.
 * Pure and deterministic; dictionaries are built lazily on first use.
 *
 * Not to be confused with the zero-width tool's own `readability()` in
 * tools/stego/_zerowidth.ts, a cheaper English-only check that tool uses to order its decodings.
 */
import { EN_COLLOCATIONS, FR_COLLOCATIONS } from './wordlists/collocations';
import { EN_WORDS } from './wordlists/en';
import { FR_WORDS } from './wordlists/fr';

export type Lang = 'en' | 'fr';

export interface Readability {
  /** 0..100, higher = more like real text. Comparable across candidates. */
  score: number;
  /** Best-scoring language, or null when nothing in the input looks like a word. */
  lang: Lang | null;
  /** Folded tokens in reading order (after segmentation); unknown stretches are kept as-is. */
  words: string[];
  /**
   * Share of letters that sit inside known words (0..1). Words recognised only through an
   * inflection rule or as the other language count slightly less.
   */
  coverage: number;
  /** Share of tokens that are function words (articles, pronouns, auxiliaries…). */
  stopwordShare: number;
  /** The segmented reading when spaceless input was split into words, else null. */
  segmented: string | null;
  /**
   * 0..1: how well neighbouring words fit by grammatical class ("cette nuit", "meet me at" fit;
   * "le dans et" does not). 1 for fewer than two words. See phraseFit().
   */
  coherence: number;
  /** Neighbouring word pairs that are a known collocation with a content word (cette nuit). */
  attested: number;
  /** Known words that are not function words. */
  content: number;
}

const NON_ASCII = /[^\t\n\r -~]/;

/** Lowercase, strip accents (é→e), expand ligatures (œ→oe, æ→ae) and normalise apostrophes. */
export function foldAccents(s: string): string {
  if (!NON_ASCII.test(s)) return s.toLowerCase().replace(/`/g, "'");
  return s
    .toLowerCase()
    .replace(/œ/g, 'oe')
    .replace(/æ/g, 'ae')
    .replace(/ß/g, 'ss')
    .replace(/ø/g, 'o')
    .replace(/ł/g, 'l')
    .replace(/đ/g, 'd')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[’‘ʼ`´]/g, "'");
}

// ---------------------------------------------------------------------------------------------
// Dictionaries

/** Letter frequencies a..z in percent; French is accent-folded (é, è, ê count as e). */
const LETTER_FREQ: Record<Lang, number[]> = {
  en: [
    8.2, 1.5, 2.8, 4.3, 12.7, 2.2, 2.0, 6.1, 7.0, 0.15, 0.77, 4.0, 2.4, 6.7, 7.5, 1.9, 0.095, 6.0,
    6.3, 9.1, 2.8, 0.98, 2.4, 0.15, 2.0, 0.074,
  ],
  fr: [
    8.1, 0.93, 3.2, 3.6, 16.7, 1.1, 1.0, 0.85, 7.3, 0.6, 0.07, 5.5, 2.9, 7.1, 5.4, 2.8, 1.2, 6.6,
    7.9, 7.0, 6.1, 1.6, 0.1, 0.4, 0.3, 0.15,
  ],
};

/** Letter frequencies a..z of a language, in percent (French accents folded). */
export function letterFrequencies(lang: Lang): number[] {
  return [...LETTER_FREQ[lang]];
}

/** Function words (accent-folded). Natural prose has 30–55 % of its tokens in these lists. */
const STOPWORDS: Record<Lang, string> = {
  en: `the a an of to in and or but nor is are was were be been being am i you he she it we they me
    him her us them my your his its our their this that these those there here what which who whom
    whose when where why how not no so as at by for from with on into onto about than then if do
    does did have has had will would shall should can could may might must just also very all any
    some each every both only own same too up out over under again once s t m re ve ll d don didn
    doesn isn wasn aren weren haven hasn hadn won wouldn couldn shouldn`,
  fr: `le la les un une des du de au aux ce cet cette ces ca cela ceci mon ma mes ton ta tes son sa ses
    notre nos votre vos leur leurs je me moi tu te toi il elle on nous vous ils elles se soi lui eux
    y en que qui quoi dont ou quand comme si ne pas plus et mais donc or ni car a dans par pour sur
    sous avec sans chez vers entre est sont ete etre ai as avons avez ont avait etait suis es
    sommes etes etaient avaient sera tout tous toute toutes tres bien aussi meme quel quelle quels
    quelles celui celle ceux celles l d j m n s t c qu jusqu lorsqu puisqu quelqu`,
};

const wordSet = (list: string) => new Set(list.split(/\s+/).filter(Boolean));

/** French elided forms written before an apostrophe (l'honneur, qu'un, jusqu'à). */
const FR_ELIDED = wordSet('l d j m n s t c qu jusqu lorsqu puisqu quoiqu quelqu presqu');
/** English contraction halves: the part after the apostrophe (it's, we're) … */
const EN_AFTER_APOS = wordSet('s t m re ve ll d');
/** … and negative stems before it (don't, isn't). */
const EN_BEFORE_APOS = wordSet(
  'don doesn didn isn aren wasn weren haven hasn hadn won wouldn couldn shouldn mustn needn ain can',
);

/** `suffix:replacement` rewrites tried on unknown words: plurals, conjugations, -ly… */
const rules = (list: string): [string, string][] =>
  list.split(' ').map((r) => [r.slice(0, r.indexOf(':')), r.slice(r.indexOf(':') + 1)]);
const MORPH: Record<Lang, [string, string][]> = {
  en: rules('s: es: ies:y ied:y ed: ed:e d: ing: ing:e ly: ily:y er: est: ers: ness: ment:'),
  fr: rules(
    's: x: e: es: e:er es:er ent:er ons:er ez:er ait:er ais:er aient:er ee:er ees:er es:e ement:e ment:',
  ),
};

interface Dict {
  rank: Map<string, number>;
  size: number;
  logSize: number;
  maxLen: number;
  stop: Set<string>;
  /** Expected letter probabilities a..z, floored so one rare letter cannot dominate. */
  letterP: number[];
  /** The words as a trie over a..z, for segmentation (built on demand). */
  trie: Trie | null;
  /** morphRank() results already computed. */
  morph: Map<string, number | null>;
  /** log2 P(next letter | letter) over a..z plus a word boundary (index 26), built on demand. */
  bigram: Float64Array | null;
}

/**
 * Trie over a..z in flat arrays: `next[node * 26 + letter]` is the child (0 = none, the root is
 * node 0 and is never a child) and `rank[node]` the word's rank (-1 when no word ends there).
 */
interface Trie {
  next: Int32Array;
  rank: Int32Array;
  /** Parent node and the letter (0..25) leading to each node; a child comes after its parent. */
  parent: Int32Array;
  letter: Uint8Array;
  depth: Uint8Array;
  /** Nodes in use. */
  size: number;
}

function buildTrie(words: Map<string, number>): Trie {
  let nodes = 1;
  for (const w of words.keys()) nodes += w.length;
  const next = new Int32Array(nodes * 26);
  const rank = new Int32Array(nodes).fill(-1);
  const parent = new Int32Array(nodes);
  const letter = new Uint8Array(nodes);
  const depth = new Uint8Array(nodes);
  let used = 1;
  for (const [w, r] of words) {
    if (!/^[a-z]+$/.test(w)) continue;
    let node = 0;
    for (let i = 0; i < w.length; i++) {
      const c = w.charCodeAt(i) - 97;
      const slot = node * 26 + c;
      if (!next[slot]) {
        next[slot] = used;
        parent[used] = node;
        letter[used] = c;
        depth[used] = Math.min(255, i + 1);
        used++;
      }
      node = next[slot]!;
    }
    if (rank[node] === -1 || r < rank[node]!) rank[node] = r;
  }
  return { next, rank, parent, letter, depth, size: used };
}

const dicts: Partial<Record<Lang, Dict>> = {};

function dict(lang: Lang): Dict {
  const cached = dicts[lang];
  if (cached) return cached;
  const rank = new Map<string, number>();
  let position = 0;
  let maxLen = 1;
  for (const raw of (lang === 'en' ? EN_WORDS : FR_WORDS).split(/\s+/)) {
    if (!raw) continue;
    const w = foldAccents(raw);
    if (!rank.has(w)) rank.set(w, position);
    if (w.length > maxLen) maxLen = w.length;
    position++;
  }
  const freq = LETTER_FREQ[lang].map((p) => Math.max(p, 0.3));
  const total = freq.reduce((a, b) => a + b, 0);
  const built: Dict = {
    rank,
    size: position,
    logSize: Math.log(position + 1),
    maxLen,
    stop: wordSet(STOPWORDS[lang]),
    letterP: freq.map((p) => p / total),
    trie: null,
    morph: new Map(),
    bigram: null,
  };
  dicts[lang] = built;
  return built;
}

function trieOf(d: Dict): Trie {
  d.trie ??= buildTrie(d.rank);
  return d.trie;
}

const BOUNDARY = 26;

/** Letter-pair model of the word list: which letter tends to follow which, and at word edges. */
function bigramOf(d: Dict): Float64Array {
  if (d.bigram) return d.bigram;
  const counts = new Float64Array(27 * 27).fill(0.5);
  for (const w of d.rank.keys()) {
    if (!/^[a-z]+$/.test(w)) continue;
    let prev = BOUNDARY;
    for (let i = 0; i <= w.length; i++) {
      const next = i < w.length ? w.charCodeAt(i) - 97 : BOUNDARY;
      counts[prev * 27 + next]!++;
      prev = next;
    }
  }
  const model = new Float64Array(27 * 27);
  for (let a = 0; a < 27; a++) {
    let row = 0;
    for (let b = 0; b < 27; b++) row += counts[a * 27 + b]!;
    for (let b = 0; b < 27; b++) model[a * 27 + b] = Math.log2(counts[a * 27 + b]! / row);
  }
  d.bigram = model;
  return model;
}

/** Mean bits per letter pair of random letters and of ordinary words under bigramOf(). */
const LIKENESS_RANDOM = -5.2;
const LIKENESS_TYPICAL = -3.6;

/**
 * 0..1: how much an unknown word looks like a word of the language, from its letter pairs
 * ("paillasson", "fuyez" look French; "qzvk", "xkcq" do not). Mean log-probability of each
 * letter given the previous one (word edges included), mapped from random-looking to typical.
 */
export function wordLikeness(word: string, lang: Lang): number {
  const w = foldAccents(word).replace(/[^a-z]/g, '');
  if (w.length < 3) return 0;
  const model = bigramOf(dict(lang));
  let prev = BOUNDARY;
  let sum = 0;
  for (let i = 0; i <= w.length; i++) {
    const next = i < w.length ? w.charCodeAt(i) - 97 : BOUNDARY;
    sum += model[prev * 27 + next]!;
    prev = next;
  }
  const mean = sum / (w.length + 1);
  return Math.max(0, Math.min(1, (mean - LIKENESS_RANDOM) / (LIKENESS_TYPICAL - LIKENESS_RANDOM)));
}

/** A function word (article, pronoun, preposition, auxiliary…) of French or English. */
export function isFunctionWord(word: string): boolean {
  const w = foldAccents(word);
  return dict('fr').stop.has(w) || dict('en').stop.has(w);
}

/** Frequency rank of a word in the language's list (0 = most frequent), accents ignored. */
export function wordRank(word: string, lang: Lang): number | null {
  return dict(lang).rank.get(foldAccents(word)) ?? null;
}

/** Rank of an unknown word through simple suffix rewrites (plurals, conjugations, -ly…). */
function morphRank(w: string, lang: Lang): number | null {
  const d = dict(lang);
  const known = d.morph.get(w);
  if (known !== undefined) return known;
  const r = computeMorphRank(w, d, lang);
  // Bounded memo: unknown words repeat across the candidates of one analysis.
  if (d.morph.size > 50_000) d.morph.clear();
  d.morph.set(w, r);
  return r;
}

function computeMorphRank(w: string, d: Dict, lang: Lang): number | null {
  let best: number | null = null;
  for (const [suffix, repl] of MORPH[lang]) {
    if (w.length - suffix.length < 3 || !w.endsWith(suffix)) continue;
    const stem = w.slice(0, w.length - suffix.length);
    const candidates = [stem + repl];
    // stopped → stopp → stop, running → runn → run
    if (repl === '' && stem.length > 3 && stem[stem.length - 1] === stem[stem.length - 2])
      candidates.push(stem.slice(0, -1));
    for (const c of candidates) {
      const r = d.rank.get(c);
      if (r !== undefined && (best === null || r < best)) best = r;
    }
  }
  return best === null ? null : Math.round(best * 1.5 + 300);
}

// ---------------------------------------------------------------------------------------------
// Segmentation

const UNKNOWN_COST = 10;
const WORD_COST = 4;
const VOWEL_OR_H = /[aeiouyh]/;
const FR_SEG_CLITICS = ['l', 'd', 'j', 'm', 'n', 's', 't', 'c', 'qu'];
/** Words that never follow an elided clitic ("jetaime" is je t'aime, not j'et aime). */
const NOT_AFTER_CLITIC = wordSet('et ou oui onze huit haut hors');

interface Piece {
  text: string;
  known: boolean;
  rank: number;
  stop: boolean;
  /** French elided clitic (l', d'…): rendered glued to the next piece. */
  clitic: boolean;
  /** Second half of a compound (peut-être, it's): one word with the previous piece. */
  join?: boolean;
  /** Unfolded lowercase spelling, when the piece is a whole input token. */
  raw?: string;
  /** A word of another language inside this one: its grammatical class comes from there. */
  foreign?: Lang;
}

function wordCost(rank: number, len: number): number {
  return Math.log(rank + 2) + WORD_COST + (len === 1 ? 2.5 : 0);
}

/**
 * Inflections segmentation accepts: `suffix:replacement` with the letters the stem must end
 * with ('' = any). Stricter than MORPH: inside a run of letters, a loose rule invents words
 * ("dug" + "ed").
 */
const SEG_MORPH: Record<Lang, [string, string, RegExp][]> = {
  en: [
    ['s', '', /[^s]$/],
    ['es', '', /(?:s|x|z|ch|sh)$/],
    ['ed', '', /[a-z]{3}[^aeiouy]$/],
    ['ing', '', /[a-z]{3}[^aeiouy]$/],
  ],
  fr: [
    ['s', '', /[^sxz]$/],
    ['x', '', /(?:au|eu)$/],
    ['e', '', /[^e]$/],
    ['es', '', /[^e]$/],
    ['ez', 'er', /./],
    ['ee', 'er', /./],
    ['ees', 'er', /./],
  ],
};

/** Rank of the word reached from trie `node` by the letters of `rest`, or -1. */
function rankAfter(trie: Trie, node: number, rest: string): number {
  let at = node;
  for (let k = 0; k < rest.length; k++) {
    at = trie.next[at * 26 + rest.charCodeAt(k) - 97]!;
    if (!at) return -1;
  }
  return trie.rank[at]!;
}

/**
 * Dynamic programming over positions: O(n · maxWordLen) dictionary lookups. Inflected forms
 * (keys, cachez, cachée) are words too, through the same suffix rules as morphRank().
 */
function segmentPieces(s: string, lang: Lang): Piece[] {
  const d = dict(lang);
  const trie = trieOf(d);
  const rules = SEG_MORPH[lang];
  const suffixStarts = new Set(rules.map(([suffix]) => suffix.charCodeAt(0)));
  const n = s.length;
  const cost = new Float64Array(n + 1).fill(Infinity);
  const from = new Int32Array(n + 1);
  // Where the word starts when the step is "French clitic + word" (l'honneur), else -1.
  const mid = new Int32Array(n + 1).fill(-1);
  // 0 = the step is one unknown letter, 1 = a word
  const isWord = new Uint8Array(n + 1);
  // Frequency rank of the word the step ends with.
  const wordRankAt = new Float64Array(n + 1);
  cost[0] = 0;
  const relax = (to: number, c: number, at: number, rank: number, split: number) => {
    if (c >= cost[to]!) return;
    cost[to] = c;
    from[to] = at;
    isWord[to] = rank >= 0 ? 1 : 0;
    wordRankAt[to] = rank;
    mid[to] = split;
  };
  // Visits every dictionary word (or inflected form) starting at `i` with its end and rank.
  const wordsAt = (i: number, afterClitic: boolean, visit: (end: number, rank: number) => void) => {
    let node = 0;
    for (let j = i; j < n; j++) {
      const letter = s.charCodeAt(j) - 97;
      if (letter < 0 || letter > 25) break;
      node = trie.next[node * 26 + letter]!;
      if (!node) break;
      const len = j + 1 - i;
      if (len >= 3 && j + 1 < n && suffixStarts.has(s.charCodeAt(j + 1))) {
        for (const [suffix, repl, stem] of rules) {
          if (j + 1 + suffix.length > n || !s.startsWith(suffix, j + 1)) continue;
          const r = repl ? rankAfter(trie, node, repl) : trie.rank[node]!;
          if (r < 0 || !stem.test(s.slice(Math.max(i, j - 3), j + 1))) continue;
          visit(j + 1 + suffix.length, Math.round(r * 1.5 + 300));
        }
      }
      const r = trie.rank[node]!;
      if (r < 0) continue;
      if (afterClitic && NOT_AFTER_CLITIC.has(s.slice(i, j + 1))) continue;
      visit(j + 1, r);
    }
  };
  for (let i = 0; i < n; i++) {
    const base = cost[i]!;
    if (base === Infinity) continue;
    relax(i + 1, base + UNKNOWN_COST, i, -1, -1);
    wordsAt(i, false, (end, r) => relax(end, base + wordCost(r, end - i), i, r, -1));
    if (lang !== 'fr') continue;
    for (const cl of FR_SEG_CLITICS) {
      const j = i + cl.length;
      if (j >= n || !s.startsWith(cl, i) || !VOWEL_OR_H.test(s[j]!)) continue;
      const clCost = wordCost(10, 2) + 1;
      wordsAt(j, true, (end, r) => relax(end, base + clCost + wordCost(r, end - j), i, r, j));
    }
  }
  const pieces: Piece[] = [];
  const word = (text: string, clitic: boolean, rank: number): Piece => ({
    text,
    known: true,
    rank: clitic ? 10 : rank,
    stop: clitic || d.stop.has(text),
    clitic,
  });
  let unknown = '';
  for (let j = n; j > 0; j = from[j]!) {
    const i = from[j]!;
    if (!isWord[j]) {
      unknown = s.slice(i, j) + unknown;
      continue;
    }
    if (unknown) {
      pieces.push({ text: unknown, known: false, rank: 0, stop: false, clitic: false });
      unknown = '';
    }
    const m = mid[j]!;
    const rank = wordRankAt[j]!;
    if (m < 0) pieces.push(word(s.slice(i, j), false, rank));
    else pieces.push(word(s.slice(m, j), false, rank), word(s.slice(i, m), true, rank));
  }
  if (unknown) pieces.push({ text: unknown, known: false, rank: 0, stop: false, clitic: false });
  return pieces.reverse();
}

/**
 * Split a run of letters with no spaces into dictionary words, preferring frequent words
 * ("CETTENUIT" → cette nuit). Unknown stretches are kept as their own pieces, so `words`
 * always spells the whole input; `coverage` is the share of letters inside known words.
 */
export function segmentWords(letters: string, lang: Lang): { words: string[]; coverage: number } {
  const s = foldAccents(letters).replace(/[^a-z]/g, '');
  if (!s) return { words: [], coverage: 0 };
  const pieces = segmentPieces(s, lang);
  const covered = pieces.reduce((a, p) => a + (p.known ? p.text.length : 0), 0);
  return { words: pieces.map((p) => p.text), coverage: covered / s.length };
}

/**
 * Chance that `len` random letters spell a word of the list, for each length: the sum of the
 * probabilities of its words of that length, under `letterP` (a..z). Inflected forms and
 * French elisions, which segmentation also accepts, add about half again.
 */
function wordChance(d: Dict, lang: Lang, letterP: number[]): number[] {
  // One pass over the trie: a node's probability is its parent's times its letter's.
  const trie = trieOf(d);
  const w = new Array<number>(d.maxLen + 1).fill(0);
  const p = new Float64Array(trie.size);
  p[0] = 1;
  for (let node = 1; node < trie.size; node++) {
    p[node] = p[trie.parent[node]!]! * letterP[trie.letter[node]!]!;
    if (trie.rank[node]! >= 0) w[trie.depth[node]!]! += p[node]!;
  }
  const extra = lang === 'fr' ? 1.8 : 1.5;
  return w.map((p, len) => (len >= 3 ? p * extra : p));
}

const log2Choose = (n: number, k: number): number => {
  let bits = 0;
  for (let i = 1; i <= k; i++) bits += Math.log2((n - k + i) / i);
  return bits;
};

export interface Split {
  /** The words, French elisions glued to the next word. */
  words: string[];
  lang: Lang;
  /**
   * How surprising it is that the letters split into words at all, in bits: minus the log of
   * the chance that random letters fill these word lengths (any arrangement of them). Picks
   * that read by chance stay under ~8 bits; "hidethekeys" is about 14.
   */
  bits: number;
}

/**
 * A run of letters that splits entirely into dictionary words, with how unlikely that is by
 * chance; null when some letters are left over. The language that gives the more surprising
 * split wins (one bit is taken off for having tried two).
 */
export function wordSplit(letters: string): Split | null {
  const s = foldAccents(letters).replace(/[^a-z]/g, '');
  if (s.length < 2 || s.length > 200) return null;
  let best: Split | null = null;
  for (const lang of ['fr', 'en'] as const) {
    const d = dict(lang);
    const pieces = segmentPieces(s, lang);
    if (pieces.some((p) => !p.known)) continue;
    const words: string[] = [];
    let glue = '';
    for (const p of pieces) {
      if (p.clitic) glue += `${p.text}'`;
      else {
        words.push(glue + p.text);
        glue = '';
      }
    }
    if (glue) words.push(glue.slice(0, -1));
    // Letters as likely as in the language, or as in the pick itself: a pick full of one
    // letter ("a a au au a") splits into words easily and proves nothing.
    const own = new Array<number>(26).fill(0);
    for (let i = 0; i < s.length; i++) own[s.charCodeAt(i) - 97]! += 1 / s.length;
    const chance = wordChance(
      d,
      lang,
      d.letterP.map((p, i) => (p + own[i]!) / 2),
    );
    let bits = log2Choose(s.length - 1, words.length - 1) * -1;
    for (const w of words) {
      const len = w.replace(/'/g, '').length;
      bits -= Math.log2(Math.max(1e-12, chance[Math.min(len, chance.length - 1)] ?? 1e-12));
    }
    bits -= 1;
    if (!best || bits > best.bits) best = { words, lang, bits };
  }
  return best;
}

function renderPieces(pieces: Piece[]): string {
  let out = '';
  pieces.forEach((p, k) => {
    out += p.clitic ? `${p.text}'` : p.text;
    if (k < pieces.length - 1 && !p.clitic) out += ' ';
  });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Tokenizer

interface Token {
  w: string;
  /** Lowercase before folding: "là" and "la" differ for grammar checks. */
  raw: string;
  /** Only a..z after folding (no other script, no digits). */
  latin: boolean;
  /** Followed by an apostrophe and a letter (l'…, don't). */
  elided: boolean;
  /** Preceded by a letter and an apostrophe (…'s, …'re). */
  afterApos: boolean;
  /** Preceded by a letter and a hyphen (peut-être, grand-mère). */
  hyphen: boolean;
}

const LETTER = /[\p{L}\p{M}]/u;
const LOWER = /\p{Ll}/u;
const UPPER = /\p{Lu}/u;
const CAMEL = /\p{Ll}\p{Lu}|\p{Lu}\p{Lu}\p{Ll}/u;

/** camelCase / PascalCase / XMLHttp boundaries; kept whole when a part would be too short. */
function splitCamel(run: string): string[] {
  if (!CAMEL.test(run)) return [run];
  const cuts: number[] = [];
  for (let i = 1; i < run.length; i++) {
    const a = run[i - 1]!;
    const b = run[i]!;
    const c = run[i + 1];
    if (LOWER.test(a) && UPPER.test(b)) cuts.push(i);
    else if (UPPER.test(a) && UPPER.test(b) && c !== undefined && LOWER.test(c)) cuts.push(i);
  }
  if (!cuts.length) return [run];
  const parts: string[] = [];
  let prev = 0;
  for (const cut of cuts) {
    parts.push(run.slice(prev, cut));
    prev = cut;
  }
  parts.push(run.slice(prev));
  // "TeSt" or "iPhone" is odd casing, not camelCase: keep it whole.
  if (parts.some((p, k) => p.length < (k ? 3 : 2))) return [run];
  // Letters picked from a text keep the case of their source ("AttacKatnoon": attack at noon,
  // with the K of a name): split only where the parts are words (userProfileService).
  const known = parts.reduce((sum, p) => sum + (isAnyWord(foldAccents(p)) ? p.length : 0), 0);
  return known * 2 >= run.length ? parts : [run];
}

/** A word of the French or English list, or an inflection of one. */
function isAnyWord(w: string): boolean {
  return (['en', 'fr'] as const).some((l) => dict(l).rank.has(w) || morphRank(w, l) !== null);
}

function tokenize(text: string): Token[] {
  const s = text.replace(/[’‘ʼ]/g, "'").replace(/aujourd'hui/giu, 'aujourdhui');
  const out: Token[] = [];
  for (const m of s.matchAll(/[\p{L}\p{M}]+/gu)) {
    const start = m.index;
    const end = start + m[0].length;
    const afterApos = start >= 2 && s[start - 1] === "'" && LETTER.test(s[start - 2]!);
    const elided = s[end] === "'" && end + 1 < s.length && LETTER.test(s[end + 1]!);
    const hyphen = start >= 2 && s[start - 1] === '-' && LETTER.test(s[start - 2]!);
    const parts = splitCamel(m[0]);
    parts.forEach((part, k) => {
      const w = foldAccents(part);
      out.push({
        w,
        raw: part.toLowerCase(),
        latin: /^[a-z]+$/.test(w),
        elided: elided && k === parts.length - 1,
        afterApos: afterApos && k === 0,
        hyphen: hyphen && k === 0,
      });
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Scoring

/** Rank of `w` among the other languages' words, if any (mixed FR/EN text). */
function foreignWord(
  w: string,
  others: Lang[],
): { rank: number; stop: boolean; lang: Lang } | null {
  for (const o of others) {
    const od = dict(o);
    const rank = od.rank.get(w) ?? morphRank(w, o);
    if (rank !== null) return { rank, stop: od.stop.has(w), lang: o };
  }
  return null;
}

/** Longest token that readability() tries to split into words (keeps huge inputs linear). */
const MAX_SEGMENT = 10_000;

/**
 * How much a segmented word of each length says: random letters split into "a", "do", "it"
 * easily, a word of four letters or more rarely appears by chance.
 */
const LONG_WEIGHT = [0, 0, 0.25, 0.6];
const longWeight = (len: number) => LONG_WEIGHT[len] ?? 1;

interface Resolved {
  pieces: Piece[];
  /** Letters inside known words, weighted. */
  covered: number;
  segmented: boolean;
  /** An unknown word that looks like one of the language (see wordLikeness): its share. */
  credit?: number;
}

/**
 * How much of a word missing from the lists still counts when it looks like a word of the
 * language: a rare noun ("paillasson") costs its sentence a little, not most of its score.
 */
const UNKNOWN_CREDIT = 0.7;

const unknownPiece = (text: string): Piece => ({
  text,
  known: false,
  rank: 0,
  stop: false,
  clitic: false,
});

/** Look one token up: exact word, inflection, other language, or split into words. */
function resolve(t: Token, lang: Lang, others: Lang[], single: boolean): Resolved {
  const d = dict(lang);
  const w = t.w;
  const one = (rank: number, stop: boolean, weight: number, extra?: Partial<Piece>): Resolved => ({
    pieces: [{ text: w, known: true, rank, stop, clitic: false, ...extra }],
    covered: w.length * weight,
    segmented: false,
  });
  if (!t.latin) return { pieces: [unknownPiece(w)], covered: 0, segmented: false };
  if (lang === 'fr' && t.elided && FR_ELIDED.has(w)) return one(2, true, 1, { clitic: true });
  if (lang === 'en' && t.afterApos && EN_AFTER_APOS.has(w)) return one(10, true, 1, { join: true });
  if (lang === 'en' && t.elided && EN_BEFORE_APOS.has(w)) return one(10, true, 1);
  const exact = d.rank.get(w);
  if (exact !== undefined) return one(exact, d.stop.has(w), 1, { raw: t.raw });
  const morph = morphRank(w, lang);
  if (morph !== null) return one(morph, false, 0.95);
  // A word of another language inside this one (mixed FR/EN text): covered, but rare.
  const foreign = w.length > 1 ? foreignWord(w, others) : null;
  if (foreign) {
    return one(foreign.rank + Math.round(d.size / 2), foreign.stop, 0.85, {
      foreign: foreign.lang,
    });
  }
  if ((w.length >= 6 || (single && w.length >= 2)) && w.length <= MAX_SEGMENT) {
    const pieces = segmentPieces(w, lang);
    const known = pieces.filter((p) => p.known);
    const covered = known.reduce((sum, p) => sum + p.text.length, 0);
    // Inside a sentence, an unknown word is split only into real words (lighthouse keeper),
    // not into fragments ("gather" is not "g at her").
    const long = known.reduce((sum, p) => sum + p.text.length * longWeight(p.text.length), 0);
    if (
      single ||
      (covered / w.length >= 0.8 && w.length / known.length >= 2.5 && long / w.length >= 0.6)
    )
      return { pieces, covered, segmented: true };
  }
  const credit = single ? 0 : w.length * UNKNOWN_CREDIT * wordLikeness(w, lang);
  return { pieces: [unknownPiece(w)], covered: 0, segmented: false, credit };
}

interface Analysis {
  pieces: Piece[];
  letters: number;
  /** Letters inside known words, weighted (foreign / inflected words count a bit less). */
  covered: number;
  segmented: boolean;
  segLetters: number;
  /** Letters of segmented tokens inside known words, weighted by word length (see LONG_WEIGHT). */
  segLong: number;
  /** Letters of unknown words that look like words of the language, weighted. */
  credit: number;
}

function analyse(tokens: Token[], lang: Lang, others: Lang[]): Analysis {
  const a: Analysis = {
    pieces: [],
    letters: 0,
    covered: 0,
    segmented: false,
    segLetters: 0,
    segLong: 0,
    credit: 0,
  };
  for (const t of tokens) {
    const r = resolve(t, lang, others, tokens.length === 1);
    a.letters += t.w.length;
    a.covered += r.covered;
    a.credit += r.credit ?? 0;
    r.pieces.forEach((p, k) => a.pieces.push(k === 0 && t.hyphen ? { ...p, join: true } : p));
    if (r.segmented) {
      a.segmented = true;
      a.segLetters += t.w.length;
      for (const p of r.pieces) if (p.known) a.segLong += p.text.length * longWeight(p.text.length);
    }
  }
  return a;
}

interface Unit {
  text: string;
  known: boolean;
  rank: number;
  stop: boolean;
  raw?: string;
  foreign?: Lang;
}

/**
 * Group pieces into words as a reader counts them: l'honneur, peut-être and it's are one word
 * each (the rarer half gives the rank; a function word only if every half is one).
 */
function toUnits(pieces: Piece[]): Unit[] {
  const out: Unit[] = [];
  let clitic: Piece | null = null;
  for (const p of pieces) {
    if (p.clitic) {
      clitic = p;
      continue;
    }
    const prev = out[out.length - 1];
    if (p.join && !clitic && prev?.known && p.known) {
      prev.text += `-${p.text}`;
      prev.rank = Math.max(prev.rank, p.rank);
      prev.stop = prev.stop && p.stop;
      prev.raw = undefined;
      continue;
    }
    const text = clitic ? `${clitic.text}'${p.text}` : p.text;
    out.push({
      text,
      known: p.known,
      rank: p.rank,
      stop: p.stop,
      raw: clitic ? undefined : p.raw,
      foreign: p.foreign,
    });
    clitic = null;
  }
  if (clitic) out.push({ text: clitic.text, known: true, rank: clitic.rank, stop: true });
  return out;
}

/**
 * Words a phrase cannot end on: articles, determiners, prepositions, conjunctions. French is
 * checked on the accented spelling (la / là, sur / sûr); without accents (segmented input) the
 * ambiguous ones are skipped.
 */
const DANGLING: Record<Lang, Set<string>> = {
  en: wordSet('the a an my your our their its of and or but nor into onto'),
  fr: wordSet(`le la les un une des du de au aux ce cet cette ces mon ma mes ton ta tes son sa ses
    notre votre nos vos leurs à dans par pour sur sous avec sans chez vers et mais car ni que ne se
    me te je très tres l d j m n s t c qu jusqu lorsqu puisqu quelqu`),
};
const FOLDED_AMBIGUOUS = wordSet('la a ou sur du des');
/** Determiners, and the function words that may still follow one (the same, la plus…). */
const DETERMINERS: Record<Lang, Set<string>> = {
  en: wordSet('the a an my your our their'),
  fr: wordSet('du au aux cet cette ces mon ma mes ton ta tes sa ses notre votre nos vos'),
};
const AFTER_DETERMINER = wordSet(
  'very same only own most so too all such plus meme tout toute tous toutes bien tres',
);

// ---------------------------------------------------------------------------------------------
// Phrase coherence: word classes and collocations

/**
 * Grammatical classes of the function words (accent-folded; a word may have several):
 * D determiner, P preposition, J conjunction, S subject pronoun, O object / clitic pronoun,
 * A auxiliary (be, have, will…), N negation, R relative / question word, Q quantifier (tout,
 * all: before a determiner, not after one). Every other known word is C (content), an unknown
 * one U.
 */
type WordClass = 'D' | 'P' | 'J' | 'S' | 'O' | 'A' | 'N' | 'R' | 'Q' | 'C' | 'U';

const CLASS_WORDS: Record<Lang, [WordClass, string][]> = {
  fr: [
    [
      'D',
      `le la les l un une des du au aux ce cet cette ces mon ma mes ton ta tes son sa ses notre nos
      votre vos leur leurs chaque quelques plusieurs aucun aucune`,
    ],
    [
      'P',
      `de d a dans par pour sur sous avec sans chez vers entre en contre depuis pendant avant apres
      jusqu jusque malgre selon parmi derriere devant pres envers`,
    ],
    ['J', 'et ou mais donc or ni car que qu quand comme si s lorsque lorsqu puisque puisqu parce'],
    ['S', 'je j tu il elle on nous vous ils elles ce c ca cela ceci'],
    ['O', 'me m te t se s le la les l lui leur y en moi toi soi eux nous vous'],
    [
      'A',
      `est sont ete etre ai as a avons avez ont avait avaient avais etait etaient etais suis es
      sommes etes sera serai seras serons serez seront serait seraient fut furent aura aurai auras
      aurons aurez auront aurait va vas vais allons allez vont`,
    ],
    ['N', 'ne n pas plus jamais rien guere'],
    ['R', 'qui que qu quoi dont ou lequel laquelle lesquels lesquelles quel quelle quels quelles'],
    ['Q', 'tout toute tous toutes'],
  ],
  en: [
    [
      'D',
      `the a an this that these those my your his her its our their every each some any no another
      either neither such`,
    ],
    [
      'P',
      `of to in on at by for from with into onto about over under after before between through
      without within during against among across behind beyond near off out up down upon around
      along toward towards since until till via per like than`,
    ],
    [
      'J',
      'and or but nor so yet if when as because while though although unless whether once that',
    ],
    ['S', 'i you he she it we they'],
    ['O', 'me him her us them you it myself yourself himself herself itself ourselves themselves'],
    [
      'A',
      `is are was were be been being am have has had having will would shall should can could may
      might must do does did s re ve ll d m don doesn didn isn aren wasn weren haven hasn hadn won
      wouldn couldn shouldn mustn needn ain`,
    ],
    ['N', 'not no never t'],
    ['R', 'who whom whose which what where why how that'],
    ['Q', 'all both half'],
  ],
};

const CLASS_ORDER: WordClass[] = ['D', 'P', 'J', 'S', 'O', 'A', 'N', 'R', 'Q', 'C', 'U'];
/**
 * How plausible it is for a word of class `row` to be followed by one of class `column`, 0..1,
 * in CLASS_ORDER. Content words (C) are not told apart (noun, verb, adjective), so C → C is
 * left at an uninformative 0.5.
 */
const TRANSITIONS: Record<WordClass, number[]> = {
  //   D     P     J     S     O     A     N     R     Q     C     U
  D: [0.0, 0.0, 0.0, 0.0, 0.0, 0.1, 0.0, 0.0, 0.0, 1.0, 0.4],
  P: [1.0, 0.25, 0.05, 0.35, 0.9, 0.1, 0.3, 0.5, 0.8, 0.9, 0.4],
  J: [1.0, 0.7, 0.1, 1.0, 0.6, 0.5, 0.7, 0.4, 0.8, 0.9, 0.4],
  S: [0.05, 0.1, 0.2, 0.05, 0.8, 1.0, 0.9, 0.15, 0.5, 0.9, 0.4],
  O: [0.5, 0.6, 0.5, 0.3, 0.4, 0.6, 0.4, 0.3, 0.5, 0.9, 0.4],
  A: [0.8, 0.6, 0.3, 0.5, 0.5, 0.7, 0.9, 0.4, 0.8, 1.0, 0.4],
  N: [0.6, 0.6, 0.3, 0.3, 0.7, 0.8, 0.5, 0.3, 0.6, 0.9, 0.4],
  R: [0.6, 0.4, 0.1, 0.9, 0.6, 0.8, 0.6, 0.1, 0.5, 0.8, 0.4],
  Q: [1.0, 0.5, 0.4, 0.5, 0.4, 0.5, 0.3, 0.3, 0.0, 0.8, 0.4],
  C: [0.8, 0.85, 0.8, 0.6, 0.7, 0.6, 0.4, 0.6, 0.6, 0.5, 0.4],
  U: [0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4],
};
/** How plausible it is for a phrase to end on a word of each class. */
const ENDING: Record<WordClass, number> = {
  D: 0,
  P: 0.15,
  J: 0.1,
  S: 0.3,
  O: 0.9,
  A: 0.5,
  N: 0.6,
  R: 0.4,
  Q: 0.7,
  C: 1,
  U: 0.6,
};

const classMaps: Partial<Record<Lang, Map<string, WordClass[]>>> = {};

function classMap(lang: Lang): Map<string, WordClass[]> {
  const cached = classMaps[lang];
  if (cached) return cached;
  const map = new Map<string, WordClass[]>();
  for (const [cls, list] of CLASS_WORDS[lang]) {
    for (const w of wordSet(list)) map.set(w, [...(map.get(w) ?? []), cls]);
  }
  classMaps[lang] = map;
  return map;
}

const collocationSets: Partial<Record<Lang, Set<string>>> = {};

/** Folded "first second" collocations of a language. */
export function collocations(lang: Lang): Set<string> {
  const cached = collocationSets[lang];
  if (cached) return cached;
  const set = new Set<string>();
  for (const entry of (lang === 'en' ? EN_COLLOCATIONS : FR_COLLOCATIONS).split(',')) {
    const words = foldAccents(entry).match(/[a-z]+/g);
    if (words?.length === 2) set.add(`${words[0]} ${words[1]}`);
  }
  collocationSets[lang] = set;
  return set;
}

/** Classes of one folded word part; `known` decides between content and unknown. */
function classesOf(part: string, known: boolean, lang: Lang): WordClass[] {
  return classMap(lang).get(part) ?? [known ? 'C' : 'U'];
}

export interface PhraseInfo {
  coherence: number;
  attested: number;
  content: number;
}

/**
 * Class-transition fit of a word sequence (mean plausibility of each neighbouring pair and of
 * the last word), the collocations it contains and its content words. Elided and hyphenated
 * words (l'honneur, voulez-vous) are read as their parts.
 */
function phraseOf(units: Unit[], lang: Lang): PhraseInfo {
  const colloc = collocations(lang);
  const parts = units.map((u) => u.text.split(/['-]/).filter(Boolean));
  const cls = units.map((u, i) => parts[i]!.map((p) => classesOf(p, u.known, u.foreign ?? lang)));
  let attested = 0;
  const isContent = (c: WordClass[]) => c.includes('C');
  // A collocation counts when one of its words is not a function word (a word missing from
  // the frequency list, like "trust" in "trust me", is not one either).
  const notFunction = (c: WordClass[]) => c.includes('C') || c.includes('U');
  const check = (a: string, ca: WordClass[], b: string, cb: WordClass[]) => {
    if ((notFunction(ca) || notFunction(cb)) && colloc.has(`${a} ${b}`)) attested++;
  };
  let content = 0;
  units.forEach((u, i) => {
    const p = parts[i]!;
    const c = cls[i]!;
    if (u.known && c.some(isContent)) content++;
    for (let k = 1; k < p.length; k++) check(p[k - 1]!, c[k - 1]!, p[k]!, c[k]!);
  });
  if (units.length < 2) return { coherence: 1, attested, content };
  const best = (from: WordClass[], to: WordClass[]) => {
    let top = 0;
    for (const a of from) {
      const row = TRANSITIONS[a];
      for (const b of to) top = Math.max(top, row[CLASS_ORDER.indexOf(b)]!);
    }
    return top;
  };
  let sum = 0;
  for (let i = 1; i < units.length; i++) {
    const pa = parts[i - 1]!;
    const pb = parts[i]!;
    const ca = cls[i - 1]!;
    const cb = cls[i]!;
    if (!pa.length || !pb.length) continue;
    const before = attested;
    check(pa[pa.length - 1]!, ca[ca.length - 1]!, pb[0]!, cb[0]!);
    // A known collocation ("send help") fits whatever the classes say.
    sum += attested > before ? 1 : best(ca[ca.length - 1]!, cb[0]!);
  }
  const last = cls[cls.length - 1]!;
  const ending = last.length ? Math.max(...last[last.length - 1]!.map((c) => ENDING[c])) : 1;
  return { coherence: (sum + ending) / units.length, attested, content };
}

/**
 * Collocations among the words as typed: a word the dictionary lacks may have been split into
 * pieces ("cimetière" → "ci metier e") that hide the pair "le cimetière".
 */
function typedCollocations(tokens: Token[], lang: Lang): number {
  const colloc = collocations(lang);
  const functionWord = classMap(lang);
  let n = 0;
  for (let i = 1; i < tokens.length; i++) {
    const a = tokens[i - 1]!.w;
    const b = tokens[i]!.w;
    if (colloc.has(`${a} ${b}`) && !(functionWord.has(a) && functionWord.has(b))) n++;
  }
  return n;
}

/** How plausible it is for a sentence to open on a word of each class. */
const OPENING: Record<WordClass, number> = {
  D: 1,
  P: 0.6,
  J: 0.5,
  S: 1,
  O: 0.5,
  A: 0.5,
  N: 0.5,
  R: 0.7,
  Q: 0.9,
  C: 0.8,
  U: 0.6,
};
/** English particles a phrase may end on (carry on, give up), though they are prepositions. */
const EN_PARTICLES = wordSet('on off up out in down over away back around along about');
const SENTENCE_END = /[.!?…]["'»”’)\]]*$/u;
const CLAUSE_END = /[,;:]["'»”’)\]]*$/u;

export interface OrderFit {
  /** 0..1: how naturally the chunks follow on from one another. */
  fit: number;
  /** Joins that say something about the order: not after a full stop or a paragraph break. */
  open: number;
  joins: number;
}

/**
 * How naturally a sequence of chunks (lines) follows on from one another, 0..1: the word
 * classes on both sides of each join, set phrases across a join, whether the first chunk can
 * open a sentence and the last one close it. A join after a full stop (or a chunk marked as
 * a paragraph end) fits any order and counts as `stop`. Readability barely depends on word
 * order; this does, so it tells "il faut / tout brûler / avant minuit" from the same lines
 * upside down.
 */
export function orderFit(
  chunks: string[],
  options: { stop?: number; paragraphEnds?: boolean[] } = {},
): OrderFit {
  const stop = options.stop ?? 0.85;
  const parts = chunks.map((c, i) => ({
    words: tokenize(c).map((t) => t.w),
    text: c.trim(),
    ends: SENTENCE_END.test(c.trim()) || options.paragraphEnds?.[i] === true,
  }));
  const used = parts.filter((p) => p.words.length);
  const joins = Math.max(0, used.length - 1);
  const open = used.slice(0, -1).filter((p) => !p.ends).length;
  if (used.length < 2) return { fit: 1, open, joins };
  let best = 0;
  for (const lang of ['fr', 'en'] as const) {
    const d = dict(lang);
    const colloc = collocations(lang);
    const cls = (w: string) => classesOf(w, d.rank.has(w) || morphRank(w, lang) !== null, lang);
    const top = (from: WordClass[], to: WordClass[]) => {
      let v = 0;
      for (const x of from)
        for (const y of to) v = Math.max(v, TRANSITIONS[x][CLASS_ORDER.indexOf(y)]!);
      return v;
    };
    let sum = Math.max(...cls(used[0]!.words[0]!).map((c) => OPENING[c]));
    for (let i = 1; i < used.length; i++) {
      const prev = used[i - 1]!;
      const x = prev.words[prev.words.length - 1]!;
      const y = used[i]!.words[0]!;
      if (prev.ends) sum += stop;
      else if (colloc.has(`${x} ${y}`)) sum += 1;
      else {
        const fit = top(cls(x), cls(y));
        sum += CLAUSE_END.test(prev.text) ? Math.max(fit, 0.7) : fit;
      }
    }
    const last = used[used.length - 1]!;
    const final = last.words[last.words.length - 1]!;
    // A text that ends its sentences with full stops ends with one too.
    const stops = used.some((p) => SENTENCE_END.test(p.text)) ? 0.8 : 1;
    const ending = last.ends
      ? 1
      : stops *
        (lang === 'en' && EN_PARTICLES.has(final)
          ? 0.8
          : Math.max(...cls(final).map((c) => ENDING[c])));
    sum += CLAUSE_END.test(last.text) ? Math.min(ending, 0.6) : ending;
    best = Math.max(best, sum / (used.length + 1));
  }
  return { fit: best, open, joins };
}

/**
 * Map a coherence value to 0..1: ordinary sentences sit around 0.75-0.9, a run of function
 * words ("le dans et") below 0.45.
 */
export function phraseFit(coherence: number): number {
  return Math.max(0, Math.min(1, (coherence - 0.45) / 0.4));
}

/**
 * Cheap grammar sanity for short phrases: a determiner followed by a function word
 * ("votre mais") or a phrase ending on a preposition ("faveur à") is not a sentence.
 */
function syntaxFactor(units: Unit[], lang: Lang): number {
  if (units.length < 2) return 1;
  let bad = 0;
  for (let i = 1; i < units.length; i++) {
    const a = units[i - 1]!;
    const b = units[i]!;
    if (DETERMINERS[lang].has(a.text) && b.stop && !AFTER_DETERMINER.has(b.text)) bad++;
  }
  let factor = 1 - 0.25 * Math.min(1, (4 * bad) / (units.length - 1));
  const last = units[units.length - 1]!;
  const dangling =
    last.raw !== undefined
      ? DANGLING[lang].has(last.raw)
      : DANGLING[lang].has(last.text) && !FOLDED_AMBIGUOUS.has(last.text);
  if (last.known && dangling) factor *= 1 - 0.25 * Math.min(1, 8 / units.length);
  return factor;
}

/** Letter-distribution fit 0..1 from a chi-squared distance, robust to short inputs. */
function letterFit(tokens: Token[], lang: Lang): number {
  const counts = new Array<number>(26).fill(0);
  let n = 0;
  for (const t of tokens) {
    if (!t.latin) continue;
    for (let i = 0; i < t.w.length; i++) {
      counts[t.w.charCodeAt(i) - 97]!++;
      n++;
    }
  }
  if (!n) return 0;
  const p = dict(lang).letterP;
  let chi = 0;
  for (let i = 0; i < 26; i++) {
    const e = p[i]! * n;
    chi += (counts[i]! - e) ** 2 / e;
  }
  // A genuine sample of n letters has chi ≈ 25 (degrees of freedom) whatever n is.
  const fit = Math.max(0, Math.min(1, 1 - Math.max(0, chi - 25) / (n * 1.5)));
  return 0.5 + (fit - 0.5) * Math.min(1, n / 20);
}

function stopFit(share: number, words: number): number {
  if (words < 2) return 0.5;
  // Two or three words say nothing about the share of function words ("send help").
  if (words <= 3) return Math.max(0.7, share > 0.6 ? 0.7 : 1);
  if (share < 0.25) return share / 0.25;
  if (share > 0.6) return Math.max(0.3, 1 - ((share - 0.6) / 0.4) * 0.7);
  return 1;
}

/** Share of non-space characters that are neither letters nor ordinary punctuation. */
function junkShare(text: string): number {
  const total = text.replace(/\s+/g, '').length;
  if (!total) return 0;
  const digits = text.match(/\d/g)?.length ?? 0;
  const symbols = text.match(/[^\s\p{L}\p{M}\d.,;:!?'"()«»…—–\-’/]/gu)?.length ?? 0;
  return (symbols + digits / 2) / total;
}

const FLAG_LIKE = /\b([A-Za-z][A-Za-z0-9_]{1,15})\{[^{}\s]{1,200}\}/g;

/**
 * Blank out flag prefixes that are not words (CTF{…}, picoCTF{…}): an event name says nothing
 * about readability. Real words such as flag{…} are kept.
 */
function neutralFlagPrefixes(text: string): { text: string; flag: boolean } {
  let flag = false;
  const out = text.replace(FLAG_LIKE, (m, prefix: string) => {
    flag = true;
    const letters = foldAccents(prefix).replace(/[^a-z]/g, '');
    const known = dict('en').rank.has(letters) || dict('fr').rank.has(letters);
    return known ? m : ' '.repeat(prefix.length) + m.slice(prefix.length);
  });
  return { text: out, flag };
}

interface Scored extends Readability {
  lang: Lang;
}

interface Input {
  text: string;
  tokens: Token[];
  langs: Lang[];
  junk: number;
  flag: boolean;
}

function scoreLang(input: Input, lang: Lang): Scored {
  const { text, tokens, junk, flag } = input;
  const a = analyse(
    tokens,
    lang,
    input.langs.filter((l) => l !== lang),
  );
  const d = dict(lang);
  const units = toUnits(a.pieces);
  const known = units.filter((u) => u.known);
  // Unknown words that look like words count only among known ones (a sentence with one rare
  // word), never on their own.
  const credit = known.length >= 2 ? a.credit : 0;
  const coverage = a.letters ? Math.min(1, (a.covered + credit) / a.letters) : 0;
  const stopShare = units.length ? known.filter((u) => u.stop).length / units.length : 0;
  const words = a.pieces.map((p) => p.text);
  const phrase = phraseOf(units, lang);
  if (a.segmented) phrase.attested = Math.max(phrase.attested, typedCollocations(tokens, lang));
  const result: Scored = {
    score: 0,
    lang,
    words,
    coverage,
    stopwordShare: stopShare,
    segmented: a.segmented && !/\s/.test(text.trim()) ? renderPieces(a.pieces) : null,
    coherence: phrase.coherence,
    attested: phrase.attested,
    content: phrase.content,
  };
  if (!known.length) return result;

  const freq =
    known.reduce((s, p) => s + Math.max(0, 1 - Math.log(p.rank + 1) / d.logSize), 0) / known.length;
  const quality =
    0.35 +
    0.35 * Math.min(1, freq / 0.5) +
    0.15 * stopFit(stopShare, units.length) +
    0.15 * letterFit(tokens, lang);
  // One word proves little; confidence grows with the number of words and letters.
  const confidence =
    (1 - 0.6 * Math.exp(-0.9 * (known.length - 1))) * Math.min(1, 0.55 + a.letters / 15);
  let score = 100 * coverage ** 2 * quality * confidence;
  // Share of the letters that come from a split made by the machine.
  const machine = a.segmented ? a.segLetters / Math.max(1, a.letters) : 0;
  if (a.segmented) {
    // A split found by the machine is weaker evidence than spaces typed by a human, and a split
    // into short words ("air see do a eat") is what random letters give.
    const split = 0.93 * (0.4 + 0.6 * (a.segLong / Math.max(1, a.segLetters)));
    score *= 1 - machine * (1 - split);
  }
  // Words that cannot follow each other ("le dans et") are not a phrase; it matters most for
  // short phrases and machine-made splits, where the words alone prove little.
  if (units.length >= 2) {
    const typed = units.length <= 8 ? 0.3 : 0.15;
    const weight = typed + (0.45 - typed) * machine;
    score *= 1 - weight * (1 - phraseFit(phrase.coherence));
  }
  score *= syntaxFactor(units, lang);
  score *= 1 - Math.min(0.7, Math.max(0, (junk - 0.2) * 1.5));
  if (flag) score += 8 + 10 * coverage;
  result.score = Math.round(Math.max(0, Math.min(100, score)) * 10) / 10;
  return result;
}

/**
 * Readability of `text` in the best of `langs` (French and English by default).
 * Words are split on anything that is not a letter, plus snake_case / camelCase / braces, so
 * `flag{hidden_message}` reads as "flag hidden message" (with a bonus for the flag shape).
 * Input without spaces is segmented into dictionary words first.
 */
export function readability(text: string, langs: Lang[] = ['fr', 'en']): Readability {
  const flag = neutralFlagPrefixes(text);
  const tokens = tokenize(flag.text);
  const empty: Readability = {
    score: 0,
    lang: null,
    words: tokens.map((t) => t.w),
    coverage: 0,
    stopwordShare: 0,
    segmented: null,
    coherence: 1,
    attested: 0,
    content: 0,
  };
  const unique = [...new Set(langs)];
  if (!tokens.length || !unique.length) return empty;
  const input: Input = { text, tokens, langs: unique, junk: junkShare(text), flag: flag.flag };
  let best: Scored | null = null;
  for (const lang of unique) {
    const r = scoreLang(input, lang);
    if (!best || r.score > best.score) best = r;
  }
  return best && best.coverage > 0 ? best : empty;
}
