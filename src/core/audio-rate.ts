/**
 * Native sample rate of a compressed audio file, read from its container header BEFORE it is
 * decoded. Web Audio resamples whatever it decodes to the rate of the context it is given, so a
 * 22050 Hz MP3 decoded in a 44100 Hz context would be analysed (and reported) as 44100 Hz, with
 * a fake empty band above 11025 Hz. Knowing the real rate lets the decoder be created at it.
 *
 * Pure functions on bytes: no DOM, no Web Audio, testable in Node.
 */
import { bytesEqualAt, indexOfBytes, u16be, u32be, u32le } from '../lib/bytes';

export type AudioFormat = 'mp3' | 'aac' | 'flac' | 'vorbis' | 'opus' | 'mp4' | 'webm';

export interface RateProbe {
  format: AudioFormat;
  /** Rate to create the decoding context at, so that nothing is resampled. */
  decodeRate: number;
  /** Opus only: rate of the original recording (OpusHead). Opus always decodes at 48000 Hz. */
  originalRate?: number;
}

/** Where a decoded rate comes from. */
export type RateSource = 'file' | 'decoder';

export interface RateInfo {
  source: RateSource;
  originalRate?: number;
}

/** Sample rates a Web Audio context accepts (Chromium: 3000 to 768000 Hz). */
export const MIN_CONTEXT_RATE = 3000;
export const MAX_CONTEXT_RATE = 768000;
export const usableContextRate = (rate: number): boolean =>
  Number.isInteger(rate) && rate >= MIN_CONTEXT_RATE && rate <= MAX_CONTEXT_RATE;

/** Rate of a decoded buffer when the container could not be read (the historical default). */
export const FALLBACK_RATE = 44100;
export const OPUS_RATE = 48000;

/** How far into the file a first audio frame is searched for (after the ID3 tags). */
const SYNC_SCAN_LIMIT = 256 * 1024;

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const at = (b: Uint8Array, o: number): number => b[o] ?? 0;
const tag = (b: Uint8Array, o: number, s: string): boolean => bytesEqualAt(b, ascii(s), o);

// ---------- ID3v2 ----------

/** Offset just after any ID3v2 tag(s) at the start of the file. */
function skipId3(b: Uint8Array): number {
  let p = 0;
  while (p + 10 <= b.length && tag(b, p, 'ID3') && at(b, p + 3) < 0xff) {
    const s = [at(b, p + 6), at(b, p + 7), at(b, p + 8), at(b, p + 9)];
    if (s.some((x) => x & 0x80)) break; // not a synchsafe size: not a tag
    const size = (s[0]! << 21) | (s[1]! << 14) | (s[2]! << 7) | s[3]!;
    const footer = at(b, p + 5) & 0x10 ? 10 : 0;
    p += 10 + size + footer;
  }
  return p;
}

// ---------- MPEG audio (MP3, MP2) ----------

const MPEG_RATES: Record<number, readonly number[]> = {
  3: [44100, 48000, 32000], // MPEG-1
  2: [22050, 24000, 16000], // MPEG-2
  0: [11025, 12000, 8000], // MPEG-2.5
};
/** kbit/s by header index; index 0 is "free format" (unknown length) and is not supported. */
const MPEG_BITRATES = {
  v1l1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  v1l2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  v1l3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  v2l1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  v2l23: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
} as const;

interface Frame {
  rate: number;
  length: number;
  /** What must stay the same from one frame to the next. */
  key: string;
}

