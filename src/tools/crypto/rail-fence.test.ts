import { describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors';
import { resultToText } from '../../core/result-text';
import type { ToolResult } from '../../core/types';
import tool, { railFenceDecrypt, railFenceEncrypt } from './rail-fence';
import { PROSE_A } from './_sample-text';

const run = (text: string, options: Partial<Parameters<typeof tool.run>[1]>): ToolResult =>
  tool.run(text, { mode: 'brute', rails: 3, offset: 0, ...options }) as ToolResult;

describe('rail fence', () => {
  it('matches the classic 3-rail vector', () => {
    expect(railFenceEncrypt('WEAREDISCOVEREDFLEEATONCE', 3)).toBe('WECRLTEERDSOEEFEAOCAIVDEN');
    expect(railFenceDecrypt('WECRLTEERDSOEEFEAOCAIVDEN', 3)).toBe('WEAREDISCOVEREDFLEEATONCE');
  });

  it('writes the zigzag the textbook way', () => {
    // H . . . O . . . L      rails read: HOL / ELWRD / LO
    // . E . L . W . R .
    // . . L . . . O . D
    expect(railFenceEncrypt('HELLOWORLD', 3)).toBe('HOLELWRDLO');
  });

  it('round-trips for many rail counts and offsets', () => {
    const msg = 'flag{Round-trip, with spaces & ünïcode ✓}';
    for (let rails = 2; rails <= 12; rails++) {
      for (let offset = 0; offset < 2 * (rails - 1) + 2; offset++) {
        expect(railFenceDecrypt(railFenceEncrypt(msg, rails, offset), rails, offset)).toBe(msg);
      }
    }
  });

  it('leaves the text alone when there are at least as many rails as characters', () => {
    expect(railFenceEncrypt('abc', 3)).toBe('abc');
    expect(railFenceDecrypt('abc', 9)).toBe('abc');
  });

  it('brute-forces the rail count on real English text', () => {
    for (const rails of [2, 4, 7]) {
      const out = resultToText(run(railFenceEncrypt(PROSE_A, rails), {}));
      // Neighbouring offsets only move a few characters at the ends, so check the body.
      expect(out).toContain(`Best guess · ${rails} rails, offset `);
      expect(out).toContain(PROSE_A.slice(20, 400));
    }
  });

  it('brute-forces a non-zero offset', () => {
    const out = resultToText(run(railFenceEncrypt(PROSE_A, 5, 3), {}));
    expect(out).toContain('Best guess · 5 rails, offset ');
    expect(out).toContain(PROSE_A.slice(20, 400));
  });

  it('lists the exact plaintext among the top candidates for a shifted zigzag', () => {
    const msg = 'meet me behind the old mill at midnight';
    const out = resultToText(run(railFenceEncrypt(msg, 4, 2), {}));
    expect(out).toContain('4\t2\t');
    expect(out).toContain(msg);
  });

  it('brute-forces a short flag', () => {
    const cipher = railFenceEncrypt('flag{rail_fence_changes_the_order}', 3);
    const out = resultToText(run(cipher, {}));
    expect(out).toContain('Best guess · 3 rails, offset 0');
    expect(out).toContain('flag{rail_fence_changes_the_order}');
  });

  it('rejects bad parameters and tiny input', () => {
    expect(() => run('abcdef', { mode: 'decrypt', rails: 1 })).toThrow(ToolError);
    expect(() => run('abcdef', { mode: 'encrypt', rails: 2.5 })).toThrow(ToolError);
    expect(() => run('abcdef', { mode: 'decrypt', rails: 3, offset: -1 })).toThrow(ToolError);
    expect(() => run('abc', {})).toThrow(/at least 4/);
  });
});
