import { describe, expect, it } from 'vitest';
import { imitates } from './_unicode-hidden-scan';
import { algorithmicName, hangulName, loadUnicodeData, type NameContext } from './_unicode-lookup';

const data = await loadUnicodeData();

describe('Unicode 16.0.0 data', () => {
  it('knows the version', () => {
    expect(data.version).toBe('16.0.0');
  });

  it.each([
    [0x200b, 'ZERO WIDTH SPACE', 'Cf', 'General Punctuation'],
    [0x0430, 'CYRILLIC SMALL LETTER A', 'Ll', 'Cyrillic'],
    [0x0391, 'GREEK CAPITAL LETTER ALPHA', 'Lu', 'Greek and Coptic'],
    [0xe0041, 'TAG LATIN CAPITAL LETTER A', 'Cf', 'Tags'],
    [0xfe0f, 'VARIATION SELECTOR-16', 'Mn', 'Variation Selectors'],
    [0xac00, 'HANGUL SYLLABLE GA', 'Lo', 'Hangul Syllables'],
    [0x4e00, 'CJK UNIFIED IDEOGRAPH-4E00', 'Lo', 'CJK Unified Ideographs'],
    [0x2060, 'WORD JOINER', 'Cf', 'General Punctuation'],
    [0xfeff, 'ZERO WIDTH NO-BREAK SPACE', 'Cf', 'Arabic Presentation Forms-B'],
    [0x0000, 'NULL', 'Cc', 'Basic Latin'],
    [0x000a, 'LINE FEED', 'Cc', 'Basic Latin'],
    [0x00a0, 'NO-BREAK SPACE', 'Zs', 'Latin-1 Supplement'],
    [0x2028, 'LINE SEPARATOR', 'Zl', 'General Punctuation'],
    [0x0301, 'COMBINING ACUTE ACCENT', 'Mn', 'Combining Diacritical Marks'],
    [0xff21, 'FULLWIDTH LATIN CAPITAL LETTER A', 'Lu', 'Halfwidth and Fullwidth Forms'],
    [0x1d400, 'MATHEMATICAL BOLD CAPITAL A', 'Lu', 'Mathematical Alphanumeric Symbols'],
    [0x13a0, 'CHEROKEE LETTER A', 'Lu', 'Cherokee'],
    [0x0561, 'ARMENIAN SMALL LETTER AYB', 'Ll', 'Armenian'],
    [0x0251, 'LATIN SMALL LETTER ALPHA', 'Ll', 'IPA Extensions'],
    [0x24b6, 'CIRCLED LATIN CAPITAL LETTER A', 'So', 'Enclosed Alphanumerics'],
    [0x1f600, 'GRINNING FACE', 'So', 'Emoticons'],
  ])('U+%s is %s (%s, %s)', (cp, name, category, block) => {
    expect(data.name(cp)).toBe(name);
    expect(data.category(cp)).toBe(category);
    expect(data.block(cp)).toBe(block);
  });

  it('computes the names that follow a rule', () => {
    expect(data.name(0xd7a3)).toBe('HANGUL SYLLABLE HIH');
    expect(data.name(0xae00)).toBe('HANGUL SYLLABLE GEUL');
    expect(data.name(0xd55c)).toBe('HANGUL SYLLABLE HAN');
    expect(data.name(0x20000)).toBe('CJK UNIFIED IDEOGRAPH-20000');
    expect(data.name(0x3400)).toBe('CJK UNIFIED IDEOGRAPH-3400');
    expect(data.name(0x17000)).toBe('TANGUT IDEOGRAPH-17000');
    expect(data.name(0xf900)).toBe('CJK COMPATIBILITY IDEOGRAPH-F900');
    expect(data.name(0x2f800)).toBe('CJK COMPATIBILITY IDEOGRAPH-2F800');
    expect(data.name(0xfe00)).toBe('VARIATION SELECTOR-1');
    expect(data.name(0xe0100)).toBe('VARIATION SELECTOR-17');
    expect(data.name(0xe01ef)).toBe('VARIATION SELECTOR-256');
    expect(data.name(0xe0001)).toBe('LANGUAGE TAG');
    expect(data.name(0xe007f)).toBe('CANCEL TAG');
    expect(data.name(0xe0020)).toBe('TAG SPACE');
    expect(data.name(0xe0061)).toBe('TAG LATIN SMALL LETTER A');
    expect(data.name(0xe0030)).toBe('TAG DIGIT ZERO');
    expect(data.name(0xe007e)).toBe('TAG TILDE');
  });

  it('computes Hangul syllable names with the standard algorithm', () => {
    expect(hangulName(0xac00)).toBe('HANGUL SYLLABLE GA');
    expect(hangulName(0xac01)).toBe('HANGUL SYLLABLE GAG');
    expect(hangulName(0xb098)).toBe('HANGUL SYLLABLE NA');
    expect(hangulName(0xc548)).toBe('HANGUL SYLLABLE AN');
  });

  it('only names a code point by rule when the rule applies', () => {
    const ctx: NameContext = { name: () => null, category: () => 'Cn', range: () => null };
    expect(algorithmicName(0x41, ctx)).toBeNull();
    expect(algorithmicName(0xf900, ctx)).toBeNull(); // unassigned: no name
    expect(algorithmicName(0xe0041, ctx)).toBeNull(); // no ASCII name to build on
  });

  it('says what it does not bundle: no name, but a block and a category', () => {
    // U+0995 BENGALI LETTER KA: outside the bundled set.
    expect(data.name(0x0995)).toBeNull();
    expect(data.block(0x0995)).toBe('Bengali');
    expect(data.category(0x0995)).toBe('Lo');
    // Unassigned, private use, surrogate, noncharacter.
    expect(data.category(0x0378)).toBe('Cn');
    expect(data.category(0xe000)).toBe('Co');
    expect(data.category(0xd800)).toBe('Cs');
    expect(data.category(0xfffe)).toBe('Cn');
    expect(data.name(0xe000)).toBeNull();
    expect(data.block(0xe000)).toBe('Private Use Area');
    expect(data.block(0x10ffff)).toBe('Supplementary Private Use Area-B');
  });

  it('names every confusable source and every Cc Cf Zs Zl Zp Mn Me character', () => {
    for (const cp of data.skeleton.keys())
      expect(data.name(cp), `U+${cp.toString(16)}`).not.toBeNull();
    const wanted = new Set(['Cc', 'Cf', 'Zs', 'Zl', 'Zp', 'Mn', 'Me']);
    const missing: string[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (wanted.has(data.category(cp)) && data.name(cp) === null) missing.push(cp.toString(16));
    }
    expect(missing).toEqual([]);
  });

  it('names every assigned character of the blocks the tool promises', () => {
    const blocks = new Set([
      'Basic Latin',
      'Latin-1 Supplement',
      'Latin Extended-A',
      'Latin Extended-B',
      'IPA Extensions',
      'Greek and Coptic',
      'Cyrillic',
      'Armenian',
      'Cherokee',
      'Letterlike Symbols',
      'Halfwidth and Fullwidth Forms',
      'Mathematical Alphanumeric Symbols',
      'Enclosed Alphanumerics',
      'General Punctuation',
    ]);
    const missing: string[] = [];
    for (let cp = 0; cp <= 0x1ffff; cp++) {
      if (!blocks.has(data.block(cp)) || data.category(cp) === 'Cn') continue;
      if (data.name(cp) === null) missing.push(cp.toString(16));
    }
    expect(missing).toEqual([]);
  });
});

