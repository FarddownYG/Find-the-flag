import { ToolError } from '../../core/errors';
import type { RgbaImage } from '../../core/types';
import { toolT } from '../../i18n/tool-text';

const T = toolT('emd');

/**
 * EMD, Exploiting Modification Direction (Zhang and Wang, 2006).
 *
 * A group of n values g1..gn carries ONE digit in base 2n+1:  f(g) = (1*g1 + 2*g2 + ... + n*gn)
 * mod (2n+1). To write a digit d, s = (d - f) mod (2n+1) tells what to do: s = 0 nothing;
 * s <= n add 1 to g_s; otherwise subtract 1 from g_(2n+1-s). At most one value moves, by 1.
 *
 * Saturation (0 and 255 cannot move outwards): when the single step is impossible the embedder
 * does NOT clamp or skip (the extractor could not know). It searches the smallest other change of
 * the same group that lands on the same digit: first several values by +-1, then one value by a few
 * levels. Such a change always exists (n <= 8), so every digit is written exactly.
 */

export type EmdChannel = 'r' | 'g' | 'b' | 'luma' | 'avg';
export type EmdTraversal = 'horizontal' | 'vertical' | 'raw';

export interface EmdParams {
  /** Values per group. A group carries one digit in base 2n+1. */
  n: number;
  /** Which value of a pixel is used (ignored for the raw traversal). */
  channel: EmdChannel;
  traversal: EmdTraversal;
  /** Values skipped along the traversal before the first group: pixels, or bytes when raw. */
  offset: number;
}

export const MAX_N = 8;
export const emdBase = (n: number) => 2 * n + 1;

/** The extraction function f(g1..gn) = (1*g1 + 2*g2 + ... + n*gn) mod (2n+1). */
export function emdValue(group: ArrayLike<number>, n = group.length): number {
  let s = 0;
  for (let i = 0; i < n; i++) s += (i + 1) * group[i]!;
  return s % (2 * n + 1);
}

/** Integer BT.601 luma, rounded. For a grey pixel (r = g = b = v) it is exactly v. */
export const lumaOf = (r: number, g: number, b: number) =>
  Math.floor((299 * r + 587 * g + 114 * b + 500) / 1000);
/** Rounded mean of the three channels. */
export const averageOf = (r: number, g: number, b: number) => Math.floor((r + g + b + 1) / 3);

/** An image seen as a flat list of values along a traversal, which groups are cut from. */
export interface Layout {
  /** Values available along the traversal. */
  count: number;
  read(i: number): number;
  /** Move value i by exactly `delta` (by editing pixel bytes). False, with no change, if impossible. */
  shift(i: number, delta: number): boolean;
  canShift(i: number, delta: number): boolean;
}

/** True when some pixel is not fully opaque: the raw byte stream then includes alpha. */
export function hasTransparency(data: Uint8ClampedArray): boolean {
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) return true;
  return false;
}

/** Number of values along a traversal (pixels, or RGB / RGBA bytes when raw). */
export function streamLength(img: RgbaImage, traversal: EmdTraversal): number {
  const pixels = img.width * img.height;
  if (traversal !== 'raw') return pixels;
  return pixels * (hasTransparency(img.data) ? 4 : 3);
}

/** How many whole groups fit after the offset. */
export function capacityGroups(img: RgbaImage, p: EmdParams): number {
  return Math.max(0, Math.floor((streamLength(img, p.traversal) - p.offset) / p.n));
}

type Plan = readonly [number, number, number];
const BYTE_OF = { r: 0, g: 1, b: 2 } as const;
const MEMO_LIMIT = 1 << 16;

/** Smallest change of (r, g, b) that moves fn(r, g, b) by exactly `delta`; null if none. */
function planDerived(
  fn: (r: number, g: number, b: number) => number,
  r: number,
  g: number,
  b: number,
  delta: number,
): Plan | null {
  const target = fn(r, g, b) + delta;
  if (target < 0 || target > 255) return null;
  // A grey pixel stays grey: the same step on all three channels moves luma and mean alike.
  if (r === g && g === b && r + delta >= 0 && r + delta <= 255) return [delta, delta, delta];
  const reach = 2 * Math.abs(delta) + 2;
  for (let rho = 1; rho <= reach; rho++) {
    let best: Plan | null = null;
    let bestCost = Infinity;
    for (let dr = -rho; dr <= rho; dr++) {
      const r2 = r + dr;
      if (r2 < 0 || r2 > 255) continue;
      for (let dg = -rho; dg <= rho; dg++) {
        const g2 = g + dg;
        if (g2 < 0 || g2 > 255) continue;
        for (let db = -rho; db <= rho; db++) {
          if (Math.max(Math.abs(dr), Math.abs(dg), Math.abs(db)) !== rho) continue;
          const b2 = b + db;
          if (b2 < 0 || b2 > 255 || fn(r2, g2, b2) !== target) continue;
          const cost = Math.abs(dr) + Math.abs(dg) + Math.abs(db);
          if (cost < bestCost) {
            bestCost = cost;
            best = [dr, dg, db];
          }
        }
      }
    }
    if (best) return best;
  }
  return null;
}

