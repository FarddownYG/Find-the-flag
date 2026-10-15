import { describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors';
import { resultToText } from '../../core/result-text';
import type { ToolResult } from '../../core/types';
import tool, { adfgvxDecrypt, adfgvxEncrypt, makeSquare } from './adfgvx';
import { parseColumnKey } from './_transposition';

type Options = Parameters<typeof tool.run>[1];

const run = (text: string, options: Partial<Options> = {}): ToolResult =>
  tool.run(text, {
    variant: 'adfgvx',
    mode: 'decrypt',
    square: '',
    fill: 'letters',
    key: 'PRIVACY',
    labels: '',
    group: false,
    ...options,
  }) as ToolResult;

const first = (r: ToolResult): string => {
  const block = r[0];
  if (block?.type !== 'text') throw new Error('first block is not text');
  return block.value;
};

// Wikipedia, "ADFGVX cipher": this square, the key PRIVACY and the message "Attack at 1200AM".
const WIKI_SQUARE = 'NA1C3H8TB2OME5WRPD4F6G7I9J0KLQSUVXYZ';
const WIKI_STREAM = 'ADDDDDADAGVGADDDAFDGVFVFADDX';
const WIKI_CIPHER = 'DGDDDAGDDGAFADDFDADVDVFAADVX';

describe('ADFGVX (published example)', () => {
  const sq = makeSquare('adfgvx', WIKI_SQUARE, '', 'letters');
  const key = parseColumnKey('PRIVACY');

  it('fractionates and transposes Attack at 1200AM to the published ciphertext', () => {
    const r = adfgvxEncrypt('Attack at 1200AM', sq, key);
    expect(r.stream.join('')).toBe(WIKI_STREAM);
    expect(r.cipher.join('')).toBe(WIKI_CIPHER);
    expect(r.skipped).toBe(0);
  });

  it('decrypts it back, with or without the groups of four', () => {
    expect(adfgvxDecrypt(WIKI_CIPHER, sq, key).plain).toBe('ATTACKAT1200AM');
    expect(adfgvxDecrypt('DGDD DAGD DGAF ADDF DADV DVFA ADVX', sq, key).plain).toBe(
      'ATTACKAT1200AM',
    );
    expect(adfgvxDecrypt(WIKI_CIPHER.toLowerCase(), sq, key).plain).toBe('ATTACKAT1200AM');
    expect(adfgvxDecrypt(WIKI_CIPHER, sq, key).stream.join('')).toBe(WIKI_STREAM);
  });

  it('shows the three steps in the tool', () => {
    const out = resultToText(
      run('DGDD DAGD DGAF ADDF DADV DVFA ADVX', { square: WIKI_SQUARE, key: 'PRIVACY' }),
    );
    expect(out).toContain('ATTACKAT1200AM');
    expect(out).toContain('AD DD DD AD AG VG AD DD AF DG VF VF AD DX');
    expect(out).toContain('Transposition grid');
    expect(out).toContain('Square');
  });
});

describe('squares', () => {
  it('completes a keyword with the rest of the alphabet', () => {
    expect(makeSquare('adfgx', 'ZEBRAS', '', 'letters').cells.join('')).toBe(
      'ZEBRASCDFGHIKLMNOPQTUVWXY',
    );
    expect(makeSquare('adfgvx', 'ZEBRA', '', 'letters').cells.join('')).toBe(
      'ZEBRACDFGHIJKLMNOPQSTUVWXY0123456789',
    );
    expect(makeSquare('adfgvx', 'ZEBRA', '', 'digits').cells.join('')).toBe(
      'ZEBRA0123456789CDFGHIJKLMNOPQSTUVWXY',
    );
    expect(makeSquare('adfgvx', 'a1b2', '', 'letters').cells.join('').startsWith('A1B2CDEF')).toBe(
      true,
    );
  });

  it('takes a full square as it is, in any order and with any characters', () => {
    const full = 'ph0qg64mea1yl2nofdxkr3cvs5zw7bj9uti8';
    const sq = makeSquare('adfgvx', full, '', 'letters');
    expect(sq.cells.join('')).toBe(full.toUpperCase());
    expect(sq.size).toBe(6);
    // 25 distinct letters make a 5 x 5 square even without the I.
    const five = makeSquare('adfgx', 'ABCDEFGHJKLMNOPQRSTUVWXYZ', '', 'letters');
    expect(five.cells.join('')).toBe('ABCDEFGHJKLMNOPQRSTUVWXYZ');
    // ... in which an I is read as the J that is there.
    expect(five.index.get('I')).toBe(five.index.get('J'));
    expect(five.merged).toBe(true);
  });

  it('merges I and J in a 5 x 5 square', () => {
    const sq = makeSquare('adfgx', 'KEYWORD', '', 'letters');
    expect(sq.index.get('J')).toBe(sq.index.get('I'));
    const key = parseColumnKey('NEBEL');
    const a = adfgvxEncrypt('JIB', sq, key).cipher.join('');
    const b = adfgvxEncrypt('IIB', sq, key).cipher.join('');
    expect(a).toBe(b);
  });

  it('names the rows and columns with your own letters', () => {
    const sq = makeSquare('adfgvx', WIKI_SQUARE, 'abcdef', 'letters');
    expect(sq.labels).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
    const key = parseColumnKey('PRIVACY');
    const cipher = adfgvxEncrypt('Attack at 1200AM', sq, key).cipher.join('');
    // The default letters A D F G V X are the 1st to 6th labels: translate the published ciphertext.
    const map: Record<string, string> = { A: 'A', D: 'B', F: 'C', G: 'D', V: 'E', X: 'F' };
    expect(cipher).toBe([...WIKI_CIPHER].map((c) => map[c]).join(''));
    expect(adfgvxDecrypt(cipher, sq, key).plain).toBe('ATTACKAT1200AM');
  });

  it('rejects coordinate letters that cannot name the rows', () => {
    expect(() => makeSquare('adfgvx', '', 'ABCDE', 'letters')).toThrow(/exactly 6/);
    expect(() => makeSquare('adfgx', '', 'AABCD', 'letters')).toThrow(ToolError);
    expect(makeSquare('adfgx', '', '1 2 3 4 5', 'letters').labels).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
    ]);
  });
});

