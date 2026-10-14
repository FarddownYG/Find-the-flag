/**
 * Printer tracking dots, step 1: find the dots (pure, no DOM).
 *
 * Detection never looks at the display options (stretch, gain, gamma, invert): those only change
 * the pictures. It works on the raw channel value of each pixel:
 *  - "colour ink only" (_channel.ts channelRegion): a yellow dot lowers blue but not red or
 *    green, black text lowers all three. Measuring blue against the other two keeps the dots and
 *    drops text, grey shading and the paper tone. Same idea for cyan (R) and magenta (G) ink.
 *  - polarity from physics, not from the picture: ink lowers R, G, B and luma and raises C, M,
 *    Y and K (alpha, which is not ink, goes by the side of the far tail).
 *  - local paper level: a 3 × 3 average, then a grey-level opening (minimum then maximum over a
 *    square wider than a dot) estimates the paper under each pixel; what sticks out above it is
 *    the dot contrast (a "top-hat"). A gradient, vignetting, a highlighter band or a logo larger
 *    than the square are part of the paper level and disappear; smaller blobs stay and are
 *    dropped by the size filter. The paper level is smooth, so it is computed on 4 × 4 blocks
 *    (their minimum, which is the first step of the opening anyway): 16 times less work.
 *  - threshold: 4 robust sigmas above the contrast's own noise (at least 4 levels), raised to 40 %
 *    of the typical dot peak so neighbouring dots do not merge; or given by hand.
 *  - blobs: 8-connected components; a blob whose peak stays under 6 noise sigmas is noise (pure
 *    noise almost never reaches that), and a size filter keeps blobs of the dominant size. A blob
 *    too small at the common threshold (a dot dimmed by shading) gets a second chance, measured
 *    at 40 % of its own peak.
 */
import type { RgbaImage } from '../../core/types';
import { median as medianOf } from '../audio/_dsp';
import {
  channelRegion,
  histogram,
  inkLowers,
  inkOnlyApplies,
  percentile,
  robustSpread,
  statsFromHistogram,
  type Channel,
  type ChannelStats,
  type Rect,
} from './_channel';

export interface Signal {
  /** The analysed region, in image coordinates. */
  rect: Rect;
  /** Channel value of every region pixel (its colour-ink form when inkOnly), row-major. */
  raw: Uint8Array;
  hist: Uint32Array;
  /** Statistics of `raw`. */
  stats: ChannelStats;
  /** The ink-only transform was applied (only for R, G, B, C, M, Y). */
  inkOnly: boolean;
  /** Dots are darker than the paper in `raw`. */
  darkDots: boolean;
}

/** For a channel that is not ink (alpha): the dots lie on the side of the median with the far tail. */
function tailBelow(hist: Uint32Array, n: number): boolean {
  const { median, sigma } = robustSpread(hist, n);
  let below = 0;
  let above = 0;
  for (let v = 0; v < 256; v++) {
    if (v < median - 4 * sigma) below += hist[v]!;
    else if (v > median + 4 * sigma) above += hist[v]!;
  }
  return below >= above;
}

export function computeSignal(img: RgbaImage, rect: Rect, channel: Channel, inkOnly: boolean) {
  const applied = inkOnly && inkOnlyApplies(channel);
  const raw = channelRegion(img, channel, rect, applied);
  const hist = histogram(raw);
  const signal: Signal = {
    rect,
    raw,
    hist,
    stats: statsFromHistogram(hist),
    inkOnly: applied,
    darkDots: inkLowers(channel) ?? tailBelow(hist, raw.length),
  };
  return signal;
}

// ---------- morphology ----------

const SUM_MAX = 9 * 255;

/**
 * Sum of each pixel's 3 × 3 neighbourhood (edges replicated): 9 × the 3 × 3 average; of
 * 255 − value when `invert` (so the dots always come out bright).
 */
function boxSum3(src: Uint8Array, w: number, h: number, invert: boolean): Uint16Array {
  const tmp = new Uint16Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const l = src[row + (x > 0 ? x - 1 : 0)]!;
      const r = src[row + (x < w - 1 ? x + 1 : x)]!;
      tmp[row + x] = l + src[row + x]! + r;
    }
  }
  const out = new Uint16Array(w * h);
  for (let y = 0; y < h; y++) {
    const up = (y > 0 ? y - 1 : 0) * w;
    const row = y * w;
    const down = (y < h - 1 ? y + 1 : y) * w;
    if (invert)
      for (let x = 0; x < w; x++)
        out[row + x] = SUM_MAX - tmp[up + x]! - tmp[row + x]! - tmp[down + x]!;
    else for (let x = 0; x < w; x++) out[row + x] = tmp[up + x]! + tmp[row + x]! + tmp[down + x]!;
  }
  return out;
}

