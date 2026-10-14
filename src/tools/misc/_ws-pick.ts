/**
 * Where is the program? Every way of extracting it from the text is a candidate; auto mode runs
 * them all and keeps the one that works.
 */
import { ToolError } from '../../core/errors';
import { plaintextScore } from '../../lib/english';
import { parse, type Parsed } from './_ws-core';
import {
  extractAll,
  extractLetters,
  extractMarkers,
  extractMarkersTrailing,
  extractTrailing,
  looksLikeLetters,
  markerRegion,
  type BareLines,
  type Extraction,
  type MarkerRegion,
} from './_ws-extract';
import { execute, type VmResult } from './_ws-vm';

export type ExtractMode = 'auto' | 'all' | 'trailing' | 'markers' | 'markers-trailing' | 'letters';

/**
 * The "Program is in" choices. The labels are also used to tell how to pick an extraction by hand,
 * and the short names of the extractions (Candidate.key: "line ends", "between markers"...) are
 * the same words, so the options, the notes and the Run table speak one vocabulary.
 */
export const EXTRACT_CHOICES = [
  { value: 'auto', label: 'Auto (try every way)' },
  { value: 'all', label: 'All whitespace' },
  { value: 'trailing', label: 'Line ends (trailing spaces/tabs)' },
  { value: 'markers', label: 'Between markers' },
  { value: 'markers-trailing', label: 'Line ends between markers' },
  { value: 'letters', label: 'S/T/L letters ([Space] [Tab] [LF])' },
] as const satisfies readonly { value: ExtractMode; label: string }[];

export const BARE_CHOICES = [
  { value: 'count', label: 'Count (each gives its L)' },
  { value: 'lead', label: 'Count from the first coded line' },
  { value: 'skip', label: 'Skip (coded lines only)' },
] as const satisfies readonly { value: BareLines; label: string }[];

export interface ExtractOptions {
  extract: ExtractMode;
  bareLines: BareLines;
  /** Markers, already unescaped. */
  start: string;
  end: string;
}

export interface Candidate {
  /** Short name, used in the Run table and in lists of attempts. */
  key: string;
  /** Where the program is, as a sentence fragment ("the trailing spaces/tabs of each line"). */
  desc: string;
  /** How to choose this extraction by hand in the options. */
  how: string;
  /** Lower = simpler to explain: names the program when several extractions give the same one. */
  rank: number;
  /** Based on the trailing whitespace of lines (the per-line table then helps). */
  trailing: boolean;
  extraction: Extraction;
  /** Other extractions that gave exactly the same program. */
  same: string[];
  endFound?: boolean;
}

export interface Attempt extends Candidate {
  parsed: Parsed;
  result: VmResult;
  score: number;
}

const q = (s: string) => JSON.stringify(s);
const label = (mode: ExtractMode) => EXTRACT_CHOICES.find((c) => c.value === mode)!.label;
const bareLabel = (b: BareLines) => BARE_CHOICES.find((c) => c.value === b)!.label;

const BARE_DESC: Record<BareLines, string> = {
  count: 'every line feed counts',
  lead: 'the lines before the first one that has some are skipped',
  skip: 'the lines without any are skipped',
};
const BARE_KEY: Record<BareLines, string> = {
  count: '',
  lead: ', from the first coded line',
  skip: ', coded lines only',
};
const BARE_RANK: Record<BareLines, number> = { count: 0, lead: 1, skip: 2 };

function between(start: string, end: string, r: MarkerRegion): string {
  const from = start ? q(start) : 'the start of the text';
  if (!r.endFound) return `after ${from} (to the end of the text: ${q(end)} was not found)`;
  return `between ${from} and ${end ? q(end) : 'the end of the text'}`;
}

