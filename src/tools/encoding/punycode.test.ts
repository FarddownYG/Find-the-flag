import { domainToASCII, domainToUnicode } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors';
import { resultToText } from '../../core/result-text';
import type { Output } from '../../core/types';
import { utf8Encode } from '../../lib/bytes';
import punycode, {
  decodeAceLabels,
  encodeDomains,
  punycodeDecode,
  punycodeEncode,
} from './punycode';

/** Code points (numbers) and plain text pieces, as in the RFC's listing. */
const cps = (...parts: (number | string)[]): string =>
  parts.map((p) => (typeof p === 'number' ? String.fromCodePoint(p) : p)).join('');

// RFC 3492 section 7.1, "Sample strings" (A)-(S). The same strings and results were produced by
// Python's independent encodings.punycode, in both directions.
/* prettier-ignore */
const RFC_3492: [string, string, string][] = [
  ['A Arabic (Egyptian)', cps(0x0644, 0x064a, 0x0647, 0x0645, 0x0627, 0x0628, 0x062a, 0x0643, 0x0644, 0x0645, 0x0648, 0x0634, 0x0639, 0x0631, 0x0628, 0x064a, 0x061f), 'egbpdaj6bu4bxfgehfvwxn'],
  ['B Chinese (simplified)', cps(0x4ed6, 0x4eec, 0x4e3a, 0x4ec0, 0x4e48, 0x4e0d, 0x8bf4, 0x4e2d, 0x6587), 'ihqwcrb4cv8a8dqg056pqjye'],
  ['C Chinese (traditional)', cps(0x4ed6, 0x5011, 0x7232, 0x4ec0, 0x9ebd, 0x4e0d, 0x8aaa, 0x4e2d, 0x6587), 'ihqwctvzc91f659drss3x8bo0yb'],
  ['D Czech', cps('Pro', 0x010d, 'prost', 0x011b, 'nemluv', 0x00ed, 0x010d, 'esky'), 'Proprostnemluvesky-uyb24dma41a'],
  ['E Hebrew', cps(0x05dc, 0x05de, 0x05d4, 0x05d4, 0x05dd, 0x05e4, 0x05e9, 0x05d5, 0x05d8, 0x05dc, 0x05d0, 0x05de, 0x05d3, 0x05d1, 0x05e8, 0x05d9, 0x05dd, 0x05e2, 0x05d1, 0x05e8, 0x05d9, 0x05ea), '4dbcagdahymbxekheh6e0a7fei0b'],
  ['F Hindi (Devanagari)', cps(0x092f, 0x0939, 0x0932, 0x094b, 0x0917, 0x0939, 0x093f, 0x0928, 0x094d, 0x0926, 0x0940, 0x0915, 0x094d, 0x092f, 0x094b, 0x0902, 0x0928, 0x0939, 0x0940, 0x0902, 0x092c, 0x094b, 0x0932, 0x0938, 0x0915, 0x0924, 0x0947, 0x0939, 0x0948, 0x0902), 'i1baa7eci9glrd9b2ae1bj0hfcgg6iyaf8o0a1dig0cd'],
  ['G Japanese (kanji and hiragana)', cps(0x306a, 0x305c, 0x307f, 0x3093, 0x306a, 0x65e5, 0x672c, 0x8a9e, 0x3092, 0x8a71, 0x3057, 0x3066, 0x304f, 0x308c, 0x306a, 0x3044, 0x306e, 0x304b), 'n8jok5ay5dzabd5bym9f0cm5685rrjetr6pdxa'],
  ['H Korean (Hangul syllables)', cps(0xc138, 0xacc4, 0xc758, 0xbaa8, 0xb4e0, 0xc0ac, 0xb78c, 0xb4e4, 0xc774, 0xd55c, 0xad6d, 0xc5b4, 0xb97c, 0xc774, 0xd574, 0xd55c, 0xb2e4, 0xba74, 0xc5bc, 0xb9c8, 0xb098, 0xc88b, 0xc744, 0xae4c), '989aomsvi5e83db1d2a355cv1e0vak1dwrv93d5xbh15a0dt30a5jpsd879ccm6fea98c'],
  ['I Russian (Cyrillic)', cps(0x043f, 0x043e, 0x0447, 0x0435, 0x043c, 0x0443, 0x0436, 0x0435, 0x043e, 0x043d, 0x0438, 0x043d, 0x0435, 0x0433, 0x043e, 0x0432, 0x043e, 0x0440, 0x044f, 0x0442, 0x043f, 0x043e, 0x0440, 0x0443, 0x0441, 0x0441, 0x043a, 0x0438), 'b1abfaaepdrnnbgefbadotcwatmq2g4l'],
  ['J Spanish', cps('Porqu', 0x00e9, 'nopuedensimplementehablarenEspa', 0x00f1, 'ol'), 'PorqunopuedensimplementehablarenEspaol-fmd56a'],
  ['K Vietnamese', cps('T', 0x1ea1, 'isaoh', 0x1ecd, 'kh', 0x00f4, 'ngth', 0x1ec3, 'ch', 0x1ec9, 'n', 0x00f3, 'iti', 0x1ebf, 'ngVi', 0x1ec7, 't'), 'TisaohkhngthchnitingVit-kjcr8268qyxafd2f1b9g'],
  ['L 3<nen>B<gumi><kinpachi><sensei>', cps('3', 0x5e74, 'B', 0x7d44, 0x91d1, 0x516b, 0x5148, 0x751f), '3B-ww4c5e180e575a65lsy2b'],
  ['M <amuro><namie>-with-SUPER-MONKEYS', cps(0x5b89, 0x5ba4, 0x5948, 0x7f8e, 0x6075, '-with-SUPER-MONKEYS'), '-with-SUPER-MONKEYS-pc58ag80a8qai00g7n9n'],
  ['N Hello-Another-Way-<sorezore><no><basho>', cps('Hello-Another-Way-', 0x305d, 0x308c, 0x305e, 0x308c, 0x306e, 0x5834, 0x6240), 'Hello-Another-Way--fc4qua05auwb3674vfr0b'],
  ['O <hitotsu><yane><no><shita>2', cps(0x3072, 0x3068, 0x3064, 0x5c4b, 0x6839, 0x306e, 0x4e0b, '2'), '2-u9tlzr9756bt3uc0v'],
  ['P Maji<de>Koi<suru>5<byou><mae>', cps('Maji', 0x3067, 'Koi', 0x3059, 0x308b, '5', 0x79d2, 0x524d), 'MajiKoi5-783gue6qz075azm5e'],
  ['Q <pafii>de<runba>', cps(0x30d1, 0x30d5, 0x30a3, 0x30fc, 'de', 0x30eb, 0x30f3, 0x30d0), 'de-jg4avhby1noc0d'],
  ['R <sono><supiido><de>', cps(0x305d, 0x306e, 0x30b9, 0x30d4, 0x30fc, 0x30c9, 0x3067), 'd9juau41awczczp'],
  ['S -> $1.00 <-', '-> $1.00 <-', '-> $1.00 <--'],
];

