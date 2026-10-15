/**
 * Picture preparation for the barcode reader (pure, no DOM): greyscale, threshold, quiet-zone
 * margin, rescaling, tilt. Every function works on a plain 8-bit greyscale buffer, which is all
 * the reader looks at, and returns a map back to the pixels of the original when it moves them.
 */
import type { RgbaImage } from '../../core/types';

export interface Gray {
  width: number;
  height: number;
  data: Uint8Array;
}

export interface Point {
  x: number;
  y: number;
}

/** Maps a point of a prepared picture back onto the original picture. */
export type ToOriginal = (p: Point) => Point;

export const identity: ToOriginal = (p) => p;

/** Same weights as the reader's own greyscale conversion (306 / 601 / 117 over 1024). */
const luma = (r: number, g: number, b: number): number => (306 * r + 601 * g + 117 * b + 512) >> 10;

export function hasAlpha(img: RgbaImage): boolean {
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i] !== 255) return true;
  return false;
}

/**
 * Greyscale of a picture. Transparent pixels are laid over `background` (white or black), since
 * PNG barcodes are often black bars on a transparent background that would otherwise read black.
 */
export function toGray(img: RgbaImage, background: number): Gray {
  const n = img.width * img.height;
  const data = new Uint8Array(n);
  const px = img.data;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const a = px[j + 3]!;
    if (a === 255) {
      data[i] = luma(px[j]!, px[j + 1]!, px[j + 2]!);
    } else {
      const f = (c: number) => (c * a + background * (255 - a)) / 255;
      data[i] = luma(f(px[j]!), f(px[j + 1]!), f(px[j + 2]!));
    }
  }
  return { width: img.width, height: img.height, data };
}

/** The buffer the reader takes: RGBA with the grey value in every channel. */
export function grayToRgba(g: Gray): { width: number; height: number; data: Uint8ClampedArray } {
  const data = new Uint8ClampedArray(g.width * g.height * 4);
  for (let i = 0, j = 0; i < g.data.length; i++, j += 4) {
    const v = g.data[i]!;
    data[j] = data[j + 1] = data[j + 2] = v;
    data[j + 3] = 255;
  }
  return { width: g.width, height: g.height, data };
}

/** Otsu's threshold: the grey level that best separates the dark and the light pixels. */
export function otsu(g: Gray): number {
  const hist = new Array<number>(256).fill(0);
  for (let i = 0; i < g.data.length; i++) hist[g.data[i]!]!++;
  const n = g.data.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t]!;
  let wB = 0;
  let sumB = 0;
  let best = 128;
  let max = -1;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]!;
    if (!wB) continue;
    const wF = n - wB;
    if (!wF) break;
    sumB += t * hist[t]!;
    const between = wB * wF * (sumB / wB - (sum - sumB) / wF) ** 2;
    if (between > max) {
      max = between;
      best = t;
    }
  }
  return best;
}

/** Pixels darker than `t` become black, the others white. */
export function threshold(g: Gray, t: number): Gray {
  const data = new Uint8Array(g.data.length);
  for (let i = 0; i < data.length; i++) data[i] = g.data[i]! < t ? 0 : 255;
  return { width: g.width, height: g.height, data };
}

/** The grey level of the border (median of the outermost pixels): what a margin should match. */
export function borderLevel(g: Gray): number {
  const vals: number[] = [];
  const { width: w, height: h, data } = g;
  const stepX = Math.max(1, Math.floor(w / 256));
  const stepY = Math.max(1, Math.floor(h / 256));
  for (let x = 0; x < w; x += stepX) vals.push(data[x]!, data[(h - 1) * w + x]!);
  for (let y = 0; y < h; y += stepY) vals.push(data[y * w]!, data[y * w + w - 1]!);
  vals.sort((a, b) => a - b);
  return vals[vals.length >> 1] ?? 255;
}

/** A frame of `m` pixels of one grey level around the picture (the quiet zone). */
export function addMargin(
  g: Gray,
  m: number,
  value: number,
): { gray: Gray; toOriginal: ToOriginal } {
  const w = g.width + 2 * m;
  const h = g.height + 2 * m;
  const data = new Uint8Array(w * h).fill(value);
  for (let y = 0; y < g.height; y++) {
    data.set(g.data.subarray(y * g.width, (y + 1) * g.width), (y + m) * w + m);
  }
  return {
    gray: { width: w, height: h, data },
    toOriginal: (p) => ({ x: p.x - m, y: p.y - m }),
  };
}

/** Each pixel becomes a k x k block (keeps hard edges, which is what a tiny code needs). */
export function upscale(g: Gray, k: number): { gray: Gray; toOriginal: ToOriginal } {
  const w = g.width * k;
  const h = g.height * k;
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = Math.floor(y / k) * g.width;
    for (let x = 0; x < w; x++) data[y * w + x] = g.data[sy + Math.floor(x / k)]!;
  }
  return { gray: { width: w, height: h, data }, toOriginal: (p) => ({ x: p.x / k, y: p.y / k }) };
}

