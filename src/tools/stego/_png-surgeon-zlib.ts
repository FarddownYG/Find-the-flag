/**
 * zlib side of the PNG chunk surgeon: what the image data must inflate to (rows, Adam7 passes),
 * a streaming check of an IDAT sequence (fflate Inflate, row filter bytes, size, Adler-32),
 * where it breaks, zlib header repair, and the image size the inflated data really gives.
 *
 * fflate is lenient (it does not verify Huffman trees nor the Adler-32), so a wrong IDAT order
 * often inflates for a while without an error. Every PNG row starts with a filter type 0-4,
 * which is checked on the fly: garbage fails that test within a few rows. Only the Adler-32
 * (checked by the caller) proves that a whole order is right.
 */
import { Unzlib } from 'fflate';
import { concatBytes } from '../../lib/bytes';
import { type Ihdr, rowSize, validDepthForColor } from './_png';

/** Adam7 passes: x0, y0, dx, dy. */
const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
] as const;

export interface Pass {
  /** Bytes per row including the filter byte. */
  rowBytes: number;
  rows: number;
}

export interface Layout {
  passes: Pass[];
  /** Exact inflated size for this IHDR. */
  total: number;
  interlaced: boolean;
  /** Non-interlaced: bytes per row, so extra rows (a reduced height) can still be checked. */
  rowBytes: number;
}

export function usableIhdr(h: Ihdr): boolean {
  return (
    validDepthForColor(h.bitDepth, h.colorType) &&
    h.width > 0 &&
    h.height > 0 &&
    h.width <= 0x7fffffff &&
    (h.interlace === 0 || h.interlace === 1)
  );
}

const rowBytesFor = (width: number, h: Ihdr) => rowSize({ ...h, width }) ?? 0;

/** Row structure of the inflated data, or null when the IHDR fields are not usable. */
export function layoutOf(h: Ihdr): Layout | null {
  if (!usableIhdr(h)) return null;
  const passes: Pass[] = [];
  if (h.interlace === 1) {
    for (const [x0, y0, dx, dy] of ADAM7) {
      const w = Math.ceil((h.width - x0) / dx);
      const rows = Math.ceil((h.height - y0) / dy);
      if (w > 0 && rows > 0) passes.push({ rowBytes: rowBytesFor(w, h), rows });
    }
  } else {
    passes.push({ rowBytes: rowBytesFor(h.width, h), rows: h.height });
  }
  const total = passes.reduce((s, p) => s + p.rowBytes * p.rows, 0);
  return { passes, total, interlaced: h.interlace === 1, rowBytes: rowBytesFor(h.width, h) };
}

/** Height that makes the layout inflate to exactly `size` bytes, or null. */
export function heightForSize(h: Ihdr, size: number): number | null {
  if (!usableIhdr({ ...h, height: 1 })) return null;
  if (h.interlace !== 1) {
    const rb = rowBytesFor(h.width, h);
    return size > 0 && size % rb === 0 && size / rb <= 0x7fffffff ? size / rb : null;
  }
  // Adam7: the size grows with the height; binary search.
  let lo = 1;
  let hi = 1;
  while (layoutOf({ ...h, height: hi })!.total < size) {
    if (hi > 1 << 30) return null;
    hi *= 2;
  }
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (layoutOf({ ...h, height: mid })!.total < size) lo = mid + 1;
    else hi = mid;
  }
  return layoutOf({ ...h, height: lo })!.total === size ? lo : null;
}

/** Exact inflated size for this IHDR as a decimal string (it can exceed 2^53). */
export function exactTotal(layout: Layout): string {
  return layout.passes.reduce((s, p) => s + BigInt(p.rowBytes) * BigInt(p.rows), 0n).toString();
}

/** Every row of `data` (exactly the layout's size) starts with a filter type 0-4. */
export function filtersOk(layout: Layout, data: Uint8Array): boolean {
  if (data.length !== layout.total) return false;
  let o = 0;
  for (const p of layout.passes) {
    for (let r = 0; r < p.rows; r++, o += p.rowBytes) if (data[o]! > 4) return false;
  }
  return true;
}

/** Width that makes the layout inflate to exactly `size` bytes at height h.height, or null. */
function widthForSize(h: Ihdr, size: number): number | null {
  if (!usableIhdr({ ...h, width: 1 })) return null;
  const total = (width: number) => layoutOf({ ...h, width })!.total;
  // The size grows with the width: binary search for the first width that reaches `size`.
  let hi = 1;
  while (total(hi) < size) {
    if (hi >= 1 << 29) return null;
    hi *= 2;
  }
  let lo = 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (total(mid) < size) lo = mid + 1;
    else hi = mid;
  }
  if (total(lo) !== size) return null;
  // Sub-byte depths: several widths give the same row size; take the one nearest the stored one.
  let best = lo;
  for (let w = lo + 1; total(w) === size; w++) {
    if (Math.abs(w - h.width) < Math.abs(best - h.width)) best = w;
  }
  return best;
}

