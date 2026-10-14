import { describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors';
import { fromHex, toHex, utf8Decode, utf8Encode } from '../../lib/bytes';
import base58, { base58Decode, base58Encode } from './base58';

// Bitcoin Core's base58_encode_decode.json
const VECTORS: [string, string][] = [
  ['', ''],
  ['61', '2g'],
  ['626262', 'a3gV'],
  ['636363', 'aPEr'],
  ['73696d706c792061206c6f6e6720737472696e67', '2cFupjhnEsSn59qHXstmK2ffpLv2'],
  ['00eb15231dfceb60925886b67d065299925915aeb172c06647', '1NS17iag9jJgTHD1VXjvLCEnZuQ3rJDE9L'],
  ['516b6fcd0f', 'ABnLTmg'],
  ['bf4f89001e670274dd', '3SEo3LWLoPntC'],
  ['572e4794', '3EFU7m'],
  ['ecac89cad93923c02321', 'EJDM8drfXA6uyA'],
  ['10c8511e', 'Rt5zm'],
  ['00000000000000000000', '1111111111'],
  ['0000000f', '111G'],
];

describe('base58', () => {
  it.each(VECTORS)('Bitcoin Core vector %s', (hex, b58) => {
    expect(base58Encode(fromHex(hex))).toBe(b58);
    expect(toHex(base58Decode(b58))).toBe(hex);
  });

  it('matches known text vectors', () => {
    expect(base58Encode(utf8Encode('Hello World!'))).toBe('2NEpo7TZRRrLZSi2U');
    expect(base58Encode(utf8Encode('The quick brown fox jumps over the lazy dog.'))).toBe(
      'USm3fpXnKG5EUBx2ndxBDMPVciP5hGey2Jh4NDv6gmeo1LkMeiKrLJUUBk6Z',
    );
    expect(base58Encode(utf8Encode('Hello World!'), 'flickr')).toBe('2nePN7syqqRkyrH2t');
  });

  it('keeps leading zero bytes and handles all-zero input', () => {
    const data = Uint8Array.from([0, 0, 0, 1, 2, 3]);
    expect(base58Encode(data)).toMatch(/^111/);
    expect(Array.from(base58Decode(base58Encode(data)))).toEqual(Array.from(data));
    expect(Array.from(base58Decode('111'))).toEqual([0, 0, 0]);
  });

  it('round-trips random-looking binary of many lengths in every alphabet', () => {
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) >> 8;
    for (const abc of ['bitcoin', 'flickr', 'ripple'] as const) {
      for (const len of [1, 2, 7, 8, 9, 31, 32, 33, 200, 1500]) {
        const data = Uint8Array.from({ length: len }, () => rnd() & 0xff);
        expect(toHex(base58Decode(base58Encode(data, abc), abc))).toBe(toHex(data));
      }
    }
  });

  it('ignores whitespace when decoding', () => {
    expect(utf8Decode(base58Decode('2NEpo7TZ\n RRrLZSi2U'))).toBe('Hello World!');
  });

  it('rejects look-alike characters with an explanation', () => {
    for (const bad of ['0abc', 'abcO', 'Iabc', 'abcl']) {
      expect(() => base58Decode(bad)).toThrow(ToolError);
    }
    expect(() => base58Decode('2NEpo0TZ')).toThrow(/look-alikes/);
    expect(() => base58Decode('2NEpo+TZ')).toThrow(/position 6/);
  });
});

describe('base58 tool', () => {
  const run = (text: string, options: Record<string, unknown> = {}) =>
    base58.run({ bytes: utf8Encode(text) }, {
      mode: 'decode',
      alphabet: 'bitcoin',
      ...options,
    } as never);

  it('decodes a flag', async () => {
    const out = await run('48uXsVXpkFDMtHVURyP3maKiZdwgoeM5BR3S');
    expect(utf8Decode((out[0] as { value: Uint8Array }).value)).toBe('flag{base58_no_lookalikes}');
  });

  it('reports bad input as ToolError', async () => {
    await expect(Promise.resolve().then(() => run('not base58 0OIl'))).rejects.toThrow(ToolError);
  });

  it('detects base58 that decodes to text, not plain words', () => {
    const sample = (text: string) => ({ text, bytes: new Uint8Array() });
    expect(base58.detect!(sample('48uXsVXpkFDMtHVURyP3maKiZdwgoeM5BR3S'))?.score).toBeGreaterThan(
      0.7,
    );
    expect(base58.detect!(sample('hello world'))).toBeNull();
    expect(base58.detect!(sample('0000000000000000'))).toBeNull();
  });
});
