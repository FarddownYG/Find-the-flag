import { describe, expect, it } from 'vitest';
import type { RgbaImage } from '../../core/types';
import { extractBits } from './_lsb-core';
import {
  anomalyRows,
  embedBits,
  parseRows,
  rangeMask,
  rowLsbEntropy,
  rowRanges,
  rowsLabel,
  strideHint,
  zonePixels,
} from './_lsb-zones';

/** Smooth cover with a quiet bit 0, optionally with random bit 0 everywhere (a noisy cover). */
function cover(w: number, h: number, noisy = false): RgbaImage {
  const data = new Uint8ClampedArray(w * h * 4);
  let s = 12345;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      s = (Math.imul(s, 1103515245) + 12345) >>> 0;
      for (let c = 0; c < 3; c++) {
        const base = (40 + x + y * 2 + c * 30) & 0xfe;
        data[o + c] = noisy ? base | ((s >>> (16 + c)) & 1) : base;
      }
      data[o + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

/** Random-looking bits on row 0, even pixels only, bit 0 of R, G and B. */
function rowZeroEven(w: number, h: number, noisy = false): RgbaImage {
  const img = cover(w, h, noisy);
  let s = 99;
  for (let x = 0; x < w; x += 2) {
    for (let c = 0; c < 3; c++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      const o = x * 4 + c;
      img.data[o] = (img.data[o]! & 0xfe) | ((s >>> 24) & 1);
    }
  }
  return img;
}

describe('rowLsbEntropy', () => {
  it('is 0 for a quiet row and near 1 for random bits', () => {
    const e = rowLsbEntropy(cover(64, 4), 0);
    expect(e).toEqual([0, 0, 0, 0]);
    const noisy = rowLsbEntropy(cover(256, 3, true), 0);
    for (const v of noisy) expect(v).toBeGreaterThan(0.95);
  });
});

describe('anomalyRows', () => {
  it('flags row 0 only when just its even pixels carry data', () => {
    const rows = anomalyRows(rowZeroEven(108, 48));
    expect(rows.map((r) => r.row)).toEqual([0]);
    expect(rows[0]!.score).toBeGreaterThan(0.5);
  });

  it('flags nothing on a plain cover, quiet or noisy', () => {
    expect(anomalyRows(cover(108, 48))).toEqual([]);
    expect(anomalyRows(cover(108, 48, true))).toEqual([]);
  });

  it('flags nothing on images too small to judge', () => {
    expect(anomalyRows(cover(8, 8))).toEqual([]);
  });

  it('groups contiguous rows into ranges', () => {
    expect(
      rowRanges([
        { row: 2, score: 0.4 },
        { row: 3, score: 0.6 },
        { row: 7, score: 0.5 },
      ]),
    ).toEqual([
      { from: 2, to: 3, score: 0.6 },
      { from: 7, to: 7, score: 0.5 },
    ]);
  });
});

describe('strideHint', () => {
  it('finds a stride of 2 on the even pixels of the carrier row', () => {
    expect(strideHint(rowZeroEven(108, 48), 0)).toEqual({ step: 2, offset: 0 });
  });

  it('finds the odd offset too, and says nothing on a quiet row', () => {
    const img = cover(108, 4);
    let s = 7;
    for (let x = 1; x < 108; x += 2) {
      for (let c = 0; c < 3; c++) {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        img.data[x * 4 + c] = (img.data[x * 4 + c]! & 0xfe) | ((s >>> 24) & 1);
      }
    }
    expect(strideHint(img, 0)).toEqual({ step: 2, offset: 1 });
    expect(strideHint(img, 1)).toBeNull();
  });
});

describe('zones and embedding', () => {
  it('parses row lists and rejects bad ones', () => {
    expect(parseRows('', 10)).toBeNull();
    expect(rowsLabel(parseRows('0, 3-4,9', 10)!)).toBe('0,3-4,9');
    expect(() => parseRows('x', 10)).toThrow(/Bad row/);
    expect(() => parseRows('5-2', 10)).toThrow(/smaller/);
    expect(() => parseRows('10', 10)).toThrow(/no row 10/);
  });

  it('limits a traversal to the zone rows', () => {
    const px = zonePixels(4, 3, 'column', rangeMask(3, 1, 1));
    expect(Array.from(px)).toEqual([4, 5, 6, 7]);
  });

  it('embedBits is the inverse of extractBits with zone, step and offset', () => {
    const img = cover(40, 10);
    const payload = new TextEncoder().encode('FTF{embed}');
    const pixels = zonePixels(40, 10, 'serpentine', parseRows('2-5', 10));
    const p = {
      channels: [0, 1, 2],
      planes: [0],
      order: 'row' as const,
      bitOrder: 'msb' as const,
      pixels,
      step: 2,
      offset: 1,
    };
    const stego = embedBits(img, p, payload)!;
    expect(new TextDecoder().decode(extractBits(stego, p, payload.length))).toBe('FTF{embed}');
    expect(embedBits(img, p, new Uint8Array(1000))).toBeNull();
  });
});
