/**
 * Carrier-zone detection and zone helpers for the LSB tool: which rows of an image have low bits
 * that behave unlike the rest, at what stride, plus the row zone / traversal pixel sequences and an
 * embedder that mirrors `extractBits`. Pure functions, deterministic and cheap (one pass per row).
 */
import { ToolError } from '../../core/errors';
import type { RgbaImage } from '../../core/types';
import { toolT } from '../../i18n/tool-text';
import type { LsbParams } from './_lsb-core';
import { sequence, type Traversal } from './_pvd';

const T = toolT('lsb');

/** Rows narrower than this carry too few bits for an entropy estimate to mean anything. */
const MIN_WIDTH = 16;
/** How far above the image median a row's low-bit entropy must sit, and the floor it must reach. */
const MARGIN = 0.25;
const FLOOR = 0.3;
/** A stride is credited when the busiest offset beats the quietest by this much. */
const STRIDE_CONTRAST = 0.4;

/** Shannon entropy (0..1) of a stream of bits, given how many are ones. */
function bitEntropy(ones: number, total: number): number {
  if (!total) return 0;
  const p = ones / total;
  if (p <= 0 || p >= 1) return 0;
  return -(p * Math.log2(p) + (1 - p) * Math.log2(1 - p));
}

/** Per-row Shannon entropy (0..1) of bit 0 of one channel (0 = R ... 3 = A). */
export function rowLsbEntropy(img: RgbaImage, channel: number): number[] {
  const { width: w, height: h, data } = img;
  const out: number[] = [];
  for (let y = 0; y < h; y++) {
    let ones = 0;
    for (let x = 0; x < w; x++) ones += data[(y * w + x) * 4 + channel]! & 1;
    out.push(bitEntropy(ones, w));
  }
  return out;
}

const median = (v: number[]): number => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? s[s.length >> 1]! : 0;
};

export interface AnomalyRow {
  row: number;
  /** How far the row's low-bit entropy sits above the image median (0..1). */
  score: number;
}

/**
 * Rows whose low-bit entropy is well above the image median: candidate carrier rows. Uses the
 * busiest of R, G and B per row. A noisy cover (every row near 1) flags nothing.
 */
export function anomalyRows(img: RgbaImage): AnomalyRow[] {
  if (img.width < MIN_WIDTH || img.height < 2) return [];
  const per = [0, 1, 2].map((c) => rowLsbEntropy(img, c));
  const best = per[0]!.map((_, y) => Math.max(per[0]![y]!, per[1]![y]!, per[2]![y]!));
  const med = median(best);
  const rows: AnomalyRow[] = [];
  best.forEach((e, row) => {
    const score = e - med;
    if (e >= FLOOR && score >= MARGIN) rows.push({ row, score: Math.round(score * 1000) / 1000 });
  });
  return rows;
}

export interface RowRange {
  from: number;
  to: number;
  /** Highest row score inside the range. */
  score: number;
}

/** Group sorted anomaly rows into contiguous ranges. */
export function rowRanges(rows: readonly AnomalyRow[]): RowRange[] {
  const out: RowRange[] = [];
  for (const r of rows) {
    const last = out[out.length - 1];
    if (last && r.row === last.to + 1) {
      last.to = r.row;
      last.score = Math.max(last.score, r.score);
    } else out.push({ from: r.row, to: r.row, score: r.score });
  }
  return out;
}

export interface StrideHint {
  step: number;
  offset: number;
}

/** Entropy of bit 0 of R, G and B over the pixels x = offset (mod step) of one row. */
function groupEntropy(img: RgbaImage, row: number, step: number, offset: number): number {
  const { width: w, data } = img;
  let ones = 0;
  let total = 0;
  for (let x = offset; x < w; x += step) {
    for (let c = 0; c < 3; c++) {
      ones += data[(row * w + x) * 4 + c]! & 1;
      total++;
    }
  }
  return bitEntropy(ones, total);
}

/**
 * Whether the low bits of one row only carry data on every `step`-th pixel (2 to 4): one offset
 * clearly busier than the others. Returns the smallest such step, with the busy offset.
 */
