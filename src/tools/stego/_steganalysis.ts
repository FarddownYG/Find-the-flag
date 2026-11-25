/**
 * Steganalysis primitives shared by the image tools: "is there something, and where?". Pure
 * functions on an RgbaImage, each returning a number the caller can word and overlay.
 *
 *  - chiSquare / chiByBands: Westfeld & Pfitzmann's chi-square attack on LSB embedding. Sequential
 *    LSB embedding equalises the pair (2k, 2k+1); the test turns that into a probability.
 *  - rsAnalysis: Fridrich, Goljan & Du's RS method — an estimate of the fraction of pixels whose
 *    LSB was flipped, from how "regular" and "singular" groups move under a flipping mask.
 *  - coherenceByRow / anomalyBlocks: where neighbouring channels stop agreeing (a touched zone).
 *  - outlierPixels: lone pixels far from their neighbours (a planted length word, say).
 *
 * The RS estimate is a heuristic indicator, not a forensic measurement; the tests pin its behaviour
 * (≈0 on a clean image, rising with the embedding rate) rather than an exact value.
 */
import type { RgbaImage } from '../../core/types';

// ---------- incomplete gamma, for the chi-square p-value ----------

/** Lanczos approximation of ln Γ(z). */
function lnGamma(z: number): number {
  const g = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);
  z -= 1;
  let x = 0.99999999999980993;
  for (let i = 0; i < g.length; i++) x += g[i]! / (z + i + 1);
  const t = z + g.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

/** Regularised lower incomplete gamma P(a, x) (Numerical Recipes: series + continued fraction). */
function gammaP(a: number, x: number): number {
  if (x <= 0 || a <= 0) return 0;
  if (x < a + 1) {
    let ap = a;
    let sum = 1 / a;
    let del = sum;
    for (let n = 0; n < 300; n++) {
      ap++;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-14) break;
    }
    return sum * Math.exp(-x + a * Math.log(x) - lnGamma(a));
  }
  const FPMIN = 1e-300;
  let b = x + 1 - a;
  let c = 1 / FPMIN;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i <= 300; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = b + an / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-14) break;
  }
  const q = Math.exp(-x + a * Math.log(x) - lnGamma(a)) * h;
  return 1 - q;
}

// ---------- samples ----------

/** The chosen channel's values (0 = R, 1 = G, 2 = B, 3 = A) in row-major order. */
export function channelSamples(img: RgbaImage, channel: number): Uint8Array {
  const n = img.width * img.height;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = img.data[i * 4 + channel]!;
  return out;
}

// ---------- chi-square (Westfeld & Pfitzmann) ----------

export interface ChiResult {
  /** Probability that LSB embedding is present (0..1). */
  p: number;
  /** Chi-square statistic and how many pairs were usable. */
  stat: number;
  pairs: number;
}

/**
 * The chi-square attack on one run of samples. Builds the histogram, pairs value 2k with 2k+1, and
 * measures how close each pair's two counts are to their average (what full LSB embedding produces).
 */
export function chiSquare(samples: Uint8Array): ChiResult {
  const h = new Uint32Array(256);
  for (const v of samples) h[v] = h[v]! + 1;
  let stat = 0;
  let pairs = 0;
  for (let k = 0; k < 128; k++) {
    const a = h[2 * k]!;
    const b = h[2 * k + 1]!;
    const expected = (a + b) / 2;
    if (expected < 5) continue; // too few samples for the pair to mean anything
    const diff = a - expected;
    stat += (diff * diff) / expected;
    pairs++;
  }
  const p = pairs > 0 ? 1 - gammaP(pairs / 2, stat / 2) : 0;
  return { p, stat, pairs };
}

/** Chi-square probability over `bands` equal slices of the sample sequence, to localise embedding. */
export function chiByBands(samples: Uint8Array, bands: number): number[] {
  const n = samples.length;
  const out: number[] = [];
  const size = Math.max(1, Math.floor(n / bands));
  for (let i = 0; i < bands; i++) {
    const from = i * size;
    const to = i === bands - 1 ? n : from + size;
    if (from >= n) break;
    out.push(chiSquare(samples.subarray(from, to)).p);
  }
  return out;
}

// ---------- RS analysis (Fridrich, Goljan & Du) ----------

const flipF1 = (x: number) => x ^ 1;
const flipFm1 = (x: number) => ((x + 1) ^ 1) - 1;
/** Apply the flip chosen by a mask value (-1, 0, 1) to a pixel value. */
function applyMask(x: number, m: number): number {
  if (m === 1) return flipF1(x);
  if (m === -1) return flipFm1(x);
  return x;
}

const MASK = [0, 1, 1, 0];

/** Discrimination of a 4-pixel group: the total absolute variation. */
function discrimination(a: number, b: number, c: number, d: number): number {
  return Math.abs(b - a) + Math.abs(c - b) + Math.abs(d - c);
}

interface RsCounts {
  reg: number;
  sing: number;
}