const SENTINEL = 0xffff;
const STRIP = 64;

/**
 * Minimum over the (2r+1) × (2r+1) square around each pixel (pixels outside the region ignored),
 * by van Herk / Gil-Werman: per line, block-wise running minima from both ends, so the cost does
 * not depend on r. Columns are processed in strips of 64 so memory is read row by row.
 */
function minFilter(src: Uint16Array, w: number, h: number, r: number): Uint16Array {
  const S = 2 * r + 1;
  const out = new Uint16Array(w * h);
  // Rows.
  {
    const L = w + 2 * r;
    const pad = new Uint16Array(L).fill(SENTINEL);
    const g = new Uint16Array(L);
    const hh = new Uint16Array(L);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      pad.set(src.subarray(row, row + w), r);
      for (let i = 0; i < L; i++) {
        const v = pad[i]!;
        g[i] = i % S === 0 ? v : v < g[i - 1]! ? v : g[i - 1]!;
      }
      for (let i = L - 1; i >= 0; i--) {
        const v = pad[i]!;
        hh[i] = i === L - 1 || (i + 1) % S === 0 ? v : v < hh[i + 1]! ? v : hh[i + 1]!;
      }
      for (let x = 0; x < w; x++) {
        const a = hh[x]!;
        const b = g[x + 2 * r]!;
        out[row + x] = a < b ? a : b;
      }
    }
  }
  // Columns, in strips.
  const L = h + 2 * r;
  const g = new Uint16Array(L * STRIP);
  const hh = new Uint16Array(L * STRIP);
  const tmp = out.slice();
  for (let x0 = 0; x0 < w; x0 += STRIP) {
    const sw = Math.min(STRIP, w - x0);
    const at = (i: number, k: number) => {
      const y = i - r;
      return y < 0 || y >= h ? SENTINEL : tmp[y * w + x0 + k]!;
    };
    for (let i = 0; i < L; i++) {
      const base = i * STRIP;
      const start = i % S === 0;
      for (let k = 0; k < sw; k++) {
        const v = at(i, k);
        const p = start ? v : g[base - STRIP + k]!;
        g[base + k] = v < p ? v : p;
      }
    }
    for (let i = L - 1; i >= 0; i--) {
      const base = i * STRIP;
      const end = i === L - 1 || (i + 1) % S === 0;
      for (let k = 0; k < sw; k++) {
        const v = at(i, k);
        const p = end ? v : hh[base + STRIP + k]!;
        hh[base + k] = v < p ? v : p;
      }
    }
    for (let y = 0; y < h; y++) {
      const a = y * STRIP;
      const b = (y + 2 * r) * STRIP;
      const row = y * w + x0;
      for (let k = 0; k < sw; k++) {
        const u = hh[a + k]!;
        const v = g[b + k]!;
        out[row + k] = u < v ? u : v;
      }
    }
  }
  return out;
}

/** Grey-level opening (minimum, then maximum, over the same square). */
function opening(src: Uint16Array, w: number, h: number, r: number): Uint16Array {
  const eroded = minFilter(src, w, h, r);
  // max(x) = M − min(M − x).
  for (let i = 0; i < eroded.length; i++) eroded[i] = SUM_MAX - eroded[i]!;
  const d = minFilter(eroded, w, h, r);
  for (let i = 0; i < d.length; i++) d[i] = SUM_MAX - d[i]!;
  return d;
}

const BLOCK = 4;

/**
 * The paper level under every pixel, on BLOCK × BLOCK blocks: each block's minimum, then an
 * opening over blocks spanning about 2 × radius + 1 pixels. Never above the pixel itself.
 */
function paperLevel(sums: Uint16Array, w: number, h: number, radius: number) {
  const bw = Math.ceil(w / BLOCK);
  const bh = Math.ceil(h / BLOCK);
  const mins = new Uint16Array(bw * bh).fill(SENTINEL);
  for (let y = 0; y < h; y++) {
    const brow = ((y / BLOCK) | 0) * bw;
    const row = y * w;
    for (let x = 0, bx = 0, k = 0; x < w; x++) {
      const v = sums[row + x]!;
      if (v < mins[brow + bx]!) mins[brow + bx] = v;
      if (++k === BLOCK) {
        k = 0;
        bx++;
      }
    }
  }
  return { level: opening(mins, bw, bh, Math.ceil(radius / BLOCK)), bw };
}

