import { describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors';
import { utf8Decode, utf8Encode } from '../../lib/bytes';
import base32, { base32Decode, base32Encode } from './base32';

const RFC4648: [string, string, string][] = [
  ['', '', ''],
  ['f', 'MY======', 'CO======'],
  ['fo', 'MZXQ====', 'CPNG===='],
  ['foo', 'MZXW6===', 'CPNMU==='],
  ['foob', 'MZXW6YQ=', 'CPNMUOG='],
  ['fooba', 'MZXW6YTB', 'CPNMUOJ1'],
  ['foobar', 'MZXW6YTBOI======', 'CPNMUOJ1E8======'],
];

describe('base32', () => {
  it.each(RFC4648)('RFC 4648 vector %j', (plain, std, hex) => {
    expect(base32Encode(utf8Encode(plain), 'std')).toBe(std);
    expect(base32Encode(utf8Encode(plain), 'hex')).toBe(hex);
    expect(utf8Decode(base32Decode(std, 'std'))).toBe(plain);
    expect(utf8Decode(base32Decode(hex, 'hex'))).toBe(plain);
  });

  it('decodes leniently: lowercase, whitespace, missing padding', () => {
    expect(utf8Decode(base32Decode('mzxw 6ytb\noi', 'std'))).toBe('foobar');
    expect(utf8Decode(base32Decode('MZXW6YQ', 'std'))).toBe('foob');
  });

  it('can omit padding when encoding', () => {
    expect(base32Encode(utf8Encode('foob'), 'std', false)).toBe('MZXW6YQ');
  });

  it('round-trips every byte value with every alphabet', () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    for (const abc of ['std', 'hex', 'crockford'] as const) {
      for (let len = 0; len < 12; len++) {
        const part = all.subarray(250 - len, 250);
        expect(Array.from(base32Decode(base32Encode(part, abc), abc))).toEqual(Array.from(part));
      }
      expect(Array.from(base32Decode(base32Encode(all, abc), abc))).toEqual(Array.from(all));
    }
  });

  it('Crockford: never padded, I/L/O are forgiven, hyphens ignored', () => {
    const enc = base32Encode(utf8Encode('foobar'), 'crockford');
    expect(enc).toBe('CSQPYRK1E8');
    expect(utf8Decode(base32Decode('csqpyrk1e8', 'crockford'))).toBe('foobar');
    expect(utf8Decode(base32Decode('CSQP-YRKl-E8', 'crockford'))).toBe('foobar');
    expect(Array.from(base32Decode('OIL0', 'crockford'))).toEqual(
      Array.from(base32Decode('0110', 'crockford')),
    );
  });

  it('rejects characters outside the alphabet with a helpful hint', () => {
    expect(() => base32Decode('MZXW6YT1', 'std')).toThrow(ToolError);
    expect(() => base32Decode('MZXW6YT1', 'std')).toThrow(/base32hex/);
    expect(() => base32Decode('MZXW-6YTB', 'std')).toThrow(/position 5/);
  });

  it('rejects an impossible length', () => {
    expect(() => base32Decode('MZXW6Y', 'std')).toThrow(ToolError);
    expect(() => base32Decode('MZXW6Y', 'std')).toThrow(/Truncated/);
    expect(() => base32Decode('M', 'std')).toThrow(ToolError);
  });
});

describe('base32 tool', () => {
  const run = (text: string, options: Record<string, unknown> = {}) =>
    base32.run({ bytes: utf8Encode(text) }, {
      mode: 'decode',
      alphabet: 'std',
      pad: true,
      ...options,
    } as never);

  it('decodes to a bytes block', async () => {
    const out = await run('MZWGCZ33MJQXGZJTGJPWS427NZXXIX3DOJ4XA5DPPU======');
    expect(out[0]).toMatchObject({ type: 'bytes' });
    expect(utf8Decode((out[0] as { value: Uint8Array }).value)).toBe('flag{base32_is_not_crypto}');
  });

  it('encodes to text', async () => {
    expect(await run('foobar', { mode: 'encode' })).toEqual([
      { type: 'text', value: 'MZXW6YTBOI======' },
    ]);
  });

  it('detects uppercase base32 with padding', () => {
    const d = base32.detect!({
      text: 'MZWGCZ33MJQXGZJTGJPWS427NZXXIX3DOJ4XA5DPPU======',
      bytes: new Uint8Array(),
    });
    expect(d?.score).toBeGreaterThan(0.8);
    expect(base32.detect!({ text: 'hello world', bytes: new Uint8Array() })).toBeNull();
    expect(base32.detect!({ text: null, bytes: new Uint8Array() })).toBeNull();
  });
});
