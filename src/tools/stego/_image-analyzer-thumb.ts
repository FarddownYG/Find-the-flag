import * as jpegNs from 'jpeg-js';
import { decodeImageExact } from '../../core/decode-image';
import type { RgbaImage } from '../../core/types';
import { jpegDcLuma, type LumaGrid } from './_image-analyzer-dc';

// jpeg-js is CommonJS: bundlers give named exports, Node may only give `default`.
type JpegApi = Pick<typeof jpegNs, 'decode'>;
const jpeg: JpegApi =
  typeof jpegNs.decode === 'function'
    ? jpegNs
    : (jpegNs as unknown as { default: JpegApi }).default;

/** At or above: the thumbnail shows the main image. */
const MATCH_THRESHOLD = 0.8;
/** Below: clearly another picture. In between: loosely similar, worth a look. */
const DIFFERENT_THRESHOLD = 0.5;
/** Mean luminance difference (0-255) of one ninth of the picture that counts as an edit. */
const REGION_THRESHOLD = 35;
/** Comparison grid: the longest side of both pictures is averaged down to this many cells. */
const GRID = 32;
/** Standard deviation below which a picture is "flat" and correlation means nothing. */
const FLAT = 4;

const MAX_PIXELS = 60e6;
/** Above this, the main JPEG is read from its DC coefficients only (8x8 block averages). */
const DC_ONLY_PIXELS = 1e6;

/**
 * The main image, as cheaply as the comparison allows: block averages for a large JPEG, pixels
 * otherwise (JPEG via jpeg-js, PNG via fast-png); null for other formats.
 */
export function decodeMain(bytes: Uint8Array): RgbaImage | LumaGrid | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    const sof = jpegSize(bytes);
    if (sof && sof.width * sof.height >= DC_ONLY_PIXELS) {
      const grid = jpegDcLuma(bytes);
      if (grid) return grid;
    }
    return decodeJpeg(bytes);
  }
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return decodeImageExact(bytes);
  }
  return null;
}

/** Width and height from the first SOF marker of a JPEG. */
function jpegSize(b: Uint8Array): { width: number; height: number } | null {
  for (let off = 2; off + 9 < b.length;) {
    if (b[off] !== 0xff) return null;
    const m = b[off + 1]!;
    if (m === 0xff) {
      off++;
      continue;
    }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
      off += 2;
      continue;
    }
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { height: (b[off + 5]! << 8) | b[off + 6]!, width: (b[off + 7]! << 8) | b[off + 8]! };
    }
    if (m === 0xda || m === 0xd9) return null;
    off += 2 + ((b[off + 2]! << 8) | b[off + 3]!);
  }
  return null;
}

export function decodeJpeg(bytes: Uint8Array): RgbaImage {
  const img = jpeg.decode(bytes, {
    useTArray: true,
    formatAsRGBA: true,
    tolerantDecoding: true,
    maxResolutionInMP: MAX_PIXELS / 1e6,
    maxMemoryUsageInMB: 1024,
  });
  const { buffer, byteOffset, byteLength } = img.data;
  return {
    width: img.width,
    height: img.height,
    data: new Uint8ClampedArray(buffer, byteOffset, byteLength),
  };
}

/** Luminance of every pixel (alpha composited on white). */
function lumaPlane(img: RgbaImage): Float64Array {
  const n = img.width * img.height;
  const out = new Float64Array(n);
  const d = img.data;
  for (let i = 0; i < n; i++) {
    const a = d[i * 4 + 3]! / 255;
    const y = 0.299 * d[i * 4]! + 0.587 * d[i * 4 + 1]! + 0.114 * d[i * 4 + 2]!;
    out[i] = a * y + (1 - a) * 255;
  }
  return out;
}

interface Plane {
  w: number;
  h: number;
  v: Float64Array;
}

/** Rotate a plane by 90° clockwise, `turns` times. */
function rotate(p: Plane, turns: number): Plane {
  let cur = p;
  for (let t = 0; t < turns; t++) {
    const { w, h, v } = cur;
    const out = new Float64Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) out[x * h + (h - 1 - y)] = v[y * w + x]!;
    }
    cur = { w: h, h: w, v: out };
  }
  return cur;
}

function crop(p: Plane, x0: number, y0: number, w: number, h: number): Plane {
  const v = new Float64Array(w * h);
  for (let y = 0; y < h; y++)
    v.set(p.v.subarray((y0 + y) * p.w + x0, (y0 + y) * p.w + x0 + w), y * w);
  return { w, h, v };
}

function stats(v: ArrayLike<number>): { mean: number; std: number } {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i]!;
  const mean = s / v.length;
  let q = 0;
  for (let i = 0; i < v.length; i++) q += (v[i]! - mean) ** 2;
  return { mean, std: Math.sqrt(q / v.length) };
}

