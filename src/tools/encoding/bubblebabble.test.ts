import { describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors';
import { resultToText } from '../../core/result-text';
import type { Output } from '../../core/types';
import { fromHex, toHex, utf8Decode, utf8Encode } from '../../lib/bytes';
import bubblebabble, {
  BUBBLEBABBLE_SHAPE,
  bubbleBabbleDecode,
  bubbleBabbleEncode,
} from './bubblebabble';

// The test vectors of the Bubble Babble specification (Antti Huima, 2000).
const SPEC: [string, string][] = [
  ['', 'xexax'],
  ['1234567890', 'xesef-disof-gytuf-katof-movif-baxux'],
  ['Pineapple', 'xigak-nyryk-humil-bosek-sonax'],
];

// Made with the independent Python implementation (pip "bubblepy" 1.0) from seeded random bytes.
const PYTHON: [string, string][] = [
  ['', 'xexax'],
  ['61', 'ximex'],
  ['a5', 'xonex'],
  ['6162', 'ximek-dixux'],
  ['4dca', 'xifes-pixux'],
  ['182530', 'xekad-hasyx'],
  ['bb1d6d13', 'xovoc-taric-foxex'],
  ['2cded6237b', 'xerat-vuhed-fovix'],
  ['2ed91e3f721fcb19', 'xerit-nulif-zasic-zydec-nuxux'],
  ['71174494d6493c9d5c3460be31201e69', 'xisec-lucun-gahig-nizan-talef-gimyr-vosid-balak-noxax'],
  [
    'fedaa0eee8b9997f5c7c2999fdafe593253cd654',
    'xuzit-pymov-vipor-nakol-zelol-sapan-nyzop-zonen-funuf-saheh-gexox',
  ],
  [
    'af4dfad71427a0aeb3fee9232f8af2211f9ee491c5b10becb5563bfc1e6f93427e',
    'xorog-tivot-luhad-lomop-vysaz-vepyd-farum-pisad-calon-vanin-cecor-cudyv-sytah-kavuz-sylok-zagyg-dazyx',
  ],
  [
    toHex(utf8Encode('flag{bubble_babble}')),
    'xinik-samak-luvak-dotuk-dumok-sanih-zamak-cymak-deruk-hazex',
  ],
];

describe('bubble babble', () => {
  it.each(SPEC)('specification vector %j', (text, babble) => {
    expect(bubbleBabbleEncode(utf8Encode(text))).toBe(babble);
    expect(utf8Decode(bubbleBabbleDecode(babble).bytes)).toBe(text);
  });

  it.each(PYTHON)('matches the Python reference for %s', (hex, babble) => {
    expect(bubbleBabbleEncode(fromHex(hex))).toBe(babble);
    expect(toHex(bubbleBabbleDecode(babble).bytes)).toBe(hex);
    expect(BUBBLEBABBLE_SHAPE.test(babble)).toBe(true);
  });

  it('round-trips random bytes of every length from 0 to 70', () => {
    let seed = 2000;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) >> 8;
    for (let len = 0; len <= 70; len++) {
      const data = Uint8Array.from({ length: len }, () => rnd() & 0xff);
      const babble = bubbleBabbleEncode(data);
      expect(BUBBLEBABBLE_SHAPE.test(babble)).toBe(true);
      expect(toHex(bubbleBabbleDecode(babble).bytes)).toBe(toHex(data));
    }
  });

  it('ignores case, dashes and whitespace, and reads them from the text as given', () => {
    const plain = 'xesefdisofgytufkatofmovifbaxux';
    expect(utf8Decode(bubbleBabbleDecode(plain).bytes)).toBe('1234567890');
    expect(utf8Decode(bubbleBabbleDecode('XESEF-DISOF-GYTUF-KATOF-MOVIF-BAXUX').bytes)).toBe(
      '1234567890',
    );
    expect(
      utf8Decode(bubbleBabbleDecode('xesef-disof-\ngytuf-katof-\n  movif-baxux\n').bytes),
    ).toBe('1234567890');
  });

  it('rejects a string that does not start or end with x', () => {
    expect(() => bubbleBabbleDecode('esef-disof')).toThrow(
      /start with "x" but starts with "e" at position 1/,
    );
    expect(() => bubbleBabbleDecode('xesef-disof-gytuf-katof-movif-baxu')).toThrow(
      /end with "x" but ends with "u" at position 34/,
    );
    expect(() => bubbleBabbleDecode('')).toThrow(ToolError);
  });

  it('rejects a wrong length, wrong letters and the wrong kind of letter, with positions', () => {
    expect(() => bubbleBabbleDecode('xesef-disofx')).toThrow(/Wrong length/);
    // 'q' is not a Bubble Babble letter
    expect(() => bubbleBabbleDecode('xesqf-disof-gytuf-katof-movif-baxux')).toThrow(
      /"q" at position 4 is not a Bubble Babble letter/,
    );
    // a consonant where a vowel belongs (position 4 is the 3rd letter after x: vowel expected)
    expect(() => bubbleBabbleDecode('xessf-disof-gytuf-katof-movif-baxux')).toThrow(
      /"s" at position 4 should be a vowel/,
    );
    expect(() => bubbleBabbleDecode('xeeef-disof-gytuf-katof-movif-baxux')).toThrow(
      /"e" at position 3 should be a consonant/,
    );
    expect(() => bubbleBabbleDecode('xesex-disof-gytuf-katof-movif-baxux')).toThrow(
      /"x" at position 5 can only close/,
    );
  });

  it('checks the checksum chain and says which group is wrong', () => {
    // last vowel changed: the closing group no longer matches the running seed
    expect(() => bubbleBabbleDecode('xesef-disof-gytuf-katof-movif-baxax')).toThrow(
      /Checksum error: group 6 \(positions 32–34\)/,
    );
    // a changed letter in the middle shifts the seed for every later group
    expect(() => bubbleBabbleDecode('xesef-disof-gytyf-katof-movif-baxux')).toThrow(
      /Checksum error/,
    );
  });

  it('lenient mode decodes anyway and lists the groups', () => {
    const r = bubbleBabbleDecode('xesef-disof-gytuf-katof-movif-baxax', true);
    expect(utf8Decode(r.bytes)).toBe('1234567890');
    expect(r.problems).toEqual([{ group: 6, from: 32, to: 34 }]);
    expect(bubbleBabbleDecode('xesef-disof-gytuf-katof-movif-baxux', true).problems).toEqual([]);
  });
});