function build(src: string, o: ExtractOptions) {
  const all = (): Candidate => ({
    key: 'all whitespace',
    desc: 'all whitespace',
    how: `Program is in = "${label('all')}"`,
    rank: 0,
    trailing: false,
    extraction: extractAll(src),
    same: [],
  });
  const trailing = (bare: BareLines): Candidate => ({
    key: `line ends${BARE_KEY[bare]}`,
    desc: `the trailing spaces/tabs of each line (${BARE_DESC[bare]})`,
    how: `Program is in = "${label('trailing')}", Lines without trailing spaces/tabs = "${bareLabel(bare)}"`,
    rank: 3 + BARE_RANK[bare],
    trailing: true,
    extraction: extractTrailing(src, bare),
    same: [],
  });
  const markers = (r: MarkerRegion, own: boolean): Candidate => ({
    key: own ? 'between markers (own lines)' : 'between markers',
    desc: `the whitespace ${between(o.start, o.end, r)}${own ? `, without the line break that ends the ${q(o.start)} line` : ''}`,
    how: `Program is in = "${label('markers')}", with these markers`,
    rank: own ? 2 : 1,
    trailing: false,
    extraction: extractMarkers(src, r, own),
    same: [],
    endFound: r.endFound,
  });
  const markersTrailing = (r: MarkerRegion, bare: BareLines): Candidate => ({
    key: `line ends between markers${BARE_KEY[bare]}`,
    desc: `the trailing spaces/tabs of the lines ${between(o.start, o.end, r)} (${BARE_DESC[bare]})`,
    how: `Program is in = "${label('markers-trailing')}", Lines without trailing spaces/tabs = "${bareLabel(bare)}"`,
    rank: 6 + BARE_RANK[bare],
    trailing: true,
    extraction: extractMarkersTrailing(src, r, bare),
    same: [],
    endFound: r.endFound,
  });
  const letters = (): Candidate => ({
    key: 'S/T/L letters',
    desc: 'the letters S, T and L (and the words [Space] [Tab] [LF])',
    how: `Program is in = "${label('letters')}"`,
    rank: 9,
    trailing: false,
    extraction: extractLetters(src),
    same: [],
  });
  return { all, trailing, markers, markersTrailing, letters };
}

/** Same program from two extractions: keep the first one's place, the simplest one's name. */
function dedupe(list: Candidate[]): Candidate[] {
  const out: Candidate[] = [];
  for (const c of list) {
    if (!c.extraction.code) continue;
    const twin = out.find((u) => u.extraction.code === c.extraction.code);
    if (!twin) out.push(c);
    else if (c.rank < twin.rank) {
      const same = [...twin.same, twin.key];
      Object.assign(twin, { ...c, same });
    } else twin.same.push(c.key);
  }
  return out;
}

const BARES: BareLines[] = ['count', 'lead', 'skip'];

/** The extractions to try, most specific first (a tie between two working ones goes to it). */
export function candidates(src: string, o: ExtractOptions): Candidate[] {
  const b = build(src, o);
  if (o.extract === 'all') return [b.all()];
  if (o.extract === 'trailing') return [b.trailing(o.bareLines)];
  if (o.extract === 'letters') return [b.letters()];
  if (o.extract === 'markers' || o.extract === 'markers-trailing') {
    const r = markerRegion(src, o.start, o.end);
    if (!r) {
      throw new ToolError(
        `The start marker ${q(o.start)} does not appear in the text. Markers are case-sensitive (\\n and other escapes work); leave it empty to start at the beginning.`,
      );
    }
    if (o.extract === 'markers-trailing') return [b.markersTrailing(r, o.bareLines)];
    // A marker alone on its line is followed by a line break that may be layout or code: try both.
    return dedupe(
      r.lineFrom === null ? [b.markers(r, false)] : [b.markers(r, true), b.markers(r, false)],
    );
  }
  const list: Candidate[] = [];
  const r = o.start || o.end ? markerRegion(src, o.start, o.end) : null;
  if (r) {
    if (src.slice(r.lineFrom ?? r.from, r.to).includes('\n')) {
      list.push(...BARES.map((bare) => b.markersTrailing(r, bare)));
    }
    if (r.lineFrom !== null) list.push(b.markers(r, true));
    list.push(b.markers(r, false));
  }
  if (looksLikeLetters(src)) list.push(b.letters());
  list.push(...BARES.map((bare) => b.trailing(bare)), b.all());
  return dedupe(list);
}

// ---------- running and choosing ----------

/** Characters of an output that are scored: enough to judge it, cheap on a 1 MB output. */
const SAMPLE = 1 << 16;

