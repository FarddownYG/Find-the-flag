import { describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors';
import { resultToText } from '../../core/result-text';
import type { Output } from '../../core/types';
import nato, { looksLikeNato, natoDecode, natoEncode } from './nato';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

// The ICAO / ITU spelling alphabet (ICAO Annex 10, Volume II), letters A to Z.
const ICAO = [
  'Alfa Bravo Charlie Delta Echo Foxtrot Golf Hotel India Juliett Kilo Lima Mike November Oscar',
  'Papa Quebec Romeo Sierra Tango Uniform Victor Whiskey X-ray Yankee Zulu',
].join(' ');

describe('nato: encoding', () => {
  it('spells the whole alphabet with the official ICAO words', () => {
    expect(natoEncode(ALPHABET).text).toBe(ICAO);
  });

  it('common spellings, radio and plain digits', () => {
    expect(natoEncode('AJ', { spelling: 'common' }).text).toBe('Alpha Juliet');
    expect(natoEncode('AJ').text).toBe('Alfa Juliett');
    expect(natoEncode('0123456789').text).toBe(
      'Zero One Two Tree Fower Fife Six Seven Eight Niner',
    );
    expect(natoEncode('0123456789', { digits: 'plain' }).text).toBe(
      'Zero One Two Three Four Five Six Seven Eight Nine',
    );
    expect(natoEncode('3.5').text).toBe('Tree Decimal Fife');
  });

  it('separators, word breaks and case', () => {
    expect(natoEncode('ab cd', { separator: 'comma' }).text).toBe('Alfa, Bravo / Charlie, Delta');
    expect(natoEncode('ab cd', { separator: 'newline' }).text).toBe(
      'Alfa\nBravo\n\nCharlie\nDelta',
    );
    expect(natoEncode('ab\ncd', { wordCase: 'upper' }).text).toBe('ALFA BRAVO / CHARLIE DELTA');
    expect(natoEncode('ab', { wordCase: 'lower' }).text).toBe('alfa bravo');
    // a hyphen in "X-ray" would look like the separator
    expect(natoEncode('xy', { separator: 'dash' }).text).toBe('Xray-Yankee');
    expect(natoEncode('xy').text).toBe('X-ray Yankee');
  });

  it('drops accents and reports what has no word', () => {
    const r = natoEncode('Café {ok}!');
    expect(r.text).toBe('Charlie Alfa Foxtrot Echo / Oscar Kilo');
    expect(r.skipped).toEqual(['{', '}', '!']);
    expect(natoEncode('').text).toBe('');
  });
});

describe('nato: decoding', () => {
  it('reads every spelling, in any case', () => {
    expect(natoDecode(ICAO).text).toBe(ALPHABET);
    expect(natoDecode(ICAO.toUpperCase()).text).toBe(ALPHABET);
    expect(natoDecode(ICAO.toLowerCase()).text).toBe(ALPHABET);
    expect(natoDecode('Alpha Juliet Whisky Xray X-ray X ray').text).toBe('AJWXXX');
  });

  it('reads the digits, radio and plain, and the pronunciation spellings', () => {
    expect(natoDecode('Zero One Two Three Four Five Six Seven Eight Nine').text).toBe('0123456789');
    expect(natoDecode('Zero Wun Too Tree Fower Fife Six Seven Ait Niner').text).toBe('0123456789');
    expect(natoDecode('Ze-ro Fow-er Sev-en Nin-er Thuh-ree').text).toBe('04793');
    expect(natoDecode('Tree Decimal Fife').text).toBe('3.5');
  });

  it('accepts any separator: spaces, commas, dashes, dots, slashes, new lines', () => {
    for (const sep of [' ', ', ', '-', '.', ';', '\n', '  ', ' - ', '_']) {
      expect(natoDecode(['Foxtrot', 'Lima', 'Alfa', 'Golf'].join(sep)).text).toBe('FLAG');
    }
  });

  it('a slash, a bar or a blank line is a space', () => {
    expect(natoDecode('Foxtrot Lima / Alfa Golf').text).toBe('FL AG');
    expect(natoDecode('Foxtrot Lima|Alfa Golf').text).toBe('FL AG');
    expect(natoDecode('Foxtrot Lima\n\nAlfa Golf').text).toBe('FL AG');
    expect(natoDecode('Foxtrot Lima\nAlfa Golf').text).toBe('FLAG');
  });

  it('cuts words that run together, even where "Juliett" and "Juliet" + "Tango" compete', () => {
    expect(natoDecode('FOXTROTLIMAALFAGOLF').text).toBe('FLAG');
    expect(natoDecode('alfabravocharlie').text).toBe('ABC');
    expect(natoDecode('JulietTangoNiner').text).toBe('JT9');
    expect(natoDecode('juliettangoniner').text).toBe('JT9');
    expect(natoDecode('Juliett').text).toBe('J');
  });

  it('keeps plain digits in the text', () => {
    expect(natoDecode('Foxtrot Lima Alfa Golf 2024').text).toBe('FLAG2024');
  });

  it('lower case output', () => {
    expect(natoDecode('Foxtrot Lima', 'error', true).text).toBe('fl');
  });

  it('a word with no meaning: error with position and nearest word, or ?, or left out', () => {
    expect(() => natoDecode('Alfa Brovo Charlie')).toThrow(ToolError);
    expect(() => natoDecode('Alfa Brovo Charlie')).toThrow(
      /"Brovo" at position 6 is not a word of the NATO alphabet \(did you mean "Bravo"\?\)/,
    );
    expect(() => natoDecode('Alfa Banana Charlie')).toThrow(/"Banana" at position 6 is not a word/);
    expect(() => natoDecode('Alfa Banana Charlie')).not.toThrow(/did you mean/);
    // the nearest word is offered when there is one clear candidate
    expect(() => natoDecode('Alfa Trea')).toThrow(/did you mean "Tree"/);
    const marked = natoDecode('Alfa Brovo Charlie', 'mark');
    expect(marked.text).toBe('A?C');
    expect(marked.unknown).toEqual([{ word: 'Brovo', pos: 6 }]);
    expect(natoDecode('Alfa Brovo Charlie', 'skip').text).toBe('AC');
  });

  it('round-trips every option combination', () => {
    const text = 'THE QUICK BROWN FOX 1234567890';
    for (const spelling of ['icao', 'common'] as const) {
      for (const digits of ['radio', 'plain'] as const) {
        for (const separator of ['space', 'dash', 'comma', 'newline'] as const) {
          for (const wordCase of ['title', 'upper', 'lower'] as const) {
            const spelled = natoEncode(text, { spelling, digits, separator, wordCase }).text;
            expect(natoDecode(spelled).text).toBe(text);
          }
        }
      }
    }
  });

  it('reports position of a word after astral characters and line breaks', () => {
    expect(() => natoDecode('Alfa\nBravo\nBrovo')).toThrow(/position 12/);
  });
});

describe('nato: recognising a spelled text', () => {
  it('needs four or more words and no unknown word', () => {
    expect(looksLikeNato('Foxtrot Lima Alfa Golf')).toEqual({ words: 4, letters: 4 });
    expect(looksLikeNato('Foxtrot Lima Alfa')).toBeNull();
    expect(looksLikeNato('Foxtrot Lima Alfa Golf and more')).toBeNull();
    expect(looksLikeNato('')).toBeNull();
  });

  it('does not take ordinary text for it', () => {
    for (const s of [
      'one two three four five six',
      'Hello world, this is plain text.',
      'Mike and Victor went to the Hotel Lima in India with Oscar.',
      'Delta Air Lines',
      '1 2 3 4 5',
    ]) {
      const r = looksLikeNato(s);
      expect(r === null || r.letters < 3).toBe(true);
    }
  });
});

describe('nato tool', () => {
  const run = (text: string, options: Record<string, unknown> = {}) =>
    nato.run(text, {
      mode: 'decode',
      unknown: 'error',
      lower: false,
      spelling: 'icao',
      digits: 'radio',
      separator: 'space',
      wordCase: 'title',
      ...options,
    } as never) as Output[];

  it('decodes and encodes', () => {
    expect(resultToText(run('Foxtrot Lima Alfa Golf'))).toBe('FLAG');
    expect(resultToText(run('Flag 42', { mode: 'encode' }))).toBe(
      'Foxtrot Lima Alfa Golf / Fower Two',
    );
  });

  it('notes characters without a word, and words without a meaning', () => {
    expect(resultToText(run('a-b!', { mode: 'encode' }))).toContain('skipped: - !');
    const out = resultToText(run('Alfa Brovo Charlie', { unknown: 'mark' }));
    expect(out).toContain('A?C');
    expect(out).toContain('Brovo (6)');
  });

  it('rejects empty input and unknown words', () => {
    expect(() => run('   ')).toThrow(ToolError);
    expect(() => run('hello')).toThrow(/not a word/);
  });

  it('detect: only text made of NATO words', () => {
    const sample = (text: string) => ({ text, bytes: new Uint8Array() });
    expect(nato.detect!(sample('Sierra Echo Charlie Romeo Echo Tango'))?.score).toBeGreaterThan(
      0.8,
    );
    expect(nato.detect!(sample('hello world, nothing to see here'))).toBeNull();
    expect(nato.detect!(sample('one two three four five six'))).toBeNull();
  });
});
