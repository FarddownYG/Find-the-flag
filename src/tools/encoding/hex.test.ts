import { describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors';
import { toHex, utf8Decode, utf8Encode } from '../../lib/bytes';
import hex, { hexDecode, hexEncode } from './hex';

const FLAG = 'flag{hex_is_just_bytes}';
const FLAG_HEX = '666c61677b6865785f69735f6a7573745f62797465737d';

describe('hex', () => {
  it('encodes with every separator style', () => {
    const b = utf8Encode('hi CTF');
    expect(hexEncode(b, 'none')).toBe('686920435446');
    expect(hexEncode(b, 'space')).toBe('68 69 20 43 54 46');
    expect(hexEncode(b, 'colon')).toBe('68:69:20:43:54:46');
    expect(hexEncode(b, 'comma')).toBe('68,69,20,43,54,46');
    expect(hexEncode(b, 'x')).toBe('\\x68\\x69\\x20\\x43\\x54\\x46');
    expect(hexEncode(b, '0x')).toBe('0x68 0x69 0x20 0x43 0x54 0x46');
    expect(hexEncode(b, 'c')).toBe('0x68, 0x69, 0x20, 0x43, 0x54, 0x46');
  });

  it('uppercases only the digits, not the prefix', () => {
    expect(hexEncode(Uint8Array.of(0xab, 0xcd), '0x', true)).toBe('0xAB 0xCD');
    expect(hexEncode(Uint8Array.of(0xab, 0xcd), 'x', true)).toBe('\\xAB\\xCD');
    expect(hexEncode(Uint8Array.of(0xab, 0xcd), 'none', false)).toBe('abcd');
  });

  it('encodes the empty input as the empty string', () => {
    expect(hexEncode(new Uint8Array(), 'space')).toBe('');
  });

  it('decodes every separator style back to the same bytes', () => {
    const b = utf8Encode(FLAG);
    for (const sep of ['none', 'space', 'colon', 'comma', 'x', '0x', 'c'] as const) {
      for (const upper of [false, true]) {
        expect(utf8Decode(hexDecode(hexEncode(b, sep, upper)))).toBe(FLAG);
      }
    }
  });

  it('decodes messy input: newlines, mixed case, quotes, Python bytes literal, C array', () => {
    expect(toHex(hexDecode('66 6C\n61\t67'))).toBe('666c6167');
    expect(utf8Decode(hexDecode("b'\\x66\\x6c\\x61\\x67'"))).toBe('flag');
    expect(utf8Decode(hexDecode('{0x66, 0x6c, 0x61, 0x67}'))).toBe('flag');
    expect(utf8Decode(hexDecode('"666C6167"'))).toBe('flag');
  });

  it('round-trips all 256 byte values', () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(Array.from(hexDecode(hexEncode(all, 'space')))).toEqual(Array.from(all));
  });

  it('rejects non-hex characters and odd digit counts', () => {
    expect(() => hexDecode('66 6g')).toThrow(ToolError);
    expect(() => hexDecode('66 6g')).toThrow(/"g"/);
    expect(() => hexDecode('666')).toThrow(/Odd number/);
  });
});

describe('hex tool', () => {
  const run = (text: string, options: Record<string, unknown> = {}) =>
    hex.run({ bytes: utf8Encode(text) }, {
      mode: 'decode',
      separator: 'space',
      upper: false,
      ...options,
    } as never);

  it('decodes to a bytes block', async () => {
    const out = await run(FLAG_HEX);
    expect(out[0]).toMatchObject({ type: 'bytes' });
    expect(utf8Decode((out[0] as { value: Uint8Array }).value)).toBe(FLAG);
  });

  it('flags binary output', async () => {
    const out = await run('ff fe fd');
    expect(out.some((o) => o.type === 'note')).toBe(true);
  });

  it('detects hex of text strongly and a bare hash weakly', () => {
    const sample = (text: string) => ({ text, bytes: new Uint8Array() });
    expect(hex.detect!(sample(FLAG_HEX))?.score).toBeGreaterThan(0.8);
    expect(hex.detect!(sample('d41d8cd98f00b204e9800998ecf8427e'))?.score).toBeLessThan(0.5);
    expect(hex.detect!(sample('hello there'))).toBeNull();
    expect(hex.detect!({ text: null, bytes: new Uint8Array() })).toBeNull();
  });
});
