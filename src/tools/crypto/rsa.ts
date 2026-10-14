import { defineTool, number } from '../../core/define';
import { ToolError } from '../../core/errors';
import type { Output } from '../../core/types';
import { printableRatio, utf8Decode } from '../../lib/bytes';
import {
  bitLength,
  exactRoot,
  gcd,
  isProbablePrime,
  longToBytes,
  mod,
  modInv,
  modPow,
  parseBigInt,
  toHexString,
} from './_bigint';
import {
  combinations,
  commonModulus,
  crtExponentLeak,
  factorFromPhi,
  factorFromPrivateExponent,
  hastad,
  rabinRoots,
  smallExponentScan,
  wiener,
} from './_rsa-attacks';
import { COMMON, FERMAT, HASTAD, SMALL_E, TINY, WIENER } from './_rsa-examples';
import { factorize, totient } from './_rsa-factor';

// ---------------------------------------------------------------------------------------------
// Parsing: `n = …`, `e: 0x10001`, {"c": "123"}, n1/c1/n2/c2, Python dumps. Never evaluates code.
// ---------------------------------------------------------------------------------------------

type Key = 'n' | 'e' | 'c' | 'p' | 'q' | 'd' | 'dp' | 'dq' | 'phi';

const ALIASES: Record<string, Key | 'ignore'> = {
  n: 'n',
  modulus: 'n',
  mod: 'n',
  e: 'e',
  exp: 'e',
  exponent: 'e',
  pubexp: 'e',
  publicexponent: 'e',
  c: 'c',
  ct: 'c',
  cipher: 'c',
  ciphertext: 'c',
  cyphertext: 'c',
  enc: 'c',
  encrypted: 'c',
  p: 'p',
  prime1: 'p',
  q: 'q',
  prime2: 'q',
  d: 'd',
  privateexponent: 'd',
  privexp: 'd',
  dp: 'dp',
  dmp1: 'dp',
  exponent1: 'dp',
  dq: 'dq',
  dmq1: 'dq',
  exponent2: 'dq',
  phi: 'phi',
  phin: 'phi',
  totient: 'phi',
  qinv: 'ignore',
  iqmp: 'ignore',
  coefficient: 'ignore',
  m: 'ignore',
};

function classify(raw: string): { key: Key; idx: string | null } | null {
  const name = raw.toLowerCase().replace(/_/g, '');
  const full = Object.hasOwn(ALIASES, name) ? ALIASES[name] : undefined;
  if (full) return full === 'ignore' ? null : { key: full, idx: null };
  const split = /^([a-z]+?)(\d+)$/.exec(name);
  const base = split && Object.hasOwn(ALIASES, split[1]!) ? ALIASES[split[1]!] : undefined;
  return split && base && base !== 'ignore' ? { key: base, idx: split[2]! } : null;
}

