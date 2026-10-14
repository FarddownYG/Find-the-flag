/**
 * Text analyzer passes that read the visible text in another order: acrostics (first or last
 * letter / word of each line, every Nth letter…) and structured readings (odd lines, reversed
 * text, diagonals, columns, boustrophedon).
 */
import { foldAccents, isFunctionWord, orderFit, type OrderFit } from '../../lib/readability';
import {
  isLetterOrDigit,
  lettersOf,
  ordinal,
  pickBest,
  wordPickFactor,
  wordsOf,
  type Family,
  type Mode,
  type Pass,
  type Scorer,
} from './_text-analyzer-core';

/** The visible text, prepared once for every reading pass. */
export interface ReadInput {
  /** Visible text (invisible characters removed, homoglyphs replaced). */
  text: string;
  /** Non-blank lines, trailing whitespace removed. */
  lines: string[];
  /** The lines without a leading list marker ("1. ", "- ", "• "): what acrostics read. */
  bodies: string[];
  /** For each line: a blank line comes right before it (a new paragraph or stanza). */
  afterBlank: boolean[];
  /** Number of words in the text. */
  wordCount: number;
}

/** A bullet, a dash or a number that starts a list item, with the space after it. */
const LIST_MARKER = /^\s*(?:[-*•·–—>+#]+|\(?\d{1,3}[.):\]]|\[\d{1,3}\])\s+(?=\S)/u;

/** Split visible text into its non-blank lines, remembering paragraph breaks. */
export function readInput(text: string): ReadInput {
  const lines: string[] = [];
  const afterBlank: boolean[] = [];
  let blank = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/u, '');
    if (!line.trim()) {
      blank = lines.length > 0;
      continue;
    }
    lines.push(line);
    afterBlank.push(blank);
    blank = false;
  }
  const marked = lines.filter((l) => LIST_MARKER.test(l)).length;
  // Strip markers only from a list (most lines marked), not from one line that starts with "-".
  const bodies =
    marked >= Math.max(2, lines.length * 0.6)
      ? lines.map((l) => l.replace(LIST_MARKER, ''))
      : lines;
  return { text, lines, bodies, afterBlank, wordCount: wordsOf(text).length };
}

/** Every Nth character is tried for N up to this, on the first MAX_STEP_CHARS characters. */
const MAX_STEP = 16;
const MAX_STEP_CHARS = 1200;
/** Characters of each every-Nth pick read to choose the best offset. */
const NTH_COMPARE = 240;
const MAX_WORD_STEP = 8;
const MAX_STEP_WORDS = 1000;
/** Columns of the line grid that are read one by one. */
const MAX_COLUMNS = 120;

const pass = (
  family: Family,
  mode: Mode,
  label: string,
  result: string | null,
  note: string,
  prior?: number,
): Pass => ({ family, mode, label, result, note, prior });

