import {
  crt,
  egcd,
  exactRoot,
  gcd,
  isqrt,
  mod,
  modInv,
  modPow,
  sievePrimes,
  sqrtModPrime,
} from './_bigint';

/** Textbook attacks on RSA parameters. Each one is a pure function that verifies its own result. */

const ordered = (a: bigint, b: bigint): [bigint, bigint] => (a <= b ? [a, b] : [b, a]);

/** p <= q from n = p*q and phi = (p-1)(q-1): they are the roots of x^2 - (n - phi + 1)x + n. */
export function factorFromPhi(n: bigint, phi: bigint): [bigint, bigint] | null {
  const s = n - phi + 1n;
  const disc = s * s - 4n * n;
  if (disc < 0n) return null;
  const t = isqrt(disc);
  if (t * t !== disc || (s - t) % 2n !== 0n) return null;
  const p = (s - t) / 2n;
  const q = (s + t) / 2n;
  return p > 1n && p * q === n ? ordered(p, q) : null;
}

/** p <= q from (n, e, d): e*d - 1 is a multiple of lambda(n), which leaks a square root of 1. */
export function factorFromPrivateExponent(
  n: bigint,
  e: bigint,
  d: bigint,
): [bigint, bigint] | null {
  const k = e * d - 1n;
  if (k <= 0n || n < 4n) return null;
  let t = k;
  let s = 0;
  while ((t & 1n) === 0n) {
    t >>= 1n;
    s++;
  }
  for (const g of sievePrimes(60).map(BigInt)) {
    if (g >= n) break;
    let x = modPow(g, t, n);
    if (x === 1n || x === n - 1n) continue;
    for (let i = 0; i < s; i++) {
      const y = (x * x) % n;
      if (y === 1n) {
        const f = gcd(x - 1n, n);
        if (f > 1n && f < n) return ordered(f, n / f);
        break;
      }
      if (y === n - 1n) break;
      x = y;
    }
  }
  return null;
}

/**
 * Wiener's attack: if d < n^(1/4)/3, then k/d is a convergent of e/n. Returns d and the primes.
 */
export function wiener(n: bigint, e: bigint): { d: bigint; p: bigint; q: bigint } | null {
  let [a, b] = [e, n];
  let [h1, h2] = [1n, 0n];
  let [k1, k2] = [0n, 1n];
  while (b !== 0n) {
    const q = a / b;
    [a, b] = [b, a - q * b];
    const h = q * h1 + h2;
    const k = q * k1 + k2;
    [h2, h1] = [h1, h];
    [k2, k1] = [k1, k];
    // e/n ~ h/k, with h the "k" of e*d = 1 + k*phi and k the candidate d.
    if (h === 0n || k === 0n) continue;
    const num = e * k - 1n;
    if (num % h !== 0n) continue;
    const pq = factorFromPhi(n, num / h);
    if (pq) return { d: k, p: pq[0], q: pq[1] };
  }
  return null;
}

/**
 * Hastad broadcast: the same message sent with the same small e to e (or more) pairwise coprime
 * moduli. CRT gives m^e exactly (no reduction), so an integer e-th root recovers m.
 */
export function hastad(cs: bigint[], ns: bigint[], e: number): bigint | null {
  const joined = crt(
    cs.map((c, i) => mod(c, ns[i]!)),
    ns,
  );
  return joined ? exactRoot(joined.x, e) : null;
}

/** Combinations of `size` indices out of `count`, capped at `limit` combinations. */
export function combinations(count: number, size: number, limit: number): number[][] {
  const out: number[][] = [];
  const pick: number[] = [];
  const walk = (from: number) => {
    if (out.length >= limit) return;
    if (pick.length === size) {
      out.push([...pick]);
      return;
    }
    for (let i = from; i < count; i++) {
      pick.push(i);
      walk(i + 1);
      pick.pop();
    }
  };
  walk(0);
  return out;
}

export type CommonModulusResult =
  { ok: true; m: bigint } | { ok: false; reason: string; factor?: bigint };

