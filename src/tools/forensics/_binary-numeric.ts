/**
 * Numeric view of the Binary analyzer: read bytes as a typed array (int8 … float64, either
 * byte order), optionally reshaped into rows × columns, with statistics and a grayscale
 * preview. An ENVI .hdr next to a raw raster (samples, lines, bands, data type, byte order,
 * header offset, interleave) fills all of that in.
 */
import { ToolError } from '../../core/errors';
import type { FileInput, LazyFile, Output, RgbaImage } from '../../core/types';
import { toolT } from '../../i18n/tool-text';
import { utf8Decode } from '../../lib/bytes';
import { hex, parseSize, readRange } from './_binary-stream';

const T = toolT('binary-analyzer');

export const DTYPES = {
  int8: 1,
  uint8: 1,
  int16: 2,
  uint16: 2,
  int32: 4,
  uint32: 4,
  int64: 8,
  uint64: 8,
  float32: 4,
  float64: 8,
} as const;
export type DType = keyof typeof DTYPES;
const DTYPE_LIST = Object.keys(DTYPES).join(', ');

/** Values read at most (stats and preview); the table shows far fewer. */
export const MAX_VALUES = 4 << 20;
const TABLE_ROWS = 1000;
const TEXT_VALUES = 4096;
const PREVIEW_MAX = 1024;

export interface Decoded {
  /** Every value as a double (64-bit integers may lose precision here). */
  values: Float64Array;
  /** Exact 64-bit integers, for display. */
  big?: BigInt64Array | BigUint64Array;
}

/** Decode whole elements of `b`; a partial element at the end is ignored. */
export function decodeValues(b: Uint8Array, dtype: DType, little: boolean): Decoded {
  const size = DTYPES[dtype];
  const n = Math.floor(b.length / size);
  const v = new DataView(b.buffer, b.byteOffset, n * size);
  const out = new Float64Array(n);
  switch (dtype) {
    case 'int8':
      for (let i = 0; i < n; i++) out[i] = v.getInt8(i);
      break;
    case 'uint8':
      for (let i = 0; i < n; i++) out[i] = v.getUint8(i);
      break;
    case 'int16':
      for (let i = 0; i < n; i++) out[i] = v.getInt16(i * 2, little);
      break;
    case 'uint16':
      for (let i = 0; i < n; i++) out[i] = v.getUint16(i * 2, little);
      break;
    case 'int32':
      for (let i = 0; i < n; i++) out[i] = v.getInt32(i * 4, little);
      break;
    case 'uint32':
      for (let i = 0; i < n; i++) out[i] = v.getUint32(i * 4, little);
      break;
    case 'float32':
      for (let i = 0; i < n; i++) out[i] = v.getFloat32(i * 4, little);
      break;
    case 'float64':
      for (let i = 0; i < n; i++) out[i] = v.getFloat64(i * 8, little);
      break;
    case 'int64': {
      const big = new BigInt64Array(n);
      for (let i = 0; i < n; i++) {
        big[i] = v.getBigInt64(i * 8, little);
        out[i] = Number(big[i]);
      }
      return { values: out, big };
    }
    case 'uint64': {
      const big = new BigUint64Array(n);
      for (let i = 0; i < n; i++) {
        big[i] = v.getBigUint64(i * 8, little);
        out[i] = Number(big[i]);
      }
      return { values: out, big };
    }
  }
  return { values: out };
}

export interface Stats {
  count: number;
  finite: number;
  min: number;
  max: number;
  mean: number;
  std: number;
  nan: number;
  posInf: number;
  negInf: number;
  zeros: number;
}

/**
 * Statistics over the finite values. Two passes on values scaled by a power of two (exact):
 * no square overflows near Number.MAX_VALUE, and a large mean with a tiny spread keeps its
 * standard deviation (a one-pass sum of squares cancels it out).
 */
