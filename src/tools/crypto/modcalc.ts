import { defineTool, select, text } from '../../core/define';
import { ToolError } from '../../core/errors';
import type { Output } from '../../core/types';
import { toolT } from '../../i18n/tool-text';
import {
  bitLength,
  crt,
  egcd,
  gcd,
  isProbablePrime,
  longToBytes,
  mod,
  modInv,
  modPow,
  parseBigInt,
  sievePrimes,
  toHexString,
} from './_bigint';

const T = toolT('modcalc');

const FACTOR_LIMIT = 10_000_000;
const MAX_BYTES_BITS = 8192;
const MAX_POW_BITS = 1_000_000;

/** parseBigInt plus 0b / 0o prefixes (and a sign in front of them). */
function parseInteger(raw: string): bigint | null {
  const s = raw.trim().replace(/_/g, '');
  const m = /^([+-]?)0([bBoO])([0-9]+)$/.exec(s);
  if (m) {
    const radix = m[2]!.toLowerCase() === 'b' ? /^[01]+$/ : /^[0-7]+$/;
    if (!radix.test(m[3]!)) return null;
    const v = BigInt(`0${m[2]!.toLowerCase()}${m[3]!}`);
    return m[1] === '-' ? -v : v;
  }
  return parseBigInt(s);
}

function operand(raw: string, name: 'A' | 'B' | 'M'): bigint {
  if (raw.trim() === '') throw new ToolError(T('error.empty', { name }));
  const v = parseInteger(raw);
  if (v === null) throw new ToolError(T('error.parse', { name, value: raw.trim().slice(0, 40) }));
  return v;
}

function list(raw: string, name: 'A' | 'M'): bigint[] {
  const tokens = raw.split(/[\s,;]+/).filter(Boolean);
  if (tokens.length === 0) throw new ToolError(T('error.empty', { name }));
  return tokens.map((t) => operand(t, name));
}

function integerOutputs(n: bigint, label?: string): Output[] {
  const out: Output[] = [
    {
      type: 'kv',
      ...(label ? { label } : {}),
      entries: [
        [T('kv.dec'), n.toString()],
        [T('kv.hex'), toHexString(n)],
        [T('kv.bits'), String(bitLength(n < 0n ? -n : n))],
      ],
    },
  ];
  if (n >= 0n && bitLength(n) <= MAX_BYTES_BITS) {
    out.push({ type: 'bytes', label: T('label.bytes'), value: longToBytes(n) });
  }
  return out;
}

function factorOutputs(n: bigint): Output[] {
  if (n < 2n) throw new ToolError(T('error.factorRange'));
  const found: [bigint, number][] = [];
  let rest = n;
  for (const p of sievePrimes(FACTOR_LIMIT)) {
    const bp = BigInt(p);
    if (bp * bp > rest) break;
    if (rest % bp !== 0n) continue;
    let e = 0;
    while (rest % bp === 0n) {
      rest /= bp;
      e++;
    }
    found.push([bp, e]);
  }
  const limitSq = BigInt(FACTOR_LIMIT) * BigInt(FACTOR_LIMIT);
  const out: Output[] = [];
  let complete = false;
  if (rest === 1n) complete = true;
  else if (rest < limitSq || isProbablePrime(rest)) {
    // Every prime up to sqrt(rest) was tried, or the cofactor is a probable prime.
    found.push([rest, 1]);
    complete = true;
  }
  if (found.length > 0) {
    out.push({
      type: 'table',
      columns: [T('col.prime'), T('col.exponent')],
      rows: found.map(([p, e]) => [p.toString(), e]),
    });
    out.push({
      type: 'text',
      label: T('label.product'),
      value: found.map(([p, e]) => (e > 1 ? `${p}^${e}` : `${p}`)).join(' × '),
    });
  }
  if (complete) {
    out.push({ type: 'note', level: 'success', text: T('note.factorDone') });
  } else if (found.length === 0) {
    out.push({
      type: 'note',
      level: 'warn',
      text: T('note.noSmallFactor', { limit: '1e7' }),
    });
  } else {
    out.push({
      type: 'note',
      level: 'warn',
      text: T('note.compositeRest', { rest: rest.toString(), limit: '1e7' }),
    });
  }
  return out;
}

