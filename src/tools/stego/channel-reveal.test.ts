import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors';
import { prepareInput } from '../../core/prepare';
import { resultToText } from '../../core/result-text';
import type { ImageInput, Output, RgbaImage } from '../../core/types';
import {
  CHANNEL_INFO,
  DEFAULT_REVEAL,
  buildLut,
  channelStats,
  channelValues,
  effectiveScale,
  histogram,
  normalizeCrop,
  percentile,
  reveal,
  revealDetailed,
  sparseTails,
  statsHint,
  type Channel,
  type RevealOptions,
} from './_channel';
import channelReveal from './channel-reveal';

// ---------- helpers ----------

type Pixel = [number, number, number, number];

const make = (w: number, h: number, f: (x: number, y: number) => Pixel): RgbaImage => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) data.set(f(x, y), (y * w + x) * 4);
  }
  return { width: w, height: h, data };
};

/** One row whose red channel is `values` (green and blue 0, opaque). */
const strip = (values: number[]): RgbaImage =>
  make(values.length, 1, (x) => [values[x]!, 0, 0, 255]);

/** A strip with `count` pixels of each value, in order. */
const counts = (spec: [value: number, count: number][]): RgbaImage =>
  strip(spec.flatMap(([v, n]) => Array.from({ length: n }, () => v)));

/** Options that change nothing: red channel, no invert, no stretch. */
const plain: RevealOptions = {
  channel: 'r',
  invert: false,
  stretch: 'none',
  gain: 1,
  gamma: 1,
  threshold: 0,
  scale: 1,
};

/** Grey level of every pixel of a revealed image (asserts it is opaque grey). */
function greys(img: RgbaImage): number[] {
  const out: number[] = [];
  for (let i = 0; i < img.data.length; i += 4) {
    const [r, g, b, a] = [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!, img.data[i + 3]!];
    expect([g, b, a]).toEqual([r, r, 255]);
    out.push(r);
  }
  return out;
}

const levels = (values: number[], o: Partial<RevealOptions>) =>
  greys(reveal(strip(values), { ...plain, ...o }));

/** Boolean mask of the lit pixels of a text-like pattern, drawn as bars. */
function textMask(w: number, h: number): boolean[] {
  const mask = new Array<boolean>(w * h).fill(false);
  const bar = (x0: number, y0: number, bw: number, bh: number) => {
    for (let y = y0; y < y0 + bh; y++) for (let x = x0; x < x0 + bw; x++) mask[y * w + x] = true;
  };
  for (let k = 0; k < 6; k++) {
    bar(10 + k * 18, 8, 3, 24); // stems
    bar(10 + k * 18, 8, 12, 3); // tops
    bar(10 + k * 18, 20, 9, 3); // middles
  }
  return mask;
}

function pageWithFaintText(
  w: number,
  h: number,
  mask: boolean[],
  paper: Pixel = [255, 255, 255, 255],
  ink: Pixel = [255, 255, 236, 255],
): RgbaImage {
  return make(w, h, (x, y) => (mask[y * w + x] ? ink : paper));
}

const imageOf = (out: Output[]) => {
  const block = out.find((o) => o.type === 'image');
  if (block?.type !== 'image') throw new Error('no image block');
  return block;
};
const notes = (out: Output[], level: 'info' | 'warn' | 'error' | 'success') =>
  out.flatMap((o) => (o.type === 'note' && o.level === level ? [o.text] : []));

const toolDefaults = Object.fromEntries(
  Object.entries(channelReveal.options ?? {}).map(([k, spec]) => [k, spec.default]),
) as Parameters<typeof channelReveal.run>[1];

const runTool = (image: RgbaImage, o: Partial<Parameters<typeof channelReveal.run>[1]> = {}) =>
  channelReveal.run({ bytes: new Uint8Array(), image }, { ...toolDefaults, ...o }) as Output[];

async function sample(name: string): Promise<ImageInput> {
  const bytes = new Uint8Array(
    readFileSync(new URL(`../../../public/samples/${name}`, import.meta.url)),
  );
  return (await prepareInput('image', { bytes, name })) as ImageInput;
}

// ---------- channel formulas ----------