export function stats(values: Float64Array): Stats {
  let min = Infinity;
  let max = -Infinity;
  let finite = 0;
  let nan = 0;
  let posInf = 0;
  let negInf = 0;
  let zeros = 0;
  for (const x of values) {
    if (Number.isNaN(x)) nan++;
    else if (x === Infinity) posInf++;
    else if (x === -Infinity) negInf++;
    else {
      finite++;
      if (x < min) min = x;
      if (x > max) max = x;
      if (x === 0) zeros++;
    }
  }
  let mean = NaN;
  let std = NaN;
  if (finite) {
    const top = Math.max(Math.abs(min), Math.abs(max));
    const scale = top > 0 ? 2 ** Math.min(1023, Math.max(-1022, Math.ceil(Math.log2(top)))) : 1;
    let sum = 0;
    for (const x of values) if (Number.isFinite(x)) sum += x / scale;
    const m = sum / finite;
    let d1 = 0;
    let d2 = 0;
    for (const x of values) {
      if (!Number.isFinite(x)) continue;
      const d = x / scale - m;
      d1 += d;
      d2 += d * d;
    }
    mean = (m + d1 / finite) * scale;
    std = Math.sqrt(Math.max(0, (d2 - (d1 * d1) / finite) / finite)) * scale;
    // Rounding can push the mean a hair outside [min, max] (e.g. a constant array).
    mean = Math.min(max, Math.max(min, mean));
  }
  return {
    count: values.length,
    finite,
    min: finite ? min : NaN,
    max: finite ? max : NaN,
    mean,
    std,
    nan,
    posInf,
    negInf,
    zeros,
  };
}

/** Shortest text that reads back as the same value for this data type (-0 keeps its sign). */
export function formatValue(x: number, dtype: DType): string {
  if (!Number.isFinite(x)) return String(x);
  if (dtype !== 'float32' && dtype !== 'float64') return String(x);
  if (Object.is(x, -0)) return '-0';
  if (dtype === 'float64') return String(x);
  for (let p = 1; p <= 9; p++) {
    const s = x.toPrecision(p);
    if (Math.fround(parseFloat(s)) === x) return String(parseFloat(s));
  }
  return String(x);
}

/** A derived statistic (mean, standard deviation): 12 significant digits. */
const fmtStat = (x: number) => (Number.isFinite(x) ? String(Number(x.toPrecision(12))) : String(x));

