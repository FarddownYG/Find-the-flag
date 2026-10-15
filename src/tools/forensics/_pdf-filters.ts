/**
 * Stream filters of a PDF (ISO 32000-1, 7.4): FlateDecode (fflate), LZWDecode, ASCIIHexDecode,
 * ASCII85Decode, RunLengthDecode and the PNG / TIFF predictors of Flate and LZW. The image codecs
 * (DCT, JPX, CCITT, JBIG2) are not decoded: the chain stops there and hands back their bytes.
 *
 * Every filter takes an output limit (decompression bombs) and keeps what it decoded before an
 * error, so a damaged or truncated stream still gives its readable beginning.
 */
import { Inflate, Unzlib } from 'fflate';
import { concatBytes } from '../../lib/bytes';

export interface FilterSpec {
  /** Canonical name (FlateDecode, not Fl). */
  name: string;
  /** Integer entries of /DecodeParms (Predictor, Colors, BitsPerComponent, Columns, EarlyChange). */
  params: Record<string, number>;
}

export type ImageCodec = 'jpeg' | 'jpeg2000' | 'ccitt' | 'jbig2';

export interface DecodeOutcome {
  data: Uint8Array;
  /** The output was cut at the limit. */
  truncated: boolean;
  /** Filters undone, in order. */
  applied: string[];
  /** The filter the chain stopped at (an image codec, or one this tool cannot undo). */
  stoppedAt: string | null;
  /** Set when the chain stopped at an image codec: `data` is the encoded image. */
  image: ImageCodec | null;
  error: string | null;
}

const ABBREVIATIONS: Record<string, string> = {
  AHx: 'ASCIIHexDecode',
  A85: 'ASCII85Decode',
  LZW: 'LZWDecode',
  Fl: 'FlateDecode',
  RL: 'RunLengthDecode',
  CCF: 'CCITTFaxDecode',
  DCT: 'DCTDecode',
};

export const canonicalFilter = (n: string): string => ABBREVIATIONS[n] ?? n;

const IMAGE_CODECS: Record<string, ImageCodec> = {
  DCTDecode: 'jpeg',
  JPXDecode: 'jpeg2000',
  CCITTFaxDecode: 'ccitt',
  JBIG2Decode: 'jbig2',
};

export function decodeFilters(raw: Uint8Array, specs: FilterSpec[], limit: number): DecodeOutcome {
  let data = raw;
  const out: DecodeOutcome = {
    data,
    truncated: false,
    applied: [],
    stoppedAt: null,
    image: null,
    error: null,
  };
  for (const spec of specs) {
    const codec = IMAGE_CODECS[spec.name];
    if (codec) {
      out.stoppedAt = spec.name;
      out.image = codec;
      break;
    }
    if (spec.name === 'Crypt') continue; // handled by the decryption layer
    let step: { data: Uint8Array; truncated: boolean; error: string | null } | null = null;
    switch (spec.name) {
      case 'FlateDecode':
        step = withPredictor(inflateTolerant(data, limit), spec, limit);
        break;
      case 'LZWDecode':
        step = withPredictor(lzwDecode(data, spec.params.EarlyChange ?? 1, limit), spec, limit);
        break;
      case 'ASCIIHexDecode':
        step = asciiHexDecode(data);
        break;
      case 'ASCII85Decode':
        step = ascii85Decode(data);
        break;
      case 'RunLengthDecode':
        step = runLengthDecode(data, limit);
        break;
    }
    if (!step) {
      out.stoppedAt = spec.name;
      break;
    }
    data = step.data;
    out.applied.push(spec.name);
    if (step.truncated) out.truncated = true;
    if (step.error && !out.error) out.error = `${spec.name}: ${step.error}`;
  }
  out.data = data;
  return out;
}

// ---------- Flate ----------

interface Step {
  data: Uint8Array;
  truncated: boolean;
  error: string | null;
}

class LimitReached extends Error {}

/** Feed size: small enough that a bomb is noticed early, large enough to be fast. */
const CHUNK = 4096;

interface Sink {
  push(data: Uint8Array, final?: boolean): void;
}

const zlibHeaderOk = (b: Uint8Array): boolean =>
  b.length >= 2 &&
  (b[0]! & 0x0f) === 8 &&
  ((b[0]! << 8) | b[1]!) % 31 === 0 &&
  (b[1]! & 0x20) === 0;