const SENTENCE_END = /[.!?…]["'»”’)\]]*$/u;
/** French reflexive pairs, the only natural doubled words. */
const DOUBLE_OK = new Set(['nous', 'vous']);

/**
 * Last two letters of a line's last word (accents folded): a rough rhyme by spelling. Lines
 * that end on a function word ("les", "de") do not rhyme: that is where wrapped prose breaks.
 */
function rhymeOf(line: string): string | null {
  const word = wordsOf(line).at(-1) ?? '';
  if (isFunctionWord(word)) return null;
  const last = foldAccents(word).replace(/[^a-z]/g, '');
  return last.length >= 2 ? last.slice(-2) : null;
}

/** Share of lines that rhyme with one of the two lines before or after (AABB, ABAB). */
export function rhymeShare(lines: string[]): number {
  if (lines.length < 2) return 0;
  const ends = lines.map(rhymeOf);
  let rhymed = 0;
  ends.forEach((e, i) => {
    if (e && [i - 2, i - 1, i + 1, i + 2].some((j) => ends[j] === e)) rhymed++;
  });
  return rhymed / lines.length;
}

/**
 * How much the first words of the lines say, as a score multiplier (0.65..1). Whether the
 * words form a phrase is judged by the scorer; this only weighs the layout. In verse (lines
 * that rhyme, or start with a capital in the middle of a sentence) every line start is a free
 * choice of the poet. In prose a line that starts a new sentence puts a sentence-opening word
 * there anyway, and hard-wrapped prose (lowercase line starts, no rhyme) puts whatever word
 * the wrap fell on. Capitals prove nothing in Title Case; doubled words ("And And") are salad.
 */
function firstWordEvidence(input: ReadInput, words: string[]): { prior: number; note: string } {
  const { afterBlank } = input;
  const lines = input.bodies;
  const rhymes = rhymeShare(lines) >= 0.5;
  let capitals = 0;
  let lower = 0;
  let starts = 0;
  for (let i = 1; i < lines.length; i++) {
    const first = words[i];
    if (!first) continue;
    if (afterBlank[i] || SENTENCE_END.test(lines[i - 1]!)) starts++;
    else if (/^\p{Lu}/u.test(first)) capitals++;
    else lower++;
  }
  const rest = Math.max(1, capitals + lower + starts);
  const verse = rhymes || (capitals > 0 && capitals >= lower);
  const wrapped = !verse && lower > rest / 2;
  // Prose whose every line opens a sentence puts sentence openers there (Le, The, Please).
  let prior = wrapped
    ? 0.65
    : verse
      ? 0.8 + (0.2 * (capitals + 0.8 * starts + 0.8 * lower)) / rest
      : 0.65 + (0.35 * capitals) / rest;
  // Keywords in capitals at the start of lines that are not (SELECT, FROM, WHERE): code.
  const shouted = words.filter((w) => /^\p{Lu}{2,}$/u.test(w)).length;
  const capsLines = lines.filter((l) => !/\p{Ll}/u.test(l)).length;
  const keywords = shouted >= 2 && shouted >= 0.6 * words.length && capsLines < lines.length / 2;
  if (keywords) prior *= 0.6;
  // Title Case: capitals inside the lines too, so the capital at the start proves nothing.
  const inner = lines.flatMap((l) => wordsOf(l).slice(1));
  const capitalised = inner.filter((w) => /^\p{Lu}/u.test(w)).length;
  const titleCase = inner.length >= 4 && capitalised / inner.length >= 0.6;
  if (titleCase) prior *= 0.85;
  const picked = words.filter(Boolean).map((w) => w.toLowerCase());
  let doubled = 0;
  for (let i = 1; i < picked.length; i++) {
    if (picked[i] === picked[i - 1] && !DOUBLE_OK.has(picked[i]!)) doubled++;
  }
  prior *= 0.85 ** doubled;
  const notes = [`${picked.length} lines`];
  if (rhymes) notes.push('they rhyme');
  if (wrapped) notes.push('lowercase line starts: wrapped prose?');
  else if (starts) {
    notes.push(`${starts} ${starts === 1 ? 'begins' : 'begin'} a new sentence anyway`);
  }
  if (titleCase) notes.push('every word is capitalised');
  if (keywords) notes.push('keywords in capitals');
  if (doubled) notes.push(`${doubled} doubled word${doubled > 1 ? 's' : ''}`);
  return { prior, note: notes.join(', ') };
}

const reverse = (s: string) => Array.from(s).reverse().join('');

function firstLetter(line: string): string | undefined {
  return lettersOf(line)[0];
}

function lastLetter(line: string): string | undefined {
  const letters = lettersOf(line);
  return letters[letters.length - 1];
}

/** Keep only the positions that exist; null when fewer than `min` remain. */
function collect(items: (string | undefined)[], min: number): string[] | null {
  const kept = items.filter((x): x is string => x !== undefined && x !== '');
  return kept.length >= min ? kept : null;
}

/** Pick one letter (or word) per line; `pick` says which, and decides how it is scored. */
function perLine(
  input: ReadInput,
  label: string,
  pick: (line: string) => string | undefined,
  kind: 'letters' | 'words',
  prior?: number,
  tries = 1,
): Pass {
  const lines = input.bodies;
  const none = (why: string): Pass => ({
    ...pass('acrostic', 'select', label, null, why),
    pick: kind,
  });
  if (lines.length < 2) return none('Needs at least 2 lines');
  const picked = collect(lines.map(pick), 2);
  if (!picked) return none('Lines are too short');
  const missing = lines.length - picked.length;
  const note = `${picked.length} lines${missing ? `, ${missing} too short skipped` : ''}`;
  const result = picked.join(kind === 'words' ? ' ' : '');
  return {
    ...pass('acrostic', 'select', label, result, note, prior),
    pick: kind,
    share: kind === 'words' ? picked.length / Math.max(1, input.wordCount) : undefined,
    tries,
  };
}

/** The classic acrostic of poems (Sand to Musset), weighed by how free the line starts are. */
function firstWords(input: ReadInput): Pass {
  const label = 'First word of each line';
  const base = perLine(input, label, (l) => wordsOf(l)[0], 'words');
  if (base.result === null) return base;
  const words = input.bodies.map((l) => wordsOf(l)[0] ?? '');
  const { prior, note } = firstWordEvidence(input, words);
  return { ...base, prior, note };
}

/**
 * The last word of each line (the telestich of words). Hard-wrapped prose ends its lines
 * wherever the wrap falls and rhyming verse on the rhyme, so neither choice is free there;
 * the layout is read as for the first words.
 */
function lastWords(input: ReadInput): Pass {
  const label = 'Last word of each line';
  const base = perLine(input, label, (l) => wordsOf(l).at(-1), 'words');
  if (base.result === null) return base;
  const firsts = input.bodies.map((l) => wordsOf(l)[0] ?? '');
  const layout = firstWordEvidence(input, firsts);
  // Lines that end on "la", "de", "the": the wrap fell mid-phrase (no poem or message does it).
  const lasts = input.bodies.map((l) => wordsOf(l).at(-1) ?? '').filter(Boolean);
  const dangling = lasts.filter((w) => isFunctionWord(w)).length / Math.max(1, lasts.length);
  const wrapped = layout.note.includes('wrapped prose') || dangling >= 0.4;
  const rhymes = rhymeShare(input.bodies) >= 0.5;
  const prior = wrapped ? 0.5 : rhymes ? 0.7 : 0.8;
  const notes = [`${base.result.split(' ').length} lines`];
  if (wrapped) notes.push('lowercase line starts: wrapped prose?');
  else if (rhymes) notes.push('they rhyme');
  return { ...base, prior, note: notes.join(', ') };
}

/** Readability of a word pick, as scorePass() will weigh it (for choosing among offsets). */
const wordPickRate = (scorer: Scorer) => (text: string) => {
  const r = scorer.reading(text).r;
  return r.score * wordPickFactor(r, wordsOf(text).length, 0);
};

/** Every Nth character with the best offset, on letters only or on every character. */
function everyNth(text: string, scorer: Scorer): Pass[] {
  const all = Array.from(text.slice(0, MAX_STEP_CHARS * 2)).slice(0, MAX_STEP_CHARS);
  const chars = all.filter((c) => c !== '\n' && c !== '\r');
  const letters = chars.filter(isLetterOrDigit);
  const out: Pass[] = [];
  const truncated = text.length > MAX_STEP_CHARS ? `, first ${MAX_STEP_CHARS} characters` : '';
  for (let n = 2; n <= MAX_STEP; n++) {
    const label = `Every ${ordinal(n)} character`;
    const options: { text: string; note: string }[] = [];
    for (const [source, what] of [
      [letters, 'letter'],
      [chars, 'character'],
    ] as const) {
      if (source.length < n * 3) continue;
      for (let offset = 0; offset < n; offset++) {
        let picked = '';
        for (let i = offset; i < source.length; i += n) picked += source[i]!;
        options.push({
          text: picked.trim(),
          note: `${what === 'letter' ? 'letters only' : 'all characters'}, from ${what} ${offset + 1}${truncated}`,
        });
      }
    }
    // Offsets are compared on the start of each pick: a message shows there, and the 2·N
    // readings of a long text stay cheap. The chosen pick is scored in full.
    const top = pickBest(
      options,
      scorer,
      '',
      (t) => scorer.reading(t.slice(0, NTH_COMPARE)).r.score,
    );
    // The best of 2·N offsets: chance alone gets some of them to read as words.
    out.push(
      top
        ? {
            ...pass('acrostic', 'select', label, top.best.text, top.best.note, 0.8),
            pick: 'letters',
            margin: top.margin,
            // 2·N offsets for this step, and the step itself is one of a few natural ones.
            tries: 8 * n,
          }
        : pass('acrostic', 'select', label, null, `Text too short for a step of ${n}`),
    );
  }
  return out;
}

function everyNthWord(words: string[], scorer: Scorer): Pass[] {
  const used = words.slice(0, MAX_STEP_WORDS);
  const out: Pass[] = [];
  for (let n = 2; n <= MAX_WORD_STEP; n++) {
    const label = `Every ${ordinal(n)} word`;
    if (used.length < n * 2) {
      out.push(pass('acrostic', 'select', label, null, `Fewer than ${n * 2} words`));
      continue;
    }
    const options: { text: string; note: string }[] = [];
    for (let offset = 0; offset < n; offset++) {
      const picked: string[] = [];
      for (let i = offset; i < used.length; i += n) picked.push(used[i]!);
      options.push({
        text: picked.join(' '),
        note: `from word ${offset + 1}; picked words always look readable, check by eye`,
      });
    }
    const top = pickBest(options, scorer, '', wordPickRate(scorer))!;
    out.push({
      ...pass('acrostic', 'select', label, top.best.text, top.best.note, 0.35),
      pick: 'words',
      margin: top.margin,
    });
  }
  return out;
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+|\n\s*\n/)
    .map((s) => s.trim())
    .filter((s) => lettersOf(s).length > 0);
}

