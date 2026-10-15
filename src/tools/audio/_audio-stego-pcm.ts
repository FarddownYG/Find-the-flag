/**
 * Raw PCM samples of a WAV or AIFF file, read straight from the file bytes (never through the
 * decoded floats, which would hide the very bits this is about): the layout of the samples, the
 * bit-plane extraction used by the LSB scan, and the per-window ones-ratio of each plane.
 * Pure functions on bytes: they run in the page, in the tool worker and in Node.
 */
import { u16be, u16le, u32be, u32le } from '../../lib/bytes';
import { codecHex, codecName, WAV_FLOAT, WAV_PCM } from '../../core/wav';

// ---------- chunks ----------

export interface Chunk {
  id: string;
  /** Offset of the chunk header. */
  offset: number;
  /** The size field. */
  size: number;
  /** Body [start, end): `end` is clamped to the file. */
  start: number;
  end: number;
  /** The size field runs past the end of the file. */
  truncated: boolean;
}

export interface ChunkFile {
  kind: 'wav' | 'aiff';
  /** 'WAVE', 'AIFF' or 'AIFC'. */
  form: string;
  /** 8 + the RIFF / FORM size field: where the container says it ends (may exceed the file). */
  declaredEnd: number;
  chunks: Chunk[];
  /** First byte that is not part of a chunk: [stop, length) is data after the last chunk. */
  stop: number;
}

const ascii4 = (b: Uint8Array, o: number): string =>
  String.fromCharCode(b[o] ?? 0, b[o + 1] ?? 0, b[o + 2] ?? 0, b[o + 3] ?? 0);

/** Chunk ids are four letters, digits, spaces or a few signs: random bytes rarely look like one. */
const CHUNK_ID = /^[A-Za-z0-9_ ()-]{4}$/;

/** Only the audio itself may run past the end of a truncated file. */
const MAY_OVERFLOW = new Set(['data', 'SSND']);

/**
 * Walk the chunks of a RIFF/WAVE or FORM/AIFF file without trusting its size fields. Stops at the
 * first thing that is not a chunk (a header that is not four plain characters, or a size that
 * leaves the file): whatever follows is data after the last chunk. Null when the bytes are
 * neither format.
 */
export function walkChunks(b: Uint8Array): ChunkFile | null {
  if (b.length < 12) return null;
  const magic = ascii4(b, 0);
  const form = ascii4(b, 8);
  const wav = magic === 'RIFF' && form === 'WAVE';
  const aiff = magic === 'FORM' && (form === 'AIFF' || form === 'AIFC');
  if (!wav && !aiff) return null;
  const read = wav ? u32le : u32be;
  const chunks: Chunk[] = [];
  let p = 12;
  while (p + 8 <= b.length) {
    const id = ascii4(b, p);
    if (!CHUNK_ID.test(id)) break;
    const size = read(b, p + 4);
    const start = p + 8;
    const overflow = start + size > b.length;
    if (overflow && !MAY_OVERFLOW.has(id)) break;
    const end = Math.min(b.length, start + size);
    chunks.push({ id, offset: p, size, start, end, truncated: overflow });
    p = start + size + (size & 1);
    if (overflow) break;
  }
  return {
    kind: wav ? 'wav' : 'aiff',
    form,
    declaredEnd: read(b, 4) + 8,
    chunks,
    stop: Math.min(p, b.length),
  };
}

// ---------- sample layout ----------

export interface PcmLayout {
  container: 'wav' | 'aiff';
  /** Integer samples, or IEEE floats (their raw bits are what an LSB tool changes). */
  sample: 'int' | 'float';
  /** Bits per sample as declared, and bytes per sample in the file. */
  bits: number;
  bytes: number;
  bigEndian: boolean;
  channels: number;
  rate: number;
  /** The sample bytes, [start, end), `end` clamped to the file. */
  start: number;
  end: number;
  /** Whole sample frames (one sample per channel). */
  frames: number;
  /** Bytes of the data that do not make a whole frame. */
  leftover: number;
  /** The data chunk announces more bytes than the file holds. */
  truncated: boolean;
  /** AIFF: sample bytes the SSND chunk skips between its header and the samples. */
  ssndOffset: number;
}

/** Why a WAV / AIFF could not be turned into a sample layout. */
export type NoPcm =
  | { why: 'codec'; codec: string }
  | { why: 'noFmt' }
  | { why: 'noData' }
  | { why: 'layout'; bits: number; channels: number };

export const isNoPcm = (r: PcmLayout | NoPcm): r is NoPcm => 'why' in r;

