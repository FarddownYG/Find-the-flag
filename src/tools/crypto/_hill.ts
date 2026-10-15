/**
 * Hill cipher arithmetic: matrices modulo m (m = 26, 29 or 37), determinants, inverses, reading a
 * key, applying a matrix to blocks, and solving for the key from known plaintext. Pure functions;
 * the tool in hill.ts adds the options, the tables and the messages.
 *
 * Vectors are columns (C = K P), the usual convention; the tool offers the row convention
 * (C = P K) by transposing the matrix.
 */

export type Matrix = number[][];
export type AlphabetId = 'az' | 'az29' | 'az37';

export interface HillAlphabet {
  id: AlphabetId;
  symbols: string;
  modulus: number;
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export const HILL_ALPHABETS: Record<AlphabetId, HillAlphabet> = {
  /** A=0 ... Z=25 */
  az: { id: 'az', symbols: LETTERS, modulus: 26 },
  /** The letters, then space, full stop and comma: 29 symbols (a prime modulus). */
  az29: { id: 'az29', symbols: `${LETTERS} .,`, modulus: 29 },
  /** The letters, the digits, then space: 37 symbols (a prime modulus). */
  az37: { id: 'az37', symbols: `${LETTERS}0123456789 `, modulus: 37 },
};

export const MAX_SIZE = 6;

export const mod = (a: number, m: number): number => ((a % m) + m) % m;

export function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) [x, y] = [y, x % y];
  return x;
}

/** The inverse of a modulo m, or null when gcd(a, m) is not 1. */
export function modInverse(a: number, m: number): number | null {
  let [r0, r1] = [mod(a, m), m];
  let [s0, s1] = [1, 0];
  while (r1) {
    const q = Math.floor(r0 / r1);
    [r0, r1] = [r1, r0 - q * r1];
    [s0, s1] = [s1, s0 - q * s1];
  }
  return r0 === 1 ? mod(s0, m) : null;
}

export function primeFactors(m: number): number[] {
  const out: number[] = [];
  let rest = m;
  for (let p = 2; p * p <= rest; p++) {
    if (rest % p === 0) {
      out.push(p);
      while (rest % p === 0) rest /= p;
    }
  }
  if (rest > 1) out.push(rest);
  return out;
}

export const identity = (n: number): Matrix =>
  Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));

export const transpose = (a: Matrix): Matrix => a[0]!.map((_, j) => a.map((row) => row[j]!));

export function multiply(a: Matrix, b: Matrix, m: number): Matrix {
  return a.map((row) =>
    b[0]!.map((_, j) =>
      mod(
        row.reduce((sum, x, k) => sum + x * b[k]![j]!, 0),
        m,
      ),
    ),
  );
}

/** Determinant modulo m by cofactor expansion (the sizes here are 2 to 6). */
export function determinant(a: Matrix, m: number): number {
  const n = a.length;
  if (n === 1) return mod(a[0]![0]!, m);
  if (n === 2) return mod(a[0]![0]! * a[1]![1]! - a[0]![1]! * a[1]![0]!, m);
  let sum = 0;
  for (let j = 0; j < n; j++) {
    const minor = a.slice(1).map((row) => row.filter((_, c) => c !== j));
    sum += (j % 2 ? -1 : 1) * a[0]![j]! * determinant(minor, m);
    sum = mod(sum, m);
  }
  return mod(sum, m);
}

export interface Inversion {
  det: number;
  /** gcd(det, m): 1 means the matrix can be inverted. */
  gcd: number;
  inverse: Matrix | null;
}

/** Determinant, its gcd with m, and the inverse mod m (adjugate times the inverse determinant). */
export function invert(a: Matrix, m: number): Inversion {
  const n = a.length;
  const det = determinant(a, m);
  const g = gcd(det, m);
  const detInv = modInverse(det, m);
  if (detInv === null) return { det, gcd: g === 0 ? m : g, inverse: null };
  const inverse: Matrix = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      // The adjugate is the transposed cofactor matrix.
      const minor = a.filter((_, r) => r !== j).map((row) => row.filter((_, c) => c !== i));
      const cofactor = ((i + j) % 2 ? -1 : 1) * (n === 1 ? 1 : determinant(minor, m));
      inverse[i]![j] = mod(detInv * cofactor, m);
    }
  }
  return { det, gcd: g, inverse };
}

/** The primes of m that divide the determinant: why a matrix has no inverse mod m. */
export const blockingPrimes = (det: number, m: number): number[] =>
  primeFactors(m).filter((p) => det % p === 0);

export interface ParsedKey {
  matrix: Matrix;
  n: number;
  form: 'numbers' | 'letters';
}

export type KeyProblem =
  { problem: 'empty' } | { problem: 'count'; count: number } | { problem: 'tooBig'; n: number };

const isSquare = (k: number): number => {
  const n = Math.round(Math.sqrt(k));
  return n * n === k ? n : 0;
};

/**
 * Read the key: n x n numbers (separated by spaces, commas, semicolons, new lines; brackets are
 * ignored) or a keyword of n x n symbols of the alphabet, row by row. Returns a problem when it
 * cannot be read.
 */