describe('round trips', () => {
  const keys = ['PRIVACY', 'A', 'BA', '3 1 2', 'NEBEL', 'LONGERKEYTHANTHEMESSAGEITSELF'];
  const message = 'The quick brown fox jumps over 13 lazy dogs at 0900 and 1530 hours';

  it('ADFGVX with digits, for several squares and keys', () => {
    for (const square of ['', 'ZEBRAS', WIKI_SQUARE, 'ph0qg64mea1yl2nofdxkr3cvs5zw7bj9uti8']) {
      for (const key of keys) {
        const sq = makeSquare('adfgvx', square, '', 'letters');
        const k = parseColumnKey(key);
        const cipher = adfgvxEncrypt(message, sq, k).cipher.join('');
        const expected = message.toUpperCase().replace(/[^A-Z0-9]/g, '');
        expect(adfgvxDecrypt(cipher, sq, k).plain, `${square} ${key}`).toBe(expected);
      }
    }
  });

  it('ADFGX, with I and J merged and digits left out', () => {
    for (const key of keys) {
      const sq = makeSquare('adfgx', 'GERMANY', '', 'letters');
      const k = parseColumnKey(key);
      const r = adfgvxEncrypt(message, sq, k);
      // The digits of 13, 0900 and 1530 have no cell in a 5 x 5 square.
      expect(r.skipped).toBe(10);
      const expected = message
        .toUpperCase()
        .replace(/[^A-Z]/g, '')
        .replace(/J/g, 'I');
      expect(adfgvxDecrypt(r.cipher.join(''), sq, k).plain).toBe(expected);
    }
  });
});