/**
 * Build the layout of `data` (RGBA, w x h). Horizontal: pixels row by row. Vertical: column by
 * column. Raw: every byte of the RGB stream (RGBA when the image has transparency) in turn.
 * `data` is read live, and edited by shift(): pass a copy to embed.
 */
export function makeLayout(
  w: number,
  h: number,
  data: Uint8ClampedArray,
  channel: EmdChannel,
  traversal: EmdTraversal,
): Layout {
  const pixels = w * h;
  if (traversal === 'raw') {
    const alpha = hasTransparency(data);
    const stride = alpha ? 4 : 3;
    const byteAt = (i: number) => {
      const p = Math.floor(i / stride);
      return p * 4 + (i - p * stride);
    };
    // Alpha bytes are never edited: that keeps the stride (opaque or not) the same after embedding.
    const movable = (k: number, delta: number) => {
      if ((k & 3) === 3) return false;
      const v = data[k]! + delta;
      return v >= 0 && v <= 255;
    };
    return {
      count: pixels * stride,
      read: (i) => data[byteAt(i)]!,
      canShift: (i, delta) => movable(byteAt(i), delta),
      shift(i, delta) {
        const k = byteAt(i);
        if (!movable(k, delta)) return false;
        data[k] = data[k]! + delta;
        return true;
      },
    };
  }

  const pixelOf =
    traversal === 'vertical'
      ? (i: number) => {
          const y = i % h;
          return y * w + (i - y) / h;
        }
      : (i: number) => i;

  if (channel === 'r' || channel === 'g' || channel === 'b') {
    const ch = BYTE_OF[channel];
    return {
      count: pixels,
      read: (i) => data[pixelOf(i) * 4 + ch]!,
      canShift(i, delta) {
        const v = data[pixelOf(i) * 4 + ch]! + delta;
        return v >= 0 && v <= 255;
      },
      shift(i, delta) {
        const k = pixelOf(i) * 4 + ch;
        const v = data[k]! + delta;
        if (v < 0 || v > 255) return false;
        data[k] = v;
        return true;
      },
    };
  }

  const fn = channel === 'luma' ? lumaOf : averageOf;
  const memo = new Map<number, Plan | null>();
  const planFor = (base: number, delta: number): Plan | null => {
    const r = data[base]!;
    const g = data[base + 1]!;
    const b = data[base + 2]!;
    const key = ((r * 256 + g) * 256 + b) * 64 + delta + 32;
    if (memo.has(key)) return memo.get(key)!;
    const plan = planDerived(fn, r, g, b, delta);
    // Flat areas repeat the same colour; photographs do not, so keep the table small.
    if (memo.size >= MEMO_LIMIT) memo.clear();
    memo.set(key, plan);
    return plan;
  };
  return {
    count: pixels,
    read(i) {
      const k = pixelOf(i) * 4;
      return fn(data[k]!, data[k + 1]!, data[k + 2]!);
    },
    canShift: (i, delta) => planFor(pixelOf(i) * 4, delta) !== null,
    shift(i, delta) {
      const k = pixelOf(i) * 4;
      const plan = planFor(k, delta);
      if (!plan) return false;
      data[k] = data[k]! + plan[0];
      data[k + 1] = data[k + 1]! + plan[1];
      data[k + 2] = data[k + 2]! + plan[2];
      return true;
    },
  };
}

export function checkParams(img: RgbaImage, p: EmdParams): void {
  if (!img.width || !img.height) throw new ToolError(T('error.noPixels'));
  if (!Number.isInteger(p.n) || p.n < 1 || p.n > MAX_N) throw new ToolError(T('error.badN'));
  if (!Number.isInteger(p.offset) || p.offset < 0) throw new ToolError(T('error.badOffset'));
}

/** The digits stored in the image: one per group of n values, base 2n+1. */
export function readDigits(img: RgbaImage, p: EmdParams, maxDigits = Infinity): Uint8Array {
  checkParams(img, p);
  const layout = makeLayout(img.width, img.height, img.data, p.channel, p.traversal);
  const base = emdBase(p.n);
  const groups = Math.max(0, Math.floor((layout.count - p.offset) / p.n));
  const count = Math.min(groups, maxDigits);
  const out = new Uint8Array(count);
  for (let g = 0; g < count; g++) {
    const start = p.offset + g * p.n;
    let s = 0;
    for (let j = 0; j < p.n; j++) s += (j + 1) * layout.read(start + j);
    out[g] = s % base;
  }
  return out;
}

