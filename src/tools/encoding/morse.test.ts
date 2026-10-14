import { describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors';
import type { Output } from '../../core/types';
import { resultToText } from '../../core/result-text';
import morse, { morseDecode, morseEncode } from './morse';

const dec = (s: string, o = {}) => morseDecode(s, o).text;

describe('morse: encode', () => {
  it('letters, digits and punctuation', () => {
    expect(morseEncode('SOS').text).toBe('... --- ...');
    expect(morseEncode('Hello, World!').text).toBe(
      '.... . .-.. .-.. --- --..-- / .-- --- .-. .-.. -.. -.-.--',
    );
    expect(morseEncode('0123456789').text).toBe(
      '----- .---- ..--- ...-- ....- ..... -.... --... ---.. ----.',
    );
    expect(morseEncode('a.b?c@d').text).toBe('.- .-.-.- -... ..--.. -.-. .--.-. -..');
  });

  it('word separators and symbols', () => {
    expect(morseEncode('a b').text).toBe('.- / -...');
    expect(morseEncode('a   b\nc', { wordSeparator: 'spaces' }).text).toBe('.-  -...  -.-.');
    expect(morseEncode('sos', { dot: '•', dash: '−' }).text).toBe('••• −−− •••');
    expect(morseEncode('at', { dot: '0', dash: '1' }).text).toBe('01 1');
  });

  it('strips accents it has no code for and reports characters it cannot encode', () => {
    expect(morseEncode('Ünï').text).toBe('..-- -. ..'); // Ü has its own code, ï loses its dots
    const r = morseEncode('a{b}~');
    expect(r.text).toBe('.- -...');
    expect(r.skipped).toEqual(['{', '}', '~']);
  });

  it('empty input', () => {
    expect(morseEncode('').text).toBe('');
    expect(morseEncode('  ').text).toBe('');
  });
});

describe('morse: decode', () => {
  it('decodes letters, digits and punctuation', () => {
    expect(dec('... --- ...')).toBe('SOS');
    expect(
      dec(
        '.-.-.- --..-- ..--.. .----. -.-.-- -..-. -.--. -.--.- .-... ---... -.-.-. -...- .-.-. -....- ..--.- .-..-. ...-..- .--.-.',
      ),
    ).toBe('.,?\'!/()&:;=+-_"$@');
  });

  it('words: slash, double space, blank line', () => {
    expect(dec('.... .. / - .... . .-. .')).toBe('HI THERE');
    expect(dec('.... ..  - .... . .-. .')).toBe('HI THERE');
    expect(dec('.... ..   - .... . .-. .')).toBe('HI THERE');
    expect(dec('.... ..\n\n- .... . .-. .')).toBe('HI THERE');
    expect(dec('.... ../- .... . .-. .')).toBe('HI THERE');
    expect(dec('.... .. /  / - .... . .-. .')).toBe('HI THERE');
  });

  it('a single newline or tab separates letters only', () => {
    expect(dec('.... ..\r\n- .... . .-. .')).toBe('HITHERE');
    expect(dec('....\t..')).toBe('HI');
  });

  it('ignores leading and trailing separators', () => {
    expect(dec('  / .... .. /  ')).toBe('HI');
  });

  it('accepts typographic dots and dashes with the default symbols', () => {
    expect(dec('••• −−− •••')).toBe('SOS');
    expect(dec('··· ——— ···')).toBe('SOS');
    expect(dec('... ––– ...')).toBe('SOS');
    expect(dec('... ___ ...')).toBe('SOS');
  });

  it('custom symbols: only those are Morse', () => {
    expect(dec('0010 0100 01 110', { dot: '0', dash: '1' })).toBe('FLAG');
    expect(dec('xxx ooo xxx', { dot: 'x', dash: 'o' })).toBe('SOS');
    expect(dec('--- ... ---', { dot: '-', dash: '.' })).toBe('SOS'); // swapped
    expect(() => dec('0010 .-', { dot: '0', dash: '1' })).toThrow(/plain \. or -/);
  });

  it('unknown codes become ? and are counted', () => {
    const r = morseDecode('.... ........ ..');
    expect(r.text).toBe('H?I');
    expect(r.unknown).toBe(1);
  });

  it('round-trips every supported character', () => {
    const all = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,?\'!/()&:;=+-_"$@ÄÖÜÉÑÀÇ';
    expect(dec(morseEncode(all).text)).toBe(all);
    expect(
      dec(morseEncode(all, { wordSeparator: 'spaces', dot: '·', dash: '—' }).text, {
        dot: '·',
        dash: '—',
      }),
    ).toBe(all);
    expect(dec(morseEncode('two words here').text)).toBe('TWO WORDS HERE');
  });

  it('rejects other characters with a pointer to the symbol options', () => {
    expect(() => dec('.-a')).toThrow(ToolError);
    expect(() => dec('.- x')).toThrow(/position 4/);
    expect(() => dec('.- x')).toThrow(/dot and dash symbols/);
  });

  it('rejects bad symbol options', () => {
    expect(() => dec('.-', { dot: '', dash: '' })).not.toThrow(); // empty = defaults
    expect(() => dec('.-', { dot: '..', dash: '-' })).toThrow(/one visible character/);
    expect(() => dec('.-', { dot: 'a', dash: 'a' })).toThrow(/different/);
    expect(() => dec('.-', { dot: '/', dash: '-' })).toThrow(ToolError);
    expect(() => dec('.-', { dot: ' ', dash: '-' })).toThrow(ToolError);
  });
});

describe('morse tool', () => {
  const run = (text: string, options: Record<string, unknown> = {}) =>
    morse.run(text, {
      mode: 'decode',
      dot: '.',
      dash: '-',
      wordSeparator: 'slash',
      lower: false,
      ...options,
    } as never) as Output[];

  it('decodes, lower-cases on request, and warns about unknown codes', () => {
    expect(run('.... ..')).toEqual([{ type: 'text', value: 'HI' }]);
    expect(run('.... ..', { lower: true })[0]).toEqual({ type: 'text', value: 'hi' });
    expect(resultToText(run('.... ........'))).toContain('1 unknown code');
  });

  it('encodes and warns about skipped characters', () => {
    expect(run('hi', { mode: 'encode' })).toEqual([{ type: 'text', value: '.... ..' }]);
    expect(resultToText(run('hi~', { mode: 'encode' }))).toContain('"~"');
  });

  it('empty decode input is a ToolError', () => {
    expect(() => run('   ')).toThrow(ToolError);
  });

  it('detect: Morse that decodes, not separator lines or dotted text', () => {
    const sample = (text: string) => ({ text, bytes: new Uint8Array() });
    expect(morse.detect!(sample('.... .. / - .... . .-. .'))?.score).toBeGreaterThan(0.8);
    expect(morse.detect!(sample('••• −−− •••'))?.score).toBeGreaterThan(0.8);
    expect(morse.detect!(sample('----------'))).toBeNull();
    expect(morse.detect!(sample('......'))).toBeNull();
    expect(morse.detect!(sample('hello there'))).toBeNull();
  });
});
