import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { prepareInput } from '../../core/prepare';
import { resultToText } from '../../core/result-text';
import type { ImageInput, Output, RgbaImage } from '../../core/types';
import bitPlanes from './bit-planes';

interface Opts {
  mode: 'all' | 'one' | 'filters';
  channel: 'r' | 'g' | 'b' | 'a';
  bit: number;
  filter: 'all' | 'invert' | 'grayscale' | 'channels' | 'colormap' | 'xor' | 'equalize';
  xor: number;
  alpha: boolean;
}
const defaults: Opts = { mode: 'all', channel: 'r', bit: 0, filter: 'all', xor: 0, alpha: false };

const make = (
  w: number,
  h: number,
  f: (x: number, y: number) => [number, number, number, number],
) => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) data.set(f(x, y), (y * w + x) * 4);
  }
  return { width: w, height: h, data } satisfies RgbaImage;
};
const run = (image: RgbaImage, o: Partial<Opts> = {}) =>
  bitPlanes.run({ bytes: new Uint8Array(), image }, { ...defaults, ...o }) as Output[];
const images = (out: Output[]) =>
  out.flatMap((o) =>
    o.type === 'image' ? [{ label: o.label ?? '', image: o.image, filename: o.filename }] : [],
  );

async function sample(name: string): Promise<ImageInput> {
  const bytes = new Uint8Array(
    readFileSync(new URL(`../../../public/samples/${name}`, import.meta.url)),
  );
  return (await prepareInput('image', { bytes })) as ImageInput;
}

