import { fromHex } from '../../lib/bytes';

/** BigInt number theory used by the RSA toolkit. Everything here is exact and side-effect free. */

export const abs = (a: bigint): bigint => (a < 0n ? -a : a);

/** Mathematical modulo: the result is always in [0, m). */
export function mod(a: bigint, m: bigint): bigint {
  const r = a % m;
  return r < 0n ? r + m : r;
}

export function gcd(a: bigint, b: bigint): bigint {
  let x = abs(a);
  let y = abs(b);
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

/** Extended Euclid: returns g = gcd(a, b) and x, y with a*x + b*y = g. */
export function egcd(a: bigint, b: bigint): { g: bigint; x: bigint; y: bigint } {
  let [r0, r1] = [a, b];
  let [s0, s1] = [1n, 0n];
  let [t0, t1] = [0n, 1n];
  while (r1 !== 0n) {
    const q = r0 / r1;
    [r0, r1] = [r1, r0 - q * r1];
    [s0, s1] = [s1, s0 - q * s1];
    [t0, t1] = [t1, t0 - q * t1];
  }
  return r0 < 0n ? { g: -r0, x: -s0, y: -t0 } : { g: r0, x: s0, y: t0 };
}

/** Modular inverse, or null when gcd(a, m) != 1. */
export function modInv(a: bigint, m: bigint): bigint | null {
  if (m < 1n) return null;
  const { g, x } = egcd(mod(a, m), m);
  return g === 1n ? mod(x, m) : null;
}

/** base^exp mod m. A negative exponent uses the modular inverse (throws if there is none). */
export function modPow(base: bigint, exp: bigint, m: bigint): bigint {
  if (m === 1n) return 0n;
  let b = mod(base, m);
  let e = exp;
  if (e < 0n) {
    const inv = modInv(b, m);
    if (inv === null) throw new RangeError('base is not invertible modulo m');
    b = inv;
    e = -e;
  }
  let result = 1n;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % m;
    e >>= 1n;
    if (e > 0n) b = (b * b) % m;
  }
  return result;
}

/** Number of bits needed to write n (0 for 0). */
export function bitLength(n: bigint): number {
  if (n <= 0n) return 0;
  const h = n.toString(16);
  return (h.length - 1) * 4 + (32 - Math.clz32(parseInt(h[0]!, 16)));
}

/** floor(sqrt(n)) by Newton iteration from above. */
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new RangeError('isqrt of a negative number');
  if (n < 2n) return n;
  let x = 1n << BigInt((bitLength(n) + 1) >> 1);
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

/** floor(n^(1/k)) for n >= 0, k >= 1. */
export function iroot(n: bigint, k: number): bigint {
  if (n < 0n) throw new RangeError('iroot of a negative number');
  if (k < 1) throw new RangeError('root degree must be >= 1');
  if (k === 1 || n < 2n) return n;
  const kb = BigInt(k);
  const k1 = BigInt(k - 1);
  let x = 1n << BigInt(Math.ceil(bitLength(n) / k));
  for (;;) {
    const y = (k1 * x + n / x ** k1) / kb;
    if (y >= x) return x;
    x = y;
  }
}

/** The exact k-th root of n, or null when n is not a perfect k-th power. */
export function exactRoot(n: bigint, k: number): bigint | null {
  const r = iroot(n, k);
  return r ** BigInt(k) === n ? r : null;
}

export function isPerfectSquare(n: bigint): boolean {
  if (n < 0n) return false;
  const r = isqrt(n);
  return r * r === n;
}

/** Primes below `limit` (sieve of Eratosthenes). */
export function sievePrimes(limit: number): number[] {
  const flags = new Uint8Array(limit + 1);
  const out: number[] = [];
  for (let i = 2; i <= limit; i++) {
    if (flags[i]) continue;
    out.push(i);
    for (let j = i * i; j <= limit; j += i) flags[j] = 1;
  }
  return out;
}

const MR_BASES = sievePrimes(80).map(BigInt);

/**
 * Miller-Rabin with the first 22 primes as bases. Deterministic for n < 3.3e24 and, for larger
 * numbers, a false "prime" would need a strong pseudoprime to 22 fixed bases at once.
 */