/** A character of text in any script: letter, mark, digit, punctuation, symbol or space. */
const TEXT_CHAR = /[\p{L}\p{M}\p{N}\p{P}\p{S}\p{Zs}]/u;

/**
 * The Unicode blocks ordinary text is written with: the letters of the living scripts, the usual
 * punctuation and symbols, CJK and emoji. Other assigned characters (IPA, rare extensions...)
 * count half: real messages seldom use them, random values often land there.
 */
const COMMON_BLOCKS: readonly (readonly [number, number])[] = [
  [0x00a0, 0x017f], // Latin-1 letters and signs, Latin Extended-A
  [0x0218, 0x021b], // Romanian ș ț
  [0x0300, 0x036f], // combining accents
  [0x0370, 0x058f], // Greek, Cyrillic, Armenian
  [0x0590, 0x06ff], // Hebrew, Arabic
  [0x0900, 0x0eff], // Indic scripts, Thai, Lao
  [0x10a0, 0x10ff], // Georgian
  [0x1e00, 0x1eff], // Latin Extended Additional (Vietnamese)
  [0x2010, 0x205e], // general punctuation (dashes, quotes, …, ‰)
  [0x2070, 0x20c0], // superscripts, subscripts, currency signs
  [0x2100, 0x23ff], // letterlike symbols, number forms, arrows, maths, technical
  [0x2460, 0x27bf], // enclosed numbers, box drawing, shapes, symbols, dingbats (✓)
  [0x2e80, 0x2fdf], // CJK radicals
  [0x3000, 0x33ff], // CJK punctuation, kana, bopomofo, Hangul jamo, enclosed CJK
  [0x3400, 0x4dbf], // CJK Extension A
  [0x4e00, 0x9fff], // CJK ideographs
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe30, 0xfe4f], // CJK compatibility forms
  [0xff00, 0xffef], // fullwidth and halfwidth forms
  [0x1f000, 0x1faff], // emoji, flags, playing cards, pictographs
];

const inCommonBlock = (cp: number) => COMMON_BLOCKS.some(([a, b]) => cp >= a && cp <= b);

type Alphabet = 'latin' | 'greek' | 'cyrillic' | null;

const LATIN = /\p{Script=Latin}/u;
const GREEK = /\p{Script=Greek}/u;
const CYRILLIC = /\p{Script=Cyrillic}/u;
const LETTER_OR_MARK = /[\p{L}\p{M}]/u;

/** Latin, Greek and Cyrillic look alike: a word mixing them is noise, not text. */
function alphabetOf(ch: string, cp: number): Alphabet {
  if (cp < 0x80) return (cp | 0x20) >= 0x61 && (cp | 0x20) <= 0x7a ? 'latin' : null;
  if (LATIN.test(ch)) return 'latin';
  if (GREEK.test(ch)) return 'greek';
  if (CYRILLIC.test(ch)) return 'cyrillic';
  return null;
}

/**
 * Share of an output that reads as text, from 0 to 1. Printable ASCII, tab, LF and CR count 1, and
 * so does text in any script (accented letters, Cyrillic, CJK, emoji, ✓ €...) from the blocks real
 * messages use; rarer printable characters count half. Control and invisible characters, U+FFFD,
 * private-use and unassigned code points count 0, and the letters of a word that mixes the Latin,
 * Greek and Cyrillic alphabets (цtf) a quarter.
 */
export function printableShare(out: string): number {
  let printable = 0;
  let total = 0;
  // The current word: its letters' weight, their alphabet, and whether it mixes alphabets.
  let wordWeight = 0;
  let wordLetters = 0;
  let wordAlphabet: Alphabet = null;
  let mixed = false;
  const endWord = () => {
    printable += mixed ? wordLetters * 0.25 : wordWeight;
    wordWeight = 0;
    wordLetters = 0;
    wordAlphabet = null;
    mixed = false;
  };
  for (const ch of out) {
    if (total >= SAMPLE) break;
    const cp = ch.codePointAt(0)!;
    total++;
    let weight = 0;
    if ((cp >= 0x20 && cp < 0x7f) || cp === 9 || cp === 10 || cp === 13) weight = 1;
    // Zero width joiner and emoji presentation selector: parts of emoji sequences.
    else if (cp === 0x200d || cp === 0xfe0f) weight = 1;
    else if (cp !== 0xfffd && TEXT_CHAR.test(ch)) weight = inCommonBlock(cp) ? 1 : 0.5;
    const alphabet = weight ? alphabetOf(ch, cp) : null;
    if (alphabet) {
      if (wordAlphabet && alphabet !== wordAlphabet) mixed = true;
      wordAlphabet = alphabet;
      wordLetters++;
      wordWeight += weight;
    } else if (weight && cp >= 0x80 && LETTER_OR_MARK.test(ch)) {
      // A letter of another script, or an accent: part of the word, no alphabet of its own.
      wordWeight += weight;
      wordLetters++;
    } else {
      endWord();
      printable += weight;
    }
  }
  endWord();
  return total ? printable / total : 0;
}