describe('channelValues', () => {
  // r, g, b, a for six pixels; pixels 3 and 5 probe the near-white ink and transparency.
  const PIXELS: Pixel[] = [
    [10, 20, 30, 40],
    [255, 0, 128, 255],
    [0, 0, 0, 0],
    [255, 255, 236, 255],
    [200, 100, 50, 255],
    [7, 8, 9, 0],
  ];
  const img = make(6, 1, (x) => PIXELS[x]!);

  const expected: Record<Channel, number[]> = {
    r: [10, 255, 0, 255, 200, 7],
    g: [20, 0, 0, 255, 100, 8],
    b: [30, 128, 0, 236, 50, 9],
    a: [40, 255, 0, 255, 255, 0],
    c: [245, 0, 255, 0, 55, 248], // 255 - R
    m: [235, 255, 255, 0, 155, 247], // 255 - G
    y: [225, 127, 255, 19, 205, 246], // 255 - B
    k: [225, 0, 255, 0, 55, 246], // 255 - max(R, G, B)
    luma: [18, 91, 0, 253, 124, 8], // round(0.299 R + 0.587 G + 0.114 B)
  };

  it.each(CHANNEL_INFO.map((c) => c.id))('channel %s', (ch) => {
    expect(Array.from(channelValues(img, ch))).toEqual(expected[ch]);
  });

  it('lists every channel exactly once', () => {
    expect(CHANNEL_INFO.map((c) => c.id).sort()).toEqual(Object.keys(expected).sort());
  });

  it('yellow is exactly 255 - blue for every blue value', () => {
    const all = make(256, 1, (x) => [1, 2, x, 255]);
    const y = channelValues(all, 'y');
    const b = channelValues(all, 'b');
    for (let v = 0; v < 256; v++) expect(y[v]).toBe(255 - b[v]!);
  });

  it('returns one byte per pixel, row-major, and nothing for an empty image', () => {
    const tall = make(2, 3, (x, y) => [y * 2 + x, 0, 0, 255]);
    expect(Array.from(channelValues(tall, 'r'))).toEqual([0, 1, 2, 3, 4, 5]);
    expect(
      channelValues({ width: 0, height: 0, data: new Uint8ClampedArray(0) }, 'b'),
    ).toHaveLength(0);
  });

  it('rejects an unknown channel with a readable error', () => {
    expect(() => channelValues(img, 'z' as Channel)).toThrow(ToolError);
  });
});

// ---------- statistics ----------

describe('channelStats', () => {
  it('min, max, mean and nearest-rank percentiles of a 1..100 ramp', () => {
    const ramp = strip(Array.from({ length: 100 }, (_, i) => i + 1));
    expect(channelStats(ramp, 'r')).toEqual({ min: 1, max: 100, mean: 50.5, p1: 1, p99: 99 });
  });

  it('percentiles ignore a rare outlier, min / max do not', () => {
    const s = channelStats(
      counts([
        [0, 5],
        [255, 995],
      ]),
      'r',
    );
    expect(s.min).toBe(0);
    expect(s.max).toBe(255);
    expect(s.p1).toBe(255); // 5 of 1000 pixels is below the 1 % mark
    expect(s.p99).toBe(255);
    expect(s.mean).toBeCloseTo(253.725, 9);
  });

  it('a constant channel has min = max = mean', () => {
    expect(channelStats(counts([[77, 10]]), 'r')).toEqual({
      min: 77,
      max: 77,
      mean: 77,
      p1: 77,
      p99: 77,
    });
  });

  it('percentile on a raw histogram', () => {
    const h = histogram(Uint8Array.from([5, 5, 5, 9]));
    expect(percentile(h, 4, 50)).toBe(5);
    expect(percentile(h, 4, 75)).toBe(5);
    expect(percentile(h, 4, 76)).toBe(9);
    expect(percentile(h, 0, 50)).toBe(0);
  });

  it('hints: faint spread, constant channel, ordinary content', () => {
    expect(statsHint('b', { min: 228, max: 255, mean: 254, p1: 255, p99: 255 })).toBe(
      'Blue channel spans only 228-255: something faint is there.',
    );
    expect(statsHint('a', { min: 255, max: 255, mean: 255, p1: 255, p99: 255 })).toBe(
      'Alpha channel is constant (255): nothing is hidden in it, try another channel.',
    );
    expect(statsHint('g', { min: 0, max: 255, mean: 120, p1: 3, p99: 250 })).toBeNull();
    expect(statsHint('g', { min: 100, max: 140, mean: 120, p1: 100, p99: 140 })).not.toBeNull();
    expect(statsHint('g', { min: 100, max: 141, mean: 120, p1: 100, p99: 141 })).toBeNull();
  });
});

// ---------- the maths of each stage ----------

