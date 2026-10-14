import { ToolError } from '../../core/errors';
import type { RgbaImage } from '../../core/types';

/**
 * Colour-channel isolation and amplification (pure, no DOM).
 *
 * Everything here works on 8-bit values. A "channel value" is one byte per pixel; the whole
 * reveal pipeline after that is a single 256-entry look-up table (invert, stretch, gain, gamma
 * and threshold are all pointwise), which is what keeps a 12-megapixel scan fast.
 */

export type Channel = 'r' | 'g' | 'b' | 'a' | 'c' | 'm' | 'y' | 'k' | 'luma';

/**
 * Contrast stretch applied after the optional inversion.
 *  - none:     keep the values as they are.
 *  - auto:     map the 1st..99th percentile to 0..255 (the clipped 1 % at each end saturates).
 *              A sparse signal that window would clip — under 1 % of the pixels, more than 5
 *              robust sigmas from the median, e.g. faint dots on a noisy page — widens the window
 *              up to that signal (see sparseTails). If the percentiles coincide (a clean page) it
 *              falls back to the full min..max range.
 *  - full:     map min..max to 0..255, never clips.
 *  - equalize: histogram equalisation.
 */
export type Stretch = 'none' | 'auto' | 'full' | 'equalize';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RevealOptions {
  channel: Channel;
  /** Colour ink only (see channelRegion): R/G/B/C/M/Y measured against the two other components. */
  inkOnly?: boolean;
  /** Replace each value v by 255 - v (first step: faint ink on a light page becomes bright). */
  invert: boolean;
  stretch: Stretch;
  /** Multiplier applied after the stretch (clamped to 255). 1 = unchanged. */
  gain: number;
  /** out = 255 * (v / 255) ^ (1 / gamma). Above 1 lifts shadows, below 1 deepens them. */
  gamma: number;
  /** 0 = off, else 1..255: values >= threshold become 255, the rest 0 (applied last). */
  threshold: number;
  /** Region to reveal; w / h of 0 mean "up to the edge". Omitted = the whole image. */
  crop?: Rect;
  /** Integer nearest-neighbour zoom, 1..16. */
  scale: number;
}

export interface ChannelStats {
  min: number;
  max: number;
  mean: number;
  /** 1st and 99th percentile (nearest-rank on the 256-bin histogram). */
  p1: number;
  p99: number;
}

export interface CropInfo {
  rect: Rect;
  /** True when the requested crop had to be clamped to fit the image. */
  adjusted: boolean;
  /** True when the rect covers the whole image. */
  whole: boolean;
}

export interface RevealResult {
  image: RgbaImage;
  /** Statistics of the raw channel values inside the region (before invert / stretch). */
  stats: ChannelStats;
  crop: CropInfo;
  /** Zoom actually applied (can be lower than requested for huge regions). */
  scale: number;
  /** The look-up table that was applied: raw channel value -> displayed grey level. */
  lut: Uint8Array;
  /** 1, or the factor of the reduced preview sent for a big region at zoom 1 (see poolPreview). */
  reduced: number;
}

export const MAX_SCALE = 16;
/** Output pixel budget (4096 x 4096): a bigger zoom is lowered, never above 1x though. */
export const MAX_OUT_PIXELS = 1 << 24;
/** Regions above this many pixels are previewed reduced at zoom 1 (keeping the dots). */
export const PREVIEW_PIXELS = 4_000_000;
/** Longest side of that preview. */
export const PREVIEW_SIDE = 2048;
/** A channel whose max - min is at most this is reported as "faint". */
export const FAINT_SPREAD = 40;

export const DEFAULT_REVEAL: RevealOptions = {
  channel: 'b',
  invert: true,
  stretch: 'auto',
  gain: 1,
  gamma: 1,
  threshold: 0,
  scale: 1,
};