/** A1Z26: 1 → a … 26 → z; null when a number is out of range. */
function a1z26(numbers: number[]): string | null {
  if (!numbers.every((n) => n >= 1 && n <= 26)) return null;
  return numbers.map((n) => String.fromCharCode(96 + n)).join('');
}

/**
 * Word lengths, a classic null cipher: each word stands for its number of letters, read as
 * digits (a word of ten letters or more for 0, as in pi mnemonics) or as A1Z26 letters.
 */
function wordLengthPasses(words: string[]): Pass[] {
  const digitsLabel = 'Word lengths as digits';
  const lettersLabel = 'Word lengths as letters (A1Z26)';
  const lengths = words.map((w) => lettersOf(w).length).filter((n) => n > 0);
  if (lengths.length < 4) {
    return [
      pass('acrostic', 'select', digitsLabel, null, 'Fewer than 4 words'),
      pass('acrostic', 'select', lettersLabel, null, 'Fewer than 4 words'),
    ];
  }
  const used = lengths.slice(0, MAX_STEP_WORDS);
  const letters = a1z26(used);
  return [
    pass(
      'acrostic',
      'select',
      digitsLabel,
      used.map((n) => n % 10).join(''),
      `${used.length} words; read it as a number`,
    ),
    letters
      ? {
          ...pass('acrostic', 'select', lettersLabel, letters, `${used.length} words`, 0.8),
          pick: 'letters',
        }
      : pass('acrostic', 'select', lettersLabel, null, 'A word has more than 26 letters'),
  ];
}