/** Parse an MPEG audio frame header at `p` (null when it is not a plausible one). */
function mpegFrame(b: Uint8Array, p: number): Frame | null {
  if (p + 4 > b.length || b[p] !== 0xff || (at(b, p + 1) & 0xe0) !== 0xe0) return null;
  const version = (at(b, p + 1) >> 3) & 3; // 0 = 2.5, 1 = reserved, 2 = MPEG-2, 3 = MPEG-1
  const layerBits = (at(b, p + 1) >> 1) & 3; // 1 = III, 2 = II, 3 = I, 0 = reserved (ADTS)
  const bitrateIdx = (at(b, p + 2) >> 4) & 15;
  const rateIdx = (at(b, p + 2) >> 2) & 3;
  const padding = (at(b, p + 2) >> 1) & 1;
  if (version === 1 || layerBits === 0 || bitrateIdx === 0 || bitrateIdx === 15 || rateIdx === 3) {
    return null;
  }
  const rate = MPEG_RATES[version]![rateIdx]!;
  const layer = 4 - layerBits; // 1, 2 or 3
  const v1 = version === 3;
  const table =
    layer === 1
      ? v1
        ? MPEG_BITRATES.v1l1
        : MPEG_BITRATES.v2l1
      : layer === 2
        ? v1
          ? MPEG_BITRATES.v1l2
          : MPEG_BITRATES.v2l23
        : v1
          ? MPEG_BITRATES.v1l3
          : MPEG_BITRATES.v2l23;
  const bitrate = table[bitrateIdx]! * 1000;
  const length =
    layer === 1
      ? (Math.floor((12 * bitrate) / rate) + padding) * 4
      : Math.floor(((layer === 3 && !v1 ? 72 : 144) * bitrate) / rate) + padding;
  return { rate, length, key: `mpeg${version}/${layer}/${rate}` };
}

// ---------- AAC ADTS ----------

/** MPEG-4 sampling_frequency_index table (shared by ADTS and AudioSpecificConfig). */
const AAC_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
] as const;

function adtsFrame(b: Uint8Array, p: number): Frame | null {
  if (p + 7 > b.length || b[p] !== 0xff || (at(b, p + 1) & 0xf6) !== 0xf0) return null;
  const idx = (at(b, p + 2) >> 2) & 15;
  const rate = AAC_RATES[idx];
  const length = ((at(b, p + 3) & 3) << 11) | (at(b, p + 4) << 3) | (at(b, p + 5) >> 5);
  if (rate === undefined || length < 7) return null;
  return { rate, length, key: `adts/${rate}` };
}

/**
 * A frame is trusted when the next one follows right after it with the same parameters (or the
 * data simply ends there): a stray 0xFFEx in tag or cover-art bytes is not.
 */
function chained(b: Uint8Array, p: number, parse: (b: Uint8Array, p: number) => Frame | null) {
  const first = parse(b, p);
  if (!first) return null;
  const end = p + first.length;
  if (end + 4 >= b.length) return first;
  const next = parse(b, end);
  return next && next.key === first.key ? first : null;
}

function probeFrames(b: Uint8Array, start: number): RateProbe | null {
  const last = Math.min(b.length - 4, start + SYNC_SCAN_LIMIT);
  for (let p = start; p < last; p++) {
    if (b[p] !== 0xff) continue;
    const second = at(b, p + 1);
    if ((second & 0xf6) === 0xf0) {
      const f = chained(b, p, adtsFrame);
      if (f) return { format: 'aac', decodeRate: f.rate };
    } else if ((second & 0xe0) === 0xe0) {
      const f = chained(b, p, mpegFrame);
      if (f) return { format: 'mp3', decodeRate: f.rate };
    }
  }
  return null;
}

// ---------- FLAC ----------

/** 20-bit sample rate of a STREAMINFO block body starting at `o`. */
function streamInfoRate(b: Uint8Array, o: number): number | null {
  if (o + 13 > b.length) return null;
  const rate = (at(b, o + 10) << 12) | (at(b, o + 11) << 4) | (at(b, o + 12) >> 4);
  return rate > 0 ? rate : null;
}

function probeFlac(b: Uint8Array, p: number): RateProbe | null {
  // "fLaC", then the first metadata block, which must be STREAMINFO (type 0, 34 bytes).
  if ((at(b, p + 4) & 0x7f) !== 0) return null;
  const rate = streamInfoRate(b, p + 8);
  return rate ? { format: 'flac', decodeRate: rate } : null;
}

// ---------- Ogg (Vorbis, Opus, Ogg FLAC) ----------

