import {
  bytesEqualAt,
  concatBytes,
  indexOfBytes,
  latin1Decode,
  u32le,
  utf8Encode,
} from '../../lib/bytes';
import { identify, SIGNATURES, type Signature } from '../../lib/signatures';
import { carveAll } from '../forensics/carve';
import { imageFileEnd } from './_carve';
import { parseGif, type GifParse } from './_gif';
import { appIdentifier, parseJpeg, type JpegParse } from './_jpeg';
import { parsePng, type PngParse } from './_png';

/** A byte range of the file and what it is ("APP1 Exif", "IDAT chunk", "image data"...). */
export interface Region {
  start: number;
  end: number;
  label: string;
  /** Compressed pixels: signatures found in there are coincidences. */
  imageData: boolean;
}

export interface Layout {
  /** What the file is, from its first bytes. */
  sig: Signature | null;
  isImage: boolean;
  jpeg: JpegParse | null;
  png: PngParse | null;
  gif: GifParse | null;
  /** WebP only. */
  riff: RiffChunk[];
  /** Exclusive end of the image according to its own structure; null when unknown. */
  end: number | null;
  /** The structure says the image goes on past the data we have, or never ends. */
  truncated: boolean;
  regions: Region[];
}

const IMAGE_IDS = new Set([
  'png',
  'jpeg',
  'gif',
  'bmp',
  'webp',
  'tiff-le',
  'tiff-be',
  'heic',
  'avif',
  'ico',
  'psd',
  'qoi',
  'jxl',
]);
const HEIF_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1']);
const HEIC_SIG = SIGNATURES.find((s) => s.id === 'heic') ?? null;

/** Brand of an ISO-BMFF file ("heic", "mif1", "avif"...), or null. */
function heifBrand(b: Uint8Array): string | null {
  if (b.length < 12 || latin1Decode(b.subarray(4, 8)) !== 'ftyp') return null;
  const brand = latin1Decode(b.subarray(8, 12));
  return HEIF_BRANDS.has(brand) || brand === 'avif' || brand === 'avis' ? brand : null;
}

function containerOf(bytes: Uint8Array): Signature | null {
  const brand = heifBrand(bytes);
  const found = identify(bytes).find((s) => !s.valid || s.valid(bytes, 0)) ?? null;
  if (brand && HEIF_BRANDS.has(brand) && found?.id !== 'heic') return HEIC_SIG;
  return found;
}

/** Short label of an APPn segment: "APP1 Exif", "APP1 XMP", "APP13 Photoshop/IPTC"... */
function appLabel(name: string, id: string): string {
  const short = id.startsWith('http://ns.adobe.com/xap/1.0/')
    ? 'XMP'
    : id.startsWith('http://ns.adobe.com/xmp/extension')
      ? 'XMP extension'
      : id.startsWith('Photoshop')
        ? 'Photoshop/IPTC'
        : id === 'ICC_PROFILE'
          ? 'ICC profile'
          : id;
  return short ? `${name} ${short}` : name;
}

const CODING_TABLES: Record<number, string> = {
  0xc4: 'DHT (Huffman tables)',
  0xdb: 'DQT (quantisation tables)',
};

function jpegRegions(b: Uint8Array, j: JpegParse): Region[] {
  const out: Region[] = [];
  for (const s of j.segments) {
    if (s.marker === 0xda) {
      const scanStart = s.dataStart + s.dataLength;
      out.push({ start: s.offset, end: scanStart, label: 'SOS (scan header)', imageData: false });
      out.push({
        start: scanStart,
        end: s.offset + s.length,
        label: 'image data',
        imageData: true,
      });
      continue;
    }
    const label =
      s.marker >= 0xe0 && s.marker <= 0xef
        ? appLabel(s.name, appIdentifier(b, s))
        : s.marker === 0xfe
          ? 'COM (comment)'
          : (CODING_TABLES[s.marker] ?? s.name);
    // Huffman and quantisation tables are bytes of the codec, like the pixels themselves.
    const imageData = s.marker in CODING_TABLES;
    out.push({ start: s.offset, end: s.offset + s.length, label, imageData });
  }
  return out;
}

function pngRegions(p: PngParse): Region[] {
  const out: Region[] = [{ start: 0, end: 8, label: 'PNG signature', imageData: false }];
  for (const c of p.chunks) {
    out.push({
      start: c.offset,
      end: c.dataStart + c.length + 4,
      label: `${c.type} chunk`,
      imageData: c.type === 'IDAT' || c.type === 'fdAT',
    });
  }
  return out;
}