/** The 80-bit IEEE extended number an AIFF COMM chunk stores its sample rate in. */
export function extended80(b: Uint8Array, o: number): number {
  const exp = u16be(b, o) & 0x7fff;
  const mantissa = u32be(b, o + 2) * 2 ** 32 + u32be(b, o + 6);
  return mantissa === 0 ? 0 : Math.round(mantissa * 2 ** (exp - 16383 - 63));
}

function layoutOf(
  file: ChunkFile,
  data: { start: number; end: number; truncated: boolean },
  f: {
    sample: 'int' | 'float';
    bits: number;
    bigEndian: boolean;
    channels: number;
    rate: number;
    ssndOffset?: number;
  },
): PcmLayout | NoPcm {
  const bytes = Math.ceil(f.bits / 8);
  const okSize = f.sample === 'float' ? bytes === 4 || bytes === 8 : bytes >= 1 && bytes <= 4;
  if (!f.channels || !okSize) return { why: 'layout', bits: f.bits, channels: f.channels };
  const frame = bytes * f.channels;
  const frames = Math.floor((data.end - data.start) / frame);
  return {
    container: file.kind,
    sample: f.sample,
    bits: f.bits,
    bytes,
    bigEndian: f.bigEndian,
    channels: f.channels,
    rate: f.rate,
    start: data.start,
    end: data.end,
    frames,
    leftover: data.end - data.start - frames * frame,
    truncated: data.truncated,
    ssndOffset: f.ssndOffset ?? 0,
  };
}

/** AIFF-C compression types that are plain PCM: big-endian unless noted. */
const AIFC_INT = new Set(['NONE', 'twos', 'in24', 'in32', 'raw ']);
const AIFC_FLOAT = new Set(['fl32', 'FL32', 'fl64', 'FL64']);

/** The sample layout of a WAV / AIFF, or the reason it has none (compressed, no data...). */
export function readPcm(b: Uint8Array, file: ChunkFile): PcmLayout | NoPcm {
  if (file.kind === 'wav') {
    const fmt = file.chunks.find((c) => c.id === 'fmt ');
    if (!fmt || fmt.end - fmt.start < 16) return { why: 'noFmt' };
    const o = fmt.start;
    let codec = u16le(b, o);
    if (codec === 0xfffe && fmt.end - o >= 26) codec = u16le(b, o + 24); // WAVE_FORMAT_EXTENSIBLE
    const data = file.chunks.find((c) => c.id === 'data');
    if (codec !== WAV_PCM && codec !== WAV_FLOAT) {
      const name = codecName(codec);
      return { why: 'codec', codec: name ? `${name} (${codecHex(codec)})` : codecHex(codec) };
    }
    if (!data) return { why: 'noData' };
    return layoutOf(file, data, {
      sample: codec === WAV_FLOAT ? 'float' : 'int',
      bits: u16le(b, o + 14),
      bigEndian: false,
      channels: u16le(b, o + 2),
      rate: u32le(b, o + 4),
    });
  }
  const comm = file.chunks.find((c) => c.id === 'COMM');
  if (!comm || comm.end - comm.start < 18) return { why: 'noFmt' };
  const o = comm.start;
  const type = file.form === 'AIFC' && comm.end - o >= 22 ? ascii4(b, o + 18) : 'NONE';
  if (!AIFC_INT.has(type) && !AIFC_FLOAT.has(type) && type !== 'sowt') {
    return { why: 'codec', codec: `AIFF-C ${type}` };
  }
  const ssnd = file.chunks.find((c) => c.id === 'SSND');
  if (!ssnd || ssnd.end - ssnd.start < 8) return { why: 'noData' };
  const ssndOffset = u32be(b, ssnd.start);
  const start = Math.min(ssnd.end, ssnd.start + 8 + ssndOffset);
  const channels = u16be(b, o);
  const declared = u16be(b, o + 6);
  const bits = type === 'fl32' || type === 'FL32' ? 32 : AIFC_FLOAT.has(type) ? 64 : declared;
  const frameBytes = Math.ceil(bits / 8) * channels;
  // The COMM chunk says how many frames there are; the SSND chunk may hold more bytes than that.
  const wanted = frameBytes ? u32be(b, o + 2) * frameBytes : 0;
  const end = wanted && start + wanted <= ssnd.end ? start + wanted : ssnd.end;
  return layoutOf(
    file,
    { start, end, truncated: ssnd.truncated },
    {
      sample: AIFC_FLOAT.has(type) ? 'float' : 'int',
      bits,
      bigEndian: type !== 'sowt',
      channels,
      rate: extended80(b, o + 8),
      ssndOffset,
    },
  );
}

