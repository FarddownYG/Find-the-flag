import { unzipSync } from 'fflate';
import { decode as decodePng } from 'fast-png';
import { describe, expect, it } from 'vitest';
import type { GalleryItem, RgbaImage } from '../core/types';
import { utf8Decode } from '../lib/bytes';
import {
  clampZoom,
  fillView,
  fitView,
  imageToPng,
  itemFileName,
  MAX_ZOOM,
  MIN_ZOOM,
  pixelUnder,
  readPixel,
  stepIndex,
  zipItems,
  zoomAt,
} from './gallery-core';

const img = (w: number, h: number, rgba: (x: number, y: number) => number[]): RgbaImage => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(rgba(x, y), (y * w + x) * 4);
  return { width: w, height: h, data };
};
const item = (id: string, label: string, image: RgbaImage, suspect = false): GalleryItem => ({
  id,
  label,
  image,
  ...(suspect ? { suspect: true, note: 'why' } : {}),
});

describe('gallery view maths', () => {
  it('fits a big picture and never enlarges a small one when fitting', () => {
    expect(fitView(500, 400, 1000, 400).scale).toBeCloseTo(0.5);
    expect(fitView(500, 400, 50, 40).scale).toBe(1);
    expect(fillView(500, 400, 50, 40).scale).toBe(10);
  });

  it('centres the picture', () => {
    const v = fitView(500, 400, 100, 100);
    expect(v.x).toBeCloseTo(200);
    expect(v.y).toBeCloseTo(150);
  });

  it('zooms around the pointer: the picture point under it stays put', () => {
    const view = { scale: 2, x: 30, y: -10 };
    const before = { x: (120 - view.x) / view.scale, y: (80 - view.y) / view.scale };
    const next = zoomAt(view, 1.5, 120, 80);
    expect(next.scale).toBeCloseTo(3);
    expect((120 - next.x) / next.scale).toBeCloseTo(before.x);
    expect((80 - next.y) / next.scale).toBeCloseTo(before.y);
  });

  it('clamps the zoom', () => {
    expect(clampZoom(1e9)).toBe(MAX_ZOOM);
    expect(clampZoom(0)).toBe(MIN_ZOOM);
    expect(zoomAt({ scale: MAX_ZOOM, x: 0, y: 0 }, 2, 0, 0).scale).toBe(MAX_ZOOM);
  });

  it('wraps between pictures', () => {
    expect(stepIndex(0, -1, 5)).toBe(4);
    expect(stepIndex(4, 1, 5)).toBe(0);
    expect(stepIndex(2, 0, 0)).toBe(0);
  });
});

describe('pixel inspector', () => {
  const view = { scale: 4, x: 10, y: 20 };
  it('maps the pointer to a picture pixel, or to none outside', () => {
    expect(pixelUnder(view, 10 + 4 * 3 + 1, 20 + 4 * 2 + 1, 8, 8)).toEqual({ x: 3, y: 2 });
    expect(pixelUnder(view, 5, 25, 8, 8)).toBeNull();
    expect(pixelUnder(view, 10 + 4 * 8, 20, 8, 8)).toBeNull();
  });

  it('reads RGBA, hex and the 8 bits of each channel', () => {
    const p = readPixel(
      img(2, 1, (x) => (x ? [1, 2, 255, 128] : [0, 0, 0, 255])),
      1,
      0,
    )!;
    expect(p.rgba).toEqual([1, 2, 255, 128]);
    expect(p.bits).toEqual(['00000001', '00000010', '11111111', '10000000']);
    expect(p.hex).toBe('#0102ff');
    expect(
      readPixel(
        img(2, 1, () => [0, 0, 0, 255]),
        2,
        0,
      ),
    ).toBeNull();
  });
});

describe('downloads', () => {
  const a = img(3, 2, (x, y) => [x * 80, y * 100, 7, 255]);

  it('encodes an item as a lossless PNG', () => {
    const decoded = decodePng(imageToPng(a));
    expect([decoded.width, decoded.height]).toEqual([3, 2]);
    expect([...decoded.data.slice(0, 8)]).toEqual([0, 0, 7, 255, 80, 0, 7, 255]);
  });

  it('names files after the label, safely', () => {
    expect(itemFileName(item('x', 'B0 · blue bit 0 (lowest)', a))).toBe('B0-blue-bit-0-lowest.png');
    expect(itemFileName(item('plane-r0', '···', a))).toBe('plane-r0.png');
  });

  it('zips every picture under a unique name with an index of notes', () => {
    const zip = unzipSync(
      zipItems([
        item('a', 'Same label', a, true),
        item('b', 'Same label', a),
        item('c', 'Other', a),
      ]),
    );
    expect(Object.keys(zip).sort()).toEqual([
      'Other.png',
      'Same-label-2.png',
      'Same-label.png',
      'index.txt',
    ]);
    expect(utf8Decode(zip['index.txt']!)).toContain('Same-label.png\tlook-first\twhy');
    expect(decodePng(zip['Other.png']!).width).toBe(3);
  });
});