// ---------- blobs ----------

export interface DotBlob {
  /** Weighted centroid, image coordinates (pixel centres at +0.5). */
  x: number;
  y: number;
  area: number;
  w: number;
  h: number;
  /** Highest contrast in the blob (levels, 3 × 3 average). */
  peak: number;
}

export interface DotDetection {
  /** Contrast threshold (levels above the local paper, 3 × 3 average), 1..255. */
  threshold: number;
  auto: boolean;
  /** Paper level of the raw channel (median of the region). */
  paper: number;
  /** Robust sigma of the contrast signal (levels). */
  noise: number;
  /** Typical dot contrast: the median peak of the accepted dots (0 without dots). */
  peak: number;
  /** Connected components found (before the size filter). */
  blobs: number;
  /** Blobs kept as dots. */
  dots: DotBlob[];
  /** Typical dot area (px), the centre of the accepted size range. */
  typicalArea: number;
  /** Blobs whose peak stays within 6 noise sigmas of the paper. */
  rejectedFaint: number;
  rejectedSmall: number;
  rejectedLarge: number;
  /** Stopped early: more than MAX_BLOBS components (noise; raise the threshold). */
  truncated: boolean;
  /** 1 where a region pixel belongs to an accepted dot (rect.w × rect.h). */
  accept: Uint8Array;
  /** Dot contrast of every region pixel, × 9 (the 3 × 3 sum minus the paper level). */
  contrast: Uint16Array;
  /** Half-width of the square used for the paper level (px). */
  radius: number;
}

export const MAX_BLOBS = 300_000;
/** Paper-level square: 33 px, wider than the dots of a 300-600 dpi scan; widened for big dots. */
const BASE_RADIUS = 16;
const MAX_RADIUS = 60;
const MIN_CONTRAST = 4;
/** A dot's peak must clear the paper by this many noise sigmas (and MIN_CONTRAST + 2 levels). */
const PEAK_SIGMAS = 6;

interface Labels {
  raw: { x: number; y: number; area: number; w: number; h: number; peak: number }[];
  /** Pixel indices of blob k: pix[starts[k] .. starts[k + 1]). */
  pix: Int32Array;
  starts: number[];
  truncated: boolean;
}

/**
 * 8-connected components of contrast >= limit (× 9 scale). `within`: only these pixels can be
 * foreground (the blobs of a lower threshold: every pixel above a higher one is in them).
 */
function label(
  top: Uint16Array,
  w: number,
  h: number,
  limit: number,
  ox: number,
  oy: number,
  within?: Int32Array,
) {
  const n = w * h;
  const fg = new Uint8Array(n);
  let fgCount = 0;
  const seeds: number[] | null = within ? [] : null;
  if (within && seeds) {
    for (let k = 0; k < within.length; k++) {
      const i = within[k]!;
      if (top[i]! >= limit) {
        fg[i] = 1;
        fgCount++;
        seeds.push(i);
      }
    }
  } else {
    for (let i = 0; i < n; i++) {
      if (top[i]! >= limit) {
        fg[i] = 1;
        fgCount++;
      }
    }
  }
  // `pix` doubles as the BFS queue and the per-blob pixel list.
  const pix = new Int32Array(fgCount);
  const starts: number[] = [];
  const raw: Labels['raw'] = [];
  let tail = 0;
  let truncated = false;
  const count = seeds ? seeds.length : n;
  for (let si = 0; si < count; si++) {
    const s = seeds ? seeds[si]! : si;
    if (!fg[s]) continue;
    if (raw.length >= MAX_BLOBS) {
      truncated = true;
      break;
    }
    const start = tail;
    fg[s] = 0;
    pix[tail++] = s;
    let head = start;
    let sw = 0;
    let sx = 0;
    let sy = 0;
    let peak = 0;
    let minX = w;
    let maxX = -1;
    let minY = h;
    let maxY = -1;
    while (head < tail) {
      const p = pix[head++]!;
      const px = p % w;
      const py = (p - px) / w;
      const v = top[p]!;
      const wt = v - limit + 1;
      sw += wt;
      sx += wt * px;
      sy += wt * py;
      if (v > peak) peak = v;
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = py + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = px + dx;
          if (nx < 0 || nx >= w) continue;
          const q = ny * w + nx;
          if (fg[q]) {
            fg[q] = 0;
            pix[tail++] = q;
          }
        }
      }
    }
    starts.push(start);
    raw.push({
      x: ox + sx / sw + 0.5,
      y: oy + sy / sw + 0.5,
      area: tail - start,
      w: maxX - minX + 1,
      h: maxY - minY + 1,
      peak: peak / 9,
    });
  }
  starts.push(tail);
  const labels: Labels = { raw, pix, starts, truncated };
  return labels;
}

