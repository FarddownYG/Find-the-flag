import { describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors';
import { fromHex, toHex, utf8Decode, utf8Encode } from '../../lib/bytes';
import base62, { base62Decode, base62Encode } from './base62';

describe('base62', () => {
  it('matches big-integer reference values (computed with Python int arithmetic)', () => {
    const flag = utf8Encode('flag{base62_big_int}');
    expect(base62Encode(flag)).toBe('Ec4uB45OsTQcNl9MM3lq1utLgFh');
    expect(base62Encode(flag, 'digitsLower')).toBe('eC4Ub45oStqCnL9mm3LQ1UTlGfH');
    expect(utf8Decode(base62Decode('Ec4uB45OsTQcNl9MM3lq1utLgFh'))).toBe('flag{base62_big_int}');
    expect(utf8Decode(base62Decode('eC4Ub45oStqCnL9mm3LQ1UTlGfH', 'digitsLower'))).toBe(
      'flag{base62_big_int}',
    );
  });

  it('small numbers: 61 -> "z", 62 -> "10", 255 -> "47", 256 -> "48"', () => {
    expect(base62Encode(Uint8Array.of(61))).toBe('z');
    expect(base62Encode(Uint8Array.of(0xff))).toBe('47'); // 4 * 62 + 7
    expect(base62Encode(Uint8Array.of(1, 0))).toBe('48'); // 4 * 62 + 8
    expect(toHex(base62Decode('10'))).toBe('3e'); // 62
    expect(base62Encode(Uint8Array.of(0x3e))).toBe('10');
  });

  it('preserves leading zero bytes as leading zero digits', () => {
    const data = fromHex('0000ff00');
    const enc = base62Encode(data);
    expect(enc.startsWith('00')).toBe(true);
    expect(toHex(base62Decode(enc))).toBe('0000ff00');
    expect(toHex(base62Decode('000'))).toBe('000000');
    expect(base62Encode(new Uint8Array())).toBe('');
  });

  it('round-trips binary in every order, including long inputs', () => {
    let seed = 99;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) >> 8;
    for (const abc of ['digitsUpper', 'digitsLower', 'lettersFirst'] as const) {
      for (const len of [1, 2, 5, 8, 9, 16, 33, 1000, 3000]) {
        const data = Uint8Array.from({ length: len }, () => rnd() & 0xff);
        expect(toHex(base62Decode(base62Encode(data, abc), abc))).toBe(toHex(data));
      }
    }
  });

  it('rejects symbols with the offending position', () => {
    expect(() => base62Decode('abc+def')).toThrow(ToolError);
    expect(() => base62Decode('abc+def')).toThrow(/position 4/);
    expect(() => base62Decode('abc=')).toThrow(ToolError);
  });
});

describe('base62 tool', () => {
  const run = (text: string, options: Record<string, unknown> = {}) =>
    base62.run({ bytes: utf8Encode(text) }, {
      mode: 'decode',
      alphabet: 'digitsUpper',
      ...options,
    } as never);

  it('decodes and encodes', async () => {
    const dec = await run('Ec4uB45OsTQcNl9MM3lq1utLgFh');
    expect(utf8Decode((dec[0] as { value: Uint8Array }).value)).toBe('flag{base62_big_int}');
    const enc = await run('flag{base62_big_int}', { mode: 'encode' });
    expect(enc).toEqual([{ type: 'text', value: 'Ec4uB45OsTQcNl9MM3lq1utLgFh' }]);
  });

  it('detect: picks the alphabet order that yields text', () => {
    const d = base62.detect!({ text: 'eC4Ub45oStqCnL9mm3LQ1UTlGfH', bytes: new Uint8Array() });
    expect(d?.options).toMatchObject({ alphabet: 'digitsLower' });
    expect(base62.detect!({ text: 'tooshort', bytes: new Uint8Array() })).toBeNull();
  });
});