/** Average k x k blocks: smooths noise and brings a huge picture down to a workable size. */
export function shrink(g: Gray, k: number): { gray: Gray; toOriginal: ToOriginal } {
  const w = Math.max(1, Math.floor(g.width / k));
  const h = Math.max(1, Math.floor(g.height / k));
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      let count = 0;
      for (let dy = 0; dy < k; dy++) {
        const sy = y * k + dy;
        if (sy >= g.height) break;
        for (let dx = 0; dx < k; dx++) {
          const sx = x * k + dx;
          if (sx >= g.width) break;
          sum += g.data[sy * g.width + sx]!;
          count++;
        }
      }
      data[y * w + x] = Math.round(sum / count);
    }
  }
  return { gray: { width: w, height: h, data }, toOriginal: (p) => ({ x: p.x * k, y: p.y * k }) };
}

/**
 * The picture turned by `degrees` (bilinear), on a canvas big enough to hold all of it and
 * filled with `fill` where there was nothing. The map takes a point of the turned picture back
 * to the original.
 */
export function rotate(
  g: Gray,
  degrees: number,
  fill: number,
): { gray: Gray; toOriginal: ToOriginal } {
  const rad = (degrees * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const w = Math.ceil(Math.abs(g.width * cos) + Math.abs(g.height * sin));
  const h = Math.ceil(Math.abs(g.width * sin) + Math.abs(g.height * cos));
  const cx = g.width / 2;
  const cy = g.height / 2;
  const ox = w / 2;
  const oy = h / 2;
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Destination pixel centre, turned back by -angle into the source.
      const dx = x + 0.5 - ox;
      const dy = y + 0.5 - oy;
      const sx = dx * cos + dy * sin + cx - 0.5;
      const sy = -dx * sin + dy * cos + cy - 0.5;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      if (x0 < -1 || y0 < -1 || x0 >= g.width || y0 >= g.height) {
        data[y * w + x] = fill;
        continue;
      }
      const fx = sx - x0;
      const fy = sy - y0;
      const at = (xx: number, yy: number) =>
        xx < 0 || yy < 0 || xx >= g.width || yy >= g.height ? fill : g.data[yy * g.width + xx]!;
      const top = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx;
      const bottom = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx;
      data[y * w + x] = Math.round(top * (1 - fy) + bottom * fy);
    }
  }
  return {
    gray: { width: w, height: h, data },
    toOriginal: (p) => {
      const dx = p.x + 0.5 - ox;
      const dy = p.y + 0.5 - oy;
      return { x: dx * cos + dy * sin + cx - 0.5, y: -dx * sin + dy * cos + cy - 0.5 };
    },
  };
}

/** Every grey level turned around (white on black becomes black on white). */
export function invert(g: Gray): Gray {
  const data = new Uint8Array(g.data.length);
  for (let i = 0; i < data.length; i++) data[i] = 255 - g.data[i]!;
  return { width: g.width, height: g.height, data };
}

/**
 * Share of pixels that stand out from all eight neighbours, all lighter or all darker by a wide
 * margin: salt-and-pepper speckle. (A grey pixel on the edge of a bar has lighter and darker
 * neighbours, and a pixel on a thin line has a neighbour like itself: neither counts.)
 */
export function speckleShare(g: Gray): number {
  const { width: w, height: h, data } = g;
  const offsets = [-w - 1, -w, -w + 1, -1, 1, w - 1, w, w + 1];
  let count = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const v = data[i]!;
      let darker = 0;
      let lighter = 0;
      for (const o of offsets) {
        const n = data[i + o]!;
        if (n - v > 100) lighter++;
        else if (v - n > 100) darker++;
      }
      if (darker === 8 || lighter === 8) count++;
    }
  }
  return count / (w * h);
}

/** 3 x 3 median filter: removes isolated specks (it would also erase 1-pixel-wide bars). */
export function median3(g: Gray): Gray {
  const { width: w, height: h, data } = g;
  const out = new Uint8Array(data);
  const win = new Uint8Array(9);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      win[0] = data[i - w - 1]!;
      win[1] = data[i - w]!;
      win[2] = data[i - w + 1]!;
      win[3] = data[i - 1]!;
      win[4] = data[i]!;
      win[5] = data[i + 1]!;
      win[6] = data[i + w - 1]!;
      win[7] = data[i + w]!;
      win[8] = data[i + w + 1]!;
      // Insertion sort of nine values, then the middle one.
      for (let a = 1; a < 9; a++) {
        const v = win[a]!;
        let b = a - 1;
        while (b >= 0 && win[b]! > v) {
          win[b + 1] = win[b]!;
          b--;
        }
        win[b + 1] = v;
      }
      out[i] = win[4]!;
    }
  }
  return { width: w, height: h, data: out };
}

export interface TracedBars {
  /** Corners of the code's rectangle, going round (a tilted rectangle if the code leans). */
  corners: [Point, Point, Point, Point];
  /** Degrees the code is turned further than the reader's 0 / 90 / 180 / 270, clockwise. */
  slant: number;
  /** The bars were followed far enough for the lean to be the code's angle. */
  sure: boolean;
}