export const CHANNEL_INFO: readonly {
  id: Channel;
  name: string;
  /** How the channel value is computed from R, G, B, A. */
  formula: string;
}[] = [
  { id: 'r', name: 'Red', formula: 'R' },
  { id: 'g', name: 'Green', formula: 'G' },
  { id: 'b', name: 'Blue', formula: 'B' },
  { id: 'a', name: 'Alpha', formula: 'A' },
  { id: 'c', name: 'Cyan', formula: '255 − R' },
  { id: 'm', name: 'Magenta', formula: '255 − G' },
  { id: 'y', name: 'Yellow', formula: '255 − B' },
  { id: 'k', name: 'Black key', formula: '255 − max(R, G, B)' },
  { id: 'luma', name: 'Luma', formula: '0.299 R + 0.587 G + 0.114 B' },
];

export function channelInfo(ch: Channel): { id: Channel; name: string; formula: string } {
  const info = CHANNEL_INFO.find((c) => c.id === ch);
  if (!info)
    throw new ToolError(`Unknown channel "${String(ch)}". Pick R, G, B, A, C, M, Y, K or luma.`);
  return info;
}

// ---------- channel values ----------

/** Components that are a single byte of the pixel, possibly complemented (CMY = 255 - RGB). */
const COMPONENT = {
  r: { offset: 0, flip: false },
  g: { offset: 1, flip: false },
  b: { offset: 2, flip: false },
  a: { offset: 3, flip: false },
  c: { offset: 0, flip: true },
  m: { offset: 1, flip: true },
  y: { offset: 2, flip: true },
} as const;

function valuesIn(img: RgbaImage, ch: Channel, rect: Rect): Uint8Array {
  channelInfo(ch);
  const out = new Uint8Array(rect.w * rect.h);
  const src = img.data;
  const stride = img.width * 4;
  let o = 0;
  if (ch === 'k') {
    for (let y = 0; y < rect.h; y++) {
      let i = (rect.y + y) * stride + rect.x * 4;
      for (let x = 0; x < rect.w; x++, i += 4) {
        const r = src[i]!;
        const g = src[i + 1]!;
        const b = src[i + 2]!;
        out[o++] = 255 - (r > g ? (r > b ? r : b) : g > b ? g : b);
      }
    }
  } else if (ch === 'luma') {
    // Integer Rec. 601 weights, rounded half up: (299 R + 587 G + 114 B) / 1000.
    for (let y = 0; y < rect.h; y++) {
      let i = (rect.y + y) * stride + rect.x * 4;
      for (let x = 0; x < rect.w; x++, i += 4) {
        out[o++] = Math.floor((299 * src[i]! + 587 * src[i + 1]! + 114 * src[i + 2]! + 500) / 1000);
      }
    }
  } else {
    const { offset, flip } = COMPONENT[ch];
    for (let y = 0; y < rect.h; y++) {
      let i = (rect.y + y) * stride + rect.x * 4 + offset;
      if (flip) {
        for (let x = 0; x < rect.w; x++, i += 4) out[o++] = 255 - src[i]!;
      } else {
        for (let x = 0; x < rect.w; x++, i += 4) out[o++] = src[i]!;
      }
    }
  }
  return out;
}

/**
 * Ink that lowers one RGB component: cyan ink lowers R, magenta G, yellow B. `isInk`: the channel
 * reports the ink itself (C/M/Y) rather than the component (R/G/B).
 */
const INK: Partial<Record<Channel, { comp: 0 | 1 | 2; isInk: boolean }>> = {
  r: { comp: 0, isInk: false },
  c: { comp: 0, isInk: true },
  g: { comp: 1, isInk: false },
  m: { comp: 1, isInk: true },
  b: { comp: 2, isInk: false },
  y: { comp: 2, isInk: true },
};

/** "Colour ink only" exists for R, G, B, C, M and Y. */
export const inkOnlyApplies = (ch: Channel): boolean => INK[ch] !== undefined;

/**
 * Does ink make this channel's value lower (R, G, B, luma: true) or higher (C, M, Y, K: false)?
 * Null for alpha, which is not ink at all.
 */
export function inkLowers(ch: Channel): boolean | null {
  if (ch === 'a') return null;
  return ch === 'r' || ch === 'g' || ch === 'b' || ch === 'luma';
}

