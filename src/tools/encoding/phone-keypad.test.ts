import { describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors';
import { resultToText } from '../../core/result-text';
import type { Output } from '../../core/types';
import {
  ENUM_CAP,
  decodeMultitap,
  decodeT9,
  encodeText,
  lettersToDigits,
  type Separator,
} from './_keypad';
import phoneKeypad from './phone-keypad';

const decode = (s: string, sep: Separator = 'auto') => decodeMultitap(s, sep);
const upper = (s: string, sep: Separator = 'auto') => decode(s, sep).text.toUpperCase();

/** The tool as the UI calls it: defaults, then the options under test. */
const run = (text: string, options: Record<string, unknown> = {}) =>
  phoneKeypad.run(text, {
    mode: 'multitap',
    separator: 'auto',
    casing: 'upper',
    ...options,
  } as never) as Output[];

const textOf = (out: Output[]) => resultToText(out);
const firstText = (out: Output[]) => {
  const block = out.find((o) => o.type === 'text');
  return block?.type === 'text' ? block.value : '';
};
const noteTexts = (out: Output[]) =>
  out.flatMap((o) => (o.type === 'note' ? [`${o.level}: ${o.text}`] : []));

describe('phone-keypad: multi-tap with separators', () => {
  it('decodes HELLO with every separator', () => {
    expect(upper('44-33-555-555-666')).toBe('HELLO');
    expect(upper('44 33 555 555 666')).toBe('HELLO');
    expect(upper('44,33,555,555,666')).toBe('HELLO');
    expect(upper('44, 33, 555, 555, 666')).toBe('HELLO');
    expect(upper('44|33|555|555|666')).toBe('HELLO');
    expect(upper('44 | 33 | 555 | 555 | 666')).toBe('HELLO');
    expect(upper('44/33/555/555/666')).toBe('HELLO');
    expect(upper('44 – 33 – 555 – 555 – 666')).toBe('HELLO'); // typographic dashes
  });

  it('each separator can also be chosen', () => {
    expect(upper('44-33-555-555-666', 'dash')).toBe('HELLO');
    expect(upper('44 - 33 - 555 - 555 - 666', 'dash')).toBe('HELLO');
    expect(upper('44 33 555 555 666', 'space')).toBe('HELLO');
    expect(upper('44  33\n555\t555 666', 'space')).toBe('HELLO');
    expect(upper('44,33,555,555,666', 'comma')).toBe('HELLO');
    expect(upper('44 , 33 , 555 , 555 , 666', 'comma')).toBe('HELLO');
    expect(upper('44|33|555|555|666', 'pipe')).toBe('HELLO');
  });

  it('auto-detects the separator and reports it', () => {
    expect(decode('44-33-555-555-666').separators).toEqual(['dash']);
    expect(decode('44 33 555 555 666').separators).toEqual(['space']);
    expect(decode('44,33,555,555,666').separators).toEqual(['comma']);
    expect(decode('44|33|555|555|666').separators).toEqual(['pipe']);
    expect(decode('44/33/555/555/666').separators).toEqual(['slash']);
    expect(decode('44-33 555-555 666').separators).toEqual(['dash', 'space']);
    expect(noteTexts(run('44-33-555-555-666'))).toContain(
      'info: Letters were separated by: dash (-).',
    );
  });

  it('a separator is what splits LL from the ambiguous 55555', () => {
    expect(upper('555-555')).toBe('LL');
    expect(upper('555 555')).toBe('LL');
    const ambiguous = decode('55555');
    expect(ambiguous.readings).not.toBeNull();
    expect(ambiguous.total).toBe(13);
    expect(ambiguous.readings!.map((r) => r.text)).toEqual(expect.arrayContaining(['lk', 'kl']));
  });

  it('0 is a space, a run of zeros is one space, and outer spaces are dropped', () => {
    expect(upper('44 33 555 555 666 0 9 666 777 555 3')).toBe('HELLO WORLD');
    expect(upper('44-33-555-555-666-0-9-666-777-555-3')).toBe('HELLO WORLD');
    expect(upper('44 33 555 555 666 00 000 9 666 777 555 3')).toBe('HELLO WORLD');
    expect(upper('0 44 33 0')).toBe('HE');
  });

  it('decodes a longer word and every key', () => {
    expect(upper('222-33-555-555-7-44-666-66-33')).toBe('CELLPHONE');
    expect(upper('2 22 222 3 33 333 4 44 444 5 55 555 6 66 666')).toBe('ABCDEFGHIJKLMNO');
    expect(upper('7 77 777 7777 8 88 888 9 99 999 9999')).toBe('PQRSTUVWXYZ');
  });

  it('wraps around when a key is pressed more often than it has letters', () => {
    expect(upper('2222', 'dash')).toBe('A');
    expect(upper('2222-22222-222222')).toBe('ABC');
    expect(upper('7777-77777-777777-7777777-77777777')).toBe('SPQRS');
    expect(upper('9999-99999-999999')).toBe('ZWX');
    const r = decode('2222-3-33333');
    expect(r.text).toBe('ade');
    expect(r.wraps).toEqual({ count: 2, example: '2222 → A' });
  });

  it('tells the user when it wrapped', () => {
    const out = run('2222-7777-77777');
    expect(firstText(out)).toBe('ASP');
    expect(noteTexts(out).join('\n')).toMatch(
      /warn: 2 groups press a key more often.*2222 = A.*First one: 2222 → A/,
    );
    expect(noteTexts(run('44-33')).join('\n')).not.toMatch(/wraps around/);
    expect(noteTexts(run('2222', { separator: 'dash' })).join('\n')).toMatch(
      /1 group presses a key more often/,
    );
  });

  it('shortens the example of a very long group', () => {
    const r = decode(`${'2'.repeat(40)}-3`);
    expect(r.wraps?.example).toBe('222222222222… → A'); // 40 presses: (40 - 1) % 3 = 0
    expect(r.text).toBe('ad');
  });

  it('applies the Case option', () => {
    expect(firstText(run('44 33 555 555 666'))).toBe('HELLO');
    expect(firstText(run('44 33 555 555 666', { casing: 'lower' }))).toBe('hello');
    expect(firstText(run('44 33 555 555 666 0 9', { casing: 'lower' }))).toBe('hello w');
  });
});

describe('phone-keypad: multi-tap errors', () => {
  const fails = (fn: () => unknown, message: RegExp) => {
    expect(fn).toThrow(ToolError);
    expect(fn).toThrow(message);
  };

  it('key 1 and letters say what to do', () => {
    fails(() => run('44 1 33'), /Key 1 \(position 4\) has no letters/);
    fails(() => run('44 a 33'), /Unexpected "a" at position 4.*switch Mode to Encode/);
    fails(() => run('4*4'), /Unexpected "\*" at position 2/);
    fails(() => run('flag{x}'), /Unexpected "f" at position 1/);
  });

  it('empty input, and input with nothing but zeros', () => {
    fails(() => run(''), /Nothing to convert/);
    fails(() => run('   \n'), /Nothing to convert/);
    fails(() => run('0 0 0'), /Only 0 keys/);
    fails(() => run('000'), /Only 0 keys/);
  });

  it('a chosen separator must be the one used', () => {
    fails(
      () => run('44 33', { separator: 'dash' }),
      /Unexpected space between letters.*dash \(-\)/,
    );
    fails(() => run('44-33', { separator: 'space' }), /Unexpected dash \(-\) between letters/);
    fails(() => run('44,33', { separator: 'pipe' }), /Unexpected comma \(,\) between letters/);
  });

  it('a group that mixes keys cannot be one letter', () => {
    fails(
      () => run('4433-555', { separator: 'dash' }),
      /group "4433" mixes several keys.*set Separator to None/,
    );
  });
});

describe('phone-keypad: no separator (ranked splits)', () => {
  it('HELLO comes first for 4433555555666', () => {
    const r = decode('4433555555666');
    expect(r.text).toBe('hello');
    expect(r.readings!.length).toBe(10);
    expect(r.readings![0]).toMatchObject({ text: 'hello', lang: 'en' });
    expect(r.readings![0]!.score).toBeGreaterThan(15);
    expect(r.readings![1]!.score).toBeLessThan(r.readings![0]!.score);
    expect(r.total).toBe(384);
    expect(r.capped).toBe(false);
    expect(r.weak).toBe(false);
  });

  it('is shown as a ranked table next to the best reading', () => {
    const out = run('4433555555666');
    expect(out[0]).toEqual({ type: 'text', label: 'Best reading', value: 'HELLO' });
    const table = out.find((o) => o.type === 'table');
    expect(table?.type === 'table' && table.rows[0]).toEqual([
      1,
      'HELLO',
      expect.any(Number),
      'English',
    ]);
    expect(table?.type === 'table' && table.highlight).toEqual([0]);
    expect(noteTexts(out).join('\n')).toMatch(/384 ways to split this were tried/);
    expect(firstText(run('4433555555666', { casing: 'lower' }))).toBe('hello');
  });

  it('an explicit "none" does the same', () => {
    expect(decode('4433555555666', 'none').text).toBe('hello');
  });

  it('real words win over letters that merely contain short words', () => {
    // 'secret' scores below "sea a app pet" on readability alone.
    const word = (w: string) => encodeText(w, 'none').multitap;
    expect(decode(word('secret')).text).toBe('secret');
    expect(decode(word('cat')).text).toBe('cat');
    expect(decode(word('password')).text).toBe('password');
    expect(decode(word('flag')).text).toBe('flag');
    expect(decode(word('hidden')).text).toBe('hidden');
  });

  it('reads French as well as English', () => {
    const word = (w: string) => encodeText(w, 'none').multitap;
    expect(decode(word('bonjour')).text).toBe('bonjour');
    expect(decode(word('cette nuit')).text).toBe('cette nuit');
    expect(decode(word('merci')).text).toBe('merci');
    expect(decode(word('cette nuit')).readings![0]!.lang).toBe('fr');
  });

  it('puts the intended word first for nearly every word of the lists', () => {
    const words = [
      ...'house water friend morning because people number little system second window garden family office street'.split(
        ' ',
      ),
      ...'maison soleil ami matin parce enfant famille bureau fenetre jardin pourquoi semaine voiture ecole'.split(
        ' ',
      ),
    ];
    const wrong = words.filter((w) => decode(encodeText(w, 'none').multitap).text !== w);
    expect(wrong.length).toBeLessThanOrEqual(1);
  });

  it('the 0 key splits words that are solved on their own', () => {
    const digits = encodeText('hello world', 'none').multitap;
    expect(digits).toBe('4433555555666096667775553');
    const r = decode(digits);
    expect(r.text).toBe('hello world');
    expect(r.total).toBe(384 * 64);
    expect(r.capped).toBe(false); // each word is small, only their product is large
    expect(r.readings!.map((x) => x.text).slice(0, 2)).toEqual(['hello world', expect.any(String)]);
  });

  it('separators over unseparated words are read as word breaks', () => {
    const r = decode('4433555555666 96667775553');
    expect(r.text).toBe('hello world');
    expect(r.wordBreaks).toBe(true);
    expect(noteTexts(run('4433555555666 96667775553')).join('\n')).toMatch(/read as word breaks/);
    expect(decode('4433555555666-96667775553', 'none').text).toBe('hello world');
    // Groups that are single keys keep the separators as letter separators.
    expect(decode('44 33').wordBreaks).toBe(false);
  });

  it('a bare run of presses is a single letter first', () => {
    expect(decode('222').text).toBe('c');
    expect(decode('7777').text).toBe('s');
    expect(decode('23').readings).toBeNull();
    expect(decode('23').text).toBe('ad');
  });

  it('warns when nothing reads as a word', () => {
    const r = decode('55555');
    expect(r.weak).toBe(true);
    expect(noteTexts(run('55555')).join('\n')).toMatch(
      /warn: Some letters do not form French or English words/,
    );
    expect(decode('4433555555666').weak).toBe(false);
  });
});

describe('phone-keypad: the cap on combinations', () => {
  const long = 'meetmeatthecastlegatebeforemidnight';

  it('a word with too many splits is read with a dictionary search and says so', () => {
    const digits = encodeText(long, 'none').multitap;
    const r = decode(digits);
    expect(r.capped).toBe(true);
    expect(r.total).toBeGreaterThan(ENUM_CAP);
    expect(r.text).toBe(long);
    expect(r.readings).toBeNull();
    const out = run(digits);
    expect(firstText(out)).toBe(long.toUpperCase());
    expect(noteTexts(out).join('\n')).toMatch(/warn: There are too many ways to split this input/);
  });

  it('small inputs are never capped, and the cap is on one word, not on the phrase', () => {
    expect(decode('4433555555666').capped).toBe(false);
    expect(decode(encodeText('hello world', 'none').multitap).capped).toBe(false);
    const phrase = encodeText('meet me at the gate', 'none').multitap;
    const r = decode(phrase);
    expect(r.text).toBe('meet me at the gate');
    expect(r.capped).toBe(false);
  });

  it('a long unbroken run does not blow up', () => {
    const t0 = performance.now();
    const r = decode('2'.repeat(500));
    expect(r.capped).toBe(true);
    expect(r.total).toBe(1e12); // saturated, never Infinity or NaN
    expect(r.text.length).toBeGreaterThan(50);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});

describe('phone-keypad: speed on 2 KB of input', () => {
  const sentence =
    'the quick brown fox jumps over the lazy dog and then it runs away from the farmer who is working in the field ';
  const make = (n: number) => {
    let s = '';
    while (s.length < n) s += sentence;
    return s;
  };

  it('separated multi-tap', () => {
    const digits = encodeText(make(900), 'space').multitap;
    expect(digits.length).toBeGreaterThan(2000);
    const t0 = performance.now();
    const r = decode(digits);
    expect(r.text.startsWith('the quick brown fox')).toBe(true);
    expect(performance.now() - t0).toBeLessThan(500);
  });

  it('unseparated multi-tap with spaces typed as 0', () => {
    const digits = encodeText(make(1100), 'none').multitap;
    expect(digits.length).toBeGreaterThan(2000);
    const t0 = performance.now();
    const r = decode(digits);
    expect(r.text.startsWith('the quick brown fox jumps over the lazy dog')).toBe(true);
    expect(performance.now() - t0).toBeLessThan(2500);
  });

  it('2 KB of random keys with no separator and no zero', () => {
    let seed = 7;
    let digits = '';
    for (let i = 0; i < 2048; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      digits += String(2 + ((seed >> 8) % 8));
    }
    const t0 = performance.now();
    const r = decode(digits);
    expect(r.capped).toBe(true);
    expect(r.text.length).toBeGreaterThan(500);
    expect(performance.now() - t0).toBeLessThan(2500);
  });

  it('2 KB through the tool in every mode', () => {
    const digits = encodeText(make(700), 'space').multitap;
    const t0 = performance.now();
    run(digits);
    run(digits.replace(/ /g, '0'), { separator: 'none' });
    run(make(2048), { mode: 'encode' });
    run(encodeText(make(700), 'none').t9, { mode: 't9' });
    run(make(2048), { mode: 'letters' });
    expect(performance.now() - t0).toBeLessThan(4000);
  });
});

describe('phone-keypad: T9', () => {
  it('finds the word for 43556', () => {
    const r = decodeT9('43556');
    expect(r.text).toBe('hello');
    expect(r.tokens).toEqual([{ keys: '43556', words: ['hello'] }]);
    expect(r.unknown).toBe(0);
  });

  it('lists the candidates of an ambiguous sequence, most frequent first', () => {
    const r = decodeT9('4663');
    expect(r.tokens[0]!.words.slice(0, 3)).toEqual(['good', 'home', 'gone']);
    expect(r.text).toBe('good');
  });

  it('decodes several words separated by 0 or spaces', () => {
    expect(decodeT9('43556 0 96753').text).toBe('hello world');
    expect(decodeT9('43556096753').text).toBe('hello world');
    expect(decodeT9('43556 96753').text).toBe('hello world');
    expect(decodeT9('43556\n96753').text).toBe('hello world');
    expect(decodeT9('43556,96753').text).toBe('hello world');
    expect(decodeT9('43556 / 96753').text).toBe('hello world');
  });

  it('chooses between candidates by how the phrase reads', () => {
    // Frequency alone gives "come good room"; the phrase that reads is "come home soon".
    const keys = encodeText('come home soon', 'auto').t9;
    expect(keys).toBe('2663 0 4663 0 7666');
    expect(decodeT9(keys).tokens.map((t) => t.words[0])).toEqual(['come', 'good', 'room']);
    expect(decodeT9(keys).text).toBe('come home soon');
    // ... but it keeps the frequency order when nothing reads clearly better.
    expect(decodeT9('4663 0 4663').text).toBe('good good');
  });

  it('knows French words and keeps their accents', () => {
    const r = decodeT9('3383');
    expect(r.tokens[0]!.words).toContain('fête');
    expect(decodeT9('2665687').text).toBe('bonjour');
  });

  it('shows the letters of the keys for a sequence no word matches', () => {
    const r = decodeT9('43556 0 99999');
    expect(r.unknown).toBe(1);
    expect(r.chosen).toEqual(['hello', '[wxyz][wxyz][wxyz][wxyz][wxyz]']);
    const out = run('43556 0 99999', { mode: 't9' });
    expect(firstText(out)).toBe('HELLO [WXYZ][WXYZ][WXYZ][WXYZ][WXYZ]');
    expect(noteTexts(out).join('\n')).toMatch(
      /warn: 1 key sequence matches no French or English word/,
    );
  });

  it('is case-insensitive in its output option', () => {
    expect(firstText(run('43556', { mode: 't9' }))).toBe('HELLO');
    expect(firstText(run('43556', { mode: 't9', casing: 'lower' }))).toBe('hello');
  });

  it('lists each key sequence once with its candidates', () => {
    const out = run('4663 0 4663 0 43556', { mode: 't9' });
    const table = out.find((o) => o.type === 'table');
    expect(table?.type === 'table' && table.rows).toEqual([
      ['4663', expect.stringMatching(/^GOOD, HOME, GONE/)],
      ['43556', 'HELLO'],
    ]);
  });

  it('rejects key 1, letters and empty input with a hint', () => {
    expect(() => decodeT9('4355 1')).toThrow(/Key 1 \(position 6\)/);
    expect(() => decodeT9('hello')).toThrow(/Unexpected "h" at position 1.*switch Mode to Encode/);
    expect(() => decodeT9('43-556')).toThrow(/Unexpected "-" at position 3/);
    expect(() => decodeT9('')).toThrow(ToolError);
    expect(() => decodeT9('0 0')).toThrow(/Only 0 keys/);
  });
});

describe('phone-keypad: encode', () => {
  it('HELLO ↔ 44 33 555 555 666', () => {
    expect(encodeText('HELLO', 'auto').multitap).toBe('44 33 555 555 666');
    expect(encodeText('HELLO', 'auto').t9).toBe('43556');
    expect(upper(encodeText('HELLO', 'auto').multitap)).toBe('HELLO');
    expect(encodeText(decode('44 33 555 555 666').text, 'space').multitap).toBe(
      '44 33 555 555 666',
    );
  });

  it('round-trips text through every separator', () => {
    const text = 'meet me at the castle gate before midnight';
    for (const sep of ['auto', 'dash', 'space', 'comma', 'pipe'] as const) {
      const encoded = encodeText(text, sep).multitap;
      expect(decode(encoded, sep).text).toBe(text);
      expect(decode(encoded).text).toBe(text);
    }
    expect(decode(encodeText(text, 'none').multitap).text).toBe(text);
  });

  it('applies the separator and writes a space as 0', () => {
    const e = (sep: Separator) => encodeText('Hi you', sep).multitap;
    expect(e('space')).toBe('44 444 0 999 666 88');
    expect(e('dash')).toBe('44-444-0-999-666-88');
    expect(e('comma')).toBe('44,444,0,999,666,88');
    expect(e('pipe')).toBe('44|444|0|999|666|88');
    expect(e('none')).toBe('44444099966688');
    expect(encodeText('Hi you', 'auto').t9).toBe('44 0 968');
  });

  it('collapses white space, ignores case and drops accents', () => {
    expect(encodeText('  A\n\n  b  ', 'space').multitap).toBe('2 0 22');
    expect(encodeText('Café', 'space').multitap).toBe('222 2 333 33');
    expect(encodeText('ÉTÉ', 'space').t9).toBe('383');
  });

  it('reports what it could not encode and cannot encode only that', () => {
    const e = encodeText('flag{x}-1!', 'space');
    expect(e.skipped).toEqual(['{', '}', '-', '1', '!']);
    expect(e.letters).toBe(5);
    const out = run('flag{x}', { mode: 'encode' });
    expect(noteTexts(out).join('\n')).toMatch(
      /warn: Left out \(no letter on the keypad\): "\{" "\}"/,
    );
    expect(() => run('123 !?', { mode: 'encode' })).toThrow(/No letters to encode/);
    expect(() => run('', { mode: 'encode' })).toThrow(ToolError);
  });

  it('warns that neighbours on one key are ambiguous without a separator', () => {
    const none = run('HELLO', { mode: 'encode', separator: 'none' });
    expect(firstText(none)).toBe('4433555555666');
    expect(noteTexts(none).join('\n')).toMatch(
      /warn: With no separator, two neighbouring letters on the same key/,
    );
    expect(noteTexts(run('HELLO', { mode: 'encode' }))).toEqual([]);
    expect(noteTexts(run('FIND', { mode: 'encode', separator: 'none' }))).toEqual([]);
  });

  it('shows the multi-tap and the T9 sequence', () => {
    const out = run('HELLO', { mode: 'encode' });
    const texts = out.flatMap((o) => (o.type === 'text' ? [[o.label, o.value]] : []));
    expect(texts).toEqual([
      ['Multi-tap', '44 33 555 555 666'],
      ['T9', '43556'],
    ]);
  });
});

describe('phone-keypad: phone number letters', () => {
  it('turns the letters of a vanity number into digits', () => {
    expect(lettersToDigits('1-800-FLOWERS')).toEqual({ text: '1-800-3569377', converted: 7 });
    expect(lettersToDigits('1-800-flowers').text).toBe('1-800-3569377');
    expect(lettersToDigits('1-800-GO-FEDEX').text).toBe('1-800-46-33339');
    expect(lettersToDigits('+33 (0)1 CALL ME').text).toBe('+33 (0)1 2255 63');
    expect(lettersToDigits('QZ pqrs wxyz').text).toBe('79 7777 9999');
  });

  it('keeps everything else and folds accents', () => {
    expect(lettersToDigits('Téléphone: 555-0100 ext. 12').text).toBe('835374663: 555-0100 398. 12');
    expect(lettersToDigits('№ 5 ж').text).toBe('№ 5 ж');
    expect(lettersToDigits('').converted).toBe(0);
  });

  it('is a mode of the tool, with the digits alone and the keypad', () => {
    const out = run('1-800-FLOWERS', { mode: 'letters' });
    expect(firstText(out)).toBe('1-800-3569377');
    expect(textOf(out)).toContain('Digits only: 18003569377');
    expect(textOf(out)).toContain('Letters converted: 7');
    expect(noteTexts(run('555-0100', { mode: 'letters' }))).toEqual([
      'info: No letters in the text: only digits and punctuation, which are kept as they are.',
    ]);
    expect(() => run(' ', { mode: 'letters' })).toThrow(ToolError);
  });
});

describe('phone-keypad: the keypad block', () => {
  it('lists every key, with the presses in multi-tap and plain letters otherwise', () => {
    const block = (options: Record<string, unknown>) => {
      const input = options.mode === 'encode' || options.mode === 'letters' ? 'hi' : '44';
      const kv = run(input, options).find((o) => o.type === 'kv' && o.label === 'Keypad');
      return kv?.type === 'kv' ? Object.fromEntries(kv.entries) : {};
    };
    expect(block({})).toEqual({
      '1': 'no letters',
      '2': 'A 2 · B 22 · C 222',
      '3': 'D 3 · E 33 · F 333',
      '4': 'G 4 · H 44 · I 444',
      '5': 'J 5 · K 55 · L 555',
      '6': 'M 6 · N 66 · O 666',
      '7': 'P 7 · Q 77 · R 777 · S 7777',
      '8': 'T 8 · U 88 · V 888',
      '9': 'W 9 · X 99 · Y 999 · Z 9999',
      '0': 'space',
    });
    expect(block({ mode: 't9' })['7']).toBe('P Q R S');
    expect(block({ mode: 'letters' })['9']).toBe('W X Y Z');
    expect(block({ mode: 'encode' })['2']).toBe('A 2 · B 22 · C 222');
  });
});

describe('phone-keypad: detect', () => {
  const sample = (text: string) => ({ text, bytes: new Uint8Array() });
  const detect = (text: string) => phoneKeypad.detect!(sample(text));

  it('suggests multi-tap for groups of repeated keys', () => {
    const d = detect('44 33 555 555 666');
    expect(d?.score).toBeGreaterThan(0.5);
    expect(d?.score).toBeLessThan(0.7);
    expect(d?.options).toEqual({ mode: 'multitap', separator: 'auto' });
    expect(detect('44-33-555-555-666')?.score).toBeGreaterThan(0.5);
    expect(detect('7777-666-8-444-33')?.score).toBeGreaterThan(0.3);
  });

  it('scores less when the result does not read', () => {
    const readable = detect('44 33 555 555 666')!.score;
    const noise = detect('22 33 88 55 99 66')!.score;
    expect(noise).toBeLessThan(readable);
    expect(noise).toBeGreaterThanOrEqual(0.25);
  });

  it('stays out of the way of hex, decimal and plain digits', () => {
    expect(detect('deadbeef')).toBeNull();
    expect(detect('72 101 108 108 111')).toBeNull(); // charcodes (1 is not a key with letters)
    expect(detect('65 66 67 68 69 70')).toBeNull();
    expect(detect('4433555555666')).toBeNull(); // no separator: could be anything
    expect(detect('555-222-3333')).toBeNull(); // a phone number: 3333 is not a letter of key 3
    expect(detect('1-800-356-9377')).toBeNull();
    expect(detect('2 3 4 5')).toBeNull(); // single presses only
    expect(detect('44 33')).toBeNull(); // too short to say
    expect(detect('')).toBeNull();
    expect(detect('hello world')).toBeNull();
  });
});