const ASSIGNMENT =
  /(?<![A-Za-z0-9_])["']?([A-Za-z][A-Za-z0-9_]*)["']?\s*[:=]\s*["'(]?\s*(0[xX][0-9a-fA-F]+|[0-9a-fA-F]+)[lL]?(?![A-Za-z0-9_])/g;

interface Entry {
  key: Key;
  idx: string | null;
  value: bigint;
}

function scan(text: string): Entry[] {
  const out: Entry[] = [];
  for (const m of text.matchAll(ASSIGNMENT)) {
    const cls = classify(m[1]!);
    const value = parseBigInt(m[2]!);
    if (cls && value !== null) out.push({ ...cls, value });
  }
  return out;
}

export interface Inst {
  /** '' for a single instance, '#1', '#2'… when several are pasted. */
  label: string;
  n: bigint;
  e?: bigint;
  c?: bigint;
  p?: bigint;
  q?: bigint;
  d?: bigint;
  dp?: bigint;
  dq?: bigint;
  phi?: bigint;
}

type Params = Partial<Record<Key, bigint>>;

/** Group the assignments into instances: index suffixes first, else repeated names in order. */
function groupEntries(entries: Entry[]): { label: string; params: Params }[] {
  const indices = [...new Set(entries.flatMap((e) => (e.idx === null ? [] : [e.idx])))].sort(
    (a, b) => Number(a) - Number(b),
  );
  if (indices.length > 0) {
    const shared: Params = {};
    for (const e of entries) if (e.idx === null) shared[e.key] = e.value;
    return indices.map((idx) => {
      const params: Params = { ...shared };
      for (const e of entries) if (e.idx === idx) params[e.key] = e.value;
      return { label: `#${Number(idx)}`, params };
    });
  }
  const perKey = new Map<Key, bigint[]>();
  for (const e of entries) perKey.set(e.key, [...(perKey.get(e.key) ?? []), e.value]);
  const count = Math.max(1, ...[...perKey.values()].map((v) => v.length));
  return Array.from({ length: count }, (_, i) => {
    const params: Params = {};
    for (const [key, values] of perKey) {
      const v = values.length === 1 ? values[0] : values[i];
      if (v !== undefined) params[key] = v;
    }
    return { label: count > 1 ? `#${i + 1}` : '', params };
  });
}

export function parseInput(text: string): { insts: Inst[]; warnings: string[] } {
  const entries = scan(text);
  if (entries.length === 0) {
    throw new ToolError(
      'No RSA parameters found. Write one per line, e.g. "n = 0x…", "e = 65537", "c = 1234…" ' +
        '(decimal or 0x hex; also p, q, d, dp, dq, phi; n1/c1, n2/c2 for several instances).',
    );
  }
  const warnings: string[] = [];
  const insts: Inst[] = [];
  for (const { label, params } of groupEntries(entries)) {
    const at = label ? ` ${label}` : '';
    const p = params.p;
    const q = params.q;
    let n = params.n;
    if (n === undefined && p !== undefined && q !== undefined) n = p * q;
    if (n === undefined) {
      warnings.push(`Instance${at} has no modulus n (and no p and q): ignored.`);
      continue;
    }
    if (n < 4n) throw new ToolError(`The modulus n${at} must be at least 4 (got ${n}).`);
    const inst: Inst = { ...params, n, label };
    for (const key of ['p', 'q'] as const) {
      const f = inst[key];
      if (f !== undefined && (f < 2n || f >= n || n % f !== 0n)) {
        warnings.push(`${key}${at} does not divide n: ignored.`);
        delete inst[key];
      }
    }
    if (inst.p !== undefined && inst.q === undefined && n % inst.p === 0n) inst.q = n / inst.p;
    if (inst.q !== undefined && inst.p === undefined && n % inst.q === 0n) inst.p = n / inst.q;
    if (inst.c !== undefined && inst.c >= n) {
      warnings.push(`c${at} is not smaller than n: the plaintext can only be recovered modulo n.`);
    }
    insts.push(inst);
  }
  if (insts.length === 0) {
    throw new ToolError('The modulus n is missing: add a line like "n = 0x…" (or give p and q).');
  }
  return { insts, warnings };
}

// ---------------------------------------------------------------------------------------------
// Analysis: run the attacks in order of cost, stop on each instance as soon as it is decrypted.
// ---------------------------------------------------------------------------------------------

export interface Attempt {
  attack: string;
  target: string;
  status: 'worked' | 'failed' | 'not applicable';
  detail: string;
}

/** What is known about a modulus: its prime factors so far and the composite rest. */
export interface Modulus {
  n: bigint;
  tag: string;
  primes: Map<bigint, number>;
  composites: bigint[];
  /** φ(n) when it was given but n could not be split with it. */
  phi?: bigint;
  via: string[];
  tried: string[];
}

export interface Plain {
  /** One candidate, or several for even e (square roots modulo n). */
  m: bigint[];
  via: string;
}

export interface Analysis {
  insts: Inst[];
  mods: Modulus[];
  solved: Map<Inst, Plain>;
  privateExponents: Map<Inst, bigint>;
  blocked: Map<Inst, string>;
  attempts: Attempt[];
  budgetMs: number;
}

const complete = (m: Modulus) => m.composites.length === 0;
const phiOf = (m: Modulus): bigint | undefined => (complete(m) ? totient(m.primes) : m.phi);

function addPrime(m: Modulus, p: bigint) {
  m.primes.set(p, (m.primes.get(p) ?? 0) + 1);
}

function place(m: Modulus, piece: bigint) {
  if (piece === 1n) return;
  if (isProbablePrime(piece)) addPrime(m, piece);
  else m.composites.push(piece);
}

/** Record that f divides n (f may be composite). Returns true when this taught us something. */
function absorb(m: Modulus, f: bigint, via: string): boolean {
  if (f <= 1n || f >= m.n) return false;
  const idx = m.composites.findIndex((c) => c % f === 0n && c !== f);
  if (idx < 0) {
    const i = m.composites.indexOf(f);
    if (i < 0) return false;
    m.composites.splice(i, 1);
    place(m, f);
  } else {
    const c = m.composites[idx]!;
    m.composites.splice(idx, 1);
    place(m, f);
    place(m, c / f);
  }
  if (!m.via.includes(via)) m.via.push(via);
  return true;
}

const showFactors = (m: Modulus) =>
  [...m.primes.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([p, k]) => (k > 1 ? `${p}^${k}` : `${p}`))
    .join(' · ');

const viaLabel = (m: Modulus) => m.via.join(' + ') || 'Known factors';

const MAX_SCAN_E = 64;
const SCAN_LIMIT = 1 << 20;

/** Rabin-style decryption when e = 2^j * e' shares its 2-part with φ(n) (n = p*q, p, q odd). */
function evenExponentCandidates(c: bigint, n: bigint, e: bigint, m: Modulus): bigint[] | null {
  const entries = [...m.primes.entries()];
  const phi = phiOf(m);
  if (!complete(m) || phi === undefined || entries.length !== 2) return null;
  const [[p, kp], [q, kq]] = entries as [[bigint, number], [bigint, number]];
  if (kp !== 1 || kq !== 1 || p === 2n || q === 2n) return null;
  let odd = e;
  let j = 0;
  while ((odd & 1n) === 0n) {
    odd >>= 1n;
    j++;
  }
  if (j < 1 || j > 3 || gcd(odd, phi) !== 1n) return null;
  const inv = modInv(odd, phi);
  if (inv === null) return null;
  let roots = [modPow(c, inv, n)];
  for (let i = 0; i < j; i++) roots = [...new Set(roots.flatMap((r) => rabinRoots(r, p, q)))];
  return roots;
}

export function analyze(insts: Inst[], budgetMs: number): Analysis {
  const attempts: Attempt[] = [];
  const solved = new Map<Inst, Plain>();
  const privateExponents = new Map<Inst, bigint>();
  const blocked = new Map<Inst, string>();
  const byN = new Map<string, Modulus>();
  const many = insts.length > 1;

  const log = (attack: string, target: string, status: Attempt['status'], detail: string) =>
    attempts.push({ attack, target, status, detail });
  const tgt = (i: Inst) => i.label || 'n';
  const modOf = (i: Inst): Modulus => {
    const key = i.n.toString();
    let m = byN.get(key);
    if (!m) {
      m = {
        n: i.n,
        tag: i.label,
        primes: new Map(),
        composites: [i.n],
        via: [],
        tried: [],
      };
      byN.set(key, m);
    }
    return m;
  };
  for (const i of insts) modOf(i);
  const pending = () => insts.filter((i) => i.c !== undefined && !solved.has(i));

  /** Decrypt every instance whose key material is now known. */
  const decryptKnown = () => {
    for (const inst of pending()) {
      const c = inst.c!;
      const m = modOf(inst);
      if (inst.d !== undefined) {
        privateExponents.set(inst, inst.d);
        solved.set(inst, { m: [modPow(c, inst.d, inst.n)], via: 'Known d' });
        continue;
      }
      const phi = phiOf(m);
      if (inst.e === undefined || phi === undefined) continue;
      const d = modInv(inst.e, phi);
      if (d !== null) {
        privateExponents.set(inst, d);
        solved.set(inst, { m: [modPow(c, d, inst.n)], via: viaLabel(m) });
        continue;
      }
      const roots = evenExponentCandidates(c, inst.n, inst.e, m);
      if (roots && roots.length > 0) {
        solved.set(inst, { m: roots, via: `${viaLabel(m)} + Rabin square roots` });
      } else {
        blocked.set(
          inst,
          `e = ${inst.e} is not coprime to φ(n) (gcd = ${gcd(inst.e, phi)}), so d does not exist` +
            (roots
              ? ' and c is not a square modulo n.'
              : '. Only e = 2^j·e′ with n = p·q is handled.'),
        );
      }
    }
  };

  // 1. Key material the user already has --------------------------------------------------------
  for (const inst of insts) {
    const m = modOf(inst);
    const t = tgt(inst);
    if (inst.p !== undefined || inst.q !== undefined) {
      for (const f of [inst.p, inst.q]) if (f !== undefined) absorb(m, f, 'Known p, q');
      if (!m.via.includes('Known p, q')) m.via.push('Known p, q');
      log(
        'Known p, q',
        t,
        'worked',
        complete(m) ? 'n = p · q, φ(n) computed' : 'n partly factored, the rest is factored below',
      );
    }
    if (inst.phi !== undefined) {
      m.phi ??= inst.phi;
      const pq = factorFromPhi(inst.n, inst.phi);
      if (pq) {
        absorb(m, pq[0], 'Known φ');
        absorb(m, pq[1], 'Known φ');
        log('Known φ', t, 'worked', 'p and q solve x² − (n − φ + 1)x + n = 0');
      } else {
        if (!m.via.includes('Known φ')) m.via.push('Known φ');
        log('Known φ', t, 'worked', 'φ used as given (n is not p·q with this φ: multi-prime n?)');
      }
    }
    if (inst.d !== undefined) {
      const pq = inst.e === undefined ? null : factorFromPrivateExponent(inst.n, inst.e, inst.d);
      if (pq) {
        absorb(m, pq[0], 'Known d');
        absorb(m, pq[1], 'Known d');
      }
      log(
        'Known d',
        t,
        'worked',
        inst.c !== undefined
          ? 'm = c^d mod n'
          : pq
            ? 'n factored from e·d − 1'
            : 'private key given',
      );
    }
    for (const key of ['dp', 'dq'] as const) {
      const v = inst[key];
      if (v === undefined) continue;
      const name = key === 'dp' ? 'dp' : 'dq';
      if (inst.e === undefined) {
        log('dp / dq leak', t, 'failed', `${name} given but e is missing`);
        continue;
      }
      const f = crtExponentLeak(inst.n, inst.e, v);
      if (f !== null && absorb(m, f, 'dp / dq leak')) {
        log('dp / dq leak', t, 'worked', `gcd(2^(e·${name}) − 2, n) is a prime factor of n`);
      } else {
        log('dp / dq leak', t, 'failed', `gcd(x^(e·${name}) − x, n) gave no factor`);
      }
    }
  }
  decryptKnown();

  // 2. Several moduli: shared prime -------------------------------------------------------------
  const mods = [...byN.values()];
  if (mods.length >= 2) {
    let shown = 0;
    let found = 0;
    let checked = 0;
    const total = (mods.length * (mods.length - 1)) / 2;
    const stopAt = Date.now() + budgetMs;
    pairs: for (let i = 0; i < mods.length; i++) {
      for (let j = i + 1; j < mods.length; j++) {
        if (Date.now() > stopAt) break pairs;
        checked++;
        const a = mods[i]!;
        const b = mods[j]!;
        const g = gcd(a.n, b.n);
        if (g === 1n || g === a.n || g === b.n) continue;
        absorb(a, g, 'Shared factor (gcd)');
        absorb(b, g, 'Shared factor (gcd)');
        found++;
        if (shown++ < 6) {
          log(
            'Shared factor (gcd)',
            `${a.tag || 'n'}, ${b.tag || 'n'}`,
            'worked',
            'gcd(n_i, n_j) > 1',
          );
        }
      }
    }
    if (found === 0) {
      log(
        'Shared factor (gcd)',
        `${mods.length} moduli`,
        'failed',
        checked < total
          ? `no shared prime in the first ${checked} of ${total} pairs (time limit)`
          : 'every pair of moduli is coprime',
      );
    }
    decryptKnown();
  }

  // 3. Several ciphertexts: Håstad broadcast and common modulus ----------------------------------
  if (many) {
    const byE = new Map<string, Inst[]>();
    for (const i of pending()) {
      if (i.e === undefined || i.e > 257n || i.e < 2n) continue;
      byE.set(i.e.toString(), [...(byE.get(i.e.toString()) ?? []), i]);
    }
    for (const group of byE.values()) {
      const e = Number(group[0]!.e);
      const distinct = [...new Map(group.map((i) => [i.n.toString(), i])).values()];
      if (distinct.length < 2) continue;
      const subsets = [
        distinct.map((_, i) => i),
        ...(distinct.length > e ? combinations(distinct.length, e, 200) : []),
      ];
      let done = false;
      for (const idxs of subsets) {
        const used = idxs.map((i) => distinct[i]!);
        const msg = hastad(
          used.map((i) => i.c!),
          used.map((i) => i.n),
          e,
        );
        if (msg === null) continue;
        for (const inst of group) {
          if (modPow(msg, BigInt(e), inst.n) === mod(inst.c!, inst.n)) {
            solved.set(inst, { m: [msg], via: 'Håstad broadcast' });
          }
        }
        log(
          'Håstad broadcast',
          used.map(tgt).join(', '),
          'worked',
          `CRT over ${used.length} moduli, then an exact integer root of degree ${e}`,
        );
        done = true;
        break;
      }
      if (!done) {
        log(
          'Håstad broadcast',
          `e = ${e}`,
          'failed',
          distinct.length < e
            ? `CRT result is not a perfect power; usually ${e} ciphertexts under different moduli are needed, ${distinct.length} given`
            : 'CRT result is not a perfect power (different messages, or padding was used)',
        );
      }
    }

    const sameN = new Map<string, Inst[]>();
    for (const i of pending()) {
      if (i.e === undefined) continue;
      sameN.set(i.n.toString(), [...(sameN.get(i.n.toString()) ?? []), i]);
    }
    for (const group of sameN.values()) {
      const exps = new Set(group.map((i) => i.e!.toString()));
      if (group.length < 2 || exps.size < 2) continue;
      let done = false;
      let reason = 'no pair of ciphertexts with different exponents';
      for (let a = 0; a < group.length && !done; a++) {
        for (let b = a + 1; b < group.length && !done; b++) {
          const x = group[a]!;
          const y = group[b]!;
          if (x.e === y.e || solved.has(x) || solved.has(y)) continue;
          const r = commonModulus(x.n, x.e!, y.e!, x.c!, y.c!);
          if (!r.ok) {
            reason = r.reason;
            if (r.factor !== undefined) absorb(modOf(x), r.factor, 'Common modulus');
            continue;
          }
          const good =
            modPow(r.m, x.e!, x.n) === mod(x.c!, x.n) && modPow(r.m, y.e!, y.n) === mod(y.c!, y.n);
          if (!good) {
            reason = 'the two ciphertexts do not encrypt the same message';
            continue;
          }
          solved.set(x, { m: [r.m], via: 'Common modulus' });
          solved.set(y, { m: [r.m], via: 'Common modulus' });
          log(
            'Common modulus',
            `${tgt(x)}, ${tgt(y)}`,
            'worked',
            `a·e1 + b·e2 = 1 (extended gcd), m = c1^a · c2^b mod n`,
          );
          done = true;
        }
      }
      if (!done) log('Common modulus', group.map(tgt).join(', '), 'failed', reason);
    }
    decryptKnown();
  }

  // 4. Cheap tests on each remaining ciphertext ---------------------------------------------------
  for (const inst of pending()) {
    const e = inst.e;
    if (e === undefined) continue;
    const t = tgt(inst);
    if (e === 1n) {
      solved.set(inst, { m: [mod(inst.c!, inst.n)], via: 'e = 1' });
      log('e = 1', t, 'worked', 'c = m mod n, nothing was encrypted');
      continue;
    }
    if (e <= 4096n) {
      const root = exactRoot(inst.c!, Number(e));
      if (root !== null) {
        solved.set(inst, { m: [root], via: 'Small e (integer root)' });
        log(
          'Small e (integer root)',
          t,
          'worked',
          `m^e < n, so c is a perfect power with exponent ${e}`,
        );
      } else {
        log(
          'Small e (integer root)',
          t,
          'failed',
          `c is not a perfect power with exponent ${e} (m^e wraps around n)`,
        );
      }
    }
  }

  // 5. Wiener (large e, small d) ------------------------------------------------------------------
  const anyCipher = insts.some((i) => i.c !== undefined);
  /** Still worth recovering the key of this modulus: it is open and a ciphertext waits for it. */
  const needsKey = (m: Modulus) =>
    !complete(m) && (!anyCipher || pending().some((i) => i.n === m.n));
  const wienerDone = new Set<string>();
  for (const inst of insts) {
    const m = modOf(inst);
    if (inst.e === undefined || !needsKey(m) || inst.d !== undefined) continue;
    const key = `${inst.n}/${inst.e}`;
    if (wienerDone.has(key)) continue;
    wienerDone.add(key);
    if (bitLength(inst.e) * 2 < bitLength(inst.n)) {
      log(
        'Wiener',
        tgt(inst),
        'not applicable',
        `e has only ${bitLength(inst.e)} bits; Wiener needs a large e`,
      );
      continue;
    }
    const w = wiener(inst.n, inst.e);
    if (w) {
      absorb(m, w.p, 'Wiener');
      absorb(m, w.q, 'Wiener');
      log(
        'Wiener',
        tgt(inst),
        'worked',
        `continued fraction of e/n gives d (${bitLength(w.d)} bits)`,
      );
    } else {
      log('Wiener', tgt(inst), 'failed', 'no convergent of e/n gives a valid d (d is not small)');
    }
  }
  decryptKnown();

  // 6. m^e slightly above n -----------------------------------------------------------------------
  for (const inst of pending()) {
    const e = inst.e;
    if (e === undefined || e < 2n || e > BigInt(MAX_SCAN_E) || bitLength(inst.n) < 128) continue;
    const hit = smallExponentScan(inst.c!, inst.n, Number(e), SCAN_LIMIT, Date.now() + 800);
    if (hit) {
      solved.set(inst, { m: [hit.m], via: 'Small e (m^e = c + k·n)' });
      log(
        'Small e (m^e = c + k·n)',
        tgt(inst),
        'worked',
        `k = ${hit.k}: c + k·n is a perfect power with exponent ${e}`,
      );
    } else {
      log(
        'Small e (m^e = c + k·n)',
        tgt(inst),
        'failed',
        `no k up to ${SCAN_LIMIT} makes c + k·n a perfect power with exponent ${e}`,
      );
    }
  }

  // 7. Factor n (trial division, Fermat, Pollard p-1, Pollard rho) --------------------------------
  const targets = [...byN.values()].filter(needsKey);
  const share = Math.max(300, Math.floor(budgetMs / Math.max(1, targets.length)));
  for (const m of targets) {
    const fromScratch = m.primes.size === 0;
    const label = m.tag || 'n';
    const methods: string[] = [];
    for (const comp of [...m.composites]) {
      const r = factorize(comp, share);
      methods.push(...r.methods);
      m.composites.splice(m.composites.indexOf(comp), 1);
      for (const [p, k] of r.primes) m.primes.set(p, (m.primes.get(p) ?? 0) + k);
      m.composites.push(...r.unfactored);
    }
    const used = [...new Set(methods)];
    m.tried = ['trial division (primes < 200 000)', 'Fermat', 'Pollard p−1', 'Pollard rho'];
    if (complete(m)) {
      const single = fromScratch && m.primes.size === 1;
      const attack = single ? ([...m.primes][0]![1] === 1 ? 'n is prime' : 'n = p^k') : 'Factor n';
      if (single) m.via = [attack];
      else for (const v of used) if (!m.via.includes(v)) m.via.push(v);
      const text = showFactors(m);
      const how = used.length > 0 ? ` via ${used.join(', ')}` : '';
      log(
        attack,
        label,
        'worked',
        `${text.length <= 90 ? `n = ${text}` : 'n fully factored'}${how}`,
      );
    } else if (m.primes.size > 0) {
      const rest = bitLength(m.composites.reduce((a, b) => a * b, 1n));
      log(
        'Factor n',
        label,
        'failed',
        `partial: ${m.primes.size} prime factor(s), a ${rest}-bit cofactor remains`,
      );
    } else {
      const secs = (share / 1000).toFixed(1);
      log('Factor n', label, 'failed', `${bitLength(m.n)}-bit n not factored in ${secs} s`);
    }
  }
  decryptKnown();

  return {
    insts,
    mods: [...byN.values()],
    solved,
    privateExponents,
    blocked,
    attempts,
    budgetMs,
  };
}

// ---------------------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------------------

const bitsOf = (n: bigint) => `${bitLength(n)} bits`;

function bestFirst(candidates: bigint[]): { m: bigint; bytes: Uint8Array; score: number }[] {
  return candidates
    .map((m) => {
      const bytes = longToBytes(m);
      return { m, bytes, score: printableRatio(bytes) };
    })
    .sort((a, b) => b.score - a.score);
}

/** `insts` all decrypt to the same plaintext (typical for Håstad and common modulus). */
function plaintextBlocks(insts: Inst[], plain: Plain): Output[] {
  const tag = insts[0]!.label ? ` ${insts.map((i) => i.label).join(', ')}` : '';
  const ranked = bestFirst(plain.m);
  const best = ranked[0]!;
  const out: Output[] = [
    {
      type: 'bytes',
      label: `Plaintext${tag} · long_to_bytes(m)`,
      value: best.bytes,
      filename: 'plaintext.bin',
    },
    {
      type: 'kv',
      label: `m${tag}`,
      entries: [
        ['Recovered by', plain.via],
        ['m (decimal)', best.m.toString()],
        ['m (hex)', toHexString(best.m)],
      ],
    },
  ];
  if (ranked.length > 1) {
    out.push({
      type: 'table',
      label: `All ${ranked.length} square-root candidates${tag}`,
      columns: ['#', 'Printable', 'As text'],
      rows: ranked.map((r, i) => [
        i + 1,
        `${Math.round(r.score * 100)} %`,
        r.score > 0.9 ? utf8Decode(r.bytes) : '',
      ]),
      highlight: [0],
    });
  }
  return out;
}

function keyBlock(a: Analysis, m: Modulus): Output | null {
  const entries: [string, string][] = [['n', bitsOf(m.n)]];
  const phi = phiOf(m);
  if (m.primes.size > 0) {
    const sorted = [...m.primes.entries()].sort(([x], [y]) => (x < y ? -1 : 1));
    if (complete(m) && sorted.length === 2 && sorted.every(([, k]) => k === 1)) {
      entries.push(['p', sorted[0]![0].toString()], ['q', sorted[1]![0].toString()]);
    } else {
      entries.push([complete(m) ? 'factors' : 'factors found', showFactors(m)]);
    }
  }
  if (!complete(m) && m.primes.size > 0) {
    entries.push(['unfactored rest', m.composites.map((c) => bitsOf(c)).join(', ')]);
  }
  if (phi !== undefined) entries.push(['φ(n)', phi.toString()]);
  const seen = new Set<string>();
  for (const inst of a.insts) {
    const d = a.privateExponents.get(inst);
    if (d === undefined || inst.n !== m.n || seen.has(`${inst.e}`)) continue;
    seen.add(`${inst.e}`);
    entries.push([
      a.insts.length > 1 && inst.e !== undefined ? `d (e = ${inst.e})` : 'd',
      d.toString(),
    ]);
  }
  if (entries.length === 1) return null;
  return { type: 'kv', label: `Key material${m.tag ? ` ${m.tag}` : ''}`, entries };
}

function failureNotes(a: Analysis): Output[] {
  const out: Output[] = [];
  const seenMods = new Set<Modulus>();
  const lines: string[] = [];
  for (const inst of a.insts) {
    if (inst.c === undefined || a.solved.has(inst)) continue;
    const m = a.mods.find((x) => x.n === inst.n)!;
    const tag = inst.label ? ` ${inst.label}` : '';
    const reason = a.blocked.get(inst);
    if (reason) {
      lines.push(`Could not decrypt c${tag}: ${reason}`);
    } else if (inst.e === undefined) {
      lines.push(
        `Could not decrypt c${tag}: the public exponent e is missing (add "e = 65537" or similar).`,
      );
    } else if (!complete(m)) {
      if (seenMods.has(m)) continue;
      seenMods.add(m);
      const secs = (a.budgetMs / 1000).toFixed(1);
      lines.push(
        `n${m.tag ? ` ${m.tag}` : ''} (${bitsOf(m.n)}) could not be factored in ${secs} s ` +
          `(tried ${m.tried.join(', ') || 'nothing'}). Missing: p and q, or φ(n), or d, or dp/dq. ` +
          'Try factordb.com manually (this tool never goes online) or yafu / msieve / CADO-NFS; ' +
          'RsaCtfTool has more attacks. Extra ciphertexts help too: several n with the same small e ' +
          '(Håstad), a repeated n with another e (common modulus), or moduli sharing a prime.',
      );
    }
  }
  for (const line of lines) out.push({ type: 'note', level: 'error', text: line });
  if (!a.insts.some((i) => i.c !== undefined)) {
    const found = a.mods.some((m) => m.primes.size > 0);
    out.push({
      type: 'note',
      level: found ? 'info' : 'warn',
      text: found
        ? 'No ciphertext c given: only the key material was recovered.'
        : 'No ciphertext c given and n could not be broken. Add c to decrypt once the key is known.',
    });
  }
  return out;
}

export function render(a: Analysis, warnings: string[]): Output[] {
  const out: Output[] = [];
  if (a.solved.size > 0) {
    const methods = [...new Set([...a.solved.values()].map((p) => p.via))];
    out.push({
      type: 'note',
      level: 'success',
      text: `Decrypted ${a.solved.size} of ${a.insts.filter((i) => i.c !== undefined).length} ciphertext(s) with: ${methods.join('; ')}.`,
    });
  }
  const groups = new Map<string, { insts: Inst[]; plain: Plain }>();
  for (const inst of a.insts) {
    const plain = a.solved.get(inst);
    if (!plain) continue;
    const key = `${plain.via}|${plain.m.join(',')}`;
    const group = groups.get(key) ?? { insts: [], plain };
    group.insts.push(inst);
    groups.set(key, group);
  }
  for (const g of groups.values()) out.push(...plaintextBlocks(g.insts, g.plain));
  for (const m of a.mods) {
    const block = keyBlock(a, m);
    if (block) out.push(block);
  }
  out.push(...failureNotes(a));
  if (a.attempts.length > 0) {
    out.push({
      type: 'table',
      label: 'Attacks tried, in order',
      columns: ['Attack', 'Target', 'Result', 'Details'],
      rows: a.attempts.map((t) => [t.attack, t.target, t.status, t.detail]),
      highlight: a.attempts.flatMap((t, i) => (t.status === 'worked' ? [i] : [])),
    });
  }
  for (const w of warnings) out.push({ type: 'note', level: 'warn', text: w });
  return out;
}

// ---------------------------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------------------------

export default defineTool({
  id: 'rsa',
  name: 'RSA toolkit',
  category: 'crypto',
  description:
    'Decrypt RSA from n, e, c: tries factoring, small e, Håstad, Wiener, common modulus, shared primes and more.',
  tags: [
    'RsaCtfTool',
    'factordb',
    'long_to_bytes',
    'Wiener',
    'Hastad',
    'Håstad',
    'common modulus',
    'Fermat',
    'Pollard',
    'dp dq',
    'phi',
    'modulus',
    'public key',
    'private key',
    'rabin',
    'bigint',
  ],
  input: 'text',
  live: false,
  placeholder:
    'n = 0x… or decimal\ne = 65537\nc = …\n# optional: p, q, d, dp, dq, phi\n# several instances: n1 c1, n2 c2 …',
  options: {
    budget: number('Factoring time (s)', 2, {
      min: 0.2,
      max: 30,
      step: 0.5,
      hint: 'Time allowed for trial division, Fermat, Pollard p−1 and rho on n (per run).',
    }),
  },
  examples: [
    {
      label: 'Small e (e = 3)',
      input: SMALL_E,
      expect: 'flag{small_e_no_padding}',
    },
    {
      label: 'Håstad broadcast',
      input: HASTAD,
      expect: 'flag{hastad_broadcast_attack}',
    },
    {
      label: 'Wiener (small d)',
      input: WIENER,
      expect: 'flag{wiener_small_private_exponent}',
    },
    {
      label: 'Common modulus',
      input: COMMON,
      expect: 'flag{common_modulus}',
    },
    {
      label: 'Close primes (Fermat)',
      input: FERMAT,
      expect: 'flag{fermat_close_primes}',
    },
    {
      label: 'Tiny n (factor it)',
      input: TINY,
      expect: 'flag{rho}',
    },
  ],
  detect({ text }) {
    if (!text || text.length > 200_000) return null;
    const hasN = /(?:^|[\s{,(])["']?n\d*["']?\s*[:=]\s*["']?(?:0x[0-9a-f]{12,}|\d{12,})/im.test(
      text,
    );
    const hasOther =
      /(?:^|[\s{,(])["']?(?:e|c|ct|p|q|d|phi)\d*["']?\s*[:=]\s*["']?(?:0x[0-9a-f]+|\d+)/im.test(
        text,
      );
    if (!hasN) return null;
    return hasOther
      ? { score: 0.9, reason: 'RSA parameters (n, e, c…)' }
      : { score: 0.55, reason: 'A modulus n' };
  },
  run(text, { budget }) {
    if (!text.trim())
      throw new ToolError('Paste RSA parameters, one per line: n = …, e = …, c = ….');
    const { insts, warnings } = parseInput(text);
    return render(analyze(insts, Math.round(budget * 1000)), warnings);
  },
});