export default defineTool({
  id: 'modcalc',
  name: 'Modular / big-integer calculator',
  category: 'crypto',
  description:
    'Big-integer arithmetic: modular inverse, modular exponentiation, gcd, extended Euclid, CRT, primality and small factors.',
  tags: [
    'modular inverse',
    'modinv',
    'modpow',
    'modular exponentiation',
    'gcd',
    'egcd',
    'extended euclidean',
    'bezout',
    'crt',
    'chinese remainder',
    'big integer',
    'bignum',
    'arbitrary precision',
    'isprime',
    'factor',
    'number theory',
    'calculator',
  ],
  input: 'text',
  placeholder: '17',
  options: {
    op: select(
      'Operation',
      [
        { value: 'add', label: 'A + B' },
        { value: 'sub', label: 'A − B' },
        { value: 'mul', label: 'A × B' },
        { value: 'divmod', label: 'A ÷ B (quotient, remainder)' },
        { value: 'mod', label: 'A mod M' },
        { value: 'pow', label: 'A ^ B' },
        { value: 'modpow', label: 'A ^ B mod M' },
        { value: 'modinv', label: 'A⁻¹ mod M' },
        { value: 'gcd', label: 'gcd(A, B)' },
        { value: 'egcd', label: 'egcd(A, B)' },
        { value: 'crt', label: 'CRT' },
        { value: 'isprime', label: 'is A prime?' },
        { value: 'factor', label: 'factor A' },
      ],
      'modinv',
      {
        hint: 'A is the main input. Numbers: decimal, 0x hex, 0b binary, 0o octal. For CRT, A is the list of residues and M the list of moduli.',
      },
    ),
    b: text('B', '', {
      showIf: (v) =>
        ['add', 'sub', 'mul', 'divmod', 'pow', 'modpow', 'gcd', 'egcd'].includes(String(v.op)),
    }),
    m: text('Modulus M', '', {
      showIf: (v) => ['mod', 'modpow', 'modinv', 'crt'].includes(String(v.op)),
    }),
  },
  examples: [
    {
      label: 'Modular inverse (RSA d)',
      input: '17',
      options: { op: 'modinv', m: '3120' },
      expect: '2753',
    },
    {
      label: 'Modular exponentiation',
      input: '2',
      options: { op: 'modpow', b: '10', m: '1000' },
      expect: '24',
    },
    { label: 'gcd', input: '1071', options: { op: 'gcd', b: '462' }, expect: '21' },
    { label: 'Extended Euclid', input: '240', options: { op: 'egcd', b: '46' }, expect: '2' },
  ],
  detect() {
    return null;
  },
  run(input, { op, b, m }) {
    if (op === 'crt') {
      const residues = list(input, 'A');
      const moduli = list(m, 'M');
      if (residues.length !== moduli.length)
        throw new ToolError(
          T('error.crtLength', { residues: residues.length, moduli: moduli.length }),
        );
      if (moduli.some((q) => q < 1n)) throw new ToolError(T('error.crtModulus'));
      const sol = crt(
        residues.map((r, i) => mod(r, moduli[i]!)),
        moduli,
      );
      if (!sol) throw new ToolError(T('error.crtCoprime'));
      return [
        {
          type: 'kv',
          entries: [
            [T('kv.x'), sol.x.toString()],
            [T('kv.modulus'), sol.modulus.toString()],
            [T('kv.hex'), toHexString(sol.x)],
          ],
        },
        ...(sol.x >= 0n && bitLength(sol.x) <= MAX_BYTES_BITS
          ? ([{ type: 'bytes', label: T('label.bytes'), value: longToBytes(sol.x) }] as Output[])
          : []),
      ];
    }

    const a = operand(input, 'A');

    switch (op) {
      case 'add':
        return integerOutputs(a + operand(b, 'B'));
      case 'sub':
        return integerOutputs(a - operand(b, 'B'));
      case 'mul':
        return integerOutputs(a * operand(b, 'B'));
      case 'divmod': {
        const d = operand(b, 'B');
        if (d === 0n) throw new ToolError(T('error.divZero'));
        // Truncated quotient with a remainder in [0, |B|): the Euclidean division.
        const r = mod(a, d < 0n ? -d : d);
        const q = (a - r) / d;
        return [
          {
            type: 'kv',
            entries: [
              [T('kv.quotient'), q.toString()],
              [T('kv.remainder'), r.toString()],
              [T('kv.check'), `${d} × ${q} + ${r} = ${d * q + r}`],
            ],
          },
        ];
      }
      case 'mod': {
        const q = operand(m, 'M');
        if (q === 0n) throw new ToolError(T('error.divZero'));
        return integerOutputs(mod(a, q < 0n ? -q : q));
      }
      case 'pow': {
        const e = operand(b, 'B');
        if (e < 0n) throw new ToolError(T('error.negExp'));
        if (
          a !== 0n &&
          a !== 1n &&
          a !== -1n &&
          BigInt(bitLength(a < 0n ? -a : a)) * e > MAX_POW_BITS
        )
          throw new ToolError(T('error.tooBig'));
        return integerOutputs(a ** e);
      }
      case 'modpow': {
        const e = operand(b, 'B');
        const q = operand(m, 'M');
        if (q < 1n) throw new ToolError(T('error.modPositive'));
        if (e < 0n && modInv(a, q) === null)
          throw new ToolError(
            T('error.notInvertible', { a: a.toString(), m: q.toString(), g: gcd(a, q).toString() }),
          );
        return integerOutputs(modPow(a, e, q));
      }
      case 'modinv': {
        const q = operand(m, 'M');
        if (q < 1n) throw new ToolError(T('error.modPositive'));
        const inv = modInv(a, q);
        if (inv === null) {
          throw new ToolError(
            T('error.notInvertible', { a: a.toString(), m: q.toString(), g: gcd(a, q).toString() }),
          );
        }
        return integerOutputs(inv);
      }
      case 'gcd':
        return integerOutputs(gcd(a, operand(b, 'B')));
      case 'egcd': {
        const d = operand(b, 'B');
        const { g, x, y } = egcd(a, d);
        return [
          {
            type: 'kv',
            entries: [
              [T('kv.g'), g.toString()],
              [T('kv.xCoef'), x.toString()],
              [T('kv.yCoef'), y.toString()],
              [T('kv.bezout'), `${a} × ${x} + ${d} × ${y} = ${a * x + d * y}`],
            ],
          },
        ];
      }
      case 'isprime': {
        const prime = isProbablePrime(a);
        return [
          {
            type: 'note',
            level: prime ? 'success' : 'info',
            text: prime
              ? T('note.probablePrime', { bits: bitLength(a < 0n ? -a : a) })
              : T('note.composite'),
          },
        ];
      }
      case 'factor':
        return factorOutputs(a);
    }
  },
});
