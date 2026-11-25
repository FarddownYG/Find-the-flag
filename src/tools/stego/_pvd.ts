/**
 * Pixel Value Differencing (PVD) steganography — Wu & Tsai (2003) and the usual variants.
 *
 * The image is walked in some order and split into non-overlapping pixel pairs. For a pair
 * (p1, p2) the difference d = |p2 - p1| falls into a range [lo, hi]; the range width is a power of
 * two, so it carries n = log2(width) bits, and the value is d - lo. A larger difference (an edge)
 * hides more bits than a flat area, which is what makes PVD quiet.
 *
 * Everything here is pure (pixels in, bits out, and the reverse for the encoder) so the traversal,
 * range table, channel and the fall-off-boundary test are all easy to test and to combine.
 */
import type { RgbaImage } from '../../core/types';

// ---------- range tables ----------

export interface Range {
  lo: number;
  hi: number;
  bits: number;
}
export type RangeTable = readonly Range[];

/** The original Wu & Tsai ranges: 0-7, 8-15, 16-31, 32-63, 64-127, 128-255 → 3,3,4,5,6,7 bits. */
export const WU_TSAI: RangeTable = [
  { lo: 0, hi: 7, bits: 3 },
  { lo: 8, hi: 15, bits: 3 },
  { lo: 16, hi: 31, bits: 4 },
  { lo: 32, hi: 63, bits: 5 },
  { lo: 64, hi: 127, bits: 6 },
  { lo: 128, hi: 255, bits: 7 },
];

/** Build a table of `count` equal-width ranges over 0..255 (width must be a power of two). */
function equalWidth(width: number): RangeTable {
  const bits = Math.log2(width);
  if (!Number.isInteger(bits) || width < 2) throw new Error('width must be a power of two ≥ 2');
  const out: Range[] = [];
  for (let lo = 0; lo <= 255; lo += width) out.push({ lo, hi: Math.min(lo + width - 1, 255), bits });
  return out;
}

/** Equal 16-wide ranges (4 bits each), a common "simple PVD" variant. */
export const EQUAL_16: RangeTable = equalWidth(16);
/** Equal 8-wide ranges (3 bits each). */
export const EQUAL_8: RangeTable = equalWidth(8);

/**
 * Parse a custom table from widths like "8 8 16 32 64 128" (each a power of two). The widths must
 * tile 0..255. Returns null on a malformed spec.
 */
export function parseTable(spec: string): RangeTable | null {
  const widths = spec.trim().split(/[\s,]+/).filter(Boolean).map(Number);
  if (!widths.length || widths.some((w) => !Number.isInteger(w) || w < 2 || (w & (w - 1)) !== 0)) {
    return null;
  }
  const out: Range[] = [];
  let lo = 0;
  for (const w of widths) {
    if (lo > 255) return null;
    out.push({ lo, hi: Math.min(lo + w - 1, 255), bits: Math.log2(w) });
    lo += w;
  }
  return lo >= 256 ? out : null;
}

export const TABLES = {
  'wu-tsai': WU_TSAI,
  'equal-16': EQUAL_16,
  'equal-8': EQUAL_8,
} as const;
export type TableName = keyof typeof TABLES;

function rangeOf(table: RangeTable, d: number): Range {
  for (const r of table) if (d >= r.lo && d <= r.hi) return r;
  return table[table.length - 1]!;
}

// ---------- traversal & channel ----------

export type Traversal = 'row' | 'serpentine' | 'column' | 'column-serpentine';
export type Channel = 'gray' | 'r' | 'g' | 'b' | 'rgb';

/** Pixel indices (row-major) in the visiting order. */
export function sequence(width: number, height: number, traversal: Traversal): Int32Array {
  const seq = new Int32Array(width * height);
  let k = 0;
  if (traversal === 'row' || traversal === 'serpentine') {
    for (let y = 0; y < height; y++) {
      const rev = traversal === 'serpentine' && y % 2 === 1;
      for (let i = 0; i < width; i++) seq[k++] = y * width + (rev ? width - 1 - i : i);
    }
  } else {
    for (let x = 0; x < width; x++) {
      const rev = traversal === 'column-serpentine' && x % 2 === 1;
      for (let i = 0; i < height; i++) seq[k++] = (rev ? height - 1 - i : i) * width + x;
    }
  }
  return seq;
}

const CHANNEL_OFFSET: Record<Exclude<Channel, 'rgb'>, number> = { gray: 0, r: 0, g: 1, b: 2 };

/** A channel sample and where it lives, in traversal order (RGB yields three samples per pixel). */
export interface Samples {
  /** The channel value of each sample. */
  val: Uint8Array;
  /** Byte offset of each sample inside image.data (for the "which bytes" evidence). */
  dataOffset: Int32Array;
  width: number;
  height: number;
}

export function samplesOf(image: RgbaImage, channel: Channel, seq: Int32Array): Samples {
  const per = channel === 'rgb' ? 3 : 1;
  const val = new Uint8Array(seq.length * per);
  const dataOffset = new Int32Array(seq.length * per);
  let k = 0;
  for (let s = 0; s < seq.length; s++) {
    const px = seq[s]! * 4;
    if (channel === 'rgb') {
      for (let c = 0; c < 3; c++) {
        val[k] = image.data[px + c]!;
        dataOffset[k] = px + c;
        k++;
      }
    } else {
      const c = CHANNEL_OFFSET[channel];
      val[k] = image.data[px + c]!;
      dataOffset[k] = px + c;
      k++;
    }
  }
  return { val, dataOffset, width: image.width, height: image.height };
}

