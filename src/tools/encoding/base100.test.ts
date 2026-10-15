import { describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors';
import { resultToText } from '../../core/result-text';
import type { Output } from '../../core/types';
import { fromHex, toHex, utf8Decode, utf8Encode } from '../../lib/bytes';
import base100, { base100Decode, base100Encode, isBase100 } from './base100';

// Made with the independent Python implementation (pip "pybase100" 0.3.1), which works on the
// UTF-8 bytes (F0 9F, (b+55)/64+143, (b+55)%64+128) like the Rust crate "base100".
const PYTHON: [string, string][] = [
  ['', ''],
  ['00', '🏷'],
  ['ff', '📶'],
  ['68656c6c6f', '👟👜👣👣👦'],
  ['48656c6c6f2c20576f726c6421', '🐿👜👣👣👦🐣🐗👎👦👩👣👛🐘'],
  ['666c61677b656d6f6a695f626173653130307d', '👝👣👘👞👲👜👤👦👡👠👖👙👘👪👜🐨🐧🐧👴'],
  ['00112233445566778899aabbccddeeff', '🏷🐈🐙🐪🐻👌👝👮👿💐💡💲📃📔📥📶'],
];

/** The byte-level formula of the Rust crate, written independently of the tool. */
function rustEncode(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length * 4);
  bytes.forEach((b, i) => {
    out.set([240, 159, Math.floor((b + 55) / 64) + 143, ((b + 55) % 64) + 128], i * 4);
  });
  return out;
}

describe('base100', () => {
  it.each(PYTHON)('matches the Python reference for %s', (hex, emoji) => {
    expect(base100Encode(fromHex(hex))).toBe(emoji);
    expect(toHex(base100Decode(emoji).bytes)).toBe(hex);
  });

  it('every byte agrees with the Rust crate formula (UTF-8 level)', () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(utf8Encode(base100Encode(all))).toEqual(rustEncode(all));
  });

  it('maps byte 0 to U+1F3F7 and byte 255 to U+1F4F6', () => {
    expect(base100Encode(Uint8Array.of(0)).codePointAt(0)).toBe(0x1f3f7);
    expect(base100Encode(Uint8Array.of(255)).codePointAt(0)).toBe(0x1f4f6);
    expect(isBase100(0x1f3f6)).toBe(false);
    expect(isBase100(0x1f4f7)).toBe(false);
  });

  it('round-trips random bytes of many lengths', () => {
    let seed = 100;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) >> 8;
    for (const len of [0, 1, 2, 3, 15, 16, 17, 255, 1000]) {
      const data = Uint8Array.from({ length: len }, () => rnd() & 0xff);
      const text = base100Encode(data);
      expect([...text]).toHaveLength(len);
      expect(toHex(base100Decode(text).bytes)).toBe(toHex(data));
    }
  });

  it('ignores whitespace and variation selectors, and counts the selectors', () => {
    const r = base100Decode('👟 👜\n👣\u{fe0f}👣\t👦');
    expect(utf8Decode(r.bytes)).toBe('hello');
    expect(r.selectors).toBe(1);
    expect(r.skipped).toBe(0);
  });

  it('rejects other characters with their position and code point', () => {
    expect(() => base100Decode('👟👜hi')).toThrow(ToolError);
    expect(() => base100Decode('👟👜hi')).toThrow(/"h" \(U\+0068\) at position 3/);
    // an emoji outside the range, after an astral character (positions count characters)
    expect(() => base100Decode('👟😀')).toThrow(/\(U\+1F600\) at position 2/);
  });

  it('skip mode reads the emoji inside a sentence and says how much it left out', () => {
    const r = base100Decode('look: 👟👜👣👣👦 !!', true);
    expect(utf8Decode(r.bytes)).toBe('hello');
    expect(r.skipped).toBe(7); // "look:" and "!!" (spaces are not counted)
  });
});

describe('base100 tool', () => {
  const run = (text: string, options: Record<string, unknown> = {}) =>
    base100.run({ bytes: utf8Encode(text) }, {
      mode: 'decode',
      skip: false,
      ...options,
    } as never) as Output[];

  it('decodes, encodes and reports what it skipped', () => {
    expect(resultToText(run('👟👜👣👣👦'))).toBe('hello');
    expect(resultToText(run('hello', { mode: 'encode' }))).toBe('👟👜👣👣👦');
    const text = resultToText(run('a 👟👜👣👣👦 b', { skip: true }));
    expect(text).toContain('hello');
    expect(text).toContain('Characters left out: 2');
  });

  it('binary results get the usual hint', () => {
    expect(resultToText(run(base100Encode(Uint8Array.of(0xff, 0xfe, 0x00))))).toContain('binary');
  });

  it('reports bad input as ToolError', () => {
    expect(() => run('plain text')).toThrow(ToolError);
  });

  it('detect: emoji only, never ordinary text or emoji of another range', () => {
    const sample = (text: string) => ({ text, bytes: new Uint8Array() });
    expect(base100.detect!(sample('👟👜👣👣👦'))?.score).toBeGreaterThan(0.9);
    expect(base100.detect!(sample(base100Encode(Uint8Array.of(0, 1, 2, 3))))?.score).toBe(0.75);
    expect(base100.detect!(sample('hello 👟👜👣👣👦'))).toBeNull();
    expect(base100.detect!(sample('😀😀😀😀'))).toBeNull();
    expect(base100.detect!(sample('👟👜'))).toBeNull();
    expect(base100.detect!(sample('hello world'))).toBeNull();
  });
});