describe('reveal: invert, gain, gamma, threshold', () => {
  it('no stage = identity', () => {
    expect(levels([0, 1, 127, 128, 254, 255], {})).toEqual([0, 1, 127, 128, 254, 255]);
  });

  it('invert is 255 - v', () => {
    expect(levels([0, 1, 254, 255], { invert: true })).toEqual([255, 254, 1, 0]);
  });

  it('gain multiplies and clamps at 255', () => {
    expect(levels([0, 50, 100, 127, 128, 200], { gain: 2 })).toEqual([0, 100, 200, 254, 255, 255]);
    expect(levels([0, 50, 100], { gain: 0.5 })).toEqual([0, 25, 50]);
    expect(levels([10, 255], { gain: 0 })).toEqual([0, 0]);
  });

  it('gamma: out = 255 (v / 255) ^ (1 / gamma)', () => {
    expect(levels([0, 64, 255], { gamma: 2 })).toEqual([0, 128, 255]); // brightens
    expect(levels([0, 128, 255], { gamma: 0.5 })).toEqual([0, 64, 255]); // darkens
  });

  it('threshold: 0 = off, else v >= t is white', () => {
    expect(levels([99, 100, 101], { threshold: 100 })).toEqual([0, 255, 255]);
    expect(levels([254, 255], { threshold: 255 })).toEqual([0, 255]);
    expect(levels([0, 1], { threshold: 1 })).toEqual([0, 255]);
    expect(levels([0, 1, 200], { threshold: 0 })).toEqual([0, 1, 200]);
  });

  it('order is invert, stretch, gain, gamma, threshold', () => {
    // Blue 236 on blue 255 paper: inverted 19 and 0. Gain 4 -> 76 and 0. Threshold 50 keeps the ink.
    const page = make(3, 1, (x) => [255, 255, [236, 255, 250][x]!, 255]);
    const o = { ...plain, channel: 'b' as const, invert: true, gain: 4, threshold: 50 };
    expect(greys(reveal(page, o))).toEqual([255, 0, 0]); // 250 -> 5 -> 20 < 50
    // Stretch comes before gain: 100..199 auto-stretches to 0..255, then gain 0.5 halves it.
    const ramp = Array.from({ length: 100 }, (_, i) => 100 + i);
    const half = levels(ramp, { stretch: 'auto', gain: 0.5 });
    expect([half[0], half[98], half[99]]).toEqual([0, 128, 128]);
  });

  it('bad numbers fall back to neutral values instead of NaN pixels', () => {
    const nan = Number.NaN;
    expect(levels([10, 200], { gain: nan, gamma: nan, threshold: nan, scale: nan })).toEqual([
      10, 200,
    ]);
    expect(levels([10, 200], { gain: Infinity })).toEqual([10, 200]);
    expect(levels([10, 200], { gamma: -3 })).toHaveLength(2);
  });

  it('buildLut is a plain 256-entry table indexed by the raw value', () => {
    const h = new Uint32Array(256);
    const lut = buildLut(h, { invert: true, stretch: 'none', gain: 1, gamma: 1, threshold: 0 });
    expect(lut).toHaveLength(256);
    expect([lut[0], lut[1], lut[254], lut[255]]).toEqual([255, 254, 1, 0]);
  });
});

describe('reveal: contrast stretch', () => {
  const ramp = Array.from({ length: 100 }, (_, i) => 100 + i); // 100..199

  it('auto maps the 1st..99th percentile (100 and 198) to 0..255 and clips beyond', () => {
    const out = levels(ramp, { stretch: 'auto' });
    expect(out[0]).toBe(0); // 100 = p1
    expect(out[24]).toBe(62); // 124 -> 24 * 255 / 98 = 62.45
    expect(out[49]).toBe(128); // 149 -> 127.5 rounds up
    expect(out[74]).toBe(193); // 174 -> 192.55
    expect(out[98]).toBe(255); // 198 = p99
    expect(out[99]).toBe(255); // 199 saturates
  });

  it('auto clips outliers: a few extreme pixels do not squash everything else', () => {
    // 1000 pixels: 5 black, 5 white (1 % together) and 11 each of the levels 100..189.
    const values = [
      ...Array.from({ length: 5 }, () => 0),
      ...Array.from({ length: 90 * 11 }, (_, i) => 100 + Math.floor(i / 11)),
      ...Array.from({ length: 5 }, () => 255),
    ];
    // p1 = 100 and p99 = 189 (nearest rank), so that window is what fills 0..255.
    const out = levels(values, { stretch: 'auto' });
    expect([out[0], out[5], out[5 + 90 * 11 - 1], out[999]]).toEqual([0, 0, 255, 255]);
    expect(out[5 + 45 * 11]).toBe(129); // level 145: 45 * 255 / 89 = 128.9
    const none = levels(values, { stretch: 'none' });
    expect(none[5]).toBe(100); // without a stretch nothing moves
    const full = levels(values, { stretch: 'full' });
    expect(full[5]).toBe(100); // min..max is already 0..255, so the same
  });

  it('auto falls back to min..max when the signal is under 1 % of the pixels', () => {
    // 995 paper pixels at 0 and 5 faint ink pixels at 19 (what inverted blue looks like).
    const img = counts([
      [0, 995],
      [19, 5],
    ]);
    const out = greys(reveal(img, { ...plain, stretch: 'auto' }));
    expect(out.slice(0, 995).every((v) => v === 0)).toBe(true);
    expect(out.slice(995)).toEqual([255, 255, 255, 255, 255]);
  });

  it('full maps min..max exactly', () => {
    expect(levels([50, 100, 150], { stretch: 'full' })).toEqual([0, 128, 255]);
    expect(levels([50, 75, 100, 150], { stretch: 'full' })).toEqual([0, 64, 128, 255]);
  });

  it('a constant channel is left alone by every stretch', () => {
    for (const stretch of ['auto', 'full', 'equalize'] as const) {
      expect(levels([90, 90, 90], { stretch })).toEqual([90, 90, 90]);
    }
  });

  it('equalize follows the cumulative histogram', () => {
    // 50 x 10, 25 x 20, 25 x 30: cdf = 50, 75, 100 -> (cdf - 50) / 50 of 255.
    const img = counts([
      [10, 50],
      [20, 25],
      [30, 25],
    ]);
    const out = greys(reveal(img, { ...plain, stretch: 'equalize' }));
    expect(out[0]).toBe(0);
    expect(out[50]).toBe(128); // 127.5
    expect(out[99]).toBe(255);
  });

  it('stretch is computed on the inverted values', () => {
    // Inverted, 10 stays the low end and 30 the high end of the same three levels.
    const img = counts([
      [10, 50],
      [20, 25],
      [30, 25],
    ]);
    const out = greys(reveal(img, { ...plain, invert: true, stretch: 'full' }));
    expect(out[0]).toBe(255); // 10 -> 245 -> top of the window
    expect(out[50]).toBe(128); // 20 -> 235 -> middle
    expect(out[99]).toBe(0); // 30 -> 225 -> bottom
  });

  it('blue + invert equals yellow without invert', () => {
    const page = pageWithFaintText(180, 40, textMask(180, 40));
    const viaBlue = reveal(page, { ...DEFAULT_REVEAL, channel: 'b', invert: true });
    const viaYellow = reveal(page, { ...DEFAULT_REVEAL, channel: 'y', invert: false });
    expect(Array.from(viaBlue.data)).toEqual(Array.from(viaYellow.data));
  });
});