/**
 * One byte per pixel of `rect` (row-major). Without `inkOnly`: the plain channel (channelValues).
 * With it, for R/G/B/C/M/Y: how far the component is below the two others, ink = max(0,
 * min(other two) − component). Yellow ink lowers blue only, black text, grey shading and white
 * paper lower all three alike, so they give 0: only coloured ink is left. R/G/B report 255 − ink
 * (ink stays dark, like the plain channel), C/M/Y the ink itself. Other channels ignore `inkOnly`.
 */
export function channelRegion(
  img: RgbaImage,
  ch: Channel,
  rect: Rect,
  inkOnly = false,
): Uint8Array {
  const spec = inkOnly ? INK[ch] : undefined;
  if (!spec) return valuesIn(img, ch, rect);
  const src = img.data;
  const stride = img.width * 4;
  const out = new Uint8Array(rect.w * rect.h);
  const c0 = spec.comp;
  const c1 = (c0 + 1) % 3;
  const c2 = (c0 + 2) % 3;
  let o = 0;
  for (let y = 0; y < rect.h; y++) {
    let i = (rect.y + y) * stride + rect.x * 4;
    for (let x = 0; x < rect.w; x++, i += 4) {
      const a = src[i + c1]!;
      const b = src[i + c2]!;
      const ink = (a < b ? a : b) - src[i + c0]!;
      const v = ink > 0 ? ink : 0;
      out[o++] = spec.isInk ? v : 255 - v;
    }
  }
  return out;
}

/**
 * One byte per pixel (row-major) for the chosen channel.
 * r / g / b / a are the raw bytes; c / m / y are plain CMY complements (255 - R / G / B, no black
 * generation, so 'y' is exactly 255 - blue); k = 255 - max(R, G, B); luma is Rec. 601.
 * Alpha is ignored for r / g / b: colours hidden under transparent pixels stay visible.
 */
export function channelValues(img: RgbaImage, ch: Channel): Uint8Array {
  return valuesIn(img, ch, { x: 0, y: 0, w: img.width, h: img.height });
}

// ---------- histogram and statistics ----------

export function histogram(values: Uint8Array): Uint32Array {
  const hist = new Uint32Array(256);
  for (let i = 0; i < values.length; i++) hist[values[i]!]!++;
  return hist;
}

/** Nearest-rank percentile: the smallest value v with at least ceil(p % of total) pixels <= v. */
export function percentile(hist: Uint32Array, total: number, p: number): number {
  if (total <= 0) return 0;
  const target = Math.max(1, Math.ceil((total * p) / 100));
  let cum = 0;
  for (let v = 0; v < 256; v++) {
    cum += hist[v]!;
    if (cum >= target) return v;
  }
  return 255;
}

function total(hist: Uint32Array): number {
  let n = 0;
  for (let v = 0; v < 256; v++) n += hist[v]!;
  return n;
}

export function statsFromHistogram(hist: Uint32Array): ChannelStats {
  const n = total(hist);
  if (n === 0) return { min: 0, max: 0, mean: 0, p1: 0, p99: 0 };
  let min = 0;
  while (hist[min] === 0) min++;
  let max = 255;
  while (hist[max] === 0) max--;
  let sum = 0;
  for (let v = min; v <= max; v++) sum += v * hist[v]!;
  return { min, max, mean: sum / n, p1: percentile(hist, n, 1), p99: percentile(hist, n, 99) };
}

export function channelStats(img: RgbaImage, ch: Channel): ChannelStats {
  return statsFromHistogram(histogram(channelValues(img, ch)));
}

/** A one-line reading of the statistics, or null when the channel looks like ordinary content. */
export function statsHint(ch: Channel, s: ChannelStats): string | null {
  const name = channelInfo(ch).name;
  if (s.max === s.min) {
    return `${name} channel is constant (${s.min}): nothing is hidden in it, try another channel.`;
  }
  if (s.max - s.min <= FAINT_SPREAD) {
    return `${name} channel spans only ${s.min}-${s.max}: something faint is there.`;
  }
  return null;
}

// ---------- options ----------