function probeOgg(b: Uint8Array, p: number): RateProbe | null {
  if (p + 28 > b.length) return null;
  const body = p + 27 + at(b, p + 26); // first packet of the first page
  if (at(b, body) === 0x01 && tag(b, body + 1, 'vorbis')) {
    const rate = u32le(b, body + 12);
    return rate > 0 ? { format: 'vorbis', decodeRate: rate } : null;
  }
  if (tag(b, body, 'OpusHead')) {
    const original = u32le(b, body + 12);
    return {
      format: 'opus',
      decodeRate: OPUS_RATE,
      ...(original ? { originalRate: original } : {}),
    };
  }
  if (at(b, body) === 0x7f && tag(b, body + 1, 'FLAC') && tag(b, body + 9, 'fLaC')) {
    const rate = streamInfoRate(b, body + 17);
    return rate ? { format: 'flac', decodeRate: rate } : null;
  }
  return null;
}

// ---------- WebM / Matroska ----------

function probeWebm(b: Uint8Array): RateProbe | null {
  const head = b.subarray(0, 64 * 1024);
  const opus = indexOfBytes(head, ascii('OpusHead'));
  if (opus >= 0) {
    const original = u32le(head, opus + 12);
    return {
      format: 'opus',
      decodeRate: OPUS_RATE,
      ...(original ? { originalRate: original } : {}),
    };
  }
  const vorbis = indexOfBytes(head, [1, ...ascii('vorbis')]);
  if (vorbis >= 0 && u32le(head, vorbis + 7) === 0) {
    const rate = u32le(head, vorbis + 12);
    return rate > 0 ? { format: 'vorbis', decodeRate: rate } : null;
  }
  return null;
}

// ---------- MP4 / M4A ----------

interface Box {
  type: string;
  /** First byte after the box header. */
  body: number;
  end: number;
}

function* boxes(b: Uint8Array, start: number, end: number): Generator<Box> {
  let p = start;
  while (p + 8 <= end) {
    let size = u32be(b, p);
    let header = 8;
    if (size === 1) {
      if (p + 16 > end) return;
      size = u32be(b, p + 8) * 2 ** 32 + u32be(b, p + 12);
      header = 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < header) return;
    const type = String.fromCharCode(at(b, p + 4), at(b, p + 5), at(b, p + 6), at(b, p + 7));
    yield { type, body: p + header, end: Math.min(end, p + size) };
    p += size;
  }
}

const child = (b: Uint8Array, parent: Box, type: string, skip = 0): Box | undefined => {
  for (const box of boxes(b, parent.body + skip, parent.end)) if (box.type === type) return box;
  return undefined;
};

class Bits {
  private pos = 0;
  constructor(
    private readonly b: Uint8Array,
    private readonly start: number,
    private readonly end: number,
  ) {}
  read(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = this.start + (this.pos >> 3);
      if (byte >= this.end) return -1;
      v = v * 2 + ((at(this.b, byte) >> (7 - (this.pos & 7))) & 1);
      this.pos++;
    }
    return v;
  }
}

/** Sampling rate announced by an MPEG-4 AudioSpecificConfig (the SBR output rate if signalled). */
function configRate(b: Uint8Array, start: number, end: number): number | null {
  const bits = new Bits(b, start, end);
  let type = bits.read(5);
  if (type === 31) type = 32 + bits.read(6);
  const rateOf = (): number => {
    const idx = bits.read(4);
    return idx === 15 ? bits.read(24) : (AAC_RATES[idx] ?? -1);
  };
  const base = rateOf();
  if (base <= 0) return null;
  bits.read(4); // channel configuration
  if (type === 5 || type === 29) {
    const extension = rateOf();
    if (extension > 0) return extension;
  }
  return base;
}

/** Walk MPEG-4 descriptors (tag, variable-length size, body) looking for the 0x05 payload. */
function decoderSpecificInfo(b: Uint8Array, start: number, end: number): [number, number] | null {
  let p = start;
  while (p + 2 <= end) {
    const t = at(b, p);
    let size = 0;
    let q = p + 1;
    for (let i = 0; i < 4 && q < end; i++, q++) {
      size = (size << 7) | (at(b, q) & 0x7f);
      if (!(at(b, q) & 0x80)) {
        q++;
        break;
      }
    }
    if (t === 0x05) return [q, Math.min(end, q + size)];
    if (t === 0x03) {
      // ES_Descriptor: ES_ID(2) + flags(1) [+ dependsOn(2)] [+ URL] [+ OCR(2)], then sub-descriptors.
      const flags = at(b, q + 2);
      let inner = q + 3;
      if (flags & 0x80) inner += 2;
      if (flags & 0x40) inner += 1 + at(b, inner);
      if (flags & 0x20) inner += 2;
      p = inner;
      continue;
    }
    if (t === 0x04) {
      p = q + 13; // DecoderConfigDescriptor: 13 fixed bytes, then DecoderSpecificInfo
      continue;
    }
    p = q + size;
  }
  return null;
}

