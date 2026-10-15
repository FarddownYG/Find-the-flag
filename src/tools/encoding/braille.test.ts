import { describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors';
import { resultToText } from '../../core/result-text';
import type { Output } from '../../core/types';
import { toHex, utf8Decode, utf8Encode } from '../../lib/bytes';
import braille, {
  brailleToText,
  bytesToCells,
  cellChar,
  cellsToBytes,
  dotsOf,
  readBraille,
  readCells,
  readDots,
  textToBraille,
  cellsToString,
} from './braille';

const toText = (cells: string) => brailleToText(readBraille(cells).items);
const toCells = (text: string, blank = false) => cellsToString(textToBraille(text).masks, blank);

describe('braille: cells and dots', () => {
  it('dot n is bit n-1, as the Unicode character names say', () => {
    // Names from the Unicode database (Python unicodedata): U+2803 is "BRAILLE PATTERN DOTS-12"...
    const names: [number, string][] = [
      [0x2800, '0'], // BLANK
      [0x2803, '12'],
      [0x2841, '17'],
      [0x2840, '7'],
      [0x2880, '8'],
      [0x283c, '3456'],
      [0x28ff, '12345678'],
    ];
    for (const [cp, dots] of names) expect(dotsOf(cp - 0x2800)).toBe(dots);
    expect(cellChar(0x3c)).toBe('⠼');
  });
});

describe('braille: grade 1 text', () => {
  const ALPHABET = '⠁⠃⠉⠙⠑⠋⠛⠓⠊⠚⠅⠇⠍⠝⠕⠏⠟⠗⠎⠞⠥⠧⠺⠭⠽⠵';

  it('the alphabet, both ways', () => {
    expect(toCells('abcdefghijklmnopqrstuvwxyz')).toBe(ALPHABET);
    expect(toText(ALPHABET).text).toBe('abcdefghijklmnopqrstuvwxyz');
  });

  // Made with the independent Python implementation (pip "pybraille" 1.0.0). It writes one capital
  // sign per capital letter and its semicolon is not grade 1, so those cases are left out.
  const PYTHON: [string, string][] = [
    ['0123456789', '⠼⠚⠁⠃⠉⠙⠑⠋⠛⠓⠊'],
    ['The quick brown fox jumps over the lazy dog', '⠠⠞⠓⠑ ⠟⠥⠊⠉⠅ ⠃⠗⠕⠺⠝ ⠋⠕⠭ ⠚⠥⠍⠏⠎ ⠕⠧⠑⠗ ⠞⠓⠑ ⠇⠁⠵⠽ ⠙⠕⠛'],
    ['Hello World', '⠠⠓⠑⠇⠇⠕ ⠠⠺⠕⠗⠇⠙'],
    ['Hello, World 42', '⠠⠓⠑⠇⠇⠕⠂ ⠠⠺⠕⠗⠇⠙ ⠼⠙⠃'],
    ['It is 3.14 or 1,000 or 42', '⠠⠊⠞ ⠊⠎ ⠼⠉⠲⠁⠙ ⠕⠗ ⠼⠁⠂⠚⠚⠚ ⠕⠗ ⠼⠙⠃'],
    ['a1 b2 j9', '⠁⠼⠁ ⠃⠼⠃ ⠚⠼⠊'],
    [": . ! ? ' -", '⠒ ⠲ ⠖ ⠦ ⠄ ⠤'],
  ];

  it.each(PYTHON)('matches the Python reference for %j', (text, cells) => {
    expect(toCells(text)).toBe(cells);
  });

  it('decodes them back (numbers after the number sign, capitals after the capital sign)', () => {
    for (const [text, cells] of PYTHON) {
      if (text.startsWith('a1')) continue; // "a1" needs the letter sign to come back: see below
      expect(toText(cells).text).toBe(text);
    }
  });

  it('number sign, digits as a-j, decimal point and comma, letter sign after a number', () => {
    expect(toCells('1a')).toBe('⠼⠁⠰⠁'); // 1 then the letter a: the letter sign ends the number
    expect(toText('⠼⠁⠰⠁').text).toBe('1a');
    expect(toText('⠼⠁⠃⠉⠲⠑').text).toBe('123.5');
    expect(toText('⠼⠁⠂⠚⠚⠚').text).toBe('1,000');
    expect(toText('⠼⠁ ⠁').text).toBe('1 a');
    expect(toText('⠼⠁⠤⠃').text).toBe('1-b'); // a hyphen ends the number
    expect(toCells('12-3')).toBe('⠼⠁⠃⠤⠼⠉');
  });

  it('capitals: one letter, one word (two signs), a passage (three signs and an end sign)', () => {
    expect(toText('⠠⠁⠃').text).toBe('Ab');
    expect(toText('⠠⠠⠁⠃ ⠉').text).toBe('AB c');
    expect(toText('⠠⠠⠠⠁⠃ ⠉⠙⠠⠄ ⠑').text).toBe('AB CD e');
    // a capital word ends at the first symbol or digit
    expect(toText('⠠⠠⠋⠞⠋⠸⠣⠙⠑⠍⠕⠸⠜').text).toBe('FTF{demo}');
    expect(toText('⠠⠠⠙⠕⠝⠄⠠⠞').text).toBe("DON'T");
    expect(toCells('FLAG')).toBe('⠠⠠⠋⠇⠁⠛');
    expect(toCells('Flag')).toBe('⠠⠋⠇⠁⠛');
    expect(toCells('McD')).toBe('⠠⠍⠉⠠⠙');
    expect(toCells('A b')).toBe('⠠⠁ ⠃'); // one capital letter stays a single sign
  });

  it('punctuation and symbols with one or two cells', () => {
    const symbols = ", ; : . ! ' - ( ) [ ] { } / \\ @ & $ # * + = % _ < >";
    expect(toText(toCells(symbols)).text).toBe(symbols);
    expect(toCells(';')).toBe('⠆');
    expect(toCells('@')).toBe('⠈⠁');
    expect(toCells('(a)')).toBe('⠐⠣⠁⠐⠜');
    expect(toCells('a/b')).toBe('⠁⠸⠌⠃');
  });

  it('quotation marks open where a word starts and close elsewhere; "?" after a word', () => {
    expect(toCells('"hi" ok?')).toBe('⠦⠓⠊⠴ ⠕⠅⠦');
    expect(toText('⠦⠓⠊⠴ ⠕⠅⠦').text).toBe('"hi" ok?');
    expect(toCells('“hi”')).toBe('⠦⠓⠊⠴');
    expect(toText('⠘⠦⠓⠊⠘⠴').text).toBe('"hi"');
  });

  it('round-trips ordinary text with capitals, numbers and punctuation', () => {
    const samples = [
      'Hello, World!',
      'FTF{demo} is not braille',
      "WORLD-WIDE web, DON'T panic",
      'The year 2024 had 365 days (and 12 months).',
      "It's 3.5 or 1,250: SECRET Code?",
      'a b\nc d',
    ];
    for (const s of samples) {
      const r = textToBraille(s);
      expect(r.skipped).toEqual([]);
      expect(toText(cellsToString(r.masks, false)).text).toBe(s);
    }
  });

  it('reports characters with no cell and cells with no reading', () => {
    expect(textToBraille('a~b€').skipped).toEqual(['~', '€']);
    const r = toText('⠁⠿⠃'); // dots 123456 has no grade 1 reading
    expect(r.text).toBe('a?b');
    expect(r.unknown).toEqual([{ pos: 2, dots: '123456' }]);
    expect(toText('⡦').unknown).toEqual([{ pos: 1, dots: '2367' }]); // an 8-dot cell
  });

  it('blank cells and normal spaces both separate words; other characters are kept', () => {
    expect(toText('⠁⠀⠃ ⠉').text).toBe('a b c');
    expect(toCells('a b', true)).toBe('⠁⠀⠃');
    const kept = toText('⠁ x ⠃');
    expect(kept.text).toBe('a x b');
    expect(kept.kept).toBe(1);
  });
});

describe('braille: dot numbers', () => {
  it('reads cells separated by dashes, spaces, commas or slashes', () => {
    for (const sep of ['-', ' ', ',', '.', '_', ' - ']) {
      expect(toText(['125', '15', '123', '123', '135'].join(sep)).text).toBe('hello');
    }
    expect(toText('125-15-123-123-135-0-2456-135-1235-123-145').text).toBe('hello world');
    expect(toText('125-15 / 123-123-135').text).toBe('he llo');
    expect(toText('1-25-14').text).toBe('a:c'); // 1 = a, 25 = dots 2 and 5 (a colon), 14 = c
  });

  it('digits can be in any order within a cell', () => {
    expect(readDots('52')[0]).toEqual({ kind: 'cell', mask: 0x12, pos: 1 });
    expect(readDots('25')[0]).toEqual({ kind: 'cell', mask: 0x12, pos: 1 });
  });

  it('turns cells into dot numbers and back', () => {
    const cells = '⠃⠗⠁⠊⠇⠇⠑ ⠠⠁';
    const dots = (text: string) =>
      readBraille(text)
        .items.map((i) => (i.kind === 'cell' ? dotsOf(i.mask) : i.kind === 'space' ? '0' : ''))
        .join('-');
    expect(dots(cells)).toBe('12-1235-1-24-123-123-15-0-6-1');
    const back = readDots('12-1235-1-24-123-123-15-0-6-1').map((i) =>
      i.kind === 'cell' ? cellChar(i.mask) : ' ',
    );
    expect(back.join('')).toBe(cells);
  });

  it('every one of the 256 cells survives cells -> dots -> cells', () => {
    for (let m = 1; m < 256; m++) {
      const item = readDots(dotsOf(m))[0]!;
      expect(item).toMatchObject({ kind: 'cell', mask: m });
    }
  });

  it('explains a bad group with its position', () => {
    expect(() => readDots('1-9-2')).toThrow(
      /"9" at position 3 \(in "9"\): dots are numbered 1 to 8/,
    );
    expect(() => readDots('12-103')).toThrow(/"103" at position 4: 0 stands for a blank cell/);
    expect(() => readDots('12-11')).toThrow(/"11" at position 4 repeats a dot/);
    expect(() => readDots('12-ab')).toThrow(/"a" at position 4 is not a dot number/);
    expect(() => readDots('12-x')).toThrow(ToolError);
  });
});

describe('braille: bytes (8-dot cells)', () => {
  it('every byte value is one cell, dot n = bit n-1', () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    const cells = bytesToCells(all);
    expect([...cells]).toHaveLength(256);
    expect(cells.codePointAt(0)).toBe(0x2800);
    expect(cells.codePointAt(255)).toBe(0x28ff);
    expect(toHex(cellsToBytes(readCells(cells)).bytes)).toBe(toHex(all));
    // "A" = 0x41 = dots 1 and 7
    expect(bytesToCells(utf8Encode('A'))).toBe('⡁');
  });

  it('skips spaces and line breaks, reads a blank cell as 0x00, rejects other characters', () => {
    const r = cellsToBytes(readCells('⡦⡬ ⡡\n⡧⠀'));
    expect(toHex(r.bytes)).toBe('666c61670' + '0');
    expect(r.skipped).toBe(2);
    expect(() => cellsToBytes(readCells('⡦x⡬'))).toThrow(/"x" at position 2 is not a braille cell/);
  });
});