const cleanNumber = (n: number, fallback: number) => (Number.isFinite(n) ? n : fallback);
const cleanGain = (n: number) => Math.min(1e6, Math.max(0, cleanNumber(n, 1)));
const cleanGamma = (n: number) => Math.min(100, Math.max(0.01, cleanNumber(n, 1)));
const cleanThreshold = (n: number) => Math.min(255, Math.max(0, Math.round(cleanNumber(n, 0))));
const cleanScale = (n: number) => Math.min(MAX_SCALE, Math.max(1, Math.round(cleanNumber(n, 1))));

/** Bring numeric options into their valid range (NaN and Infinity fall back to the neutral value). */
export function normalizeOptions(o: RevealOptions): RevealOptions {
  return {
    ...o,
    gain: cleanGain(o.gain),
    gamma: cleanGamma(o.gamma),
    threshold: cleanThreshold(o.threshold),
    scale: cleanScale(o.scale),
  };
}

/**
 * Validate a crop against the image. 0 / missing width or height mean "up to the edge", a rect
 * sticking out of the image is clamped (`adjusted`), and an origin outside the image is an error.
 */
export function normalizeCrop(img: RgbaImage, crop?: Rect): CropInfo {
  const whole: Rect = { x: 0, y: 0, w: img.width, h: img.height };
  if (!crop || img.width < 1 || img.height < 1)
    return { rect: whole, adjusted: false, whole: true };
  const int = (n: number) => (Number.isFinite(n) ? Math.floor(n) : 0);
  let adjusted = false;
  let x = int(crop.x);
  let y = int(crop.y);
  let w = int(crop.w);
  let h = int(crop.h);
  if (x < 0 || y < 0) {
    adjusted = true;
    x = Math.max(0, x);
    y = Math.max(0, y);
  }
  if (x >= img.width || y >= img.height) {
    throw new ToolError(
      `The crop starts at (${x}, ${y}), outside the ${img.width}×${img.height} image. ` +
        'Use X below the width and Y below the height, or set the crop back to 0.',
    );
  }
  const maxW = img.width - x;
  const maxH = img.height - y;
  if (w < 0 || h < 0) adjusted = true;
  if (w <= 0) w = maxW;
  else if (w > maxW) {
    w = maxW;
    adjusted = true;
  }
  if (h <= 0) h = maxH;
  else if (h > maxH) {
    h = maxH;
    adjusted = true;
  }
  const isWhole = x === 0 && y === 0 && w === img.width && h === img.height;
  return { rect: { x, y, w, h }, adjusted, whole: isWhole };
}

/** The zoom that will really be used: integer 1..16, lowered while the output exceeds the budget. */
export function effectiveScale(w: number, h: number, requested: number): number {
  let s = cleanScale(requested);
  while (s > 1 && w * s * (h * s) > MAX_OUT_PIXELS) s--;
  return s;
}

// ---------- look-up table ----------

type LutOptions = Pick<RevealOptions, 'invert' | 'stretch' | 'gain' | 'gamma' | 'threshold'>;

const clamp255 = (n: number) => (n < 0 ? 0 : n > 255 ? 255 : n);

/** Median and robust sigma (1.4826 × median absolute deviation, at least 0.5) of a histogram. */
export function robustSpread(hist: Uint32Array, n: number): { median: number; sigma: number } {
  const median = percentile(hist, n, 50);
  const dev = new Uint32Array(256);
  for (let v = 0; v < 256; v++) dev[Math.abs(v - median)]! += hist[v]!;
  return { median, sigma: Math.max(0.5, 1.4826 * percentile(dev, n, 50)) };
}

/**
 * A sparse signal on a flat background, on each side of the median: the pixels more than 5 robust
 * sigmas away, when there are at least 4 of them and at most 1 % of the region (pure noise almost
 * never goes that far; a picture with real contrast has a wide sigma and no such tail). Returns the
 * median value of each tail, or null. Faint dots or near-white text on a noisy page are such a
 * tail: the 1–99 % window sits inside the paper noise and would clip them to the noise level.
 */
