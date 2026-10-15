/**
 * The homoglyph channel of "Hidden Unicode text": which letters of a text were swapped for a
 * lookalike, what the pattern of swaps hides, and the encoder that hides a message that way.
 *
 * Readings of a text with swapped letters (the swapped ones are "replaced", the others "kept"):
 *  - letters:      the ASCII letters the replaced characters imitate, in order ("flag");
 *  - replaceable:  one bit per letter that the encoder below can replace (replaced = 1, kept = 0),
 *                  MSB first into bytes; this is what "Hide a message" writes;
 *  - seen:         the same, over the letters that were replaced at least once in this text (a
 *                  foreign encoder may only swap a, e, o, p, c...);
 *  - all:          the same, over all the letters.
 * Each bit reading is also tried with the opposite polarity (replaced = 0). The plain carriers
 * after the message read as zero bytes and are cut off.
 */
import { readability } from './_zerowidth';
import { readability as languageReadability } from '../../lib/readability';
import { imitates, scanText, toCodePoints, type Scan } from './_unicode-hidden-scan';
import { isReadable, packBits, textOfBytes, trimTail } from './_unicode-hidden-read';
import type { UnicodeData } from './_unicode-lookup';

// ---------- the substitutes the encoder uses ----------

/**
 * Blocks the encoder takes substitutes from, best first. Cyrillic and Greek letters are what
 * people use; the others are Unicode's lookalikes in Armenian, Cherokee and the Latin
 * extensions (IPA). Fullwidth, mathematical, letterlike and enclosed forms look different in
 * every font, so they are never used.
 */
const BLOCK_RANK: [RegExp, number][] = [
  [/^Cyrillic/, 0],
  [/^Greek/, 1],
  [/^Armenian$/, 2],
  [/^Cherokee/, 3],
  [/^(IPA Extensions|Latin Extended|Phonetic Extensions)/, 4],
  [/^Coptic$/, 5],
];

export interface Substitutes {
  /** The substitute code point of each ASCII letter that has one. */
  byLetter: ReadonlyMap<string, number>;
  /** The letters that can be swapped: their keys. */
  replaceable: ReadonlySet<string>;
}

const cache = new WeakMap<UnicodeData, Substitutes>();

/**
 * One substitute per ASCII letter, taken from the confusables data (UTS #39, type MA).
 * The rule: a non-ASCII letter of the same case (Lu for capitals, Ll for small letters) whose
 * skeleton is the skeleton of the ASCII letter, and which reads back as that letter (the
 * skeleton "l" stands for I and l, "O" for O and 0, so case decides); among those, the lowest
 * block rank of BLOCK_RANK (Cyrillic, then Greek, Armenian, Cherokee, Latin extensions,
 * Coptic), then the lowest code point.
 */
export function substitutesOf(data: UnicodeData): Substitutes {
  const known = cache.get(data);
  if (known) return known;
  const best = new Map<string, { cp: number; rank: number }>();
  for (const [cp, skeleton] of data.skeleton) {
    if (skeleton.length !== 1 || data.compat.has(cp)) continue;
    const category = data.category(cp);
    if (category !== 'Lu' && category !== 'Ll') continue;
    const letter = imitates(data, category, cp);
    if (letter === null || !/^[A-Za-z]$/.test(letter)) continue;
    // Same case as the letter it replaces, or it would look different.
    if ((category === 'Lu') !== (letter === letter.toUpperCase())) continue;
    const rank = BLOCK_RANK.find(([re]) => re.test(data.block(cp)))?.[1];
    if (rank === undefined) continue;
    const prev = best.get(letter);
    if (!prev || rank < prev.rank || (rank === prev.rank && cp < prev.cp)) {
      best.set(letter, { cp, rank });
    }
  }
  const byLetter = new Map([...best].map(([letter, v]) => [letter, v.cp]));
  const result = { byLetter, replaceable: new Set(byLetter.keys()) };
  cache.set(data, result);
  return result;
}

// ---------- reading a text ----------

export type GlyphReadingId = 'letters' | 'replaceable' | 'seen' | 'all';

export interface GlyphReading {
  id: GlyphReadingId;
  /** Polarity: replaced = 0 instead of 1. */
  inverse: boolean;
  text: string;
  bytes: Uint8Array;
  /** Letters of the text this reading looked at. */
  carriers: number;
  /** Bits read (carriers, for the bit readings). */
  bits: number;
  score: number;
  readable: boolean;
}

/** The letter positions of a scan: the letter (char code) and whether it was replaced. */
export interface LetterStream {
  letter: Uint8Array;
  replaced: Uint8Array;
  /** Code point index of each letter. */
  index: Uint32Array;
}

export function letterStream(scan: Scan): LetterStream {
  const n = scan.cps.length;
  const letter = new Uint8Array(n);
  const replaced = new Uint8Array(n);
  const index = new Uint32Array(n);
  let count = 0;
  let h = 0;
  for (let i = 0; i < n; i++) {
    const cp = scan.cps[i]!;
    if (h < scan.hitIndex.length && scan.hitIndex[h] === i) {
      const code = scan.hitLetter[h]!.charCodeAt(0);
      h++;
      if (code > 57) {
        letter[count] = code;
        replaced[count] = 1;
        index[count++] = i;
      }
    } else if ((cp | 0x20) >= 97 && (cp | 0x20) <= 122 && cp < 0x80) {
      letter[count] = cp;
      index[count++] = i;
    }
  }
  return {
    letter: letter.subarray(0, count),
    replaced: replaced.subarray(0, count),
    index: index.subarray(0, count),
  };
}

/** Most letters a bit reading looks at (a payload of 16 KiB), and letters scored as words. */
const MAX_LETTERS = 131_072;
const MAX_WORD_LETTERS = 2000;