describe('bubble babble tool', () => {
  const run = (text: string, options: Record<string, unknown> = {}) =>
    bubblebabble.run({ bytes: utf8Encode(text) }, {
      mode: 'decode',
      lenient: false,
      ...options,
    } as never) as Output[];

  it('decodes and encodes', () => {
    expect(resultToText(run('xigak-nyryk-humil-bosek-sonax'))).toBe('Pineapple');
    expect(resultToText(run('Pineapple', { mode: 'encode' }))).toBe(
      'xigak-nyryk-humil-bosek-sonax',
    );
  });

  it('warns about every damaged group in lenient mode and fails otherwise', () => {
    const text = resultToText(run('xesef-disof-gytuf-katof-movif-baxax', { lenient: true }));
    expect(text).toContain('1234567890');
    expect(text).toContain('Checksum does not match in group 6');
    expect(() => run('xesef-disof-gytuf-katof-movif-baxax')).toThrow(ToolError);
  });

  it('detect: only the exact shape, checksum decides the score', () => {
    const sample = (text: string) => ({ text, bytes: new Uint8Array() });
    expect(
      bubblebabble.detect!(sample('xesef-disof-gytuf-katof-movif-baxux'))?.score,
    ).toBeGreaterThan(0.9);
    expect(bubblebabble.detect!(sample('xesef-disof-gytuf-katof-movif-baxax'))?.score).toBe(0.5);
    expect(bubblebabble.detect!(sample('xexax'))).toBeNull();
    expect(bubblebabble.detect!(sample('xylophone'))).toBeNull();
    expect(bubblebabble.detect!(sample('hello world'))).toBeNull();
    expect(bubblebabble.detect!(sample('xerox'))).toBeNull();
  });
});
