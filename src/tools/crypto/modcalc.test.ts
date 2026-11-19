import { describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors';
import { resultToText } from '../../core/result-text';
import type { ToolResult } from '../../core/types';
import tool from './modcalc';

type Options = Parameters<typeof tool.run>[1];

const run = (text: string, o: Partial<Options> = {}): ToolResult =>
  tool.run(text, { op: 'modinv', b: '', m: '', ...o }) as ToolResult;
const out = (text: string, o: Partial<Options> = {}): string => resultToText(run(text, o));

describe('modcalc', () => {
  it('runs the examples', () => {
    for (const ex of tool.examples) {
      const o = { op: 'modinv' as const, b: '', m: '', ...ex.options };
      expect(resultToText(tool.run(ex.input as string, o) as ToolResult)).toContain(ex.expect);
    }
  });

  it('adds, subtracts, multiplies', () => {
    expect(out('0xff', { op: 'add', b: '1' })).toContain('256');
    expect(out('5', { op: 'sub', b: '8' })).toContain('-3');
    expect(out('0b101', { op: 'mul', b: '0o10' })).toContain('40');
  });

  it('divides with a non-negative remainder', () => {
    const t = out('-7', { op: 'divmod', b: '2' });
    expect(t).toContain('-4');
    expect(t).toContain('1');
    expect(out('100', { op: 'divmod', b: '7' })).toMatch(/14/);
  });

  it('reduces and exponentiates', () => {
    expect(out('-1', { op: 'mod', m: '7' })).toContain('6');
    expect(out('2', { op: 'pow', b: '100' })).toContain('1267650600228229401496703205376');
  });

  it('matches node BigInt on a 256-bit modpow', () => {
    const a = (1n << 255n) + 12345n;
    const e = (1n << 200n) + 987654321n;
    const m = (1n << 256n) - 189n;
    let r = 1n;
    let b = a % m;
    for (let k = e; k > 0n; k >>= 1n) {
      if (k & 1n) r = (r * b) % m;
      b = (b * b) % m;
    }
    expect(out(a.toString(), { op: 'modpow', b: e.toString(), m: m.toString() })).toContain(
      r.toString(),
    );
  });

  it('shows the long_to_bytes view', () => {
    const r = run('0x666c6167', { op: 'add', b: '0' });
    const bytes = r.find((x) => x.type === 'bytes');
    expect(bytes?.type === 'bytes' && new TextDecoder().decode(bytes.value)).toBe('flag');
  });

  it('inverts and checks', () => {
    expect(out('17', { op: 'modinv', m: '3120' })).toContain('2753');
    expect(out('3', { op: 'modinv', m: '7' })).toContain('5');
  });

  it('gcd and egcd satisfy Bezout', () => {
    expect(out('1071', { op: 'gcd', b: '462' })).toContain('21');
    const t = out('240', { op: 'egcd', b: '46' });
    expect(t).toContain('240 × -9 + 46 × 47 = 2');
  });

  it('solves CRT', () => {
    const t = out('2, 3, 2', { op: 'crt', m: '3 5 7' });
    expect(t).toContain('23');
    expect(t).toContain('105');
  });

  it('tests primality', () => {
    expect(out('1000000007', { op: 'isprime' })).toMatch(/probablePrime|Miller/);
    expect(out('1000000007', { op: 'isprime' })).toMatch(/probablePrime|Probable prime/);
    expect(out('1000000011', { op: 'isprime' })).toMatch(/note\.composite|Composite/);
  });

  it('factors small numbers and admits defeat on large ones', () => {
    const t = out('360', { op: 'factor' });
    expect(t).toContain('2^3');
    expect(t).toContain('3^2');
    const big = ((1n << 127n) - 1n) * ((1n << 89n) - 1n);
    expect(out(big.toString(), { op: 'factor' })).toMatch(
      /noSmallFactor|No small factor found below 1e7/,
    );
  });

  it('rejects bad input with a ToolError', () => {
    const bad = (text: string, o: Partial<Options>) => () => run(text, o);
    expect(bad('4', { op: 'modinv', m: '8' })).toThrow(ToolError);
    expect(bad('4', { op: 'modinv', m: '8' })).toThrow(/notInvertible|gcd\(4, 8\) = 4/);
    expect(bad('4', { op: 'divmod', b: '0' })).toThrow(/divZero|zero/);
    expect(bad('4', { op: 'mod', m: '0' })).toThrow(ToolError);
    expect(bad('xyz!', { op: 'add', b: '1' })).toThrow(ToolError);
    expect(bad('1', { op: 'add', b: 'zz!' })).toThrow(ToolError);
    expect(bad('', { op: 'add', b: '1' })).toThrow(ToolError);
    expect(bad('1', { op: 'add', b: '' })).toThrow(ToolError);
    expect(bad('1 2', { op: 'crt', m: '3' })).toThrow(/crtLength|as many/);
    expect(bad('1 2', { op: 'crt', m: '4 6' })).toThrow(/crtCoprime|coprime/);
    expect(bad('2', { op: 'pow', b: '-1' })).toThrow(ToolError);
    expect(bad('1', { op: 'factor' })).toThrow(ToolError);
  });
});