function bitReading(
  id: GlyphReadingId,
  stream: LetterStream,
  pick: (i: number) => boolean,
  inverse: boolean,
): GlyphReading | null {
  const bits: number[] = [];
  for (let i = 0; i < stream.letter.length && bits.length < MAX_LETTERS; i++) {
    if (pick(i)) bits.push(stream.replaced[i]! ^ (inverse ? 1 : 0));
  }
  if (bits.length < 16) return null;
  const bytes = trimTail(packBits(bits), inverse ? 0xff : 0);
  if (bytes.length < 2) return null;
  const text = textOfBytes(bytes);
  if (text === null) return null;
  return {
    id,
    inverse,
    text,
    bytes,
    carriers: bits.length,
    bits: bytes.length * 8,
    score: readability(text),
    readable: isReadable(text, 'generic'),
  };
}

/**
 * Every reading of the pattern of swapped letters, readable ones first, then by readability.
 * Empty when no letter was swapped.
 */
export function glyphReadings(scan: Scan, data: UnicodeData): GlyphReading[] {
  if (!scan.hitIndex.length) return [];
  const out: GlyphReading[] = [];

  const letters = scan.hitLetter.slice(0, MAX_LETTERS / 8).join('');
  if (letters.length >= 2) {
    // The swapped letters themselves: only dictionary words count, any letters score the same.
    const words = languageReadability(letters.slice(0, MAX_WORD_LETTERS).toLowerCase());
    out.push({
      id: 'letters',
      inverse: false,
      text: letters,
      bytes: new TextEncoder().encode(letters),
      carriers: letters.length,
      bits: letters.length * 8,
      score: readability(letters),
      // Seven letters or more that are all dictionary words: by chance, 3 in 1000 at most.
      readable: letters.length >= 7 && /^[A-Za-z]+$/.test(letters) && words.coverage >= 0.95,
    });
  }

  const stream = letterStream(scan);
  const { replaceable } = substitutesOf(data);
  const seen = new Set<number>();
  for (let i = 0; i < stream.letter.length; i++) {
    if (stream.replaced[i]) seen.add(stream.letter[i]!);
  }
  const picks: [GlyphReadingId, (i: number) => boolean][] = [
    ['replaceable', (i) => replaceable.has(String.fromCharCode(stream.letter[i]!))],
    ['seen', (i) => seen.has(stream.letter[i]!)],
    ['all', () => true],
  ];
  for (const [id, pick] of picks) {
    for (const inverse of [false, true]) {
      const reading = bitReading(id, stream, pick, inverse);
      if (reading) out.push(reading);
    }
  }

  // The same text found by several readings is listed once, by the first (most specific) one.
  const seenText = new Set<string>();
  return out
    .map((r, i) => ({ r, i }))
    .sort(
      (a, b) => Number(b.r.readable) - Number(a.r.readable) || b.r.score - a.r.score || a.i - b.i,
    )
    .map(({ r }) => r)
    .filter((r) => {
      if (seenText.has(r.text)) return false;
      seenText.add(r.text);
      return true;
    });
}

/** The text with every lookalike replaced by the character it imitates. */
export function normalizeText(scan: Scan): string {
  const out: string[] = [];
  let h = 0;
  for (let i = 0; i < scan.cps.length; i++) {
    if (h < scan.hitIndex.length && scan.hitIndex[h] === i) out.push(scan.hitLetter[h++]!);
    else out.push(String.fromCodePoint(scan.cps[i]!));
  }
  return out.join('');
}

/**
 * The bytes the encoder hid in a text: one bit per replaceable letter, replaced = 1, MSB first,
 * without the zero bytes of the plain carriers after the message. Null when the text has fewer
 * than 8 such letters. What "Hide a message" checks its result with.
 */
export function readReplaceable(scan: Scan, data: UnicodeData): Uint8Array | null {
  const stream = letterStream(scan);
  const { replaceable } = substitutesOf(data);
  const bits: number[] = [];
  for (let i = 0; i < stream.letter.length; i++) {
    if (replaceable.has(String.fromCharCode(stream.letter[i]!))) bits.push(stream.replaced[i]!);
  }
  return bits.length < 8 ? null : trimTail(packBits(bits), 0);
}

// ---------- the encoder ----------

export type HideResult =
  | { ok: true; text: string; capacity: number; bits: number; normalized: number }
  | { ok: false; needed: number; have: number };

/**
 * Hide `secret` in the letters of `cover`: one bit per replaceable letter, replaced = 1,
 * MSB first. A cover that already has lookalike letters is normalised first, so that every
 * swap in the result is a bit. Letters after the last bit stay as they are (zero bits).
 */
export function hideInGlyphs(cover: string, secret: Uint8Array, data: UnicodeData): HideResult {
  const scan = scanText(cover, data);
  const plain = normalizeText(scan);
  const cps = toCodePoints(plain);
  const { byLetter } = substitutesOf(data);
  const positions: number[] = [];
  for (let i = 0; i < cps.length; i++) {
    const cp = cps[i]!;
    if (cp < 0x80 && byLetter.has(String.fromCharCode(cp))) positions.push(i);
  }
  const needed = secret.length * 8;
  if (needed > positions.length) return { ok: false, needed, have: positions.length };
  const out = Array.from(cps);
  for (let b = 0; b < needed; b++) {
    if (((secret[b >> 3]! >> (7 - (b & 7))) & 1) === 0) continue;
    const at = positions[b]!;
    out[at] = byLetter.get(String.fromCharCode(cps[at]!))!;
  }
  const text = out.map((cp) => String.fromCodePoint(cp)).join('');
  return {
    ok: true,
    text,
    capacity: positions.length,
    bits: needed,
    normalized: scan.hitIndex.length,
  };
}