/**
 * The first letter and the first word of each paragraph (blocks between blank lines): the
 * acrostic of letters and e-mails, where the lines inside a paragraph are wrapped anyhow.
 */
function paragraphPasses(input: ReadInput): Pass[] {
  const letterLabel = 'First letter of each paragraph';
  const wordLabel = 'First word of each paragraph';
  const starts = input.bodies.filter((_, i) => i === 0 || input.afterBlank[i]);
  if (starts.length < 3) {
    const why = starts.length < 2 ? 'No blank line between paragraphs' : 'Fewer than 3 paragraphs';
    return [
      pass('acrostic', 'select', letterLabel, null, why),
      pass('acrostic', 'select', wordLabel, null, why),
    ];
  }
  // One line per paragraph: the same reading as the lines, already listed there.
  if (starts.length === input.bodies.length) {
    const why = 'Every paragraph is one line: see the line acrostics';
    return [
      pass('acrostic', 'select', letterLabel, null, why),
      pass('acrostic', 'select', wordLabel, null, why),
    ];
  }
  const letters = collect(starts.map(firstLetter), 3);
  const words = collect(
    starts.map((l) => wordsOf(l)[0]),
    3,
  );
  const note = `${starts.length} paragraphs`;
  return [
    letters
      ? { ...pass('acrostic', 'select', letterLabel, letters.join(''), note), pick: 'letters' }
      : pass('acrostic', 'select', letterLabel, null, 'Paragraphs start without a letter'),
    words
      ? {
          ...pass('acrostic', 'select', wordLabel, words.join(' '), note),
          pick: 'words',
          share: words.length / Math.max(1, input.wordCount),
        }
      : pass('acrostic', 'select', wordLabel, null, 'Paragraphs start without a word'),
  ];
}

