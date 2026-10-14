import { describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors';
import { resultToText } from '../../core/result-text';
import type { ToolResult } from '../../core/types';
import tool, { baconDecodeBits, baconEncodeBits, extractSymbols } from './bacon';
import { PROSE_A } from './_sample-text';

const run = (text: string, options: Partial<Parameters<typeof tool.run>[1]> = {}): ToolResult =>
  tool.run(text, {
    mode: 'decode',
    variant: '24',
    symbols: 'AB',
    grouped: true,
    ...options,
  }) as ToolResult;

const text = (blocks: ToolResult) => resultToText(blocks);

describe('bacon', () => {
  it('encodes with the classic table (Wikipedia: HELLO 24-letter)', () => {
    expect(baconEncodeBits('HELLO', '24')).toBe('00111' + '00100' + '01010' + '01010' + '01101');
    expect(text(run('Hello', { mode: 'encode' }))).toContain('AABBB AABAA ABABA ABABA ABBAB');
  });

  it('merges I/J and U/V in the 24-letter alphabet only', () => {
    expect(baconEncodeBits('J', '24')).toBe(baconEncodeBits('I', '24'));
    expect(baconEncodeBits('V', '24')).toBe(baconEncodeBits('U', '24'));
    expect(baconEncodeBits('J', '26')).not.toBe(baconEncodeBits('I', '26'));
    expect(baconEncodeBits('Z', '26')).toBe('11001');
    expect(baconEncodeBits('Z', '24')).toBe('10111');
  });

  it('round-trips letters in both alphabets, with custom symbols', () => {
    const msg = 'SOMETHINGHIDDENINPLAINSIGHT';
    for (const variant of ['24', '26'] as const) {
      const enc = text(run(msg, { mode: 'encode', variant, symbols: '01', grouped: false }));
      expect(enc).toMatch(/^[01]+$/);
      expect(baconDecodeBits(enc, variant)).toBe(msg);
      const dec = text(run(enc, { variant }));
      expect(dec).toContain(`Best guess · ${variant}-letter`);
      expect(dec).toContain(msg);
    }
  });

  it('decodes whichever assignment of the two symbols reads as English', () => {
    const msg = 'THEFLAGISHIDDENHERE';
    const enc = baconEncodeBits(msg, '24');
    const ab = enc.replace(/0/g, 'a').replace(/1/g, 'b');
    const swapped = enc.replace(/0/g, 'b').replace(/1/g, 'a');
    expect(text(run(ab))).toContain(`Best guess · 24-letter, A=a B=b\n${msg}`);
    expect(text(run(swapped))).toContain(`Best guess · 24-letter, A=b B=a\n${msg}`);
    // any two symbols, with groups and noise
    const odd = enc
      .replace(/0/g, '#')
      .replace(/1/g, '*')
      .replace(/(.{5})/g, '$1 / ');
    expect(text(run(odd))).toContain(msg);
  });

  it('builds the flag form for flag-looking output', () => {
    const enc = baconEncodeBits('FLAGBACONISFUN', '24');
    const out = text(run(enc.replace(/0/g, 'A').replace(/1/g, 'B')));
    expect(out).toContain('flag{baconisfun}');
  });

  it('points to the other alphabet when it reads far better', () => {
    const enc = baconEncodeBits('JUSTAVERYLONGJOKEWITHVOWELS', '26')
      .replace(/0/g, 'A')
      .replace(/1/g, 'B');
    const out = text(run(enc, { variant: '24' }));
    expect(out).toContain('26-letter variant reads much better');
    expect(out).toContain('JUSTAVERYLONGJOKEWITHVOWELS');
  });

  it('reads upper/lower case in Letter case mode (either way round)', () => {
    const cover = PROSE_A.slice(0, 120);
    const bits = baconEncodeBits('HIDDEN', '24');
    let i = 0;
    let hidden = '';
    for (const ch of cover) {
      if (/[a-z]/i.test(ch) && i < bits.length)
        hidden += bits[i++] === '1' ? ch.toUpperCase() : ch.toLowerCase();
      else if (/[a-z]/i.test(ch)) hidden += ch.toLowerCase();
      else hidden += ch;
    }
    const out = text(run(hidden, { mode: 'case' }));
    expect(out).toContain('Best guess · 24-letter, A=lowercase B=UPPERCASE\nHIDDEN');
    // inverted convention: upper = A
    const inverted = [...hidden]
      .map((c) =>
        /[a-z]/i.test(c) ? (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()) : c,
      )
      .join('');
    expect(text(run(inverted, { mode: 'case' }))).toContain('HIDDEN');
  });

  it('decodes a hidden flag from letter case', () => {
    const out = text(
      run('meEt Me At The old pieR After mIdnight anD brINg It HEre', { mode: 'case' }),
    );
    expect(out).toContain('FLAGBACON');
    expect(out).toContain('flag{bacon}');
  });

  it('warns about trailing symbols and rejects garbage', () => {
    expect(text(run('AABBB AABAA ABAB'))).toContain('trailing symbol');
    expect(() => run('AAB')).toThrow(ToolError);
    expect(() => run('ABC DEF GHI')).toThrow(/different symbols/);
    expect(() => run('   ')).toThrow(ToolError);
    expect(() => run('hello', { mode: 'encode', symbols: 'A' })).toThrow(/two different/);
    expect(() => run('12345', { mode: 'encode' })).toThrow(/no letters/);
    expect(() => run('abcd', { mode: 'case' })).toThrow(/at least 5 letters/);
  });

  it('finds the symbols of a noisy text', () => {
    expect(extractSymbols('AB, BA; AA!').symbols).toEqual(['A', 'B']);
    expect(extractSymbols('aabb AABB').symbols).toEqual(['a', 'b']);
  });
});