export function sparseTails(
  hist: Uint32Array,
  n: number,
): { lo: number | null; hi: number | null } {
  if (n <= 0) return { lo: null, hi: null };
  const { median, sigma } = robustSpread(hist, n);
  const minCount = 4;
  const maxCount = 0.01 * n;
  const tail = (from: number, to: number, step: 1 | -1): number | null => {
    let count = 0;
    for (let v = from; step > 0 ? v <= to : v >= to; v += step) count += hist[v]!;
    if (count < minCount || count > maxCount) return null;
    let cum = 0;
    for (let v = from; step > 0 ? v <= to : v >= to; v += step) {
      cum += hist[v]!;
      if (2 * cum >= count) return v;
    }
    return null;
  };
  const upFrom = Math.floor(median + 5 * sigma) + 1;
  const downFrom = Math.ceil(median - 5 * sigma) - 1;
  return {
    hi: upFrom <= 255 ? tail(upFrom, 255, 1) : null,
    lo: downFrom >= 0 ? tail(downFrom, 0, -1) : null,
  };
}

/** The window [lo, hi] mapped to 0..255 by the auto / full stretch, or null if nothing to stretch. */
function stretchWindow(
  hist: Uint32Array,
  n: number,
  mode: 'auto' | 'full',
): { lo: number; hi: number } | null {
  if (mode === 'auto') {
    let lo = percentile(hist, n, 1);
    let hi = percentile(hist, n, 99);
    if (hi > lo) {
      const tails = sparseTails(hist, n);
      if (tails.hi !== null && tails.hi > hi) hi = tails.hi;
      if (tails.lo !== null && tails.lo < lo) lo = tails.lo;
      return { lo, hi };
    }
  }
  const stats = statsFromHistogram(hist);
  return stats.max > stats.min ? { lo: stats.min, hi: stats.max } : null;
}

/**
 * Build the table raw channel value -> displayed grey level.
 * `rawHist` is the histogram of the channel BEFORE inversion; the stretch is computed on the
 * inverted values. Order: invert, stretch, gain, gamma, round, threshold.
 */
export function buildLut(rawHist: Uint32Array, o: LutOptions): Uint8Array {
  const gain = cleanGain(o.gain);
  const gamma = cleanGamma(o.gamma);
  const threshold = cleanThreshold(o.threshold);
  const hist = o.invert ? Uint32Array.from(rawHist).reverse() : rawHist;
  const n = total(hist);

  const stage = new Float64Array(256);
  for (let x = 0; x < 256; x++) stage[x] = x;
  if (o.stretch === 'auto' || o.stretch === 'full') {
    const win = stretchWindow(hist, n, o.stretch);
    if (win) {
      // Multiply before dividing so exact halves stay exact (127.5 rounds to 128).
      for (let x = 0; x < 256; x++) stage[x] = ((x - win.lo) * 255) / (win.hi - win.lo);
    }
  } else if (o.stretch === 'equalize') {
    const cdf = new Float64Array(256);
    let cum = 0;
    let cdfMin = 0;
    for (let x = 0; x < 256; x++) {
      cum += hist[x]!;
      cdf[x] = cum;
      if (cdfMin === 0 && cum > 0) cdfMin = cum;
    }
    if (n > cdfMin) {
      for (let x = 0; x < 256; x++) stage[x] = ((cdf[x]! - cdfMin) * 255) / (n - cdfMin);
    }
  }

  const lut = new Uint8Array(256);
  for (let x = 0; x < 256; x++) {
    let t = clamp255(stage[x]!);
    t = clamp255(t * gain);
    if (gamma !== 1) t = 255 * (t / 255) ** (1 / gamma);
    let level = Math.round(t);
    if (threshold > 0) level = level >= threshold ? 255 : 0;
    lut[o.invert ? 255 - x : x] = level;
  }
  return lut;
}

// ---------- reveal ----------