/**
 * Same message, same n, two exponents: a*e1 + b*e2 = g gives c1^a * c2^b = m^g (mod n).
 * With gcd(e1, e2) = 1 that is m itself; otherwise an integer g-th root is tried.
 */
export function commonModulus(
  n: bigint,
  e1: bigint,
  e2: bigint,
  c1: bigint,
  c2: bigint,
): CommonModulusResult {
  const { g, x: a, y: b } = egcd(e1, e2);
  const i1 = a < 0n ? modInv(c1, n) : c1;
  const i2 = b < 0n ? modInv(c2, n) : c2;
  if (i1 === null || i2 === null) {
    const factor = gcd(i1 === null ? c1 : c2, n);
    return { ok: false, reason: 'a ciphertext is not invertible mod n', factor };
  }
  const mg = (modPow(i1, a < 0n ? -a : a, n) * modPow(i2, b < 0n ? -b : b, n)) % n;
  if (g === 1n) return { ok: true, m: mg };
  if (g > 4096n) return { ok: false, reason: `gcd(e1, e2) = ${g} is too large to take a root` };
  const m = exactRoot(mg, Number(g));
  return m === null
    ? { ok: false, reason: `gcd(e1, e2) = ${g} and m^${g} >= n, so no integer root` }
    : { ok: true, m };
}

/** CRT-RSA leak: x^(e*dp) = x (mod p), so gcd(x^(e*dp) - x, n) = p. Works for dq and q alike. */
export function crtExponentLeak(n: bigint, e: bigint, dp: bigint): bigint | null {
  for (const x of [2n, 3n, 5n, 7n, 11n, 13n]) {
    const g = gcd(modPow(x, e * dp, n) - x, n);
    if (g > 1n && g < n) return g;
  }
  return null;
}

/**
 * Small exponent, message slightly larger than n^(1/e): look for m^e = c + k*n with k small.
 * Residue tables for a dozen small primes reject nearly every k without a big-number root.
 */
export function smallExponentScan(
  c: bigint,
  n: bigint,
  e: number,
  maxK: number,
  deadline: number,
): { m: bigint; k: number } | null {
  const filters: { r: number; ok: Uint8Array; nm: number; cur: number; ratio: number }[] = [];
  for (const r of sievePrimes(2000)) {
    const g = Number(gcd(BigInt(e), BigInt(r - 1)));
    if (g === 1) continue;
    const ok = new Uint8Array(r);
    ok[0] = 1;
    for (let x = 1; x < r; x++) {
      let acc = 1;
      for (let i = 0; i < e; i++) acc = (acc * x) % r;
      ok[acc] = 1;
    }
    filters.push({
      r,
      ok,
      nm: Number(n % BigInt(r)),
      cur: Number(c % BigInt(r)),
      ratio: ((r - 1) / g + 1) / r,
    });
    if (filters.length >= 40) break;
  }
  filters.sort((a, b) => a.ratio - b.ratio);
  const use = filters.slice(0, 12);
  if (use.length === 0) return null;
  for (let k = 1; k <= maxK; k++) {
    let pass = true;
    for (const f of use) {
      f.cur += f.nm;
      if (f.cur >= f.r) f.cur -= f.r;
      if (f.ok[f.cur] !== 1) pass = false;
    }
    if (!pass) continue;
    const m = exactRoot(c + BigInt(k) * n, e);
    if (m !== null) return { m, k };
    if ((k & 255) === 0 && Date.now() > deadline) return null;
  }
  return null;
}

/** The four square roots of c modulo p*q (p, q odd primes), or [] if c is not a square. */
export function rabinRoots(c: bigint, p: bigint, q: bigint): bigint[] {
  const rp = sqrtModPrime(c, p);
  const rq = sqrtModPrime(c, q);
  if (rp === null || rq === null) return [];
  const n = p * q;
  const out = new Set<bigint>();
  for (const sp of [rp, p - rp]) {
    for (const sq of [rq, q - rq]) {
      const joined = crt([sp % p, sq % q], [p, q]);
      if (joined) out.add(mod(joined.x, n));
    }
  }
  return [...out];
}