// ---------- crop and zoom ----------

describe('crop and zoom', () => {
  // r = x + 10 y on a 10 x 5 image, so every pixel is identifiable.
  const grid = make(10, 5, (x, y) => [x + 10 * y, 0, 0, 255]);

  it('normalizeCrop: whole image, edge-relative sizes, clamping, errors', () => {
    expect(normalizeCrop(grid)).toEqual({
      rect: { x: 0, y: 0, w: 10, h: 5 },
      adjusted: false,
      whole: true,
    });
    expect(normalizeCrop(grid, { x: 0, y: 0, w: 0, h: 0 }).whole).toBe(true);
    expect(normalizeCrop(grid, { x: 2, y: 1, w: 3, h: 2 })).toEqual({
      rect: { x: 2, y: 1, w: 3, h: 2 },
      adjusted: false,
      whole: false,
    });
    // 0 = up to the edge, which is not an adjustment
    expect(normalizeCrop(grid, { x: 4, y: 3, w: 0, h: 0 })).toEqual({
      rect: { x: 4, y: 3, w: 6, h: 2 },
      adjusted: false,
      whole: false,
    });
    // too big: clamped and flagged
    expect(normalizeCrop(grid, { x: 8, y: 4, w: 50, h: 50 })).toEqual({
      rect: { x: 8, y: 4, w: 2, h: 1 },
      adjusted: true,
      whole: false,
    });
    // negative origin and size, fractions, NaN
    expect(normalizeCrop(grid, { x: -3, y: -1, w: 4, h: 2 })).toEqual({
      rect: { x: 0, y: 0, w: 4, h: 2 },
      adjusted: true,
      whole: false,
    });
    expect(normalizeCrop(grid, { x: 1.9, y: 1.2, w: 2.7, h: Number.NaN }).rect).toEqual({
      x: 1,
      y: 1,
      w: 2,
      h: 4,
    });
    // exactly the last pixel is allowed, one more is not
    expect(normalizeCrop(grid, { x: 9, y: 4, w: 1, h: 1 }).rect).toEqual({
      x: 9,
      y: 4,
      w: 1,
      h: 1,
    });
    expect(() => normalizeCrop(grid, { x: 10, y: 0, w: 1, h: 1 })).toThrow(ToolError);
    expect(() => normalizeCrop(grid, { x: 0, y: 5, w: 1, h: 1 })).toThrow(/outside the 10×5 image/);
  });

  it('a crop shows exactly those pixels', () => {
    const out = reveal(grid, { ...plain, crop: { x: 2, y: 1, w: 3, h: 2 } });
    expect([out.width, out.height]).toEqual([3, 2]);
    expect(greys(out)).toEqual([12, 13, 14, 22, 23, 24]);
  });

  it('statistics describe the cropped region only', () => {
    const res = revealDetailed(grid, { ...plain, crop: { x: 2, y: 1, w: 3, h: 2 } });
    expect(res.stats.min).toBe(12);
    expect(res.stats.max).toBe(24);
    expect(res.stats.mean).toBeCloseTo((12 + 13 + 14 + 22 + 23 + 24) / 6, 9);
  });

  it('stretch is computed inside the crop, not over the whole image', () => {
    const out = reveal(grid, { ...plain, stretch: 'full', crop: { x: 2, y: 1, w: 3, h: 2 } });
    expect(greys(out)[0]).toBe(0); // 12 is the minimum of the crop
    expect(greys(out)[5]).toBe(255); // 24 the maximum
  });

  it('zoom replicates every pixel into a scale x scale block (nearest neighbour)', () => {
    const out = reveal(grid, { ...plain, crop: { x: 2, y: 1, w: 3, h: 2 }, scale: 4 });
    expect([out.width, out.height]).toEqual([12, 8]);
    const g = greys(out);
    const src = [12, 13, 14, 22, 23, 24];
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 12; x++) {
        expect(g[y * 12 + x]).toBe(src[Math.floor(y / 4) * 3 + Math.floor(x / 4)]);
      }
    }
  });

  it('zoom 1 and zoom 3 of the whole image have the right size', () => {
    expect([reveal(grid, plain).width, reveal(grid, plain).height]).toEqual([10, 5]);
    const z3 = reveal(grid, { ...plain, scale: 3 });
    expect([z3.width, z3.height, z3.data.length]).toEqual([30, 15, 30 * 15 * 4]);
  });

  it('zoom is a whole number between 1 and 16', () => {
    const w = (scale: number) => reveal(grid, { ...plain, scale }).width;
    expect(w(0)).toBe(10);
    expect(w(-4)).toBe(10);
    expect(w(Number.NaN)).toBe(10);
    expect(w(2.6)).toBe(30);
    expect(w(16)).toBe(160);
    expect(w(99)).toBe(160);
  });

  it('effectiveScale lowers a zoom that would exceed the pixel budget, never below 1', () => {
    expect(effectiveScale(100, 100, 16)).toBe(16);
    expect(effectiveScale(100, 100, 99)).toBe(16);
    expect(effectiveScale(2000, 2000, 16)).toBe(2); // 4000 x 4000 fits, 6000 x 6000 does not
    expect(effectiveScale(3000, 4000, 16)).toBe(1); // already above the budget at 1x
    expect(effectiveScale(10, 10, 0)).toBe(1);
  });

  it('a crop that touches the image edge still has the right pixels at zoom', () => {
    const out = reveal(grid, { ...plain, crop: { x: 9, y: 4, w: 0, h: 0 }, scale: 2 });
    expect([out.width, out.height]).toEqual([2, 2]);
    expect(greys(out)).toEqual([49, 49, 49, 49]);
  });
});