/**
 * The image size the inflated data really gives, when the IHDR one does not fit (an edited
 * width or height whose CRC was recomputed). Only one dimension changes, the other is kept as
 * stored, and every row must start with a valid filter type. Null when nothing fits.
 */
export function fitSize(h: Ihdr, data: Uint8Array): Ihdr | null {
  const tries: Ihdr[] = [];
  const height = heightForSize(h, data.length);
  if (height !== null) tries.push({ ...h, height });
  const width = widthForSize(h, data.length);
  if (width !== null) tries.push({ ...h, width });
  for (const t of tries) {
    const layout = layoutOf(t);
    if (layout && filtersOk(layout, data)) return t;
  }
  return null;
}

// ---------------------------------------------------------------- zlib header

export interface ZlibHeader {
  cmf: number;
  flg: number;
  valid: boolean;
  /** Compression method (8 = deflate). */
  cm: number;
  /** log2(window) - 8. */
  cinfo: number;
  fdict: boolean;
  /** 0 fastest, 1 fast, 2 default, 3 maximum (informational only). */
  flevel: number;
  fcheckOk: boolean;
}

export function zlibHeader(cmf: number, flg: number): ZlibHeader {
  const cm = cmf & 15;
  const cinfo = cmf >> 4;
  const fcheckOk = ((cmf << 8) | flg) % 31 === 0;
  const fdict = (flg & 0x20) !== 0;
  return {
    cmf,
    flg,
    cm,
    cinfo,
    fdict,
    flevel: flg >> 6,
    fcheckOk,
    valid: cm === 8 && cinfo <= 7 && fcheckOk && !fdict,
  };
}

export const headerOk = (b: Uint8Array) => b.length >= 2 && zlibHeader(b[0]!, b[1]!).valid;

/**
 * Replacement header for a damaged one: keep what is still consistent (CMF with a fixed
 * FCHECK, or 78 with the stored FLG), else the standard 78 9C / 78 DA / 78 5E / 78 01.
 * FLEVEL is informational, so every candidate inflates the same; the first is the best guess.
 */
export function headerCandidates(cmf: number, flg: number): [number, number][] {
  const out: [number, number][] = [];
  const add = (c: number, f: number) => {
    if (zlibHeader(c, f).valid && !out.some(([a, b]) => a === c && b === f)) out.push([c, f]);
  };
  if ((cmf & 15) === 8 && cmf >> 4 <= 7) {
    const level = flg & 0xc0;
    add(cmf, level | ((31 - (((cmf << 8) | level) % 31)) % 31));
  }
  add(0x78, flg);
  for (const f of [0x9c, 0xda, 0x5e, 0x01]) add(0x78, f);
  return out;
}

// ---------------------------------------------------------------- Adler-32