describe('punycode (RFC 3492)', () => {
  it.each(RFC_3492)('sample %s', (_name, unicode, ascii) => {
    expect(punycodeEncode(unicode)).toBe(ascii);
    expect(punycodeDecode(ascii)).toBe(unicode);
  });

  it('round-trips random strings from every plane', () => {
    let seed = 3492;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) >> 8) % n;
    const ranges: [number, number][] = [
      [0x20, 0x7e],
      [0xa1, 0x24f],
      [0x370, 0x3ff],
      [0x4e00, 0x9fff],
      [0x1f300, 0x1f5ff],
      [0x10000, 0x10fff],
    ];
    for (let n = 0; n < 200; n++) {
      const len = 1 + rnd(30);
      let s = '';
      for (let i = 0; i < len; i++) {
        const [a, b] = ranges[rnd(ranges.length)]!;
        s += String.fromCodePoint(a + rnd(b - a + 1));
      }
      expect(punycodeDecode(punycodeEncode(s))).toBe(s);
    }
  });

  it('handles ASCII-only text (a trailing "-") and the empty string', () => {
    expect(punycodeEncode('abc')).toBe('abc-');
    expect(punycodeDecode('abc-')).toBe('abc');
    expect(punycodeEncode('')).toBe('');
    expect(punycodeDecode('')).toBe('');
    expect(punycodeEncode('ü')).toBe('tda');
  });

  it('reads digits in either case', () => {
    expect(punycodeDecode('EGBPDAJ6BU4BXFGEHFVWXN')).toBe(RFC_3492[0]![1]);
  });

  it('explains what is wrong, with positions counted from the text given', () => {
    expect(() => punycodeDecode('bü-abc')).toThrow(/"ü" at position 2/);
    expect(() => punycodeDecode('abc-!!')).toThrow(/"!" at position 5 is not a Punycode digit/);
    expect(() => punycodeDecode('abc-!!', 10)).toThrow(/position 15/);
    expect(() => punycodeDecode('bcher-k')).toThrow(
      /ends in the middle of a number \(position 7\)/,
    );
    expect(() => punycodeDecode('99999999')).toThrow(/Overflow near position/);
    expect(() => punycodeDecode('99999999')).toThrow(ToolError);
  });
});

