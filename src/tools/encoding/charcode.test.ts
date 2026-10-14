import { describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors';
import { toHex } from '../../lib/bytes';
import charcode, {
  charcodeDecode,
  charcodeDecodeBytes,
  charcodeEncode,
  parseCharcodes,
} from './charcode';

const FLAG = 'flag{charcode}';

describe('charcode', () => {
  it('encodes decimal, hex and octal with chosen separators', () => {
    expect(charcodeEncode('flag{', 'dec')).toBe('102 108 97 103 123');
    expect(charcodeEncode('flag{', 'hex')).toBe('66 6c 61 67 7b');
    expect(charcodeEncode('flag{', 'oct')).toBe('146 154 141 147 173');
    expect(charcodeEncode('a\tb', 'oct', 'comma')).toBe('141,011,142');
    expect(charcodeEncode('ab', 'dec', 'comma-space')).toBe('97, 98');
    expect(charcodeEncode('ab', 'dec', 'newline')).toBe('97\n98');
    expect(charcodeEncode('', 'dec')).toBe('');
  });

  it('decodes whatever separator is used', () => {
    for (const sep of [' ', ',', ', ', '\n', ';', '\t', ' , ', '|']) {
      expect(charcodeDecode(charcodeEncode(FLAG, 'dec').split(' ').join(sep))).toBe(FLAG);
    }
    expect(charcodeDecode('[102, 108, 97, 103]')).toBe('flag');
  });

  it('handles 0x, \\x and &#x style prefixes and hex without a base switch', () => {
    expect(charcodeDecode('0x66 0x6c 0x61 0x67')).toBe('flag');
    expect(charcodeDecode('\\x66\\x6c\\x61\\x67')).toBe('flag');
    expect(charcodeDecode('&#x66;&#x6c;&#x61;&#x67;')).toBe('flag');
    expect(charcodeDecode('U+0066 U+006C U+0061 U+0067')).toBe('flag');
    expect(charcodeDecode('%66%6c%61%67', 'hex')).toBe('flag');
  });

  it('round-trips in every base', () => {
    const text = 'Hello, wörld! ✓ 😀 flag{x}';
    for (const base of ['dec', 'hex', 'oct'] as const) {
      expect(charcodeDecode(charcodeEncode(text, base), base)).toBe(text);
    }
  });

  it('works with Unicode code points above 255 and astral characters', () => {
    expect(charcodeEncode('✓😀')).toBe('10003 128512');
    expect(charcodeDecode('10003 128512')).toBe('✓😀');
  });

  it('merges UTF-16 surrogate halves into one character', () => {
    expect(charcodeDecode('55357 56832')).toBe('😀');
  });

  it('utf8 unit: numbers are bytes, so multi-byte characters survive', () => {
    expect(charcodeEncode('é', 'dec', 'space', 'utf8')).toBe('195 169');
    expect(charcodeDecode('195 169', 'dec', 'utf8')).toBe('é');
    expect(charcodeDecode('195 169', 'dec', 'codepoint')).toBe('Ã©');
    expect(toHex(charcodeDecodeBytes('255 254 0', 'dec', 'utf8'))).toBe('fffe00');
    expect(() => charcodeDecodeBytes('300', 'dec', 'utf8')).toThrow(/does not fit in one byte/);
  });

  it('separator-less lists are cut by digits per character', () => {
    expect(charcodeDecode('102108097103')).toBe('flag');
    expect(charcodeDecode('666c6167', 'hex')).toBe('flag');
    expect(charcodeDecode('146154141147', 'oct')).toBe('flag');
    expect(parseCharcodes('65')).toEqual([65]);
    expect(parseCharcodes('9731')).toEqual([9731]);
  });

  it('explains wrong bases and impossible values', () => {
    expect(() => charcodeDecode('66 6c')).toThrow(ToolError);
    expect(() => charcodeDecode('66 6c')).toThrow(/Hexadecimal/);
    expect(() => charcodeDecode('148 9', 'oct')).toThrow(/not a octal number/);
    expect(() => charcodeDecode('1114112')).toThrow(/Unicode code point/);
  });
});

describe('charcode tool', () => {
  const run = (text: string, options: Record<string, unknown> = {}) =>
    charcode.run(text, {
      mode: 'decode',
      base: 'dec',
      unit: 'codepoint',
      separator: 'space',
      ...options,
    } as never);

  it('decodes into a bytes block and encodes into text', async () => {
    const dec = await run('102 108 97 103');
    expect(dec[0]).toMatchObject({ type: 'bytes' });
    expect(await run('ok', { mode: 'encode' })).toEqual([{ type: 'text', value: '111 107' }]);
  });

  it('refuses empty input with guidance', async () => {
    await expect(Promise.resolve().then(() => run('   '))).rejects.toThrow(ToolError);
  });

  it('detect: lists of printable ASCII codes, nothing else', () => {
    const sample = (text: string) => ({ text, bytes: new Uint8Array() });
    expect(charcode.detect!(sample('102 108 97 103 123 125'))?.score).toBeGreaterThan(0.8);
    expect(charcode.detect!(sample('102, 108, 97, 103'))?.score).toBeGreaterThan(0.8);
    expect(charcode.detect!(sample('1 2 3'))).toBeNull();
    expect(charcode.detect!(sample('hello world'))).toBeNull();
    expect(charcode.detect!(sample('1 2 3 4 5 6 7 1000'))).toBeNull();
  });
});
