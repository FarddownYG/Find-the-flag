import { makeRng } from './_classical';
import { FITNESS_SCALE, quadTable } from './_fitness';
import { shortestKeyword, type SquareKind } from './_square';

/**
 * Key recovery for Playfair: simulated annealing on the 5 x 5 key square, scored with the same
 * English quadgram table as the substitution solver (_fitness.ts). Deterministic: the PRNG is
 * seeded and the work is counted in evaluations (one evaluation = decrypt the text with a square
 * and score it), never in milliseconds, so the same ciphertext always gives the same answer.
 *
 * What makes the search work:
 *  - Playfair squares are the same cipher up to a cyclic shift of rows and columns, so squares are
 *    compared in a canonical rotation.
 *  - Moves are mostly swaps of two cells, now and then a swap of two rows or columns, a flip of
 *    the rows, of the columns, or of the whole square (Cowan's move set).
 *  - Each restart anneals from a random square down to cold, then polishes with every improving
 *    swap. A restart that ends on plausible English is refined (re-annealed from a low
 *    temperature), because a square that is a few cells off still reads almost right. Two restarts
 *    that end on the same square also stop the search.
 *  - Long ciphertexts are searched on their first letters only and polished on a longer prefix:
 *    the cost of one evaluation stays bounded.
 */

type Kind5 = Exclude<SquareKind, 'digits'>;

/** Letters of the 5 x 5 squares: the alphabet minus J, or minus Q. */
const ALPHABETS: Record<Kind5, string> = {
  ij: 'ABCDEFGHIKLMNOPQRSTUVWXYZ',
  q: 'ABCDEFGHIJKLMNOPRSTUVWXYZ',
};

export interface SolveCandidate {
  /** The key square, 25 letters read row by row, in the most keyword-like rotation. */
  square: string;
  /** The shortest keyword that gives this square, or null when it is not a keyword square. */
  keyword: string | null;
  /** Quadgram score of the whole plaintext: sum of 100 * log10 P over its quadgrams. */
  score: number;
  /** Average log10 probability per quadgram (about -4.3 for English, -7.5 for noise). */
  fitness: number;
  /** The plaintext letters under this square, fillers still in place. */
  plain: string;
  /** Number of restarts that ended on this square. */
  hits: number;
}

export interface SolveResult {
  /** Best distinct squares first. */
  candidates: SolveCandidate[];
  /** Average fitness reached by each restart, in order (the progress of the search). */
  runs: number[];
  evaluations: number;
  restarts: number;
  /** The search stopped on plausible English or on a square found twice. */
  converged: boolean;
  /** Letters the key was searched on (the ciphertext may be longer). */
  searched: number;
}

export interface SolveOptions {
  kind?: Kind5;
  /** Evaluations to spend at most. */
  budget?: number;
  seed?: number;
  /** How many distinct squares to report. */
  keep?: number;
  /** Quadgram table to score with (index ((a*26+b)*26+c)*26+d, 100 * log10 P); English if absent. */
  table?: Int16Array;
  /** Annealing schedule (tuning and tests): start temperature, levels, moves per level. */
  schedule?: { start: number; steps: number; perStep: number };
}

/** Letters used while annealing, and while polishing. */
export const SEARCH_LETTERS = 300;
export const POLISH_LETTERS = 1500;

/**
 * Is this average fitness plausible language for a text of `letters` letters? Wrong squares end
 * around -5.4 to -6 on 200+ letters, the right one around -4.2 to -4.7. Shorter texts overfit
 * (a wrong square can read almost as well), so below 120 letters nothing is plausible by itself:
 * only a square found twice counts.
 */
export function isPlausible(fitness: number, letters: number): boolean {
  if (letters >= 200) return fitness > -5.05;
  if (letters >= 120) return fitness > -4.85;
  return false;
}

const CELLS = 25;
const ROW = new Uint8Array(CELLS);
const COL = new Uint8Array(CELLS);
const LEFT = new Uint8Array(CELLS);
const UP = new Uint8Array(CELLS);
for (let i = 0; i < CELLS; i++) {
  const r = Math.floor(i / 5);
  const c = i % 5;
  ROW[i] = r;
  COL[i] = c;
  LEFT[i] = r * 5 + ((c + 4) % 5);
  UP[i] = ((r + 4) % 5) * 5 + c;
}

