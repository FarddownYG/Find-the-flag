import { describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors';
import { toHex, utf8Decode, utf8Encode } from '../../lib/bytes';
import base91, { BASE91_ALPHABET, base91Decode, base91Encode } from './base91';

describe('basE91', () => {
  it('has 91 distinct characters', () => {
    expect(BASE91_ALPHABET).toHaveLength(91);
    expect(new Set(BASE91_ALPHABET).size).toBe(91);
  });

  it('matches the reference implementation on known vectors', () => {
    expect(base91Encode(utf8Encode('test'))).toBe('fPNKd');
    expect(base91Encode(utf8Encode('flag{base91_is_dense}'))).toBe('@iH<,{,Hb%&@_@Elr}df6=8eEW');
    expect(utf8Decode(base91Decode('fPNKd'))).toBe('test');
    expect(utf8Decode(base91Decode('@iH<,{,Hb%&@_@Elr}df6=8eEW'))).toBe('flag{base91_is_dense}');
  });

  it('handles empty input and single bytes', () => {
    expect(base91Encode(new Uint8Array())).toBe('');
    expect(base91Decode('')).toHaveLength(0);
    for (let b = 0; b < 256; b++) {
      expect(Array.from(base91Decode(base91Encode(Uint8Array.of(b))))).toEqual([b]);
    }
  });

  it('round-trips binary of every length from 0 to 64 and a large buffer', () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) >> 8;
    for (let len = 0; len <= 64; len++) {
      const data = Uint8Array.from({ length: len }, () => rnd() & 0xff);
      expect(toHex(base91Decode(base91Encode(data)))).toBe(toHex(data));
    }
    const big = Uint8Array.from({ length: 5000 }, () => rnd() & 0xff);
    expect(toHex(base91Decode(base91Encode(big)))).toBe(toHex(big));
  });

  it('ignores whitespace when decoding', () => {
    expect(utf8Decode(base91Decode('fPN\n Kd'))).toBe('test');
  });

  it('rejects characters outside the alphabet', () => {
    expect(() => base91Decode('fPN-Kd')).toThrow(ToolError);
    expect(() => base91Decode("fPN'Kd")).toThrow(/position 4/);
    expect(() => base91Decode('fPN\\Kd')).toThrow(ToolError);
  });
});

describe('base91 tool', () => {
  const run = (text: string, mode: 'decode' | 'encode') =>
    base91.run({ bytes: utf8Encode(text) }, { mode });

  it('decodes and encodes', async () => {
    const dec = await run('fPNKd', 'decode');
    expect(utf8Decode((dec[0] as { value: Uint8Array }).value)).toBe('test');
    expect(await run('test', 'encode')).toEqual([{ type: 'text', value: 'fPNKd' }]);
  });

  it('detects basE91 text but leaves plain Base64 alone', () => {
    const d = base91.detect!({ text: '@iH<,{,Hb%&@_@Elr}df6=8eEW', bytes: new Uint8Array() });
    expect(d?.score).toBeGreaterThan(0.5);
    expect(
      base91.detect!({ text: 'ZmxhZ3tiYXNlNjRfaXNfbm90X2NyeXB0b30=', bytes: new Uint8Array() }),
    ).toBeNull();
  });
});