describe('bit-planes', () => {
  it('renders exact black/white planes', () => {
    const img = make(4, 2, (x, y) => [x * 16 + y, 0b10101010, 255, 255]);
    const out = images(run(img, { mode: 'one', channel: 'r', bit: 4 }));
    expect(out).toHaveLength(1);
    // red = x*16 + y: bit 4 is set for x = 1 and x = 3
    const px = (x: number, y: number) => out[0]!.image.data[(y * 4 + x) * 4];
    expect([px(0, 0), px(1, 0), px(2, 0), px(3, 0), px(1, 1)]).toEqual([0, 255, 0, 255, 255]);
    const g1 = images(run(img, { mode: 'one', channel: 'g', bit: 1 }))[0]!;
    expect(g1.image.data[0]).toBe(255); // 0b10101010 bit 1 = 1
    const g0 = images(run(img, { mode: 'one', channel: 'g', bit: 0 }))[0]!;
    expect(g0.image.data[0]).toBe(0);
  });

  it('all planes: 24 images when opaque, 32 with transparency', () => {
    const opaque = make(8, 8, (x, y) => [x, y, 0, 255]);
    expect(images(run(opaque))).toHaveLength(24);
    const translucent = make(8, 8, (x, y) => [x, y, 0, x === 0 ? 0 : 255]);
    const out = run(translucent);
    expect(images(out)).toHaveLength(32);
    expect(images(out).map((i) => i.label.split(' ')[0])).toContain('A7');
  });

  it('finds the plane that hides text in the sample', async () => {
    const input = await sample('stego-planes.png');
    const out = bitPlanes.run(input, { ...defaults }) as Output[];
    const table = out.find((o) => o.type === 'table');
    if (table?.type !== 'table') throw new Error('no table');
    const row = (plane: string) => table.rows.find((r) => r[0] === plane)!;
    expect(row('G0')[3]).toBe('blank (all 0)');
    expect(row('G1')[3]).toBe('structured');
    expect(Number.parseFloat(String(row('G1')[1]))).toBeGreaterThan(1);
    expect(table.highlight).toContain(table.rows.indexOf(row('G1')));
    // The picture itself: G1 has lit pixels, R1 has none.
    const g1 = images(out).find((i) => i.label.startsWith('G1'))!;
    const lit = g1.image.data.filter((v, i) => i % 4 === 0 && v === 255).length;
    expect(lit).toBeGreaterThan(100);
    const r1 = images(out).find((i) => i.label.startsWith('R1'))!;
    expect(r1.image.data.filter((v, i) => i % 4 === 0 && v === 255).length).toBe(0);
  });

  it('shrinks huge images for the plane grid and says so', () => {
    const big = make(1600, 800, (x, y) => [x & 255, y & 255, 0, 255]);
    const out = run(big);
    for (const i of images(out)) {
      expect(Math.max(i.image.width, i.image.height)).toBeLessThanOrEqual(512);
    }
    expect(resultToText(out)).toMatch(/shrunk to 512x256/);
    // One plane keeps full size.
    expect(images(run(big, { mode: 'one' }))[0]!.image.width).toBe(1600);
  });

  describe('filters', () => {
    const img = make(4, 4, (x, y) => [x * 20, y * 20, 100 + x + y, 255]);
    const only = (filter: Opts['filter'], extra: Partial<Opts> = {}) =>
      images(run(img, { mode: 'filters', filter, ...extra }));

    it('inverts', () => {
      const [inv] = only('invert');
      expect(Array.from(inv!.image.data.slice(0, 4))).toEqual([255, 255, 155, 255]);
    });

    it('converts to grayscale', () => {
      const [g] = only('grayscale');
      const d = g!.image.data;
      expect(d[0]).toBe(d[1]);
      expect(d[1]).toBe(d[2]);
      expect(d[(3 * 4 + 3) * 4]).toBe(Math.round(0.299 * 60 + 0.587 * 60 + 0.114 * 106));
    });

    it('isolates channels (alpha only when it varies)', () => {
      const out = only('channels');
      expect(out.map((i) => i.label)).toEqual([
        'Red channel alone (grey)',
        'Green channel alone (grey)',
        'Blue channel alone (grey)',
      ]);
      expect(out[0]!.image.data[(1 * 4 + 2) * 4]).toBe(40);
    });

    it('xors only with a value, and "all" skips xor 0', () => {
      expect(only('all').some((i) => i.label.startsWith('XOR'))).toBe(false);
      const [x] = only('xor', { xor: 0xff });
      expect(Array.from(x!.image.data.slice(0, 3))).toEqual([255, 255, 155]);
      expect(only('all', { xor: 7 }).some((i) => i.label.startsWith('XOR with 7'))).toBe(true);
    });

    it('random colormap separates neighbouring values deterministically', () => {
      const near = make(2, 1, (x) => [100 + x, 100, 100, 255]);
      const a = images(run(near, { mode: 'filters', filter: 'colormap' }));
      const b = images(run(near, { mode: 'filters', filter: 'colormap' }));
      const map = a[0]!.image.data;
      expect(Array.from(map)).toEqual(Array.from(b[0]!.image.data));
      const diff =
        Math.abs(map[0]! - map[4]!) + Math.abs(map[1]! - map[5]!) + Math.abs(map[2]! - map[6]!);
      expect(diff).toBeGreaterThan(60);
      expect(resultToText(run(near, { mode: 'filters', filter: 'colormap' }))).toContain(
        'Random colormap',
      );
    });

    it('equalizes a low-contrast image to the full range', () => {
      const dull = make(16, 16, (x, y) => [100 + ((x + y) % 4), 100 + (x % 3), 120, 255]);
      const [eq] = images(run(dull, { mode: 'filters', filter: 'equalize' }));
      const reds = Array.from(eq!.image.data).filter((_, i) => i % 4 === 0);
      expect(Math.min(...reds)).toBe(0);
      expect(Math.max(...reds)).toBe(255);
    });

    it('shows colours hidden under fully transparent pixels', () => {
      const hidden = make(2, 1, (x) => (x ? [10, 20, 30, 255] : [200, 100, 50, 0]));
      const [inv] = images(run(hidden, { mode: 'filters', filter: 'invert' }));
      expect(Array.from(inv!.image.data.slice(0, 4))).toEqual([55, 155, 205, 255]);
    });
  });

  it('rejects an impossible bit', () => {
    expect(() =>
      run(
        make(2, 2, () => [0, 0, 0, 255]),
        { mode: 'one', bit: 9 },
      ),
    ).toThrow(/0 \(lowest\) to 7/);
  });
});