/** The square shifted down by dr rows and right by dc columns. */
function shift(sq: ArrayLike<number>, dr: number, dc: number): number[] {
  const out = new Array<number>(CELLS);
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 5; c++) out[((r + dr) % 5) * 5 + ((c + dc) % 5)] = sq[r * 5 + c]!;
  }
  return out;
}

const toLetters = (codes: ArrayLike<number>): string =>
  Array.from({ length: codes.length }, (_, i) => String.fromCharCode(65 + codes[i]!)).join('');

/** The smallest of the 25 shifts, so that equivalent squares compare equal. */
export function canonicalSquare(square: string): string {
  const codes = [...square].map((ch) => ch.charCodeAt(0) - 65);
  let best = '';
  for (let dr = 0; dr < 5; dr++) {
    for (let dc = 0; dc < 5; dc++) {
      const s = toLetters(shift(codes, dr, dc));
      if (!best || s < best) best = s;
    }
  }
  return best;
}

/**
 * Longest keyword worth reporting: every square is "a keyword, then the rest in order" if the
 * keyword may be 20 letters long, which says nothing.
 */
const MAX_KEYWORD = 15;

/**
 * The shift of a square that reads like a keyword square (keyword, then the other letters in
 * order) with the shortest keyword; the canonical shift when no shift does.
 */
export function readableSquare(
  square: string,
  kind: Kind5,
): { square: string; keyword: string | null } {
  const codes = [...square].map((ch) => ch.charCodeAt(0) - 65);
  let best: { square: string; keyword: string } | null = null;
  for (let dr = 0; dr < 5; dr++) {
    for (let dc = 0; dc < 5; dc++) {
      const s = toLetters(shift(codes, dr, dc));
      const keyword = shortestKeyword(kind, [...s]);
      if (
        keyword !== null &&
        keyword.length <= MAX_KEYWORD &&
        (!best ||
          keyword.length < best.keyword.length ||
          (keyword.length === best.keyword.length && s < best.square))
      ) {
        best = { square: s, keyword };
      }
    }
  }
  return best ?? { square: canonicalSquare(square), keyword: null };
}

/** Decrypt Playfair ciphertext (letter codes, as pairs c1[i] c2[i]) with a square. */
export function decryptPairs(
  c1: ArrayLike<number>,
  c2: ArrayLike<number>,
  square: ArrayLike<number>,
  out: Uint8Array,
): void {
  const pos = new Uint8Array(26);
  for (let i = 0; i < CELLS; i++) pos[square[i]!] = i;
  for (let i = 0; i < c1.length; i++) {
    const a = pos[c1[i]!]!;
    const b = pos[c2[i]!]!;
    let x: number;
    let y: number;
    if (ROW[a] === ROW[b]) {
      x = square[LEFT[a]!]!;
      y = square[LEFT[b]!]!;
    } else if (COL[a] === COL[b]) {
      x = square[UP[a]!]!;
      y = square[UP[b]!]!;
    } else {
      x = square[ROW[a]! * 5 + COL[b]!]!;
      y = square[ROW[b]! * 5 + COL[a]!]!;
    }
    out[2 * i] = x;
    out[2 * i + 1] = y;
  }
}

/** A scorer for the first `pairs` pairs: quadgram score of the plaintext a square gives. */
function makeScorer(
  c1: Uint8Array,
  c2: Uint8Array,
  pairs: number,
  counter: { n: number },
  quad: Int16Array,
) {
  const n = pairs * 2;
  const plain = new Uint8Array(n);
  const pos = new Uint8Array(26);
  return (sq: Uint8Array): number => {
    for (let i = 0; i < CELLS; i++) pos[sq[i]!] = i;
    for (let i = 0; i < pairs; i++) {
      const a = pos[c1[i]!]!;
      const b = pos[c2[i]!]!;
      const ra = ROW[a]!;
      const rb = ROW[b]!;
      let x: number;
      let y: number;
      if (ra === rb) {
        x = sq[LEFT[a]!]!;
        y = sq[LEFT[b]!]!;
      } else if (COL[a] === COL[b]) {
        x = sq[UP[a]!]!;
        y = sq[UP[b]!]!;
      } else {
        x = sq[ra * 5 + COL[b]!]!;
        y = sq[rb * 5 + COL[a]!]!;
      }
      plain[2 * i] = x;
      plain[2 * i + 1] = y;
    }
    let sum = 0;
    for (let i = 0; i + 3 < n; i++) {
      sum += quad[plain[i]! * 17576 + plain[i + 1]! * 676 + plain[i + 2]! * 26 + plain[i + 3]!]!;
    }
    counter.n++;
    return sum;
  };
}

