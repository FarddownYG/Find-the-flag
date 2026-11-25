/**
 * Pixel Indicator Technique (PIT, Gutub et al.) — pure decoder, encoder and capacity.
 *
 * Every pixel has an INDICATOR channel; the other two are the DATA channels, called channel 1 and
 * channel 2 (the two channels that are not the indicator, in R, G, B order). The low two bits of the
 * indicator, 00 / 01 / 10 / 11, say where this pixel hides its bits. A CODE TABLE maps each of the
 * four codes to one of five slots: nothing, channel 1, channel 2, channel 1 then 2, channel 2 then 1.
 * The low `bitsPerChannel` bits of every selected data channel are payload.
 *
 * The walk is row-major. A big-endian (by default) HEADER of `header.bytes` bytes, read from the
 * pixels starting at `header.atPixel`, gives the message length; the body then starts either at the
 * next pixel (startMode "after") or at the start of row `startRow` (startMode "row": the usual trap
 * is a body that begins on row 1 although the header ended in row 0). The body stops at the length.
 *
 * Rotating indicator: the indicator channel advances R, G, B, R ... one step per pixel. The header
 * is read starting with R at its first pixel. The body starts with R when the message length is
 * even and with G when it is odd, counting from its first pixel.
 *
 * The encoder picks the code of each pixel from a fixed pattern (so the output is deterministic);
 * the decoder only reads the codes, so it works on any PIT image regardless of how it was produced.
 */
import type { RgbaImage } from '../../core/types';

export type IndicatorMode = 'r' | 'g' | 'b' | 'rotate';
export type Slot = 'none' | 'c1' | 'c2' | 'c1c2' | 'c2c1';
export const SLOTS: readonly Slot[] = ['none', 'c1', 'c2', 'c1c2', 'c2c1'];
/** One slot per indicator code (index = the two low bits of the indicator: 00, 01, 10, 11). */
export type CodeTable = readonly [Slot, Slot, Slot, Slot];
export const DEFAULT_TABLE: CodeTable = ['none', 'c1', 'c2', 'c1c2'];

export interface HeaderSettings {
  /** Header size in bytes, 1..8. */
  bytes: number;
  endian: 'be' | 'le';
  /** Pixel (row-major index) where the header starts. */
  atPixel: number;
}

export interface PitSettings {
  indicator: IndicatorMode;
  codeTable: CodeTable;
  /** Low bits taken from each selected channel, 1..4. */
  bitsPerChannel: number;
  /** msb: high bit of a channel's group first and bytes filled from bit 7; lsb: the reverse. */
  bitOrder: 'msb' | 'lsb';
  header: HeaderSettings;
  startMode: 'after' | 'row';
  startRow: number;
}

export const DEFAULT_SETTINGS: PitSettings = {
  indicator: 'g',
  codeTable: DEFAULT_TABLE,
  bitsPerChannel: 2,
  bitOrder: 'msb',
  header: { bytes: 8, endian: 'be', atPixel: 0 },
  startMode: 'after',
  startRow: 1,
};

/** Indicator codes the encoder cycles through (so every code of the table is exercised). */
export const ENCODER_PATTERN: readonly number[] = [3, 1, 2, 3, 0, 2, 1];

const INDICATOR_INDEX = { r: 0, g: 1, b: 2 } as const;
const CHANNEL_NAMES = ['R', 'G', 'B'] as const;
export const channelName = (c: number): string => CHANNEL_NAMES[c] ?? '?';

/** The two non-indicator channels, in R, G, B order. */
export function dataChannels(indicator: number): [number, number] {
  const rest = [0, 1, 2].filter((c) => c !== indicator);
  return [rest[0]!, rest[1]!];
}

/** Concrete channels (in reading order) a slot selects for a given indicator channel. */
export function slotChannels(slot: Slot, indicator: number): number[] {
  const [a, b] = dataChannels(indicator);
  switch (slot) {
    case 'none':
      return [];
    case 'c1':
      return [a];
    case 'c2':
      return [b];
    case 'c1c2':
      return [a, b];
    case 'c2c1':
      return [b, a];
  }
}

/** The indicator channel of the k-th pixel of a stage (header or body). */
export function indicatorAt(mode: IndicatorMode, k: number, rotStart: number): number {
  return mode === 'rotate' ? (rotStart + k) % 3 : INDICATOR_INDEX[mode];
}

