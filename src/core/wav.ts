/**
 * WAV (RIFF/WAVE): chunk scanning, codec names, and the codecs decoded exactly in pure
 * JavaScript: PCM 8/16/24/32-bit, IEEE float 32/64, G.711 A-law and µ-law. Other codecs (ADPCM,
 * MP3 in WAV, GSM...) are left to the browser decoder. Pure functions on bytes: they run in the
 * page, in the tool worker and in Node.
 */
import { u16le, u32le } from '../lib/bytes';

export const WAV_PCM = 0x0001;
export const WAV_FLOAT = 0x0003;
export const WAV_ALAW = 0x0006;
export const WAV_MULAW = 0x0007;
const WAV_EXTENSIBLE = 0xfffe;

/** wFormatTag values met in the wild (mmreg.h), named in messages. */
const CODEC_NAMES: Readonly<Record<number, string>> = {
  0x0001: 'PCM',
  0x0002: 'MS ADPCM',
  0x0003: 'IEEE float',
  0x0006: 'A-law',
  0x0007: 'µ-law',
  0x0010: 'OKI ADPCM',
  0x0011: 'IMA ADPCM',
  0x0014: 'G.723 ADPCM',
  0x0020: 'Yamaha ADPCM',
  0x0022: 'TrueSpeech',
  0x0031: 'GSM 6.10',
  0x0040: 'G.721 ADPCM',
  0x0045: 'G.726 ADPCM',
  0x0050: 'MPEG audio',
  0x0055: 'MP3',
  0x0064: 'G.726 ADPCM',
  0x00ff: 'AAC',
  0x0160: 'WMA',
  0x0161: 'WMA',
  0x0162: 'WMA Pro',
  0x0163: 'WMA Lossless',
  0x1600: 'AAC',
  0x1610: 'AAC',
  0x2000: 'AC-3',
  0x2001: 'DTS',
  0xf1ac: 'FLAC',
};

/** "0x0011" */
export const codecHex = (codec: number): string => `0x${codec.toString(16).padStart(4, '0')}`;
export const codecName = (codec: number): string | undefined => CODEC_NAMES[codec];

/** Codecs this module decodes; the others need the browser decoder. */
export const decodableInJs = (codec: number): boolean =>
  codec === WAV_PCM || codec === WAV_FLOAT || codec === WAV_ALAW || codec === WAV_MULAW;

export interface WavFormat {
  /** wFormatTag, or the sub-format of WAVE_FORMAT_EXTENSIBLE. */
  codec: number;
  channels: number;
  rate: number;
  bits: number;
}

export interface WavScan {
  /** The "fmt " chunk, when one was found before "data" (or before the end of the bytes). */
  fmt: WavFormat | null;
  /** The "data" chunk body: [start, end), end clamped to the bytes present. */
  data: [number, number] | null;
}

export const isRiffWave = (b: Uint8Array): boolean =>
  b[0] === 0x52 &&
  b[1] === 0x49 &&
  b[2] === 0x46 &&
  b[3] === 0x46 &&
  b[8] === 0x57 &&
  b[9] === 0x41 &&
  b[10] === 0x56 &&
  b[11] === 0x45;

/**
 * Walk the RIFF chunks up to "data". Never throws: a truncated or partial file (e.g. only its
 * first kilobytes) gives what could be read. Null when the bytes are not a RIFF/WAVE file.
 */
export function scanWav(b: Uint8Array): WavScan | null {
  if (b.length < 12 || !isRiffWave(b)) return null;
  let fmt: WavFormat | null = null;
  let p = 12;
  while (p + 8 <= b.length) {
    const id = String.fromCharCode(b[p]!, b[p + 1]!, b[p + 2]!, b[p + 3]!);
    const size = u32le(b, p + 4);
    const body = p + 8;
    if (id === 'fmt ' && body + 16 <= b.length) {
      let codec = u16le(b, body);
      // WAVE_FORMAT_EXTENSIBLE: the codec is the first two bytes of the sub-format GUID.
      if (codec === WAV_EXTENSIBLE && size >= 26 && body + 26 <= b.length) {
        codec = u16le(b, body + 24);
      }
      fmt = {
        codec,
        channels: u16le(b, body + 2),
        rate: u32le(b, body + 4),
        bits: u16le(b, body + 14),
      };
    } else if (id === 'data') {
      return { fmt, data: [body, Math.min(b.length, body + size)] };
    }
    p = body + size + (size & 1);
  }
  return { fmt, data: null };
}

// ---------- G.711 ----------