// ---------- fall-off-boundary (Wu & Tsai overflow test) ----------

/** New pixel values when a pair's difference is pushed to `dNew`, keeping the average (Wu & Tsai). */
export function adjust(p1: number, p2: number, dNew: number): [number, number] {
  const m = dNew - Math.abs(p2 - p1);
  const hi = Math.ceil(m / 2);
  const lo = Math.floor(m / 2);
  return p1 <= p2 ? [p1 - hi, p2 + lo] : [p1 + hi, p2 - lo];
}

/** A pair can embed only if setting its difference to the top of its range stays inside 0..255. */
function usable(p1: number, p2: number, r: Range): boolean {
  const [a, b] = adjust(p1, p2, r.hi);
  return a >= 0 && a <= 255 && b >= 0 && b <= 255;
}

// ---------- extract (decode) ----------

export interface PvdParams {
  table: RangeTable;
  overflow: boolean;
}

export interface PairTrace {
  /** Indices of the two samples in the Samples arrays. */
  i: number;
  j: number;
  p1: number;
  p2: number;
  d: number;
  range: Range;
  /** The value d - lo, i.e. the bits this pair carries. */
  value: number;
}

/** Read the embedded bits from the samples. `maxBits` stops early (auto-mode preview). */
export function extractBits(
  s: Samples,
  p: PvdParams,
  maxBits = Infinity,
  trace?: PairTrace[],
): number[] {
  const bits: number[] = [];
  const n = s.val.length - (s.val.length % 2);
  for (let i = 0; i < n && bits.length < maxBits; i += 2) {
    const p1 = s.val[i]!;
    const p2 = s.val[i + 1]!;
    const d = Math.abs(p2 - p1);
    const r = rangeOf(p.table, d);
    if (p.overflow && !usable(p1, p2, r)) continue;
    const value = d - r.lo;
    if (trace && trace.length < 8) trace.push({ i, j: i + 1, p1, p2, d, range: r, value });
    for (let k = r.bits - 1; k >= 0; k--) bits.push((value >> k) & 1);
  }
  return bits;
}

/** Pack bits into bytes, most- or least-significant bit first; a trailing partial byte is dropped. */
export function bitsToBytes(bits: readonly number[], msbFirst: boolean): Uint8Array {
  const out = new Uint8Array(Math.floor(bits.length / 8));
  for (let i = 0; i < out.length; i++) {
    let b = 0;
    for (let j = 0; j < 8; j++) b |= bits[i * 8 + j]! << (msbFirst ? 7 - j : j);
    out[i] = b;
  }
  return out;
}

// ---------- embed (encoder, for tests and learning) ----------

/** Bits of a message's bytes, most- or least-significant bit first. */
export function bytesToBits(bytes: Uint8Array, msbFirst: boolean): number[] {
  const bits: number[] = [];
  for (const byte of bytes) for (let j = 0; j < 8; j++) bits.push((byte >> (msbFirst ? 7 - j : j)) & 1);
  return bits;
}

/**
 * Embed `bits` into a copy of `image` with the given settings, returning the new image. Pairs whose
 * difference cannot reach the top of its range without overflow are skipped (same rule as decoding),
 * so the message round-trips. Throws when the image cannot hold the bits.
 */
export function embed(
  image: RgbaImage,
  bits: readonly number[],
  o: { channel: Channel; traversal: Traversal } & PvdParams,
): RgbaImage {
  const data = new Uint8ClampedArray(image.data);
  const out: RgbaImage = { width: image.width, height: image.height, data };
  const seq = sequence(image.width, image.height, o.traversal);
  const s = samplesOf(out, o.channel, seq);
  let bitPos = 0;
  const n = s.val.length - (s.val.length % 2);
  for (let i = 0; i < n && bitPos < bits.length; i += 2) {
    const p1 = s.val[i]!;
    const p2 = s.val[i + 1]!;
    const d = Math.abs(p2 - p1);
    const r = rangeOf(o.table, d);
    if (o.overflow && !usable(p1, p2, r)) continue;
    let value = 0;
    let got = 0;
    while (got < r.bits && bitPos < bits.length) {
      value = (value << 1) | bits[bitPos++]!;
      got++;
    }
    // A last partial symbol: the real bits are its high bits, pad the rest with 0 (the decoder
    // reads the padding back as trailing zero bits, dropped when the stream is cut to length).
    if (got < r.bits) value <<= r.bits - got;
    const [a, b] = adjust(p1, p2, r.lo + value);
    data[s.dataOffset[i]!] = a;
    data[s.dataOffset[i + 1]!] = b;
  }
  if (bitPos < bits.length) throw new Error('message does not fit in the image');
  return out;
}

// ---------- capacity ----------

/** Rough capacity in bits: sum of each usable pair's bit count. */
export function capacityBits(image: RgbaImage, o: { channel: Channel; traversal: Traversal } & PvdParams): number {
  const s = samplesOf(image, o.channel, sequence(image.width, image.height, o.traversal));
  let bits = 0;
  const n = s.val.length - (s.val.length % 2);
  for (let i = 0; i < n; i += 2) {
    const d = Math.abs(s.val[i + 1]! - s.val[i]!);
    const r = rangeOf(o.table, d);
    if (o.overflow && !usable(s.val[i]!, s.val[i + 1]!, r)) continue;
    bits += r.bits;
  }
  return bits;
}