/** The rotating-indicator start channel of the body: R for an even length, G for an odd one. */
export const bodyRotStart = (length: number): number => length % 2;

// ---------- bit reading / writing ----------

interface Sink {
  buf: Uint8Array;
  pos: number;
}

function push(sink: Sink, bit: number, msb: boolean): boolean {
  if (sink.pos >= sink.buf.length * 8) return false;
  const i = sink.pos & 7;
  sink.buf[sink.pos >> 3]! |= bit << (msb ? 7 - i : i);
  sink.pos++;
  return true;
}

export interface PixelTrace {
  pixel: number;
  x: number;
  y: number;
  indicator: number;
  /** The indicator's value and its two low bits. */
  indicatorValue: number;
  code: number;
  slot: Slot;
  channels: number[];
  /** The payload bits taken from this pixel, in order. */
  bits: number[];
}

interface Stream {
  bytes: Uint8Array;
  bitsRead: number;
  /** Pixel index right after the last pixel used. */
  next: number;
}

function readStream(
  image: RgbaImage,
  s: PitSettings,
  first: number,
  nBytes: number,
  rotStart: number,
  trace?: PixelTrace[],
): Stream {
  const total = image.width * image.height;
  const sink: Sink = { buf: new Uint8Array(nBytes), pos: 0 };
  const msb = s.bitOrder === 'msb';
  const bpc = s.bitsPerChannel;
  const mask = (1 << bpc) - 1;
  const { data } = image;
  let p = Math.max(0, first);
  while (sink.pos < nBytes * 8 && p < total) {
    const ind = indicatorAt(s.indicator, p - first, rotStart);
    const ivalue = data[p * 4 + ind]!;
    const code = ivalue & 3;
    const slot = s.codeTable[code]!;
    const chans = slotChannels(slot, ind);
    const bits: number[] = [];
    for (const c of chans) {
      const v = data[p * 4 + c]! & mask;
      for (let i = 0; i < bpc; i++) {
        const bit = (v >> (msb ? bpc - 1 - i : i)) & 1;
        if (push(sink, bit, msb)) bits.push(bit);
      }
    }
    if (trace && trace.length < 8) {
      trace.push({
        pixel: p,
        x: p % image.width,
        y: Math.floor(p / image.width),
        indicator: ind,
        indicatorValue: ivalue,
        code,
        slot,
        channels: chans,
        bits,
      });
    }
    p++;
  }
  return { bytes: sink.buf.subarray(0, sink.pos >> 3), bitsRead: sink.pos, next: p };
}

/** Header bytes as an integer (up to 8 bytes: beyond 2^53 the value is only approximate). */
export function headerValue(bytes: Uint8Array, endian: 'be' | 'le'): number {
  let v = 0;
  const order = endian === 'be' ? [...bytes] : [...bytes].reverse();
  for (const b of order) v = v * 256 + b;
  return v;
}

export function headerBytes(value: number, size: number, endian: 'be' | 'le'): Uint8Array {
  const out = new Uint8Array(size);
  let v = value;
  for (let i = size - 1; i >= 0; i--) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  return endian === 'be' ? out : out.reverse();
}

/** The pixel where the body starts once the header ended just before `headerEnd`. */
export function bodyStartPixel(image: RgbaImage, s: PitSettings, headerEnd: number): number {
  return s.startMode === 'row' ? Math.max(s.startRow * image.width, headerEnd) : headerEnd;
}

// ---------- decode ----------

export interface DecodeResult {
  /** The message: `header` bytes, or fewer when the image runs out first. */
  body: Uint8Array;
  /** The length read from the header. */
  header: number;
  /** First pixel of the body. */
  bodyStart: number;
  /** Pixels read for the first header bytes (for hand-decoding). */
  trace: PixelTrace[];
}

/**
 * Read the header, then the body. `limit` caps the body bytes returned (auto-mode preview). A
 * header that cannot be read (image too small) gives an empty body and header 0.
 */