/** A word written in capitals (ATTENTION, NASA): visible, it hides nothing. */
const ALL_CAPS_WORD = /^\p{Lu}{2,}$/u;

/**
 * The capital letters of the text, except those of words written in capitals: a shouted
 * sentence ("DO NOT LEAVE YOUR BAGS") is read by anyone, it is not a hidden message.
 */
function capitalsPass(text: string): Pass {
  const label = 'Capital letters';
  const none = (why: string) => pass('acrostic', 'select', label, null, why);
  const picked: string[] = [];
  let total = 0;
  let shouted = 0;
  for (const word of text.match(/[\p{L}\p{M}]+/gu) ?? []) {
    const caps = Array.from(word).filter((c) => /\p{Lu}/u.test(c));
    total += caps.length;
    if (ALL_CAPS_WORD.test(word.replace(/\p{M}/gu, ''))) shouted += caps.length;
    else picked.push(...caps);
  }
  if (total >= 2 && total === lettersOf(text).filter((c) => /\p{L}/u.test(c)).length) {
    return none('Every letter is a capital');
  }
  if (shouted && shouted >= 0.7 * total) {
    return none(
      `${shouted} of ${total} capitals belong to words written in capitals: visible text`,
    );
  }
  if (picked.length < 2) return none('Fewer than 2 capital letters');
  const skipped = shouted ? `, ${shouted} in words written in capitals left out` : '';
  return {
    ...pass(
      'acrostic',
      'select',
      label,
      picked.join(''),
      `${picked.length} capitals${skipped}`,
      0.9,
    ),
    pick: 'letters',
  };
}

