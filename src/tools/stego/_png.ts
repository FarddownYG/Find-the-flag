import { Unzlib } from 'fflate';
import { concatBytes, latin1Decode, u32be, utf8Decode } from '../../lib/bytes';
import { crc32 } from './_crc32';

export const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export interface PngChunk {
  index: number;
  /** Offset of the 4-byte length field. */
  offset: number;
  type: string;
  length: number;
  dataStart: number;
  crcStored: number;
  crcComputed: number;
  crcOk: boolean;
  /** Type is four ASCII letters, as the spec requires. */
  validType: boolean;
}

export interface PngParse {
  signatureOk: boolean;
  chunks: PngChunk[];
  /** Offset just after the IEND chunk, or null if there is none. */
  iendEnd: number | null;
  /** Human-readable reason the walk stopped early (truncated or corrupt length). */
  problem: string | null;
}

const isLetter = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);

/**
 * Walk the chunk list. Returns null when the bytes do not look like a PNG at all
 * (no signature and no IHDR where it should be). A damaged signature followed by a
 * sane IHDR is still parsed, with `signatureOk: false`.
 */
export function parsePng(bytes: Uint8Array): PngParse | null {
  const signatureOk = PNG_SIGNATURE.every((b, i) => bytes[i] === b);
  const ihdrAt12 =
    bytes[12] === 0x49 && bytes[13] === 0x48 && bytes[14] === 0x44 && bytes[15] === 0x52;
  if (!signatureOk && !ihdrAt12) return null;
  if (bytes.length < 8) return null;
  const chunks: PngChunk[] = [];
  let problem: string | null = null;
  let iendEnd: number | null = null;
  let off = 8;
  while (off < bytes.length) {
    if (off + 12 > bytes.length) {
      problem = `Only ${bytes.length - off} byte(s) left at offset ${off}, not enough for a chunk.`;
      break;
    }
    const length = u32be(bytes, off);
    const typeBytes = bytes.subarray(off + 4, off + 8);
    const type = latin1Decode(typeBytes);
    const validType = typeBytes.every(isLetter);
    if (length > 0x7fffffff || off + 12 + length > bytes.length) {
      problem = `Chunk "${type}" at offset ${off} claims ${length} bytes but only ${Math.max(0, bytes.length - off - 12)} remain (length field corrupt or file truncated).`;
      break;
    }
    const dataStart = off + 8;
    const crcStored = u32be(bytes, dataStart + length);
    const crcComputed = crc32(bytes.subarray(off + 4, dataStart + length));
    chunks.push({
      index: chunks.length,
      offset: off,
      type,
      length,
      dataStart,
      crcStored,
      crcComputed,
      crcOk: crcStored === crcComputed,
      validType,
    });
    off += 12 + length;
    if (type === 'IEND') {
      iendEnd = off;
      break;
    }
  }
  return { signatureOk, chunks, iendEnd, problem };
}

export interface Ihdr {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  compression: number;
  filter: number;
  interlace: number;
}

export function readIhdr(bytes: Uint8Array, dataStart: number): Ihdr {
  return {
    width: u32be(bytes, dataStart),
    height: u32be(bytes, dataStart + 4),
    bitDepth: bytes[dataStart + 8]!,
    colorType: bytes[dataStart + 9]!,
    compression: bytes[dataStart + 10]!,
    filter: bytes[dataStart + 11]!,
    interlace: bytes[dataStart + 12]!,
  };
}

export const COLOR_TYPE_NAMES: Record<number, string> = {
  0: 'grayscale',
  2: 'RGB',
  3: 'indexed (palette)',
  4: 'grayscale + alpha',
  6: 'RGBA',
};

const SAMPLES: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const DEPTHS: Record<number, number[]> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
};

export const validDepthForColor = (depth: number, colorType: number) =>
  DEPTHS[colorType]?.includes(depth) ?? false;

