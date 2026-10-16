import { afterEach, describe, expect, it } from 'vitest';
import { TOOLS } from '../core/registry';
import { setLocale, type Locale } from '../i18n';
import { matchScore, normalize, search } from './search';

const ids = (q: string, n = 50): string[] =>
  search(q)
    .slice(0, n)
    .map((t) => t.id);

afterEach(async () => {
  await setLocale('en');
});

/**
 * What a visitor looking for a base or a conversion must find, and in which order. Ties between
 * tools that all carry the exact word as an alias follow the registry order (category, then
 * name), so these are the results the sidebar and the Enter key give today.
 */
const EXPECTED: [query: string, first: string, alsoInTop: string[]][] = [
  ['octal', 'base-convert', ['charcode', 'number-base']],
  ['base 8', 'base-convert', ['number-base']],
  ['base8', 'base-convert', ['number-base']],
  ['décimal', 'base-convert', ['charcode', 'number-base']],
  ['decimal', 'base-convert', ['charcode', 'number-base']],
  ['base 10', 'base-convert', ['number-base']],
  ['hexa', 'hex', ['base-convert']],
  ['hexadécimal', 'hex', ['base-convert']],
  ['binaire', 'binary', ['base-convert']],
  ['base 2', 'binary', ['base-convert', 'number-base']],
  ['conversion', 'base-convert', ['number-base']],
  ['convertisseur', 'base-convert', ['number-base']],
  ['converter', 'base-convert', ['number-base']],
  ['ascii', 'base-convert', ['charcode']],
];

describe.each<Locale>(['en', 'fr'])('sidebar search, %s interface', (locale) => {
  it.each(EXPECTED)('%s finds the right tools first', async (query, first, also) => {
    await setLocale(locale);
    const found = ids(query);
    expect(found[0], `${query} → ${found.slice(0, 5).join(', ')}`).toBe(first);
    for (const id of also) expect(found.slice(0, 5), query).toContain(id);
  });
});

describe('base numbers', () => {
  it('a digit after "base" is the whole number, not the start of a longer one', () => {
    // Base32, Base36, Base58... and Base85, Base91, Base100 are not base 8, 10 or 2.
    for (const q of ['base 8', 'base8', 'base-8']) {
      expect(ids(q), q).not.toEqual(expect.arrayContaining(['base85']));
    }
    expect(ids('base 10')).not.toContain('base100');
    expect(ids('base10')).not.toContain('base100');
    for (const q of ['base 8', 'base 10', 'base 2']) {
      for (const id of ids(q)) expect(id, q).not.toMatch(/^base(?!-convert$)\d+$/);
    }
  });

  it('"base 64", "base64" and "base-64" are the same search', () => {
    expect(ids('base 64')).toEqual(ids('base64'));
    expect(ids('base-64')).toEqual(ids('base64'));
    expect(ids('Base 64')[0]).toBe('base64');
    expect(ids('base 58')[0]).toBe('base58');
    expect(ids('base 32')[0]).toBe('base32');
    expect(ids('base 100')[0]).toBe('base100');
  });

  it('a base nobody offers finds nothing, rather than every Base tool', () => {
    expect(ids('base 6')).toEqual([]);
    expect(ids('base 7')).toEqual([]);
    expect(ids('base 3')).toEqual([]);
  });

  it('"base" alone still lists the Base tools first', () => {
    expect(ids('base', 3).every((id) => id.startsWith('base'))).toBe(true);
  });

  it('mixes with another word', () => {
    expect(ids('base 64 decode')).toContain('base64');
    expect(ids('hex base 16')[0]).toBe('hex');
  });
});

describe('accents and case', () => {
  it('ignores accents on Latin letters in the query and in the tool text', () => {
    expect(ids('décimal')).toEqual(ids('decimal'));
    expect(ids('hexadécimal')).toEqual(ids('hexadecimal'));
    expect(ids('DÉCIMAL')).toEqual(ids('decimal'));
    expect(normalize('Hexadécimal')).toBe('hexadecimal');
    expect(normalize('Base 8')).toBe('base8');
    expect(normalize('BASE - 16')).toBe('base16');
    expect(normalize('database 8')).toBe('database 8');
  });

  it('leaves other scripts alone', () => {
    expect(normalize('Привет')).toBe('привет');
    expect(normalize('й')).toBe('й');
    expect(normalize('हिन्दी')).toBe('हिन्दी');
  });
});

describe('what already worked keeps working', () => {
  it.each([
    ['rot13', 'caesar'],
    ['hex', 'hex'],
    ['binary', 'binary'],
    ['base64', 'base64'],
    ['morse', 'morse'],
    ['xor', 'xor'],
  ])('%s opens %s first', (query, first) => {
    expect(ids(query)[0]).toBe(first);
  });

  it('an empty search lists every tool, in registry order', () => {
    expect(search('').map((t) => t.id)).toEqual(TOOLS.map((t) => t.id));
    expect(search('   ').map((t) => t.id)).toEqual(TOOLS.map((t) => t.id));
  });

  it('every word must match', () => {
    expect(ids('hex zzzzqqq')).toEqual([]);
    const both = ids('binary octal');
    expect(both).toContain('base-convert');
  });

  it('scores an exact alias above a prefix above a mention', () => {
    const convert = TOOLS.find((t) => t.id === 'base-convert')!;
    expect(matchScore(convert, 'octal')).toBe(100);
    expect(matchScore(convert, 'octa')).toBe(70);
    expect(matchScore(convert, 'zzzz')).toBe(0);
  });
});
