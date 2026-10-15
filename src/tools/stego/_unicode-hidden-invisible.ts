/**
 * The invisible-character channel of "Hidden Unicode text": which characters carry data, every
 * reading of them, and the encoder.
 *
 * The readings come from the zero-width tool's engine (decodeAll in _zerowidth.ts): the tag
 * characters as ASCII, the variation selectors as bytes, the 330k scheme, any 2 to 5 invisible
 * characters as the digits of a number, three symbols as separator and bits, Morse, and two
 * kinds of space as bits. This module adds what that engine does not do by itself:
 *  - it feeds the engine only the characters that can carry data, never an emoji's variation
 *    selector, a joiner a script needs, a leading byte order mark or a French no-break space;
 *  - when three or more of ZWSP, ZWNJ, ZWJ, BOM and the word joiner occur, it also reads every
 *    pair of them alone (the third symbol may be noise or a separator);
 *  - it decides which readings are readable text (see _unicode-hidden-read.ts), and puts those
 *    first.
 */
import {
  CODE_330K,
  classify,
  decodeAll,
  embedPayload,
  encodePayload,
  type Candidate,
  type Placement,
} from './_zerowidth';
import { readability as languageReadability } from '../../lib/readability';
import { kindOfFlag, type Scan } from './_unicode-hidden-scan';
import { isReadable, type Strength } from './_unicode-hidden-read';

/** The symbols of a binary zero-width message. */
export const BINARY_SYMBOLS = [0x200b, 0x200c, 0x200d, 0x2060, 0xfeff];

/** Most carriers read at once: longer streams are read from their start. */
export const MAX_CARRIERS = 40_000;
/** Most spaces read at once for the two-kinds-of-space reading. */
const MAX_SPACES = 30_000;

export interface InvisibleReading extends Candidate {
  strength: Strength;
  readable: boolean;
  /** Bits of the hidden message. */
  bits: number;
}

export interface InvisibleAnalysis {
  /** Positions of the characters that can carry data, in order. */
  carriers: number[];
  /** Occurrences of each carrier code point. */
  distinct: Map<number, number>;
  /** How many carriers were read (the first MAX_CARRIERS). */
  read: number;
  /** Characters of an emoji, a script or a BOM at the start: listed, not read. */
  inPlace: number;
  readings: InvisibleReading[];
  /** The best readable reading, if any. */
  best: InvisibleReading | null;
}

const strengthOf = (id: Candidate['id']): Strength =>
  id === 'tags' ? 'tags' : id === 'variation' || id === '330k' ? 'specific' : 'generic';

const fromPoints = (points: number[]): string => {
  let out = '';
  for (let i = 0; i < points.length; i += 8192) {
    out += String.fromCodePoint(...points.slice(i, i + 8192));
  }
  return out;
};

/**
 * A Morse reading is made of the shortest codes (E, T, I, M, S, H, O) whatever the symbols are, so
 * the evidence of its letters means nothing: it needs dictionary words instead.
 */
function morseReadable(text: string): boolean {
  return /^[A-Z0-9 ]{7,}$/.test(text) && languageReadability(text.toLowerCase()).coverage >= 0.95;
}

/** Orderings of k symbols that the engine tries as digits, relative to two symbols: k! / 2. */
const orderings = (k: number) => (k <= 2 ? 1 : [1, 1, 1, 3, 12, 60][Math.min(k, 5)]!);

function toReading(c: Candidate, symbols: number, weight = 1): InvisibleReading {
  const strength = strengthOf(c.id);
  const tries = strength === 'generic' ? orderings(symbols) : 1;
  return {
    ...c,
    score: c.score * weight,
    strength,
    readable:
      c.id === 'morse' ? morseReadable(c.text) : isReadable(c.text, strength, c.unitValues, tries),
    bits: c.bytes.length * 8,
  };
}