/** ITU-T G.711 A-law code to 16-bit linear (the classic Sun g711.c, also ffmpeg's). */
export function alawToLinear(code: number): number {
  const a = (code & 0xff) ^ 0x55;
  const seg = (a & 0x70) >> 4;
  let v = (a & 0x0f) << 4;
  v += seg === 0 ? 8 : 0x108;
  if (seg > 1) v <<= seg - 1;
  return a & 0x80 ? v : -v;
}

/** ITU-T G.711 µ-law code to 16-bit linear. */
export function mulawToLinear(code: number): number {
  const u = ~code & 0xff;
  const v = (((u & 0x0f) << 3) + 0x84) << ((u & 0x70) >> 4);
  return u & 0x80 ? 0x84 - v : v - 0x84;
}

const g711Tables = new Map<number, Float32Array>();
function g711Table(codec: number): Float32Array {
  let table = g711Tables.get(codec);
  if (!table) {
    const f = codec === WAV_ALAW ? alawToLinear : mulawToLinear;
    table = Float32Array.from({ length: 256 }, (_, i) => f(i) / 32768);
    g711Tables.set(codec, table);
  }
  return table;
}

// ---------- samples ----------

const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/**
 * Bytes per sample of a codec decoded here, or 0 when the layout is not one (e.g. 12-bit PCM).
 * G.711 is always one byte per sample, whatever the header says.
 */
export function sampleBytes(f: WavFormat): number {
  if (f.codec === WAV_ALAW || f.codec === WAV_MULAW) return 1;
  const n = f.bits / 8;
  if (!Number.isInteger(n)) return 0;
  if (f.codec === WAV_FLOAT) return n === 4 || n === 8 ? n : 0;
  return n >= 1 && n <= 4 ? n : 0;
}

/** A typed view over `d` when it is aligned, else over an aligned copy. */
function view<T>(
  d: Uint8Array,
  size: number,
  count: number,
  make: (b: ArrayBuffer, o: number, n: number) => T,
): T {
  if (d.byteOffset % size === 0) return make(d.buffer as ArrayBuffer, d.byteOffset, count);
  return make(d.slice(0, count * size).buffer, 0, count);
}

/**
 * De-interleave the "data" bytes of a codec decoded here into one Float32Array per channel, in
 * [-1, 1). The caller checks `sampleBytes(f) > 0` and `f.channels > 0`.
 */
export function decodeSamples(d: Uint8Array, f: WavFormat): Float32Array[] {
  const per = sampleBytes(f);
  const nCh = f.channels;
  const frames = Math.floor(d.length / (per * nCh));
  const n = frames * nCh;
  const out = Array.from({ length: nCh }, () => new Float32Array(frames));
  // Interleaved source values for one sample index; `at(k)` reads value k as a float.
  let at: (k: number) => number;
  if (f.codec === WAV_ALAW || f.codec === WAV_MULAW) {
    const table = g711Table(f.codec);
    at = (k) => table[d[k]!]!;
  } else if (per === 1) {
    at = (k) => (d[k]! - 128) / 128;
  } else if (per === 3) {
    at = (k) => {
      const o = k * 3;
      return (((d[o]! | (d[o + 1]! << 8) | (d[o + 2]! << 16)) << 8) >> 8) / 8388608;
    };
  } else if (!LITTLE_ENDIAN) {
    const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
    at =
      f.codec === WAV_FLOAT
        ? per === 4
          ? (k) => dv.getFloat32(k * 4, true)
          : (k) => dv.getFloat64(k * 8, true)
        : per === 2
          ? (k) => dv.getInt16(k * 2, true) / 32768
          : (k) => dv.getInt32(k * 4, true) / 2147483648;
  } else {
    // Typed views: the fast path (a 10-minute stereo file in a fraction of a second).
    const src =
      f.codec === WAV_FLOAT
        ? per === 4
          ? view(d, 4, n, (b, o, c) => new Float32Array(b, o, c))
          : view(d, 8, n, (b, o, c) => new Float64Array(b, o, c))
        : per === 2
          ? view(d, 2, n, (b, o, c) => new Int16Array(b, o, c))
          : view(d, 4, n, (b, o, c) => new Int32Array(b, o, c));
    const scale = f.codec === WAV_FLOAT ? 1 : per === 2 ? 1 / 32768 : 1 / 2147483648;
    for (let c = 0; c < nCh; c++) {
      const ch = out[c]!;
      for (let i = 0, k = c; i < frames; i++, k += nCh) ch[i] = src[k]! * scale;
    }
    return out;
  }
  for (let c = 0; c < nCh; c++) {
    const ch = out[c]!;
    for (let i = 0, k = c; i < frames; i++, k += nCh) ch[i] = at(k);
  }
  return out;
}