/** Acrostics: first / last / nth letter or word of lines, words and sentences. */
export function acrosticPasses(input: ReadInput, scorer: Scorer): Pass[] {
  const { text } = input;
  const words = wordsOf(text);
  const out: Pass[] = [
    // The two classic acrostics (initials, telestich) get the benefit of the doubt.
    perLine(input, 'First letter of each line', firstLetter, 'letters', 1.1, 1),
    perLine(input, 'Last letter of each line', lastLetter, 'letters', 1, 2),
    firstWords(input),
    // Word picks always read as words: the first and last words of the lines are the classic
    // places, the others are trusted less.
    lastWords(input),
  ];
  for (const n of [2, 3]) {
    out.push(
      perLine(input, `${ordinal(n)} word of each line`, (l) => wordsOf(l)[n - 1], 'words', 0.4),
    );
  }
  for (const n of [2, 3, 4, 5]) {
    out.push(
      perLine(
        input,
        `${ordinal(n)} letter of each line`,
        (l) => lettersOf(l)[n - 1],
        'letters',
        0.8,
        5,
      ),
    );
  }
  out.push(
    perLine(
      input,
      'Middle letter of each line',
      (l) => {
        const letters = lettersOf(l);
        return letters.length >= 3 ? letters[Math.floor((letters.length - 1) / 2)] : undefined;
      },
      'letters',
      0.8,
      5,
    ),
  );

  const byWord = (label: string, pick: (w: string) => string | undefined, prior: number): Pass => {
    if (words.length < 3) return pass('acrostic', 'select', label, null, 'Fewer than 3 words');
    const picked = collect(words.map(pick), 3);
    return picked
      ? {
          ...pass('acrostic', 'select', label, picked.join(''), `${picked.length} words`, prior),
          pick: 'letters',
          // The first letter of each word is the classic null cipher; the others are rarer.
          tries: label.startsWith('First') ? 2 : 4,
        }
      : pass('acrostic', 'select', label, null, 'Words are too short');
  };
  out.push(
    byWord('First letter of each word', (w) => lettersOf(w)[0], 0.9),
    byWord('Second letter of each word', (w) => lettersOf(w)[1], 0.8),
    byWord('Third letter of each word', (w) => lettersOf(w)[2], 0.7),
    byWord('Last letter of each word', (w) => lettersOf(w).at(-1), 0.8),
  );

  const sents = sentences(text);
  out.push(
    sents.length >= 2
      ? {
          ...pass(
            'acrostic',
            'select',
            'First letter of each sentence',
            sents.map((s) => lettersOf(s)[0]!).join(''),
            `${sents.length} sentences`,
            0.9,
          ),
          pick: 'letters',
        }
      : pass('acrostic', 'select', 'First letter of each sentence', null, 'Fewer than 2 sentences'),
  );
  out.push(...paragraphPasses(input));

  out.push(capitalsPass(text));

  out.push(...wordLengthPasses(words), ...everyNth(text, scorer), ...everyNthWord(words, scorer));
  return out;
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
/** How much a reading of the lines beats the text as written, by its readability. */
function readsBetter(after: string, before: string, scorer: Scorer): number {
  return clamp01((scorer.reading(after).r.score - scorer.reading(before).r.score - 10) / 30);
}

const median = (values: number[]) => {
  const sorted = [...values].sort((x, y) => x - y);
  return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)]! : 0;
};

/**
 * Every other line. A message on the odd lines stands apart from the cover on the even ones:
 * its lines are much shorter ("the drop is" between long sentences) or the other lines do not
 * read at all, and the picked lines run on as one phrase (sentences that each end with a full
 * stop do not). The halves of an ordinary text, or the two languages of a bilingual one, do
 * neither, however readable each half is. A greeting and a signature around one long line are
 * not a message either: it takes three picked lines.
 */
function alternateLines(picked: string[], others: string[], scorer: Scorer) {
  const count = (ls: string[]) => ls.map((l) => wordsOf(l).length).filter((n) => n > 0);
  const mine = count(picked);
  const theirs = count(others);
  if (mine.length < 3 || theirs.length < 2) {
    return { evidence: 0, note: `${picked.length} lines: too few to stand apart` };
  }
  const ratio = median(theirs) / Math.max(1, median(mine));
  // Shorter line by line, not only on average: a greeting and a signature are short too, but
  // so is some of the body around them.
  let below = 0;
  for (const m of mine) for (const t of theirs) below += m < t ? 1 : m === t ? 0.5 : 0;
  const separated = clamp01((below / (mine.length * theirs.length) - 0.75) / 0.2);
  const shorter = clamp01((ratio - 1.5) / 1.5) * separated;
  const rOthers = scorer.read(others.join('\n')).score;
  const junk =
    readsBetter(picked.join('\n'), others.join('\n'), scorer) * clamp01((45 - rOthers) / 20);
  const flow = clamp01((orderFit(picked, { stop: 0.5 }).fit - 0.55) / 0.3);
  const evidence = Math.max(shorter, junk) * (0.4 + 0.6 * flow);
  const why =
    junk >= shorter && junk > 0
      ? 'the other lines do not read'
      : shorter > 0
        ? `${ratio.toFixed(1)}× shorter than the other lines`
        : 'like the other lines: no sign of a message';
  return { evidence, note: `${picked.length} lines, ${why}` };
}