/**
 * Inflate with a limit, keeping the output produced before an error. fflate delivers the output
 * of a push only when that push succeeds, so after a failure the damaged chunk is fed again one
 * byte at a time to recover every byte before the actual error position.
 */
function inflateRun(
  data: Uint8Array,
  make: (cb: (chunk: Uint8Array) => void) => Sink,
  limit: number,
): Step {
  const parts: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  const collect = (chunk: Uint8Array) => {
    if (total + chunk.length > limit) {
      const room = Math.max(0, limit - total);
      if (room > 0) parts.push(chunk.subarray(0, room));
      total += room;
      truncated = true;
      throw new LimitReached();
    }
    parts.push(chunk);
    total += chunk.length;
  };
  let failedAt = -1;
  let error: string | null = null;
  try {
    const stream = make(collect);
    for (let i = 0; i < data.length; i += CHUNK) {
      const end = Math.min(data.length, i + CHUNK);
      try {
        stream.push(data.subarray(i, end), end >= data.length);
      } catch (e) {
        if (e instanceof LimitReached) throw e;
        failedAt = i;
        error = e instanceof Error ? e.message : String(e);
        break;
      }
    }
  } catch (e) {
    if (!(e instanceof LimitReached)) throw e;
  }
  if (failedAt >= 0 && !truncated) {
    // Start over to the failing chunk, then byte by byte.
    parts.length = 0;
    total = 0;
    try {
      const stream = make(collect);
      const head = Math.min(data.length, Math.max(failedAt, 2));
      if (head > 0) stream.push(data.subarray(0, head));
      const stop = Math.min(data.length, failedAt + CHUNK);
      for (let i = head; i < stop; i++) stream.push(data.subarray(i, i + 1));
    } catch (e) {
      if (!(e instanceof LimitReached) && !(e instanceof Error)) throw e;
    }
  }
  return { data: concatBytes(...parts), truncated, error };
}

export function inflateTolerant(data: Uint8Array, limit: number): Step {
  if (data.length === 0) return { data, truncated: false, error: null };
  const asZlib = (cb: (c: Uint8Array) => void): Sink => new Unzlib((c) => cb(c));
  const asRaw = (cb: (c: Uint8Array) => void): Sink => new Inflate((c) => cb(c));
  const first = zlibHeaderOk(data) ? inflateRun(data, asZlib, limit) : null;
  if (first && (first.data.length > 0 || first.error === null)) return first;
  // No valid zlib header (or nothing came out of it): some writers store a raw deflate stream,
  // others garble the two header bytes.
  const raw = inflateRun(data, asRaw, limit);
  if (raw.data.length > 0 || raw.error === null) return raw;
  const skipped = data.length > 2 ? inflateRun(data.subarray(2), asRaw, limit) : null;
  if (skipped && skipped.data.length > 0) return skipped;
  return first ?? raw;
}

// ---------- LZW (7.4.4.2) ----------

export function lzwDecode(data: Uint8Array, earlyChange: number, limit: number): Step {
  const prefix = new Int32Array(4096).fill(-1);
  const suffix = new Uint8Array(4096);
  const head = new Uint8Array(4096); // first byte of each string
  const length = new Uint16Array(4096);
  for (let i = 0; i < 256; i++) {
    suffix[i] = i;
    head[i] = i;
    length[i] = 1;
  }
  let out = new Uint8Array(Math.min(Math.max(data.length * 4, 1024), limit));
  let n = 0;
  let truncated = false;
  let error: string | null = null;
  const early = earlyChange === 0 ? 0 : 1;
  let codeLen = 9;
  let next = 258;
  let prev = -1;
  let bitBuf = 0;
  let bitCount = 0;
  let pos = 0;

  /** Write the string of a code; false when the limit is reached. */
  const emit = (code: number): boolean => {
    const len = length[code]!;
    if (n + len > limit) {
      truncated = true;
      return false;
    }
    if (n + len > out.length) {
      const bigger = new Uint8Array(Math.min(limit, Math.max(out.length * 2, n + len)));
      bigger.set(out.subarray(0, n));
      out = bigger;
    }
    let c = code;
    for (let i = len - 1; i >= 0; i--) {
      out[n + i] = suffix[c]!;
      c = prefix[c]!;
    }
    n += len;
    return true;
  };
  const add = (p: number, byte: number): void => {
    if (next >= 4096) return;
    prefix[next] = p;
    suffix[next] = byte;
    head[next] = head[p]!;
    length[next] = length[p]! + 1;
    next++;
  };

  for (;;) {
    while (bitCount < codeLen && pos < data.length) {
      bitBuf = ((bitBuf << 8) | data[pos++]!) >>> 0;
      bitCount += 8;
    }
    if (bitCount < codeLen) break; // out of data without an end-of-data code
    bitCount -= codeLen;
    const code = (bitBuf >>> bitCount) & ((1 << codeLen) - 1);
    bitBuf &= (1 << bitCount) - 1;
    if (code === 257) break;
    if (code === 256) {
      codeLen = 9;
      next = 258;
      prev = -1;
      continue;
    }
    if (prev < 0) {
      if (code > 255) {
        error = 'invalid first code after a clear';
        break;
      }
      if (!emit(code)) break;
      prev = code;
      continue;
    }
    if (code < next) {
      add(prev, head[code]!);
    } else if (code === next) {
      add(prev, head[prev]!); // the previous string followed by its own first byte
    } else {
      error = `invalid code ${code}`;
      break;
    }
    if (!emit(code)) break;
    prev = code;
    if (next + early >= 1 << codeLen && codeLen < 12) codeLen++;
  }
  return { data: out.slice(0, n), truncated, error };
}