export function strideHint(img: RgbaImage, row: number): StrideHint | null {
  if (img.width < MIN_WIDTH || row < 0 || row >= img.height) return null;
  for (let step = 2; step <= 4; step++) {
    const e = Array.from({ length: step }, (_, k) => groupEntropy(img, row, step, k));
    const hi = Math.max(...e);
    const lo = Math.min(...e);
    if (hi - lo >= STRIDE_CONTRAST) return { step, offset: e.indexOf(hi) };
  }
  return null;
}

// ---------- row zones and traversal ----------

/** "" = every row; "0", "0-2", "0,3,5-6": a row mask (1 = in the zone), or null for the whole image. */
export function parseRows(textValue: string, height: number): Uint8Array | null {
  const parts = textValue.split(/[\s,]+/).filter(Boolean);
  if (!parts.length) return null;
  const mask = new Uint8Array(height);
  for (const part of parts) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) throw new ToolError(T('error.badRows', { part }));
    const lo = Number(m[1]);
    const hi = m[2] === undefined ? lo : Number(m[2]);
    if (hi < lo) throw new ToolError(T('error.badRowRange', { part }));
    if (hi >= height) throw new ToolError(T('error.noSuchRow', { row: hi, height }));
    for (let y = lo; y <= hi; y++) mask[y] = 1;
  }
  return mask;
}

/** Row-major pixel indices in traversal order, limited to the rows of the mask (if any). */
export function zonePixels(
  width: number,
  height: number,
  traversal: Traversal,
  rows: Uint8Array | null,
): Int32Array {
  const seq = sequence(width, height, traversal);
  if (!rows) return seq;
  const kept = new Int32Array(seq.length);
  let n = 0;
  for (const p of seq) if (rows[Math.floor(p / width)]) kept[n++] = p;
  return kept.slice(0, n);
}

/** A mask covering one range of rows. */
export function rangeMask(height: number, from: number, to: number): Uint8Array {
  const mask = new Uint8Array(height);
  mask.fill(1, from, to + 1);
  return mask;
}

/** Compact text of a row mask: "0", "0-2", "0,3-4". */
export function rowsLabel(rows: Uint8Array): string {
  const parts: string[] = [];
  for (let y = 0; y < rows.length; y++) {
    if (!rows[y]) continue;
    let end = y;
    while (end + 1 < rows.length && rows[end + 1]) end++;
    parts.push(end === y ? `${y}` : `${y}-${end}`);
    y = end;
  }
  return parts.join(',');
}

// ---------- embedder ----------

/**
 * The inverse of `extractBits` for the same params: write `payload` into the chosen bits, visiting
 * pixels in the same order (traversal, zone, step, offset). Returns a new image, or null when the
 * payload does not fit.
 */
export function embedBits(img: RgbaImage, p: LsbParams, payload: Uint8Array): RgbaImage | null {
  const { width: w, height: h } = img;
  const planes = p.bitOrder === 'msb' ? [...p.planes].reverse() : p.planes;
  const step = p.step && p.step > 0 ? Math.floor(p.step) : 1;
  const offset = p.offset && p.offset > 0 ? Math.floor(p.offset) : 0;
  const seqLen = p.pixels ? p.pixels.length : w * h;
  const count = Math.max(0, Math.ceil((seqLen - offset) / step));
  const total = payload.length * 8;
  if (count * p.channels.length * planes.length < total) return null;
  const data = new Uint8ClampedArray(img.data);
  const msb = p.bitOrder === 'msb';
  const pixelAt = (s: number): number => {
    if (p.pixels) return p.pixels[s]!;
    if (p.order === 'col') {
      const y = s % h;
      return y * w + (s - y) / h;
    }
    return s;
  };
  let bit = 0;
  for (let i = 0; i < count && bit < total; i++) {
    const base = pixelAt(offset + i * step) * 4;
    for (const ch of p.channels) {
      for (const pl of planes) {
        if (bit >= total) break;
        const byte = payload[bit >> 3]!;
        const v = msb ? (byte >> (7 - (bit & 7))) & 1 : (byte >> (bit & 7)) & 1;
        data[base + ch] = (data[base + ch]! & ~(1 << pl)) | (v << pl);
        bit++;
      }
    }
  }
  return { width: w, height: h, data };
}