function gifRegions(g: GifParse): Region[] {
  return g.blocks.map((k) => ({
    start: k.offset,
    end: k.offset + k.length,
    label: k.kind,
    imageData: k.kind.startsWith('Image '),
  }));
}

// ---------------------------------------------------------------- WebP (RIFF)

export interface RiffChunk {
  offset: number;
  id: string;
  dataStart: number;
  size: number;
}

/** Top-level chunks of a RIFF/WebP file, stopping at the first one that does not fit. */
function riffChunks(b: Uint8Array): RiffChunk[] {
  const out: RiffChunk[] = [];
  const end = Math.min(b.length, 8 + u32le(b, 4));
  for (let off = 12; off + 8 <= end;) {
    const size = u32le(b, off + 4);
    if (off + 8 + size > b.length) break;
    out.push({ offset: off, id: latin1Decode(b.subarray(off, off + 4)), dataStart: off + 8, size });
    off += 8 + size + (size & 1);
  }
  return out;
}

const u24le = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16);

/** Canvas size of a WebP from its VP8X, VP8L or VP8 chunk. */
export function webpSize(b: Uint8Array, chunks: RiffChunk[]): [number, number] | null {
  for (const c of chunks) {
    const d = c.dataStart;
    if (c.id === 'VP8X' && c.size >= 10) return [1 + u24le(b, d + 4), 1 + u24le(b, d + 7)];
    if (c.id === 'VP8L' && c.size >= 5 && b[d] === 0x2f) {
      const bits = u32le(b, d + 1);
      return [1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff)];
    }
    if (c.id === 'VP8 ' && c.size >= 10 && b[d + 3] === 0x9d && b[d + 4] === 0x01) {
      return [((b[d + 7]! << 8) | b[d + 6]!) & 0x3fff, ((b[d + 9]! << 8) | b[d + 8]!) & 0x3fff];
    }
  }
  return null;
}

/**
 * exifr reads no WebP: give it the EXIF and XMP chunks wrapped in a minimal JPEG (SOI, APP1
 * segments, EOI), which it parses like any photo. Null when there is nothing to wrap.
 */
export function webpMetadataAsJpeg(b: Uint8Array, chunks: RiffChunk[]): Uint8Array | null {
  const app1 = (payload: Uint8Array) =>
    payload.length + 2 <= 0xffff
      ? concatBytes(
          new Uint8Array([0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]),
          payload,
        )
      : new Uint8Array();
  const parts: Uint8Array[] = [];
  for (const c of chunks) {
    const data = b.subarray(c.dataStart, c.dataStart + c.size);
    if (c.id === 'EXIF') {
      const hasHeader = latin1Decode(data.subarray(0, 6)) === 'Exif\0\0';
      parts.push(app1(hasHeader ? data : concatBytes(utf8Encode('Exif\0\0'), data)));
    } else if (c.id === 'XMP ') {
      parts.push(app1(concatBytes(utf8Encode('http://ns.adobe.com/xap/1.0/\0'), data)));
    }
  }
  if (!parts.some((p) => p.length)) return null;
  return concatBytes(new Uint8Array([0xff, 0xd8]), ...parts, new Uint8Array([0xff, 0xd9]));
}

const RIFF_PIXELS = new Set(['VP8 ', 'VP8L', 'ALPH', 'ANMF']);

/** Where the image ends, and a map of its segments / chunks / blocks. */
export function analyseLayout(bytes: Uint8Array): Layout {
  const sig = containerOf(bytes);
  const isImage = sig !== null && IMAGE_IDS.has(sig.id);
  const jpeg = sig?.id === 'jpeg' ? parseJpeg(bytes) : null;
  const png = sig?.id === 'png' ? parsePng(bytes) : null;
  const gif = sig?.id === 'gif' ? parseGif(bytes) : null;
  let end: number | null = null;
  let truncated = false;
  if (sig && (sig.id === 'png' || sig.id === 'jpeg' || sig.id === 'gif')) {
    end = imageFileEnd(bytes, sig.id);
    truncated = end === null;
  } else if (sig?.end && isImage) {
    const e = sig.end(bytes, 0);
    if (e !== null && e > bytes.length) truncated = true;
    else if (e !== null && e > 0) end = e;
  }
  const riff = sig?.id === 'webp' ? riffChunks(bytes) : [];
  const regions = jpeg
    ? jpegRegions(bytes, jpeg)
    : png
      ? pngRegions(png)
      : gif
        ? gifRegions(gif)
        : riff.map((c) => ({
            start: c.offset,
            end: c.dataStart + c.size + (c.size & 1),
            label: `${c.id.trim()} chunk`,
            imageData: RIFF_PIXELS.has(c.id),
          }));
  if (end !== null && end < bytes.length) {
    regions.push({
      start: end,
      end: bytes.length,
      label: 'after the end of the image',
      imageData: false,
    });
  }
  regions.sort((a, c) => a.start - c.start);
  return { sig, isImage, jpeg, png, gif, riff, end, truncated, regions };
}