/** Exact smallest / largest 64-bit integer of the first `n` values. */
function bigRange(big: BigInt64Array | BigUint64Array, n: number): [string, string] | null {
  if (n === 0) return null;
  let lo = big[0]!;
  let hi = big[0]!;
  for (let i = 1; i < n; i++) {
    const v = big[i]!;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return [String(lo), String(hi)];
}

const NAN_RGB = [255, 0, 255] as const;
const INF_RGB = [229, 160, 70] as const;

/** Min-max normalised grayscale of a rows × cols array; NaN magenta, ±Inf amber. */
export function preview(values: Float64Array, rows: number, cols: number, s: Stats): RgbaImage {
  const step = Math.max(1, Math.ceil(Math.max(rows, cols) / PREVIEW_MAX));
  const w = Math.ceil(cols / step);
  const h = Math.ceil(rows / step);
  const data = new Uint8ClampedArray(w * h * 4);
  const span = s.max - s.min;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * step * cols + x * step;
      const v = i < values.length ? values[i]! : NaN;
      const o = (y * w + x) * 4;
      let rgb: readonly [number, number, number];
      if (Number.isNaN(v)) rgb = i < values.length ? NAN_RGB : [0, 0, 0];
      else if (!Number.isFinite(v)) rgb = INF_RGB;
      else {
        const g = span > 0 ? Math.round(((v - s.min) / span) * 255) : 128;
        rgb = [g, g, g];
      }
      data[o] = rgb[0];
      data[o + 1] = rgb[1];
      data[o + 2] = rgb[2];
      data[o + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

/** rows × cols factorisations of n closest to a square (both sides at least 8). */
export function shapes(n: number, max = 5): [number, number][] {
  const out: [number, number][] = [];
  for (let r = Math.floor(Math.sqrt(n)); r >= 8 && out.length < max; r--) {
    if (n % r === 0 && n / r >= 8) out.push([r, n / r]);
  }
  return out;
}

// ---------------------------------------------------------------- ENVI

export interface Envi {
  samples: number;
  lines: number;
  bands: number;
  dataType: number;
  dtype: DType;
  little: boolean;
  offset: number;
  interleave: 'bsq' | 'bil' | 'bip';
  description: string;
  bandNames: string[];
}

const ENVI_TYPES: Record<number, DType> = {
  1: 'uint8',
  2: 'int16',
  3: 'int32',
  4: 'float32',
  5: 'float64',
  12: 'uint16',
  13: 'uint32',
  14: 'int64',
  15: 'uint64',
};

/** Parse an ENVI header ("ENVI" then key = value lines; {…} values may span lines). */
export function parseEnvi(text: string): Envi {
  const body = text.replace(/^\uFEFF/, '');
  if (!/^\s*ENVI\b/.test(body)) throw new ToolError(T('error.enviNotHeader'));
  const fields = new Map<string, string>();
  const re = /^\s*([A-Za-z][\w .()/-]*?)\s*=\s*(\{[\s\S]*?\}|[^\r\n]*)/gm;
  for (const m of body.matchAll(re)) fields.set(m[1]!.toLowerCase(), m[2]!.trim());
  const num = (key: string, def?: number) => {
    const v = fields.get(key);
    if (v === undefined) {
      if (def !== undefined) return def;
      throw new ToolError(T('error.enviMissing', { field: key }));
    }
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0)
      throw new ToolError(T('error.enviField', { field: key, value: v }));
    return n;
  };
  const samples = num('samples');
  const lines = num('lines');
  const bands = num('bands', 1);
  const dataType = num('data type');
  const dtype = ENVI_TYPES[dataType];
  if (!dtype) throw new ToolError(T('error.enviType', { type: dataType }));
  const il = (fields.get('interleave') ?? 'bsq').toLowerCase();
  if (il !== 'bsq' && il !== 'bil' && il !== 'bip')
    throw new ToolError(T('error.enviField', { field: 'interleave', value: il }));
  const list = (v: string | undefined) =>
    v
      ? v
          .replace(/^\{|\}$/g, '')
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean)
      : [];
  if (samples === 0 || lines === 0 || bands === 0)
    throw new ToolError(T('error.enviField', { field: 'samples × lines × bands', value: '0' }));
  return {
    samples,
    lines,
    bands,
    dataType,
    dtype,
    little: num('byte order', 0) === 0,
    offset: num('header offset', 0),
    interleave: il,
    description: (fields.get('description') ?? '').replace(/^\{|\}$/g, '').trim(),
    bandNames: list(fields.get('band names')),
  };
}

/** File offset of element (line, sample) of `band` (0-based) in an ENVI cube. */
export function enviIndex(h: Envi, band: number, line: number, sample: number): number {
  const i =
    h.interleave === 'bsq'
      ? (band * h.lines + line) * h.samples + sample
      : h.interleave === 'bil'
        ? (line * h.bands + band) * h.samples + sample
        : (line * h.samples + sample) * h.bands + band;
  return h.offset + i * DTYPES[h.dtype];
}

const ENVI_MAX_READ = 256 << 20;

/**
 * Bytes of one band of an ENVI cube, in line-major order, and how many whole values of it the
 * file holds. In every interleave the file offset grows along line-major order, so the values
 * a truncated file lacks are always the last ones: `present` values, then nothing.
 */
export async function readEnviBand(
  file: LazyFile,
  h: Envi,
  band: number,
): Promise<{ bytes: Uint8Array; present: number }> {
  const size = DTYPES[h.dtype];
  const plane = h.lines * h.samples;
  if (plane > MAX_VALUES)
    throw new ToolError(T('error.enviTooBig', { count: plane, max: MAX_VALUES }));
  if (h.interleave === 'bsq') {
    const start = enviIndex(h, band, 0, 0);
    const present = Math.max(0, Math.min(plane, Math.floor((file.size - start) / size)));
    return { bytes: await readRange(file, start, present * size), present };
  }
  const cube = plane * h.bands * size;
  if (cube > ENVI_MAX_READ)
    throw new ToolError(
      T('error.enviTooBig', { count: plane * h.bands, max: ENVI_MAX_READ / size }),
    );
  const all = await readRange(file, h.offset, cube);
  const out = new Uint8Array(plane * size);
  let present = 0;
  for (let l = 0; l < h.lines; l++) {
    for (let s = 0; s < h.samples; s++) {
      const from = enviIndex(h, band, l, s) - h.offset;
      if (from + size > all.length) continue;
      out.set(all.subarray(from, from + size), (l * h.samples + s) * size);
      present++;
    }
  }
  return { bytes: out.subarray(0, present * size), present };
}

// ---------------------------------------------------------------- view

export interface NumericOptions {
  dtype: DType;
  endian: 'le' | 'be';
  offset: string;
  count: number;
  rows: number;
  cols: number;
  band: number;
  envi: FileInput | null;
}

export async function numericView(file: LazyFile, o: NumericOptions): Promise<Output[]> {
  if (!Object.hasOwn(DTYPES, o.dtype))
    throw new ToolError(T('error.dtype', { dtype: String(o.dtype), types: DTYPE_LIST }));
  const out: Output[] = [];
  let dtype = o.dtype;
  let little = o.endian === 'le';
  let rows = Math.max(0, Math.floor(o.rows) || 0);
  let cols = Math.max(0, Math.floor(o.cols) || 0);
  let bytes: Uint8Array;
  let start: number;
  /** Values the file lacks at the end of an ENVI band (NaN, left out of the statistics). */
  let missing = 0;
  const info: [string, string][] = [];
  if (o.envi) {
    const h = parseEnvi(utf8Decode(o.envi.bytes));
    const band = o.band;
    if (!Number.isInteger(band) || band < 1 || band > h.bands)
      throw new ToolError(T('error.enviBand', { band, count: h.bands }));
    dtype = h.dtype;
    little = h.little;
    rows = h.lines;
    cols = h.samples;
    if (h.offset >= file.size)
      throw new ToolError(T('error.offsetPast', { offset: h.offset, size: file.size }));
    start = enviIndex(h, band - 1, 0, 0);
    const need = h.offset + h.samples * h.lines * h.bands * DTYPES[dtype];
    if (need > file.size) {
      out.push({
        type: 'note',
        level: 'warn',
        text: T('note.enviShort', { need, size: file.size }),
      });
    }
    const read = await readEnviBand(file, h, band - 1);
    bytes = read.bytes;
    missing = rows * cols - read.present;
    if (missing > 0) {
      out.push({
        type: 'note',
        level: 'warn',
        text: T('note.enviMissing', { count: missing, band }),
      });
    }
    info.push(
      [T('kv.enviHeader'), o.envi.name ?? '.hdr'],
      [
        T('kv.enviShape'),
        T('value.enviShape', { samples: h.samples, lines: h.lines, bands: h.bands }),
      ],
      [T('kv.interleave'), h.interleave.toUpperCase()],
      [T('kv.band'), h.bandNames[band - 1] ? `${band} (${h.bandNames[band - 1]})` : String(band)],
      [T('kv.headerOffset'), String(h.offset)],
    );
    if (h.description) info.push([T('kv.description'), h.description]);
  } else {
    const parsed = parseSize(o.offset, T('opt.offset')) ?? 0;
    if (parsed < 0 && -parsed > file.size)
      throw new ToolError(T('error.offsetBefore', { offset: parsed, size: file.size }));
    start = parsed < 0 ? file.size + parsed : parsed;
    if (start >= file.size)
      throw new ToolError(T('error.offsetPast', { offset: start, size: file.size }));
    const size = DTYPES[dtype];
    const fit = Math.floor((file.size - start) / size);
    if (fit <= 0) throw new ToolError(T('error.noValues'));
    const asked = Math.max(0, Math.floor(o.count) || 0);
    let want = rows > 0 && cols > 0 ? rows * cols : asked > 0 ? asked : fit;
    let count = Math.min(want, fit, MAX_VALUES);
    if (count < want) {
      out.push({
        type: 'note',
        level: 'warn',
        text:
          want > fit
            ? T('note.valuesShort', { count, wanted: want })
            : T('note.valuesCapped', { count, wanted: want, max: MAX_VALUES }),
      });
    }
    // One side of the shape given: the other one follows from the values read.
    if (rows > 0 && cols === 0) cols = Math.floor(count / rows);
    else if (cols > 0 && rows === 0) rows = Math.floor(count / cols);
    if (rows > 0 && cols > 0 && rows * cols > count) {
      const fullRows = Math.floor(count / cols);
      if (fullRows >= 1) {
        out.push({
          type: 'note',
          level: 'warn',
          text: T('note.shapeClamped', { count: fullRows, rows, cols }),
        });
        rows = fullRows;
      } else {
        out.push({
          type: 'note',
          level: 'warn',
          text: T('note.shapeDropped', { rows, cols, count }),
        });
        rows = 0;
        cols = 0;
      }
    } else if (rows > 0 !== cols > 0) {
      rows = 0;
      cols = 0;
    }
    if (rows > 0 && cols > 0) count = rows * cols;
    want = count;
    const rest = (file.size - start) % size;
    if (rest && count === fit) {
      out.push({
        type: 'note',
        level: 'info',
        text: T('note.partialValue', { count: rest, dtype }),
      });
    }
    bytes = await readRange(file, start, want * size);
  }
  const decoded = decodeValues(bytes, dtype, little);
  const big = decoded.big;
  const present = decoded.values.length;
  let values = decoded.values;
  if (missing > 0) {
    values = new Float64Array(present + missing).fill(NaN);
    values.set(decoded.values);
  }
  const s = stats(values);
  const isFloat = dtype === 'float32' || dtype === 'float64';
  out.unshift({
    type: 'kv',
    label: T('label.numeric'),
    entries: [
      [T('kv.dtype'), `${dtype} (${T('value.bytesEach', { count: DTYPES[dtype] })})`],
      [T('kv.byteOrder'), little ? T('value.little') : T('value.big')],
      [T('kv.offset'), `${start} (${hex(start)})`],
      [T('kv.values'), String(values.length)],
      ...(missing > 0 ? ([[T('kv.missing'), String(missing)]] as [string, string][]) : []),
      ...(rows > 0 && cols > 0
        ? ([[T('kv.shape'), `${rows} × ${cols}`]] as [string, string][])
        : []),
      ...info,
    ],
  });
  // Min and max are values of the data: shown exactly (64-bit integers through BigInt).
  const range = big ? bigRange(big, present) : null;
  const statEntries: [string, string][] = [
    [T('kv.min'), range ? range[0] : formatValue(s.min, dtype)],
    [T('kv.max'), range ? range[1] : formatValue(s.max, dtype)],
    [T('kv.mean'), fmtStat(s.mean)],
    [T('kv.std'), fmtStat(s.std)],
    [T('kv.zeros'), String(s.zeros)],
  ];
  if (isFloat) {
    statEntries.push(
      [T('kv.nan'), String(s.nan - missing)],
      [T('kv.inf'), `${s.posInf} / ${s.negInf}`],
    );
  }
  if (big) statEntries.push([T('kv.precision'), T('value.precision')]);
  out.push({ type: 'kv', label: T('label.stats'), entries: statEntries });

  const shaped = rows > 0 && cols > 0;
  if (shaped) {
    out.push({
      type: 'image',
      label: T('label.preview', { rows, cols }),
      image: preview(values, rows, cols, s),
      filename: 'numeric-preview.png',
    });
  } else {
    const fits = shapes(values.length);
    if (fits.length) {
      out.push({
        type: 'note',
        level: 'info',
        text: T('note.shapes', { shapes: fits.map(([r, c]) => `${r} × ${c}`).join(', ') }),
      });
    }
  }
  const show = (i: number) =>
    i >= present ? '—' : big ? String(big[i]) : formatValue(values[i]!, dtype);
  const n = Math.min(values.length, TABLE_ROWS);
  const rowsOut: (string | number)[][] = [];
  for (let i = 0; i < n; i++) {
    rowsOut.push(
      shaped
        ? [Math.floor(i / cols), i % cols, show(i)]
        : [i, hex(start + i * DTYPES[dtype]), show(i)],
    );
  }
  out.push({
    type: 'table',
    label: T('label.values', { shown: n, count: values.length }),
    columns: shaped
      ? [T('col.row'), T('col.column'), T('col.value')]
      : [T('col.index'), T('col.offset'), T('col.value')],
    rows: rowsOut,
  });
  const perLine = shaped ? cols : 16;
  const lines: string[] = [];
  const m = Math.min(values.length, TEXT_VALUES);
  for (let i = 0; i < m; i += perLine) {
    const row: string[] = [];
    for (let k = i; k < Math.min(m, i + perLine); k++) row.push(show(k));
    lines.push(row.join(' '));
  }
  out.push({ type: 'text', label: T('label.valuesText', { count: m }), value: lines.join('\n') });
  return out;
}