/** Rows (or columns) [from, to) of a plane are one flat colour: a letterbox bar. */
function flatBand(p: Plane, from: number, to: number, rows: boolean): boolean {
  if (to <= from) return false;
  const vals: number[] = [];
  for (let a = from; a < to; a++) {
    const n = rows ? p.w : p.h;
    for (let b = 0; b < n; b++) vals.push(rows ? p.v[a * p.w + b]! : p.v[b * p.w + a]!);
  }
  return stats(vals).std < 6;
}

/**
 * Cameras that store a 4:3 thumbnail for a 3:2 or 16:9 photo pad it with bars. Crop them when
 * the aspect ratios disagree and the would-be bars are flat.
 */
function stripBars(p: Plane, mainAspect: number): { plane: Plane; bars: boolean } {
  const aspect = p.w / p.h;
  if (Math.abs(aspect - mainAspect) / mainAspect < 0.04) return { plane: p, bars: false };
  if (mainAspect > aspect) {
    const h = Math.round(p.w / mainAspect);
    const bar = Math.floor((p.h - h) / 2);
    if (bar >= 2 && flatBand(p, 0, bar - 1, true) && flatBand(p, p.h - bar + 1, p.h, true)) {
      return { plane: crop(p, 0, bar, p.w, p.h - 2 * bar), bars: true };
    }
  } else {
    const w = Math.round(p.h * mainAspect);
    const bar = Math.floor((p.w - w) / 2);
    if (bar >= 2 && flatBand(p, 0, bar - 1, false) && flatBand(p, p.w - bar + 1, p.w, false)) {
      return { plane: crop(p, bar, 0, p.w - 2 * bar, p.h), bars: true };
    }
  }
  return { plane: p, bars: false };
}

/** Box-average a plane down to gw x gh. */
function shrinkPlane(p: Plane, gw: number, gh: number): Float64Array {
  const sum = new Float64Array(gw * gh);
  const cnt = new Float64Array(gw * gh);
  for (let y = 0; y < p.h; y++) {
    const gy = Math.min(gh - 1, Math.floor((y * gh) / p.h));
    for (let x = 0; x < p.w; x++) {
      const gx = Math.min(gw - 1, Math.floor((x * gw) / p.w));
      sum[gy * gw + gx]! += p.v[y * p.w + x]!;
      cnt[gy * gw + gx]! += 1;
    }
  }
  return fill(sum, cnt);
}

/** Box-average an RGBA image's luminance down to gw x gh in one pass (main images can be huge). */
function shrinkImage(img: RgbaImage, gw: number, gh: number): Float64Array {
  const sum = new Float64Array(gw * gh);
  const cnt = new Float64Array(gw * gh);
  const d = img.data;
  const cols = new Int32Array(img.width);
  for (let x = 0; x < img.width; x++) cols[x] = Math.min(gw - 1, Math.floor((x * gw) / img.width));
  for (let y = 0; y < img.height; y++) {
    const row = Math.min(gh - 1, Math.floor((y * gh) / img.height)) * gw;
    for (let x = 0, i = y * img.width * 4; x < img.width; x++, i += 4) {
      const a = d[i + 3]! / 255;
      const lum = 0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!;
      sum[row + cols[x]!]! += a * lum + (1 - a) * 255;
      cnt[row + cols[x]!]! += 1;
    }
  }
  return fill(sum, cnt);
}

/** Cells that received no pixel (grid larger than the picture) copy their left/upper neighbour. */
function fill(sum: Float64Array, cnt: Float64Array): Float64Array {
  for (let i = 0; i < sum.length; i++) {
    sum[i] = cnt[i]! > 0 ? sum[i]! / cnt[i]! : i > 0 ? sum[i - 1]! : 0;
  }
  return sum;
}

/** 0..1: Pearson correlation of the two grids, or a level comparison when one is flat. */
function similarity(a: Float64Array, b: Float64Array): number {
  const sa = stats(a);
  const sb = stats(b);
  // A flat picture cannot be the thumbnail of a detailed one (or the other way round).
  if (Math.min(sa.std, sb.std) < FLAT && Math.max(sa.std, sb.std) > 4 * FLAT) return 0;
  if (sa.std < FLAT || sb.std < FLAT) {
    let d = 0;
    for (let i = 0; i < a.length; i++) d += Math.abs(a[i]! - b[i]!);
    return Math.max(0, Math.min(1, 1 - d / a.length / 96));
  }
  let cov = 0;
  for (let i = 0; i < a.length; i++) cov += (a[i]! - sa.mean) * (b[i]! - sb.mean);
  return Math.max(0, Math.min(1, cov / a.length / (sa.std * sb.std)));
}

const REGION_NAMES = [
  ['top-left corner', 'top', 'top-right corner'],
  ['left side', 'centre', 'right side'],
  ['bottom-left corner', 'bottom', 'bottom-right corner'],
];