// ---------- the point of the tool ----------

describe('invisible text becomes high contrast', () => {
  const W = 130;
  const H = 40;
  const mask = textMask(W, H);
  const page = pageWithFaintText(W, H, mask);
  const spread = (values: ArrayLike<number>) =>
    Math.max(...Array.from(values)) - Math.min(...Array.from(values));

  it('is nearly invisible to the eye: luma differs by only 2 levels', () => {
    expect(spread(channelValues(page, 'luma'))).toBe(2);
    expect(spread(channelValues(page, 'r'))).toBe(0);
    expect(spread(channelValues(page, 'g'))).toBe(0);
    expect(spread(channelValues(page, 'b'))).toBe(19);
  });

  it('default settings (blue, inverted, auto stretch) give exact black and white', () => {
    const out = greys(reveal(page, DEFAULT_REVEAL));
    expect(out.every((v, i) => v === (mask[i] ? 255 : 0))).toBe(true);
    expect(spread(out)).toBe(255);
  });

  it('every other way in also separates ink from paper', () => {
    const ways: Partial<RevealOptions>[] = [
      { channel: 'y', invert: false },
      { channel: 'b', invert: true, stretch: 'full' },
      { channel: 'b', invert: true, stretch: 'equalize' },
      { channel: 'b', invert: true, stretch: 'none', gain: 13 }, // 19 * 13 = 247
      { channel: 'b', invert: true, stretch: 'none', threshold: 10 },
    ];
    ways.forEach((way) => {
      const out = greys(reveal(page, { ...DEFAULT_REVEAL, ...way }));
      const ink = out.filter((_, i) => mask[i]);
      const paper = out.filter((_, i) => !mask[i]);
      expect(Math.min(...ink)).toBeGreaterThanOrEqual(247);
      expect(Math.max(...paper)).toBe(0);
    });
  });

  it('red, green and black key hold nothing: revealing them yields one flat grey', () => {
    for (const channel of ['r', 'g', 'k'] as const) {
      const out = greys(reveal(page, { ...DEFAULT_REVEAL, channel }));
      expect(new Set(out).size).toBe(1);
    }
  });

  it('a noisy scan: Full range and Auto both keep sparse ink clear of the noise', () => {
    // 0.5 % of the pixels are ink (blue 236); the paper's blue wobbles between 253 and 255.
    const w = 200;
    const h = 100;
    let seed = 12345;
    const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296;
    const noisy = make(w, h, (x, y) => {
      const ink = (x * 7 + y * 13) % 200 === 0;
      return [255, 255, ink ? 236 : 253 + Math.floor(rnd() * 3), 255];
    });
    const inkAt = (x: number, y: number) => (x * 7 + y * 13) % 200 === 0;
    const split = (o: Partial<RevealOptions>) => {
      const out = greys(reveal(noisy, { ...DEFAULT_REVEAL, ...o }));
      return {
        ink: out.filter((_, i) => inkAt(i % w, Math.floor(i / w))),
        paper: out.filter((_, i) => !inkAt(i % w, Math.floor(i / w))),
      };
    };
    const full = split({ stretch: 'full' });
    expect(Math.min(...full.ink)).toBe(255);
    expect(Math.max(...full.paper)).toBeLessThan(60); // noise 0..2 of 19 levels
    // The 1-99 % window sits inside the noise (253-255); the ink is a sparse tail far beyond it,
    // so Auto widens the window up to it instead of clipping it to the noise level.
    const auto = split({ stretch: 'auto' });
    expect(Math.min(...auto.ink)).toBe(255);
    expect(Math.max(...auto.paper)).toBeLessThan(60);
  });

  it('sparse tails: found beyond 5 robust sigmas when they are 4 pixels to 1 % of the region', () => {
    const hist = new Uint32Array(256);
    hist[10] = 400;
    hist[11] = 500;
    hist[12] = 100;
    expect(sparseTails(hist, 1000)).toEqual({ lo: null, hi: null });
    hist[40] = 6; // 0.6 %: a tail
    hist[41] = 2;
    expect(sparseTails(hist, 1008)).toEqual({ lo: null, hi: 40 });
    hist[0] = 3; // 3 pixels: too few to be a signal
    expect(sparseTails(hist, 1011).lo).toBeNull();
    hist[40] = 60; // 6 %: an ordinary part of the picture, not a sparse tail
    expect(sparseTails(hist, 1065).hi).toBeNull();
  });

  it('faint dots (12 levels, noise sigma 2, 0.5 % of the page): the default shows them', () => {
    const w = 240;
    const h = 160;
    let seed = 7;
    const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296;
    const gauss = () =>
      Math.sqrt(-2 * Math.log(Math.max(1e-9, rnd()))) * Math.cos(2 * Math.PI * rnd());
    const dot = (x: number, y: number) => x % 24 < 2 && y % 24 < 2 && (x + y) % 48 < 24;
    const page = make(w, h, (x, y) => [
      246,
      244,
      Math.round(238 - (dot(x, y) ? 12 : 0) + 2 * gauss()),
      255,
    ]);
    const out = greys(reveal(page, DEFAULT_REVEAL));
    const at = (pred: (x: number, y: number) => boolean) =>
      out.filter((_, i) => pred(i % w, Math.floor(i / w)));
    const dots = at(dot);
    const paper = at((x, y) => !dot(x, y));
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(dots.length / out.length).toBeLessThan(0.01);
    expect(mean(dots)).toBeGreaterThan(180);
    expect(mean(paper)).toBeLessThan(110);
    // Bright noise is rare: well under the 41 % the plain 1-99 % window gave.
    expect(paper.filter((v) => v > 200).length / paper.length).toBeLessThan(0.02);
  });
});