describe('braille tool', () => {
  const run = (text: string, options: Record<string, unknown> = {}) =>
    braille.run({ bytes: utf8Encode(text) }, {
      mode: 'decode',
      as: 'text',
      blank: false,
      ...options,
    } as never) as Output[];

  it('decode: text, bytes and dot numbers', () => {
    expect(resultToText(run('⠃⠗⠁⠊⠇⠇⠑'))).toBe('braille');
    expect(resultToText(run('⡦⡬⡡⡧', { as: 'bytes' }))).toBe('flag');
    expect(resultToText(run('⠃⠗⠁⠊⠇⠇⠑ ⠁', { as: 'dots' }))).toBe('12-1235-1-24-123-123-15-0-1');
    expect(resultToText(run('125-15-123-123-135', { as: 'bytes' }))).toBe(
      '\u0013\u0011\u0007\u0007\u0015',
    );
  });

  it('encode: text, bytes and dot numbers', () => {
    expect(resultToText(run('Hello', { mode: 'encode' }))).toBe('⠠⠓⠑⠇⠇⠕');
    expect(resultToText(run('flag', { mode: 'encode', as: 'bytes' }))).toBe('⡦⡬⡡⡧');
    expect(resultToText(run('125-15-0-123', { mode: 'encode', as: 'dots' }))).toBe('⠓⠑ ⠇');
    expect(resultToText(run('125-15-0-123', { mode: 'encode', as: 'dots', blank: true }))).toBe(
      '⠓⠑⠀⠇',
    );
  });

  it('notes what it could not read', () => {
    expect(resultToText(run('a~', { mode: 'encode' }))).toContain('skipped: ~');
    expect(resultToText(run('⠁⠿'))).toContain('123456 (2)');
    expect(resultToText(run('125-15-123'))).toContain('Read from dot numbers');
  });

  it('rejects empty input and text without cells', () => {
    expect(() => run('  ')).toThrow(ToolError);
    expect(() => run('hello')).toThrow(/No braille cells/);
  });

  it('detect: cells (6-dot as text, 8-dot as bytes) and dot numbers that read as text', () => {
    const sample = (text: string) => ({ text, bytes: new Uint8Array() });
    expect(braille.detect!(sample('⠃⠗⠁⠊⠇⠇⠑'))).toMatchObject({
      score: 0.92,
      options: { as: 'text' },
    });
    expect(braille.detect!(sample('⡦⡬⡡⡧'))).toMatchObject({ options: { as: 'bytes' } });
    expect(braille.detect!(sample('125-15-123-123-135'))?.score).toBe(0.5);
    expect(braille.detect!(sample('12-3-2024'))).toBeNull();
    expect(braille.detect!(sample('hello world'))).toBeNull();
    expect(braille.detect!(sample('⠁⠃'))).toBeNull();
  });
});

// the ASCII text of the 8-dot example, to keep the example and the bytes honest
describe('braille: the example flag', () => {
  it('8-dot cells spell flag{braille_bytes}', () => {
    const cells = '⡦⡬⡡⡧⡻⡢⡲⡡⡩⡬⡬⡥⡟⡢⡹⡴⡥⡳⡽';
    expect(utf8Decode(cellsToBytes(readCells(cells)).bytes)).toBe('flag{braille_bytes}');
  });
});