/**
 * Search for the square. `cipher` is the ciphertext as letter codes 0..25 (J already folded to I
 * for the 'ij' square); an odd last letter is ignored.
 */
export function solvePlayfair(cipher: Uint8Array, options: SolveOptions = {}): SolveResult {
  const kind = options.kind ?? 'ij';
  const alphabet = ALPHABETS[kind];
  const letters = [...alphabet].map((ch) => ch.charCodeAt(0) - 65);
  const pairs = cipher.length >> 1;
  const rng = makeRng(options.seed ?? 0x9e3779b1);
  const budget = options.budget ?? 2_000_000;
  const keep = options.keep ?? 6;
  if (pairs < 4) {
    return { candidates: [], runs: [], evaluations: 0, restarts: 0, converged: false, searched: 0 };
  }

  const c1 = new Uint8Array(pairs);
  const c2 = new Uint8Array(pairs);
  for (let i = 0; i < pairs; i++) {
    c1[i] = cipher[2 * i]!;
    c2[i] = cipher[2 * i + 1]!;
  }
  const counter = { n: 0 };
  const searchPairs = Math.min(pairs, SEARCH_LETTERS >> 1);
  const polishPairs = Math.min(pairs, POLISH_LETTERS >> 1);
  const table = options.table ?? quadTable();
  const searchScore = makeScorer(c1, c2, searchPairs, counter, table);
  const polishScore =
    polishPairs === searchPairs ? searchScore : makeScorer(c1, c2, polishPairs, counter, table);
  const fullScore = pairs === polishPairs ? polishScore : makeScorer(c1, c2, pairs, counter, table);
  const searchLetters = searchPairs * 2;
  // The temperatures below are for 300 letters: scale them to the text searched.
  const scale = (searchLetters - 3) / 297;

  function shuffled(): Uint8Array {
    const a = Uint8Array.from(letters);
    for (let i = CELLS - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = a[i]!;
      a[i] = a[j]!;
      a[j] = t;
    }
    return a;
  }

  /** One random move on `cand` (already a copy of the current square). */
  function mutate(cand: Uint8Array): void {
    const m = rng();
    if (m < 0.9) {
      const i = Math.floor(rng() * CELLS);
      let j = Math.floor(rng() * (CELLS - 1));
      if (j >= i) j++;
      const t = cand[i]!;
      cand[i] = cand[j]!;
      cand[j] = t;
    } else if (m < 0.94) {
      const a = Math.floor(rng() * 5);
      let b = Math.floor(rng() * 4);
      if (b >= a) b++;
      for (let c = 0; c < 5; c++) {
        const t = cand[a * 5 + c]!;
        cand[a * 5 + c] = cand[b * 5 + c]!;
        cand[b * 5 + c] = t;
      }
    } else if (m < 0.98) {
      const a = Math.floor(rng() * 5);
      let b = Math.floor(rng() * 4);
      if (b >= a) b++;
      for (let r = 0; r < 5; r++) {
        const t = cand[r * 5 + a]!;
        cand[r * 5 + a] = cand[r * 5 + b]!;
        cand[r * 5 + b] = t;
      }
    } else if (m < 0.99) {
      const copy = cand.slice();
      for (let r = 0; r < 5; r++) {
        for (let c = 0; c < 5; c++) cand[r * 5 + c] = copy[(4 - r) * 5 + c]!;
      }
    } else if (m < 0.995) {
      const copy = cand.slice();
      for (let r = 0; r < 5; r++) {
        for (let c = 0; c < 5; c++) cand[r * 5 + c] = copy[r * 5 + 4 - c]!;
      }
    } else {
      cand.reverse();
    }
  }

  /** Simulated annealing of `cur` in place; returns its score. */
  function anneal(
    cur: Uint8Array,
    score: (sq: Uint8Array) => number,
    start: number,
    steps: number,
    perStep: number,
  ): number {
    let curScore = score(cur);
    const cand = new Uint8Array(CELLS);
    for (let step = 0; step < steps && counter.n < budget; step++) {
      const temp = start * scale * (1 - step / steps);
      for (let k = 0; k < perStep; k++) {
        cand.set(cur);
        mutate(cand);
        const s = score(cand);
        const d = s - curScore;
        if (d >= 0 || rng() < Math.exp(d / temp)) {
          cur.set(cand);
          curScore = s;
        }
      }
    }
    return curScore;
  }

  /** Greedy polish: take any improving swap of two cells until none is left. */
  function polish(sq: Uint8Array, score: (sq: Uint8Array) => number): number {
    let best = score(sq);
    let improved = true;
    while (improved) {
      improved = false;
      for (let i = 0; i < CELLS - 1; i++) {
        for (let j = i + 1; j < CELLS; j++) {
          const t = sq[i]!;
          sq[i] = sq[j]!;
          sq[j] = t;
          const s = score(sq);
          if (s > best) {
            best = s;
            improved = true;
          } else {
            sq[j] = sq[i]!;
            sq[i] = t;
          }
        }
      }
    }
    return best;
  }

  const fitnessOf = (score: number, letterCount: number) =>
    score / FITNESS_SCALE / (letterCount - 3);

  const T_START = options.schedule?.start ?? 1100;
  const STEPS = options.schedule?.steps ?? 40;
  const PER_STEP = options.schedule?.perStep ?? 5000;

  const found = new Map<string, { sq: Uint8Array; score: number; hits: number }>();
  const runs: number[] = [];
  let converged = false;
  while (counter.n < budget && !converged) {
    const cur = shuffled();
    anneal(cur, searchScore, T_START, STEPS, PER_STEP);
    let curScore = polish(cur, polishScore);
    let fit = fitnessOf(curScore, polishPairs * 2);
    if (isPlausible(fit, polishPairs * 2)) {
      // Close to the language: a few cells may still be wrong (a three-way swap no single swap
      // can undo). Kick the square with a few random swaps, re-anneal from a low temperature and
      // keep what is better, until several kicks in a row bring nothing.
      for (let fails = 0; fails < 6 && counter.n < budget;) {
        const kicked = cur.slice();
        const kicks = 2 + Math.floor(rng() * 3);
        for (let k = 0; k < kicks; k++) {
          const i = Math.floor(rng() * CELLS);
          const j = Math.floor(rng() * CELLS);
          const t = kicked[i]!;
          kicked[i] = kicked[j]!;
          kicked[j] = t;
        }
        anneal(kicked, searchScore, 300, 10, 1500);
        const s = polish(kicked, polishScore);
        if (s > curScore) {
          cur.set(kicked);
          curScore = s;
          fails = 0;
        } else fails++;
      }
      fit = fitnessOf(curScore, polishPairs * 2);
      converged = isPlausible(fit, polishPairs * 2);
    }
    runs.push(fit);
    const fullSq = cur.slice();
    const full = fullScore(fullSq);
    const key = canonicalSquare(toLetters(fullSq));
    const known = found.get(key);
    if (known) {
      known.hits++;
      if (known.hits >= 2) converged = true;
    } else found.set(key, { sq: fullSq, score: full, hits: 1 });
  }

  const ranked = [...found.values()].sort((a, b) => b.score - a.score).slice(0, keep);
  const out = new Uint8Array(pairs * 2);
  const candidates = ranked.map(({ sq, score, hits }) => {
    decryptPairs(c1, c2, sq, out);
    const { square, keyword } = readableSquare(toLetters(sq), kind);
    return {
      square,
      keyword,
      score,
      fitness: fitnessOf(score, pairs * 2),
      plain: toLetters(out),
      hits,
    };
  });
  return {
    candidates,
    runs,
    evaluations: counter.n,
    restarts: runs.length,
    converged,
    searched: searchLetters,
  };
}
