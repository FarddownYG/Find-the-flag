import { FITNESS_SCALE, quadTable, toCodes } from './_fitness';
import { makeRng } from './_classical';

/**
 * Monoalphabetic substitution solver: iterated hill climbing on quadgram log-probabilities
 * with random restarts. Deterministic (seeded PRNG, work measured in evaluations, never in time).
 */

const ENGLISH_ORDER = 'ETAOINSHRDLCUMWFGYPBVKJXQZ';

export interface SubstitutionSolution {
  /** map[c] = plaintext letter (0..25) for cipher letter c; a permutation of 0..25. */
  map: Uint8Array;
  /** Average log10 probability per quadgram of the decrypted letters. */
  fitness: number;
  /** Number of letters the solution is based on. */
  letters: number;
}

function scoreMap(c: Uint8Array, m: Uint8Array, t: Int16Array): number {
  const n = c.length;
  let sum = 0;
  let a = m[c[0]!]!;
  let b = m[c[1]!]!;
  let d = m[c[2]!]!;
  for (let i = 3; i < n; i++) {
    const e = m[c[i]!]!;
    sum += t[((a * 26 + b) * 26 + d) * 26 + e]!;
    a = b;
    b = d;
    d = e;
  }
  return sum;
}

function frequencyMap(counts: number[]): Uint8Array {
  const order = counts
    .map((n, letter) => ({ n, letter }))
    .sort((x, y) => y.n - x.n || x.letter - y.letter);
  const map = new Uint8Array(26);
  order.forEach(({ letter }, rank) => {
    map[letter] = ENGLISH_ORDER.charCodeAt(rank) - 65;
  });
  return map;
}

/** Solve a substitution cipher given the cipher letters as codes 0..25. */
export function solveCodes(
  cipher: Uint8Array,
  options: { budget?: number; seed?: number } = {},
): SubstitutionSolution {
  const t = quadTable();
  const letters = cipher.length;
  const identity = Uint8Array.from({ length: 26 }, (_, i) => i);
  if (letters < 4) return { map: identity, fitness: -Infinity, letters };

  // Search on a prefix for long texts, then polish on everything.
  const SEARCH_MAX = 1200;
  const work = letters > SEARCH_MAX ? cipher.subarray(0, SEARCH_MAX) : cipher;
  const counts = new Array<number>(26).fill(0);
  for (const c of work) counts[c]!++;
  const present: number[] = [];
  counts.forEach((n, i) => {
    if (n > 0) present.push(i);
  });

  const rng = makeRng(options.seed ?? 0x5eed);
  let evals = 0;
  const maxEvals = Math.max(3000, Math.floor((options.budget ?? 90_000_000) / work.length));

  /** Swap-based hill climb: try every pair of cipher letters until nothing improves. */
  function climb(map: Uint8Array): number {
    let best = scoreMap(work, map, t);
    let improved = true;
    while (improved && evals < maxEvals) {
      improved = false;
      for (let x = 0; x < 26; x++) {
        for (let y = x + 1; y < 26; y++) {
          if (!counts[x]! && !counts[y]!) continue;
          const mx = map[x]!;
          map[x] = map[y]!;
          map[y] = mx;
          const s = scoreMap(work, map, t);
          evals++;
          if (s > best) {
            best = s;
            improved = true;
          } else {
            map[y] = map[x]!;
            map[x] = mx;
          }
        }
      }
    }
    return best;
  }

  function randomMap(): Uint8Array {
    const m = Uint8Array.from({ length: 26 }, (_, i) => i);
    for (let i = 25; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = m[i]!;
      m[i] = m[j]!;
      m[j] = tmp;
    }
    return m;
  }

  let bestMap = frequencyMap(counts);
  let bestScore = climb(bestMap);
  let stagnation = 0;
  let restarts = 0;
  const STAGNATION_LIMIT = 30;
  const MIN_RESTARTS = 3;

  while (evals < maxEvals) {
    let cand: Uint8Array;
    if (stagnation > 0 && stagnation % 12 === 0) {
      cand = randomMap();
      restarts++;
    } else {
      cand = bestMap.slice();
      const swaps = 2 + Math.floor(rng() * 3);
      for (let k = 0; k < swaps; k++) {
        const x = present[Math.floor(rng() * present.length)]!;
        const y = Math.floor(rng() * 26);
        const tmp = cand[x]!;
        cand[x] = cand[y]!;
        cand[y] = tmp;
      }
    }
    const s = climb(cand);
    if (s > bestScore) {
      bestScore = s;
      bestMap = cand;
      stagnation = 0;
    } else {
      stagnation++;
    }
    if (stagnation >= STAGNATION_LIMIT && restarts >= MIN_RESTARTS) break;
  }

  if (work !== cipher) {
    // polish on the whole text
    const full = cipher;
    let cur = scoreMap(full, bestMap, t);
    let improved = true;
    while (improved) {
      improved = false;
      for (let x = 0; x < 26; x++) {
        for (let y = x + 1; y < 26; y++) {
          const mx = bestMap[x]!;
          bestMap[x] = bestMap[y]!;
          bestMap[y] = mx;
          const s = scoreMap(full, bestMap, t);
          if (s > cur) {
            cur = s;
            improved = true;
          } else {
            bestMap[y] = bestMap[x]!;
            bestMap[x] = mx;
          }
        }
      }
    }
  }
  const total = scoreMap(cipher, bestMap, t);
  return { map: bestMap, fitness: total / FITNESS_SCALE / (letters - 3), letters };
}

/** Solve from raw text (letters only are used). */
export function solveText(text: string, options?: { budget?: number; seed?: number }) {
  return solveCodes(toCodes(text), options);
}
