import { describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors';
import { toHex, utf8Decode, utf8Encode } from '../../lib/bytes';
import base85, { base85Decode, base85Encode } from './base85';

const bytesOf = (s: string) => utf8Encode(s);

describe('base85', () => {
  it('matches Python base64.b85encode (RFC 1924 alphabet) outputs', () => {
    expect(base85Encode(bytesOf('hello'), 'rfc1924')).toBe('Xk~0{Zv');
    expect(base85Encode(bytesOf('a'), 'rfc1924')).toBe('VE');
    expect(base85Encode(bytesOf('ab'), 'rfc1924')).toBe('VPX');
    expect(base85Encode(bytesOf('abc'), 'rfc1924')).toBe('VPaz');
    expect(base85Encode(new Uint8Array(4), 'rfc1924')).toBe('00000');
    expect(base85Encode(Uint8Array.of(255, 255, 255, 255), 'rfc1924')).toBe('|NsC0');
    expect(base85Encode(bytesOf('flag{rfc1924_like_git}'), 'rfc1924')).toBe(
      'W^7?+dva!DF*!0cUu<b>WnX7$bbS',
    );
  });

  it('matches Python base64.a85encode outputs', () => {
    expect(base85Encode(bytesOf('hello'), 'ascii85')).toBe('BOu!rDZ');
    expect(base85Encode(bytesOf('hello'), 'ascii85', true)).toBe('<~BOu!rDZ~>');
    expect(base85Encode(bytesOf('Man is distinguished'), 'ascii85')).toBe(
      '9jqo^BlbD-BleB1DJ+*+F(f,q',
    );
    expect(base85Encode(bytesOf('flag{ascii85_is_denser}'), 'ascii85', true)).toBe(
      '<~Ao(mgHXUu*Bk]Oa?YORgA7]Y"ATE2~>',
    );
  });

  it('uses the z shortcut for four zero bytes (Ascii85 only)', () => {
    expect(base85Encode(Uint8Array.of(0, 0, 0, 0, 97, 98, 99, 100), 'ascii85')).toBe('z@:E_W');
    expect(base85Encode(new Uint8Array(5), 'ascii85')).toBe('z!!');
    expect(toHex(base85Decode('z@:E_W'))).toBe('0000000061626364');
    expect(toHex(base85Decode('z!!'))).toBe('0000000000');
  });

  it('Z85: ZeroMQ spec example and a flag', () => {
    const spec = Uint8Array.of(0x86, 0x4f, 0xd2, 0x6f, 0xb5, 0x59, 0xf7, 0x5b);
    expect(base85Encode(spec, 'z85')).toBe('HelloWorld');
    expect(toHex(base85Decode('HelloWorld', 'z85'))).toBe('864fd26fb559f75b');
    expect(utf8Decode(base85Decode('w]7)*DWomzz/6G3Dn)^g', 'z85'))).toBe('flag{zeromq_z85}');
    // z is just a digit in Z85, not a shortcut
    expect(base85Encode(new Uint8Array(4), 'z85')).toBe('00000');
  });

  it('decodes the optional <~ ~> frame and ignores whitespace', () => {
    expect(utf8Decode(base85Decode('<~ 9jqo^BlbD-\n BleB1DJ+*+F(f,q ~>'))).toBe(
      'Man is distinguished',
    );
    expect(utf8Decode(base85Decode('BOu!rDZ'))).toBe('hello');
  });

  it('round-trips every length 0..40 and all byte values in every variant', () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    for (const v of ['ascii85', 'z85', 'rfc1924'] as const) {
      for (let len = 0; len <= 40; len++) {
        const part = all.subarray(len * 3, len * 3 + len);
        expect(toHex(base85Decode(base85Encode(part, v), v))).toBe(toHex(part));
      }
      expect(toHex(base85Decode(base85Encode(all, v, true), v))).toBe(toHex(all));
    }
  });

  it('rejects bad input with ToolError', () => {
    expect(() => base85Decode('abcéd', 'ascii85')).toThrow(ToolError);
    expect(() => base85Decode('hello world~~~', 'ascii85')).toThrow(/not in its alphabet/);
    expect(() => base85Decode('uuuuu', 'ascii85')).toThrow(/too large/); // > 2^32
    expect(() => base85Decode('BOu!rD', 'ascii85')).toThrow(/Truncated/); // 5 + 1 lone character
    expect(() => base85Decode('BOz!rDZ', 'ascii85')).toThrow(/middle of a group/);
  });
});

describe('base85 tool', () => {
  const run = (text: string, options: Record<string, unknown> = {}) =>
    base85.run({ bytes: bytesOf(text) }, {
      mode: 'decode',
      variant: 'ascii85',
      adobe: false,
      ...options,
    } as never);

  it('decodes and encodes', async () => {
    const dec = await run('W^7?+dva!DF*!0cUu<b>WnX7$bbS', { variant: 'rfc1924' });
    expect(utf8Decode((dec[0] as { value: Uint8Array }).value)).toBe('flag{rfc1924_like_git}');
    expect(await run('hello', { mode: 'encode', variant: 'rfc1924' })).toEqual([
      { type: 'text', value: 'Xk~0{Zv' },
    ]);
  });

  it('detects the Adobe frame with high confidence', () => {
    const d = base85.detect!({ text: '<~BOu!rDZ~>', bytes: new Uint8Array() });
    expect(d?.score).toBeGreaterThan(0.9);
    expect(base85.detect!({ text: 'just some words here', bytes: new Uint8Array() })).toBeNull();
  });

  it('detects unframed RFC 1924 that decodes to text', () => {
    const d = base85.detect!({ text: 'W^7?+dva!DF*!0cUu<b>WnX7$bbS', bytes: new Uint8Array() });
    expect(d?.options).toMatchObject({ variant: 'rfc1924' });
  });
});
