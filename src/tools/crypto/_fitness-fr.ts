import { FR_WORDS } from '../../lib/wordlists/fr';
import { makeRng } from './_classical';
import { FITNESS_SCALE } from './_fitness';

/**
 * French quadgram log-probabilities for the key-recovery solvers, in the same layout as the
 * English table of _fitness.ts (index ((a*26+b)*26+c)*26+d, 100 * log10 P, accents folded).
 *
 * There is no French n-gram corpus in the project, so none is added: the table is derived on first
 * use from the ~5000 French word forms the readability score already ships (src/lib/wordlists/fr),
 * by reading a fixed-seed random text in which each word is drawn with probability proportional to
 * 1/rank (Zipf's law), spaces removed. Word boundaries are therefore covered too. Quadgrams seen
 * fewer than 3 times are estimated from the trigram and bigram counts, as in the English table,
 * and capped just below the rarest counted quadgram.
 */

const SAMPLE_LETTERS = 1_200_000;
const MIN_COUNT = 3;

let table: Int16Array | null = null;

/** a-z letters of a word, accents and ligatures folded (é -> e, œ -> oe). */
function letters(word: string): number[] {
  const out: number[] = [];
  const folded = word
    .toLowerCase()
    .replace(/œ/g, 'oe')
    .replace(/æ/g, 'ae')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '');
  for (let i = 0; i < folded.length; i++) {
    const c = folded.charCodeAt(i);
    if (c >= 97 && c <= 122) out.push(c - 97);
  }
  return out;
}

export function frenchQuadTable(): Int16Array {
  if (table) return table;
  const words = FR_WORDS.split(/\s+/)
    .map(letters)
    .filter((w) => w.length > 0);
  const cumulative = new Float64Array(words.length);
  let total = 0;
  for (let i = 0; i < words.length; i++) {
    total += 1 / (i + 1);
    cumulative[i] = total;
  }
  const rng = makeRng(0xf12e4c);
  const quads = new Float64Array(26 ** 4);
  let n = 0;
  let a = 0;
  let b = 0;
  let c = 0;
  let seen = 0;
  while (n < SAMPLE_LETTERS) {
    const x = rng() * total;
    let lo = 0;
    let hi = words.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cumulative[mid]! < x) lo = mid + 1;
      else hi = mid;
    }
    for (const d of words[lo]!) {
      if (seen >= 3) quads[((a * 26 + b) * 26 + c) * 26 + d]!++;
      a = b;
      b = c;
      c = d;
      seen++;
      n++;
    }
  }
  const tri = new Float64Array(26 ** 3);
  for (let i = 0; i < quads.length; i++) tri[Math.floor(i / 26)]! += quads[i]!;
  const bi = new Float64Array(26 ** 2);
  for (let i = 0; i < tri.length; i++) bi[Math.floor(i / 26)]! += tri[i]!;

  const lp = (count: number) => Math.log10(count / n);
  const floor = lp(0.5) - 1.5;
  const cap = lp(MIN_COUNT) - 0.25;
  const t = new Int16Array(26 ** 4);
  for (let abc = 0; abc < 26 ** 3; abc++) {
    const bc = abc % 676;
    for (let d = 0; d < 26; d++) {
      const idx = abc * 26 + d;
      const count = quads[idx]!;
      let v: number;
      if (count >= MIN_COUNT) v = lp(count);
      else {
        const left = tri[abc]!;
        const right = tri[bc * 26 + d]!;
        const mid = bi[bc]!;
        v = left > 0 && right > 0 && mid > 0 ? lp(left) + lp(right) - lp(mid) : floor;
        v = Math.max(floor, Math.min(v, cap));
      }
      t[idx] = Math.round(v * FITNESS_SCALE);
    }
  }
  table = t;
  return t;
}