export function decode(image: RgbaImage, s: PitSettings, limit: number = Infinity): DecodeResult {
  const trace: PixelTrace[] = [];
  const h = readStream(image, s, s.header.atPixel, s.header.bytes, 0, trace);
  if (h.bytes.length < s.header.bytes)
    return { body: new Uint8Array(0), header: 0, bodyStart: 0, trace };
  const header = headerValue(h.bytes, s.header.endian);
  const bodyStart = bodyStartPixel(image, s, h.next);
  const pixels = Math.max(0, image.width * image.height - bodyStart);
  // Two channels of `bitsPerChannel` bits per pixel is the most a pixel can carry.
  const room = Math.floor((pixels * 2 * s.bitsPerChannel) / 8);
  const want = Math.min(header, limit, room);
  const b = readStream(image, s, bodyStart, want, bodyRotStart(header));
  return { body: b.bytes, header, bodyStart, trace };
}

// ---------- encode / capacity ----------

function bitsOfSlot(slot: Slot, bpc: number): number {
  return (slot === 'c1c2' || slot === 'c2c1' ? 2 : slot === 'none' ? 0 : 1) * bpc;
}

/** Pixels the encoder needs to place `nBits` from pixel `first`, or null when they do not fit. */
function placeSpan(image: RgbaImage, s: PitSettings, first: number, nBits: number): number | null {
  const total = image.width * image.height;
  let left = nBits;
  let p = first;
  while (left > 0 && p < total) {
    const code = ENCODER_PATTERN[(p - first) % ENCODER_PATTERN.length]!;
    left -= bitsOfSlot(s.codeTable[code]!, s.bitsPerChannel);
    p++;
  }
  return left > 0 ? null : p;
}

/** The largest message (bytes) the encoder can hide with these settings, 0 when the header does not fit. */
export function capacity(image: RgbaImage, s: PitSettings): number {
  const hEnd = placeSpan(image, s, s.header.atPixel, s.header.bytes * 8);
  if (hEnd === null) return 0;
  const start = bodyStartPixel(image, s, hEnd);
  const total = image.width * image.height;
  let bits = 0;
  for (let p = start; p < total; p++) {
    bits += bitsOfSlot(
      s.codeTable[ENCODER_PATTERN[(p - start) % ENCODER_PATTERN.length]!]!,
      s.bitsPerChannel,
    );
  }
  const maxHeader = 256 ** s.header.bytes - 1;
  return Math.min(Math.floor(bits / 8), maxHeader);
}

function writeStream(
  data: Uint8ClampedArray,
  total: number,
  s: PitSettings,
  first: number,
  payload: Uint8Array,
  rotStart: number,
): number {
  const msb = s.bitOrder === 'msb';
  const bpc = s.bitsPerChannel;
  const mask = (1 << bpc) - 1;
  const nBits = payload.length * 8;
  const bitAt = (i: number): number =>
    i >= nBits ? 0 : (payload[i >> 3]! >> (msb ? 7 - (i & 7) : i & 7)) & 1;
  let pos = 0;
  let p = first;
  while (pos < nBits) {
    if (p >= total) throw new Error('PIT: message does not fit');
    const ind = indicatorAt(s.indicator, p - first, rotStart);
    const code = ENCODER_PATTERN[(p - first) % ENCODER_PATTERN.length]!;
    data[p * 4 + ind] = (data[p * 4 + ind]! & ~3) | code;
    for (const c of slotChannels(s.codeTable[code]!, ind)) {
      if (pos >= nBits) break;
      let v = 0;
      for (let i = 0; i < bpc; i++) v |= bitAt(pos + i) << (msb ? bpc - 1 - i : i);
      pos += bpc;
      data[p * 4 + c] = (data[p * 4 + c]! & ~mask) | v;
    }
    p++;
  }
  return p;
}

/**
 * Hide `message` in a copy of `image`: header (its length) first, then the body, with the same
 * pixel walk and code table `decode` reads. Throws when it does not fit.
 */
export function encode(image: RgbaImage, message: Uint8Array, s: PitSettings): RgbaImage {
  if (message.length > 256 ** s.header.bytes - 1)
    throw new Error('PIT: length does not fit the header');
  const data = new Uint8ClampedArray(image.data);
  const out: RgbaImage = { width: image.width, height: image.height, data };
  const total = image.width * image.height;
  const head = headerBytes(message.length, s.header.bytes, s.header.endian);
  const hEnd = writeStream(data, total, s, s.header.atPixel, head, 0);
  const start = bodyStartPixel(image, s, hEnd);
  writeStream(data, total, s, start, message, bodyRotStart(message.length));
  return out;
}
