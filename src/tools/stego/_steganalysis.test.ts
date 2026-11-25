import { describe, expect, it } from 'vitest';
import type { RgbaImage } from '../../core/types';
import {
  channelSamples,
  chiByBands,
  chiSquare,
  coherenceByRow,
  outlierPixels,
  rsAnalysis,
} from './_steganalysis';

const rng = (seed: number) => () => {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  return seed >>> 16;
};

/**
 * A natural-ish grey cover: random values smoothed with a small box blur (so neighbouring pixels
 * correlate the way a real photo does — RS needs that), with every LSB forced to 0 so the pairs
 * 2k/2k+1 start unequal and the LSB plane is a clean baseline.
 */
function cover(w: number, h: number): RgbaImage {
  const next = rng(77);
  const base = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) base[i] = next() % 256;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      let count = 0;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const yy = y + dy;
          const xx = x + dx;
          if (yy >= 0 && yy < h && xx >= 0 && xx < w) {
            sum += base[yy * w + xx]!;
            count++;
          }
        }
      }
      const v = (Math.round(sum / count) & 0xfe) as number;
      const o = (y * w + x) * 4;
      data[o] = v;
      data[o + 1] = v;
      data[o + 2] = v;
      data[o + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

/** Overwrite bit 0 of R,G,B with random bits on the first `fraction` of pixels. */
function embedLsb(img: RgbaImage, fraction = 1, seed = 5): RgbaImage {
  const data = new Uint8ClampedArray(img.data);
  const next = rng(seed);
  const n = Math.floor(img.width * img.height * fraction);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) data[i * 4 + c] = (data[i * 4 + c]! & 0xfe) | (next() & 1);
  }
  return { width: img.width, height: img.height, data };
}

describe('steganalysis — chi-square (Westfeld)', () => {
  it('is near 0 on a clean cover and near 1 when every LSB is used', () => {
    const clean = cover(128, 96);
    const full = embedLsb(clean, 1);
    expect(chiSquare(channelSamples(clean, 0)).p).toBeLessThan(0.2);
    expect(chiSquare(channelSamples(full, 0)).p).toBeGreaterThan(0.9);
  });

  it('localises embedding to the bands that carry it', () => {
    const half = embedLsb(cover(128, 96), 0.5);
    const bands = chiByBands(channelSamples(half, 0), 8);
    expect(bands[0]!).toBeGreaterThan(0.9); // first half embedded
    expect(bands[7]!).toBeLessThan(0.2); // last half clean
  });
});

describe('steganalysis — RS (Fridrich)', () => {
  it('estimates ~0 on a clean cover and rises with the embedding rate', () => {
    const clean = cover(160, 120);
    // RS is a known under-estimator on smooth synthetic content, so assert the trend, not the exact rate.
    const e0 = rsAnalysis(clean, 0).estimate;
    const e70 = rsAnalysis(embedLsb(clean, 0.7), 0).estimate;
    const e100 = rsAnalysis(embedLsb(clean, 1), 0).estimate;
    expect(e0).toBeLessThan(0.1);
    expect(e70).toBeGreaterThan(e0);
    expect(e100).toBeGreaterThan(0.3);
  });
});

describe('steganalysis — inter-channel coherence', () => {
  it('flags a replaced zone on rows 1-4, leaving smooth rows quiet', () => {
    const img = cover(120, 20);
    const next = rng(9);
    for (let y = 1; y <= 4; y++) {
      for (let x = 0; x < 120; x++) {
        const o = (y * 120 + x) * 4;
        img.data[o] = next() & 0xff;
        img.data[o + 1] = next() & 0xff;
        img.data[o + 2] = next() & 0xff;
      }
    }
    const rows = coherenceByRow(img);
    for (let y = 1; y <= 4; y++) expect(rows[y]!).toBeGreaterThan(0.3);
    expect(rows[10]!).toBeLessThan(0.1);
  });
});

describe('steganalysis — outlier pixels', () => {
  it('finds planted lone pixels far from their neighbours', () => {
    const img = cover(40, 40);
    const spots = [
      [10, 10],
      [20, 25],
      [33, 7],
    ];
    for (const [x, y] of spots) img.data[(y! * 40 + x!) * 4] = 250;
    const found = outlierPixels(img, 0, 48);
    expect(found.length).toBeGreaterThanOrEqual(3);
    expect(found.some((o) => o.x === 10 && o.y === 10 && o.value === 250)).toBe(true);
  });
});