// ---------- bit-plane extraction ----------

export type BitOrder = 'msb' | 'lsb';

export interface LsbSpec {
  /** Distinct bit numbers read from every sample, 0 = least significant. */
  planes: number[];
  /**
   * 'byte': every byte of the audio data counts as one 8-bit sample, whatever the format (what a
   * script that edits the bytes of `wave.readframes()` does). Default 'sample'.
   */
  unit?: 'sample' | 'byte';
  /** 0-based channel, or null for every sample in file order (channels interleaved). */
  channel: number | null;
  bitOrder: BitOrder;
  /** Use every `step`-th sample of the selection (1 = all) ... */
  step: number;
  /** ... after skipping this many samples of the selection. */
  offset: number;
}

/** The selected samples form an arithmetic progression of byte positions. */
export interface SampleWalk {
  /** Position of the lowest-order byte of the first selected sample. */
  first: number;
  /** Bytes between two selected samples. */
  stride: number;
  /** How many whole samples are selected. */
  count: number;
}

export function sampleWalk(
  p: PcmLayout,
  spec: Pick<LsbSpec, 'channel' | 'step' | 'offset' | 'unit'>,
): SampleWalk {
  if (spec.unit === 'byte') {
    const total = p.end - p.start;
    return {
      first: p.start + spec.offset,
      stride: spec.step,
      count: spec.offset >= total ? 0 : Math.floor((total - 1 - spec.offset) / spec.step) + 1,
    };
  }
  const low = p.bigEndian ? p.bytes - 1 : 0;
  const total = p.frames * p.channels;
  const firstSample = spec.channel === null ? spec.offset : spec.offset * p.channels + spec.channel;
  const strideSamples = spec.channel === null ? spec.step : spec.step * p.channels;
  const count =
    firstSample >= total ? 0 : Math.floor((total - 1 - firstSample) / strideSamples) + 1;
  return {
    first: p.start + firstSample * p.bytes + low,
    stride: strideSamples * p.bytes,
    count,
  };
}

/** Bytes a full extraction yields: whole bytes only. */
export function lsbCapacity(p: PcmLayout, spec: LsbSpec): number {
  return Math.floor((sampleWalk(p, spec).count * spec.planes.length) / 8);
}

/**
 * Read the selected bit planes of the selected samples and pack them into bytes.
 *
 * Inside a sample the planes are read from the high bit to the low bit for MSB-first packing
 * and from low to high for LSB-first, which is what "write the next n message bits into the low
 * n bits" embedders produce (the image LSB tool does the same). The bits fill each byte from its
 * top (MSB first) or from its bottom (LSB first). The bits are those of the integer stored in
 * the file, whatever the sample type: for a float it is the low end of the mantissa.
 */
export function extractLsb(
  b: Uint8Array,
  p: PcmLayout,
  spec: LsbSpec,
  maxBytes = Infinity,
): Uint8Array {
  const walk = sampleWalk(p, spec);
  const msb = spec.bitOrder === 'msb';
  const planes = [...spec.planes].sort((x, y) => (msb ? y - x : x - y));
  const outLen = Math.min(maxBytes, Math.floor((walk.count * planes.length) / 8));
  const out = new Uint8Array(outLen);
  let acc = 0;
  let nb = 0;
  let o = 0;
  for (let k = 0, pos = walk.first; k < walk.count && o < outLen; k++, pos += walk.stride) {
    const v = b[pos]!;
    for (const pl of planes) {
      const bit = (v >> pl) & 1;
      if (msb) acc = (acc << 1) | bit;
      else acc |= bit << nb;
      if (++nb === 8) {
        if (o < outLen) out[o++] = acc & 0xff;
        acc = 0;
        nb = 0;
      }
    }
  }
  return out;
}

/** The sample frame that selected sample `k` of an extraction sits in. */
export function frameOf(p: PcmLayout, spec: LsbSpec, k: number): number {
  const i = spec.offset + k * spec.step;
  if (spec.unit === 'byte') return Math.floor(i / (p.bytes * p.channels));
  return spec.channel === null ? Math.floor(i / p.channels) : i;
}

// ---------- bit-plane statistics over time ----------

export const STAT_PLANES = 4;

export interface PlaneStats {
  frames: number;
  /** Channels analysed (the first few). */
  channels: number;
  columns: number;
  /** Sample frames per column. */
  windowFrames: number;
  /** ratios[channel][plane][column]: share of ones in that plane over the window, 0..1. */
  ratios: Float32Array[][];
}