export function adler32Update(state: [number, number], data: Uint8Array): void {
  let [a, b] = state;
  for (let i = 0; i < data.length;) {
    const end = Math.min(data.length, i + 3800);
    for (; i < end; i++) {
      a += data[i]!;
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  state[0] = a;
  state[1] = b;
}

export const adlerValue = (s: [number, number]) => ((s[1] << 16) | s[0]) >>> 0;

// ---------------------------------------------------------------- stream check

export interface StreamOptions {
  /** Row structure to check the filter bytes against (null: inflate only). */
  layout: Layout | null;
  /** The whole sequence is given: finish the stream and check its size and Adler-32. */
  final: boolean;
  /** Keep the inflated bytes (up to this many). */
  capture?: number;
  /** Fail (as an overflow) past this many inflated bytes (default 1 GiB, or the Adam7 size). */
  maxBytes?: number;
  /**
   * Push the pieces as one buffer: much faster (fflate reallocates its window on every push),
   * but a failure no longer says which piece it was in (the order search does not need it).
   */
  merge?: boolean;
}

export interface StreamFailure {
  /**
   * header: not a zlib header · inflate: fflate error · filter: a row starts with a byte > 4 ·
   * overflow: more data than the Adam7 passes hold · rows: not a whole number of rows ·
   * short: the stream ends before the image does.
   */
  kind: 'header' | 'inflate' | 'filter' | 'overflow' | 'rows' | 'short';
  /** Index (in the given sequence) of the piece being processed when it failed. */
  piece: number;
  /** fflate error code (0 EOF, 1 block type, 2 literal/length, 3 distance, 6 header). */
  code?: number;
  /** Filter failure: row (within its pass), pass, and the byte found. */
  row?: number;
  pass?: number;
  value?: number;
}

export interface StreamResult {
  ok: boolean;
  failure: StreamFailure | null;
  /** Inflated bytes produced. */
  produced: number;
  /** Bytes before the first broken row (what can still be shown). */
  goodBytes: number;
  adlerStored: number | null;
  adlerComputed: number | null;
  data: Uint8Array | null;
}

/** Largest inflated size accepted for a non-interlaced image (1 GiB). */
const MAX_RAW = 1 << 30;

function errorCode(e: unknown): number | undefined {
  if (e instanceof Error && 'code' in e && typeof e.code === 'number') return e.code;
  return undefined;
}

/**
 * Inflate a sequence of IDAT payloads and check it as PNG image data. Stops at the first
 * error. With `final: false` it only says whether this prefix can still be the start of a
 * valid stream (the order search). A non-interlaced stream may hold any whole number of rows
 * (the real height is deduced from it); an Adam7 stream must fill the passes exactly.
 */
export function checkStream(given: Uint8Array[], opts: StreamOptions): StreamResult {
  const pieces = opts.merge && given.length > 1 ? [concatBytes(...given)] : given;
  const layout = opts.layout;
  let produced = 0;
  let badRowAt = -1;
  let failure: StreamFailure | null = null;
  let current = 0;
  const parts: Uint8Array[] = [];
  let captured = 0;
  const adler: [number, number] = [1, 0];
  // Row walk: offset of the next row start, its pass and its row within the pass.
  let passIdx = 0;
  let rowInPass = 0;
  let nextRow = 0;
  const limit = Math.min(opts.maxBytes ?? MAX_RAW, layout?.interlaced ? layout.total : MAX_RAW);

  const onData = (chunk: Uint8Array) => {
    if (failure) return;
    const start = produced;
    const end = produced + chunk.length;
    if (opts.capture && captured < opts.capture) {
      const take = chunk.subarray(0, opts.capture - captured);
      parts.push(take.slice());
      captured += take.length;
    }
    if (opts.final) adler32Update(adler, chunk);
    if (layout) {
      while (nextRow < end && nextRow < limit) {
        const v = chunk[nextRow - start]!;
        const pass = layout.passes[passIdx]!;
        if (v > 4) {
          failure = { kind: 'filter', piece: current, row: rowInPass, pass: passIdx, value: v };
          badRowAt = nextRow;
          break;
        }
        nextRow += pass.rowBytes;
        rowInPass++;
        if (layout.interlaced && rowInPass >= pass.rows) {
          passIdx++;
          rowInPass = 0;
        }
      }
    }
    if (!failure && end > limit) failure = { kind: 'overflow', piece: current };
    produced = end;
  };

  const z = new Unzlib(onData);
  try {
    for (current = 0; current < pieces.length && !failure; current++) {
      z.push(pieces[current]!, opts.final && current === pieces.length - 1);
    }
  } catch (e) {
    const code = errorCode(e);
    failure ??= {
      kind: code === 6 ? 'header' : 'inflate',
      piece: Math.min(current, pieces.length - 1),
      code,
    };
  }
  if (opts.final && !failure) {
    if (!produced) failure = { kind: 'short', piece: Math.max(0, pieces.length - 1) };
    else if (layout && layout.interlaced && produced < layout.total)
      failure = { kind: 'short', piece: pieces.length - 1 };
    else if (layout && !layout.interlaced && produced % layout.rowBytes !== 0)
      failure = { kind: 'rows', piece: pieces.length - 1 };
  }
  const result: StreamResult = {
    ok: failure === null,
    failure,
    produced,
    goodBytes: badRowAt >= 0 ? badRowAt : Math.min(produced, limit),
    adlerStored: opts.final && !failure ? lastFour(pieces) : null,
    adlerComputed: opts.final && !failure ? adlerValue(adler) : null,
    data: null,
  };
  if (opts.capture) {
    const data = new Uint8Array(captured);
    let o = 0;
    for (const p of parts) {
      data.set(p, o);
      o += p.length;
    }
    result.data = data;
  }
  return result;
}

/** The last 4 bytes of the concatenated pieces, big-endian (the stored Adler-32). */
function lastFour(pieces: Uint8Array[]): number | null {
  const tail: number[] = [];
  for (let i = pieces.length - 1; i >= 0 && tail.length < 4; i--) {
    const p = pieces[i]!;
    for (let j = p.length - 1; j >= 0 && tail.length < 4; j--) tail.unshift(p[j]!);
  }
  if (tail.length < 4) return null;
  return ((tail[0]! << 24) | (tail[1]! << 16) | (tail[2]! << 8) | tail[3]!) >>> 0;
}

/**
 * Narrow down where inflating breaks: replay the stream and push the failing piece in small
 * slices. Returns the offset (within that piece) of the slice where the error is raised.
 */
export function locateFailure(pieces: Uint8Array[], piece: number, step = 16): number | null {
  const z = new Unzlib(() => undefined);
  try {
    for (let i = 0; i < piece; i++) z.push(pieces[i]!, false);
  } catch {
    return 0;
  }
  const p = pieces[piece];
  if (!p) return null;
  for (let o = 0; o < p.length; o += step) {
    try {
      z.push(p.subarray(o, o + step), false);
    } catch {
      return o;
    }
  }
  return null;
}