/** Read the characters of the scan that can carry data. */
export function readInvisibles(scan: Scan): InvisibleAnalysis {
  const carriers: number[] = [];
  let inPlace = 0;
  let unusualSpaces = 0;
  scan.flagIndex.forEach((index, k) => {
    const flag = scan.flagKind[k]!;
    const kind = kindOfFlag(flag);
    if (kind === 'invisible' || kind === 'control') carriers.push(index);
    else if (kind === 'inplace') inPlace++;
    else unusualSpaces++;
  });
  const distinct = new Map<number, number>();
  for (const index of carriers) {
    const cp = scan.cps[index]!;
    distinct.set(cp, (distinct.get(cp) ?? 0) + 1);
  }
  const used = carriers.slice(0, MAX_CARRIERS);
  const stream = used.map((index) => scan.cps[index]!);
  const readings: InvisibleReading[] = [];

  if (stream.length) {
    // The 330k scheme writes all four of its digits; a reading that uses two of them is the
    // base-k reading of those two (listed anyway), never a 330k message.
    const complete = CODE_330K.every((cp) => distinct.has(cp));
    for (const c of decodeAll(fromPoints(stream))) {
      if (c.id !== '330k' || complete) readings.push(toReading(c, distinct.size));
    }
    // Three or more binary symbols: any two of them may be the pair.
    const present = BINARY_SYMBOLS.filter((cp) => stream.includes(cp));
    if (present.length >= 3) {
      present.forEach((a, i) => {
        for (const b of present.slice(i + 1)) {
          const pair = stream.filter((cp) => cp === a || cp === b);
          const weight = pair.length / stream.length;
          for (const c of decodeAll(fromPoints(pair))) {
            if (c.id === 'base-k') readings.push(toReading(c, 2, weight));
          }
        }
      });
    }
  }

  // Two kinds of space as bits: only when some space is unusual and not typographic.
  if (unusualSpaces) {
    const typographic = new Set<number>();
    scan.flagIndex.forEach((index, k) => {
      if (scan.flagKind[k] === 'typographic') typographic.add(index);
    });
    const spaces: number[] = [];
    for (let i = 0; i < scan.cps.length && spaces.length < MAX_SPACES; i++) {
      const cp = scan.cps[i]!;
      if (
        cp === 0x20 ||
        (cp >= 0x80 && classify(cp, true)?.kind === 'space' && !typographic.has(i))
      ) {
        spaces.push(cp);
      }
    }
    for (const c of decodeAll(fromPoints(spaces))) {
      if (c.id === 'spaces') readings.push(toReading(c, 2));
    }
  }

  // Readable first, then by readability; one reading per text (the first, most specific one).
  const seen = new Set<string>();
  const ranked = readings
    .map((r, i) => ({ r, i }))
    .sort(
      (a, b) => Number(b.r.readable) - Number(a.r.readable) || b.r.score - a.r.score || a.i - b.i,
    )
    .map(({ r }) => r)
    .filter((r) => {
      if (seen.has(r.text)) return false;
      seen.add(r.text);
      return true;
    });
  return {
    carriers,
    distinct,
    read: used.length,
    inPlace,
    readings: ranked,
    best: ranked.find((r) => r.readable) ?? null,
  };
}

// ---------- the encoder ----------

/** Pairs offered by the encoder: the two symbols of the binary message (0 first, then 1). */
export const PAIRS: Record<string, [number, number]> = {
  'zwsp-zwnj': [0x200b, 0x200c],
  'zwnj-zwsp': [0x200c, 0x200b],
  'zwsp-zwj': [0x200b, 0x200d],
  'zwj-zwsp': [0x200d, 0x200b],
  'zwnj-zwj': [0x200c, 0x200d],
  'zwj-zwnj': [0x200d, 0x200c],
  'zwsp-wj': [0x200b, 0x2060],
  'wj-zwsp': [0x2060, 0x200b],
  'zwnj-wj': [0x200c, 0x2060],
  'zwj-wj': [0x200d, 0x2060],
  'zwsp-bom': [0x200b, 0xfeff],
  'zwnj-bom': [0x200c, 0xfeff],
};

export interface HideInvisible {
  text: string;
  /** Invisible characters written. */
  chars: number;
  bits: number;
}

/** Hide `secret` as zero-width binary (8 symbols per byte, MSB first) in `cover`. */
export function hideInInvisibles(
  cover: string,
  secret: string,
  pair: [number, number],
  placement: Placement,
): HideInvisible {
  const { units, chars } = encodePayload(secret, 'binary', pair);
  return {
    text: embedPayload(cover, units, placement),
    chars,
    bits: chars,
  };
}