/** Rows (or columns) of bars that must be followed before their lean is trusted. */
const MIN_TRACE = 12;

/**
 * Follow the bars of a 1D code over their whole height. The reader only reports the scan lines
 * that agreed (a thin strip when the picture is noisy or the code is turned a little); the bars
 * go on above and below it, shifting sideways when the code leans. Each row (column, for a code
 * lying on its side) is compared with the strip's middle one and a sideways shift of up to two
 * pixels from the row before is allowed: the box follows the code, and its lean is the code's
 * angle.
 */
export function traceBars(g: Gray, strip: readonly Point[]): TracedBars {
  const xs = strip.map((c) => c.x);
  const ys = strip.map((c) => c.y);
  const clamp = (v: number, max: number) => Math.max(0, Math.min(max, Math.round(v)));
  const x0 = clamp(Math.min(...xs), g.width - 1);
  const x1 = clamp(Math.max(...xs), g.width - 1);
  const y0 = clamp(Math.min(...ys), g.height - 1);
  const y1 = clamp(Math.max(...ys), g.height - 1);
  const horizontal = x1 - x0 >= y1 - y0;
  // a: along the code, b: across its bars.
  const a0 = horizontal ? x0 : y0;
  const lenA = (horizontal ? x1 - x0 : y1 - y0) + 1;
  const sizeA = horizontal ? g.width : g.height;
  const sizeB = horizontal ? g.height : g.width;
  const pix = (a: number, b: number): number =>
    horizontal ? g.data[b * g.width + a]! : g.data[a * g.width + b]!;
  const mid = horizontal ? (y0 + y1) >> 1 : (x0 + x1) >> 1;
  let lo = 255;
  let hi = 0;
  for (let i = 0; i < lenA; i++) {
    lo = Math.min(lo, pix(a0 + i, mid));
    hi = Math.max(hi, pix(a0 + i, mid));
  }
  const cut = (lo + hi) / 2;
  const ref = Array.from({ length: lenA }, (_, i) => pix(a0 + i, mid) < cut);
  const score = (b: number, shift: number): number => {
    if (a0 + shift < 0 || a0 + lenA + shift > sizeA) return 0;
    let equal = 0;
    for (let i = 0; i < lenA; i++) if (pix(a0 + i + shift, b) < cut === ref[i]) equal++;
    return equal / lenA;
  };
  const follow = (step: number): { edge: number; shift: number } => {
    let edge = mid;
    let edgeShift = 0;
    let shift = 0;
    let misses = 0;
    if (hi - lo < 40) return { edge, shift: 0 };
    for (let b = mid + step; b >= 0 && b < sizeB; b += step) {
      let best = -1;
      let bestShift = shift;
      for (let d = -2; d <= 2; d++) {
        const sc = score(b, shift + d);
        if (sc > best) {
          best = sc;
          bestShift = shift + d;
        }
      }
      if (best >= 0.78) {
        shift = bestShift;
        edge = b;
        edgeShift = shift;
        misses = 0;
      } else if (++misses > 3) break;
    }
    return { edge, shift: edgeShift };
  };
  const first = follow(-1);
  const last = follow(1);
  // The strip as reported is the least we show.
  const b0 = Math.min(first.edge, horizontal ? y0 : x0);
  const b1 = Math.max(last.edge, horizontal ? y1 : x1);
  const s0 = b0 === first.edge ? first.shift : 0;
  const s1 = b1 === last.edge ? last.shift : 0;
  const depth = b1 - b0 + 1;
  const lean = (Math.atan2(s1 - s0, Math.max(1, b1 - b0)) * 180) / Math.PI;
  // A code turned clockwise leans its bars to the left going down; one lying on its side, the other way.
  const sure = depth >= MIN_TRACE;
  const slant = sure ? (horizontal ? -lean : lean) : 0;
  // The box is the code's own rectangle: its sides run along the bars and across them.
  const rad = (slant * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const along = horizontal ? { x: cos, y: sin } : { x: -sin, y: cos };
  const across = horizontal ? { x: -sin, y: cos } : { x: cos, y: sin };
  const length = (lenA * cos) / 2;
  const height = depth / cos / 2;
  const centreA = a0 + lenA / 2 + (s0 + s1) / 2;
  const centreB = (b0 + b1 + 1) / 2;
  const c = horizontal ? { x: centreA, y: centreB } : { x: centreB, y: centreA };
  const at = (la: number, hb: number): Point => ({
    x: c.x + la * along.x + hb * across.x,
    y: c.y + la * along.y + hb * across.y,
  });
  const corners: TracedBars['corners'] = [
    at(-length, -height),
    at(length, -height),
    at(length, height),
    at(-length, height),
  ];
  return { corners, slant, sure };
}

/** Compose two maps: `inner` runs first (prepared picture -> intermediate), then `outer`. */
export const compose =
  (outer: ToOriginal, inner: ToOriginal): ToOriginal =>
  (p) =>
    outer(inner(p));
