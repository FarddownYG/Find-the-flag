import {
  abs,
  bitLength,
  exactRoot,
  gcd,
  isProbablePrime,
  isqrt,
  modPow,
  sievePrimes,
} from './_bigint';

/**
 * Factoring for RSA moduli that are weak on purpose: small factors, close primes (Fermat),
 * smooth p-1 and anything Pollard rho can crack in a couple of seconds. All of it is bounded by
 * a wall-clock deadline so a hopeless modulus returns instead of hanging the page.
 */

const TRIAL_LIMIT = 200_000;
const FERMAT_QUICK_ITERATIONS = 1 << 17;
const PM1_BOUND = 1 << 17;

let trialPrimes: number[] | null = null;
const getTrialPrimes = () => (trialPrimes ??= sievePrimes(TRIAL_LIMIT));
let pm1Primes: number[] | null = null;
const getPm1Primes = () => (pm1Primes ??= sievePrimes(PM1_BOUND));

// Squares modulo 64 and modulo 45045 = 5*7*9*11*13: a cheap filter that discards ~99 % of the
// candidates before the expensive isqrt in Fermat's method.
const SQUARE_MOD_64 = new Uint8Array(64);
for (let i = 0; i < 64; i++) SQUARE_MOD_64[(i * i) % 64] = 1;
let squareMod45045: Uint8Array | null = null;
function mightBeSquare(v: bigint): boolean {
  if (SQUARE_MOD_64[Number(v & 63n)] !== 1) return false;
  if (!squareMod45045) {
    squareMod45045 = new Uint8Array(45045);
    for (let i = 0; i < 45045; i++) squareMod45045[(i * i) % 45045] = 1;
  }
  return squareMod45045[Number(v % 45045n)] === 1;
}

/** Fermat's method: finds p, q when they are close (|p - q| of the order of n^(1/4)). */
export function fermat(n: bigint, maxIterations: number, deadline: number): bigint | null {
  if (n < 4n) return null;
  if ((n & 1n) === 0n) return 2n;
  let a = isqrt(n);
  if (a * a < n) a += 1n;
  let b2 = a * a - n;
  for (let i = 0; i < maxIterations; i++) {
    if (mightBeSquare(b2)) {
      const b = isqrt(b2);
      if (b * b === b2) {
        const f = a - b;
        if (f > 1n && f < n) return f;
      }
    }
    b2 += 2n * a + 1n;
    a += 1n;
    if ((i & 1023) === 1023 && Date.now() > deadline) return null;
  }
  return null;
}

/** Pollard p-1 with stage-1 bound B: finds p when p - 1 is B-smooth. */
export function pollardPm1(n: bigint, bound: number, deadline: number): bigint | null {
  let a = 2n;
  let count = 0;
  for (const p of bound === PM1_BOUND ? getPm1Primes() : sievePrimes(bound)) {
    let pk = p;
    while (pk * p <= bound) pk *= p;
    a = modPow(a, BigInt(pk), n);
    if (++count % 64 === 0) {
      const g = gcd(a - 1n, n);
      if (g > 1n) return g < n ? g : null;
      if (Date.now() > deadline) return null;
    }
  }
  const g = gcd(a - 1n, n);
  return g > 1n && g < n ? g : null;
}

/** Pollard rho (Brent's variant, batched gcds). Returns a non-trivial factor or null. */
export function pollardRho(n: bigint, deadline: number): bigint | null {
  if (n < 4n) return null;
  if ((n & 1n) === 0n) return 2n;
  for (let c = 1n; c < 30n; c++) {
    const f = (v: bigint) => (v * v + c) % n;
    let y = 2n;
    let x: bigint;
    let ys = 2n;
    let q = 1n;
    let g = 1n;
    let r = 1;
    const batch = 128;
    do {
      x = y;
      for (let i = 0; i < r; i++) y = f(y);
      let k = 0;
      while (k < r && g === 1n) {
        ys = y;
        const steps = Math.min(batch, r - k);
        for (let i = 0; i < steps; i++) {
          y = f(y);
          q = (q * abs(x - y)) % n;
        }
        g = gcd(q, n);
        k += batch;
        if (g === 1n && Date.now() > deadline) return null;
      }
      r *= 2;
    } while (g === 1n);
    if (g === n) {
      do {
        ys = f(ys);
        g = gcd(abs(x - ys), n);
      } while (g === 1n);
    }
    if (g !== n) return g;
  }
  return null;
}

/** If n = r^k for some k >= 2, return { root, exp } (smallest prime exponent first). */
export function perfectPower(n: bigint): { root: bigint; exp: number } | null {
  const maxExp = Math.floor(bitLength(n) / 2);
  for (const k of sievePrimes(Math.min(maxExp, 400))) {
    const root = exactRoot(n, k);
    if (root !== null && root > 1n) return { root, exp: k };
  }
  return null;
}

export interface Factorization {
  /** Prime factors with their exponents. */
  primes: Map<bigint, number>;
  /** Composite cofactors nobody could split before the deadline. */
  unfactored: bigint[];
  /** Methods that produced a factor, in the order they were needed. */
  methods: string[];
  complete: boolean;
  elapsedMs: number;
}

function findDivisor(v: bigint, deadline: number, budgetMs: number): [bigint, string] | null {
  const quick = Math.min(deadline, Date.now() + budgetMs * 0.1);
  const f1 = fermat(v, FERMAT_QUICK_ITERATIONS, quick);
  if (f1) return [f1, 'Fermat'];
  const f2 = pollardPm1(v, PM1_BOUND, Math.min(deadline, Date.now() + budgetMs * 0.2));
  if (f2) return [f2, 'Pollard p-1'];
  const f3 = pollardRho(v, deadline);
  if (f3) return [f3, 'Pollard rho'];
  return null;
}

/** Try to factor n completely within `budgetMs` milliseconds. */
export function factorize(n: bigint, budgetMs = 2000): Factorization {
  const start = Date.now();
  const deadline = start + budgetMs;
  const primes = new Map<bigint, number>();
  const unfactored: bigint[] = [];
  const methods: string[] = [];
  const note = (m: string) => {
    if (!methods.includes(m)) methods.push(m);
  };
  const add = (p: bigint, k: number) => primes.set(p, (primes.get(p) ?? 0) + k);

  let rest = n;
  if (rest > 1n) {
    for (const sp of getTrialPrimes()) {
      const b = BigInt(sp);
      if (b * b > rest) break;
      if (rest % b !== 0n) continue;
      note('trial division');
      while (rest % b === 0n) {
        rest /= b;
        add(b, 1);
      }
    }
  }
  const stack: { v: bigint; k: number }[] = rest > 1n ? [{ v: rest, k: 1 }] : [];
  while (stack.length) {
    const { v, k } = stack.pop()!;
    if (isProbablePrime(v)) {
      add(v, k);
      continue;
    }
    const pp = perfectPower(v);
    if (pp) {
      note('perfect power');
      stack.push({ v: pp.root, k: k * pp.exp });
      continue;
    }
    const found = findDivisor(v, deadline, budgetMs);
    if (!found) {
      unfactored.push(v);
      continue;
    }
    note(found[1]);
    stack.push({ v: found[0], k }, { v: v / found[0], k });
  }
  return {
    primes,
    unfactored,
    methods,
    complete: unfactored.length === 0,
    elapsedMs: Date.now() - start,
  };
}

/** Euler's totient from a complete factorization. */
export function totient(primes: Map<bigint, number>): bigint {
  let phi = 1n;
  for (const [p, k] of primes) phi *= (p - 1n) * p ** BigInt(k - 1);
  return phi;
}
