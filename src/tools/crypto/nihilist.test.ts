import { describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors';
import { resultToText } from '../../core/result-text';
import type { ToolResult } from '../../core/types';
import tool, {
  guessKey,
  keyLengthRows,
  likelyLength,
  nihilistDecrypt,
  nihilistEncrypt,
  parseNihilistKey,
  readNumbers,
  squareTransposition,
} from './nihilist';
import { parseColumnKey } from './_transposition';
import { buildSquare } from './polybius';
import { PROSE_A, PROSE_B } from './_sample-text';

type Options = Parameters<typeof tool.run>[1];

const run = (text: string, options: Partial<Options> = {}): ToolResult =>
  tool.run(text, {
    method: 'numbers',
    mode: 'decrypt',
    square: '',
    key: '',
    transpositionKey: '',
    read: 'rows',
    pad: 'X',
    keyLength: 0,
    ...options,
  }) as ToolResult;

const first = (r: ToolResult): string => {
  const block = r[0];
  if (block?.type !== 'text') throw new Error('first block is not text');
  return block.value;
};

const letters = (s: string) => s.replace(/[^A-Za-z]/g, '').toUpperCase();

// Wikipedia, "Nihilist cipher": square keyword ZEBRAS, key RUSSIAN, DYNAMITE WINTER PALACE.
const SQUARE = buildSquare('polybius', 'ZEBRAS');
const WIKI_NUMBERS = [
  37, 106, 62, 36, 67, 47, 86, 26, 104, 53, 62, 77, 27, 55, 57, 66, 55, 36, 54, 27,
];
const RUSSIAN = [14, 51, 21, 21, 32, 15, 41];

describe('Nihilist cipher (published example)', () => {
  it('uses the ZEBRAS square', () => {
    // ZEBRA / SCDFG / HIKLM / NOPQT / UVWXY
    expect(SQUARE).toBe('ZEBRASCDFGHIKLMNOPQTUVWXY');
  });

  it('turns RUSSIAN into the key numbers 14 51 21 21 32 15 41', () => {
    expect(parseNihilistKey('RUSSIAN', SQUARE)).toEqual({ numbers: RUSSIAN, kind: 'word' });
  });

  it('adds the key to the coordinates, as in the article', () => {
    // D = 23, Y = 55, N = 41, A = 15, M = 35, I = 32, T = 45, E = 12 (square row and column);
    // plus R U S S I A N R = 14 51 21 21 32 15 41 14 gives 37 106 62 36 67 47 86 26.
    const { numbers, skipped } = nihilistEncrypt('DYNAMITE WINTER PALACE', SQUARE, RUSSIAN);
    expect(numbers).toEqual(WIKI_NUMBERS);
    expect(skipped).toBe(0);
  });

  it('subtracts it again', () => {
    expect(nihilistDecrypt(WIKI_NUMBERS, SQUARE, RUSSIAN)).toEqual({
      plain: 'DYNAMITEWINTERPALACE',
      invalid: 0,
    });
  });

  it('in the tool, with the key as a word or as numbers', () => {
    const text = WIKI_NUMBERS.join(' ');
    for (const key of ['RUSSIAN', 'russian', '14 51 21 21 32 15 41', '14,51,21,21,32,15,41']) {
      expect(first(run(text, { square: 'ZEBRAS', key }))).toBe('DYNAMITEWINTERPALACE');
    }
    expect(first(run(text, { square: 'ZEBRAS', key: '14512121321541' }))).toBe(
      'DYNAMITEWINTERPALACE',
    );
    expect(
      first(run('Dynamite winter palace', { mode: 'encrypt', square: 'ZEBRAS', key: 'RUSSIAN' })),
    ).toBe(WIKI_NUMBERS.join(' '));
  });
});

describe('Nihilist cipher details', () => {
  it('reads I and J as one letter and counts what it left out', () => {
    const a = nihilistEncrypt('Jim, 2 bats!', SQUARE, RUSSIAN);
    const b = nihilistEncrypt('IIMBATS', SQUARE, RUSSIAN);
    expect(a.numbers).toEqual(b.numbers);
    expect(a.skipped).toBe(3); // , 2 !
  });

  it('shows ? for a number that gives no letter, and warns when most are wrong', () => {
    const right = run(WIKI_NUMBERS.join(' '), { square: 'ZEBRAS', key: 'RUSSIAN' });
    expect(resultToText(right)).not.toContain('do not give a letter');
    const wrong = run(WIKI_NUMBERS.join(' '), { square: 'ZEBRAS', key: 'KEY' });
    expect(first(wrong)).toContain('?');
    const out = resultToText(wrong);
    expect(out).toMatch(/\d+ of 20 numbers do not give a letter/);
    const note = wrong.find((o) => o.type === 'note' && o.text.includes('do not give a letter'));
    expect(note?.type === 'note' && note.level).toBe('warn');
  });

  it('accepts numbers on several lines and with commas or slashes', () => {
    expect(readNumbers('37 106,62\n36 / 67;47')).toEqual([37, 106, 62, 36, 67, 47]);
  });

  it('says what is wrong with the numbers and the key', () => {
    expect(() => readNumbers('   ')).toThrow(/Paste the numbers/);
    expect(() => readNumbers('3710662')).toThrow(/too long to be one number/);
    expect(() => readNumbers('37 abc 62')).toThrow(/"abc" is not a number/);
    expect(() => parseNihilistKey('', SQUARE)).toThrow(/Enter the key/);
    expect(() => parseNihilistKey('KEY2', SQUARE)).toThrow(/mixes letters and digits/);
    expect(parseNihilistKey('14512121', SQUARE).numbers).toEqual([14, 51, 21, 21]);
    // An odd run of digits cannot be read in pairs, and is too big as one number.
    expect(() => parseNihilistKey('1234567', SQUARE)).toThrow(/below 1000/);
    expect(() => parseNihilistKey('14 5000', SQUARE)).toThrow(/below 1000/);
    expect(() => run('12 34', { mode: 'encrypt', key: 'KEY' })).toThrow(/no letters/);
  });

  it('round-trips for several squares and keys', () => {
    const plain = letters(PROSE_A.slice(0, 300)).replace(/J/g, 'I');
    for (const [squareKeyword, key] of [
      ['', 'A'],
      ['ZEBRAS', 'RUSSIAN'],
      ['KEYWORD', '11 22 33 44 55'],
      ['LIGHTHOUSE', 'REVOLUTION'],
    ] as const) {
      const sq = buildSquare('polybius', squareKeyword);
      const k = parseNihilistKey(key, sq).numbers;
      const { numbers } = nihilistEncrypt(plain, sq, k);
      expect(nihilistDecrypt(numbers, sq, k).plain, `${squareKeyword} ${key}`).toBe(plain);
      expect(Math.min(...numbers)).toBeGreaterThanOrEqual(22);
      expect(Math.max(...numbers)).toBeLessThanOrEqual(110);
    }
  });
});

describe('key length from the numbers', () => {
  const plain = letters(PROSE_A).replace(/J/g, 'I'); // 600+ letters
  const encrypt = (key: string, text = plain) => {
    const sq = buildSquare('polybius', 'ZEBRAS');
    return nihilistEncrypt(text, sq, parseNihilistKey(key, sq).numbers).numbers;
  };

  it('finds the length of several keys: every position fits, shorter ones do not', () => {
    for (const key of ['RUSSIAN', 'ZEBRAS', 'LIGHTHOUSE', 'REVOLUTIONARY', 'KEY']) {
      const numbers = encrypt(key);
      const rows = keyLengthRows(numbers);
      expect(likelyLength(rows), key).toBe(key.length);
      const fit = rows[key.length - 1]!;
      expect(fit.fitting).toBe(key.length);
      // Multiples of the key length fit as well; other lengths below it do not.
      for (const r of rows.slice(0, key.length - 1)) expect(r.fitting).toBeLessThan(r.length);
      expect(rows[2 * key.length - 1]?.fitting ?? 2 * key.length).toBe(2 * key.length);
    }
  });

  it('a one-number key is a length of 1', () => {
    expect(likelyLength(keyLengthRows(encrypt('A')))).toBe(1);
  });

  it('says nothing when there are too few numbers per position', () => {
    // 20 numbers: at a length of 7 each position holds 2 or 3, too few to believe.
    expect(likelyLength(keyLengthRows(WIKI_NUMBERS))).not.toBe(7);
    const out = resultToText(run(WIKI_NUMBERS.join(' '), { method: 'analyse' }));
    expect(out).not.toMatch(/tool\.nihilist\./);
  });

  it('numbers that are not Nihilist sums are not analysed', () => {
    expect(() => run('12 30 50 70 90 111 50 40', { method: 'analyse' })).toThrow(/outside 22-110/);
    expect(() => run('37 106 62', { method: 'analyse' })).toThrow(/At least 8/);
  });

  it('guesses the key by letter frequency when the square is known', () => {
    const numbers = encrypt('RUSSIAN');
    const sq = buildSquare('polybius', 'ZEBRAS');
    const g = guessKey(numbers, 7, sq);
    expect(g.key).toEqual(RUSSIAN);
    expect(g.smallest).toBeGreaterThan(50);
    expect(nihilistDecrypt(numbers, sq, g.key).plain).toBe(plain);
    // The square is needed for the letters but not for the length.
    expect(likelyLength(keyLengthRows(numbers))).toBe(7);
  });

  it('in the tool: the length, the key, the plaintext and a button that applies the key', () => {
    const numbers = encrypt('RUSSIAN', letters(PROSE_B).replace(/J/g, 'I'));
    const r = run(numbers.join(' '), { method: 'analyse', square: 'ZEBRAS' });
    const out = resultToText(r);
    expect(out).toContain('Most likely key length: 7');
    expect(out).toContain('14 51 21 21 32 15 41');
    expect(out).toContain('Plaintext guess with a key of 7 numbers');
    expect(out).toContain('CRYPTOGRAPHYISTHEPRACTICEOFHIDINGINFORMATION');
    expect(out).toContain('RUSSIAN'.replace('R', 'R'));
    const actions = r.find((o) => o.type === 'actions');
    const options = actions?.type === 'actions' ? actions.actions[0]!.options : {};
    const back = run(numbers.join(' '), options as Partial<Options>);
    expect(first(back)).toBe(letters(PROSE_B).replace(/J/g, 'I'));
    expect(resultToText(r)).not.toMatch(/tool\.nihilist\./);
  });

  it('a given key length is tried even when the table does not recommend it', () => {
    const numbers = encrypt('RUSSIAN');
    const out = resultToText(
      run(numbers.join(' '), { method: 'analyse', square: 'ZEBRAS', keyLength: 14 }),
    );
    expect(out).toContain('Plaintext guess with a key of 14 numbers');
    // A wrong length has positions that no key number can explain.
    const wrong = resultToText(
      run(numbers.join(' '), { method: 'analyse', square: 'ZEBRAS', keyLength: 3 }),
    );
    expect(wrong).toContain('some positions have no key number that fits');
  });

  it('triage suggests the helper for numbers from 22 to 110 and not for Polybius numbers', () => {
    const d = tool.detect!({ text: WIKI_NUMBERS.join(' '), bytes: new Uint8Array() });
    expect(d?.options).toEqual({ method: 'analyse' });
    expect(
      tool.detect!({ text: '23 15 31 31 34 23 15 31 31 34', bytes: new Uint8Array() }),
    ).toBeNull();
    expect(tool.detect!({ text: '37 106 62', bytes: new Uint8Array() })).toBeNull();
  });
});

describe('Nihilist transposition', () => {
  const T = (s: string, key: string, options: Partial<Options> = {}) =>
    first(run(s, { method: 'transposition', transpositionKey: key, ...options }));

  it('puts the rows and the columns of the square in key order', () => {
    // CAB reads A, B, C: columns 1, 2, 0. Rows: E F D / H I G / B C A, read by rows.
    expect(T('ABCDEFGHI', 'CAB', { mode: 'encrypt' })).toBe('EFDHIGBCA');
    expect(T('ABCDEFGHI', 'CAB', { mode: 'encrypt', read: 'columns' })).toBe('EHBFICDGA');
    expect(T('EFDHIGBCA', 'CAB')).toBe('ABCDEFGHI');
    expect(T('EHBFICDGA', 'CAB', { read: 'columns' })).toBe('ABCDEFGHI');
  });

  it('matches an independent implementation (scripts/gen-samples-transposition.mjs)', () => {
    const plain = 'readthisnow_flag{nihilist_square_ok}';
    const cipher = 'us_qat{algnfwnso_iiihlsik_eo}rtaedhr';
    expect(T(plain, 'ZEBRAS', { mode: 'encrypt' })).toBe(cipher);
    expect(T(cipher, 'ZEBRAS')).toBe(plain);
  });

  it('cuts a long text into squares and pads the last one', () => {
    const text = 'the quick brown fox jumps over the lazy dog';
    const cipher = T(text, 'KEY', { mode: 'encrypt' });
    const cells = text.replace(/ /g, '');
    expect(cipher).toHaveLength(Math.ceil(cells.length / 9) * 9);
    expect(T(cipher, 'KEY')).toBe(cells + 'XXXXX'.slice(0, cipher.length - cells.length));
    expect(
      resultToText(
        run(text, { method: 'transposition', mode: 'encrypt', transpositionKey: 'KEY' }),
      ),
    ).toContain('Padding added to fill the last square: 1 × X');
  });

  it('round-trips with word keys, number keys and both readings', () => {
    const cells = [...'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ+-']; // 62 chars
    for (const key of ['ZEBRAS', '3 1 2', 'A', 'TOMATO', '2413']) {
      const k = parseColumnKey(key);
      const size = k.symbols.length ** 2;
      const text = cells.slice(0, size * Math.floor(cells.length / size));
      for (const byColumns of [false, true]) {
        const enc = squareTransposition(text, k, false, byColumns);
        expect([...enc].sort(), key).toEqual([...text].sort());
        expect(squareTransposition(enc, k, true, byColumns), key).toEqual(text);
      }
    }
  });

  it('explains what is wrong', () => {
    expect(() => run('abcdefg', { method: 'transposition', transpositionKey: 'KEY' })).toThrow(
      /3×3 square holds 9 characters/,
    );
    expect(() => run('abc', { method: 'transposition', transpositionKey: '' })).toThrow(
      /Enter a key/,
    );
    expect(() => run('  ', { method: 'transposition', transpositionKey: 'KEY' })).toThrow(
      ToolError,
    );
  });

  it('shows the square before and after', () => {
    const r = run('EFDHIGBCA', { method: 'transposition', transpositionKey: 'CAB' });
    const tables = r.filter((o) => o.type === 'table');
    expect(tables).toHaveLength(2);
    const written = tables[0]!;
    expect(written.type === 'table' && written.rows[0]).toEqual(['#', '3', '1', '2']);
    // The plaintext square, with each row labelled by its place in the key.
    expect(written.type === 'table' && written.rows[1]).toEqual(['3', 'A', 'B', 'C']);
    expect(resultToText(r)).not.toMatch(/tool\.nihilist\./);
  });
});