/** Regular/singular fractions for one mask over all non-overlapping 4-pixel row groups. */
function rsCount(samples: Uint8Array, width: number, height: number, mask: number[]): RsCounts {
  let reg = 0;
  let sing = 0;
  let groups = 0;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x + 4 <= width; x += 4) {
      const p = row + x;
      const g0 = samples[p]!;
      const g1 = samples[p + 1]!;
      const g2 = samples[p + 2]!;
      const g3 = samples[p + 3]!;
      const before = discrimination(g0, g1, g2, g3);
      const after = discrimination(
        applyMask(g0, mask[0]!),
        applyMask(g1, mask[1]!),
        applyMask(g2, mask[2]!),
        applyMask(g3, mask[3]!),
      );
      if (after > before) reg++;
      else if (after < before) sing++;
      groups++;
    }
  }
  return groups ? { reg: reg / groups, sing: sing / groups } : { reg: 0, sing: 0 };
}

export interface RsResult {
  /** Estimated fraction of pixels whose LSB was flipped (0..1), clamped. */
  estimate: number;
  rm: number;
  sm: number;
  rmNeg: number;
  smNeg: number;
}

/**
 * RS estimate of the embedding rate on one channel. Measures the regular/singular curves on the
 * image and on its all-LSB-flipped copy, then solves the RS quadratic for the smaller root.
 */
export function rsAnalysis(img: RgbaImage, channel: number): RsResult {
  const { width, height } = img;
  const samples = channelSamples(img, channel);
  const negMask = MASK.map((m) => -m);

  const m = rsCount(samples, width, height, MASK);
  const mN = rsCount(samples, width, height, negMask);

  // Second measurement point: the whole image with its LSBs flipped (F1 everywhere).
  const flipped = new Uint8Array(samples.length);
  for (let i = 0; i < samples.length; i++) flipped[i] = flipF1(samples[i]!);
  const fm = rsCount(flipped, width, height, MASK);
  const fmN = rsCount(flipped, width, height, negMask);

  const d0 = m.reg - m.sing;
  const d1 = mN.reg - mN.sing;
  const d0f = fm.reg - fm.sing;
  const d1f = fmN.reg - fmN.sing;

  // RS quadratic: 2(d1f + d0f) x^2 + (d1 - d0 - d1f - 3 d0f) x + (d0 - d0f) = 0.
  const a = 2 * (d1f + d0f);
  const b = d1 - d0 - d1f - 3 * d0f;
  const c = d0 - d0f;

  let x: number;
  if (Math.abs(a) < 1e-9) {
    x = Math.abs(b) < 1e-12 ? 0 : -c / b;
  } else {
    const disc = b * b - 4 * a * c;
    if (disc < 0) {
      x = -b / (2 * a);
    } else {
      const r = Math.sqrt(disc);
      const x1 = (-b + r) / (2 * a);
      const x2 = (-b - r) / (2 * a);
      x = Math.abs(x1) <= Math.abs(x2) ? x1 : x2;
    }
  }
  const estimate = Math.min(1, Math.max(0, x / (x - 0.5)));
  return { estimate, rm: m.reg, sm: m.sing, rmNeg: mN.reg, smNeg: mN.sing };
}

// ---------- inter-channel coherence ----------

/**
 * Per row, the share of pixels where R−G or G−B breaks sharply with the same difference one pixel
 * to the left: a touched zone disturbs the smooth agreement between channels. 0..1 per row.
 */
export function coherenceByRow(img: RgbaImage): number[] {
  const { width: w, height: h, data } = img;
  const out: number[] = [];
  const THRESH = 12;
  for (let y = 0; y < h; y++) {
    let breaks = 0;
    let seen = 0;
    for (let x = 1; x < w; x++) {
      const p = (y * w + x) * 4;
      const q = (y * w + x - 1) * 4;
      const rgNow = data[p]! - data[p + 1]!;
      const rgPrev = data[q]! - data[q + 1]!;
      const gbNow = data[p + 1]! - data[p + 2]!;
      const gbPrev = data[q + 1]! - data[q + 2]!;
      if (Math.abs(rgNow - rgPrev) > THRESH || Math.abs(gbNow - gbPrev) > THRESH) breaks++;
      seen++;
    }
    out.push(seen ? breaks / seen : 0);
  }
  return out;
}

// ---------- outlier pixels ----------

export interface Outlier {
  x: number;
  y: number;
  /** The channel value and the median of its 8 neighbours. */
  value: number;
  median: number;
}

const median9 = (v: number[]): number => {
  const s = [...v].sort((a, b) => a - b);
  return s[s.length >> 1]!;
};

/**
 * Pixels of one channel that sit far from the median of their eight neighbours (> `minGap`). These
 * are candidate planted bytes; the caller can read their values as a number.
 */
export function outlierPixels(img: RgbaImage, channel: number, minGap = 48, max = 32): Outlier[] {
  const { width: w, height: h, data } = img;
  const out: Outlier[] = [];
  for (let y = 1; y < h - 1 && out.length < max; y++) {
    for (let x = 1; x < w - 1 && out.length < max; x++) {
      const v = data[(y * w + x) * 4 + channel]!;
      const neigh: number[] = [];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          neigh.push(data[((y + dy) * w + (x + dx)) * 4 + channel]!);
        }
      }
      const med = median9(neigh);
      if (Math.abs(v - med) >= minGap) out.push({ x, y, value: v, median: med });
    }
  }
  return out;
}
