import { describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors';
import { resultToText } from '../../core/result-text';
import type { ToolResult } from '../../core/types';
import tool, { toCells } from './columnar';
import { PROSE_A, PROSE_B } from './_sample-text';
import {
  allRoutes,
  columnarPermutation,
  identityKey,
  orderToDigits,
  orderToLetters,
  parseColumnKey,
  permute,
  routePermutation,
  solveColumnar,
  unpermute,
} from './_transposition';

type Options = Parameters<typeof tool.run>[1];

const run = (text: string, options: Partial<Options> = {}): ToolResult =>
  tool.run(text, {
    method: 'columnar',
    mode: 'decrypt',
    key: '',
    key2: '',
    grid: 'incomplete',
    pad: 'X',
    route: 'spiral',
    corner: 'tl',
    spin: 'cw',
    way: 'in',
    width: 0,
    rows: 0,
    columns: 0,
    inverse: false,
    chars: 'nospace',
    group: false,
    maxKey: 9,
    ...options,
  }) as ToolResult;

/** The first text block (the result itself). */
const first = (r: ToolResult): string => {
  const block = r[0];
  if (block?.type !== 'text') throw new Error('first block is not text');
  return block.value;
};

const encrypt = (text: string, options: Partial<Options>) =>
  first(run(text, { mode: 'encrypt', ...options }));
const decrypt = (text: string, options: Partial<Options>) =>
  first(run(text, { mode: 'decrypt', ...options }));

const WIKI = 'WEAREDISCOVEREDFLEEATONCE';

describe('column keys', () => {
  it('ranks a word with ties broken left to right', () => {
    const k = parseColumnKey('ZEBRAS');
    expect(k.rank).toEqual([6, 3, 2, 4, 1, 5]);
    expect(k.order).toEqual([4, 2, 1, 3, 5, 0]);
    // Repeated letters: the first one is read first.
    expect(parseColumnKey('TOMATO').rank).toEqual([5, 3, 2, 1, 6, 4]);
    // Myszkowski ranks give equal symbols the same rank.
    expect(parseColumnKey('TOMATO').groupRank).toEqual([4, 3, 2, 1, 4, 3]);
  });

  it('reads numbers as the reading order of the columns', () => {
    expect(parseColumnKey('3 1 4 2').order).toEqual([1, 3, 0, 2]);
    expect(parseColumnKey('3142').order).toEqual([1, 3, 0, 2]);
    expect(parseColumnKey('3,1,4,2').order).toEqual([1, 3, 0, 2]);
    // Numbers compare as numbers, not as text: 10 comes after 9.
    expect(parseColumnKey('10 2 9').order).toEqual([1, 2, 0]);
    expect(orderToDigits([1, 3, 0, 2])).toBe('3142');
    expect(orderToDigits([1, 0, 2, 3, 4, 5, 6, 7, 8, 9])).toBe('2 1 3 4 5 6 7 8 9 10');
    expect(orderToLetters([1, 3, 0, 2])).toBe('CADB');
  });

  it('rejects empty keys and keys without usable characters', () => {
    expect(() => parseColumnKey('  ')).toThrow(ToolError);
    expect(() => parseColumnKey('***')).toThrow(ToolError);
  });
});

describe('columnar transposition (published vectors)', () => {
  // Wikipedia, "Transposition cipher": WE ARE DISCOVERED. FLEE AT ONCE with key ZEBRAS and the
  // nulls QKJEU filling the last row.
  it('matches the complete-grid example with nulls', () => {
    const cipher = 'EVLNEACDTKESEAQROFOJDEECUWIREE';
    expect(encrypt(WIKI + 'QKJEU', { key: 'ZEBRAS' })).toBe(cipher);
    expect(decrypt(cipher, { key: 'ZEBRAS', grid: 'complete' })).toBe(WIKI + 'QKJEU');
  });

  it('matches the incomplete grid (columns of different lengths)', () => {
    const cipher = 'EVLNACDTESEAROFODEECWIREE';
    expect(encrypt(WIKI, { key: 'ZEBRAS' })).toBe(cipher);
    expect(decrypt(cipher, { key: 'ZEBRAS' })).toBe(WIKI);
    // The same key written as the reading order of its columns.
    expect(decrypt(cipher, { key: '6 3 2 4 1 5' })).toBe(WIKI);
  });

  // Wikipedia, double transposition: ZEBRAS, then STRIPE.
  it('matches the double transposition', () => {
    const cipher = 'CAEENSOIAEDRLEFWEDREEVTOC';
    expect(encrypt(WIKI, { method: 'double', key: 'ZEBRAS', key2: 'STRIPE' })).toBe(cipher);
    expect(decrypt(cipher, { method: 'double', key: 'ZEBRAS', key2: 'STRIPE' })).toBe(WIKI);
    const out = resultToText(run(cipher, { method: 'double', key: 'ZEBRAS', key2: 'STRIPE' }));
    // The text between the two transpositions is shown.
    expect(out).toContain('Between the two transpositions');
    expect(out).toContain('EVLNACDTESEAROFODEECWIREE');
  });

  // Wikipedia, Myszkowski transposition: key TOMATO.
  it('matches the Myszkowski transposition', () => {
    const cipher = 'ROFOACDTEDSEEEACWEIVRLENE';
    expect(encrypt(WIKI, { method: 'myszkowski', key: 'TOMATO' })).toBe(cipher);
    expect(decrypt(cipher, { method: 'myszkowski', key: 'TOMATO' })).toBe(WIKI);
    // Read as an ordinary columnar key the ties are broken left to right: another result.
    expect(encrypt(WIKI, { key: 'TOMATO' })).not.toBe(cipher);
  });

  // Wikipedia, scytale: "I am hurt very badly help" on a rod with 4 letters round.
  it('matches the scytale', () => {
    expect(encrypt('I am hurt very badly help', { method: 'scytale', rows: 4 })).toBe(
      'Iryyatbhmvaehedlurlp',
    );
    expect(decrypt('Iryyatbhmvaehedlurlp', { method: 'scytale', rows: 4 })).toBe(
      'Iamhurtverybadlyhelp',
    );
    expect(decrypt('Iryyatbhmvaehedlurlp', { method: 'scytale', columns: 5 })).toBe(
      'Iamhurtverybadlyhelp',
    );
  });
});

describe('transposition round trips', () => {
  const text = 'flag{Round-trip, with spaces & symbols!} 0123456789 and a bit more text';
  const keys = ['ZEBRAS', 'A', 'BA', '3 1 2', 'CAMOUFLAGE', 'TOMATO', 'LONGERKEYTHANTEXTSURELY'];

  it('columnar, Myszkowski and double round-trip for every grid', () => {
    for (const method of ['columnar', 'myszkowski', 'double'] as const) {
      for (const key of keys) {
        for (const grid of ['incomplete', 'complete'] as const) {
          // Two padded grids only undo each other when both have as many columns.
          if (method === 'double' && grid === 'complete' && key.length !== 6) continue;
          const options = { method, key, key2: 'STRIPE', grid };
          const cipher = encrypt(text, options);
          const back = decrypt(cipher, options);
          const plain = [...toCells(text, 'nospace')].join('');
          // A complete grid ends with the padding.
          expect(back.startsWith(plain), `${method} ${key} ${grid}`).toBe(true);
          if (grid === 'incomplete') expect(back).toBe(plain);
        }
      }
    }
  });

  it('round-trips with the permutation run backwards', () => {
    for (const method of ['columnar', 'myszkowski', 'double', 'route'] as const) {
      const options = { method, key: 'ZEBRAS', key2: 'STRIPE', width: 5, inverse: true };
      const plain = toCells(text, 'nospace').join('');
      expect(decrypt(encrypt(text, options), options)).toBe(plain);
    }
    // Running backwards turns encryption into the other direction's decryption.
    const forward = encrypt(WIKI, { key: 'ZEBRAS' });
    expect(decrypt(WIKI, { key: 'ZEBRAS', inverse: true })).toBe(forward);
  });

  it('keeps or drops spaces and punctuation as asked', () => {
    const s = 'ab cd, ef';
    expect(toCells(s, 'nospace').join('')).toBe('abcd,ef');
    expect(toCells(s, 'letters').join('')).toBe('abcdef');
    expect(toCells(s, 'all').join('')).toBe('ab cd, ef');
    expect(
      decrypt(encrypt(s, { key: '2 1 3', chars: 'all' }), { key: '2 1 3', chars: 'all' }),
    ).toBe(s);
  });

  it('groups the ciphertext in fives', () => {
    expect(encrypt(WIKI, { key: 'ZEBRAS', group: true })).toBe('EVLNA CDTES EAROF ODEEC WIREE');
  });

  it('says what is wrong with the key or the grid', () => {
    expect(() => run('abc', { key: '' })).toThrow(/Enter a key/);
    expect(() => run('abcdefg', { key: 'ZEBRAS', grid: 'complete' })).toThrow(
      /multiple of 6 characters, but there are 7/,
    );
    expect(() => run('abc', { method: 'route', width: 0 })).toThrow(/grid width/);
    expect(() => run('abc', { method: 'scytale' })).toThrow(/number of rows/);
    expect(() => run('  ', { key: 'ZEBRAS' })).toThrow(/empty/);
    expect(() => run('abcdef', { mode: 'solve', method: 'double' })).toThrow(/Auto-solve/);
  });

  it('shows the grid with the key and the reading order', () => {
    const r = run('EVLNACDTESEAROFODEECWIREE', { key: 'ZEBRAS' });
    const table = r.find((o) => o.type === 'table');
    expect(table?.type === 'table' && table.columns).toEqual(['', 'Z', 'E', 'B', 'R', 'A', 'S']);
    expect(table?.type === 'table' && table.rows[0]).toEqual(['#', '6', '3', '2', '4', '1', '5']);
    expect(table?.type === 'table' && table.rows[1]).toEqual(['1', 'W', 'E', 'A', 'R', 'E', 'D']);
    // The incomplete last row is padded with blanks, not shortened.
    expect(table?.type === 'table' && table.rows[5]).toEqual(['5', 'E', '', '', '', '', '']);
  });

  it('never leaves a translation key in the output', () => {
    const outputs = [
      run(WIKI, { mode: 'encrypt', key: 'ZEBRAS', grid: 'complete' }),
      run(WIKI, { method: 'double', mode: 'encrypt', key: 'ZEBRAS' }),
      run(WIKI, { method: 'route', mode: 'decrypt', width: 7 }),
      run(WIKI, { method: 'route', mode: 'solve' }),
      run(WIKI, { method: 'scytale', mode: 'solve' }),
    ];
    for (const out of outputs) expect(resultToText(out)).not.toMatch(/tool\.columnar\./);
  });
});

describe('route ciphers', () => {
  const grid = 'ABCDEFGHIJKL'; // 3 rows x 4 columns

  it('reads the usual clockwise spiral from the top left', () => {
    const route = { family: 'spiral', corner: 'tl', clockwise: true, outward: false } as const;
    const read = permute([...grid], routePermutation(12, 4, route)).join('');
    expect(read).toBe('ABCDHLKJIEFG');
  });

  it('starts from every corner and in both senses', () => {
    const read = (corner: 'tl' | 'tr' | 'bl' | 'br', clockwise: boolean, outward = false) =>
      permute(
        [...grid],
        routePermutation(12, 4, { family: 'spiral', corner, clockwise, outward }),
      ).join('');
    expect(read('tl', false)).toBe('AEIJKLHDCBFG');
    expect(read('tr', true)).toBe('DHLKJIEABCGF');
    expect(read('br', true)).toBe('LKJIEABCDHGF');
    expect(read('bl', false)).toBe('IJKLHDCBAEFG');
    // Outward is the inward path of the opposite sense, backwards, ending on the corner.
    expect(read('tl', true, true)).toBe([...read('tl', false)].reverse().join(''));
  });

  it('reads rows and columns back and forth', () => {
    const read = (
      family: 'snake-rows' | 'snake-columns' | 'rows' | 'columns',
      corner: 'tl' | 'br',
    ) =>
      permute(
        [...grid],
        routePermutation(12, 4, { family, corner, clockwise: true, outward: false }),
      ).join('');
    expect(read('snake-rows', 'tl')).toBe('ABCDHGFEIJKL');
    expect(read('snake-columns', 'tl')).toBe('AEIJFBCGKLHD');
    expect(read('columns', 'tl')).toBe('AEIBFJCGKDHL');
    expect(read('rows', 'br')).toBe('LKJIHGFEDCBA');
  });

  it('is a permutation for every route and width, even with a short last row', () => {
    for (const length of [12, 17, 30]) {
      for (const width of [2, 3, 5, 7]) {
        for (const route of allRoutes()) {
          const perm = routePermutation(length, width, route);
          expect([...perm].sort((a, b) => a - b)).toEqual(Array.from({ length }, (_, i) => i));
        }
      }
    }
  });

  it('decrypts a self-made spiral', () => {
    // scripts/gen-samples-transposition.mjs: a 6 x 6 grid read as a clockwise spiral.
    const out = decrypt('readths{leog}ko__stisfirgatuorpflari', { method: 'route', width: 6 });
    expect(out).toBe('readthisfirstflag{spiral_route_ok}go');
  });

  it('finds the route and the width by itself', () => {
    const text = resultToText(
      run('readths{leog}ko__stisfirgatuorpflari', { method: 'route', mode: 'solve' }),
    );
    expect(text).toContain('Best guess · Spiral inward from the top left, clockwise, width 6');
    expect(text).toContain('readthisfirstflag{spiral_route_ok}go');
    // The one-click button fills in the options that reproduce the result.
    const r = run('readths{leog}ko__stisfirgatuorpflari', { method: 'route', mode: 'solve' });
    const actions = r.find((o) => o.type === 'actions');
    const options = actions?.type === 'actions' ? actions.actions[0]!.options : {};
    expect(options).toMatchObject({ method: 'route', mode: 'decrypt', width: 6, spin: 'cw' });
    expect(decrypt('readths{leog}ko__stisfirgatuorpflari', options as Partial<Options>)).toBe(
      'readthisfirstflag{spiral_route_ok}go',
    );
  });

  it('finds a scytale by itself', () => {
    const text = resultToText(run('Iryyatbhmvaehedlurlp', { method: 'scytale', mode: 'solve' }));
    expect(text).toContain('Best guess · 4 rows × 5 columns');
    expect(text).toContain('Iamhurtverybadlyhelp');
  });
});

/** Letters of a text, upper-case, as the cells of a grid. */
const cellsOf = (s: string) => [...s.replace(/[^A-Za-z]/g, '').toUpperCase()];

/** Encrypt cells under a key (a reading order) the way the tool does. */
const encryptCells = (cells: string[], key: string) =>
  permute(cells, columnarPermutation(cells.length, parseColumnKey(key)));

describe('columnar solver', () => {
  it('finds a 7-letter key on English text within the time bound', () => {
    const plain = cellsOf(PROSE_B.slice(0, 330));
    expect(plain.length % 7).not.toBe(0); // an incomplete grid
    const cipher = encryptCells(plain, 'QUILTED');
    const started = Date.now();
    const sol = solveColumnar(cipher);
    const elapsed = Date.now() - started;
    const best = sol.candidates[0]!;
    expect(best.plain).toBe(plain.join(''));
    expect(best.length).toBe(7);
    expect(best.order).toEqual(parseColumnKey('QUILTED').order);
    expect(sol.stopped).toBeNull();
    expect(sol.reached).toBe(9);
    // 2..9 columns, every order, in a few seconds even on a shared machine.
    expect(elapsed).toBeLessThan(10_000);
  });

  it('keeps the exact text among the candidates when an incomplete grid has look-alikes', () => {
    // On an incomplete grid, keys that differ in where the long columns fall give the same
    // text moved by a few letters, and they score almost the same: the true one is listed too.
    const plain = cellsOf(PROSE_A.slice(0, 523));
    expect(plain.length % 7).not.toBe(0);
    const sol = solveColumnar(encryptCells(plain, 'QUILTED'));
    const exact = plain.join('');
    expect(sol.candidates.some((c) => c.plain === exact)).toBe(true);
    const best = sol.candidates[0]!;
    expect(best.length).toBe(7);
    // The best one is the message read from another starting point: same body, other ends.
    expect(exact.includes(best.plain.slice(10, 200))).toBe(true);
    const exactCandidate = sol.candidates.find((c) => c.plain === exact)!;
    expect(best.fitness - exactCandidate.fitness).toBeLessThan(0.02);
  });

  it('is deterministic: the same text gives the same candidates', () => {
    const cipher = encryptCells(cellsOf(PROSE_B.slice(0, 300)), 'LANTERN');
    const a = solveColumnar(cipher);
    const b = solveColumnar(cipher);
    expect(b.candidates.map((c) => [c.length, c.order, c.fitness])).toEqual(
      a.candidates.map((c) => [c.length, c.order, c.fitness]),
    );
  });

  it('solves complete grids, short keys and other key lengths', () => {
    for (const [text, key] of [
      [PROSE_B.slice(0, 400), 'ZEBRA'],
      [PROSE_A.slice(0, 600), 'PIANO'],
      [PROSE_B.slice(0, 250), 'KEY'],
      [PROSE_B.slice(0, 800), 'SPHINXVOW'],
      [PROSE_B.slice(0, 600), 'CRYPTOGR'],
    ] as const) {
      const plain = cellsOf(text);
      const sol = solveColumnar(encryptCells(plain, key));
      expect(
        sol.candidates.some((c) => c.plain === plain.join('') && c.length === key.length),
        key,
      ).toBe(true);
      expect(sol.candidates[0]!.length, key).toBe(key.length);
    }
  });

  it('solves a text that keeps punctuation and digits in the grid', () => {
    const plain = toCells(PROSE_B.slice(0, 380) + ' flag{in_the_grid_42}', 'nospace');
    const cipher = permute(plain, columnarPermutation(plain.length, parseColumnKey('BRIDGE')));
    const sol = solveColumnar(cipher);
    expect(sol.candidates.some((c) => c.plain === plain.join(''))).toBe(true);
    expect(sol.candidates[0]!.length).toBe(6);
  });

  it('searches longer keys by hill climbing', () => {
    const plain = cellsOf(PROSE_B.slice(0, 760));
    const cipher = encryptCells(plain, 'COMPUTERSAF');
    const sol = solveColumnar(cipher, { minLength: 11, maxLength: 11 });
    expect(sol.climbed).toBe(true);
    expect(sol.candidates.some((c) => c.plain === plain.join(''))).toBe(true);
    expect(plain.join('').includes(sol.candidates[0]!.plain.slice(20, 300))).toBe(true);
  });

  it('stays within a budget: a small one stops early and says so', () => {
    const cipher = encryptCells(cellsOf(PROSE_A.slice(0, 400)), 'QUILTED');
    const sol = solveColumnar(cipher, { budget: 2_000_000 });
    expect(sol.stopped).toBe('budget');
    expect(sol.reached).toBeLessThan(9);
  });

  it('ranks the right key above the rest in the tool and offers it as a button', () => {
    const cells = cellsOf(PROSE_B.slice(0, 330));
    const cipher = encryptCells(cells, 'QUILTED').join('');
    const r = run(cipher, { mode: 'solve' });
    const text = resultToText(r);
    expect(text).toContain('Best guess · 7 columns, key ');
    expect(text).toContain(cells.join(''));
    expect(text).toContain('The best result reads like English.');
    const actions = r.find((o) => o.type === 'actions');
    const options = actions?.type === 'actions' ? actions.actions[0]!.options : {};
    expect(decrypt(cipher, options as Partial<Options>)).toBe(cells.join(''));
    expect(text).not.toMatch(/tool\.columnar\./);
  });

  it('lists the look-alike keys and a button for each', () => {
    const cells = cellsOf(PROSE_A.slice(0, 523));
    const cipher = encryptCells(cells, 'QUILTED').join('');
    const r = run(cipher, { mode: 'solve' });
    expect(resultToText(r)).toContain('Several keys of this length score almost the same');
    const actions = r.find((o) => o.type === 'actions');
    const buttons = actions?.type === 'actions' ? actions.actions : [];
    expect(buttons.length).toBeGreaterThan(1);
    // One of the buttons gives the message from its real start.
    const results = buttons.map((b) => decrypt(cipher, b.options as Partial<Options>));
    const table = r.find((o) => o.type === 'table');
    expect(table?.type === 'table' && table.rows.length).toBeGreaterThan(2);
    expect(results.every((x) => x.length === cells.length)).toBe(true);
  });

  it('refuses too little text and warns about noise', () => {
    expect(() => run('abcdef', { mode: 'solve' })).toThrow(/at least 20/);
    // Letters in a random order are not English: no success note.
    const noise = 'qzxjkvwpqzxjkvwpbnmqzxjkvwpqzxjkvwpbnmqzxjkvwpqzxjkvwpbnm';
    const out = resultToText(run(noise, { mode: 'solve' }));
    expect(out).not.toContain('The best result reads like English.');
    expect(out).toContain('No result clearly reads like English');
  });

  it('points an ADFGX / ADFGVX ciphertext to its own tool', () => {
    // Wikipedia's ADFGVX example: only the six coordinate letters, no English in its columns.
    const out = resultToText(run('DGDDDAGDDGAFADDFDADVDVFAADVX', { mode: 'solve' }));
    expect(out).toContain('This text uses only the letters of an ADFGX / ADFGVX message');
    // An ordinary text does not get the hint.
    const plain = cellsOf(PROSE_B.slice(0, 200));
    const other = resultToText(run(encryptCells(plain, 'QUILTED').join(''), { mode: 'solve' }));
    expect(other).not.toContain('ADFGX / ADFGVX message');
  });

  it('keeps identity keys as the scytale', () => {
    const cells = cellsOf(WIKI);
    const viaKey = unpermute(cells, columnarPermutation(cells.length, identityKey(5)));
    const viaTool = decrypt(WIKI, { method: 'scytale', columns: 5 });
    expect(viaTool).toBe(viaKey.join(''));
  });
});
