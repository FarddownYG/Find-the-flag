import { describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors';
import { resultToText } from '../../core/result-text';
import type { Output, ToolResult } from '../../core/types';
import { makeRng } from './_classical';
import { frenchQuadTable } from './_fitness-fr';
import {
  HILL_ALPHABETS,
  applyBlocks,
  determinant,
  gcd,
  identity,
  invert,
  isParsed,
  modInverse,
  multiply,
  parseKey,
  primeFactors,
  readText,
  solveKnown,
  transpose,
  writeText,
  type AlphabetId,
  type Matrix,
} from './_hill';
import { CRACK_LETTERS, crackHill2 } from './_hill-crack';
import { PROSE_A, PROSE_B } from './_sample-text';
import tool from './hill';

type Opts = Parameters<typeof tool.run>[1];
const DEFAULTS: Opts = {
  mode: 'decrypt',
  key: '',
  alphabet: 'az',
  convention: 'column',
  filler: 'X',
  known: '',
  offset: 0,
  size: 2,
  language: 'english',
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
const AZ = HILL_ALPHABETS.az;
/** The numbers of a matrix table, without its row labels. */
const cells = (t: Extract<Output, { type: 'table' }>): string[][] =>
  t.rows.map((r) => r.slice(1).map(String));

/** Hill-encrypt the symbols of a text with a matrix (column vectors), padding with X. */
function encrypt(text: string, key: Matrix, alphabet = AZ): string {
  const letters = alphabet.id === 'az' ? text.replace(/[^A-Za-z]/g, '') : text;
  const { values } = readText(letters, alphabet);
  const n = key.length;
  while (values.length % n) values.push(alphabet.symbols.indexOf('X'));
  return writeText(
    [],
    applyBlocks(values, key, alphabet.modulus).flatMap((s) => s.output),
    alphabet,
    false,
  );
}

describe('published test vectors', () => {
  it('Wikipedia: key GYBNQKURP (3 x 3), ACT -> POH, and the inverse matrix', () => {
    const out = run('ACT', { mode: 'encrypt', key: 'GYBNQKURP' });
    expect(textOf(out, 'Ciphertext')).toBe('POH');
    expect(cells(tableOf(out, 'Key matrix'))).toEqual([
      ['6', '24', '1'],
      ['13', '16', '10'],
      ['20', '17', '15'],
    ]);
    expect(cells(tableOf(out, 'Inverse'))).toEqual([
      ['8', '5', '10'],
      ['21', '8', '21'],
      ['21', '12', '8'],
    ]);
    expect(resultToText(out)).toContain('Determinant: 25 (mod 26)');
    expect(textOf(run('POH', { key: 'GYBNQKURP' }), 'Plaintext')).toBe('ACT');
  });

  it('2 x 2: key [[3,3],[2,5]] ("DDCF"), HELP -> HIAT, inverse [[15,17],[20,9]]', () => {
    for (const key of ['DDCF', '3 3 2 5', '[[3, 3], [2, 5]]', '3,3;2,5', '3 3\n2 5']) {
      expect(textOf(run('HELP', { mode: 'encrypt', key }), 'Ciphertext')).toBe('HIAT');
    }
    const out = run('HIAT', { key: 'DDCF' });
    expect(textOf(out, 'Plaintext')).toBe('HELP');
    expect(cells(tableOf(out, 'Inverse'))).toEqual([
      ['15', '17'],
      ['20', '9'],
    ]);
  });

  it('Stinson, with row vectors (y = xK): K = [[11,8],[3,7]], JULY -> DELW', () => {
    const out = run('JULY', { mode: 'encrypt', key: '11 8 3 7', convention: 'row' });
    expect(textOf(out, 'Ciphertext')).toBe('DELW');
    expect(cells(tableOf(out, 'Inverse'))).toEqual([
      ['7', '18'],
      ['23', '11'],
    ]);
    expect(textOf(run('DELW', { key: '11 8 3 7', convention: 'row' }), 'Plaintext')).toBe('JULY');
    // The same letters read with column vectors give another ciphertext.
    expect(textOf(run('JULY', { mode: 'encrypt', key: '11 8 3 7' }), 'Ciphertext')).not.toBe(
      'DELW',
    );
  });
});

describe('the arithmetic', () => {
  it('gcd, inverses and prime factors', () => {
    expect(gcd(18, 26)).toBe(2);
    expect(gcd(0, 26)).toBe(26);
    expect(modInverse(9, 26)).toBe(3);
    expect(modInverse(25, 26)).toBe(25);
    expect(modInverse(13, 26)).toBeNull();
    expect(modInverse(0, 29)).toBeNull();
    expect(primeFactors(26)).toEqual([2, 13]);
    expect(primeFactors(29)).toEqual([29]);
    expect(primeFactors(37)).toEqual([37]);
  });

  it('determinants agree with hand-worked values (mod 26)', () => {
    expect(
      determinant(
        [
          [3, 3],
          [2, 5],
        ],
        26,
      ),
    ).toBe(9);
    expect(
      determinant(
        [
          [6, 24, 1],
          [13, 16, 10],
          [20, 17, 15],
        ],
        26,
      ),
    ).toBe(25); // 441
    expect(
      determinant(
        [
          [2, 4],
          [6, 8],
        ],
        26,
      ),
    ).toBe(18);
    expect(determinant(identity(5), 26)).toBe(1);
    // A 4 x 4 worked by hand: upper triangular, so the product of the diagonal.
    expect(
      determinant(
        [
          [3, 1, 4, 1],
          [0, 5, 9, 2],
          [0, 0, 7, 3],
          [0, 0, 0, 11],
        ],
        26,
      ),
    ).toBe((3 * 5 * 7 * 11) % 26);
  });

  it('a matrix has an inverse exactly when gcd(det, m) = 1, and K x K^-1 = I', () => {
    const rng = makeRng(31);
    for (const m of [26, 29, 37]) {
      for (const n of [2, 3, 4, 5, 6]) {
        let inverted = 0;
        for (let t = 0; t < 30; t++) {
          const k = Array.from({ length: n }, () =>
            Array.from({ length: n }, () => Math.floor(rng() * m)),
          );
          const inv = invert(k, m);
          expect(gcd(inv.det, m) === 1).toBe(inv.inverse !== null);
          if (inv.inverse) {
            inverted++;
            expect(multiply(k, inv.inverse, m)).toEqual(identity(n));
            expect(multiply(inv.inverse, k, m)).toEqual(identity(n));
          }
        }
        expect(inverted).toBeGreaterThan(0);
      }
    }
  });

  it('there are 157,248 invertible 2 x 2 matrices mod 26 and 682,080 mod 29', () => {
    const count = (m: number) => {
      let c = 0;
      for (let a = 0; a < m; a++)
        for (let b = 0; b < m; b++)
          for (let cc = 0; cc < m; cc++)
            for (let d = 0; d < m; d++) if (gcd((a * d - b * cc + m * m) % m, m) === 1) c++;
      return c;
    };
    expect(count(26)).toBe(157_248);
    expect(count(29)).toBe(682_080);
    expect(crackHill2(Uint8Array.from({ length: 40 }, (_, i) => i % 26)).tried).toBe(157_248);
  });
});

describe('reading the key', () => {
  const key = (s: string, id: AlphabetId = 'az') => parseKey(s, HILL_ALPHABETS[id]);

  it('reads numbers in any layout, and keywords with spare characters', () => {
    const expected = [
      [6, 24, 1],
      [13, 16, 10],
      [20, 17, 15],
    ];
    for (const s of [
      '6 24 1 13 16 10 20 17 15',
      '6,24,1;13,16,10;20,17,15',
      '[[6,24,1],[13,16,10],[20,17,15]]',
      'gybnqkurp'.replace('gybn', 'GYBN'),
    ]) {
      const r = key(s);
      expect(isParsed(r) && r.matrix).toEqual(expected);
    }
    const word = key('g-y b!n q k u r p');
    expect(isParsed(word) && word.matrix).toEqual(expected);
    expect(isParsed(word) && word.form).toBe('letters');
    // Negative numbers and numbers past the modulus are reduced.
    const neg = key('-1 27 0 1');
    expect(isParsed(neg) && neg.matrix).toEqual([
      [25, 1],
      [0, 1],
    ]);
  });

  it('with the 37-symbol alphabet a keyword may hold digits, numbers need separators', () => {
    const word = key('AB1C', 'az37');
    expect(isParsed(word) && word.matrix).toEqual([
      [0, 1],
      [27, 2],
    ]);
    const nums = key('1 2 3 4', 'az37');
    expect(isParsed(nums) && nums.matrix).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it('says what is wrong: empty, wrong count, too big', () => {
    expect(key('')).toEqual({ problem: 'empty' });
    expect(key('12345')).toEqual({ problem: 'empty' }); // digits are not letters of A-Z
    expect(key('ABCDE')).toEqual({ problem: 'count', count: 5 });
    expect(key('1 2 3 4 5')).toEqual({ problem: 'count', count: 5 });
    expect(key('A'.repeat(49))).toEqual({ problem: 'tooBig', n: 7 });
    expect(() => run('abcd', { key: 'ABCDE' })).toThrow(/5 entries.*4, 9, 16, 25 or 36/);
    expect(() => run('abcd', { key: '' })).toThrow(/Enter the key/);
    expect(() => run('abcd', { key: 'A'.repeat(49) })).toThrow(/too large/);
  });
});

describe('encrypting and decrypting text', () => {
  const rng = makeRng(2025);
  const alphabets: AlphabetId[] = ['az', 'az29', 'az37'];

  it('round-trips random invertible keys of every size and alphabet', () => {
    for (const id of alphabets) {
      const a = HILL_ALPHABETS[id];
      for (const n of [2, 3, 4, 5, 6]) {
        let key: Matrix;
        do {
          key = Array.from({ length: n }, () =>
            Array.from({ length: n }, () => Math.floor(rng() * a.modulus)),
          );
        } while (!invert(key, a.modulus).inverse);
        const plain = Array.from(
          { length: n * 7 },
          () => a.symbols[Math.floor(rng() * a.modulus)]!,
        ).join('');
        const enc = textOf(
          run(plain, { mode: 'encrypt', key: key.flat().join(' '), alphabet: id }),
          'Ciphertext',
        );
        expect(enc).toHaveLength(plain.length);
        const dec = textOf(run(enc, { key: key.flat().join(' '), alphabet: id }), 'Plaintext');
        expect(dec).toBe(plain);
      }
    }
  });

  it('keeps case, spaces and punctuation in place with the 26-letter alphabet', () => {
    const text = 'Meet me at the old bridge, 9 pm sharp!';
    const enc = textOf(run(text, { mode: 'encrypt', key: 'GYBNQKURP' }), 'Ciphertext');
    // The non-letters and the case pattern are those of the text; the padding comes at the end.
    expect(enc.replace(/[A-Za-z]/g, '·').startsWith(text.replace(/[A-Za-z]/g, '·'))).toBe(true);
    expect(enc.slice(0, 4)).not.toBe(text.slice(0, 4));
    const dec = textOf(run(enc, { key: 'GYBNQKURP' }), 'Plaintext');
    expect(dec).toBe(text + 'x'.repeat(dec.length - text.length));
    expect(dec.slice(0, text.length)).toBe(text);
  });

  it('pads the last block with the padding letter, and says so', () => {
    const out = run('ABCDE', { mode: 'encrypt', key: '3 3 2 5' });
    expect(textOf(out, 'Ciphertext')).toHaveLength(6);
    expect(resultToText(out)).toContain('Padding added at the end to fill the last block: 1 × X');
    const z = run('ABCDE', { mode: 'encrypt', key: '3 3 2 5', filler: 'z' });
    expect(resultToText(z)).toContain('1 × Z');
    expect(textOf(run(textOf(z, 'Ciphertext'), { key: '3 3 2 5' }), 'Plaintext')).toBe('ABCDEZ');
    expect(() => run('ABCDE', { mode: 'encrypt', key: '3 3 2 5', filler: '?' })).toThrow(
      /padding letter/,
    );
    expect(() => run('ABCDE', { mode: 'encrypt', key: '3 3 2 5', filler: '' })).toThrow(ToolError);
    // A text that fills the blocks needs no padding and no filler.
    expect(
      resultToText(run('ABCD', { mode: 'encrypt', key: '3 3 2 5', filler: '?' })),
    ).not.toContain('Padding');
  });

  it('leaves out the letters of an incomplete last block when decrypting, and says so', () => {
    const out = run('HIATH', { key: '3 3 2 5' });
    expect(textOf(out, 'Plaintext')).toBe('HELP');
    expect(resultToText(out)).toContain('Letters left out: 1 (they do not fill a block of 2)');
    // Marks around the letters stay where they are.
    expect(textOf(run('{HI AT}', { key: 'DDCF' }), 'Plaintext')).toBe('{HE LP}');
  });

  it('the 29 and 37 symbol alphabets use their own symbols and report capitals', () => {
    const a29 = run('HELLO, WORLD.', { mode: 'encrypt', key: '3 3 2 5', alphabet: 'az29' });
    const c29 = textOf(a29, 'Ciphertext');
    expect(c29).toMatch(/^[A-Z .,]+$/);
    expect(resultToText(a29)).toContain('the result is in capitals');
    // 13 symbols: one X of padding fills the last block.
    expect(textOf(run(c29, { key: '3 3 2 5', alphabet: 'az29' }), 'Plaintext')).toBe(
      'HELLO, WORLD.X',
    );
    // "!" is not in the 29-symbol alphabet: it stays where it was.
    expect(
      textOf(run('HI!', { mode: 'encrypt', key: '3 3 2 5', alphabet: 'az29' }), 'Ciphertext'),
    ).toMatch(/!/);
    const c37 = textOf(
      run('flag 42', { mode: 'encrypt', key: '1 2 3 5', alphabet: 'az37' }),
      'Ciphertext',
    );
    // "flag 42" is 7 symbols (the space counts): one X of padding.
    expect(c37).toHaveLength(8);
    expect(textOf(run(c37, { key: '1 2 3 5', alphabet: 'az37' }), 'Plaintext')).toBe('FLAG 42X');
  });

  it('shows the working: the vector, K times it, and the reduction mod m', () => {
    const t = tableOf(run('HELP', { mode: 'encrypt', key: 'DDCF' }), 'Working');
    expect(t.columns).toEqual(['#', 'Block', 'Vector', 'K × vector', 'Reduced mod m', 'Result']);
    expect(t.rows[0]).toEqual([1, 'HE', '7 4', '33 34', '7 8', 'HI']);
    expect(t.rows[1]).toEqual([2, 'LP', '11 15', '78 97', '0 19', 'AT']);
    const dec = tableOf(run('HIAT', { key: 'DDCF' }), 'Working');
    expect(dec.columns[3]).toBe('K⁻¹ × vector');
    // K^-1 = [[15,17],[20,9]]: 15*7 + 17*8 = 241 = 7 (mod 26), 20*7 + 9*8 = 212 = 4 (mod 26).
    expect(dec.rows[0]).toEqual([1, 'HI', '7 8', '241 212', '7 4', 'HE']);
  });

  it('caps the working table and handles a long text', () => {
    const big = PROSE_A.repeat(8);
    const enc = run(big, { mode: 'encrypt', key: 'GYBNQKURP' });
    const t = tableOf(enc, 'Working');
    expect(t.rows).toHaveLength(60);
    expect(t.label).toMatch(/first 60 of \d+/);
    const letters = big.replace(/[^A-Za-z]/g, '').length;
    expect(textOf(enc, 'Ciphertext').replace(/[^A-Za-z]/g, '')).toHaveLength(
      Math.ceil(letters / 3) * 3,
    );
  });

  it('refuses a text without symbols of the alphabet', () => {
    expect(() => run('1234 !?', { mode: 'encrypt', key: 'DDCF' })).toThrow(
      /symbols of the chosen alphabet/,
    );
  });
});

describe('a key with no inverse', () => {
  it('explains why: the determinant shares a factor with the modulus', () => {
    const out = run('ABCD', { key: '2 4 6 8' });
    const text = resultToText(out);
    expect(text).toContain('The key is not invertible mod 26');
    expect(text).toContain('its determinant is 18');
    expect(text).toContain('gcd(18, 26) = 2');
    expect(text).toContain('Invertible: no');
    // No plaintext is produced, but the key is shown.
    expect(out.some((o) => o.type === 'text')).toBe(false);
    expect(cells(tableOf(out, 'Key matrix'))).toEqual([
      ['2', '4'],
      ['6', '8'],
    ]);
  });

  it('names both primes of 26, and the single prime of 29 or 37', () => {
    // det = 13 * 2 = 26 = 0: divisible by 2 and by 13.
    expect(resultToText(run('ABCD', { key: '13 0 0 2' }))).toContain('(2, 13)');
    expect(resultToText(run('ABCD', { key: '1 2 2 4', alphabet: 'az29' }))).toContain(
      'gcd(0, 29) = 29',
    );
    expect(resultToText(run('ABCD', { key: '1 2 2 4', alphabet: 'az37' }))).toContain('(37)');
  });

  it('still encrypts, with a warning that nothing can decrypt it', () => {
    const out = run('ABCD', { mode: 'encrypt', key: '2 4 6 8' });
    expect(textOf(out, 'Ciphertext')).toHaveLength(4);
    expect(resultToText(out)).toContain('nobody can decrypt it');
    expect(resultToText(out)).toContain('Invertible: no');
    // Two different plaintexts give the same ciphertext: that is why.
    const a = textOf(run('AA', { mode: 'encrypt', key: '2 4 6 8' }), 'Ciphertext');
    const b = textOf(run('NA', { mode: 'encrypt', key: '2 4 6 8' }), 'Ciphertext');
    expect(a).toBe(b);
  });

  it('a prime modulus has an inverse unless the determinant is 0', () => {
    expect(
      textOf(run('HELP', { mode: 'encrypt', key: '2 4 6 8', alphabet: 'az29' }), 'Ciphertext'),
    ).toBeTruthy();
    expect(() => run('HELP', { key: '2 4 6 8', alphabet: 'az29' })).not.toThrow();
    const out = run('HELP', { key: '2 4 6 8', alphabet: 'az29' });
    expect(out.some((o) => o.type === 'text')).toBe(true);
  });
});

describe('recovering the key from known plaintext', () => {
  const key3: Matrix = [
    [6, 24, 1],
    [13, 16, 10],
    [20, 17, 15],
  ];
  const message = 'Every night the keeper of the old lighthouse raises a flag at dawn';

  it('finds the key from n x n independent letters, and decrypts the rest', () => {
    const cipher = encrypt(message, key3);
    const out = run(cipher, { mode: 'known', known: 'EVERYNIGH', size: 3 });
    expect(textOf(out, 'Plaintext')).toBe(
      'EVERYNIGHTTHEKEEPEROFTHEOLDLIGHTHOUSERAISESAFLAGATDAWNX'.slice(0, cipher.length),
    );
    expect(resultToText(out)).toContain('Recovered the 3 × 3 key');
    expect(cells(tableOf(out, 'Key found'))).toEqual([
      ['6', '24', '1'],
      ['13', '16', '10'],
      ['20', '17', '15'],
    ]);
    expect(resultToText(out)).toContain('Keyword: GYBNQKURP');
    expect(resultToText(out)).toContain('Numbers: 6 24 1 13 16 10 20 17 15');
    const action = out.find((o) => o.type === 'actions') as Extract<Output, { type: 'actions' }>;
    expect(action.actions[0]!.options).toEqual({
      mode: 'decrypt',
      key: '6 24 1 13 16 10 20 17 15',
      alphabet: 'az',
      convention: 'column',
    });
  });

  it('works with 2 x 2 from four letters (HELP -> HIAT)', () => {
    const out = run('HIAT', { mode: 'known', known: 'HELP', size: 2 });
    expect(textOf(out, 'Plaintext')).toBe('HELP');
    expect(cells(tableOf(out, 'Key found'))).toEqual([
      ['3', '3'],
      ['2', '5'],
    ]);
    expect(resultToText(out)).toContain('Recovered the 2 × 2 key');
  });

  it('works for every size from 2 to 6, and in the row convention', () => {
    const rng = makeRng(8);
    for (const n of [2, 3, 4, 5, 6]) {
      let key: Matrix;
      do {
        key = Array.from({ length: n }, () =>
          Array.from({ length: n }, () => Math.floor(rng() * 26)),
        );
      } while (!invert(key, 26).inverse);
      const plain = PROSE_B.replace(/[^A-Za-z]/g, '')
        .toUpperCase()
        .slice(0, n * 30);
      for (const convention of ['column', 'row'] as const) {
        const effective = convention === 'row' ? transpose(key) : key;
        const cipher = encrypt(plain, effective);
        const out = run(cipher, {
          mode: 'known',
          known: plain.slice(0, n * (n + 2)),
          size: n,
          convention,
        });
        const text = resultToText(out);
        // Either the one key, or (when the blocks happen to be dependent) the best of several.
        expect(textOf(out, 'Plaintext')).toBe(plain);
        expect(text).toContain(`Numbers: ${key.flat().join(' ')}`);
      }
    }
  });

  it('works with the 29 and 37 symbol alphabets', () => {
    for (const id of ['az29', 'az37'] as const) {
      const a = HILL_ALPHABETS[id];
      const key = [
        [3, 3],
        [2, 5],
      ];
      const plain =
        id === 'az29' ? 'MEET ME AT NOON, BRING THE MAP.' : 'FLAG 42 IS IN BOX 7 AT 9 PM';
      const cipher = encrypt(plain, key, a);
      const out = run(cipher, { mode: 'known', known: plain.slice(0, 8), size: 2, alphabet: id });
      expect(resultToText(out)).toContain('Numbers: 3 3 2 5');
      expect(textOf(out, 'Plaintext').startsWith(plain.slice(0, 20))).toBe(true);
    }
  });

  it('starts at the offset you give, on the right place of a block', () => {
    const cipher = encrypt(message, key3);
    const plain = message.replace(/[^A-Za-z]/g, '').toUpperCase();
    // The known text starts at letter 4: its first block-aligned letter is letter 6.
    const out = run(cipher, { mode: 'known', known: plain.slice(4, 4 + 14), size: 3, offset: 4 });
    expect(resultToText(out)).toContain('Numbers: 6 24 1 13 16 10 20 17 15');
    expect(textOf(out, 'Plaintext').startsWith(plain.slice(0, 30))).toBe(true);
  });

  it('says when the known blocks are not independent, and still lists what fits', () => {
    // THE SIG NAL: the three blocks are dependent modulo 2 and modulo 13.
    const cipher = encrypt(
      'The signal flag is raised at dawn, but only the keeper knows what it means',
      key3,
    );
    const out = run(cipher, { mode: 'known', known: 'THESIGNAL', size: 3 });
    const text = resultToText(out);
    expect(text).toContain('not independent mod 26: mod 2: 2 / 3, mod 13: 2 / 3 (rank / n)');
    expect(text).toContain('The known text does not fix the key');
    expect(text).toContain('Candidate keys, best first');
    // The real key is the one that reads as English.
    expect(text).toContain('Numbers: 6 24 1 13 16 10 20 17 15');
    expect(textOf(out, 'Plaintext').startsWith('THESIGNALFLAGISRAISED')).toBe(true);
  });

  it('a known text with two equal blocks leaves a family of keys', () => {
    const k = [
      [3, 3],
      [2, 5],
    ];
    const cipher = encrypt('ABABHELPMEOBIWANKENOBI', k);
    const out = run(cipher, { mode: 'known', known: 'ABAB', size: 2 });
    const text = resultToText(out);
    expect(text).toContain('not independent mod 26: mod 2: 1 / 2, mod 13: 1 / 2 (rank / n)');
    expect(text).toContain('invertible matrices fit');
    // The first block fixes the key only along one direction: every candidate keeps AB -> HI.
    for (const row of tableOf(out, 'Candidate keys').rows) {
      const nums = String(row[3]).split(' ').map(Number);
      expect([(nums[0]! * 0 + nums[1]! * 1) % 26, (nums[2]! * 0 + nums[3]! * 1) % 26]).toEqual([
        3, 5,
      ]);
    }
  });

  it('with a prime modulus the rank is reported mod that prime', () => {
    const k = [
      [3, 3],
      [2, 5],
    ];
    const cipher = encrypt('ABABHELPMEOBIWANKENOBI', k, HILL_ALPHABETS.az29);
    const out = run(cipher, { mode: 'known', known: 'ABAB', size: 2, alphabet: 'az29' });
    expect(resultToText(out)).toContain('not independent mod 29: mod 29: 1 / 2');
  });

  it('says when nothing fits, and at which letter the known text would fit', () => {
    const cipher = encrypt('HELPMEOBIWANKENOBI', [
      [3, 3],
      [2, 5],
    ]);
    // The known text really starts at letter 1 (ELPM...), but we say it starts at 0.
    const wrong = run(cipher, { mode: 'known', known: 'ELPMEOBI', size: 2, offset: 0 });
    expect(resultToText(wrong)).toContain(
      'No 2 × 2 matrix maps the known plaintext to the ciphertext',
    );
    expect(resultToText(wrong)).toContain('would fit if it started at letter 1');
    const right = run(cipher, { mode: 'known', known: 'ELPMEOBI', size: 2, offset: 1 });
    expect(resultToText(right)).toContain('Recovered the 2 × 2 key');
    expect(textOf(right, 'Plaintext')).toBe('HELPMEOBIWANKENOBI');
    // A different matrix size does not fit either.
    expect(resultToText(run(cipher, { mode: 'known', known: 'HELPMEOBIWAN', size: 3 }))).toContain(
      'No 3 × 3 matrix',
    );
  });

  it('is honest when there is too little to go on', () => {
    expect(() => run('HIAT', { mode: 'known', known: 'HEL', size: 2 })).toThrow(
      /at least 2 are needed \(4 letters/,
    );
    expect(() => run('HIAT', { mode: 'known', known: '', size: 2 })).toThrow(/known plaintext/);
    expect(() => run('HIAT', { mode: 'known', known: 'HELP', size: 2, offset: 9 })).toThrow(
      /cannot start at letter 9/,
    );
    expect(() => run('HIAT', { mode: 'known', known: 'HELP', size: 7 })).toThrow(/from 2 to 6/);
    // 16 letters of A fit every 4 x 4 matrix: far too many to list.
    const zeros = 'A'.repeat(32);
    expect(resultToText(run(zeros, { mode: 'known', known: 'A'.repeat(16), size: 4 }))).toContain(
      'too many 4 × 4 keys possible',
    );
  });

  it('solveKnown lists the exact family of solutions', () => {
    // K p = c for p = (0,1), c = (3,5): the second column of K is fixed, the first is free.
    const r = solveKnown(
      [
        [0, 1],
        [0, 1],
      ],
      [
        [3, 5],
        [3, 5],
      ],
      26,
    );
    expect(r.status).toBe('ok');
    expect(r.ranks).toEqual([
      { prime: 2, rank: 1 },
      { prime: 13, rank: 1 },
    ]);
    for (const k of r.keys) expect([k[0]![1], k[1]![1]]).toEqual([3, 5]);
    // 26 choices for each of the two free entries, 'invertible' keeps those with a unit determinant.
    expect(r.fits).toBe(26 * 26);
    expect(r.keys.length).toBeLessThan(26 * 26);
    expect(r.keys.length).toBeGreaterThan(0);
  });
});

describe('cracking a 2 x 2 cipher with no key', () => {
  const key: Matrix = [
    [5, 17],
    [4, 15],
  ];
  const prose = (p: string, n: number) =>
    p
      .replace(/[^A-Za-z]/g, '')
      .toUpperCase()
      .slice(0, n);

  it('recovers the key and readable plaintext from 200 letters of English', () => {
    for (const [p, k] of [
      [PROSE_A, key],
      [
        PROSE_B,
        [
          [3, 3],
          [2, 5],
        ],
      ],
      [
        PROSE_B.slice(40),
        [
          [9, 2],
          [5, 7],
        ],
      ],
    ] as [string, Matrix][]) {
      const plain = prose(p, 200);
      const cipher = encrypt(plain, k);
      const t0 = performance.now();
      const out = run(cipher, { mode: 'brute' });
      const ms = performance.now() - t0;
      expect(textOf(out, 'Plaintext')).toBe(plain);
      expect(resultToText(out)).toContain('The result reads like English');
      expect(resultToText(out)).toContain(`Numbers: ${k.flat().join(' ')}`);
      expect(resultToText(out)).toContain('Matrices tried: 157248');
      expect(ms).toBeLessThan(10_000);
    }
  });

  it('works from a shorter text, and on French with the French table', () => {
    const plain = prose(PROSE_B, 70);
    expect(textOf(run(encrypt(plain, key), { mode: 'brute' }), 'Plaintext')).toBe(plain);
    const french =
      'PERSONNENEVOUSADONNELACLEDECEMESSAGEALORSLORDINATEURAESSAYEDESMILLIERSDECARRESGARDECEUXQUIRESSEMBLAIENTUNPEUPLUSADUFRANCAIS';
    const out = run(encrypt(french, key), { mode: 'brute', language: 'french' });
    expect(textOf(out, 'Plaintext').startsWith(french)).toBe(true);
    expect(resultToText(out)).toContain('The result reads like French');
    expect(frenchQuadTable()).toBe(frenchQuadTable());
  });

  it('is deterministic and ranks every candidate it lists', () => {
    const cipher = encrypt(prose(PROSE_A, 160), key);
    const a = resultToText(run(cipher, { mode: 'brute' }));
    const b = resultToText(run(cipher, { mode: 'brute' }));
    expect(b).toBe(a);
    const t = tableOf(run(cipher, { mode: 'brute' }), 'Candidate keys');
    expect(t.rows).toHaveLength(12);
    const fits = t.rows.map((r) => Number(r[1]));
    expect([...fits].sort((x, y) => y - x)).toEqual(fits);
    expect(fits[0]!).toBeGreaterThan(-5);
    expect(fits[1]!).toBeLessThan(-5.5);
  });

  it('reports the key in the row convention as the transpose', () => {
    const plain = prose(PROSE_A, 160);
    // Row convention: the key K acts as K^T on column vectors.
    const cipher = encrypt(plain, transpose(key));
    const out = run(cipher, { mode: 'brute', convention: 'row' });
    expect(textOf(out, 'Plaintext')).toBe(plain);
    expect(resultToText(out)).toContain('Numbers: 5 17 4 15');
    const action = out.find((o) => o.type === 'actions') as Extract<Output, { type: 'actions' }>;
    expect(action.actions[0]!.options).toMatchObject({ key: '5 17 4 15', convention: 'row' });
    // ... which decrypts the same ciphertext in the tool.
    expect(textOf(run(cipher, { key: '5 17 4 15', convention: 'row' }), 'Plaintext')).toBe(plain);
  });

  it('does not claim a key for text that is not a 2 x 2 Hill cipher', () => {
    const rng = makeRng(5);
    const noise = Array.from({ length: 200 }, () =>
      String.fromCharCode(65 + Math.floor(rng() * 26)),
    ).join('');
    const out = resultToText(run(noise, { mode: 'brute' }));
    expect(out).not.toContain('The result reads like English');
    expect(out).toContain('still does not read like English');
    expect(out).toContain('Best guess (not reliable)');
    // A 3 x 3 cipher is not in reach of the 2 x 2 search.
    const three = encrypt(prose(PROSE_A, 240), [
      [6, 24, 1],
      [13, 16, 10],
      [20, 17, 15],
    ]);
    expect(resultToText(run(three, { mode: 'brute' }))).toContain(
      'still does not read like English',
    );
  });

  it('ranks on the first letters of a long text and decrypts all of it', () => {
    const plain = prose(PROSE_A + PROSE_B, 600);
    expect(plain.length).toBeGreaterThan(CRACK_LETTERS);
    const out = run(encrypt(plain, key), { mode: 'brute' });
    expect(textOf(out, 'Plaintext')).toBe(plain);
    expect(resultToText(out)).toContain(`ranked on the first ${CRACK_LETTERS} letters`);
  });

  it('keeps case, spaces and an odd last letter', () => {
    const text =
      'Nobody remembers who built the bridge, but every spring the villagers repaint its railings.';
    const cipher = encrypt(text, key);
    const spaced = cipher.slice(0, 20) + ' ' + cipher.slice(20, 41) + '!' + cipher.slice(41);
    const out = run(spaced, { mode: 'brute' });
    expect(textOf(out, 'Plaintext')).toContain(' ');
    expect(textOf(out, 'Plaintext')).toContain('!');
    expect(textOf(out, 'Plaintext').replace(/[^A-Za-z]/g, '')).toBe(
      text.replace(/[^A-Za-z]/g, '').toUpperCase() +
        (text.replace(/[^A-Za-z]/g, '').length % 2 ? 'X' : ''),
    );
  });

  it('refuses what it cannot do, with the way out', () => {
    expect(() => run('ABCDEFGHIJ', { mode: 'brute' })).toThrow(/Too short to crack/);
    expect(() => run(prose(PROSE_A, 100), { mode: 'brute', alphabet: 'az29' })).toThrow(
      /26-letter alphabet/,
    );
  });

  it('crackHill2 returns the best matrices first, by quadgram score', () => {
    const plain = prose(PROSE_A, 120);
    const cipher = encrypt(plain, key);
    const codes = Uint8Array.from(cipher, (c) => c.charCodeAt(0) - 65);
    const r = crackHill2(codes, { keep: 5 });
    expect(r.candidates).toHaveLength(5);
    expect(r.letters).toBe(120);
    const scores = r.candidates.map((c) => c.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    // The best decrypting matrix is the inverse of the key.
    expect(r.candidates[0]!.matrix).toEqual(invert(key, 26).inverse);
    expect(crackHill2(new Uint8Array(8)).candidates).toEqual([]);
  });
});
