import {
  BIGRAMS,
  BI_LOW,
  BI_STEP,
  QUADGRAM_LEVELS,
  QUAD_CUTOFF,
  QUAD_LOW,
  QUAD_STEP,
  TRIGRAMS,
  TRI_LOW,
  TRI_STEP,
} from './_ngrams';
import { plaintextScore } from '../../lib/english';

/**
 * English fitness from quadgram log-probabilities (letters only, A-Z).
 * The compact statistics in _ngrams.ts are expanded once into a dense table of
 * 26^4 entries holding round(100 * log10 P). Quadgrams missing from the list are estimated
 * from the trigram and bigram tables (P(abcd) ~ P(abc) P(bcd) / P(bc)) and capped just below
 * the rarest listed quadgram, so the score has no flat plateaus for a hill climber to get lost in.
 */

const B64 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz+/';
const SCALE = 100;
const FLOOR = QUAD_CUTOFF - 3.5;

let table: Int16Array | null = null;

/** Scaled log10 probability of every quadgram, index = ((a·26+b)·26+c)·26+d. */
export function quadTable(): Int16Array {
  if (table) return table;
  const tri = new Float64Array(26 * 26 * 26);
  for (let i = 0; i < tri.length; i++) {
    const lv = B64.indexOf(TRIGRAMS[i]!);
    tri[i] = lv === 0 ? TRI_LOW - 0.5 : TRI_LOW + (lv - 1) * TRI_STEP;
  }
  const bi = new Float64Array(26 * 26);
  for (let i = 0; i < bi.length; i++) {
    const lv = B64.indexOf(BIGRAMS[i]!);
    bi[i] = lv === 0 ? BI_LOW - 0.5 : BI_LOW + (lv - 1) * BI_STEP;
  }
  const t = new Int16Array(26 ** 4);
  for (let abc = 0; abc < 26 ** 3; abc++) {
    const bc = abc % 676;
    for (let d = 0; d < 26; d++) {
      const bcd = bc * 26 + d;
      const est = Math.max(FLOOR, Math.min(tri[abc]! + tri[bcd]! - bi[bc]!, QUAD_CUTOFF - 0.25));
      t[abc * 26 + d] = Math.round(est * SCALE);
    }
  }
  for (const [level, quads] of QUADGRAM_LEVELS) {
    const v = Math.round((QUAD_LOW + level * QUAD_STEP) * SCALE);
    for (let i = 0; i + 4 <= quads.length; i += 4) {
      const idx =
        (((quads.charCodeAt(i) - 65) * 26 + quads.charCodeAt(i + 1) - 65) * 26 +
          quads.charCodeAt(i + 2) -
          65) *
          26 +
        quads.charCodeAt(i + 3) -
        65;
      t[idx] = v;
    }
  }
  table = t;
  return t;
}

/** Letters of the text as codes 0..25 (case-insensitive, everything else dropped). */
export function toCodes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i) | 0x20;
    if (c >= 97 && c <= 122) out[n++] = c - 97;
  }
  return out.subarray(0, n);
}

/** Sum of scaled quadgram log-probabilities over the code sequence. */
export function quadSum(codes: ArrayLike<number>): number {
  const t = quadTable();
  let sum = 0;
  for (let i = 0; i + 3 < codes.length; i++) {
    sum += t[((codes[i]! * 26 + codes[i + 1]!) * 26 + codes[i + 2]!) * 26 + codes[i + 3]!]!;
  }
  return sum;
}

/** Average log10 probability per quadgram of the letters (about -4.3 for English, -7.5 for noise). */
export function fitness(text: string): number {
  const codes = toCodes(text);
  if (codes.length < 4) return -Infinity;
  return quadSum(codes) / SCALE / (codes.length - 3);
}

/** 0..100 "does this read like English" from the quadgram fitness (needs 8+ letters, else 0). */
export function englishness(text: string): number {
  const f = fitness(text);
  if (!Number.isFinite(f) || toCodes(text).length < 8) return 0;
  return Math.max(0, Math.min(100, ((f + 7.2) / 3.0) * 100));
}

/**
 * Ranking score 0..100 for brute-force candidates: letter statistics and common words
 * (plaintextScore) plus quadgram fitness. plaintextScore alone saturates at 100 and cannot
 * tell a transposition's right arrangement, or an over-fitted long key, from the real answer.
 */
export function rankScore(text: string): number {
  return 0.4 * plaintextScore(text) + 0.6 * englishness(text);
}

export const FITNESS_SCALE = SCALE;