/**
 * For each of the first `maxChannels` channels and each of the lowest four bit planes, the share
 * of ones in consecutive windows of the file: digital silence reads 0 (or 1), natural sound and
 * hidden data about 0.5. One pass over the samples, whatever the number of windows.
 */
export function planeStats(
  b: Uint8Array,
  p: PcmLayout,
  maxColumns = 600,
  maxChannels = 4,
): PlaneStats {
  const channels = Math.min(p.channels, maxChannels);
  const columns = Math.max(1, Math.min(maxColumns, Math.ceil(p.frames / 32)));
  const windowFrames = Math.max(1, Math.ceil(p.frames / columns));
  const cols = Math.ceil(p.frames / windowFrames) || 1;
  const hist = new Uint32Array(channels * cols * 16);
  const low = p.bigEndian ? p.bytes - 1 : 0;
  const frameBytes = p.bytes * p.channels;
  for (let col = 0; col < cols; col++) {
    const f1 = Math.min(p.frames, (col + 1) * windowFrames);
    for (let f = col * windowFrames; f < f1; f++) {
      const base = p.start + f * frameBytes + low;
      for (let c = 0; c < channels; c++) {
        hist[(c * cols + col) * 16 + (b[base + c * p.bytes]! & 15)]!++;
      }
    }
  }
  const ratios: Float32Array[][] = [];
  for (let c = 0; c < channels; c++) {
    const planes: Float32Array[] = [];
    for (let pl = 0; pl < STAT_PLANES; pl++) {
      const r = new Float32Array(cols);
      for (let col = 0; col < cols; col++) {
        const n = Math.min(p.frames, (col + 1) * windowFrames) - col * windowFrames;
        let ones = 0;
        for (let v = 0; v < 16; v++) if ((v >> pl) & 1) ones += hist[(c * cols + col) * 16 + v]!;
        r[col] = n > 0 ? ones / n : 0;
      }
      planes.push(r);
    }
    ratios.push(planes);
  }
  return { frames: p.frames, channels, columns: cols, windowFrames, ratios };
}

export interface Onset {
  channel: number;
  /** The first window that is no longer flat after a flat stretch, and its first sample frame. */
  column: number;
  frame: number;
  /** The value of the flat stretch: 0 (digital silence) or 1. */
  level: 0 | 1;
}

/** Where a flat plane starts to change: the first frame of the window whose bit is not the flat value. */
export function firstChange(b: Uint8Array, p: PcmLayout, o: Onset): number {
  const low = p.bigEndian ? p.bytes - 1 : 0;
  const frameBytes = p.bytes * p.channels;
  const end = Math.min(p.frames, o.frame + 4096);
  for (let f = o.frame; f < end; f++) {
    const v = b[p.start + f * frameBytes + o.channel * p.bytes + low]! & 1;
    if (v !== o.level) return f;
  }
  return o.frame;
}

const FLAT = 0.01;
const ACTIVE = [0.3, 0.7] as const;

/**
 * Where the lowest plane of a channel turns from flat (all 0 or all 1: digital silence) to random:
 * the earliest such change over the channels, when the file has a flat stretch of at least a few
 * windows followed by a random-looking one. Null when the plane never goes flat or never wakes up.
 */
export function findOnset(s: PlaneStats): Onset | null {
  const minFlat = Math.max(3, Math.floor(s.columns / 50));
  let best: Onset | null = null;
  for (let c = 0; c < s.channels; c++) {
    const r = s.ratios[c]![0]!;
    let flat = 0;
    let wake = -1; // the first window that is no longer flat after a flat stretch
    for (let col = 0; col < r.length; col++) {
      const v = r[col]!;
      if (v <= FLAT || v >= 1 - FLAT) {
        if (wake >= 0) {
          wake = -1; // a blip: the plane went flat again
          flat = 0;
        }
        flat++;
        continue;
      }
      if (flat < minFlat) {
        flat = 0;
        continue;
      }
      if (wake < 0) wake = col;
      if (v >= ACTIVE[0] && v <= ACTIVE[1]) {
        if (!best || wake < best.column) {
          const level = r[wake - 1]! >= 0.5 ? 1 : 0;
          best = { channel: c, column: wake, frame: wake * s.windowFrames, level };
        }
        break;
      }
      if (col - wake >= 2) {
        flat = 0;
        wake = -1;
      }
    }
  }
  return best;
}
