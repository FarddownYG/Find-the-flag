import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors';
import { concatBytes, latin1Decode, utf8Encode } from '../../lib/bytes';
import hexdump, { parseHexDump } from './hexdump';
import { noise } from './_fixtures';

const sample = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../../../public/samples/${name}`, import.meta.url)));

const defaults = {
  mode: 'dump',
  style: 'xxd',
  cols: 16,
  group: 2,
  start: '0',
  length: '',
  ascii: true,
};
const run = (bytes: Uint8Array, opts: Record<string, unknown> = {}) =>
  hexdump.run({ bytes }, { ...defaults, ...opts } as never);

async function dump(bytes: Uint8Array, opts: Record<string, unknown> = {}): Promise<string> {
  const out = await run(bytes, opts);
  const block = out[0];
  if (block?.type !== 'text') throw new Error('text block expected');
  return block.value;
}

describe('hexdump: dump', () => {
  it('matches the exact layout of xxd', async () => {
    const png = sample('forensics-polyglot.png').subarray(0, 40);
    expect(await dump(png)).toBe(
      [
        '00000000: 8950 4e47 0d0a 1a0a 0000 000d 4948 4452  .PNG........IHDR',
        '00000010: 0000 0040 0000 0030 0806 0000 00a1 4b7c  ...@...0......K|',
        '00000020: 1f00 001e 8449 4441                      .....IDA',
      ].join('\n'),
    );
  });

  it('supports group size and bytes per row like xxd -g -c', async () => {
    const data = utf8Encode('0123456789ABCDEFGHIJ');
    expect(await dump(data, { cols: 8, group: 4 })).toBe(
      [
        '00000000: 30313233 34353637  01234567',
        '00000008: 38394142 43444546  89ABCDEF',
        `00000010: 4748494a${' '.repeat(11)}GHIJ`,
      ].join('\n'),
    );
    expect(await dump(data.subarray(0, 5), { cols: 4, group: 1, ascii: false })).toBe(
      '00000000: 30 31 32 33\n00000004: 34',
    );
  });

  it('matches hexdump -C, squeezes repeated rows and ends with the length', async () => {
    const data = concatBytes(utf8Encode('0123456789abcdef'), new Uint8Array(48), utf8Encode('end'));
    expect(await dump(data, { style: 'canonical' })).toBe(
      [
        '00000000  30 31 32 33 34 35 36 37  38 39 61 62 63 64 65 66  |0123456789abcdef|',
        '00000010  00 00 00 00 00 00 00 00  00 00 00 00 00 00 00 00  |................|',
        '*',
        '00000040  65 6e 64                                          |end|',
        '00000043',
      ].join('\n'),
    );
  });

  it('prints plain hex like xxd -p', async () => {
    expect(await dump(utf8Encode('flag{plain}'), { style: 'plain', cols: 30 })).toBe(
      '666c61677b706c61696e7d',
    );
    expect(await dump(utf8Encode('abcdef'), { style: 'plain', cols: 4 })).toBe('61626364\n6566');
  });

  it('keeps real offsets for start / length, in decimal, hex or from the end', async () => {
    const data = noise(0x400, 5);
    const first = (await dump(data, { start: '0x100', length: '0x20' })).split('\n');
    expect(first).toHaveLength(2);
    expect(first[0]!.startsWith('00000100: ')).toBe(true);
    expect((await dump(data, { start: '256', length: '32' })).split('\n')[0]).toBe(first[0]);
    const tail = (await dump(data, { start: '-16' })).split('\n');
    expect(tail).toEqual([expect.stringMatching(/^000003f0: /)]);
  });

  it('also returns the selected bytes for the hex viewer and download', async () => {
    const data = noise(300, 8);
    const out = await run(data, { start: '10', length: '20' });
    const bytes = out.find((o) => o.type === 'bytes');
    if (bytes?.type !== 'bytes') throw new Error('bytes block expected');
    expect(bytes.value).toEqual(data.subarray(10, 30));
    // Selecting everything hands back the whole input.
    const all = (await run(data)).find((o) => o.type === 'bytes');
    expect(all?.type === 'bytes' && all.value.length).toBe(300);
  });

  it('caps very large dumps with a note instead of freezing', async () => {
    const out = await run(new Uint8Array(400_000));
    expect(out.some((o) => o.type === 'note' && o.level === 'warn')).toBe(true);
    const text = out[0];
    expect(text?.type === 'text' && text.value.split('\n')).toHaveLength(262144 / 16);
  });

  it('rejects bad numbers and out-of-range offsets with advice', async () => {
    const data = noise(10, 1);
    await expect(Promise.resolve().then(() => run(data, { start: 'abc' }))).rejects.toThrow(
      ToolError,
    );
    await expect(Promise.resolve().then(() => run(data, { start: '99' }))).rejects.toThrow(
      /past the end/,
    );
    await expect(Promise.resolve().then(() => run(data, { length: '-3' }))).rejects.toThrow(
      ToolError,
    );
    await expect(Promise.resolve().then(() => run(new Uint8Array(0)))).rejects.toThrow(ToolError);
  });
});

describe('hexdump: reverse', () => {
  const png = sample('forensics-polyglot.png').subarray(0, 40);

  it('reads real od -A x -t x1z output', () => {
    const od = [
      '000000 89 50 4e 47 0d 0a 1a 0a 00 00 00 0d 49 48 44 52  >.PNG........IHDR<',
      '000010 00 00 00 40 00 00 00 30 08 06 00 00 00 a1 4b 7c  >...@...0......K|<',
      '000020 1f 00 00 1e 84 49 44 41                          >.....IDA<',
      '000028',
    ].join('\n');
    const parsed = parseHexDump(od);
    expect(parsed.bytes).toEqual(png);
    expect(parsed.format).toBe('hexdump -C / od');
  });

  it('expands the * lines of od and understands octal offsets (od -t x1)', () => {
    const od = [
      '0000000 89 50 4e 47 0d 0a 1a 0a 00 00 00 0d 49 48 44 52',
      '0000020 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00',
      '*',
      '0000120 74 61 69 6c 2d 62 79 74 65 73 21',
      '0000133',
    ].join('\n');
    const bytes = parseHexDump(od).bytes;
    expect(bytes).toHaveLength(0o133);
    expect(latin1Decode(bytes.subarray(80))).toBe('tail-bytes!');
    expect(bytes.subarray(16, 80).every((b) => b === 0)).toBe(true);
  });

  it('reads xxd and plain hex, ignoring the ASCII column', () => {
    const xxd = [
      '00000000: 8950 4e47 0d0a 1a0a 0000 000d 4948 4452  .PNG........IHDR',
      '00000010: 0000 0040 0000 0030 0806 0000 00a1 4b7c  ...@...0......K|',
      '00000020: 1f00 001e 8449 4441                      .....IDA',
    ].join('\n');
    expect(parseHexDump(xxd)).toMatchObject({ bytes: png, format: 'xxd' });
    expect(parseHexDump('89504e470d0a1a0a\n0000000d49484452').bytes).toEqual(png.subarray(0, 16));
    expect(parseHexDump('de ad be ef').bytes).toEqual(Uint8Array.of(0xde, 0xad, 0xbe, 0xef));
    expect(parseHexDump('0xde, 0xad, 0xbe').bytes).toEqual(Uint8Array.of(0xde, 0xad, 0xbe));
  });

  it('reads the C array written by xxd -i', () => {
    const c =
      'unsigned char flag_bin[] = {\n  0x66, 0x6c, 0x61, 0x67, 0x7b, 0x63, 0x7d\n};\nunsigned int flag_bin_len = 7;';
    expect(parseHexDump(c)).toMatchObject({
      bytes: utf8Encode('flag{c}'),
      format: 'C array (xxd -i)',
    });
  });

  it('reads plain hexdump (16-bit little-endian words)', () => {
    const text = '0000000 5089 474e 0a0d 0a1a 0000 0d00 4849 5244\n0000010';
    expect(parseHexDump(text).bytes).toEqual(png.subarray(0, 16));
  });

  it('fills offset gaps with zeros, as xxd -r does', () => {
    const parsed = parseHexDump('00000000: 4141\n00000008: 4242');
    expect(parsed.bytes).toEqual(Uint8Array.of(0x41, 0x41, 0, 0, 0, 0, 0, 0, 0x42, 0x42));
    expect(parsed.filled).toBe(6);
  });

  it('starts at the first line even if the dump was cut from the middle', () => {
    expect(parseHexDump('00001000: 6162\n00001002: 6364').bytes).toEqual(utf8Encode('abcd'));
  });

  it('reports the line of a broken dump', () => {
    expect(() => parseHexDump('00000000: 6162\n00000002: zz')).toThrow(/Line 2/);
    expect(() => parseHexDump('hello world')).toThrow(ToolError);
    expect(() => parseHexDump('   \n')).toThrow(ToolError);
  });

  it('tool: returns bytes, a format summary and the file type', async () => {
    const text = await dump(png);
    const out = await run(utf8Encode(text), { mode: 'reverse' });
    const kv = out.find((o) => o.type === 'kv');
    if (kv?.type !== 'kv') throw new Error('kv expected');
    expect(kv.entries).toContainEqual(['File type', 'PNG image (.png)']);
    const bytes = out.find((o) => o.type === 'bytes');
    if (bytes?.type !== 'bytes') throw new Error('bytes expected');
    expect(bytes.value).toEqual(png);
    expect(bytes.filename).toBe('reversed.png');
  });
});

describe('hexdump: round trips', () => {
  const sizes = [1, 2, 15, 16, 17, 31, 32, 33, 100, 1000];
  const styles: [string, Record<string, unknown>][] = [
    ['xxd', {}],
    ['xxd -g1 -c8', { group: 1, cols: 8 }],
    ['xxd -g4 -c12', { group: 4, cols: 12 }],
    ['xxd -g8 -c32', { group: 8, cols: 32 }],
    ['hexdump -C', { style: 'canonical' }],
    ['plain', { style: 'plain', cols: 30 }],
  ];

  it.each(styles)('%s dump reverses to the original bytes', async (_name, opts) => {
    for (const size of sizes) {
      const data = noise(size, size + 3);
      const reversed = parseHexDump(await dump(data, opts)).bytes;
      expect(reversed).toEqual(data);
    }
  });

  it('survives long runs of identical bytes in hexdump -C (squeezed with *)', async () => {
    const data = concatBytes(noise(20, 1), new Uint8Array(500).fill(0xaa), noise(7, 2));
    const text = await dump(data, { style: 'canonical' });
    expect(text).toContain('\n*\n');
    expect(parseHexDump(text).bytes).toEqual(data);
    // squeezed run reaching the end of the data
    const tail = concatBytes(noise(16, 3), new Uint8Array(160));
    expect(parseHexDump(await dump(tail, { style: 'canonical' })).bytes).toEqual(tail);
  });

  it('detect() proposes Reverse for a pasted dump but not for prose', async () => {
    const text = await dump(noise(64, 4));
    expect(hexdump.detect?.({ text, bytes: utf8Encode(text) })).toMatchObject({
      options: { mode: 'reverse' },
    });
    expect(
      hexdump.detect?.({ text: 'just a sentence\nand another', bytes: new Uint8Array(3) }),
    ).toBeNull();
    expect(hexdump.detect?.({ text: null, bytes: noise(100, 1) })).toBeNull();
  });
});