/** Typical area: the median of the blobs bigger than a speck (or of all, when few). */
function typicalAreaOf(raw: Labels['raw']): number {
  const areas = raw.map((b) => b.area).filter((a) => a >= 3);
  return medianOf(areas.length >= 5 ? areas : raw.map((b) => b.area));
}

/** Threshold, label and filter. `threshold` 0 = automatic (see the header). */
export function detectDots(sig: Signal, threshold: number, radius = BASE_RADIUS): DotDetection {
  const { w, h } = sig.rect;
  const n = w * h;
  const sums = boxSum3(sig.raw, w, h, sig.darkDots);
  const { level: bg, bw } = paperLevel(sums, w, h, radius);
  const top = new Uint16Array(n);
  const hist = new Uint32Array(256);
  for (let y = 0; y < h; y++) {
    const brow = ((y / BLOCK) | 0) * bw;
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const t = sums[row + x]! - bg[brow + ((x / BLOCK) | 0)]!;
      top[row + x] = t;
      hist[t >= SUM_MAX - 4 ? 255 : ((t + 4) / 9) | 0]!++;
    }
  }
  const { median, sigma } = robustSpread(hist, n);
  const floor = Math.min(255, Math.ceil(median + Math.max(4 * sigma, MIN_CONTRAST)));
  const auto = !(threshold > 0);
  let t = auto ? floor : Math.min(255, Math.max(1, Math.round(threshold)));
  let labels = label(top, w, h, 9 * t, sig.rect.x, sig.rect.y);
  if (auto && !labels.truncated) {
    // Raise to 40 % of the typical dot peak: crisp, strong dots then stay separate blobs.
    const typ = typicalAreaOf(labels.raw);
    const peaks = labels.raw
      .filter((b) => b.area >= typ / 4 && b.area <= typ * 4)
      .map((b) => b.peak);
    const raised = Math.min(255, Math.round(0.4 * medianOf(peaks)));
    if (raised > t) {
      t = raised;
      const within = labels.pix;
      labels = label(top, w, h, 9 * t, sig.rect.x, sig.rect.y, within);
    }
  }
  const { pix, starts, truncated } = labels;
  // Specks that only just clear the threshold are the tail of the paper noise, not dots.
  const minPeak = median + Math.max(PEAK_SIGMAS * sigma, MIN_CONTRAST + 2);
  const raw = labels.raw.map((b, k) => ({ ...b, k })).filter((b) => b.peak >= minPeak);
  const rejectedFaint = labels.raw.length - raw.length;

  const typicalArea = typicalAreaOf(raw);
  // Dots wider than a third of the paper-level square would be partly taken for paper: widen it.
  const diameter = Math.sqrt((4 * typicalArea) / Math.PI);
  if (!truncated && raw.length >= 5 && diameter > (2 * radius + 1) / 3 && radius < MAX_RADIUS)
    return detectDots(sig, threshold, Math.min(MAX_RADIUS, Math.ceil(1.6 * diameter)));

  const lo = Math.max(1, typicalArea / 4);
  const hi = Math.max(4, typicalArea * 4);
  const accept = new Uint8Array(n);
  const dots: DotBlob[] = [];
  let rejectedSmall = 0;
  let rejectedLarge = 0;
  const elongated = (bw: number, bh: number) => {
    const long = Math.max(bw, bh);
    return long > 3 && long > 3 * Math.min(bw, bh);
  };
  // Pixels of every blob: a second-chance growth (below) never enters another blob.
  const taken = new Uint8Array(n);
  for (let q = 0; q < starts[starts.length - 1]!; q++) taken[pix[q]!] = 1;
  /**
   * Second chance for a blob too small at the common threshold: a dot under shading or a light
   * text line has a lower peak, so less of it clears that threshold. Grow it down to 40 % of its
   * own peak (never below the noise floor) and judge that size instead.
   */
  const regrow = (k: number, peak: number) => {
    const limit = 9 * Math.max(floor, Math.round(0.4 * peak));
    if (limit >= 9 * t) return null;
    const own = Array.from(pix.subarray(starts[k]!, starts[k + 1]!));
    for (let head = 0; head < own.length && own.length <= hi; head++) {
      const p = own[head]!;
      const px = p % w;
      const py = (p - px) / w;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = px + dx;
          const ny = py + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const q = ny * w + nx;
          if (!taken[q] && top[q]! >= limit) {
            taken[q] = 1;
            own.push(q);
          }
        }
    }
    if (own.length < lo || own.length > hi) return null;
    let sw = 0;
    let sx = 0;
    let sy = 0;
    let minX = w;
    let maxX = -1;
    let minY = h;
    let maxY = -1;
    for (const p of own) {
      const px = p % w;
      const py = (p - px) / w;
      const wt = top[p]! - limit + 1;
      sw += wt;
      sx += wt * px;
      sy += wt * py;
      minX = Math.min(minX, px);
      maxX = Math.max(maxX, px);
      minY = Math.min(minY, py);
      maxY = Math.max(maxY, py);
    }
    if (elongated(maxX - minX + 1, maxY - minY + 1)) return null;
    const blob: DotBlob = {
      x: sig.rect.x + sx / sw + 0.5,
      y: sig.rect.y + sy / sw + 0.5,
      area: own.length,
      w: maxX - minX + 1,
      h: maxY - minY + 1,
      peak,
    };
    return { blob, own };
  };
  raw.forEach((b) => {
    const k = b.k;
    if (b.area < lo) {
      const again = regrow(k, b.peak);
      if (!again) {
        rejectedSmall++;
        return;
      }
      dots.push(again.blob);
      for (const q of again.own) accept[q] = 1;
      return;
    }
    if (b.area > hi || elongated(b.w, b.h)) {
      rejectedLarge++;
      return;
    }
    dots.push(b);
    for (let q = starts[k]!; q < starts[k + 1]!; q++) accept[pix[q]!] = 1;
  });
  return {
    threshold: t,
    auto,
    paper: percentile(sig.hist, n, 50),
    noise: sigma,
    peak: medianOf(dots.map((d) => d.peak)),
    blobs: labels.raw.length,
    dots: dots.map(({ x, y, area, w, h, peak }) => ({ x, y, area, w, h, peak })),
    typicalArea,
    rejectedFaint,
    rejectedSmall,
    rejectedLarge,
    truncated,
    accept,
    contrast: top,
    radius,
  };
}

