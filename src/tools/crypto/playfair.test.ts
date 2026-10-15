import { describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors';
import { resultToText } from '../../core/result-text';
import type { Output, ToolResult } from '../../core/types';
import { makeRng } from './_classical';
import { frenchQuadTable } from './_fitness-fr';
import { buildLayout, crypt, pairsOf, pairUp, stripFiller, type Variant } from './_playfair';
import {
  canonicalSquare,
  isPlausible,
  readableSquare,
  solvePlayfair,
  SEARCH_LETTERS,
} from './_playfair-solve';
import { PROSE_A, PROSE_B } from './_sample-text';
import { keyedSquare, shortestKeyword, toSymbols, type SquareKind } from './_square';
import tool from './playfair';

type Opts = Parameters<typeof tool.run>[1];
const DEFAULTS: Opts = {
  mode: 'decrypt',
  variant: 'playfair',
  key: '',
  key2: '',
  square: 'ij',
  filler: 'X',
  groups: 'none',
  swap: false,
  tidy: false,
  language: 'english',
  effort: 'quick',
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

/** Encrypt letters with Playfair (the real preparation rules), returning the ciphertext. */
function playfair(plain: string, key: string, kind: SquareKind = 'ij', filler = 'X'): string {
  const { pairs } = pairUp(toSymbols(kind, plain).symbols, 'playfair', kind, filler);
  return crypt(buildLayout('playfair', kind, key, ''), 'encrypt', pairs)
    .map((d) => d.output)
    .join('');
}

const letters = (s: string) => s.replace(/[^A-Za-z]/g, '').toUpperCase();

describe('published test vectors', () => {
  it('Playfair, Wikipedia: key "playfair example", "Hide the gold in the tree stump"', () => {
    const out = run('Hide the gold in the tree stump', {
      mode: 'encrypt',
      key: 'playfair example',
    });
    expect(textOf(out, 'Ciphertext')).toBe('BMODZBXDNABEKUDMUIXMMOUVIF');
    expect(textOf(out, 'Prepared')).toBe('HI DE TH EG OL DI NT HE TR EX ES TU MP');
    const back = run('BMODZBXDNABEKUDMUIXMMOUVIF', { key: 'playfair example' });
    expect(textOf(back, 'Plaintext')).toBe('HIDETHEGOLDINTHETREXESTUMP');
  });

  it('Playfair, textbook (Stallings): key MONARCHY, BALLOON -> BA LX LO ON -> IB SU PM NA', () => {
    const out = run('balloon', { mode: 'encrypt', key: 'monarchy' });
    expect(textOf(out, 'Prepared')).toBe('BA LX LO ON');
    expect(textOf(out, 'Ciphertext')).toBe('IBSUPMNA');
    expect(textOf(run('IBSUPMNA', { key: 'monarchy' }), 'Plaintext')).toBe('BALXLOON');
  });

  it('four-square, Wikipedia: keys "example" and "keyword", HE -> FY', () => {
    const layout = buildLayout('four-square', 'ij', 'example', 'keyword');
    const [d] = crypt(layout, 'encrypt', ['HE']);
    expect(d!.output).toBe('FY');
    expect(d!.rule).toBe('rectangle');
    const out = run('HELPMEOBIWANKENOBI', {
      mode: 'encrypt',
      variant: 'four-square',
      key: 'example',
      key2: 'keyword',
    });
    // The other pairs were worked by hand from the same squares (see the reference below).
    expect(textOf(out, 'Ciphertext')).toBe('FYNFNEHWBXAFFOKHMD');
  });
});

/**
 * Reference implementations written separately from _playfair.ts: the squares are laid out as
 * one grid of strings and the letters are located by scanning it.
 */
const A5 = 'ABCDEFGHIKLMNOPQRSTUVWXYZ';
const sq5 = (key: string): string[][] => {
  const s = keyedSquare('ij', key);
  return [0, 1, 2, 3, 4].map((r) => s.slice(r * 5, r * 5 + 5));
};
function find(grid: string[][], ch: string): [number, number] {
  for (let r = 0; r < grid.length; r++) {
    const c = grid[r]!.indexOf(ch);
    if (c >= 0) return [r, c];
  }
  throw new Error(`${ch} not in the grid`);
}

function referenceFourSquare(pairs: string[], k1: string, k2: string): string {
  const plain = sq5('');
  const topRight = sq5(k1);
  const bottomLeft = sq5(k2);
  return pairs
    .map((p) => {
      const [r1, c1] = find(plain, p[0]!);
      const [r2, c2] = find(plain, p[1]!);
      return topRight[r1]![c2]! + bottomLeft[r2]![c1]!;
    })
    .join('');
}

function referenceTwoSquareSideBySide(pairs: string[], k1: string, k2: string): string {
  // One 5 x 10 table: left half key 1, right half key 2, so "same row" is literally one row.
  const left = sq5(k1);
  const right = sq5(k2);
  const table = left.map((row, r) => [...row, ...right[r]!]);
  const findIn = (ch: string, from: number, to: number): [number, number] => {
    for (let r = 0; r < table.length; r++) {
      const c = table[r]!.slice(from, to).indexOf(ch);
      if (c >= 0) return [r, from + c];
    }
    throw new Error(`${ch} not found`);
  };
  return pairs
    .map((p) => {
      const [r1, c1] = findIn(p[0]!, 0, 5); // the first letter is read in the left half
      const [r2, c2] = findIn(p[1]!, 5, 10); // the second letter in the right half
      // First ciphertext letter: first letter's row, second letter's column (right half).
      return table[r1]![c2]! + table[r2]![c1]!;
    })
    .join('');
}

function referenceTwoSquareStacked(pairs: string[], k1: string, k2: string): string {
  const table = [...sq5(k1), ...sq5(k2)]; // 10 rows x 5 columns
  const findIn = (ch: string, from: number, to: number): [number, number] => {
    for (let r = from; r < to; r++) {
      const c = table[r]!.indexOf(ch);
      if (c >= 0) return [r, c];
    }
    throw new Error(`${ch} not found`);
  };
  return pairs
    .map((p) => {
      const [r1, c1] = findIn(p[0]!, 0, 5); // the first letter is read in the top half
      const [r2, c2] = findIn(p[1]!, 5, 10); // the second letter in the bottom half
      // First ciphertext letter: the first letter's column, on the second letter's row.
      return table[r2]![c1]! + table[r1]![c2]!;
    })
    .join('');
}

describe('the squares and the rules', () => {
  const pairs = ['HE', 'LP', 'ME', 'OB', 'IW', 'AN', 'KE', 'NO', 'BI', 'QZ', 'ZA', 'AZ'];

  it('four-square agrees with a reference implementation', () => {
    const got = crypt(buildLayout('four-square', 'ij', 'example', 'keyword'), 'encrypt', pairs);
    expect(got.map((d) => d.output).join('')).toBe(
      referenceFourSquare(pairs, 'example', 'keyword'),
    );
  });

  it('two-square (side by side) agrees with a reference implementation', () => {
    const cipher = crypt(
      buildLayout('two-horizontal', 'ij', 'example', 'keyword'),
      'encrypt',
      pairs,
    );
    expect(cipher.map((d) => d.output).join('')).toBe(
      referenceTwoSquareSideBySide(pairs, 'example', 'keyword'),
    );
  });

  it('two-square (stacked) agrees with a reference implementation', () => {
    const cipher = crypt(buildLayout('two-vertical', 'ij', 'example', 'keyword'), 'encrypt', pairs);
    expect(cipher.map((d) => d.output).join('')).toBe(
      referenceTwoSquareStacked(pairs, 'example', 'keyword'),
    );
  });

  it('two-square swaps the letters when both are on one line, else takes the rectangle', () => {
    const h = buildLayout('two-horizontal', 'ij', 'example', 'keyword');
    // M is on row 1 of the left square, E on row 1 of the right one: same row.
    expect(crypt(h, 'encrypt', ['ME'])[0]).toMatchObject({ output: 'EM', rule: 'swap-row' });
    const v = buildLayout('two-vertical', 'ij', 'example', 'keyword');
    expect(crypt(v, 'encrypt', ['HE'])[0]).toMatchObject({ output: 'EH', rule: 'swap-column' });
  });

  it('Playfair rules: row to the right, column down, rectangle; wrapping at the edges', () => {
    const layout = buildLayout('playfair', 'ij', 'monarchy', '');
    expect(crypt(layout, 'encrypt', ['ON'])[0]).toMatchObject({ output: 'NA', rule: 'row' });
    expect(crypt(layout, 'encrypt', ['NR'])[0]).toMatchObject({ output: 'AM', rule: 'row' }); // wraps
    expect(crypt(layout, 'encrypt', ['BA'])[0]).toMatchObject({ output: 'IB', rule: 'column' });
    expect(crypt(layout, 'encrypt', ['RZ'])[0]).toMatchObject({ output: 'DR', rule: 'column' }); // wraps
    expect(crypt(layout, 'encrypt', ['LX'])[0]).toMatchObject({ output: 'SU', rule: 'rectangle' });
    expect(crypt(layout, 'decrypt', ['NA'])[0]).toMatchObject({ output: 'ON', rule: 'row' });
  });

  it('builds keyed squares: key letters first, J as I, the rest in order', () => {
    expect(keyedSquare('ij', 'Zebra Jungle').join('')).toBe('ZEBRAIUNGLCDFHKMOPQSTVWXY');
    expect(keyedSquare('q', 'quartz').join('')).toBe('UARTZBCDEFGHIJKLMNOPSVWXY');
    expect(keyedSquare('digits', 'a1b2').join('')).toBe(`A1B2CDEFGHIJKLMNOPQRSTUVWXYZ03456789`);
    expect(keyedSquare('ij', '').join('')).toBe(A5);
    expect(shortestKeyword('ij', keyedSquare('ij', 'monarchy'))).toBe('MONARCHY');
    expect(shortestKeyword('ij', [...'ZZ'])).toBeNull();
  });
});

describe('round trips', () => {
  const rng = makeRng(2024);
  const word = (n: number, alphabet: string) =>
    Array.from({ length: n }, () => alphabet[Math.floor(rng() * alphabet.length)]!).join('');
  const variants: Variant[] = ['playfair', 'two-horizontal', 'two-vertical', 'four-square'];
  const kinds: SquareKind[] = ['ij', 'q', 'digits'];

  for (const variant of variants) {
    for (const kind of kinds) {
      it(`${variant} on a ${kind} square: decrypt(encrypt(x)) = x`, () => {
        const alphabet =
          kind === 'digits' ? 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' : 'ABCDEFGHIJKLMNOPRSTUVWXYZ';
        for (let n = 0; n < 6; n++) {
          const plain = word(20 + Math.floor(rng() * 80), alphabet);
          const k1 = word(1 + Math.floor(rng() * 9), alphabet);
          const k2 = word(1 + Math.floor(rng() * 9), alphabet);
          const symbols = toSymbols(kind, plain).symbols;
          const { pairs } = pairUp(symbols, variant, kind, 'X');
          const layout = buildLayout(variant, kind, k1, k2);
          for (const swapped of [false, true]) {
            const cipher = crypt(layout, 'encrypt', pairs, swapped).map((d) => d.output);
            const back = crypt(layout, 'decrypt', cipher, swapped).map((d) => d.output);
            expect(back).toEqual(pairs);
          }
        }
      });
    }
  }

  it('the tool round-trips text with spaces, case and punctuation', () => {
    const plain = 'Meet me at the old bridge at midnight, bring the lanterns!';
    for (const variant of variants) {
      const enc = textOf(
        run(plain, { mode: 'encrypt', variant, key: 'lantern', key2: 'bridge' }),
        'Ciphertext',
      );
      const dec = textOf(run(enc, { variant, key: 'lantern', key2: 'bridge' }), 'Plaintext');
      // Fillers (X) may have been added; without them the letters are the message.
      expect(dec.replace(/X/g, '')).toBe(letters(plain).replace(/J/g, 'I').replace(/X/g, ''));
    }
  });
});

describe('doubled letters, odd length and the filler', () => {
  it('splits a double with the filler and starts the next pair on the second letter', () => {
    const { pairs, split, padding } = pairUp([...'BALLOON'], 'playfair', 'ij', 'X');
    expect(pairs).toEqual(['BA', 'LX', 'LO', 'ON']);
    expect(split).toEqual([{ pair: 1, letter: 'L', filler: 'X' }]);
    expect(padding).toBeNull();
  });

  it('pads an odd length with the filler, and says which letter it follows', () => {
    const { pairs, padding } = pairUp([...'ABC'], 'playfair', 'ij', 'X');
    expect(pairs).toEqual(['AB', 'CX']);
    expect(padding).toEqual({ filler: 'X', after: 'C' });
    expect(pairUp([...'ABC'], 'four-square', 'ij', 'Z').pairs).toEqual(['AB', 'CZ']);
  });

  it('never makes a pair of equal letters out of a doubled filler or a trailing filler', () => {
    expect(pairUp([...'XXAB'], 'playfair', 'ij', 'X').pairs).toEqual(['XQ', 'XA', 'BX']);
    expect(pairUp([...'ABX'], 'playfair', 'ij', 'X').pairs).toEqual(['AB', 'XQ']);
    // Without Q in the square, the alternative is Z.
    expect(pairUp([...'XXAB'], 'playfair', 'q', 'X').pairs).toEqual(['XZ', 'XA', 'BX']);
    expect(pairUp([...'ZZ'], 'playfair', 'ij', 'Z').pairs).toEqual(['ZX', 'ZX']);
  });

  it('does not split doubles for the two-square and four-square ciphers', () => {
    expect(pairUp([...'BALLOON'], 'four-square', 'ij', 'X').pairs).toEqual([
      'BA',
      'LL',
      'OO',
      'NX',
    ]);
  });

  it('reports the split and the padding in the notes', () => {
    const out = resultToText(run('balloon', { mode: 'encrypt', key: 'monarchy' }));
    expect(out).toContain('LL → LXL');
    const odd = resultToText(run('abc', { mode: 'encrypt', key: 'k', filler: 'z' }));
    expect(odd).toContain('the filler Z was added after the last letter C');
  });

  it('removes the filler on request, between equal letters and at the end', () => {
    expect(stripFiller([...'HIDXDENLOXOKXE'], 'X').join('')).toBe('HIDDENLOOKXE');
    expect(stripFiller([...'ATTACKX'], 'X').join('')).toBe('ATTACK');
    expect(stripFiller([...'X'], 'X').join('')).toBe('X');
    const out = run('BMODZBXDNABEKUDMUIXMMOUVIF', { key: 'playfair example', tidy: true });
    expect(textOf(out, 'without the filler')).toBe('HIDETHEGOLDINTHETREESTUMP');
  });

  it('a filler that is not in the square is an error, with the way out', () => {
    expect(() => run('hello', { mode: 'encrypt', key: 'k', filler: '?' })).toThrow(/filler “\?”/);
    expect(() => run('hello', { mode: 'encrypt', key: 'k', filler: 'q', square: 'q' })).toThrow(
      ToolError,
    );
    // J is I in the classical square, so J is a fine filler there.
    expect(textOf(run('abc', { mode: 'encrypt', key: 'k', filler: 'j' }), 'Prepared')).toBe(
      'AB CI',
    );
  });
});

describe('what the text may contain', () => {
  it('reads J as I and says so', () => {
    const a = run('JUMP', { mode: 'encrypt', key: 'k' });
    const b = run('IUMP', { mode: 'encrypt', key: 'k' });
    expect(textOf(a, 'Ciphertext')).toBe(textOf(b, 'Ciphertext'));
    expect(resultToText(a)).toContain('J read as I (the square has 25 cells): 1');
  });

  it('leaves Q out of the no-Q square, keeps J, and says so', () => {
    const out = run('quick jump', { mode: 'encrypt', key: 'k', square: 'q' });
    expect(textOf(out, 'Prepared')).toBe('UI CK JU MP');
    expect(resultToText(out)).toContain('Q has no place in this square: 1 left out');
  });

  it('keeps digits in the 6 x 6 square and drops them in the 5 x 5 one', () => {
    const six = run('Meet at 9', { mode: 'encrypt', key: 'k', square: 'digits' });
    expect(textOf(six, 'Prepared')).toBe('ME ET AT 9X');
    const five = run('Meet at 9', { mode: 'encrypt', key: 'k' });
    expect(textOf(five, 'Prepared')).toBe('ME ET AT');
    expect(resultToText(five)).toContain('A 5 × 5 square has no digits: 1 left out');
    expect(
      textOf(run(textOf(six, 'Ciphertext'), { key: 'k', square: 'digits' }), 'Plaintext'),
    ).toBe('MEETAT9X');
  });

  it('works with an empty key (the plain alphabet) and says so', () => {
    const out = run('hello', { mode: 'encrypt' });
    expect(resultToText(out)).toContain('The key has no usable letters');
    expect(textOf(out, 'Ciphertext')).toBe(playfair('hello', ''));
  });

  it('accepts a whole square as the key', () => {
    const square = 'BGWKZQPNDSIOAXEFCLUMTHYVR';
    expect(textOf(run('hello', { mode: 'encrypt', key: square }), 'Ciphertext')).toBe(
      playfair('hello', square),
    );
    // Spaces, digits and repeated letters in a key are ignored.
    expect(textOf(run('hello', { mode: 'encrypt', key: 'b-g w k z q 12 pnn' }), 'Ciphertext')).toBe(
      playfair('hello', 'BGWKZQPN'),
    );
  });

  it('refuses a text with nothing to encrypt', () => {
    expect(() => run('1234 !?', { mode: 'encrypt', key: 'k' })).toThrow(/letters/);
    expect(() => run('', { key: 'k' })).toThrow(ToolError);
  });

  it('groups the output in pairs or blocks of five', () => {
    const pairs = run('Hide the gold in the tree stump', {
      mode: 'encrypt',
      key: 'playfair example',
      groups: 'pairs',
    });
    expect(textOf(pairs, 'Ciphertext')).toBe('BM OD ZB XD NA BE KU DM UI XM MO UV IF');
    const fives = run('Hide the gold in the tree stump', {
      mode: 'encrypt',
      key: 'playfair example',
      groups: 'fives',
    });
    expect(textOf(fives, 'Ciphertext')).toBe('BMODZ BXDNA BEKUD MUIXM MOUVI F');
  });
});

describe('decrypting honestly', () => {
  it('leaves out the last letter of an odd ciphertext and warns', () => {
    const out = run('BMODZ', { key: 'playfair example' });
    expect(textOf(out, 'Plaintext')).toBe('HIDE');
    expect(resultToText(out)).toContain('odd number of letters (5)');
    expect(() => run('B', { key: 'k' })).toThrow(/single letter/);
  });

  it('warns about pairs of equal letters, which Playfair never produces', () => {
    const out = run('BMOODZ', { key: 'playfair example' });
    expect(resultToText(out)).toContain('Pairs with two equal letters: 1 (first: OO)');
    // The other ciphers have no such rule.
    const four = run('BMOODZ', { variant: 'four-square', key: 'a', key2: 'b' });
    expect(resultToText(four)).not.toContain('equal letters');
  });

  it('shows the squares and the working pair by pair, and caps a long working table', () => {
    const out = run('BMODZBXDNABEKUDMUIXMMOUVIF', { key: 'playfair example' });
    const table = out.find((o) => o.type === 'table' && o.rows.length === 13);
    expect(table).toBeDefined();
    const big = run('AB'.repeat(500), { mode: 'encrypt', key: 'k' });
    const working = big.find(
      (o): o is Extract<Output, { type: 'table' }> =>
        o.type === 'table' && (o.label ?? '').includes('Working'),
    )!;
    expect(working.rows).toHaveLength(150);
    expect(working.label).toContain('first 150 of 500');
    expect(textOf(big, 'Ciphertext')).toHaveLength(1000);
  });

  it('says how the two-square pairs are ordered, and swaps them on request', () => {
    const base = { variant: 'two-horizontal' as const, key: 'example', key2: 'keyword' };
    const plain = run('HELPMEOBIWANKENOBI', { ...base, mode: 'encrypt' });
    expect(resultToText(plain)).toContain('Swap the letters of each ciphertext pair');
    expect(textOf(plain, 'Ciphertext')).toBe('GXAOEMQLIAERGMLPBH');
    const swapped = run('HELPMEOBIWANKENOBI', { ...base, mode: 'encrypt', swap: true });
    expect(textOf(swapped, 'Ciphertext')).toBe('XGOAMELQAIREMGPLHB');
    expect(textOf(run('XGOAMELQAIREMGPLHB', { ...base, swap: true }), 'Plaintext')).toBe(
      'HELPMEOBIWANKENOBI',
    );
  });

  it('reads the plaintext as words when it can', () => {
    const out = run('BMODZBXDNABEKUDMUIXMMOUVIF', { key: 'playfair example' });
    expect(textOf(out, 'Words')).toMatch(/^HIDE THE GOLD IN THE TREE/);
  });
});

/** A random 25-letter square (the hardest kind of key: no keyword). */
function randomSquare(seed: number): string {
  const rng = makeRng(seed);
  const a = [...A5];
  for (let i = 24; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a.join('');
}
const codes = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) - 65);

/** Playfair-prepared plaintext (the letters that the right key must give back). */
const prepared = (text: string) =>
  pairUp(toSymbols('ij', text).symbols, 'playfair', 'ij', 'X').pairs.join('');

describe('key search', () => {
  it('recovers readable plaintext from ~300 letters of English under a random key', () => {
    const cases: [string, number][] = [
      [PROSE_A.slice(0, 380), 11],
      [PROSE_B.slice(0, 380), 12],
      [PROSE_B.slice(60, 440), 13],
    ];
    for (const [plain, seed] of cases) {
      const clean = prepared(plain);
      expect(clean.length).toBeGreaterThan(290);
      const cipher = playfair(plain, randomSquare(seed));
      const t0 = performance.now();
      const result = solvePlayfair(codes(cipher), { seed: 1, budget: 3_000_000 });
      const ms = performance.now() - t0;
      const best = result.candidates[0]!;
      expect(best.plain).toBe(clean);
      expect(result.converged).toBe(true);
      expect(best.fitness).toBeGreaterThan(-5);
      // Bounded work: far below the budget, and a generous wall-clock limit for a busy machine.
      expect(result.evaluations).toBeLessThan(3_000_000 + 60_000);
      expect(ms).toBeLessThan(20_000);
    }
  });

  it('is deterministic: the same ciphertext gives the same squares, scores and restarts', () => {
    const cipher = playfair(PROSE_A.slice(0, 380), randomSquare(21));
    const a = solvePlayfair(codes(cipher));
    const b = solvePlayfair(codes(cipher));
    expect(b).toEqual(a);
  });

  it('stops at the budget when the text is not Playfair, and does not claim a result', () => {
    const rng = makeRng(5);
    const noise = Array.from({ length: 300 }, () =>
      String.fromCharCode(65 + Math.floor(rng() * 26)),
    ).join('');
    const result = solvePlayfair(codes(noise.replace(/J/g, 'I')), { budget: 400_000 });
    expect(result.converged).toBe(false);
    expect(result.evaluations).toBeGreaterThanOrEqual(400_000);
    expect(result.evaluations).toBeLessThan(400_000 + 60_000);
    expect(result.candidates[0]!.fitness).toBeLessThan(-5);
    expect(isPlausible(result.candidates[0]!.fitness, 300)).toBe(false);
  });

  it('returns the keyword when the key was a keyword square', () => {
    const plain = PROSE_A.slice(0, 380);
    const result = solvePlayfair(codes(playfair(plain, 'forged steel')), { seed: 3 });
    const best = result.candidates[0]!;
    expect(best.plain).toBe(prepared(plain));
    expect(best.keyword).toBe('FORGEDSTL');
    expect(best.square).toBe(keyedSquare('ij', 'FORGEDSTL').join(''));
  });

  it('treats the 25 shifts of a square as one key', () => {
    const sq = randomSquare(8);
    const shifted = (dr: number, dc: number) => {
      const out = new Array<string>(25);
      for (let r = 0; r < 5; r++) {
        for (let c = 0; c < 5; c++) out[((r + dr) % 5) * 5 + ((c + dc) % 5)] = sq[r * 5 + c]!;
      }
      return out.join('');
    };
    const canon = canonicalSquare(sq);
    for (const [dr, dc] of [
      [1, 0],
      [0, 3],
      [4, 2],
    ] as const) {
      expect(canonicalSquare(shifted(dr, dc))).toBe(canon);
      // And they really are the same cipher.
      expect(playfair('Hide the gold in the tree stump', shifted(dr, dc))).toBe(
        playfair('Hide the gold in the tree stump', sq),
      );
    }
    // A random square is not a keyword square: a 20-letter "keyword" would say nothing.
    expect(readableSquare(sq, 'ij').keyword).toBeNull();
    const mon = keyedSquare('ij', 'monarchy').join('');
    expect(readableSquare(canonicalSquare(mon), 'ij')).toEqual({
      square: mon,
      keyword: 'MONARCHY',
    });
  });

  it('works on French with the French table, and says French', () => {
    const french =
      "Personne ne vous a donné la clé de ce message, alors l'ordinateur a essayé des milliers de " +
      'carrés, gardé ceux qui ressemblaient un peu plus à du français, puis remis les dernières ' +
      'lettres en place une à une. Quand les mots apparaissent enfin, il suffit de recopier la clé ' +
      "dans l'outil pour lire tous les autres messages écrits avec elle.";
    const folded = french.normalize('NFD').replace(/\p{M}/gu, '');
    const cipher = playfair(folded, 'cle rouge');
    const result = solvePlayfair(codes(cipher), { table: frenchQuadTable(), seed: 1 });
    expect(result.candidates[0]!.plain).toBe(prepared(folded));
    expect(result.converged).toBe(true);
    // The French table is derived from the project's own word list: no new corpus.
    expect(frenchQuadTable()).toBe(frenchQuadTable());
  });

  it('does not search more than it needs on long ciphertexts', () => {
    const long = (PROSE_A + PROSE_B + PROSE_A + PROSE_B).replace(/\s+/g, ' ');
    expect(long.length).toBeGreaterThan(2000);
    const cipher = playfair(long, randomSquare(33));
    const t0 = performance.now();
    const result = solvePlayfair(codes(cipher), { seed: 2 });
    expect(performance.now() - t0).toBeLessThan(20_000);
    expect(result.searched).toBe(SEARCH_LETTERS);
    expect(result.candidates[0]!.plain).toBe(prepared(long));
  });
});

describe('the tool in Find the key mode', () => {
  const plain = PROSE_B.slice(0, 380);
  const cipher = playfair(plain, 'lantern light');

  it('shows the plaintext, the key, the way to use it and the progress', () => {
    const out = run(cipher, { mode: 'solve', effort: 'normal' });
    const text = resultToText(out);
    expect(textOf(out, 'Plaintext with the key found')).toBe(prepared(plain));
    expect(text).toContain('The result reads like English');
    expect(text).toContain('Shortest keyword: LANTERIGH');
    expect(text).toContain('Fit:');
    const actions = out.find((o) => o.type === 'actions');
    expect(actions).toMatchObject({
      actions: [
        {
          options: {
            mode: 'decrypt',
            variant: 'playfair',
            key: keyedSquare('ij', 'lantern light').join(''),
          },
        },
      ],
    });
    // The key it offers decrypts the ciphertext in the tool itself.
    const key = (actions as Extract<Output, { type: 'actions' }>).actions[0]!.options.key as string;
    expect(textOf(run(cipher, { key }), 'Plaintext')).toBe(prepared(plain));
  });

  it('is deterministic and lists the best keys and every restart', () => {
    const a = resultToText(run(cipher, { mode: 'solve', effort: 'normal' }));
    const b = resultToText(run(cipher, { mode: 'solve', effort: 'normal' }));
    expect(b).toBe(a);
    expect(a).toContain('Best keys');
    expect(a).toContain('Restart');
  });

  it('refuses what it cannot do, with the way out', () => {
    expect(() => run(cipher, { mode: 'solve', variant: 'four-square' })).toThrow(/Playfair only/);
    expect(() => run(cipher, { mode: 'solve', square: 'digits' })).toThrow(/5 × 5/);
    expect(() => run('ABCDEFGHIK', { mode: 'solve' })).toThrow(/Too short to find a key/);
  });

  it('warns instead of claiming a key when the text is too short or not Playfair', () => {
    const shortCipher = playfair('the quick brown fox jumps over the lazy dog and runs', 'k');
    const out = resultToText(run(shortCipher, { mode: 'solve', effort: 'quick' }));
    expect(out).not.toContain('The result reads like English');
    expect(out).toContain('Short text');
    const rng = makeRng(9);
    const noise = Array.from(
      { length: 260 },
      () => 'ABCDEFGHIKLMNOPQRSTUVWXYZ'[Math.floor(rng() * 25)]!,
    ).join('');
    const failed = resultToText(run(noise, { mode: 'solve', effort: 'quick' }));
    expect(failed).toContain('No convincing English found');
    expect(failed).toContain('Best guess (not reliable)');
    expect(failed).toContain('Best key so far (not reliable)');
    // A nonsense plaintext is not split into "words".
    expect(failed).not.toContain('Words (guess');
  });

  it('flags pairs of equal letters, which a Playfair ciphertext cannot have', () => {
    const doubled = cipher.slice(0, 40) + 'EE' + cipher.slice(42);
    expect(resultToText(run(doubled, { mode: 'solve', effort: 'normal' }))).toContain(
      'equal letters',
    );
  });
});

describe('triage', () => {
  const detect = (text: string | null) => tool.detect!({ text, bytes: new Uint8Array() });

  it('suggests Playfair for an even-length ciphertext without J or doubled pairs', () => {
    const cipher = playfair(PROSE_A.slice(0, 300), 'forged steel');
    expect(detect(cipher)?.score).toBeGreaterThan(0.25);
    expect(detect(cipher.match(/.{1,5}/g)!.join(' '))).not.toBeNull();
  });

  it('stays quiet on plain text, short text, odd length and digits', () => {
    expect(
      detect('The quick brown fox jumps over the lazy dog, again and again and again.'),
    ).toBeNull();
    expect(detect('BMODZBXDNABEKUDMUIXMMOUVIF')).toBeNull();
    expect(detect(null)).toBeNull();
    expect(detect('AB'.repeat(40))).toBeNull();
    const cipher = playfair(PROSE_A.slice(0, 300), 'k');
    expect(detect(cipher + 'A')).toBeNull();
  });
});

describe('pairing helpers', () => {
  it('pairsOf keeps whole pairs and reports a leftover letter', () => {
    expect(pairsOf([...'ABCDE'])).toEqual({ pairs: ['AB', 'CD'], leftover: 'E' });
    expect(pairsOf([...'ABCD'])).toEqual({ pairs: ['AB', 'CD'], leftover: null });
  });
});
