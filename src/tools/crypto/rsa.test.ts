import { describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors';
import { resultToText } from '../../core/result-text';
import type { Output } from '../../core/types';
import { utf8Encode } from '../../lib/bytes';
import {
  bitLength,
  bytesToLong,
  crt,
  egcd,
  exactRoot,
  gcd,
  isProbablePrime,
  iroot,
  isqrt,
  longToBytes,
  modInv,
  modPow,
  parseBigInt,
  sqrtModPrime,
  toHexString,
} from './_bigint';
import {
  commonModulus,
  crtExponentLeak,
  factorFromPhi,
  factorFromPrivateExponent,
  hastad,
  rabinRoots,
  smallExponentScan,
  wiener,
} from './_rsa-attacks';
import { factorize, fermat, perfectPower, pollardPm1, pollardRho } from './_rsa-factor';
import tool, { parseInput } from './rsa';

// Real 512-bit primes (generated offline, p-1 coprime to 65537). Each one is re-verified below.
const P = [
  13182432449648407564138613640895942349117270374259893099600167419988825904547421063651032033021377661878002190959417717647589974108415175013602424504893037n,
  12004079511810122566899864840358780561390230152535346334221357246299888157730839597050806229079239760869747169694924001728971903504574179626361992707690651n,
  10953276740155659869898756984964756994777742754046137153807709084336195376861668119848400387344683330654144273440239997499113734482228008999502003914705193n,
  10253207630783259759632096149666785938920026541966461206125403743170751340099140734446438551025175279796725812969711262275158910988798715585733649503811481n,
  12608375217966686994375895798066461090605237026339051129543052391283355970987558235519649239137630000696914609201009723788401939447122826123409366628563093n,
  10510430702197347934229188726787806826052367448151303329372074019342619118543525982022594079005361197719534078882354241793779370665655079863203004109417071n,
] as const;
const [P0, P1, P2, P3, P4, P5] = P;

const E = 65537n;
const msg = (s: string) => bytesToLong(utf8Encode(s));
const phiOf2 = (p: bigint, q: bigint) => (p - 1n) * (q - 1n);

function nextPrime(from: bigint, step = 2n): bigint {
  let n = from % 2n === 0n ? from + 1n : from;
  while (!isProbablePrime(n)) n += step;
  return n;
}

/** The next prime p > from with p = 3 (mod 4), as needed for Rabin square roots. */
const nextPrime3Mod4 = (from: bigint) => nextPrime(from - (from % 4n) + 3n, 4n);

/** `n = …` lines. */
const lines = (o: Record<string, bigint | number>) =>
  Object.entries(o)
    .map(([k, v]) => `${k} = ${v}`)
    .join('\n');

interface Row {
  attack: string;
  target: string;
  status: string;
  detail: string;
}

async function solve(input: string, budget = 2) {
  const out = await tool.run(input, { budget });
  const table = out.flatMap((o: Output) =>
    o.type === 'table' && o.label?.startsWith('Attacks') ? [o] : [],
  )[0];
  const rows: Row[] = (table?.rows ?? []).map((r) => ({
    attack: String(r[0]),
    target: String(r[1]),
    status: String(r[2]),
    detail: String(r[3]),
  }));
  return { out, text: resultToText(out), rows };
}
const worked = (rows: Row[], attack: string) =>
  rows.some((r) => r.attack === attack && r.status === 'worked');

describe('test primes', () => {
  it('are all prime 512-bit numbers (Miller-Rabin)', () => {
    for (const p of P) {
      expect(bitLength(p)).toBe(512);
      expect(isProbablePrime(p)).toBe(true);
      expect(gcd(E, p - 1n)).toBe(1n);
    }
  });
});

describe('_bigint', () => {
  it('Miller-Rabin separates primes from pseudoprimes', () => {
    for (const p of [2n, 3n, 97n, 7919n, 2n ** 61n - 1n, 2n ** 127n - 1n]) {
      expect(isProbablePrime(p)).toBe(true);
    }
    // Carmichael numbers, a strong pseudoprime to bases 2,3,5,7 and a 2^127+1 composite
    for (const c of [0n, 1n, 4n, 561n, 41041n, 3215031751n, 2n ** 127n + 1n, P0 * P1]) {
      expect(isProbablePrime(c)).toBe(false);
    }
  });

  it('computes modular inverses, powers and the extended gcd', () => {
    expect(modInv(3n, 11n)).toBe(4n);
    expect(modInv(2n, 4n)).toBeNull();
    expect(modInv(-3n, 11n)).toBe(7n);
    expect(modPow(4n, 13n, 497n)).toBe(445n);
    expect(modPow(3n, -1n, 11n)).toBe(4n);
    expect(modPow(5n, 0n, 7n)).toBe(1n);
    const { g, x, y } = egcd(240n, 46n);
    expect(g).toBe(2n);
    expect(240n * x + 46n * y).toBe(2n);
    const d = modInv(E, phiOf2(P0, P1))!;
    expect((E * d) % phiOf2(P0, P1)).toBe(1n);
  });

  it('takes exact integer square and k-th roots', () => {
    for (const n of [0n, 1n, 2n, 15n, 16n, 17n, 10n ** 40n, P0 * P0, P0 * P0 - 1n]) {
      const r = isqrt(n);
      expect(r * r <= n && (r + 1n) * (r + 1n) > n).toBe(true);
    }
    expect(iroot(1000n, 3)).toBe(10n);
    expect(iroot(999n, 3)).toBe(9n);
    expect(exactRoot(P1 ** 5n, 5)).toBe(P1);
    expect(exactRoot(P1 ** 5n + 1n, 5)).toBeNull();
    expect(bitLength(0n)).toBe(0);
    expect(bitLength(255n)).toBe(8);
    expect(bitLength(256n)).toBe(9);
  });

  it('finds square roots modulo primes, also when p = 1 mod 4', () => {
    for (const p of [13n, 17n, 41n, 998244353n, P0]) {
      const a = 123456789n % p;
      const r = sqrtModPrime((a * a) % p, p)!;
      expect(r === a || r === p - a).toBe(true);
    }
    expect(sqrtModPrime(5n, 13n)).toBeNull();
    expect(P0 % 4n).toBe(1n);
  });

  it('combines residues with the CRT', () => {
    const r = crt([2n, 3n, 2n], [3n, 5n, 7n])!;
    expect(r.x).toBe(23n);
    expect(r.modulus).toBe(105n);
    expect(crt([1n, 2n], [4n, 6n])).toBeNull();
  });

  it('parses the number formats people paste', () => {
    expect(parseBigInt('12345')).toBe(12345n);
    expect(parseBigInt('0x1F')).toBe(31n);
    expect(parseBigInt('ff')).toBe(255n);
    expect(parseBigInt('-7')).toBe(-7n);
    expect(parseBigInt('123L')).toBe(123n);
    expect(parseBigInt('1_000')).toBe(1000n);
    expect(parseBigInt('12 34')).toBeNull();
    expect(parseBigInt('flag')).toBeNull();
    expect(toHexString(255n)).toBe('0xff');
  });

  it('converts between integers and bytes like long_to_bytes', () => {
    expect(Array.from(longToBytes(0n))).toEqual([0]);
    expect(Array.from(longToBytes(0x1234n))).toEqual([0x12, 0x34]);
    expect(Array.from(longToBytes(0x123n))).toEqual([0x01, 0x23]);
    const m = msg('flag{round_trip}');
    expect(bytesToLong(longToBytes(m))).toBe(m);
    expect(bytesToLong(new Uint8Array())).toBe(0n);
  });
});

describe('factoring', () => {
  const far = () => Date.now() + 10_000;

  it('Pollard rho splits a semiprime of two 30-bit primes', () => {
    const n = 1000000007n * 998244353n;
    const f = pollardRho(n, far())!;
    expect(f === 1000000007n || f === 998244353n).toBe(true);
  });

  it('Pollard p-1 splits n when one p-1 is smooth', () => {
    // p - 1 = 2^4 * 3^2 * 5 * 7 * 11 * 13 * 17 * 19 * 23 * 29 * j is 2^17-smooth
    const smooth = 16n * 9n * 5n * 7n * 11n * 13n * 17n * 19n * 23n * 29n;
    let j = 1n;
    while (!isProbablePrime(smooth * j + 1n)) j++;
    const p = smooth * j + 1n;
    const f = pollardPm1(p * P2, 1 << 17, far())!;
    expect(f).toBe(p);
  });

  it('Fermat splits close primes and gives up on distant ones', () => {
    const q = nextPrime(P0 + 2n ** 100n);
    const f = fermat(P0 * q, 1 << 12, far())!;
    expect(f === P0 || f === q).toBe(true);
    expect(fermat(P0 * P1, 1 << 12, far())).toBeNull();
  });

  it('recognises perfect powers', () => {
    expect(perfectPower(P0 ** 2n)).toEqual({ root: P0, exp: 2 });
    expect(perfectPower(P0 ** 3n)).toEqual({ root: P0, exp: 3 });
    expect(perfectPower(P0 * P1)).toBeNull();
  });

  it('factors numbers with small primes, repeated primes and several large primes', () => {
    const n = 2n ** 5n * 3n * 7n * 1000003n * 1000033n;
    const r = factorize(n, 5000);
    expect(r.complete).toBe(true);
    expect([...r.primes.entries()].sort(([a], [b]) => (a < b ? -1 : 1))).toEqual([
      [2n, 5],
      [3n, 1],
      [7n, 1],
      [1000003n, 1],
      [1000033n, 1],
    ]);
    const sq = factorize(P0 * P0, 5000);
    expect(sq.complete).toBe(true);
    expect(sq.primes.get(P0)).toBe(2);
    expect(sq.methods).toContain('perfect power');
  });

  it('returns the unfactored part when the budget runs out', () => {
    const r = factorize(P0 * P1, 300);
    expect(r.complete).toBe(false);
    expect(r.unfactored).toEqual([P0 * P1]);
    expect(r.elapsedMs).toBeLessThan(2500);
  });
});

describe('attacks (building blocks)', () => {
  it('factorFromPhi and factorFromPrivateExponent recover p and q', () => {
    const n = P0 * P1;
    const phi = phiOf2(P0, P1);
    const [lo, hi] = P0 < P1 ? [P0, P1] : [P1, P0];
    expect(factorFromPhi(n, phi)).toEqual([lo, hi]);
    expect(factorFromPhi(n, phi + 2n)).toBeNull();
    const d = modInv(E, phi)!;
    expect(factorFromPrivateExponent(n, E, d)).toEqual([lo, hi]);
  });

  it('Wiener needs a small d', () => {
    const n = P0 * P1;
    const phi = phiOf2(P0, P1);
    const d = nextPrime(2n ** 240n + 12345n);
    const e = modInv(d, phi)!;
    expect(wiener(n, e)).toEqual({ d, p: P0 < P1 ? P0 : P1, q: P0 < P1 ? P1 : P0 });
    expect(wiener(n, E)).toBeNull();
  });

  it('crtExponentLeak finds the prime from dp', () => {
    const n = P0 * P1;
    const dp = modInv(E, P0 - 1n)!;
    expect(crtExponentLeak(n, E, dp)).toBe(P0);
  });

  it('commonModulus handles coprime and non-coprime exponents', () => {
    const n = P0 * P1;
    const m = msg('flag{common}');
    const r = commonModulus(n, 7n, E, modPow(m, 7n, n), modPow(m, E, n));
    expect(r).toEqual({ ok: true, m });
    const r2 = commonModulus(n, 4n, 6n, modPow(m, 4n, n), modPow(m, 6n, n));
    expect(r2).toEqual({ ok: true, m });
  });

  it('hastad needs enough moduli', () => {
    const ns = [P0 * P1, P2 * P3, P4 * P5];
    const m = msg('f'.repeat(90));
    const cs = ns.map((n) => modPow(m, 3n, n));
    expect(hastad(cs, ns, 3)).toBe(m);
    // m^3 has 2160 bits: two 1024-bit moduli are not enough, but a short message needs only two
    expect(hastad(cs.slice(0, 2), ns.slice(0, 2), 3)).toBeNull();
    const short = msg('f'.repeat(60));
    const two = ns.slice(0, 2);
    expect(
      hastad(
        two.map((n) => modPow(short, 3n, n)),
        two,
        3,
      ),
    ).toBe(short);
  });

  it('smallExponentScan finds m^e = c + k*n', () => {
    const n = P0 * P1;
    const m = iroot(n * 37n, 3) + 5n;
    const c = modPow(m, 3n, n);
    const hit = smallExponentScan(c, n, 3, 1 << 12, Date.now() + 5000)!;
    expect(hit.m).toBe(m);
    expect(hit.k).toBe(Number((m ** 3n - c) / n));
    expect(smallExponentScan(c, n, 3, 5, Date.now() + 5000)).toBeNull();
  });

  it('rabinRoots returns the four square roots', () => {
    const [pp, qq] = [nextPrime3Mod4(P0), nextPrime3Mod4(P1)];
    const n = pp * qq;
    const m = msg('flag{rabin}');
    const roots = rabinRoots((m * m) % n, pp, qq);
    expect(roots).toHaveLength(4);
    expect(roots).toContain(m);
    for (const r of roots) expect((r * r) % n).toBe((m * m) % n);
  });
});

describe('input parsing', () => {
  it('accepts name = value, name: value, hex, JSON and Python dict dumps', () => {
    const forms = [
      'n = 3233\ne = 17\nc = 2790',
      'N: 3233\nE: 17\nC: 2790',
      '{"n": 3233, "e": 17, "c": 2790}',
      "{'n': 3233, 'e': 17, 'c': '2790'}",
      'n=0xca1, e=0x11, c=0xae6',
      'modulus = 3233, exponent = 17, ciphertext = 2790',
      'n = 3233L\ne = 17L\nc = 2790L',
    ];
    for (const f of forms) {
      const { insts } = parseInput(f);
      expect(insts).toHaveLength(1);
      expect(insts[0]).toMatchObject({ n: 3233n, e: 17n, c: 2790n });
    }
  });

  it('derives n and the missing prime from p and q', () => {
    expect(parseInput('p = 61\nq = 53\ne = 17').insts[0]!.n).toBe(3233n);
    const one = parseInput('n = 3233\np = 61').insts[0]!;
    expect(one.q).toBe(53n);
  });

  it('groups n1/c1, n2/c2 and shared values into instances', () => {
    const { insts } = parseInput('e = 3\nn1 = 100\nc1 = 5\nn2 = 200\nc2 = 6\nn3 = 300\nc3 = 7');
    expect(insts.map((i) => [i.label, i.n, i.e, i.c])).toEqual([
      ['#1', 100n, 3n, 5n],
      ['#2', 200n, 3n, 6n],
      ['#3', 300n, 3n, 7n],
    ]);
    const common = parseInput('n = 3233\ne1 = 17\ne2 = 5\nc1 = 1\nc2 = 2').insts;
    expect(common.map((i) => [i.n, i.e, i.c])).toEqual([
      [3233n, 17n, 1n],
      [3233n, 5n, 2n],
    ]);
  });

  it('groups repeated names in order', () => {
    const { insts } = parseInput('e = 3\nn = 100\nc = 5\nn = 200\nc = 6');
    expect(insts.map((i) => [i.n, i.e, i.c])).toEqual([
      [100n, 3n, 5n],
      [200n, 3n, 6n],
    ]);
  });

  it('explains what is wrong', () => {
    expect(() => parseInput('hello world')).toThrow(ToolError);
    expect(() => parseInput('e = 3\nc = 5')).toThrow(/modulus n is missing/);
    expect(() => parseInput('n = 2\ne = 3')).toThrow(/at least 4/);
    expect(parseInput('n = 3233\np = 7').warnings.join()).toMatch(/does not divide n/);
  });
});

describe('rsa tool: key material that is already known', () => {
  const n = P0 * P1;
  const phi = phiOf2(P0, P1);
  const m = msg('flag{rsa_by_the_book}');
  const c = modPow(m, E, n);
  const d = modInv(E, phi)!;

  it('decrypts with p and q', async () => {
    const r = await solve(lines({ n, e: E, c, p: P0, q: P1 }));
    expect(r.text).toContain('flag{rsa_by_the_book}');
    expect(worked(r.rows, 'Known p, q')).toBe(true);
    expect(r.text).toContain(`d: ${d}`);
    expect(r.text).toContain(`φ(n): ${phi}`);
  });

  it('decrypts with p alone (q is n / p)', async () => {
    const r = await solve(lines({ n, e: E, c, q: P1 }));
    expect(r.text).toContain('flag{rsa_by_the_book}');
  });

  it('decrypts with d', async () => {
    const r = await solve(lines({ n, e: E, c, d }));
    expect(r.text).toContain('flag{rsa_by_the_book}');
    expect(worked(r.rows, 'Known d')).toBe(true);
    expect(r.text).toContain(`p: ${P0 < P1 ? P0 : P1}`);
  });

  it('decrypts with phi', async () => {
    const r = await solve(lines({ n, e: E, c, phi }));
    expect(r.text).toContain('flag{rsa_by_the_book}');
    expect(worked(r.rows, 'Known φ')).toBe(true);
  });

  it('decrypts with the dp leak, and with dq', async () => {
    const dp = modInv(E, P0 - 1n)!;
    const a = await solve(lines({ n, e: E, c, dp }));
    expect(a.text).toContain('flag{rsa_by_the_book}');
    expect(worked(a.rows, 'dp / dq leak')).toBe(true);
    const dq = modInv(E, P1 - 1n)!;
    const b = await solve(lines({ n, e: E, c, dq }));
    expect(b.text).toContain('flag{rsa_by_the_book}');
  });

  it('reads Python-dict and hex dumps', async () => {
    const dump = `{'n': 0x${n.toString(16)}, 'e': ${E}, 'c': ${c}, 'p': ${P0}, 'q': ${P1}}`;
    expect((await solve(dump)).text).toContain('flag{rsa_by_the_book}');
  });
});

describe('rsa tool: attacks without key material', () => {
  it('Fermat breaks close primes', async () => {
    const q = nextPrime(P0 + 2n ** 80n);
    expect(gcd(E, q - 1n)).toBe(1n);
    const n = P0 * q;
    const c = modPow(msg('flag{fermat_works}'), E, n);
    const r = await solve(lines({ n, e: E, c }));
    expect(r.text).toContain('flag{fermat_works}');
    expect(r.rows.find((x) => x.attack === 'Factor n')?.detail).toContain('Fermat');
  });

  it('factors a small n (trial division, p-1, rho)', async () => {
    const p = 1000000007n;
    const q = 998244353n;
    const n = p * q;
    const m = msg('flag{}');
    const e = 65537n;
    const r = await solve(lines({ n, e, c: modPow(m, e, n) }));
    expect(r.text).toContain('flag{}');
    expect(r.rows.some((x) => x.attack === 'Factor n' && x.status === 'worked')).toBe(true);
  });

  it('handles an n with three primes', async () => {
    const [a, b, d] = [1000003n, 1000033n, 1000037n];
    const n = a * b * d;
    const m = 123456789012345n;
    const r = await solve(lines({ n, e: 65537, c: modPow(m, 65537n, n) }));
    expect(r.text).toContain(`m (decimal): ${m}`);
  });

  it('n prime: phi = n - 1', async () => {
    const n = P0;
    const m = msg('flag{n_is_prime}');
    const r = await solve(lines({ n, e: E, c: modPow(m, E, n) }));
    expect(r.text).toContain('flag{n_is_prime}');
    expect(worked(r.rows, 'n is prime')).toBe(true);
  });

  it('n = p^2: phi = p(p-1)', async () => {
    const n = P0 * P0;
    const m = msg('flag{prime_power}');
    const r = await solve(lines({ n, e: E, c: modPow(m, E, n) }));
    expect(r.text).toContain('flag{prime_power}');
    expect(worked(r.rows, 'n = p^k')).toBe(true);
  });

  it('e = 1 leaves c unencrypted', async () => {
    const n = P0 * P1;
    const c = msg('flag{no_encryption}');
    const r = await solve(lines({ n, e: 1, c }));
    expect(r.text).toContain('flag{no_encryption}');
    expect(worked(r.rows, 'e = 1')).toBe(true);
  });

  it('small e: m^e < n, integer root', async () => {
    const n = P0 * P1;
    const m = msg('flag{cube_root_of_c}');
    const r = await solve(lines({ n, e: 3, c: m ** 3n }));
    expect(r.text).toContain('flag{cube_root_of_c}');
    expect(worked(r.rows, 'Small e (integer root)')).toBe(true);
  });

  it('small e: m^e a few moduli above n', async () => {
    const n = P0 * P1;
    const m = iroot(n * 20n, 3) + 1n;
    expect(m ** 3n > n).toBe(true);
    const c = modPow(m, 3n, n);
    const r = await solve(lines({ n, e: 3, c }));
    expect(r.text).toContain(`m (decimal): ${m}`);
    expect(worked(r.rows, 'Small e (m^e = c + k·n)')).toBe(true);
  });

  it('Håstad broadcast with e = 3 and three moduli', async () => {
    const ns = [P0 * P1, P2 * P3, P4 * P5];
    const m = msg('flag{hastad_needs_three_ciphertexts_and_e_equals_three_xx}');
    expect(m ** 3n > ns[0]!).toBe(true);
    const input = ns.map((n, i) => lines({ [`n${i + 1}`]: n, [`c${i + 1}`]: modPow(m, 3n, n) }));
    const r = await solve(`e = 3\n${input.join('\n')}`);
    expect(r.text).toContain('flag{hastad_needs_three_ciphertexts_and_e_equals_three_xx}');
    expect(worked(r.rows, 'Håstad broadcast')).toBe(true);
    // identical plaintexts are shown once
    expect(r.out.filter((o) => o.type === 'bytes')).toHaveLength(1);
  });

  it('Håstad with e = 5 and one unrelated ciphertext among six', async () => {
    const primes = [...P, ...P.map((p) => nextPrime(p + 2n ** 90n))];
    const ns = Array.from({ length: 6 }, (_, i) => primes[2 * i]! * primes[2 * i + 1]!);
    const m = msg('f'.repeat(30) + 'lag{hastad_e5}');
    const other = msg('something else entirely');
    const cs = ns.map((n, i) => modPow(i === 2 ? other : m, 5n, n));
    const input = ns.map((n, i) => `n${i + 1} = ${n}\nc${i + 1} = ${cs[i]}`).join('\n');
    const r = await solve(`e = 5\n${input}`);
    expect(r.text).toContain('lag{hastad_e5}');
    expect(worked(r.rows, 'Håstad broadcast')).toBe(true);
  });

  it('Håstad with too few ciphertexts says what is missing', async () => {
    const ns = [P0 * P1, P2 * P3];
    const m = msg('f'.repeat(90));
    const input = ns.map((n, i) => `n${i + 1} = ${n}\nc${i + 1} = ${modPow(m, 3n, n)}`).join('\n');
    const r = await solve(`e = 3\n${input}`, 0.3);
    const row = r.rows.find((x) => x.attack === 'Håstad broadcast');
    expect(row?.status).toBe('failed');
    expect(row?.detail).toMatch(/3 ciphertexts under different moduli are needed, 2 given/);
  });

  it('Wiener recovers a small private exponent', async () => {
    const n = P0 * P1;
    const phi = phiOf2(P0, P1);
    const d = nextPrime(2n ** 245n + 99n);
    expect(gcd(d, phi)).toBe(1n);
    const e = modInv(d, phi)!;
    const m = msg('flag{wiener_small_d}');
    const r = await solve(lines({ n, e, c: modPow(m, e, n) }));
    expect(r.text).toContain('flag{wiener_small_d}');
    expect(worked(r.rows, 'Wiener')).toBe(true);
    expect(r.text).toContain(`d: ${d}`);
  });

  it('common modulus (same n, two exponents)', async () => {
    const n = P0 * P1;
    const m = msg('flag{common_modulus_attack}');
    const r = await solve(lines({ n, e1: 7, e2: E, c1: modPow(m, 7n, n), c2: modPow(m, E, n) }));
    expect(r.text).toContain('flag{common_modulus_attack}');
    expect(worked(r.rows, 'Common modulus')).toBe(true);
  });

  it('shared prime between two moduli', async () => {
    const shared = P0;
    const n1 = shared * P1;
    const n2 = shared * P2;
    const m1 = msg('flag{first_modulus}');
    const m2 = msg('flag{second_modulus}');
    const r = await solve(lines({ n1, c1: modPow(m1, E, n1), n2, c2: modPow(m2, E, n2), e: E }));
    expect(r.text).toContain('flag{first_modulus}');
    expect(r.text).toContain('flag{second_modulus}');
    expect(worked(r.rows, 'Shared factor (gcd)')).toBe(true);
  });

  it('even e: the four Rabin square roots, best one first', async () => {
    const [p, q] = [nextPrime3Mod4(P0), nextPrime3Mod4(P1)];
    expect([p % 4n, q % 4n]).toEqual([3n, 3n]);
    const n = p * q;
    const m = msg('flag{rabin_square_roots}');
    const r = await solve(lines({ n, e: 2, c: (m * m) % n, p, q }));
    expect(r.text).toContain('flag{rabin_square_roots}');
    expect(r.text).toContain('square-root candidates');
    expect(r.text).toContain('Rabin');
  });
});

describe('rsa tool: reporting', () => {
  it('lists what is missing when n cannot be factored, within the time budget', async () => {
    const n = P0 * P1;
    const c = modPow(msg('flag{unreachable}'), E, n);
    const t0 = Date.now();
    const r = await solve(lines({ n, e: E, c }), 0.4);
    expect(Date.now() - t0).toBeLessThan(4000);
    expect(r.text).not.toContain('flag{unreachable}');
    expect(r.text).toContain('could not be factored');
    expect(r.text).toContain('factordb.com');
    expect(r.text).toMatch(/Missing: p and q, or φ\(n\), or d, or dp\/dq/);
    expect(r.rows.every((x) => x.status !== 'worked')).toBe(true);
    expect(r.out.some((o) => o.type === 'note' && o.level === 'error')).toBe(true);
  });

  it('reports key material even without a ciphertext', async () => {
    const q = nextPrime(P0 + 2n ** 70n);
    const r = await solve(lines({ n: P0 * q, e: E }));
    expect(r.text).toContain(`p: ${P0}`);
    expect(r.text).toContain(`q: ${q}`);
    expect(r.text).toContain('No ciphertext c given');
  });

  it('asks for e when only n and c are given', async () => {
    const r = await solve(lines({ n: 1000003n * 1000033n, c: 12345 }));
    expect(r.text).toContain('the public exponent e is missing');
  });

  it('says when e shares a factor with phi and no square-root trick applies', async () => {
    const [p, q] = [1000003n, 1000033n];
    const n = p * q;
    // gcd(3, phi) = 3 for p = 1000003 (p - 1 = 2 * 3 * 166667)
    expect(gcd(3n, phiOf2(p, q))).toBe(3n);
    const r = await solve(lines({ n, e: 3, c: 123456789012345n, p, q }));
    expect(r.text).toMatch(/not coprime to φ\(n\)/);
  });

  it('warns when c is not smaller than n', async () => {
    const r = await solve(lines({ n: 3233, e: 17, c: 3233 + 2790 }));
    expect(r.text).toContain('c is not smaller than n');
  });

  it('is deterministic', async () => {
    const n = P0 * nextPrime(P0 + 2n ** 70n);
    const input = lines({ n, e: E, c: modPow(msg('flag{same}'), E, n) });
    expect((await solve(input)).text.replaceAll(/\(\d+ ms\)/g, '')).toBe(
      (await solve(input)).text.replaceAll(/\(\d+ ms\)/g, ''),
    );
  });

  it('rejects empty input with a hint', () => {
    expect(() => tool.run('   ', { budget: 2 })).toThrow(ToolError);
  });

  it('detects RSA dumps and nothing else', () => {
    const rsa = `n = ${P0 * P1}\ne = 65537\nc = 1234567`;
    expect(tool.detect?.({ text: rsa, bytes: utf8Encode(rsa) })?.score).toBeGreaterThan(0.8);
    const plain = 'hello there, just some prose with n = 5';
    expect(tool.detect?.({ text: plain, bytes: utf8Encode(plain) })).toBeNull();
    expect(tool.detect?.({ text: null, bytes: new Uint8Array(3) })).toBeNull();
  });
});