/** Indices of the grid cells in ninth (cx, cy) of the picture. */
function ninth(gw: number, gh: number, cx: number, cy: number): number[] {
  const out: number[] = [];
  for (let y = Math.floor((cy * gh) / 3); y < Math.floor(((cy + 1) * gh) / 3); y++) {
    for (let x = Math.floor((cx * gw) / 3); x < Math.floor(((cx + 1) * gw) / 3); x++) {
      out.push(y * gw + x);
    }
  }
  return out;
}

/** The ninth of the picture that differs most, once brightness and contrast are matched. */
function worstRegion(
  a: Float64Array,
  b: Float64Array,
  gw: number,
  gh: number,
): { name: string; diff: number; cells: Set<number> } {
  const sa = stats(a);
  const sb = stats(b);
  const k = sb.std >= FLAT && sa.std >= FLAT ? sa.std / sb.std : 1;
  let worst = { name: '', diff: 0, cells: new Set<number>() };
  for (let cy = 0; cy < 3; cy++) {
    for (let cx = 0; cx < 3; cx++) {
      const cells = ninth(gw, gh, cx, cy);
      let d = 0;
      for (const i of cells) d += Math.abs(a[i]! - ((b[i]! - sb.mean) * k + sa.mean));
      const diff = cells.length ? d / cells.length : 0;
      if (diff > worst.diff) worst = { name: REGION_NAMES[cy]![cx]!, diff, cells: new Set(cells) };
    }
  }
  return worst;
}

const without = (v: Float64Array, skip: Set<number>) =>
  Float64Array.from(v.filter((_, i) => !skip.has(i)));

export interface ThumbComparison {
  /** 0..1 for the best orientation. */
  similarity: number;
  verdict: 'match' | 'loose' | 'different';
  /** Clockwise rotation of the thumbnail that matches best. */
  rotation: 0 | 90 | 180 | 270;
  /** The thumbnail had letterbox bars that were ignored. */
  bars: boolean;
  /** When the pictures match overall but one area does not (a retouched spot). */
  editedRegion: string | null;
  grid: { width: number; height: number };
}

/**
 * Does an EXIF thumbnail show the main image? Both are averaged down to a coarse luminance grid
 * (robust to JPEG noise, resizing and colour tweaks) and correlated, in all four orientations.
 */
export function compareThumbnail(main: RgbaImage | LumaGrid, thumb: RgbaImage): ThumbComparison {
  const base: Plane = { w: thumb.width, h: thumb.height, v: lumaPlane(thumb) };
  const mainAspect = main.width / main.height;
  const shrinkMain = (gw: number, gh: number) =>
    'data' in main
      ? shrinkImage(main, gw, gh)
      : shrinkPlane({ w: main.cols, h: main.rows, v: main.v }, gw, gh);
  const verdictOf = (s: number): ThumbComparison['verdict'] =>
    s >= MATCH_THRESHOLD ? 'match' : s >= DIFFERENT_THRESHOLD ? 'loose' : 'different';
  const tries = [0, 1, 2, 3].map((turns) => {
    const { plane, bars } = stripBars(rotate(base, turns), mainAspect);
    const scale = Math.min(1, GRID / Math.max(plane.w, plane.h));
    const gw = Math.max(1, Math.round(plane.w * scale));
    const gh = Math.max(1, Math.round(plane.h * scale));
    const a = shrinkMain(gw, gh);
    const b = shrinkPlane(plane, gw, gh);
    const s = similarity(a, b);
    return {
      similarity: s,
      verdict: verdictOf(s),
      rotation: (turns * 90) as ThumbComparison['rotation'],
      bars,
      editedRegion: null,
      grid: { width: gw, height: gh },
      a,
      b,
    };
  });
  // The stored orientation counts, unless only a rotated thumbnail matches (rotated main image).
  const rotated = tries.slice(1).filter((t) => t.verdict === 'match');
  const best =
    tries[0]!.verdict !== 'match' && rotated.length
      ? rotated.reduce((x, y) => (y.similarity > x.similarity ? y : x))
      : tries[0]!;
  const { a, b, ...result }: ThumbComparison & { a: Float64Array; b: Float64Array } = best;
  // One ninth very different while the other eight match: a local edit (paint-over, blur,
  // removed object), which the thumbnail made before the edit still shows.
  if (result.grid.width >= 6 && result.grid.height >= 6) {
    const worst = worstRegion(a, b, result.grid.width, result.grid.height);
    if (
      worst.diff > REGION_THRESHOLD &&
      similarity(without(a, worst.cells), without(b, worst.cells)) >= MATCH_THRESHOLD
    ) {
      result.verdict = 'match';
      result.editedRegion = worst.name;
    }
  }
  return result;
}
