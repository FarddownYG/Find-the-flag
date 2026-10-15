import { describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors';
import { resultToText } from '../../core/result-text';
import type { Output, ToolResult } from '../../core/types';
import {
  bifidGrid,
  blockSizes,
  coordinatesOf,
  fractionate,
  joinBlocks,
  trifidGrid,
} from './_bifid';
import { makeRng } from './_classical';
import { PROSE_A, PROSE_B } from './_sample-text';
import { toSymbols, type SquareKind } from './_square';
import tool from './bifid';

type Opts = Parameters<typeof tool.run>[1];
const DEFAULTS: Opts = {
  cipher: 'bifid',
  mode: 'decrypt',
  key: '',
  square: 'ij',
  symbol: '+',
  period: 0,
  groups: 'none',
};
const run = (text: string, options: Partial<Opts> = {}): ToolResult =>
  tool.run(text, { ...DEFAULTS, ...options }) as ToolResult;
const textOf = (result: ToolResult, labelPart: string): string => {
  const block = result.find(
    (o): o is Extract<Output, { type: 'text' }> =>
      o.type === 'text' && (o.label ?? '').includes(labelPart),
  );
  if (!block) throw new Error(`no text block labelled ${labelPart}`);
  return block.value;
};
const tableOf = (result: ToolResult, labelPart: string): Extract<Output, { type: 'table' }> => {
  const t = result.find(
    (o): o is Extract<Output, { type: 'table' }> =>
      o.type === 'table' && (o.label ?? '').includes(labelPart),
  );
  if (!t) throw new Error(`no table labelled ${labelPart}`);
  return t;
};

const WIKI_KEY = 'BGWKZQPNDSIOAXEFCLUMTHYVR';
const PC_KEY = 'PHQGMEAYLNOFDXKRCVSZWBUTI';
const sym = (s: string) => [...s];

describe('published test vectors', () => {
  it('Bifid, Wikipedia: FLEEATONCE -> UAEOLWRINS (the whole message)', () => {
    const grid = bifidGrid('ij', WIKI_KEY);
    expect(joinBlocks(fractionate(grid, sym('FLEEATONCE'), 0, 'encrypt'))).toBe('UAEOLWRINS');
    expect(joinBlocks(fractionate(grid, sym('UAEOLWRINS'), 0, 'decrypt'))).toBe('FLEEATONCE');
    expect(textOf(run('UAEOLWRINS', { key: WIKI_KEY }), 'Plaintext')).toBe('FLEEATONCE');
  });

  it('Bifid, Practical Cryptography: key PHQGMEAYLNOFDXKRCVSZWBUTI, period 5', () => {
    const out = run('Defend the east wall of the castle', {
      mode: 'encrypt',
      key: PC_KEY,
      period: 5,
    });
    expect(textOf(out, 'Ciphertext')).toBe('FFYHMKHYCPLIASHADTRLHCCHLBLR');
    const back = run('FFYHMKHYCPLIASHADTRLHCCHLBLR', { key: PC_KEY, period: 5 });
    expect(textOf(back, 'Plaintext')).toBe('DEFENDTHEEASTWALLOFTHECASTLE');
  });

  it('Bifid with a period, worked by hand: FLEEA|TONCE -> UAIEY|YDINS', () => {
    // Block 1: rows 44333, columns 13553 -> 44 33 31 35 53 = U A I E Y.
    // Block 2: rows 53243, columns 12325 -> 53 24 31 23 25 = Y D I N S.
    const grid = bifidGrid('ij', WIKI_KEY);
    const blocks = fractionate(grid, sym('FLEEATONCE'), 5, 'encrypt');
    expect(blocks.map((b) => b.lines.map((l) => l.join('')))).toEqual([
      ['44333', '13553'],
      ['53243', '12325'],
    ]);
    expect(joinBlocks(blocks)).toBe('UAIEYYDINS');
  });

  it('Trifid, Wikipedia: key FELIXMARIEDELASTELLE, period 5, "aide-toi, le ciel t\'aidera"', () => {
    const plain = "aide-toi, le ciel t'aidera";
    const out = run(plain, {
      cipher: 'trifid',
      mode: 'encrypt',
      key: 'FELIXMARIEDELASTELLE',
      period: 5,
    });
    expect(textOf(out, 'Ciphertext')).toBe('FMJFVOISSUFTFPUFEQQC');
    const back = run('FMJFVOISSUFTFPUFEQQC', {
      cipher: 'trifid',
      key: 'felixmariedelastelle',
      period: 5,
    });
    expect(textOf(back, 'Plaintext')).toBe('AIDETOILECIELTAIDERA');
  });
});

describe('the grids', () => {
  it('builds keyed squares and cubes, layer by layer', () => {
    expect(bifidGrid('ij', 'monarchy').symbols.join('')).toBe('MONARCHYBDEFGIKLPQSTUVWXZ');
    expect(bifidGrid('digits', 'x1').symbols).toHaveLength(36);
    const cube = trifidGrid('+', 'FELIXMARIEDELASTELLE');
    expect(cube.symbols.join('')).toBe('FELIXMARDSTBCGHJKNOPQUVWYZ+');
    expect(cube.symbols).toHaveLength(27);
    // The 27th symbol may be in the key: it then comes first, not last.
    expect(trifidGrid('.', 'EPSDUCVWYM.ZLKXNBTFGORIJHAQ').symbols.join('')).toBe(
      'EPSDUCVWYM.ZLKXNBTFGORIJHAQ',
    );
    expect(trifidGrid('.', '.ab').symbols.slice(0, 3)).toEqual(['.', 'A', 'B']);
  });

  it('numbers the cells: row and column in a square, layer, row, column in a cube', () => {
    const sq = coordinatesOf(bifidGrid('ij', WIKI_KEY));
    expect(sq.get('B')).toEqual([0, 0]);
    expect(sq.get('F')).toEqual([3, 0]);
    expect(sq.get('R')).toEqual([4, 4]);
    const cube = coordinatesOf(trifidGrid('+', ''));
    expect(cube.get('A')).toEqual([0, 0, 0]);
    expect(cube.get('J')).toEqual([1, 0, 0]);
    expect(cube.get('+')).toEqual([2, 2, 2]);
  });

  it('cuts a text into blocks of the period, the last one shorter; 0 is one block', () => {
    expect(blockSizes(10, 5)).toEqual([5, 5]);
    expect(blockSizes(11, 5)).toEqual([5, 5, 1]);
    expect(blockSizes(10, 0)).toEqual([10]);
    expect(blockSizes(10, 10)).toEqual([10]);
    expect(blockSizes(10, 50)).toEqual([10]);
    expect(blockSizes(0, 5)).toEqual([]);
  });
});

describe('round trips', () => {
  const rng = makeRng(77);
  const word = (n: number, alphabet: string) =>
    Array.from({ length: n }, () => alphabet[Math.floor(rng() * alphabet.length)]!).join('');
  const periods = [0, 1, 2, 3, 5, 7, 13, 50, 400];

  const squares: [SquareKind, string][] = [
    ['ij', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'],
    ['q', 'ABCDEFGHIJKLMNOPRSTUVWXYZ'],
    ['digits', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'],
  ];
  for (const [kind, alphabet] of squares) {
    it(`Bifid on a ${kind} square, every period`, () => {
      for (let n = 0; n < 4; n++) {
        const plain = toSymbols(kind, word(30 + Math.floor(rng() * 120), alphabet)).symbols;
        const grid = bifidGrid(kind, word(1 + Math.floor(rng() * 12), alphabet));
        for (const p of periods) {
          const enc = fractionate(grid, plain, p, 'encrypt');
          const dec = fractionate(grid, [...joinBlocks(enc)], p, 'decrypt');
          expect(joinBlocks(dec)).toBe(plain.join(''));
        }
      }
    });
  }

  it('Trifid with a 27th symbol, every period', () => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ+';
    for (let n = 0; n < 4; n++) {
      const plain = [...word(30 + Math.floor(rng() * 120), alphabet)];
      const grid = trifidGrid('+', word(1 + Math.floor(rng() * 14), alphabet));
      for (const p of periods) {
        const enc = fractionate(grid, plain, p, 'encrypt');
        const dec = fractionate(grid, [...joinBlocks(enc)], p, 'decrypt');
        expect(joinBlocks(dec)).toBe(plain.join(''));
      }
    }
  });

  it('period 1 changes nothing, a period past the length is the whole message', () => {
    const grid = bifidGrid('ij', WIKI_KEY);
    const plain = sym('ATTACKATDAWN');
    expect(joinBlocks(fractionate(grid, plain, 1, 'encrypt'))).toBe('ATTACKATDAWN');
    expect(joinBlocks(fractionate(grid, plain, 99, 'encrypt'))).toBe(
      joinBlocks(fractionate(grid, plain, 0, 'encrypt')),
    );
    expect(
      resultToText(run('attackatdawn', { mode: 'encrypt', key: WIKI_KEY, period: 1 })),
    ).toContain('Period 1 cuts the text into single letters');
  });

  it('the tool round-trips prose, with spaces and punctuation dropped', () => {
    const prose = PROSE_A.slice(0, 300);
    for (const cipher of ['bifid', 'trifid'] as const) {
      for (const period of [0, 6, 11]) {
        const enc = textOf(
          run(prose, { cipher, mode: 'encrypt', key: 'lighthouse', period }),
          'Ciphertext',
        );
        const dec = textOf(run(enc, { cipher, key: 'lighthouse', period }), 'Plaintext');
        const letters = prose.replace(/[^A-Za-z]/g, '').toUpperCase();
        expect(dec).toBe(cipher === 'bifid' ? letters.replace(/J/g, 'I') : letters);
      }
    }
  });
});

describe('the coordinates rows', () => {
  it('shows the rows and columns of every block, and what is read from them', () => {
    const out = run('FLEEATONCE', { mode: 'encrypt', key: WIKI_KEY });
    const t = tableOf(out, 'Coordinates');
    expect(t.columns).toEqual(['#', 'Plaintext', 'Rows', 'Columns', 'Read in pairs', 'Ciphertext']);
    expect(t.rows).toEqual([
      [1, 'FLEEATONCE', '4433353243', '1355312325', '44 33 35 32 43 13 55 31 23 25', 'UAEOLWRINS'],
    ]);
    const blocks = tableOf(
      run('FLEEATONCE', { mode: 'encrypt', key: WIKI_KEY, period: 5 }),
      'Coordinates',
    );
    expect(blocks.rows.map((r) => r[2])).toEqual(['44333', '53243']);
  });

  it('shows decryption the other way round: the ciphertext coordinates, then the split lines', () => {
    const t = tableOf(run('UAEOLWRINS', { key: WIKI_KEY }), 'Coordinates');
    expect(t.columns).toEqual(['#', 'Ciphertext', 'Read in pairs', 'Rows', 'Columns', 'Plaintext']);
    expect(t.rows[0]).toEqual([
      1,
      'UAEOLWRINS',
      '44 33 35 32 43 13 55 31 23 25',
      '4433353243',
      '1355312325',
      'FLEEATONCE',
    ]);
  });

  it('Trifid has layers, rows and columns, read in triples', () => {
    const out = run('AIDETOILECIELTAIDERA', {
      cipher: 'trifid',
      mode: 'encrypt',
      key: 'FELIXMARIEDELASTELLE',
      period: 5,
    });
    const t = tableOf(out, 'Coordinates');
    expect(t.columns).toEqual([
      '#',
      'Plaintext',
      'Layers',
      'Rows',
      'Columns',
      'Read in triples',
      'Ciphertext',
    ]);
    expect(t.rows).toHaveLength(4);
    // Each line has one coordinate (1 to 3) per letter of the block.
    for (const r of t.rows) {
      for (const col of [2, 3, 4]) expect(String(r[col])).toMatch(/^[1-3]{5}$/);
    }
    expect(t.rows[0]![6]).toBe('FMJFV');
    const cube = tableOf(out, 'Key cube');
    expect(cube.rows).toHaveLength(9);
    expect(cube.columns).toEqual(['Layer', 'Row', '1', '2', '3']);
    expect(cube.rows[0]).toEqual(['1', '1', 'F', 'E', 'L']);
  });

  it('shows the square with its row and column numbers', () => {
    const sq = tableOf(run('FLEEATONCE', { key: WIKI_KEY }), 'Key square');
    expect(sq.columns).toEqual(['', '1', '2', '3', '4', '5']);
    expect(sq.rows[3]).toEqual(['4', 'F', 'C', 'L', 'U', 'M']);
  });

  it('caps the table and cuts long lines, while the result stays complete', () => {
    const long = PROSE_A.repeat(10);
    const out = run(long, { mode: 'encrypt', key: 'k', period: 0 });
    const letters = long.replace(/[^A-Za-z]/g, '').length;
    expect(textOf(out, 'Ciphertext')).toHaveLength(letters);
    const t = tableOf(out, 'Coordinates');
    expect(String(t.rows[0]![2]).length).toBeLessThanOrEqual(161);
    expect(resultToText(out)).toContain('Long lines are cut to 160 characters');
    const many = run('A'.repeat(500), { mode: 'encrypt', key: 'k', period: 2 });
    const part = tableOf(many, 'Coordinates');
    expect(part.rows).toHaveLength(100);
    expect(part.label).toContain('first 100 of 250');
  });

  it('handles a very long message without freezing', () => {
    const big = 'THEQUICKBROWNFOXJUMPSOVERTHELAZYDOG'.repeat(4000);
    const t0 = performance.now();
    const enc = textOf(run(big, { mode: 'encrypt', key: 'k', period: 0 }), 'Ciphertext');
    const dec = textOf(run(enc, { key: 'k', period: 0 }), 'Plaintext');
    expect(dec).toBe(big.replace(/J/g, 'I'));
    expect(performance.now() - t0).toBeLessThan(10_000);
  });
});

describe('the text and the options', () => {
  it('reads J as I, leaves Q out of the no-Q square, keeps digits in the 6 x 6 one', () => {
    expect(resultToText(run('JUMP', { mode: 'encrypt', key: 'k' }))).toContain(
      'J read as I (the square has 25 cells): 1',
    );
    expect(resultToText(run('quick', { mode: 'encrypt', key: 'k', square: 'q' }))).toContain(
      'Q has no place in this square: 1 left out',
    );
    const six = run('Meet at 9', { mode: 'encrypt', key: 'k', square: 'digits' });
    expect(
      textOf(run(textOf(six, 'Ciphertext'), { key: 'k', square: 'digits' }), 'Plaintext'),
    ).toBe('MEETAT9');
    expect(resultToText(run('Meet at 9', { mode: 'encrypt', key: 'k' }))).toContain(
      'Digits have no place in this grid: 1 left out',
    );
  });

  it('Trifid: the 27th symbol is part of the text and of the key, any other character is not', () => {
    const out = run('meet+at+the+bridge', {
      cipher: 'trifid',
      mode: 'encrypt',
      key: 'lighthouse',
    });
    expect(textOf(out, 'Ciphertext')).toBe('ASUGKA+KMNLCNKMEME');
    expect(
      textOf(run('ASUGKA+KMNLCNKMEME', { cipher: 'trifid', key: 'lighthouse' }), 'Plaintext'),
    ).toBe('MEET+AT+THE+BRIDGE');
    // With "." as the 27th symbol, "+" is just a dropped character.
    const dot = run('meet+at.the', { cipher: 'trifid', mode: 'encrypt', key: 'k', symbol: '.' });
    expect(resultToText(dot)).toContain('Characters outside the alphabet were ignored: 1');
    expect(() => run('abc', { cipher: 'trifid', symbol: 'x' })).toThrow(/27th symbol/);
    expect(() => run('abc', { cipher: 'trifid', symbol: '' })).toThrow(ToolError);
    // A digit is fine as the 27th symbol.
    expect(
      textOf(run('a0b', { cipher: 'trifid', mode: 'encrypt', symbol: '0' }), 'Ciphertext'),
    ).toHaveLength(3);
  });

  it('groups the output in blocks of five', () => {
    const out = run('Defend the east wall of the castle', {
      mode: 'encrypt',
      key: PC_KEY,
      period: 5,
      groups: 'fives',
    });
    expect(textOf(out, 'Ciphertext')).toBe('FFYHM KHYCP LIASH ADTRL HCCHL BLR');
  });

  it('refuses an empty text and a bad period, with the way out', () => {
    expect(() => run('123 !?', { key: 'k' })).toThrow(/letters/);
    expect(() => run('abc', { period: -1 })).toThrow(/whole number/);
    expect(() => run('abc', { period: Number.NaN })).toThrow(ToolError);
    // A decimal period is floored, as the number box would let it through.
    expect(
      textOf(run('FLEEATONCE', { mode: 'encrypt', key: WIKI_KEY, period: 5.9 }), 'Ciphertext'),
    ).toBe('UAIEYYDINS');
  });

  it('notes the blocks it made', () => {
    expect(
      resultToText(run('FLEEATONCE', { mode: 'encrypt', key: WIKI_KEY, period: 5 })),
    ).toContain('Cut into blocks of 5 letters (number of blocks: 2)');
  });
});

describe('Find the period', () => {
  const grid = bifidGrid('ij', 'lighthouse');
  const plain = toSymbols('ij', PROSE_B.slice(0, 400)).symbols;

  it('finds the period of a message whose key is known', () => {
    for (const period of [0, 4, 7, 12]) {
      const cipher = joinBlocks(fractionate(grid, plain, period, 'encrypt'));
      const out = run(cipher, { mode: 'periods', key: 'lighthouse' });
      expect(textOf(out, 'Best guess')).toBe(plain.join(''));
      const t = tableOf(out, 'Periods');
      expect(String(t.rows[0]![0])).toBe(period === 0 ? 'whole message' : String(period));
      expect(t.highlight).toEqual([0]);
      const actions = out.find((o) => o.type === 'actions') as Extract<Output, { type: 'actions' }>;
      expect(actions.actions[0]!.options).toEqual({ mode: 'decrypt', period });
    }
  });

  it('works for Trifid too, and lists at most a dozen candidates', () => {
    const cube = trifidGrid('+', 'lighthouse');
    const letters = [...plain.join('')];
    const cipher = joinBlocks(fractionate(cube, letters, 9, 'encrypt'));
    const out = run(cipher, { mode: 'periods', cipher: 'trifid', key: 'lighthouse' });
    expect(textOf(out, 'Best guess')).toBe(letters.join(''));
    expect(tableOf(out, 'Periods').rows.length).toBeLessThanOrEqual(12);
  });

  it('says it is scored for English, and still answers with the wrong key', () => {
    const out = run(joinBlocks(fractionate(grid, plain, 7, 'encrypt')), {
      mode: 'periods',
      key: 'another key',
    });
    expect(resultToText(out)).toContain('ranked by how much they read like English');
    expect(textOf(out, 'Best guess')).not.toBe(plain.join(''));
  });

  it('copes with a very short ciphertext', () => {
    const out = run('UAEOLW', { mode: 'periods', key: WIKI_KEY });
    expect(tableOf(out, 'Periods').rows.length).toBeGreaterThan(0);
    expect(() => run('A', { mode: 'periods' })).not.toThrow();
  });
});