// ---------- cache ----------

/**
 * Live runs repeat with the same picture while only grid, decoding or display options change:
 * keep the last signal and its detections. The key is a hash of every pixel (the worker gets a
 * fresh copy of the image on each run, so object identity cannot be used).
 */
export function imageFingerprint(img: RgbaImage): string {
  const d = img.data;
  let h1 = 0x811c9dc5 ^ img.width;
  let h2 = 0x9747b28c ^ img.height;
  const whole = d.byteOffset % 4 === 0 ? d.length >> 2 : 0;
  // Int32 so every step stays in small-integer arithmetic (a Uint32 above 2^31 is a double).
  const words = new Int32Array(d.buffer, d.byteOffset, whole);
  for (let i = 0; i < whole; i++) {
    const v = words[i]!;
    h1 = Math.imul(h1 ^ v, 0x01000193);
    h2 = ((h2 << 5) - h2 + v) | 0;
  }
  for (let i = whole * 4; i < d.length; i++) {
    h1 = Math.imul(h1 ^ d[i]!, 0x01000193);
    h2 = ((h2 << 5) - h2 + d[i]!) | 0;
  }
  return `${img.width}x${img.height}:${(h1 >>> 0).toString(16)}${(h2 >>> 0).toString(16)}`;
}

let cached: { key: string; sig: Signal; dets: Map<number, DotDetection> } | null = null;

/** computeSignal + detectDots, reusing the previous run's work when the inputs are the same. */
export function detectCached(
  img: RgbaImage,
  rect: Rect,
  channel: Channel,
  inkOnly: boolean,
  threshold: number,
): { sig: Signal; det: DotDetection } {
  const key = `${imageFingerprint(img)}|${rect.x},${rect.y},${rect.w},${rect.h}|${channel}|${inkOnly}`;
  if (cached?.key !== key)
    cached = { key, sig: computeSignal(img, rect, channel, inkOnly), dets: new Map() };
  const t = threshold > 0 ? Math.round(threshold) : 0;
  let det = cached.dets.get(t);
  if (!det) {
    det = detectDots(cached.sig, t);
    if (cached.dets.size >= 4) cached.dets.clear();
    cached.dets.set(t, det);
  }
  return { sig: cached.sig, det };
}
