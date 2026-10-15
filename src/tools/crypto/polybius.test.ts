import { describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors';
import { resultToText } from '../../core/result-text';
import type { ToolResult } from '../../core/types';
import tool, { buildSquare, polybiusDecode, polybiusEncode, readCoordinates } from './polybius';

const run = (text: string, options: Partial<Parameters<typeof tool.run>[1]> = {}): ToolResult =>
  tool.run(text, {
    cipher: 'polybius',
    mode: 'decode',
    keyword: '',
    tapStyle: 'dots',
    spaced: true,
    ...options,
  }) as ToolResult;

describe('polybius', () => {
  it('encodes HELLO as 23 15 31 31 34 (the textbook square)', () => {
    expect(polybiusEncode('HELLO', 'polybius', '', 'dots', true).text).toBe('23 15 31 31 34');
    expect(polybiusDecode('23 15 31 31 34', 'polybius', '')).toBe('HELLO');
  });

  it('builds the standard and a keyword-mixed square', () => {
    expect(buildSquare('polybius', '')).toBe('ABCDEFGHIKLMNOPQRSTUVWXYZ');
    expect(buildSquare('polybius', 'Zebra Jungle')).toBe('ZEBRAIUNGLCDFHKMOPQSTVWXY');
    expect(buildSquare('tap', 'ignored')).toBe('ABCDEFGHIJLMNOPQRSTUVWXYZ');
  });

  it('decodes with spaces, without spaces and with separators', () => {
    for (const s of ['23 15 31 31 34', '2315313134', '23,15,31,31,34', '23-15-31-31-34']) {
      expect(polybiusDecode(s, 'polybius', '')).toBe('HELLO');
    }
  });

  it('merges J into I', () => {
    expect(polybiusEncode('JI', 'polybius', '', 'dots', true).text).toBe('24 24');
  });

  it('round-trips a sentence with a keyword and keeps word breaks', () => {
    const enc = polybiusEncode('Meet me at noon', 'polybius', 'KEYWORD', 'dots', true).text;
    expect(enc).toContain(' / ');
    expect(polybiusDecode(enc, 'polybius', 'KEYWORD')).toBe('MEET ME AT NOON');
  });

  it('supports 0-based digits, A-E and ADFGX coordinates', () => {
    expect(polybiusDecode('12 04 20 20 23', 'polybius', '')).toBe('HELLO');
    expect(polybiusDecode('BC AE CA CA CD', 'polybius', '')).toBe('HELLO');
    expect(polybiusDecode('DF AX FA FA FG', 'adfgx', '')).toBe('HELLO');
    expect(polybiusEncode('HELLO', 'adfgx', '', 'dots', true).text).toBe('DF AX FA FA FG');
  });

  it('keeps the first reading when only A and D appear', () => {
    expect(readCoordinates('AD DA', 'adfgx').kind).toBe('adfgx');
    expect(readCoordinates('AD DA', 'polybius').kind).toBe('abcde');
  });
});

describe('tap code', () => {
  const HELLO_DOTS = '.. ...  . .....  ... .  ... .  ... ....';

  it('encodes and decodes HELLO in dots', () => {
    expect(polybiusEncode('HELLO', 'tap', '', 'dots', true).text).toBe(HELLO_DOTS);
    expect(polybiusDecode(HELLO_DOTS, 'tap', '')).toBe('HELLO');
  });

  it('treats K as C and uses the square without K', () => {
    expect(polybiusEncode('KICK', 'tap', '', 'digits', true).text).toBe('13 24 13 13');
    expect(polybiusDecode('13 24 13 13', 'tap', '')).toBe('CICC');
  });

  it('accepts digit pairs, separators and different dot characters', () => {
    expect(polybiusDecode('23 15 31 31 34', 'tap', '')).toBe('HELLO');
    expect(polybiusDecode('•• •••  • •••••  ••• •  ••• •  ••• ••••', 'tap', '')).toBe('HELLO');
    expect(polybiusDecode('.. ... / . ..... / ... . / ... . / ... ....', 'tap', '')).toBe(
      'H E L L O',
    );
    expect(polybiusDecode('.. ...  . .....  /  ... .  ... .  ... ....', 'tap', '')).toBe('HE LLO');
  });

  it('round-trips real text with word breaks in both notations', () => {
    const msg = 'the quick brown fox jumps over the lazy dog';
    for (const style of ['dots', 'digits'] as const) {
      const enc = polybiusEncode(msg, 'tap', '', style, true).text;
      // K becomes C: compare against the folded message
      expect(polybiusDecode(enc, 'tap', '')).toBe(msg.toUpperCase().replace(/K/g, 'C'));
    }
  });

  it('decodes through the tool with the flag form', () => {
    const out = resultToText(
      run('.. .  ... .  . .  .. ..  .... ....  . .  ... .....  . ...  ... ....  . ....  . .....', {
        cipher: 'tap',
      }),
    );
    expect(out).toContain('FLAGTAPCODE');
    expect(out).toContain('flag{tapcode}');
  });
});

describe('polybius errors', () => {
  it('rejects odd, out-of-range and mixed input', () => {
    expect(() => polybiusDecode('231', 'polybius', '')).toThrow(/pairs/);
    expect(() => polybiusDecode('23 16', 'polybius', '')).toThrow(/outside 1-5/);
    // Numbers up to 110 may be Nihilist sums: the message names that tool.
    expect(() => polybiusDecode('37 106', 'polybius', '')).toThrow(/Nihilist cipher tool/);
    expect(() => polybiusDecode('2A 31', 'polybius', '')).toThrow(ToolError);
    expect(() => polybiusDecode('AZ BQ', 'polybius', '')).toThrow(/A-E/);
    expect(() => polybiusDecode('.. ... .', 'tap', '')).toThrow(/pairs/);
    expect(() => polybiusDecode('...... .', 'tap', '')).toThrow(/too long/);
    expect(() => polybiusDecode('   ', 'polybius', '')).toThrow(ToolError);
    expect(() => polybiusDecode('23 1?', 'polybius', '')).toThrow(/Unexpected character/);
    expect(() => run('1234 !!', { mode: 'encode' })).toThrow(/no letters|Nothing/);
  });

  it('skips digits and punctuation when encoding, with a note', () => {
    const out = resultToText(run('Hi, 2 you!', { mode: 'encode' }));
    expect(out).toContain('23 24 / 54 34 45');
    expect(out).toContain('skipped');
  });

  it('detects digit pairs and dot groups but not plain numbers', () => {
    const detect = (text: string) => tool.detect?.({ text, bytes: new Uint8Array() });
    expect(detect('23 15 31 31 34')?.score).toBeGreaterThan(0.5);
    expect(detect('.. ...  . .....  ... .  ... .')?.options).toEqual({
      cipher: 'tap',
      mode: 'decode',
    });
    expect(detect('2315313134')).toBeNull();
    expect(detect('hello world')).toBeNull();
    expect(detect('99 15 31 31 34')).toBeNull();
  });

  it('shows the square', () => {
    const out = resultToText(run('23 15', { keyword: 'SECRET' }));
    expect(out).toContain('Square');
    expect(out).toContain('1\tS\tE\tC\tR\tT');
  });
});

describe('ADFGX hint', () => {
  it('points to the ADFGX / ADFGVX tool for ADFGX coordinates, in both directions', () => {
    const hint = 'The ADFGX / ADFGVX tool does both steps with your square and key.';
    expect(resultToText(run('DF AX FA FA FG', { cipher: 'adfgx' }))).toContain(hint);
    expect(resultToText(run('Hello', { cipher: 'adfgx', mode: 'encode' }))).toContain(hint);
    expect(resultToText(run('23 15 31 31 34'))).not.toContain('ADFGX / ADFGVX tool');
  });
});