interface Combo {
  /** Change of f (mod base) this combination produces. */
  df: number;
  moves: number;
  deltas: Int8Array;
}
const comboCache = new Map<number, Combo[]>();

/** Every way to move some values of a group by +-1, fewest moves first (for saturated groups). */
function combos(n: number): Combo[] {
  const cached = comboCache.get(n);
  if (cached) return cached;
  const base = emdBase(n);
  const list: Combo[] = [];
  const total = 3 ** n;
  for (let m = 1; m < total; m++) {
    const deltas = new Int8Array(n);
    let x = m;
    let moves = 0;
    let df = 0;
    for (let j = 0; j < n; j++) {
      const d = (x % 3) - 1;
      x = Math.floor(x / 3);
      deltas[j] = d;
      if (d) moves++;
      df += d * (j + 1);
    }
    list.push({ df: ((df % base) + base) % base, moves, deltas });
  }
  list.sort((a, b) => a.moves - b.moves);
  comboCache.set(n, list);
  return list;
}

/** The single +-1 step failed (saturation): find another change of the group that gives f + s. */
function repair(layout: Layout, n: number, start: number, s: number): boolean {
  const base = emdBase(n);
  for (const c of combos(n)) {
    if (c.df !== s) continue;
    let ok = true;
    for (let j = 0; j < n && ok; j++) {
      if (c.deltas[j] && !layout.canShift(start + j, c.deltas[j]!)) ok = false;
    }
    if (!ok) continue;
    for (let j = 0; j < n; j++) if (c.deltas[j]) layout.shift(start + j, c.deltas[j]!);
    return true;
  }
  // One value by a few levels: k * (j + 1) = s (mod base) always has a solution for value 1.
  for (let k = 2; k <= 2 * n; k++) {
    for (let j = 0; j < n; j++) {
      for (const sign of [1, -1]) {
        const df = (((sign * k * (j + 1)) % base) + base) % base;
        if (df === s && layout.canShift(start + j, sign * k)) {
          return layout.shift(start + j, sign * k);
        }
      }
    }
  }
  return false;
}

/**
 * Write one digit per group, starting at the offset. Returns a new image; the input is untouched.
 * Throws a ToolError when the digits need more groups than the image has.
 */
export function embedDigits(img: RgbaImage, p: EmdParams, digits: Uint8Array): RgbaImage {
  checkParams(img, p);
  const have = capacityGroups(img, p);
  if (digits.length > have) {
    throw new ToolError(T('error.noRoom', { need: digits.length, have, offset: p.offset }));
  }
  const data = new Uint8ClampedArray(img.data);
  const layout = makeLayout(img.width, img.height, data, p.channel, p.traversal);
  const { n } = p;
  const base = emdBase(n);
  for (let g = 0; g < digits.length; g++) {
    const start = p.offset + g * n;
    let f = 0;
    for (let j = 0; j < n; j++) f += (j + 1) * layout.read(start + j);
    const s = (((digits[g]! - f) % base) + base) % base;
    if (s === 0) continue;
    const ok = s <= n ? layout.shift(start + s - 1, 1) : layout.shift(start + base - s - 1, -1);
    if (!ok && !repair(layout, n, start, s)) {
      throw new ToolError(T('error.stuck', { group: g + 1 }));
    }
  }
  return { width: img.width, height: img.height, data };
}

export interface ChangeStats {
  /** Pixels with at least one changed byte. */
  pixels: number;
  /** Largest change of any byte. */
  maxChange: number;
  /** Peak signal-to-noise ratio in dB; Infinity when nothing changed. */
  psnr: number;
}

export function changeStats(before: RgbaImage, after: RgbaImage): ChangeStats {
  const a = before.data;
  const b = after.data;
  const alpha = hasTransparency(a) || hasTransparency(b);
  const channels = alpha ? 4 : 3;
  let pixels = 0;
  let maxChange = 0;
  let sq = 0;
  for (let p = 0; p < a.length; p += 4) {
    let touched = false;
    for (let c = 0; c < channels; c++) {
      const d = Math.abs(a[p + c]! - b[p + c]!);
      if (!d) continue;
      touched = true;
      sq += d * d;
      if (d > maxChange) maxChange = d;
    }
    if (touched) pixels++;
  }
  const mse = sq / ((a.length / 4) * channels);
  return { pixels, maxChange, psnr: mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse) };
}