/**
 * The image format of a file from its first bytes, when it is one this tool reads. Loose: the
 * magic number is enough (triage only sees the start of a file).
 */
export function imageSignature(bytes: Uint8Array): Signature | null {
  if (heifBrand(bytes) && HEIC_SIG) return HEIC_SIG;
  return identify(bytes).find((s) => IMAGE_IDS.has(s.id)) ?? null;
}

/**
 * Carve `sub` out of the region that holds it (the EXIF thumbnail inside its APP1 segment), so
 * that every offset still falls in exactly one region.
 */
export function withRegion(regions: Region[], sub: Region): Region[] {
  const out: Region[] = [];
  for (const r of regions) {
    if (sub.start >= r.start && sub.end <= r.end && sub.end > sub.start) {
      if (sub.start > r.start) out.push({ ...r, end: sub.start });
      out.push(sub);
      if (r.end > sub.end) out.push({ ...r, start: sub.end });
    } else out.push(r);
  }
  return out;
}

/** The region holding `offset`, or null. */
export function regionAt(regions: Region[], offset: number): Region | null {
  let lo = 0;
  let hi = regions.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = regions[mid]!;
    if (offset < r.start) hi = mid - 1;
    else if (offset >= r.end) lo = mid + 1;
    else return r;
  }
  return null;
}

/** Offset of `needle` inside `hay` (full match), or -1. Used to place the EXIF thumbnail. */
export function locate(hay: Uint8Array, needle: Uint8Array): number {
  if (needle.length < 4) return -1;
  const head = needle.subarray(0, Math.min(32, needle.length));
  for (let at = indexOfBytes(hay, head); at >= 0; at = indexOfBytes(hay, head, at + 1)) {
    if (bytesEqualAt(hay, needle, at)) return at;
  }
  return -1;
}

export interface EmbeddedFile {
  start: number;
  end: number;
  sig: Signature;
  how: string;
  where: string;
  truncated: boolean;
}

/** Labels of regions whose TIFF header is just EXIF (or MPF) data, not a hidden file. */
const EXIF_HOLDERS = /Exif|MPF|eXIf|EXIF/;
/** PNG chunks whose payload is a zlib stream by design. */
const COMPRESSED_CHUNK = /^(zTXt|iTXt|iCCP|IDAT|fdAT) chunk$/;
const MAX_EMBEDDED = 200;

/**
 * Files inside the image that its format does not explain: anything after the end, or inside
 * a metadata segment (a ZIP in a comment, a PNG in a text chunk...). The EXIF TIFF header, the
 * EXIF thumbnail (`known` offsets) and coincidences inside compressed pixels are left out, and
 * so are the entries of an archive that was already listed.
 */
export function embeddedFiles(
  bytes: Uint8Array,
  layout: Layout,
  known: number[],
): { files: EmbeddedFile[]; capped: boolean } {
  const { found, container } = carveAll(bytes, { container: false, nested: true, only: new Set() });
  const files: EmbeddedFile[] = [];
  const knownSet = new Set(known);
  // PNG/JPEG/GIF are mapped segment by segment; any other file is one opaque whole up to its end.
  const structured = layout.jpeg !== null || layout.png !== null || layout.gif !== null;
  let covered = !structured && container?.exact ? container.end : 0;
  for (const f of found) {
    if (f.start === 0) continue;
    const region = regionAt(layout.regions, f.start);
    const isTiff = f.sig.id === 'tiff-le' || f.sig.id === 'tiff-be';
    const explained =
      knownSet.has(f.start) ||
      (isTiff && (!structured || (region !== null && EXIF_HOLDERS.test(region.label)))) ||
      (f.sig.ext === 'zlib' && region !== null && COMPRESSED_CHUNK.test(region.label));
    if (explained || region?.imageData) {
      if (f.exact) covered = Math.max(covered, f.end);
      continue;
    }
    if (f.start < covered) continue;
    if (f.exact) covered = Math.max(covered, f.end);
    if (files.length >= MAX_EMBEDDED) return { files, capped: true };
    files.push({
      start: f.start,
      end: f.end,
      sig: f.sig,
      how: f.how,
      where: region?.label ?? (layout.end !== null && f.start >= layout.end ? 'after the end' : ''),
      truncated: f.truncated,
    });
  }
  return { files, capped: false };
}
