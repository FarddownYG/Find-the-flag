import { FITNESS_SCALE, quadTable } from './_fitness';
import { gcd, type Matrix } from './_hill';

/**
 * Ciphertext-only attack on a 2 x 2 Hill cipher modulo 26: try every invertible matrix (157,248
 * of them), decrypt the first letters with it and keep the matrices whose plaintext has the best
 * quadgram score (the English table of the substitution solver, or a French one). Deterministic.
 *
 * Decrypting with M and encrypting with M^-1 are the same cipher, and the invertible matrices are
 * closed under inversion, so the search runs over decrypting matrices M and the key is M^-1.
 */

export interface CrackCandidate {
  /** The decrypting matrix. */
  matrix: Matrix;
  /** Quadgram score of the decrypted letters searched. */
  score: number;
}

export interface CrackResult {
  candidates: CrackCandidate[];
  /** Matrices tried: the number of invertible 2 x 2 matrices modulo 26. */
  tried: number;
  /** Letters the matrices were scored on. */
  letters: number;
}

/** Letters used to rank the matrices; the best few are then looked at on more. */
export const CRACK_LETTERS = 240;

const UNIT = Array.from({ length: 26 }, (_, d) => gcd(d, 26) === 1);

/** Decrypting matrices [a b; c d] by decreasing score, ties by the matrix itself. */
export function crackHill2(
  codes: ArrayLike<number>,
  options: { keep?: number; table?: Int16Array } = {},
): CrackResult {
  const keep = options.keep ?? 12;
  const table = options.table ?? quadTable();
  const letters = Math.min(codes.length, CRACK_LETTERS) & ~1;
  const pairs = letters / 2;
  if (pairs < 6) return { candidates: [], tried: 0, letters };

  // row[a*26+b][i] = a x_i + b y_i mod 26: the first letter of pair i under the row (a, b).
  const row = new Uint8Array(676 * pairs);
  for (let a = 0; a < 26; a++) {
    for (let b = 0; b < 26; b++) {
      const base = (a * 26 + b) * pairs;
      for (let i = 0; i < pairs; i++) {
        row[base + i] = (a * codes[2 * i]! + b * codes[2 * i + 1]!) % 26;
      }
    }
  }

  const best: CrackCandidate[] = [];
  const buf = new Uint8Array(letters);
  let tried = 0;
  for (let a = 0; a < 26; a++) {
    for (let b = 0; b < 26; b++) {
      const top = (a * 26 + b) * pairs;
      for (let c = 0; c < 26; c++) {
        for (let d = 0; d < 26; d++) {
          if (!UNIT[(a * d - b * c + 676) % 26]) continue;
          tried++;
          const bottom = (c * 26 + d) * pairs;
          for (let i = 0; i < pairs; i++) {
            buf[2 * i] = row[top + i]!;
            buf[2 * i + 1] = row[bottom + i]!;
          }
          let score = 0;
          for (let i = 0; i + 3 < letters; i++) {
            score += table[buf[i]! * 17576 + buf[i + 1]! * 676 + buf[i + 2]! * 26 + buf[i + 3]!]!;
          }
          if (best.length < keep || score > best[best.length - 1]!.score) {
            best.push({
              matrix: [
                [a, b],
                [c, d],
              ],
              score,
            });
            best.sort((x, y) => y.score - x.score);
            if (best.length > keep) best.pop();
          }
        }
      }
    }
  }
  return { candidates: best, tried, letters };
}

/** Average log10 probability per quadgram of letters with this scaled score. */
export const crackFitness = (score: number, letters: number): number =>
  score / FITNESS_SCALE / (letters - 3);