function probeMp4(b: Uint8Array): RateProbe | null {
  const moov = [...boxes(b, 0, b.length)].find((x) => x.type === 'moov');
  if (!moov) return null;
  for (const trak of boxes(b, moov.body, moov.end)) {
    if (trak.type !== 'trak') continue;
    const mdia = child(b, trak, 'mdia');
    const hdlr = mdia && child(b, mdia, 'hdlr');
    if (!mdia || !hdlr || !tag(b, hdlr.body + 8, 'soun')) continue;
    const mdhd = child(b, mdia, 'mdhd');
    const timescale = mdhd ? u32be(b, mdhd.body + (at(b, mdhd.body) === 1 ? 20 : 12)) : 0;
    const minf = child(b, mdia, 'minf');
    const stbl = minf && child(b, minf, 'stbl');
    const stsd = stbl && child(b, stbl, 'stsd');
    // stsd: version/flags(4) + entry count(4), then the sample entries.
    const entry = stsd && boxes(b, stsd.body + 8, stsd.end).next().value;
    if (!entry) return timescale ? { format: 'mp4', decodeRate: timescale } : null;

    // Audio sample entry: reserved(6) dataRef(2) version(2) revision(2) vendor(4) channels(2)
    // sampleSize(2) compressionId(2) packetSize(2) sampleRate(16.16), then child boxes
    // (16 more bytes of fields in QuickTime sound description version 1).
    const version = u16be(b, entry.body + 8);
    const fixed = u32be(b, entry.body + 24) >>> 16;
    const skip = 28 + (version === 1 ? 16 : 0);
    if (entry.type === 'Opus') {
      const dOps = version < 2 ? child(b, entry, 'dOps', skip) : undefined;
      const original = dOps ? u32be(b, dOps.body + 4) : 0;
      return {
        format: 'opus',
        decodeRate: OPUS_RATE,
        ...(original ? { originalRate: original } : {}),
      };
    }
    const esds = version < 2 ? child(b, entry, 'esds', skip) : undefined;
    const dsi = esds && decoderSpecificInfo(b, esds.body + 4, esds.end);
    const fromConfig = dsi ? configRate(b, dsi[0], dsi[1]) : null;
    const rate = fromConfig ?? (fixed || timescale);
    return rate ? { format: 'mp4', decodeRate: rate } : null;
  }
  return null;
}

const MP4_TOP_LEVEL = ['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip', 'styp'];

/**
 * Sample rate stored in the header of an MP3, AAC (ADTS), FLAC, Ogg (Vorbis, Opus, FLAC), WebM
 * (Opus, Vorbis) or MP4/M4A file, or null when the container is unknown or has no readable
 * header. WAV is not handled here: it is decoded exactly in pure JavaScript.
 */
export function probeSampleRate(b: Uint8Array): RateProbe | null {
  const start = skipId3(b);
  if (start + 8 > b.length) return null;
  if (tag(b, start, 'fLaC')) return probeFlac(b, start);
  if (tag(b, start, 'OggS')) return probeOgg(b, start);
  if (bytesEqualAt(b, [0x1a, 0x45, 0xdf, 0xa3], start)) return probeWebm(b);
  if (start === 0 && MP4_TOP_LEVEL.some((t) => tag(b, 4, t))) return probeMp4(b);
  if (tag(b, start, 'RIFF')) return null;
  return probeFrames(b, start);
}

/** What the decoder recorded about a rate, read back from a decoded input. */
export function rateInfoOf(audio: object): RateInfo | undefined {
  const source = (audio as { rateSource?: unknown }).rateSource;
  if (source !== 'file' && source !== 'decoder') return undefined;
  const original = (audio as { originalRate?: unknown }).originalRate;
  return { source, ...(typeof original === 'number' ? { originalRate: original } : {}) };
}