/** Share of control characters (NUL, BEL, ESC, DEL, C1...): invisible, and a sign of noise. */
function controlShare(out: string): number {
  let n = 0;
  let total = 0;
  for (const ch of out) {
    if (total >= SAMPLE) break;
    const cp = ch.codePointAt(0)!;
    total++;
    if ((cp < 0x20 && cp !== 9 && cp !== 10 && cp !== 13) || (cp >= 0x7f && cp < 0xa0)) n++;
  }
  return total ? n / total : 0;
}

/**
 * prefix{...}. The look-behind makes a match start only at the beginning of a word, which keeps
 * the search linear: without it, a long run of letters ("AAAA…" from a printing loop) is
 * rescanned from every position, and a 1 MB output takes hours.
 */
export const FLAG_LIKE = /(?<![A-Za-z0-9_])[A-Za-z0-9_]{2,}\{[^{}\s]+\}/;

/** The beginning of a long output: what is scored and searched for flags. */
const head = (out: string, n = 4096) => (out.length > n ? out.slice(0, n) : out);

/** How readable a program's output is (higher is better), for choosing an extraction. */
export function outputScore(out: string): number {
  if (!out) return 0;
  const start = head(out);
  const total = Math.min(out.length, 40);
  const flagLike = FLAG_LIKE.test(start) ? 20 : 0;
  return (
    printableShare(out) * 50 +
    plaintextScore(start) * 0.4 +
    total / 4 +
    flagLike -
    controlShare(out) * 30
  );
}

const STATUS_RANK: Record<VmResult['stopped'], number> = {
  end: 4,
  'fell-off': 3,
  'output-limit': 2,
  'step-limit': 2,
  error: 0,
};

export function attempt(c: Candidate, input: string, stepLimit: number): Attempt {
  const parsed = parse(c.extraction.code);
  const result = execute(parsed, { input, stepLimit });
  let score = outputScore(result.output);
  if (result.stopped === 'fell-off') score *= 0.9;
  else if (result.stopped === 'step-limit' || result.stopped === 'output-limit') score *= 0.6;
  else if (result.stopped === 'error') score *= 0.4;
  if (parsed.tail && result.stopped !== 'error') score *= 0.97;
  return { ...c, parsed, result, score };
}

/** The output is text (in any script), not blank and not noise. */
export const printsText = (a: Attempt) =>
  a.result.output.trim() !== '' && printableShare(a.result.output) >= 0.85;

/** Stopped by the step or output limit: the program may be fine but loop forever, or be slow. */
export const atLimit = (a: Attempt) =>
  a.result.stopped === 'step-limit' || a.result.stopped === 'output-limit';

/** A run without an error that printed text: almost never happens by accident. */
export const isClean = (a: Attempt) =>
  (a.result.stopped === 'end' || a.result.stopped === 'fell-off') && printsText(a);

/** A clean run, or one that printed text until the step or output limit stopped it. */
export const isHit = (a: Attempt) => isClean(a) || (atLimit(a) && printsText(a));

/**
 * Best attempt. Hits first: one printing a flag-like token, then one that reached its end, then
 * one that ran off its last instruction, then one stopped by a limit; ties go to the most specific
 * extraction (attempts are in candidates() order). Short outputs are too short to be ranked by how
 * English they look. Without a hit: the most readable output, then the cleanest stop.
 */