// ---------- ASCIIHex, ASCII85, RunLength ----------

export function asciiHexDecode(data: Uint8Array): Step {
  const out: number[] = [];
  let hi = -1;
  let error: string | null = null;
  for (const c of data) {
    if (c === 0x3e) break;
    const v = hexValue(c);
    if (v < 0) {
      if (!(c === 0 || c === 9 || c === 10 || c === 12 || c === 13 || c === 32)) {
        error ??= 'a character that is not a hex digit';
      }
      continue;
    }
    if (hi < 0) hi = v;
    else {
      out.push(hi * 16 + v);
      hi = -1;
    }
  }
  if (hi >= 0) out.push(hi * 16);
  return { data: Uint8Array.from(out), truncated: false, error };
}

function hexValue(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10;
  if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10;
  return -1;
}

export function ascii85Decode(data: Uint8Array): Step {
  const out: number[] = [];
  let i = 0;
  let error: string | null = null;
  while (i < data.length && isWhite(data[i]!)) i++;
  if (data[i] === 0x3c && data[i + 1] === 0x7e) i += 2;
  const group: number[] = [];
  const flush = (count: number) => {
    // Pad a partial group with 'u' (84) and keep count - 1 bytes.
    let value = 0;
    for (let k = 0; k < 5; k++) value = value * 85 + (k < count ? group[k]! : 84);
    value >>>= 0;
    const bytes = [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
    for (let k = 0; k < count - 1; k++) out.push(bytes[k]!);
  };
  for (; i < data.length; i++) {
    const c = data[i]!;
    if (isWhite(c)) continue;
    if (c === 0x7e) break; // ~>
    if (c === 0x7a && group.length === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    if (c < 0x21 || c > 0x75) {
      error ??= 'a character outside ! to u';
      continue;
    }
    group.push(c - 33);
    if (group.length === 5) {
      flush(5);
      group.length = 0;
    }
  }
  if (group.length === 1) error ??= 'a lone character at the end';
  else if (group.length > 1) flush(group.length);
  return { data: Uint8Array.from(out), truncated: false, error };
}

const isWhite = (c: number) => c === 0 || c === 9 || c === 10 || c === 12 || c === 13 || c === 32;

export function runLengthDecode(data: Uint8Array, limit: number): Step {
  const parts: number[] = [];
  let truncated = false;
  let i = 0;
  while (i < data.length) {
    const len = data[i++]!;
    if (len === 128) break;
    if (len < 128) {
      const n = Math.min(len + 1, data.length - i);
      for (let k = 0; k < n; k++) parts.push(data[i + k]!);
      i += n;
    } else {
      if (i >= data.length) break;
      const b = data[i++]!;
      for (let k = 0; k < 257 - len; k++) parts.push(b);
    }
    if (parts.length > limit) {
      parts.length = limit;
      truncated = true;
      break;
    }
  }
  return { data: Uint8Array.from(parts), truncated, error: null };
}

// ---------- predictors (7.4.4.4) ----------

function withPredictor(step: Step, spec: FilterSpec, limit: number): Step {
  const predictor = spec.params.Predictor ?? 1;
  if (predictor < 2 || step.data.length === 0) return step;
  try {
    const data = applyPredictor(step.data, spec.params, limit);
    return { ...step, data };
  } catch (e) {
    return { ...step, error: step.error ?? (e instanceof Error ? e.message : String(e)) };
  }
}

export function applyPredictor(
  data: Uint8Array,
  params: Record<string, number>,
  limit: number,
): Uint8Array {
  const predictor = params.Predictor ?? 1;
  const colors = params.Colors ?? 1;
  const bpc = params.BitsPerComponent ?? 8;
  const columns = params.Columns ?? 1;
  if (
    !Number.isInteger(colors) ||
    colors < 1 ||
    colors > 32 ||
    ![1, 2, 4, 8, 16].includes(bpc) ||
    !Number.isInteger(columns) ||
    columns < 1 ||
    columns > 1 << 24
  ) {
    throw new Error('invalid predictor parameters');
  }
  const bitsPerRow = colors * bpc * columns;
  const rowBytes = Math.ceil(bitsPerRow / 8);
  if (rowBytes > 1 << 26) throw new Error('invalid predictor parameters');
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  if (predictor >= 10) return pngPredictor(data, rowBytes, bpp, limit);
  if (predictor === 2) return tiffPredictor(data, rowBytes, colors, bpc, columns);
  throw new Error(`unknown predictor ${predictor}`);
}

function pngPredictor(data: Uint8Array, rowBytes: number, bpp: number, limit: number): Uint8Array {
  const stride = rowBytes + 1;
  const rows = Math.ceil(data.length / stride);
  const size = Math.min(rows * rowBytes, limit);
  const out = new Uint8Array(size);
  for (let r = 0; r < rows; r++) {
    const src = r * stride;
    const dst = r * rowBytes;
    if (dst >= size) break;
    const tag = data[src]!;
    const avail = Math.min(rowBytes, data.length - src - 1, size - dst);
    const up = r > 0 ? dst - rowBytes : -1;
    for (let i = 0; i < avail; i++) {
      const x = data[src + 1 + i]!;
      const left = i >= bpp ? out[dst + i - bpp]! : 0;
      const above = up >= 0 ? out[up + i]! : 0;
      let v: number;
      switch (tag) {
        case 1:
          v = x + left;
          break;
        case 2:
          v = x + above;
          break;
        case 3:
          v = x + ((left + above) >> 1);
          break;
        case 4: {
          const upLeft = up >= 0 && i >= bpp ? out[up + i - bpp]! : 0;
          const p = left + above - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - above);
          const pc = Math.abs(p - upLeft);
          v = x + (pa <= pb && pa <= pc ? left : pb <= pc ? above : upLeft);
          break;
        }
        default:
          v = x;
      }
      out[dst + i] = v & 0xff;
    }
  }
  return out;
}

function tiffPredictor(
  data: Uint8Array,
  rowBytes: number,
  colors: number,
  bpc: number,
  columns: number,
): Uint8Array {
  const out = Uint8Array.from(data);
  const rows = Math.ceil(out.length / rowBytes);
  for (let r = 0; r < rows; r++) {
    const base = r * rowBytes;
    const len = Math.min(rowBytes, out.length - base);
    if (bpc === 8) {
      for (let i = colors; i < len; i++)
        out[base + i] = (out[base + i]! + out[base + i - colors]!) & 255;
    } else if (bpc === 16) {
      for (let i = colors * 2; i + 1 < len; i += 2) {
        const a = (out[base + i]! << 8) | out[base + i + 1]!;
        const b = (out[base + i - colors * 2]! << 8) | out[base + i - colors * 2 + 1]!;
        const v = (a + b) & 0xffff;
        out[base + i] = v >> 8;
        out[base + i + 1] = v & 255;
      }
    } else {
      const mask = (1 << bpc) - 1;
      const samples = Math.min(columns * colors, Math.floor((len * 8) / bpc));
      const read = (s: number) => {
        const bit = s * bpc;
        return (out[base + (bit >> 3)]! >> (8 - bpc - (bit & 7))) & mask;
      };
      for (let s = colors; s < samples; s++) {
        const v = (read(s) + read(s - colors)) & mask;
        const bit = s * bpc;
        const shift = 8 - bpc - (bit & 7);
        const idx = base + (bit >> 3);
        out[idx] = (out[idx]! & ~(mask << shift)) | (v << shift);
      }
    }
  }
  return out;
}