describe('domain names', () => {
  // Python's idna codec (IDNA 2003) for these; they contain nothing the mappings differ on.
  const PYTHON: [string, string][] = [
    ['bücher.example', 'xn--bcher-kva.example'],
    ['münchen.de', 'xn--mnchen-3ya.de'],
    ['日本語.jp', 'xn--wgv71a119e.jp'],
    ['пример.испытание', 'xn--e1afmkfd.xn--80akhbyknj4f'],
    ['παράδειγμα.δοκιμή', 'xn--hxajbheg2az3al.xn--jxalpdlp'],
    ['例え.テスト', 'xn--r8jz45g.xn--zckzah'],
  ];

  it.each(PYTHON)('%s <-> %s (Python idna)', (unicode, ascii) => {
    expect(encodeDomains(unicode).text).toBe(ascii);
    expect(decodeAceLabels(ascii).text).toBe(unicode);
  });

  it('agrees with the WHATWG URL implementation of Node (UTS 46) on domains of every script', () => {
    const domains = [
      'bücher.example',
      'BÜCHER.example',
      'faß.de',
      'ｂücher.example',
      'straße.münchen.de',
      '日本語.jp',
      'пример.испытание',
      'a.b.c.d.ü.example',
      'ünïcödé.test',
      '😀.example',
    ];
    for (const d of domains) {
      const expected = domainToASCII(d);
      expect(expected).not.toBe('');
      expect(encodeDomains(d).text.toLowerCase()).toBe(expected);
      expect(decodeAceLabels(expected).text).toBe(domainToUnicode(expected));
    }
  });

  it('decodes labels anywhere in a text (URLs, e-mail addresses, several domains)', () => {
    expect(
      decodeAceLabels('see https://xn--bcher-kva.example/x and a@xn--mnchen-3ya.de.').text,
    ).toBe('see https://bücher.example/x and a@münchen.de.');
    expect(decodeAceLabels('XN--BCHER-KVA.example').text).toBe('BüCHER.example'); // basic letters keep their case
    expect(decodeAceLabels('plain text, no labels').rows).toEqual([]);
    // "xn--" in the middle of a word is not a label
    expect(decodeAceLabels('foo-xn--bcher-kva').rows).toEqual([]);
  });

  it('encodes only the host of a URL or address, and leaves the rest alone', () => {
    const r = encodeDomains(
      'https://münchen.de:8080/pfad/ü?x=ü (bücher.example), user@bücher.example ｂücher。example.',
    );
    expect(r.text).toBe(
      'https://xn--mnchen-3ya.de:8080/pfad/ü?x=ü (xn--bcher-kva.example), user@xn--bcher-kva.example xn--bcher-kva.example.',
    );
    expect(r.rows).toHaveLength(4);
  });

  it('lists labels that were normalised and labels that are too long', () => {
    const r = encodeDomains(`ＢÜCHER.example ${'ü'.repeat(70)}.example`);
    expect(r.mapped[0]).toEqual({ from: 'ＢÜCHER', to: 'bücher' });
    expect(r.tooLong).toHaveLength(1);
    expect(encodeDomains(`${'a'.repeat(64)}.example`).tooLong).toHaveLength(1);
  });

  it('a label that does not decode throws, or is listed when lenient', () => {
    expect(() => decodeAceLabels('xn--bcher-k.example')).toThrow(/ends in the middle/);
    const r = decodeAceLabels('xn--bcher-k.example xn--bcher-kva.example', true);
    expect(r.failed).toEqual(['xn--bcher-k']);
    expect(r.text).toBe('xn--bcher-k.example bücher.example');
  });

  it('error positions point into the whole text', () => {
    expect(() => decodeAceLabels('see xn--bcher-k.example')).toThrow(/position 15/);
  });
});

