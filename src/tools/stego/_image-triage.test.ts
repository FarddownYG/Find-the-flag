import { describe, expect, it } from 'vitest';
import type { RgbaImage } from '../../core/types';
import { rankSuspects, scorePlane } from './_image-triage';

const W = 128;
const H = 64;

const plane = (bit: (x: number, y: number) => number): RgbaImage => {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = bit(x, y) * 255;
      data[i + 3] = 255;
    }
  }
  return { width: W, height: H, data };
};

function lcg(seed: number) {
  let s = seed;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const noise = (() => {
  const r = lcg(7);
  return plane(() => (r() < 0.5 ? 1 : 0));
})();

/** Text-like: lines of 5x7 random glyphs drawn at 2x, on a blank page. */
const text = (() => {
  const r = lcg(42);
  const glyphs = Array.from({ length: 12 }, () =>
    Array.from({ length: 35 }, () => (r() < 0.5 ? 1 : 0)),
  );
  const cells = new Map<string, number>();
  return plane((x, y) => {
    const col = Math.floor(x / 2);
    const row = Math.floor(y / 2);
    const gx = col % 6;
    const gy = row % 10;
    if (gx >= 5 || gy >= 7 || row >= 30) return 0;
    const key = `${Math.floor(col / 6)},${Math.floor(row / 10)}`;
    if (!cells.has(key)) cells.set(key, Math.floor(r() * glyphs.length));
    return glyphs[cells.get(key)!]![gy * 5 + gx]!;
  });
})();

const flat = plane(() => 0);

describe('scorePlane', () => {
  const n = scorePlane(noise, W, H);
  const t = scorePlane(text, W, H);
  const f = scorePlane(flat, W, H);
  it('scores noise low and text-like content high', () => {
    expect(n.suspicion).toBeLessThan(0.1);
    expect(t.suspicion).toBeGreaterThan(0.3);
    expect(t.suspicion).toBeGreaterThan(n.suspicion * 4);
    expect(n.compression).toBeGreaterThan(0.95);
    expect(t.compression).toBeLessThan(n.compression);
    expect(n.autocorr).toBeLessThan(0.1);
  });
  it('does not flag a flat plane', () => {
    expect(f.suspicion).toBe(0);
    expect(f.entropy).toBe(0);
  });
  it('accepts a 0/1 byte array like an image', () => {
    const bytes = new Uint8Array(W * H);
    for (let i = 0; i < bytes.length; i++) bytes[i] = text.data[i * 4]! >= 128 ? 1 : 0;
    expect(scorePlane(bytes, W, H).suspicion).toBeCloseTo(t.suspicion, 10);
  });
  it('ranks the structured plane first', () => {
    const ranked = rankSuspects([
      { label: 'flat', image: flat },
      { label: 'noise', image: noise },
      { label: 'text', image: text },
    ]);
    expect(ranked[0]!.label).toBe('text');
    expect(ranked[1]!.score).toBeLessThan(0.1);
    expect(ranked[2]!.score).toBeLessThan(0.1);
  });
});
