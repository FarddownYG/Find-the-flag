import { describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors';
import { toHex, utf8Decode, utf8Encode } from '../../lib/bytes';
import binary, { binaryDecode, binaryEncode } from './binary';

const FLAG = 'flag{binary_is_bits}';
const spaced8 = (s: string) =>
  Array.from(utf8Encode(s), (c) => c.toString(2).padStart(8, '0')).join(' ');
const spaced7 = (s: string) =>
  Array.from(utf8Encode(s), (c) => c.toString(2).padStart(7, '0')).join(' ');

describe('binary', () => {
  it('encodes 8-bit and 7-bit groups', () => {
    expect(binaryEncode(utf8Encode('Hi'))).toBe('01001000 01101001');
    expect(binaryEncode(utf8Encode('Hi'), 8, '')).toBe('0100100001101001');
    expect(binaryEncode(utf8Encode('Hi'), 7)).toBe('1001000 1101001');
    expect(binaryEncode(new Uint8Array())).toBe('');
  });

  it('refuses to squeeze a byte above 127 into 7 bits', () => {
    expect(() => binaryEncode(utf8Encode('é'), 7)).toThrow(ToolError);
    expect(() => binaryEncode(utf8Encode('é'), 7)).toThrow(/does not fit in 7 bits/);
  });

  it('decodes with or without spaces', () => {
    expect(utf8Decode(binaryDecode(spaced8(FLAG)))).toBe(FLAG);
    expect(utf8Decode(binaryDecode(spaced8(FLAG).replace(/ /g, '')))).toBe(FLAG);
    expect(utf8Decode(binaryDecode(spaced8(FLAG).replace(/ /g, '\n')))).toBe(FLAG);
    expect(utf8Decode(binaryDecode(spaced8(FLAG).replace(/ /g, ',')))).toBe(FLAG);
  });

  it('decodes 7-bit groups, spaced or not, whatever the width hint', () => {
    expect(utf8Decode(binaryDecode(spaced7(FLAG), 7))).toBe(FLAG);
    expect(utf8Decode(binaryDecode(spaced7(FLAG), 8))).toBe(FLAG);
    expect(utf8Decode(binaryDecode(spaced7(FLAG).replace(/ /g, ''), 7))).toBe(FLAG);
    // 140 bits: not a multiple of 8, so the 7-bit reading is chosen automatically
    expect(utf8Decode(binaryDecode(spaced7(FLAG).replace(/ /g, ''), 8))).toBe(FLAG);
  });

  it('accepts 0b prefixes, nibbles and single bits', () => {
    expect(utf8Decode(binaryDecode('0b01001000 0b01101001'))).toBe('Hi');
    expect(utf8Decode(binaryDecode('0100 1000 0110 1001'))).toBe('Hi');
    expect(utf8Decode(binaryDecode('0 1 0 0 1 0 0 0 0 1 1 0 1 0 0 1'))).toBe('Hi');
    expect(utf8Decode(binaryDecode('0100 1000 0110 1001', 7)).length).toBeGreaterThan(0);
  });

  it('round-trips every byte value', () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(toHex(binaryDecode(binaryEncode(all)))).toBe(toHex(all));
    expect(toHex(binaryDecode(binaryEncode(all, 8, '')))).toBe(toHex(all));
  });

  it('keeps short groups as individual bytes', () => {
    expect(Array.from(binaryDecode('1 10 11'))).toEqual([1, 2, 3]);
    expect(Array.from(binaryDecode('100 1 1111111'))).toEqual([4, 1, 127]);
  });

  it('reports bad input with a ToolError', () => {
    expect(() => binaryDecode('0102')).toThrow(/"2" at position 4/);
    expect(() => binaryDecode('hello')).toThrow(ToolError);
    expect(() => binaryDecode('0110011')).not.toThrow(); // 7 digits = one 7-bit char
    expect(() => binaryDecode('011001100')).toThrow(/not a multiple of 8/);
  });

  it('empty input gives empty output', () => {
    expect(binaryDecode('  ')).toHaveLength(0);
  });
});

describe('binary tool', () => {
  const run = (text: string, options: Record<string, unknown> = {}) =>
    binary.run({ bytes: utf8Encode(text) }, {
      mode: 'decode',
      width: '8',
      separator: 'space',
      ...options,
    } as never);

  it('decodes and encodes', async () => {
    const dec = await run(spaced8(FLAG));
    expect(utf8Decode((dec[0] as { value: Uint8Array }).value)).toBe(FLAG);
    expect(await run('Hi', { mode: 'encode', separator: 'none' })).toEqual([
      { type: 'text', value: '0100100001101001' },
    ]);
  });

  it('detects 0/1 text strongly when it decodes to text', () => {
    const sample = (text: string) => ({ text, bytes: new Uint8Array() });
    expect(binary.detect!(sample(spaced8(FLAG)))?.score).toBeGreaterThan(0.85);
    expect(binary.detect!(sample('0101'))).toBeNull();
    expect(binary.detect!(sample('hello 0101'))).toBeNull();
  });
});
