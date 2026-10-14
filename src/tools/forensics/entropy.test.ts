import { readFileSync } from 'node:fs';
import { encode as encodePng } from 'fast-png';
import { describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors';
import { concatBytes, utf8Encode } from '../../lib/bytes';
import { FONT } from './_chart';
import entropy, {
  analyse,
  autoBlockSize,
  entropyChart,
  highRegions,
  histogramChart,
  shannon,
} from './entropy';
import { noise } from './_fixtures';

const sample = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../../../public/samples/${name}`, import.meta.url)));

const defaults = { block: 0, threshold: 7.5, chart: 'bars' };
const run = (bytes: Uint8Array, opts: Record<string, unknown> = {}) =>
  entropy.run({ bytes }, { ...defaults, ...opts } as never);

const prose = utf8Encode('The quick brown fox jumps over the lazy dog. '.repeat(200));

const pixel = (img: { width: number; data: Uint8ClampedArray }, x: number, y: number) => [
  ...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 3),
];

describe('entropy: maths', () => {
  it('computes Shannon entropy', () => {
    const uniform = new Uint32Array(256).fill(10);
    expect(shannon(uniform, 2560)).toBeCloseTo(8, 10);
    const two = new Uint32Array(256);
    two[0] = 50;
    two[255] = 50;
    expect(shannon(two, 100)).toBeCloseTo(1, 10);
    const one = new Uint32Array(256);
    one[7] = 9;
    expect(shannon(one, 9)).toBe(0);
    expect(shannon(one, 0)).toBe(0);
  });

  it('picks about 256 blocks, never smaller than 1 KiB, always a power of two', () => {
    expect(autoBlockSize(10)).toBe(1024);
    expect(autoBlockSize(262144)).toBe(1024);
    expect(autoBlockSize(262145)).toBe(2048);
    expect(autoBlockSize(20 << 20)).toBe(131072);
    for (const len of [5000, 1 << 20, 33_333_333]) {
      const size = autoBlockSize(len);
      expect(Math.ceil(len / size)).toBeLessThanOrEqual(256);
      expect(size & (size - 1)).toBe(0);
    }
  });

  it('measures random data near 8, text near 4, zeros at 0', () => {
    expect(analyse(noise(65536, 1), 4096).overall).toBeGreaterThan(7.99);
    const text = analyse(prose, 1024);
    expect(text.overall).toBeGreaterThan(3.5);
    expect(text.overall).toBeLessThan(5);
    expect(analyse(new Uint8Array(5000), 1024).overall).toBe(0);
  });

  it('splits into blocks and folds a short tail into the previous block', () => {
    const lens = (n: number) => analyse(noise(n, 2), 1024).blocks.map((b) => b.end - b.start);
    expect(lens(2048)).toEqual([1024, 1024]);
    expect(lens(2048 + 300)).toEqual([1024, 1324]);
    expect(lens(2048 + 600)).toEqual([1024, 1024, 600]);
    expect(lens(100)).toEqual([100]);
  });

  it('finds the exact bounds of a high-entropy region', () => {
    const data = concatBytes(prose.subarray(0, 8192), noise(8192, 3), prose.subarray(0, 8192));
    const { blocks } = analyse(data, 1024);
    const regions = highRegions(blocks, 7.5);
    expect(regions).toHaveLength(1);
    expect(regions[0]).toMatchObject({ start: 8192, end: 16384 });
    expect(regions[0]!.mean).toBeGreaterThan(7.7);
    expect(highRegions(blocks, 7.99)).toEqual([]);
  });

  it('scans 20 MB quickly', () => {
    const big = noise(20 << 20, 6);
    const t0 = performance.now();
    const r = analyse(big, autoBlockSize(big.length));
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(r.overall).toBeGreaterThan(7.999);
  });
});

describe('entropy: charts', () => {
  const data = concatBytes(prose.subarray(0, 8192), noise(8192, 3), prose.subarray(0, 8192));
  const { blocks, counts } = analyse(data, 1024);

  it('draws bars coloured by level, with the threshold line', () => {
    const img = entropyChart(blocks, data.length, 7.5, 'bars');
    expect(img.width).toBe(960);
    expect(img.height).toBe(340);
    expect(img.data).toHaveLength(960 * 340 * 4);
    // plot spans x 52..944, base y 304; block 0 (text) is blue, block 9 (random) red
    expect(pixel(img, 52 + 20, 300)).toEqual([122, 167, 242]);
    expect(pixel(img, 52 + Math.round((9.5 * 892) / 24), 300)).toEqual([239, 108, 85]);
    // dashed threshold line at 7.5 bits: y = 304 - 7.5/8*288
    const y = Math.round(304 - (7.5 / 8) * 288);
    const row = Array.from({ length: 60 }, (_, i) => pixel(img, 52 + i, y).join());
    expect(row).toContain('239,108,85');
  });

  it('draws a line chart too, and the histogram colours byte classes', () => {
    const line = entropyChart(blocks, data.length, 7.5, 'line');
    expect(line.width).toBe(960);
    expect(line.data.some((v, i) => i % 4 === 0 && v === 239)).toBe(true);
    const hist = histogramChart(counts, data.length);
    expect(hist.width).toBe(52 + 768 + 16);
    expect(hist.height).toBe(300);
    // 'e' (0x65) is the most common letter in the prose: a blue bar reaches near the bottom axis
    expect(pixel(hist, 52 + 0x65 * 3 + 1, 262)).toEqual([122, 167, 242]);
  });

  it('has complete 5x7 glyphs for every character it draws', () => {
    for (const [ch, rows] of Object.entries(FONT)) {
      expect(rows, ch).toHaveLength(7);
      for (const r of rows) expect(r, ch).toMatch(/^[.#]{5}$/);
    }
    for (const ch of '0123456789ABCDEFKMGx.- ') expect(FONT[ch], ch).toBeDefined();
  });
});

describe('entropy: tool', () => {
  it('returns verdict, summary, two images and the regions table', async () => {
    const data = concatBytes(prose.subarray(0, 8192), noise(8192, 3), prose.subarray(0, 8192));
    const out = await run(data);
    expect(out.map((o) => o.type)).toEqual(['note', 'kv', 'image', 'table', 'note', 'image']);
    const table = out.find((o) => o.type === 'table');
    if (table?.type !== 'table') throw new Error('table expected');
    expect(table.rows[0]!.slice(0, 3)).toEqual(['0x2000', '0x4000', 8192]);
    const kv = out.find((o) => o.type === 'kv');
    if (kv?.type !== 'kv') throw new Error('kv expected');
    expect(kv.entries.find(([k]) => k === 'Block size')?.[1]).toBe('1024 bytes (24 blocks)');
    // low overall, high region: points at the embedded payload
    expect(out.some((o) => o.type === 'note' && /embedded/.test(o.text))).toBe(true);
  });

  it('calls ~8 bits "encrypted or compressed" and low entropy "text"', async () => {
    const random = await run(noise(50_000, 4));
    expect(random[0]).toMatchObject({ type: 'note', level: 'warn' });
    expect(random[0]!.type === 'note' && random[0]!.text).toMatch(/encrypted/);
    const text = await run(prose);
    expect(text[0]!.type === 'note' && text[0]!.text).toMatch(/looks like text/);
    const zeros = await run(new Uint8Array(20_000));
    expect(zeros[0]!.type === 'note' && zeros[0]!.text).toMatch(/mostly zero/);
  });

  it('does not cry wolf about a PNG that is compressed by nature', async () => {
    const png = encodePng({
      width: 100,
      height: 100,
      data: noise(40_000, 7),
      depth: 8,
      channels: 4,
    });
    const out = await run(png);
    expect(out[0]).toMatchObject({ type: 'note', level: 'info' });
    expect(out[0]!.type === 'note' && out[0]!.text).toMatch(/normal for a PNG image/);
  });

  it('works on the polyglot sample and honours a manual block size', async () => {
    const out = await run(sample('forensics-polyglot.png'), { block: 512 });
    const kv = out.find((o) => o.type === 'kv');
    expect(kv?.type === 'kv' && kv.entries.find(([k]) => k === 'Block size')?.[1]).toBe(
      '512 bytes (16 blocks)',
    );
    expect(out.some((o) => o.type === 'note' && /under 1024/.test(o.text))).toBe(true);
  });

  it('refuses empty input and absurdly small blocks', async () => {
    await expect(Promise.resolve().then(() => run(new Uint8Array(0)))).rejects.toThrow(ToolError);
    await expect(
      Promise.resolve().then(() => run(new Uint8Array(1_000_000), { block: 4 })),
    ).rejects.toThrow(/blocks/);
  });
});