/** Grey RGBA picture of `raw` through `lut`, nearest-neighbour zoomed by `s`. */
function paint(raw: Uint8Array, lut: Uint8Array, w: number, h: number, s: number): RgbaImage {
  const outW = w * s;
  const outH = h * s;
  const data = new Uint8ClampedArray(outW * outH * 4);
  if (data.length === 0) return { width: outW, height: outH, data };
  // A palette of finished RGBA pixels built through a byte view, so it is correct on any endianness.
  const palette = new Uint32Array(256);
  const bytes = new Uint8Array(palette.buffer);
  for (let v = 0; v < 256; v++) {
    const g = lut[v]!;
    bytes[v * 4] = g;
    bytes[v * 4 + 1] = g;
    bytes[v * 4 + 2] = g;
    bytes[v * 4 + 3] = 255;
  }
  const px = new Uint32Array(data.buffer);
  for (let y = 0; y < h; y++) {
    const rowStart = y * s * outW;
    const base = y * w;
    let d = rowStart;
    if (s === 1) {
      for (let x = 0; x < w; x++) px[d++] = palette[raw[base + x]!]!;
    } else {
      for (let x = 0; x < w; x++) {
        const p = palette[raw[base + x]!]!;
        for (let k = 0; k < s; k++) px[d++] = p;
      }
      for (let k = 1; k < s; k++) px.copyWithin(rowStart + k * outW, rowStart, rowStart + outW);
    }
  }
  return { width: outW, height: outH, data };
}

/**
 * `values` (w × h) through `lut`, shrunk by the smallest integer factor that fits `maxSide`,
 * keeping the most signal-like level of each block — the brightest when `keepBright`, else the
 * darkest — so isolated dots survive the reduction (an average or a browser downscale drops them).
 */
export function poolPreview(
  values: Uint8Array | Uint16Array,
  lut: Uint8Array,
  w: number,
  h: number,
  maxSide: number,
  keepBright: boolean,
): { image: RgbaImage; factor: number } {
  const f = Math.max(1, Math.ceil(Math.max(w, h) / maxSide));
  const W = Math.ceil(w / f);
  const H = Math.ceil(h / f);
  const data = new Uint8ClampedArray(W * H * 4);
  const pick = new Uint8Array(W);
  for (let Y = 0; Y < H; Y++) {
    pick.fill(keepBright ? 0 : 255);
    for (let y = Y * f; y < Math.min(h, (Y + 1) * f); y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const v = lut[values[row + x]!]!;
        const X = (x / f) | 0;
        if (keepBright ? v > pick[X]! : v < pick[X]!) pick[X] = v;
      }
    }
    for (let X = 0; X < W; X++) {
      const k = (Y * W + X) * 4;
      const m = pick[X]!;
      data[k] = m;
      data[k + 1] = m;
      data[k + 2] = m;
      data[k + 3] = 255;
    }
  }
  return { image: { width: W, height: H, data }, factor: f };
}

/** `reveal` plus the statistics, region and zoom that were really used. */
export function revealDetailed(img: RgbaImage, options: RevealOptions): RevealResult {
  const o = normalizeOptions(options);
  const crop = normalizeCrop(img, o.crop);
  const raw = channelRegion(img, o.channel, crop.rect, o.inkOnly ?? false);
  const hist = histogram(raw);
  const lut = buildLut(hist, o);
  const scale = effectiveScale(crop.rect.w, crop.rect.h, o.scale);
  const { w, h } = crop.rect;
  // A big region at zoom 1 would be shown scaled down by the browser, which drops small dots:
  // send a reduced preview that keeps them instead (crop to see real pixels).
  if (scale === 1 && w * h > PREVIEW_PIXELS) {
    const paper = lut[percentile(hist, w * h, 50)]!;
    const pooled = poolPreview(raw, lut, w, h, PREVIEW_SIDE, paper <= 127);
    return {
      image: pooled.image,
      stats: statsFromHistogram(hist),
      crop,
      scale,
      lut,
      reduced: pooled.factor,
    };
  }
  return {
    image: paint(raw, lut, w, h, scale),
    stats: statsFromHistogram(hist),
    crop,
    scale,
    lut,
    reduced: 1,
  };
}

/** The chosen region as an opaque grey picture, after invert, stretch, gain, gamma, threshold and zoom. */
export function reveal(img: RgbaImage, o: RevealOptions): RgbaImage {
  return revealDetailed(img, o).image;
}
