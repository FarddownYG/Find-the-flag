/**
 * Plumbing shared by the executable analyzer's parsers: a cached reader over a LazyFile, typed
 * reads that throw `Truncated` instead of returning garbage, entropy of a file region and a few
 * formatting helpers. Nothing here knows about ELF, PE or Mach-O.
 */
import type { LazyFile } from '../../core/types';
import { shannon } from './entropy';

/** A read went past the end of the bytes we have: the structure is cut short or points outside. */
export class Truncated extends Error {
  override name = 'Truncated';
}

const TWO32 = 4294967296;

/** Typed reads at offsets of a byte window. Anything outside the window throws `Truncated`. */
export class Buf {
  private readonly dv: DataView;
  constructor(
    readonly bytes: Uint8Array,
    readonly le = true,
  ) {
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  get length(): number {
    return this.bytes.length;
  }
  /** The same bytes read with the other byte order. */
  order(le: boolean): Buf {
    return le === this.le ? this : new Buf(this.bytes, le);
  }
  has(o: number, n: number): boolean {
    return Number.isInteger(o) && o >= 0 && n >= 0 && o + n <= this.bytes.length;
  }
  need(o: number, n: number): void {
    if (!this.has(o, n)) throw new Truncated();
  }
  u8(o: number): number {
    this.need(o, 1);
    return this.bytes[o]!;
  }
  u16(o: number): number {
    this.need(o, 2);
    return this.dv.getUint16(o, this.le);
  }
  u32(o: number): number {
    this.need(o, 4);
    return this.dv.getUint32(o, this.le);
  }
  i32(o: number): number {
    this.need(o, 4);
    return this.dv.getInt32(o, this.le);
  }
  u64(o: number): bigint {
    this.need(o, 8);
    return this.dv.getBigUint64(o, this.le);
  }
  /** A 64-bit field as a number; `Infinity` when it does not fit in 2^53 (so bounds checks fail). */
  num64(o: number): number {
    this.need(o, 8);
    const lo = this.le ? this.dv.getUint32(o, true) : this.dv.getUint32(o + 4, false);
    const hi = this.le ? this.dv.getUint32(o + 4, true) : this.dv.getUint32(o, false);
    return hi >= 0x200000 ? Infinity : hi * TWO32 + lo;
  }
  /** 4-byte (`wide` false) or 8-byte field as a bigint (addresses may use all 64 bits). */
  word(o: number, wide: boolean): bigint {
    return wide ? this.u64(o) : BigInt(this.u32(o));
  }
  /** Same field as a number, `Infinity` when huge. */
  wordNum(o: number, wide: boolean): number {
    return wide ? this.num64(o) : this.u32(o);
  }
  slice(o: number, n: number): Uint8Array {
    this.need(o, n);
    return this.bytes.subarray(o, o + n);
  }
  /** NUL-terminated Latin-1 text of at most `max` characters starting at `o`. */
  cstr(o: number, max = 4096): string {
    this.need(o, 0);
    let end = o;
    const limit = Math.min(this.bytes.length, o + max);
    while (end < limit && this.bytes[end] !== 0) end++;
    return latin1(this.bytes.subarray(o, end));
  }
  /** UTF-16LE text of `chars` characters. */
  utf16(o: number, chars: number): string {
    this.need(o, chars * 2);
    let s = '';
    for (let i = 0; i < chars; i++) s += String.fromCharCode(this.dv.getUint16(o + i * 2, true));
    return s;
  }
}

export function latin1(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x4000) s += String.fromCharCode(...b.subarray(i, i + 0x4000));
  return s;
}

const BLOCK = 1 << 16;
const MAX_CACHED_BLOCKS = 96;

/**
 * Reads a LazyFile in 64 KiB blocks and keeps the latest ones, so the many small reads a parser
 * makes (one name here, one table entry there) cost a handful of Blob slices. A read past the end
 * is clamped, like `LazyFile.read`.
 */
export class Reader {
  readonly size: number;
  private readonly cache = new Map<number, Uint8Array>();
  constructor(readonly file: LazyFile) {
    this.size = file.size;
  }

  async read(off: number, len: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(off) || off < 0 || off >= this.size || !(len > 0)) {
      return new Uint8Array(0);
    }
    const end = Math.min(this.size, off + Math.floor(len));
    if (end - off > 4 * BLOCK) return this.file.read(off, end - off);
    const first = Math.floor(off / BLOCK);
    const last = Math.floor((end - 1) / BLOCK);
    const out = new Uint8Array(end - off);
    for (let b = first; b <= last; b++) {
      const block = await this.block(b);
      const from = Math.max(off, b * BLOCK);
      const to = Math.min(end, b * BLOCK + block.length);
      if (to > from) out.set(block.subarray(from - b * BLOCK, to - b * BLOCK), from - off);
    }
    return out;
  }

  async buf(off: number, len: number, le = true): Promise<Buf> {
    return new Buf(await this.read(off, len), le);
  }

  private async block(index: number): Promise<Uint8Array> {
    const hit = this.cache.get(index);
    if (hit) {
      this.cache.delete(index);
      this.cache.set(index, hit);
      return hit;
    }
    const data = await this.file.read(index * BLOCK, BLOCK);
    this.cache.set(index, data);
    if (this.cache.size > MAX_CACHED_BLOCKS) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    return data;
  }
}

/** How many bytes the analysis may still read just to measure entropy (shared by all regions). */
export interface Budget {
  left: number;
}
export const ENTROPY_BUDGET = 384 * 1024 * 1024;

const CHUNK = 1 << 20;

/** Shannon entropy (bits per byte) of a region, read in 1 MiB pieces; null when the budget is out. */
export async function regionEntropy(
  r: Reader,
  off: number,
  len: number,
  budget: Budget,
): Promise<number | null> {
  if (!Number.isSafeInteger(off) || off < 0 || off >= r.size) return null;
  const end = Math.min(r.size, off + len);
  if (end <= off) return null;
  if (end - off > budget.left) return null;
  budget.left -= end - off;
  const counts = new Uint32Array(256);
  for (let p = off; p < end; p += CHUNK) {
    const chunk = await r.file.read(p, Math.min(CHUNK, end - p));
    for (let i = 0; i < chunk.length; i++) counts[chunk[i]!]!++;
  }
  return shannon(counts, end - off);
}

export const hex = (n: number | bigint, pad = 0): string =>
  `0x${n.toString(16).padStart(pad, '0')}`;

/** "2024-01-15 10:30:00 UTC" for seconds since 1970 (null when it is not a date). */
export function utcDate(sec: number): string | null {
  const d = new Date(sec * 1000);
  if (!Number.isFinite(d.getTime())) return null;
  return `${d.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

/** Text safe to show in a table cell: control characters become a middle dot. */
export function visible(s: string, max = 200): string {
  const cut = s.length > max ? `${s.slice(0, max)}…` : s;
  let out = '';
  for (const ch of cut) {
    const c = ch.codePointAt(0)!;
    out += c < 0x20 || (c >= 0x7f && c <= 0x9f) ? '·' : ch;
  }
  return out;
}

export const entropyText = (e: number | null): string => (e === null ? '-' : e.toFixed(2));

/** Sanity cap shared by table parsers so a hostile count cannot make us loop for minutes. */
export const MAX_ROWS = 20_000;

/** Is the range [off, off+len) entirely inside a file of `size` bytes? */
export const inFile = (off: number, len: number, size: number): boolean =>
  Number.isFinite(off) && Number.isFinite(len) && off >= 0 && len >= 0 && off + len <= size;