describe('confusables skeleton', () => {
  it('maps lookalikes to their ASCII skeleton', () => {
    expect(data.skeleton.get(0x0430)).toBe('a');
    expect(data.skeleton.get(0x03bf)).toBe('o');
    expect(data.skeleton.get(0x0406)).toBe('l'); // capital Cyrillic І: skeleton of I and l
    expect(data.skeleton.get(0x153)).toBe('oe');
    expect(data.skeleton.get(0x2019)).toBe("'");
    expect(data.asciiSkeleton.get('I')).toBe('l');
    expect(data.asciiSkeleton.get('0')).toBe('O');
    expect(data.asciiSkeleton.get('m')).toBe('rn');
    expect(data.compat.get(0xff21)).toBe('A');
    expect(data.compat.get(0x1d41a)).toBe('a');
  });

  it('keeps only skeletons made of ASCII, from non-ASCII characters', () => {
    for (const [cp, skeleton] of data.skeleton) {
      expect(cp).toBeGreaterThanOrEqual(0x80);
      expect(skeleton).toMatch(/^[\x20-\x7e]+$/);
    }
    expect(data.skeleton.size).toBeGreaterThan(1500);
  });

  it('resolves the prototypes l and O by case and category', () => {
    expect(imitates(data, 'Lu', 0x0406)).toBe('I'); // capital Cyrillic І
    expect(imitates(data, 'Ll', 0x2113)).toBeNull(); // letterlike: mathematics
    expect(imitates(data, 'Lu', 0x041e)).toBe('O');
    expect(imitates(data, 'Ll', 0x043e)).toBe('o');
    expect(imitates(data, 'Ll', 0x0430)).toBe('a');
  });

  it('does not take ordinary French (or other European) text for lookalikes', () => {
    const letters = 'àâäæçéèêëîïôöœùûüÿÀÂÄÆÇÉÈÊËÎÏÔÖŒÙÛÜŸáíóúñÑßłŁąęćńśźżčšžřůőűãõåøÅØþðÞ';
    for (const ch of letters) {
      const cp = ch.codePointAt(0)!;
      expect(imitates(data, data.category(cp), cp), ch).toBeNull();
    }
    for (const ch of '«»’‘“”…–—€°×÷²½¼·§¶©®™±µ ') {
      const cp = ch.codePointAt(0)!;
      expect(imitates(data, data.category(cp), cp), ch).toBeNull();
    }
  });
});