export function parseKey(key: string, alphabet: HillAlphabet): ParsedKey | KeyProblem {
  const m = alphabet.modulus;
  const stripped = key.replace(/[[\](){}]/g, ' ').trim();
  if (!stripped) return { problem: 'empty' };
  const tokens = stripped.split(/[\s,;|]+/).filter(Boolean);
  if (tokens.length >= 4 && tokens.every((t) => /^-?\d+$/.test(t))) {
    const n = isSquare(tokens.length);
    if (!n) return { problem: 'count', count: tokens.length };
    if (n > MAX_SIZE) return { problem: 'tooBig', n };
    const values = tokens.map((t) => mod(Number(t), m));
    return { matrix: chunk(values, n), n, form: 'numbers' };
  }
  const values: number[] = [];
  for (const ch of key.toUpperCase()) {
    const i = alphabet.symbols.indexOf(ch);
    if (i >= 0 && !/\s/.test(ch)) values.push(i);
  }
  if (!values.length) return { problem: 'empty' };
  const n = isSquare(values.length);
  if (!n) return { problem: 'count', count: values.length };
  if (n > MAX_SIZE) return { problem: 'tooBig', n };
  return { matrix: chunk(values, n), n, form: 'letters' };
}

export const isParsed = (r: ParsedKey | KeyProblem): r is ParsedKey => 'matrix' in r;

export function chunk(values: readonly number[], n: number): Matrix {
  const rows: Matrix = [];
  for (let i = 0; i < values.length; i += n) rows.push(values.slice(i, i + n));
  return rows;
}

/** The matrix written as symbols of the alphabet, row by row (a keyword). */
export const matrixWord = (a: Matrix, alphabet: HillAlphabet): string =>
  a
    .flat()
    .map((v) => alphabet.symbols[v]!)
    .join('');

export interface BlockStep {
  input: number[];
  /** K x input before reducing mod m, then reduced. */
  raw: number[];
  output: number[];
}

/** Multiply every block of n values by the matrix (column vectors); the tail is not touched. */
export function applyBlocks(values: readonly number[], a: Matrix, m: number): BlockStep[] {
  const n = a.length;
  const steps: BlockStep[] = [];
  for (let at = 0; at + n <= values.length; at += n) {
    const input = values.slice(at, at + n);
    const raw = a.map((row) => row.reduce((sum, x, k) => sum + x * input[k]!, 0));
    steps.push({ input, raw, output: raw.map((x) => mod(x, m)) });
  }
  return steps;
}

// ---------------------------------------------------------------------------------------------
// Text <-> values

export type Slot = { sym: number; upper: boolean } | { pass: string };

/** The characters of a text that are symbols of the alphabet (case ignored), and the others. */
export function readText(
  text: string,
  alphabet: HillAlphabet,
): { slots: Slot[]; values: number[] } {
  const slots: Slot[] = [];
  const values: number[] = [];
  for (const ch of text) {
    const i = alphabet.symbols.indexOf(ch.toUpperCase());
    if (ch.length === 1 && i >= 0) {
      slots.push({ sym: i, upper: ch === ch.toUpperCase() });
      values.push(i);
    } else slots.push({ pass: ch });
  }
  return { slots, values };
}

/**
 * Put new values back where the symbols were. Other characters stay in place; a letter keeps its
 * case with the 26-letter alphabet. Extra values (padding) go at the end; symbols without a new
 * value (an incomplete last block) are left out.
 */