/** Size of the inflated image data the header promises (non-interlaced only), else null. */
export function expectedRawSize(h: Ihdr): number | null {
  const spp = SAMPLES[h.colorType];
  if (!spp || h.interlace !== 0 || !validDepthForColor(h.bitDepth, h.colorType)) return null;
  const rowBytes = Math.ceil((h.width * spp * h.bitDepth) / 8);
  return h.height * (1 + rowBytes);
}

/** Bytes per image row including the filter byte, or null if the header is not usable. */
export function rowSize(h: Ihdr): number | null {
  const spp = SAMPLES[h.colorType];
  if (!spp || !validDepthForColor(h.bitDepth, h.colorType)) return null;
  return 1 + Math.ceil((h.width * spp * h.bitDepth) / 8);
}

/** Number of bytes a zlib stream inflates to, without keeping them. Null if it is invalid. */
export function inflatedSize(zlib: Uint8Array, cap = 1 << 29): number | null {
  let total = 0;
  let failed = false;
  const z = new Unzlib((chunk) => {
    total += chunk.length;
  });
  try {
    for (let i = 0; i < zlib.length && total <= cap; i += 1 << 14) {
      z.push(zlib.subarray(i, i + (1 << 14)), i + (1 << 14) >= zlib.length);
    }
  } catch {
    failed = true;
  }
  return failed || total > cap ? null : total;
}

/** Inflate with an output limit; `truncated` is true when the limit was hit or the stream broke. */
export function inflateCapped(
  zlib: Uint8Array,
  cap = 1 << 20,
): { data: Uint8Array; truncated: boolean } {
  const parts: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  const z = new Unzlib((chunk) => {
    if (total >= cap) {
      truncated = true;
      return;
    }
    const take = chunk.subarray(0, cap - total);
    parts.push(take.slice());
    total += take.length;
    if (take.length < chunk.length) truncated = true;
  });
  try {
    for (let i = 0; i < zlib.length && !truncated; i += 1 << 12) {
      z.push(zlib.subarray(i, i + (1 << 12)), i + (1 << 12) >= zlib.length);
    }
  } catch {
    truncated = true;
  }
  return { data: concatBytes(...parts), truncated };
}

/** Concatenate the payload of every IDAT chunk. */
export function idatData(bytes: Uint8Array, chunks: PngChunk[]): Uint8Array {
  return concatBytes(
    ...chunks
      .filter((c) => c.type === 'IDAT')
      .map((c) => bytes.subarray(c.dataStart, c.dataStart + c.length)),
  );
}

// ---------- text chunks ----------

export interface PngText {
  chunk: 'tEXt' | 'zTXt' | 'iTXt';
  keyword: string;
  text: string;
  note?: string;
}

function indexOfZero(b: Uint8Array, from: number): number {
  for (let i = from; i < b.length; i++) if (b[i] === 0) return i;
  return -1;
}

export function decodeTextChunk(type: string, data: Uint8Array): PngText | null {
  if (type === 'tEXt') {
    const z = indexOfZero(data, 0);
    if (z < 0) return { chunk: 'tEXt', keyword: '', text: latin1Decode(data), note: 'no keyword' };
    return {
      chunk: 'tEXt',
      keyword: latin1Decode(data.subarray(0, z)),
      text: latin1Decode(data.subarray(z + 1)),
    };
  }
  if (type === 'zTXt') {
    const z = indexOfZero(data, 0);
    if (z < 0 || z + 2 > data.length) return null;
    const inflated = inflateCapped(data.subarray(z + 2));
    return {
      chunk: 'zTXt',
      keyword: latin1Decode(data.subarray(0, z)),
      text: latin1Decode(inflated.data),
      note: inflated.truncated
        ? 'compressed data damaged or very large, text is partial'
        : undefined,
    };
  }
  if (type === 'iTXt') {
    const z = indexOfZero(data, 0);
    if (z < 0 || z + 3 > data.length) return null;
    const compressed = data[z + 1] === 1;
    const langEnd = indexOfZero(data, z + 3);
    if (langEnd < 0) return null;
    const transEnd = indexOfZero(data, langEnd + 1);
    if (transEnd < 0) return null;
    const body = data.subarray(transEnd + 1);
    const lang = latin1Decode(data.subarray(z + 3, langEnd));
    const inflated = compressed ? inflateCapped(body) : null;
    return {
      chunk: 'iTXt',
      keyword: utf8Decode(data.subarray(0, z)),
      text: utf8Decode(inflated ? inflated.data : body),
      note:
        [
          lang ? `language ${lang}` : '',
          inflated?.truncated ? 'compressed data damaged, text is partial' : '',
        ]
          .filter(Boolean)
          .join(', ') || undefined,
    };
  }
  return null;
}