// ---------- the tool ----------

describe('channel-reveal tool', () => {
  it('is registered the way the platform expects', () => {
    expect(channelReveal.id).toBe('channel-reveal');
    expect(channelReveal.category).toBe('stego');
    expect(channelReveal.input).toBe('image');
    expect(channelReveal.live).toBe(true);
    expect(channelReveal.examples.length).toBeGreaterThanOrEqual(2);
    expect(toolDefaults).toMatchObject({
      inkOnly: false,
      channel: DEFAULT_REVEAL.channel,
      invert: DEFAULT_REVEAL.invert,
      stretch: DEFAULT_REVEAL.stretch,
      zoom: 1,
      cropW: 0,
    });
  });

  it('the shipped sample is invisible but the default run reveals it exactly', async () => {
    const { image } = await sample('channel-faint-text.png');
    const ink = Array.from({ length: image.width * image.height }, (_, i) => {
      const [r, g, b] = [image.data[i * 4]!, image.data[i * 4 + 1]!, image.data[i * 4 + 2]!];
      return r === 255 && g === 255 && b === 236;
    });
    const lit = ink.filter(Boolean).length;
    expect(lit).toBeGreaterThan(500);
    expect(lit).toBeLessThan(ink.length / 4);
    // Before: the luma of ink and paper differ by 2 out of 255.
    const luma = channelValues(image, 'luma');
    expect(Math.max(...luma) - Math.min(...luma)).toBe(2);

    const out = runTool(image);
    const shown = imageOf(out);
    expect([shown.image.width, shown.image.height]).toEqual([image.width, image.height]);
    expect(greys(shown.image).every((v, i) => v === (ink[i] ? 255 : 0))).toBe(true);
    expect(shown.label).toBe('Blue channel, inverted, auto stretch (1–99 %)');

    const text = resultToText(out);
    expect(text).toContain('Range: 236–255');
    expect(text).toContain('Region: 560×96 px (whole image)');
    expect(text).toContain('Blue channel spans only 236-255: something faint is there.');
    expect(notes(out, 'info')).toContain('Processed locally — nothing uploaded.');
  });

  it('statistics are reported for the raw channel, not the inverted one', async () => {
    const { image } = await sample('channel-faint-text.png');
    const text = resultToText(runTool(image, { channel: 'y', invert: false }));
    expect(text).toContain('Range: 0–19');
    expect(text).toContain('Channel: Yellow (255 − B)');
    expect(text).toContain('p1: 0');
    expect(text).toContain('p99: 19'); // the ink is about 9 % of the page, so it is above p99
    const red = resultToText(runTool(image, { channel: 'r' }));
    expect(red).toContain('Range: 255–255');
    expect(red).toContain('Red channel is constant (255)');
    expect(red).not.toContain('something faint');
  });

  it('crop and zoom: image size, region text and output size agree', async () => {
    const { image } = await sample('channel-faint-text.png');
    const out = runTool(image, { cropX: 20, cropY: 56, cropW: 90, cropH: 24, zoom: 4 });
    const shown = imageOf(out).image;
    expect([shown.width, shown.height]).toEqual([360, 96]);
    const text = resultToText(out);
    expect(text).toContain('Region: 90×24 px at (20, 56) of 560×96');
    expect(text).toContain('Output: 360×96 px (zoom ×4)');
    // Inside the crop the first word "flag{" is lit, so both extremes are present.
    expect(new Set(greys(shown))).toEqual(new Set([0, 255]));
    expect(notes(out, 'warn')).toEqual([]);
  });

  it('a crop sticking out of the image is clamped with a warning', () => {
    const img = make(100, 50, () => [255, 255, 250, 255]);
    const out = runTool(img, { cropX: 60, cropY: 10, cropW: 500, cropH: 500 });
    const shown = imageOf(out).image;
    expect([shown.width, shown.height]).toEqual([40, 40]);
    expect(notes(out, 'warn')[0]).toContain('showing 40×40 px at (60, 10)');
  });

  it('a crop that starts outside the image is a ToolError', () => {
    const img = make(100, 50, () => [255, 255, 250, 255]);
    expect(() => runTool(img, { cropX: 100 })).toThrow(ToolError);
    expect(() => runTool(img, { cropY: 50 })).toThrow(/outside the 100×50 image/);
  });

  it('an over-large zoom is lowered with a warning, not allocated', () => {
    const img = make(1800, 1800, () => [255, 255, 250, 255]);
    const out = runTool(img, { zoom: 16 });
    const shown = imageOf(out).image;
    expect([shown.width, shown.height]).toEqual([3600, 3600]);
    expect(notes(out, 'warn')[0]).toContain('Zoom lowered from ×16 to ×2');
  });

  it('a region over 4 megapixels at zoom 1 is previewed reduced, keeping isolated dots', () => {
    const img = make(2200, 2200, (x, y) =>
      x % 50 === 7 && y % 50 === 9 ? [255, 255, 200, 255] : [255, 255, 250, 255],
    );
    const out = runTool(img, { zoom: 16 });
    const shown = imageOf(out).image;
    expect([shown.width, shown.height]).toEqual([1100, 1100]);
    expect(notes(out, 'info')[0]).toMatch(/shown reduced ×2 \(1100×1100\).*Crop a region/);
    expect(resultToText(out)).toContain('Output: 1100×1100 px (reduced ×2)');
    // Every single-pixel dot survives the reduction (a plain downscale would blur it away).
    const at = (x: number, y: number) => shown.data[(y * 1100 + x) * 4];
    expect(at(3, 4)).toBe(255);
    expect(at(28, 29)).toBe(255);
    expect(at(10, 10)).toBe(0);
  });

  it('a text page with faint dots: the default says how to drop the text; colour ink only shows the dots', () => {
    // Paper, dark text bars on 6 % of the page, faint yellow dots every 12 px.
    const page = make(240, 160, (x, y) =>
      y % 20 < 3 && x > 20 && x < 220
        ? [50, 50, 50, 255]
        : x % 12 === 6 && y % 12 === 6
          ? [246, 244, 214, 255]
          : [246, 244, 238, 255],
    );
    const plainOut = runTool(page);
    expect(notes(plainOut, 'info').join(' ')).toMatch(/Turn on Colour ink only/);
    const inkOut = runTool(page, { inkOnly: true });
    expect(notes(inkOut, 'info').join(' ')).not.toMatch(/Turn on Colour ink only/);
    const g = (out: Output[], x: number, y: number) => imageOf(out).image.data[(y * 240 + x) * 4]!;
    // Plain blue: the text outshines the dots. Colour ink only: the dots are the brightest thing.
    expect(g(plainOut, 50, 1)).toBeGreaterThan(g(plainOut, 54, 54));
    expect(g(inkOut, 54, 54)).toBe(255);
    expect(g(inkOut, 50, 1)).toBe(0);
  });

  it('colour ink only: black text and grey shading go flat, yellow ink stays', () => {
    // Left half: black text strokes; right column: faint yellow ink; elsewhere grey shading.
    const img = make(60, 20, (x, y) =>
      x < 30 && y % 4 === 0
        ? [40, 40, 40, 255]
        : x === 50
          ? [250, 248, 215, 255]
          : [200, 200, 200, 255],
    );
    const plainRun = runTool(img, { stretch: 'none' });
    const inkRun = runTool(img, { inkOnly: true, stretch: 'none' });
    const g = (out: Output[], x: number, y: number) => imageOf(out).image.data[(y * 60 + x) * 4];
    expect(g(plainRun, 5, 0)).toBe(215); // text: inverted blue 40 -> bright
    expect(g(inkRun, 5, 0)).toBe(0); // gone: grey has no colour ink
    expect(g(inkRun, 10, 1)).toBe(0); // grey shading gone too
    expect(g(inkRun, 50, 3)).toBe(33); // min(250, 248) - 215 = 33 levels of yellow ink
    expect(imageOf(inkRun).label).toBe('Blue channel, colour ink only, inverted, no stretch');
    expect(resultToText(inkRun)).toContain('Channel: Blue (B), colour ink only');
    expect(resultToText(runTool(img, { inkOnly: true, channel: 'k' }))).toContain(
      'colour ink only does not apply to this channel',
    );
  });

  it('describes the non-default steps in the picture label', () => {
    const img = make(8, 8, (x) => [x * 30, 0, 0, 255]);
    const label = imageOf(
      runTool(img, {
        channel: 'r',
        invert: false,
        stretch: 'none',
        gain: 2,
        gamma: 1.5,
        threshold: 90,
      }),
    ).label;
    expect(label).toBe('Red channel, no stretch, gain ×2, gamma 1.5, threshold ≥ 90');
  });

  it('works on an image with transparency: colours under alpha 0 are read, alpha is a channel', () => {
    const img = make(4, 1, (x) => [255, 255, 236, x === 0 ? 0 : 255]);
    const blue = resultToText(runTool(img, { channel: 'b' }));
    expect(blue).toContain('Range: 236–236');
    const alpha = resultToText(runTool(img, { channel: 'a' }));
    expect(alpha).toContain('Range: 0–255');
  });
});