export function isProbablePrime(n: bigint): boolean {
  if (n < 2n) return false;
  for (const p of MR_BASES) {
    if (n === p) return true;
    if (n % p === 0n) return false;
  }
  let d = n - 1n;
  let s = 0;
  while ((d & 1n) === 0n) {
    d >>= 1n;
    s++;
  }
  witness: for (const a of MR_BASES) {
    let x = modPow(a, d, n);
    if (x === 1n || x === n - 1n) continue;
    for (let i = 1; i < s; i++) {
      x = (x * x) % n;
      if (x === n - 1n) continue witness;
    }
    return false;
  }
  return true;
}

/** Chinese remainder theorem for pairwise coprime moduli; null when they are not coprime. */
export function crt(residues: bigint[], moduli: bigint[]): { x: bigint; modulus: bigint } | null {
  let x = 0n;
  let big = 1n;
  for (const m of moduli) big *= m;
  for (let i = 0; i < moduli.length; i++) {
    const m = moduli[i]!;
    const part = big / m;
    const inv = modInv(part, m);
    if (inv === null) return null;
    x += residues[i]! * part * inv;
  }
  return { x: mod(x, big), modulus: big };
}

/** A square root of a modulo the odd prime p (Tonelli-Shanks), or null if a is a non-residue. */
export function sqrtModPrime(a: bigint, p: bigint): bigint | null {
  const n = mod(a, p);
  if (n === 0n) return 0n;
  if (p === 2n) return n;
  if (modPow(n, (p - 1n) >> 1n, p) !== 1n) return null;
  if (p % 4n === 3n) return modPow(n, (p + 1n) >> 2n, p);
  let q = p - 1n;
  let s = 0;
  while ((q & 1n) === 0n) {
    q >>= 1n;
    s++;
  }
  let z = 2n;
  while (modPow(z, (p - 1n) >> 1n, p) !== p - 1n) z++;
  let m = s;
  let c = modPow(z, q, p);
  let t = modPow(n, q, p);
  let r = modPow(n, (q + 1n) >> 1n, p);
  while (t !== 1n) {
    let i = 0;
    let tt = t;
    while (tt !== 1n) {
      tt = (tt * tt) % p;
      i++;
    }
    const b = modPow(c, 1n << BigInt(m - i - 1), p);
    m = i;
    c = (b * b) % p;
    t = (t * c) % p;
    r = (r * b) % p;
  }
  return r;
}

/**
 * Parse an integer the way people paste them: decimal, 0x hex, hex without prefix when it
 * contains a-f, optional sign, Python-2 `L` suffix and `_` separators. Null when not a number.
 */
export function parseBigInt(raw: string): bigint | null {
  const s = raw.trim().replace(/_/g, '').replace(/[lL]$/, '');
  const m = /^([+-]?)(0[xX][0-9a-fA-F]+|[0-9]+|[0-9a-fA-F]*[a-fA-F][0-9a-fA-F]*)$/.exec(s);
  if (!m) return null;
  const body = m[2]!;
  const isHex = /^0[xX]/.test(body) || /[a-fA-F]/.test(body);
  const v = isHex ? BigInt(`0x${body.replace(/^0[xX]/, '')}`) : BigInt(body);
  return m[1] === '-' ? -v : v;
}

/** Crypto.Util.number.long_to_bytes: big-endian, no leading zeros (0 becomes one zero byte). */
export function longToBytes(n: bigint): Uint8Array {
  if (n < 0n) throw new RangeError('long_to_bytes of a negative number');
  const hex = n.toString(16);
  return fromHex(hex.length % 2 ? `0${hex}` : hex);
}

/** bytes_to_long. */
export function bytesToLong(b: Uint8Array): bigint {
  let hex = '';
  for (const x of b) hex += x.toString(16).padStart(2, '0');
  return hex ? BigInt(`0x${hex}`) : 0n;
}

/** `0x…` form of an integer (negative numbers keep their sign in front). */
export function toHexString(n: bigint): string {
  return `${n < 0n ? '-' : ''}0x${abs(n).toString(16)}`;
}