/** All text chunks of a parsed PNG. */
export function pngTexts(bytes: Uint8Array, chunks: PngChunk[]): PngText[] {
  const out: PngText[] = [];
  for (const c of chunks) {
    if (c.type !== 'tEXt' && c.type !== 'zTXt' && c.type !== 'iTXt') continue;
    const t = decodeTextChunk(c.type, bytes.subarray(c.dataStart, c.dataStart + c.length));
    if (t) out.push(t);
  }
  return out;
}

/** The tIME chunk as "2024-05-01 12:00:00 UTC", or null when there is none. */
export function pngTime(bytes: Uint8Array, chunks: PngChunk[]): string | null {
  const c = chunks.find((k) => k.type === 'tIME' && k.length === 7);
  if (!c) return null;
  const d = bytes.subarray(c.dataStart, c.dataStart + 7);
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${(d[0]! << 8) | d[1]!}-${p2(d[2]!)}-${p2(d[3]!)} ${p2(d[4]!)}:${p2(d[5]!)}:${p2(d[6]!)} UTC`;
}

// ---------- chunk catalogue ----------

export const KNOWN_CHUNKS: Record<string, string> = {
  IHDR: 'Image header',
  PLTE: 'Palette',
  IDAT: 'Image data',
  IEND: 'End of image',
  tRNS: 'Transparency',
  gAMA: 'Gamma',
  cHRM: 'Chromaticities',
  sRGB: 'sRGB rendering intent',
  iCCP: 'ICC colour profile',
  sBIT: 'Significant bits',
  bKGD: 'Background colour',
  hIST: 'Palette histogram',
  pHYs: 'Physical pixel size',
  sPLT: 'Suggested palette',
  tIME: 'Last modification time',
  tEXt: 'Text (Latin-1)',
  zTXt: 'Compressed text',
  iTXt: 'International text (UTF-8)',
  eXIf: 'EXIF metadata',
  cICP: 'Colour code points',
  mDCV: 'Mastering display colour volume',
  cLLI: 'Content light level',
  acTL: 'APNG animation control',
  fcTL: 'APNG frame control',
  fdAT: 'APNG frame data',
  oFFs: 'Image offset',
  pCAL: 'Pixel calibration',
  sCAL: 'Physical scale',
  sTER: 'Stereo layout',
  gIFg: 'GIF graphic control',
  gIFx: 'GIF application extension',
  CgBI: 'Apple optimised PNG',
  iDOT: 'Apple multi-threaded decode hint',
  vpAg: 'Virtual page (ImageMagick)',
};

/** Check the 'safe' naming bits and printable-ness of a chunk type. */
export function chunkKind(c: PngChunk): {
  known: boolean;
  ancillary: boolean;
  description: string;
} {
  const known = c.type in KNOWN_CHUNKS;
  const ancillary = (c.type.charCodeAt(0) & 0x20) !== 0;
  const description = known
    ? KNOWN_CHUNKS[c.type]!
    : !c.validType
      ? 'Invalid chunk type'
      : (c.type.charCodeAt(1) & 0x20) !== 0
        ? 'Private chunk (not in the PNG spec)'
        : 'Unknown chunk';
  return { known, ancillary, description };
}

// ---------- IHDR repair ----------

export interface IhdrRepair {
  ihdr: Ihdr;
  kind: 'fields' | 'height' | 'width' | 'both';
}

const IHDR_HEAD = [0x49, 0x48, 0x44, 0x52];

function ihdrBytes(h: Ihdr): Uint8Array {
  const b = new Uint8Array(17);
  b.set(IHDR_HEAD, 0);
  const dv = new DataView(b.buffer);
  dv.setUint32(4, h.width);
  dv.setUint32(8, h.height);
  b[12] = h.bitDepth;
  b[13] = h.colorType;
  b[14] = h.compression;
  b[15] = h.filter;
  b[16] = h.interlace;
  return b;
}

export const ihdrCrc = (h: Ihdr) => crc32(ihdrBytes(h));

/**
 * Find the IHDR values that produce the stored CRC. Typical CTF damage: the height (or width)
 * was edited without fixing the CRC, so the picture looks cropped. Search order: other fields
 * with the same size, same width + any height, same height + any width, then both free (CRC is
 * affine, so this is O(n) instead of O(n^2)).
 */
export function bruteForceIhdr(stored: Ihdr, targetCrc: number, limit = 16384): IhdrRepair[] {
  const out: IhdrRepair[] = [];
  const seen = new Set<string>();
  const add = (ihdr: Ihdr, kind: IhdrRepair['kind']) => {
    const key = `${ihdr.width}x${ihdr.height}/${ihdr.bitDepth}/${ihdr.colorType}/${ihdr.interlace}`;
    if (seen.has(key) || out.length >= 50) return;
    seen.add(key);
    out.push({ ihdr, kind });
  };

  for (const colorType of [0, 2, 3, 4, 6]) {
    for (const bitDepth of DEPTHS[colorType]!) {
      for (const interlace of [0, 1]) {
        const cand = { ...stored, bitDepth, colorType, interlace, compression: 0, filter: 0 };
        if (ihdrCrc(cand) === targetCrc) add(cand, 'fields');
      }
    }
  }
  for (let height = 1; height <= 0xffff; height++) {
    if (ihdrCrc({ ...stored, height }) === targetCrc) add({ ...stored, height }, 'height');
  }
  for (let width = 1; width <= 0xffff; width++) {
    if (ihdrCrc({ ...stored, width }) === targetCrc) add({ ...stored, width }, 'width');
  }
  // CRC(w,h) = CRC(w,0) ^ CRC(0,h) ^ CRC(0,0): index every height by its CRC term, then look up.
  const zero = ihdrCrc({ ...stored, width: 0, height: 0 });
  const byTerm = new Map<number, number[]>();
  for (let height = 1; height <= limit; height++) {
    const term = ihdrCrc({ ...stored, width: 0, height });
    const list = byTerm.get(term);
    if (list) list.push(height);
    else byTerm.set(term, [height]);
  }
  for (let width = 1; width <= limit; width++) {
    const wTerm = (ihdrCrc({ ...stored, width, height: 0 }) ^ zero) >>> 0;
    for (const height of byTerm.get((targetCrc ^ wTerm) >>> 0) ?? []) {
      add({ ...stored, width, height }, 'both');
    }
  }
  return out;
}

/** Copy of a PNG with the IHDR rewritten and its CRC recomputed. */
export function withIhdr(bytes: Uint8Array, ihdrChunk: PngChunk, h: Ihdr): Uint8Array {
  const out = bytes.slice();
  const dv = new DataView(out.buffer);
  const at = ihdrChunk.dataStart;
  dv.setUint32(at, h.width);
  dv.setUint32(at + 4, h.height);
  out[at + 8] = h.bitDepth;
  out[at + 9] = h.colorType;
  out[at + 10] = h.compression;
  out[at + 11] = h.filter;
  out[at + 12] = h.interlace;
  dv.setUint32(
    at + ihdrChunk.length,
    crc32(out.subarray(ihdrChunk.offset + 4, at + ihdrChunk.length)),
  );
  if (!PNG_SIGNATURE.every((b, i) => out[i] === b)) out.set(PNG_SIGNATURE, 0);
  return out;
}