// ---------- speed ----------

describe('speed on a 3000 x 4000 scan', () => {
  const W = 3000;
  const H = 4000;
  const big = ((): RgbaImage => {
    const data = new Uint8ClampedArray(W * H * 4);
    new Uint32Array(data.buffer).fill(0xffffffff); // opaque white
    // Faint ink: a grid of small squares in (255, 255, 236).
    for (let y = 200; y < H - 200; y += 40) {
      for (let x = 200; x < W - 200; x += 40) {
        for (let dy = 0; dy < 6; dy++) {
          for (let dx = 0; dx < 6; dx++) data[((y + dy) * W + x + dx) * 4 + 2] = 236;
        }
      }
    }
    return { width: W, height: H, data };
  })();

  const time = (f: () => void) => {
    const t0 = performance.now();
    f();
    return performance.now() - t0;
  };

  it('a crop takes under 1 s', () => {
    const o = { cropX: 1000, cropY: 1500, cropW: 600, cropH: 800, zoom: 2 };
    runTool(big, o); // warm-up
    const best = Math.min(...[0, 1, 2].map(() => time(() => runTool(big, o))));
    // Generous: about 30 ms on the development machine; the budget only catches a blow-up.
    expect(best).toBeLessThan(1000);
  });

  it('the full frame takes under 3 s and comes back as a reduced preview', () => {
    runTool(big); // warm-up
    const best = Math.min(...[0, 1].map(() => time(() => runTool(big))));
    // Generous: about 0.4 s on the development machine; the budget only catches a blow-up.
    expect(best).toBeLessThan(3000);
    const out = runTool(big);
    expect(resultToText(out)).toContain('Range: 236–255');
    const shown = imageOf(out).image;
    expect([shown.width, shown.height]).toEqual([W / 2, H / 2]);
    // spot-check (pixel (x, y) of the preview covers (2x, 2y)-(2x+1, 2y+1)): an ink square is
    // white, the paper next to it black
    const at = (x: number, y: number) => shown.data[(y * (W / 2) + x) * 4];
    expect([at(101, 101), at(95, 95), at(105, 101)]).toEqual([255, 0, 0]);
  });
});
