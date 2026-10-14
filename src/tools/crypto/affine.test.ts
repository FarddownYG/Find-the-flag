import { describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors';
import { resultToText } from '../../core/result-text';
import type { ToolResult } from '../../core/types';
import tool, { affineDecrypt, affineEncrypt, VALID_A } from './affine';
import { PROSE_A, PROSE_B } from './_sample-text';

const run = (text: string, options: Partial<Parameters<typeof tool.run>[1]>): ToolResult =>
  tool.run(text, { mode: 'brute', a: 5, b: 8, ...options }) as ToolResult;

describe('affine', () => {
  it('matches the published vector (a=5, b=8)', () => {
    expect(affineEncrypt('AFFINE CIPHER', 5, 8)).toBe('IHHWVC SWFRCP');
    expect(affineDecrypt('IHHWVC SWFRCP', 5, 8)).toBe('AFFINE CIPHER');
  });

  it('round-trips with every valid key and keeps case and punctuation', () => {
    const msg = 'Flag{Mixed-Case, 42!} zebra';
    for (const a of VALID_A) {
      for (const b of [0, 1, 13, 25]) {
        expect(affineDecrypt(affineEncrypt(msg, a, b), a, b)).toBe(msg);
      }
    }
  });

  it('a=1 is Caesar and a=25 is Atbash shifted', () => {
    expect(affineEncrypt('abc', 1, 3)).toBe('def');
    expect(affineEncrypt('abc', 25, 25)).toBe('zyx');
  });

  it('normalises negative and large b', () => {
    expect(affineEncrypt('abc', 3, -1)).toBe(affineEncrypt('abc', 3, 25));
    expect(affineEncrypt('abc', 3, 27)).toBe(affineEncrypt('abc', 3, 1));
  });

  it('rejects a that is not coprime with 26', () => {
    for (const a of [2, 4, 13, 26, 0, 1.5]) {
      expect(() => affineEncrypt('abc', a, 0)).toThrow(ToolError);
    }
    expect(() => run('abc', { mode: 'decrypt', a: 4 })).toThrow(/coprime with 26/);
  });

  it('brute force finds the key on real English text', () => {
    for (const [a, b] of [
      [5, 8],
      [11, 19],
      [25, 3],
    ] as const) {
      const cipher = affineEncrypt(PROSE_B, a, b);
      const out = resultToText(run(cipher, { mode: 'brute' }));
      expect(out).toContain(`Best guess · a=${a}, b=${b}`);
      expect(out).toContain(PROSE_B.slice(0, 40));
    }
  });

  it('brute force finds a short flag', () => {
    const cipher = affineEncrypt('flag{affine_is_a_linear_map}', 17, 6);
    const out = resultToText(run(cipher, { mode: 'brute' }));
    expect(out).toContain('Best guess · a=17, b=6');
    expect(out).toContain('flag{affine_is_a_linear_map}');
  });

  it('ranks all 312 keys', () => {
    const blocks = run(affineEncrypt(PROSE_A, 3, 4), { mode: 'brute' });
    const table = blocks.find((b) => b.type === 'table');
    expect(table?.type === 'table' && table.rows.length).toBe(312);
    expect(table?.type === 'table' && table.rows[0]!.slice(0, 2)).toEqual([3, 4]);
  });

  it('refuses text without letters in brute-force mode', () => {
    expect(() => run('1234 !!', { mode: 'brute' })).toThrow(ToolError);
  });
});