describe('self-made samples', () => {
  // scripts/gen-samples-transposition.mjs writes the same ciphers again, independently of this tool.
  it('ADFGX with a keyword square matches the independent implementation', () => {
    const sq = makeSquare('adfgx', 'GERMANY', '', 'letters');
    const key = parseColumnKey('NEBEL');
    const cipher = 'FAAGDDDDGXAFXFXGFAFFGADFDFAFXDAAFAADAXFDDAGDXFAXGDAFFXFXGAAF';
    expect(adfgvxEncrypt('THEFLAGISHIDDENINTHESQUAREGRID', sq, key).cipher.join('')).toBe(cipher);
    expect(adfgvxDecrypt(cipher, sq, key).plain).toBe('THEFLAGISHIDDENINTHESQUAREGRID');
  });

  it('ADFGVX with a keyword square and the coordinate letters ABCDEF', () => {
    const sq = makeSquare('adfgvx', 'ENIGMA', 'ABCDEF', 'letters');
    const key = parseColumnKey('LANTERN');
    const cipher = 'EAFAFEABBDECABCDAFAFAADCDAAEFABCECADCEBE';
    expect(adfgvxEncrypt('MEETATBRIDGE12AT0900', sq, key).cipher.join('')).toBe(cipher);
    expect(adfgvxDecrypt(cipher, sq, key).plain).toBe('MEETATBRIDGE12AT0900');
  });
});

describe('the tool', () => {
  it('encrypts in groups of five and counts what it left out', () => {
    const r = run('Attack at 1200AM!', {
      mode: 'encrypt',
      square: WIKI_SQUARE,
      group: true,
    });
    expect(first(r)).toBe('DGDDD AGDDG AFADD FDADV DVFAA DVX');
    expect(resultToText(r)).toContain('1 character has no cell in the square');
  });

  it('works on a 5 x 5 square and tells that I and J are one', () => {
    const cipher = adfgvxEncrypt(
      'JUST IN TIME',
      makeSquare('adfgx', 'ZEBRAS', '', 'letters'),
      parseColumnKey('NEBEL'),
    ).cipher.join('');
    const r = run(cipher, { variant: 'adfgx', square: 'ZEBRAS', key: 'NEBEL' });
    expect(first(r)).toBe('IUSTINTIME');
    expect(resultToText(r)).toContain('I and J share a cell');
    // The other tools are named so a stuck solver knows where to go next.
    expect(resultToText(r)).toContain('Polybius / Tap code');
    expect(resultToText(r)).toContain('Columnar transposition');
    expect(resultToText(r)).not.toMatch(/tool\.adfgvx\./);
  });

  it('shows the flag form of a decoded flag', () => {
    const sq = makeSquare('adfgx', 'ZEBRAS', '', 'letters');
    const key = parseColumnKey('NEBEL');
    const cipher = adfgvxEncrypt('FLAGFRACTIONATED', sq, key).cipher.join('');
    expect(
      resultToText(run(cipher, { variant: 'adfgx', square: 'ZEBRAS', key: 'NEBEL' })),
    ).toContain('flag{fractionated}');
  });

  it('explains what is wrong', () => {
    expect(() => run('ADFG XD', { key: 'PRIVACY' })).not.toThrow();
    expect(() => run('ADFGZ', { key: 'PRIVACY' })).toThrow(/character “Z”/);
    expect(() => run('ADF', { key: 'PRIVACY' })).toThrow(/even number/);
    expect(() => run('AD', { key: '' })).toThrow(/Enter a key/);
    expect(() => run('', { key: 'PRIVACY' })).toThrow(/Paste the ciphertext/);
    expect(() => run('12 !', { mode: 'encrypt', variant: 'adfgx' })).toThrow(/Nothing to encrypt/);
  });

  it('suggests itself for text made of the coordinate letters only', () => {
    const d = tool.detect!({ text: WIKI_CIPHER, bytes: new Uint8Array() });
    expect(d?.options).toEqual({ variant: 'adfgvx', mode: 'decrypt' });
    // All six letters in use: it outranks a generic guess such as Base64 (0.8).
    expect(d!.score).toBeGreaterThan(0.8);
    // Four of the letters only: a weaker guess.
    expect(tool.detect!({ text: 'ADFG'.repeat(8), bytes: new Uint8Array() })!.score).toBeLessThan(
      0.6,
    );
    expect(tool.detect!({ text: 'ADFGX'.repeat(8), bytes: new Uint8Array() })?.options).toEqual({
      variant: 'adfgx',
      mode: 'decrypt',
    });
    expect(tool.detect!({ text: 'HELLO WORLD THIS IS TEXT', bytes: new Uint8Array() })).toBeNull();
    expect(tool.detect!({ text: 'ADFGVX', bytes: new Uint8Array() })).toBeNull();
  });
});