/**
 * How much better a new order of the same chunks joins than the original one (0..1). Only
 * joins that are not at a full stop or a paragraph break can tell, and only between lines of
 * words: the grammar of sentences says nothing about the order of lines of code.
 */
function betterOrder(after: OrderFit, before: OrderFit, prose = 1): number {
  if (!before.joins) return 0;
  // One or two joins say little about an order.
  const enough = Math.min(1, before.open / 3);
  return clamp01((after.fit - before.fit) / 0.15) * (before.open / before.joins) * enough * prose;
}

/** Share of lines made mostly of letters (prose or verse, not code or tables). */
function proseShare(lines: string[]): number {
  if (!lines.length) return 0;
  const wordy = lines.filter((l) => {
    const visible = l.replace(/\s/g, '');
    return visible && lettersOf(visible).length >= 0.8 * Array.from(visible).length;
  });
  return wordy.length / lines.length;
}

/** Structured readings: line order, reversals, diagonals, columns. */
export function structurePasses(input: ReadInput, scorer: Scorer): Pass[] {
  const { lines, text } = input;
  const out: Pass[] = [];
  const s = (
    mode: Mode,
    label: string,
    result: string | null,
    note: string,
    evidence?: number,
  ) => ({
    ...pass('structure', mode, label, result, note),
    evidence,
  });
  const multi = lines.length >= 3;
  const needLines = 'Needs at least 3 lines';

  for (const [label, parity] of [
    ['Odd lines (1st, 3rd…)', 0],
    ['Even lines (2nd, 4th…)', 1],
  ] as const) {
    if (!multi) {
      out.push(s('reorder', label, null, needLines));
      continue;
    }
    const picked = lines.filter((_, i) => i % 2 === parity);
    const others = lines.filter((_, i) => i % 2 !== parity);
    const { evidence, note } = alternateLines(picked, others, scorer);
    out.push(s('reorder', label, picked.join('\n'), note, evidence));
  }

  // A reversed order shows in how the lines join (il faut / tout brûler, not brûler / il faut)
  // and in where the text starts and ends: readability alone ignores word order.
  if (lines.length >= 2) {
    const reversed = [...lines].reverse();
    // A line followed by a blank line ends a paragraph (in the reversed order: the line after).
    const ends = input.afterBlank.slice(1).concat(false);
    const evidence = betterOrder(
      orderFit(reversed, { paragraphEnds: [...input.afterBlank].reverse() }),
      orderFit(lines, { paragraphEnds: ends }),
      proseShare(lines),
    );
    out.push(
      s(
        'reorder',
        'Lines in reverse order',
        reversed.join('\n'),
        evidence > 0.2
          ? 'the lines join better upside down'
          : 'joins no better than the lines as written',
        evidence,
      ),
    );
  } else out.push(s('reorder', 'Lines in reverse order', null, 'Needs at least 2 lines'));

  const words = wordsOf(text);
  const wordsBack = [...words].reverse();
  const head = (list: string[]) => list.slice(0, 300);
  out.push(
    s(
      'transform',
      'Whole text reversed',
      reverse(text.trim()),
      'last character first',
      readsBetter(reverse(text.trim()), text, scorer),
    ),
    s(
      'reorder',
      'Words in reverse order',
      wordsBack.join(' '),
      '',
      betterOrder(orderFit(head(wordsBack)), orderFit(head(words)), proseShare(lines)),
    ),
  );
  if (lines.length >= 2) {
    const each = lines.map(reverse).join('\n');
    out.push(
      s(
        'transform',
        'Each line reversed',
        each,
        'line order kept',
        readsBetter(each, text, scorer),
      ),
    );
  } else {
    out.push(
      s('transform', 'Each line reversed', null, 'Single line: same as the whole text reversed'),
    );
  }
  const eachWord = text.replace(/[\p{L}\p{N}\p{M}]+/gu, (w) => reverse(w));
  out.push(
    s(
      'transform',
      'Each word reversed',
      eachWord,
      'word order kept',
      readsBetter(eachWord, text, scorer),
    ),
  );
  if (lines.length >= 2) {
    const even = lines.filter((_, i) => i % 2 === 1);
    out.push(
      s(
        'transform',
        'Boustrophedon (every 2nd line reversed)',
        lines.map((l, i) => (i % 2 ? reverse(l) : l)).join('\n'),
        'lines 2, 4… read right to left',
        // Only the reversed lines change: they must read better that way.
        readsBetter(even.map(reverse).join('\n'), even.join('\n'), scorer),
      ),
    );
  } else {
    out.push(
      s('transform', 'Boustrophedon (every 2nd line reversed)', null, 'Needs at least 2 lines'),
    );
  }

  const grid = lines.map((l) => Array.from(l));
  const diag = (pick: (row: string[], i: number) => string | undefined) =>
    collect(grid.map(pick), 3);
  const down = multi ? diag((row, i) => row[i]) : null;
  const up = multi ? diag((row, i) => row[row.length - 1 - i]) : null;
  const letters = (p: Pass, tries = 1): Pass => ({
    ...p,
    pick: 'letters',
    prior: p.prior ?? 0.8,
    tries,
  });
  out.push(
    letters(
      s(
        'select',
        'Diagonal ↘ (character i of line i)',
        down ? down.join('') : null,
        down ? `${down.length} lines` : multi ? 'Lines are too short' : needLines,
      ),
      2,
    ),
    letters(
      s(
        'select',
        'Diagonal ↙ (character i from the end of line i)',
        up ? up.join('') : null,
        up ? `${up.length} lines` : multi ? 'Lines are too short' : needLines,
      ),
      2,
    ),
  );

  const width = Math.max(0, ...grid.map((r) => r.length));
  if (multi && width >= 2) {
    const columns: { text: string; note: string }[] = [];
    for (let j = 1; j < Math.min(width, MAX_COLUMNS); j++) {
      const col = collect(
        grid.map((row) => row[j]),
        3,
      );
      if (col) columns.push({ text: col.join('').trim(), note: `column ${j + 1}` });
    }
    const top = pickBest(columns, scorer);
    out.push(
      top
        ? {
            ...s(
              'select',
              'Best column (character j of every line)',
              top.best.text,
              `${top.best.note} of ${width}${width > MAX_COLUMNS ? ` (first ${MAX_COLUMNS} read)` : ''}`,
            ),
            prior: 0.8,
            pick: 'letters',
            margin: top.margin,
            tries: columns.length,
          }
        : s('select', 'Best column (character j of every line)', null, 'Lines are too short'),
    );
  } else {
    out.push(s('select', 'Best column (character j of every line)', null, needLines));
  }

  const lengths = grid.map((r) => r.length);
  const similar =
    multi && Math.min(...lengths) >= 2 && Math.min(...lengths) / Math.max(...lengths) >= 0.75;
  if (similar) {
    let read = '';
    for (let j = 0; j < width; j++)
      for (const row of grid) if (row[j] !== undefined) read += row[j];
    out.push(
      letters(
        s(
          'select',
          'Read by columns (grid transposed)',
          read,
          `${grid.length} lines × ${width} columns`,
        ),
      ),
    );
  } else {
    out.push(
      s(
        'select',
        'Read by columns (grid transposed)',
        null,
        multi ? 'Lines have very different lengths' : needLines,
      ),
    );
  }
  return out;
}