describe('punycode tool', () => {
  const run = (text: string, options: Record<string, unknown> = {}) =>
    punycode.run({ bytes: utf8Encode(text) }, {
      mode: 'decode',
      form: 'domain',
      ...options,
    } as never) as Output[];

  it('decodes domains and shows a table of labels', () => {
    const out = run('xn--bcher-kva.example xn--mnchen-3ya.de');
    expect(out[0]).toEqual({ type: 'text', value: 'bücher.example münchen.de' });
    expect((out[1] as { rows: string[][] }).rows).toEqual([
      ['xn--bcher-kva', 'bücher'],
      ['xn--mnchen-3ya', 'münchen'],
    ]);
  });

  it('encodes domains', () => {
    expect(resultToText(run('münchen.de 日本語.jp', { mode: 'encode' }))).toContain(
      'xn--mnchen-3ya.de xn--wgv71a119e.jp',
    );
  });

  it('warns about a label that decodes to ASCII only', () => {
    expect(resultToText(run('xn--abc-.example'))).toContain('xn--abc- decodes to ASCII only');
  });

  it('says so when there is nothing to convert', () => {
    expect(resultToText(run('plain.example'))).toContain('No xn-- labels');
    expect(resultToText(run('plain.example', { mode: 'encode' }))).toContain('nothing to encode');
  });

  it('bare Punycode, line by line, with an xn-- prefix removed on decoding', () => {
    expect(resultToText(run('egbpdaj6bu4bxfgehfvwxn\nde-jg4avhby1noc0d', { form: 'raw' }))).toBe(
      `${RFC_3492[0]![1]}\n${RFC_3492[16]![1]}`,
    );
    expect(resultToText(run('Pročprostěnemluvíčesky', { form: 'raw', mode: 'encode' }))).toBe(
      'Proprostnemluvesky-uyb24dma41a',
    );
    const stripped = resultToText(run('xn--bcher-kva', { form: 'raw' }));
    expect(stripped).toContain('bücher');
    expect(stripped).toContain('removed');
  });

  it('bare mode errors name the position in the whole text', () => {
    expect(() => run('abc-\nabc-!!', { form: 'raw' })).toThrow(/position 10/);
  });

  it('detect: only text with an xn-- label that decodes', () => {
    const sample = (text: string) => ({ text, bytes: new Uint8Array() });
    expect(punycode.detect!(sample('https://xn--bcher-kva.example/'))?.score).toBeGreaterThan(0.9);
    expect(punycode.detect!(sample('xn--bcher-k.example'))?.score).toBe(0.5);
    expect(punycode.detect!(sample('bücher.example'))).toBeNull();
    expect(punycode.detect!(sample('hello world'))).toBeNull();
  });
});
