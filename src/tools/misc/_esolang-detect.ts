import type { Language } from './_esolang-common';
import { looksLikeBefunge } from './_esolang-befunge';
import { bracketsPair, pikalangWords } from './_esolang-brainfuck';
import { tokenizeCow } from './_esolang-cow';
import { deadfishVariantOf } from './_esolang-deadfish';
import { isMalbolgeProgram, isNormalisedMalbolge } from './_esolang-malbolge';

const count = (src: string, pattern: RegExp) => (src.match(pattern) ?? []).length;
const compactOf = (src: string) => src.replace(/\s+/g, '');

/** COW instructions found, if they make up (nearly) all of the text. */
function cowTokens(src: string, share: number): number {
  const { ops } = tokenizeCow(src);
  return ops.length * 3 >= share * compactOf(src).length ? ops.length : 0;
}

/** Befunge never needs both [ and ], while Brainfuck is made of them. */
const maybeBefunge = (src: string) => !(src.includes('[') && src.includes(']'));

/** Letters-only Alphuck: only a c e i j o p s, with p and s balanced. */
function looksLikeAlphuck(compact: string): boolean {
  if (!/^[aceijops]+$/.test(compact)) return false;
  let depth = 0;
  let loops = 0;
  for (const ch of compact) {
    if (ch === 'p') {
      depth++;
      loops++;
    } else if (ch === 's' && --depth < 0) return false;
  }
  return depth === 0 && loops > 0;
}

/** Programs written in the Brainfuck dialects whose symbols are only . ? ! and pairs of them. */
function looksLikeShortOok(compact: string): boolean {
  return (
    compact.length >= 2 &&
    compact.length % 2 === 0 &&
    /^[.?!]+$/.test(compact) &&
    /[?!]/.test(compact)
  );
}

/**
 * The language a program is written in, for the "Auto" choice. Lenient: it is only used on text
 * the person chose to run, and falls back to Brainfuck (which then explains what is missing).
 */
export function detectLanguage(src: string): Language {
  if (count(src, /\bOok[.?!]/gi) >= 2) return 'ook';
  if (count(src, /\bBlub[.?!]/gi) >= 2) return 'blub';
  if (cowTokens(src, 0.8) >= 3) return 'cow';
  const pika = pikalangWords(src);
  if (pika.known >= 3 && pika.known >= 0.9 * pika.words) return 'pikalang';
  const fish = deadfishVariantOf(src);
  if (fish) return fish;
  if (isNormalisedMalbolge(src)) return 'malbolge-normalized';
  if (isMalbolgeProgram(src)) return 'malbolge';
  if (maybeBefunge(src) && looksLikeBefunge(src)) return 'befunge';
  if (looksLikeShortOok(compactOf(src))) return 'short-ook';
  if (compactOf(src).length >= 8 && looksLikeAlphuck(compactOf(src))) return 'alphuck';
  // ReverseFuck uses the Brainfuck symbols, but its loops are written "]...[": the brackets only
  // pair up when read backwards.
  if (
    !bracketsPair(src, false) &&
    bracketsPair(src, true) &&
    count(src, /[-+<>.,]/g) >= 2 // not just a pair of stray brackets in a sentence
  ) {
    return 'reversefuck';
  }
  return 'brainfuck';
}

export interface Guess {
  language: Language;
  /** 0..1, same scale as the tool contract. */
  score: number;
  reason: string;
}

/** Strict version for the home page's triage: only speaks up when the text really looks like code. */
export function guessLanguage(sample: string): Guess | null {
  const t = sample.trim();
  if (count(t, /\bOok[.?!]/gi) >= 4) return { language: 'ook', score: 0.95, reason: 'Ook! words' };
  if (count(t, /\bBlub[.?!]/gi) >= 4) {
    return { language: 'blub', score: 0.95, reason: 'Blub words' };
  }
  if (cowTokens(t, 0.9) >= 6) {
    return { language: 'cow', score: 0.95, reason: 'COW instructions (moo, MOO, mOo…)' };
  }
  const pika = pikalangWords(t);
  if (pika.known >= 6 && pika.known >= 0.95 * pika.words) {
    return { language: 'pikalang', score: 0.9, reason: 'Pikalang words (pi, ka, pika, chu…)' };
  }
  const fish = compactOf(t).length >= 8 ? deadfishVariantOf(t) : null;
  if (fish) {
    return {
      language: fish,
      score: 0.7,
      reason: fish === 'deadfish' ? 'Only i d s o (Deadfish)' : 'Only x d k c (XKCD Deadfish)',
    };
  }
  if (isMalbolgeProgram(t, 12)) {
    return {
      language: 'malbolge',
      score: 0.9,
      reason: 'Every character is a valid Malbolge instruction at its position',
    };
  }
  if (isNormalisedMalbolge(t, 16)) {
    return { language: 'malbolge-normalized', score: 0.6, reason: 'Only i < / * j p o v' };
  }
  if (maybeBefunge(t) && looksLikeBefunge(t, true)) {
    return {
      language: 'befunge',
      score: 0.75,
      reason: 'A Befunge-93 grid made of instructions that prints something and reaches @',
    };
  }

  const compact = compactOf(t);
  if (compact.length < 16) return null;
  if (looksLikeShortOok(compact) && compact.includes('?') && compact.includes('!')) {
    return { language: 'short-ook', score: 0.7, reason: 'Only . ? ! (Short Ook)' };
  }
  const bf = (compact.match(/[-+<>[\].,]/g) ?? []).length;
  let depth = 0;
  let balanced = true;
  for (const ch of compact) {
    if (ch === '[') depth++;
    else if (ch === ']' && --depth < 0) balanced = false;
  }
  const looksLikeCode = compact.includes('[') || (/\+/.test(compact) && /[<>]/.test(compact));
  if (!(balanced && depth === 0) && bracketsPair(compact, true) && bf / compact.length >= 0.9) {
    return {
      language: 'reversefuck',
      score: 0.8,
      reason: 'Only Brainfuck symbols, and the loops are written ]…[ (ReverseFuck)',
    };
  }
  if (balanced && depth === 0 && looksLikeCode) {
    const ratio = bf / compact.length;
    if (ratio >= 0.9) {
      return { language: 'brainfuck', score: 0.9, reason: 'Only Brainfuck symbols' };
    }
    if (ratio >= 0.75) {
      return { language: 'brainfuck', score: 0.55, reason: 'Mostly Brainfuck symbols' };
    }
  }
  if (compact.length >= 24 && looksLikeAlphuck(compact)) {
    return {
      language: 'alphuck',
      score: 0.5,
      reason: 'Only the letters a c e i j o p s (Alphuck)',
    };
  }
  return null;
}