export function best(attempts: Attempt[]): Attempt {
  const hits = attempts.filter(isHit);
  if (hits.length) {
    const stop = { end: 2, 'fell-off': 1 } as Partial<Record<VmResult['stopped'], number>>;
    const rank = (a: Attempt) =>
      (FLAG_LIKE.test(head(a.result.output)) ? 4 : 0) + (stop[a.result.stopped] ?? 0);
    return hits.reduce((top, a) => (rank(a) > rank(top) ? a : top));
  }
  let top = attempts[0]!;
  for (const a of attempts.slice(1)) {
    const better =
      a.score > top.score + 1e-9 ||
      (Math.abs(a.score - top.score) <= 1e-9 &&
        STATUS_RANK[a.result.stopped] > STATUS_RANK[top.result.stopped]);
    if (better) top = a;
  }
  return top;
}

/** A program needs spaces or tabs: line feeds alone can only say "end". */
export const hasCode = (c: Candidate) => /[ST]/.test(c.extraction.code);

/** Run every candidate and choose. Throws a ToolError when no extraction has any code. */
export function pick(
  src: string,
  o: ExtractOptions,
  input: string,
  stepLimit: number,
): { chosen: Attempt; attempts: Attempt[] } {
  const list = candidates(src, o).filter(hasCode);
  if (!list.length) {
    const where =
      o.extract === 'trailing'
        ? 'at the end of any line. Try "All whitespace"'
        : o.extract === 'markers' || o.extract === 'markers-trailing'
          ? 'between the markers'
          : o.extract === 'letters'
            ? 'as S/T/L letters'
            : 'anywhere';
    throw new ToolError(`No spaces or tabs found ${where}.`);
  }
  const attempts = list.map((c) => attempt(c, input, stepLimit));
  return { chosen: best(attempts), attempts };
}

/**
 * A program that holds together without running it: it parses to the end (a partial instruction
 * from the file's last line break aside), every label it jumps to or calls is marked, and it
 * does some input or output. Random whitespace rarely passes all three.
 */
export function soundProgram(parsed: Parsed): boolean {
  if (parsed.tail && parsed.tail.kind !== 'partial') return false;
  const { instrs } = parsed;
  const marked = new Set(instrs.filter((i) => i.op.name === 'label').map((i) => i.label));
  const unknown = instrs.some(
    (i) => i.label !== undefined && i.op.name !== 'label' && !marked.has(i.label),
  );
  return !unknown && instrs.some((i) => /^(?:out|read)/.test(i.op.name));
}

/**
 * Disassemble mode in auto: nothing should run for long, so every extraction gets a short trial
 * run without input (`trialSteps`). A hit wins as in Run mode; otherwise the first extraction
 * whose program is sound (see soundProgram), which covers programs that wait for input or loop
 * without printing; otherwise the most readable trial.
 */
export function pickForListing(
  src: string,
  o: ExtractOptions,
  trialSteps: number,
): { chosen: Attempt; attempts: Attempt[]; by: 'run' | 'parse' | 'closest' } {
  const { chosen, attempts } = pick(src, o, '', trialSteps);
  if (isHit(chosen)) return { chosen, attempts, by: 'run' };
  const sound = attempts.find((a) => soundProgram(a.parsed));
  return sound ? { chosen: sound, attempts, by: 'parse' } : { chosen, attempts, by: 'closest' };
}

export const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** "line ends → printed "FTF"", "all whitespace → error at #3 (add): stack underflow...". */
export function attemptSummary(a: Attempt): string {
  const r = a.result;
  const printed = r.output
    ? `printed ${q(clip(r.output, 40))}${printsText(a) ? '' : ' (mostly unprintable)'}`
    : '';
  let what: string;
  if (r.error) {
    const err = `error at #${r.error.index} (${r.error.op}): ${r.error.message}`;
    what = printed ? `${printed}, then ${err}` : err;
  } else if (r.stopped === 'step-limit') {
    what = printed ? `${printed}, then stopped at the step limit` : 'stopped at the step limit';
  } else if (r.stopped === 'output-limit') what = `${printed} without end (output limit)`;
  else what = printed || 'printed nothing';
  return `${a.key} → ${what}`;
}