export function writeText(
  slots: readonly Slot[],
  output: readonly number[],
  alphabet: HillAlphabet,
  keepCase: boolean,
): string {
  let out = '';
  let next = 0;
  for (const slot of slots) {
    if ('pass' in slot) {
      out += slot.pass;
      continue;
    }
    if (next >= output.length) continue;
    const s = alphabet.symbols[output[next++]!]!;
    out += keepCase && !slot.upper ? s.toLowerCase() : s;
  }
  while (next < output.length) out += alphabet.symbols[output[next++]!]!;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Known plaintext

/** One linear system A x = b modulo a prime p, solved by Gauss-Jordan elimination. */
interface PrimeSolution {
  consistent: boolean;
  rank: number;
  particular: number[];
  /** Directions of the freedom: every solution is the particular one plus a combination. */
  basis: number[][];
}

function solveMod(a: Matrix, b: readonly number[], p: number): PrimeSolution {
  const rows = a.length;
  const cols = a[0]!.length;
  const aug = a.map((row, i) => [...row.map((x) => mod(x, p)), mod(b[i]!, p)]);
  const pivots: number[] = [];
  let r = 0;
  for (let c = 0; c < cols && r < rows; c++) {
    const at = aug.findIndex((row, i) => i >= r && row[c] !== 0);
    if (at < 0) continue;
    [aug[r], aug[at]] = [aug[at]!, aug[r]!];
    const inv = modInverse(aug[r]![c]!, p)!;
    aug[r] = aug[r]!.map((x) => mod(x * inv, p));
    for (let i = 0; i < rows; i++) {
      if (i !== r && aug[i]![c] !== 0) {
        const f = aug[i]![c]!;
        aug[i] = aug[i]!.map((x, k) => mod(x - f * aug[r]![k]!, p));
      }
    }
    pivots.push(c);
    r++;
  }
  const consistent = !aug.some((row, i) => i >= r && row[cols] !== 0);
  const particular = new Array<number>(cols).fill(0);
  pivots.forEach((c, i) => {
    particular[c] = aug[i]![cols]!;
  });
  const free = Array.from({ length: cols }, (_, c) => c).filter((c) => !pivots.includes(c));
  const basis = free.map((f) => {
    const v = new Array<number>(cols).fill(0);
    v[f] = 1;
    pivots.forEach((c, i) => {
      v[c] = mod(-aug[i]![f]!, p);
    });
    return v;
  });
  return { consistent, rank: pivots.length, particular, basis };
}

/** x mod m from its residues modulo the (coprime) primes of m. */
function crt(residues: readonly number[], primes: readonly number[], m: number): number {
  let x = 0;
  residues.forEach((res, i) => {
    const p = primes[i]!;
    const rest = m / p;
    x += res * rest * modInverse(rest, p)!;
  });
  return mod(x, m);
}

export interface KnownResult {
  /** No matrix fits, every key that fits (invertible ones only), or too many to list. */
  status: 'none' | 'ok' | 'too-many';
  /** The invertible keys that map every known plaintext block to its ciphertext block. */
  keys: Matrix[];
  /** Number of solutions before dropping the keys that cannot be inverted (when countable). */
  fits: number;
  /** For each prime of m: rank of the known plaintext blocks (n = they pin the key down). */
  ranks: { prime: number; rank: number }[];
  /** Blocks used. */
  blocks: number;
}

/** Most solutions listed: more than this and the known text is too short to say anything. */
export const MAX_KEYS = 30_000;

/**
 * Every n x n matrix K with K p = c for all the given blocks (columns), modulo m. Each row of K
 * is solved on its own, modulo each prime of m, and the answers are joined by the Chinese
 * remainder theorem. When the plaintext blocks do not span the whole space modulo some prime,
 * the key is not unique: all the solutions are listed (up to a limit), invertible ones kept.
 */
export function solveKnown(
  plain: readonly number[][],
  cipher: readonly number[][],
  m: number,
): KnownResult {
  const n = plain[0]?.length ?? 0;
  const primes = primeFactors(m);
  const system = plain.map((p) => [...p]);
  const ranks = primes.map((prime) => ({
    prime,
    rank: solveMod(system, new Array<number>(system.length).fill(0), prime).rank,
  }));
  const result = (status: KnownResult['status'], keys: Matrix[], fits: number): KnownResult => ({
    status,
    keys,
    fits,
    ranks,
    blocks: plain.length,
  });

  // Candidates of each row of K.
  const rowChoices: number[][][] = [];
  let total = 1;
  for (let i = 0; i < n; i++) {
    const rhs = cipher.map((c) => c[i]!);
    const perPrime: number[][][] = [];
    for (const p of primes) {
      const sol = solveMod(system, rhs, p);
      if (!sol.consistent) return result('none', [], 0);
      const count = p ** sol.basis.length;
      if (count > MAX_KEYS) return result('too-many', [], Infinity);
      const all: number[][] = [];
      for (let t = 0; t < count; t++) {
        const v = [...sol.particular];
        let rest = t;
        for (const dir of sol.basis) {
          const coeff = rest % p;
          rest = Math.floor(rest / p);
          for (let k = 0; k < n; k++) v[k] = mod(v[k]! + coeff * dir[k]!, p);
        }
        all.push(v);
      }
      perPrime.push(all);
    }
    // Join the residues of the primes: every combination is one candidate row.
    const combos = perPrime.reduce((acc, list) => acc * list.length, 1);
    if (combos > MAX_KEYS) return result('too-many', [], Infinity);
    const joined: number[][] = [];
    const pick = (depth: number, chosen: number[][]): void => {
      if (depth === perPrime.length) {
        joined.push(
          Array.from({ length: n }, (_, k) =>
            crt(
              chosen.map((v) => v[k]!),
              primes,
              m,
            ),
          ),
        );
        return;
      }
      for (const v of perPrime[depth]!) pick(depth + 1, [...chosen, v]);
    };
    pick(0, []);
    rowChoices.push(joined);
    total *= joined.length;
    if (total > MAX_KEYS * 10) return result('too-many', [], Infinity);
  }

  const keys: Matrix[] = [];
  const build = (i: number, chosen: number[][]): void => {
    if (i === n) {
      if (invert(chosen, m).inverse) keys.push(chosen.map((row) => [...row]));
      return;
    }
    for (const row of rowChoices[i]!) build(i + 1, [...chosen, row]);
  };
  build(0, []);
  return result(keys.length > MAX_KEYS ? 'too-many' : 'ok', keys.slice(0, MAX_KEYS), total);
}
