import { isValidUtf8, latin1Decode, latin1Encode, u16be, utf8Decode } from '../../lib/bytes';
import {
  bytesOfLike,
  decodeUserComment,
  errorText,
  exifr,
  fmtValue,
  hasControl,
  isRecord,
  PARSE_OPTIONS,
  positionProblem,
  readTiff,
  tiffGroups,
  toDecimal,
  type TiffGroups,
} from './_exif';
import type { Layout } from './_image-analyzer-layout';
import { isSof, jpegComments } from './_jpeg';
import { pngTexts, pngTime } from './_png';

/** One line of the flat metadata table. */
export interface MetaRow {
  group: string;
  tag: string;
  value: string;
}

/** An EXIF (TIFF) block of the file, read with our own IFD walker. */
export interface ExifBlock {
  /** Where it sits: "APP1 at 0x14", "eXIf chunk at 0x21"... */
  where: string;
  /** Absolute offset of the TIFF header in the file. */
  offset: number;
  groups: TiffGroups['groups'];
  /** What did not add up (truncated IFD, value outside the block...), in plain words. */
  problems: string[];
  /** IFD1 thumbnail with its offset in the file, or why it could not be read. */
  thumbnail: { data: Uint8Array; offset: number } | { error: string } | null;
}

export interface ImageMeta {
  rows: MetaRow[];
  /** EXIF-side groups of the first EXIF block (ifd0, exif, gps, ifd1) plus exifr's iptc, icc... */
  exif: Record<string, Record<string, unknown>>;
  /** XMP properties by namespace prefix (dc, xmp, photoshop, tiff, exif...). */
  xmp: Record<string, Record<string, unknown>>;
  /** Reader problems worth telling the user (unreadable XMP, unknown format...). */
  errors: string[];
  /** Every EXIF block found; the first is the one other software reads. */
  blocks: ExifBlock[];
  /**
   * IFD1 thumbnail of the first block (absolute offset), why it could not be read, or undefined
   * when no block could be walked (HEIC...) and exifr has to find it.
   */
  thumbnail: { data: Uint8Array; offset: number } | { error: string } | null | undefined;
}

export type Structure = Pick<Layout, 'sig' | 'jpeg' | 'png' | 'gif' | 'riff'> & {
  /** Width x height when the container says so (WebP canvas). */
  size?: [number, number] | null;
};

/** exifr group -> name in the table. Everything else exifr returns is an XMP namespace. */
const EXIF_GROUPS: Record<string, string> = {
  jfif: 'JFIF',
  ifd0: 'IFD0',
  exif: 'ExifIFD',
  gps: 'GPS',
  interop: 'Interop',
  ifd1: 'IFD1',
  iptc: 'IPTC',
  icc: 'ICC',
  ihdr: 'PNG IHDR',
};
const TIFF_GROUPS = new Set(['ifd0', 'exif', 'gps', 'interop', 'ifd1']);
const GROUP_ORDER = [
  'File',
  'JFIF',
  'IFD0',
  'ExifIFD',
  'GPS',
  'Interop',
  'IFD1',
  'IPTC',
  'XMP',
  'ICC',
  'PNG IHDR',
  'PNG text',
  'PNG tIME',
  'JPEG comment',
  'GIF comment',
];
/** exifr folds the XMP tiff:/exif: namespaces into its EXIF group names: undo that. */
const XMP_NS_OF_GROUP: Record<string, string> = {
  ifd0: 'tiff',
  ifd1: 'tiff',
  exif: 'exif',
  gps: 'exif',
};
/** exifr puts PNG text chunks into "ihdr" too; only these keys are the real header. */
const IHDR_KEYS = new Set([
  'ImageWidth',
  'ImageHeight',
  'BitDepth',
  'ColorType',
  'Compression',
  'Filter',
  'Interlace',
]);

const NO_TIFF = {
  tiff: false,
  ifd0: false,
  ifd1: false,
  exif: false,
  gps: false,
  interop: false,
};
const XMP_OPTIONS = {
  ...PARSE_OPTIONS,
  ...NO_TIFF,
  iptc: false,
  icc: false,
  jfif: false,
  ihdr: false,
  userComment: false,
  xmp: true,
};

/** A reader message in one line, without the debug dump some of them carry. */
function plainError(e: unknown): string {
  const first = errorText(e).split('\n')[0]!.trim();
  const brace = first.search(/[{[]/);
  return (brace > 20 ? first.slice(0, brace) : first).replace(/[\s:.]+$/, '');
}

/** Run exifr; a reader failure is reported, never thrown (corrupt files are the norm in CTFs). */
async function parseWith(
  bytes: Uint8Array,
  options: Record<string, unknown>,
  errors: string[],
): Promise<Record<string, unknown>> {
  let raw: unknown;
  try {
    raw = await exifr.parse(bytes, options);
  } catch (e) {
    const msg = plainError(e);
    if (!/unknown file format/i.test(msg)) errors.push(msg);
    return {};
  }
  if (!isRecord(raw)) return {};
  const { errors: found, ...rest } = raw;
  if (Array.isArray(found)) for (const e of found) errors.push(plainError(e));
  return rest;
}

// ---------------------------------------------------------------- value formatting

const pad2 = (n: number) => String(Math.floor(n)).padStart(2, '0');

/** [48, 51, 30.24] -> 48° 51′ 30.24″ */
function dmsText(v: unknown): string | null {
  if (typeof v === 'number') v = [v];
  if (!Array.isArray(v) || !v.length || !v.every((x) => typeof x === 'number')) return null;
  const [d = 0, m = 0, s = 0] = v as number[];
  const num = (x: number) => String(Math.round(x * 1e4) / 1e4);
  return `${num(d)}° ${num(m)}′ ${num(s)}″`;
}

function timeText(v: unknown): string | null {
  if (!Array.isArray(v) || v.length < 3 || !v.every((x) => typeof x === 'number')) return null;
  const [h = 0, m = 0, s = 0] = v as number[];
  const frac = s % 1 ? (s % 1).toFixed(3).slice(1) : '';
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}${frac}`;
}

const firstNumber = (v: unknown): number | null => {
  if (typeof v === 'number') return v;
  const b = bytesOfLike(v);
  if (b && b.length) return b[0]!;
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
  return null;
};

const NORTH_REF: Record<string, string> = { T: 'true north', M: 'magnetic north' };
const SPEED_REF: Record<string, string> = { K: 'km/h', M: 'mph', N: 'knots' };
const COMPRESSION: Record<number, string> = {
  1: 'uncompressed',
  5: 'LZW',
  6: 'JPEG (old-style)',
  7: 'JPEG',
  8: 'Deflate',
  32773: 'PackBits',
  34892: 'lossy JPEG',
};
const COLOR_SPACE: Record<number, string> = { 1: 'sRGB', 2: 'Adobe RGB', 65535: 'Uncalibrated' };
const JFIF_UNITS: Record<number, string> = {
  0: 'none (pixel aspect ratio only)',
  1: 'dots per inch',
  2: 'dots per cm',
};

type Formatter = (v: unknown, group: string) => string | null;

const withMeaning = (table: Record<string, string>) => (v: unknown) =>
  typeof v === 'string' && table[v] ? `${v} (${table[v]})` : null;

const SPECIAL: Record<string, Formatter> = {
  GPSVersionID: (v) => {
    const b = bytesOfLike(v);
    return b ? Array.from(b).join('.') : null;
  },
  GPSAltitudeRef: (v) => {
    const n = firstNumber(v);
    return n === null ? null : `${n} (${n === 1 ? 'below' : 'above'} sea level)`;
  },
  GPSLatitude: dmsText,
  GPSLongitude: dmsText,
  GPSDestLatitude: dmsText,
  GPSDestLongitude: dmsText,
  GPSTimeStamp: (v) => {
    const t = timeText(v);
    return t ? `${t} UTC` : null;
  },
  GPSSpeedRef: withMeaning(SPEED_REF),
  GPSImgDirectionRef: withMeaning(NORTH_REF),
  GPSTrackRef: withMeaning(NORTH_REF),
  GPSDestBearingRef: withMeaning(NORTH_REF),
  GPSProcessingMethod: (v) => {
    const b = bytesOfLike(v);
    return b ? decodeUserComment(b) : null;
  },
  GPSAreaInformation: (v) => {
    const b = bytesOfLike(v);
    return b ? decodeUserComment(b) : null;
  },
  Compression: (v) => (typeof v === 'number' && COMPRESSION[v] ? COMPRESSION[v] : null),
  ColorSpace: (v) => (typeof v === 'number' && COLOR_SPACE[v] ? COLOR_SPACE[v] : null),
  JFIFVersion: (v) => (typeof v === 'number' ? `${v >> 8}.${pad2(v & 0xff)}` : null),
  ResolutionUnit: (v, group) =>
    group === 'jfif' && typeof v === 'number' ? (JFIF_UNITS[v] ?? null) : null,
};

const isPrintable = (b: Uint8Array) => b.every((x) => x >= 0x20 && x < 0x7f);

type LangAlt = { lang: string; value: string };
const isLangAlt = (v: unknown): v is LangAlt =>
  isRecord(v) &&
  typeof v.value === 'string' &&
  typeof v.lang === 'string' &&
  Object.keys(v).length === 2;

/** XMP rdf:Alt: the default language first, the others labelled. */
function langAltText(items: LangAlt[]): string {
  const sorted = [...items].sort(
    (a, b) => Number(b.lang === 'x-default') - Number(a.lang === 'x-default'),
  );
  return sorted
    .map((x) => (x.lang === 'x-default' ? x.value : `[${x.lang}] ${x.value}`))
    .join(' | ');
}

/** Human-readable value: rationals as numbers, enums decoded, dates as written, binary as hex. */
function formatValue(group: string, tag: string, v: unknown): string {
  if (isLangAlt(v)) return langAltText([v]);
  if (Array.isArray(v) && v.length && v.every(isLangAlt)) return langAltText(v);
  const special = SPECIAL[tag]?.(v, group);
  if (special) return special;
  if (typeof v === 'string') {
    const s = v.replace(/\0+$/g, '');
    return hasControl(s) ? fmtValue(tag, latin1Encode(s)) : s;
  }
  const b = bytesOfLike(v);
  if (b && b.length && b.length <= 64 && isPrintable(b) && !/^(XP|UserComment)/.test(tag)) {
    return String.fromCharCode(...b);
  }
  return fmtValue(tag, v);
}

// ---------------------------------------------------------------- collection

/** Flatten a group object (XMP values can nest) into rows. */
function flattenInto(
  out: MetaRow[],
  group: string,
  exifrGroup: string,
  prefix: string,
  value: unknown,
  depth = 0,
): void {
  if (isRecord(value) && !isLangAlt(value) && depth < 6) {
    for (const [k, v] of Object.entries(value)) {
      flattenInto(out, group, exifrGroup, prefix ? `${prefix}.${k}` : k, v, depth + 1);
    }
    return;
  }
  // XMP lists of structures (xmpMM:History...): one row per field rather than a JSON blob.
  if (Array.isArray(value) && value.length && value.every(isRecord) && !value.every(isLangAlt)) {
    value.forEach((v, i) =>
      flattenInto(out, group, exifrGroup, `${prefix}[${i + 1}]`, v, depth + 1),
    );
    return;
  }
  const leaf = prefix.split(/[.:]/).pop() ?? prefix;
  const text = formatValue(exifrGroup, leaf.replace(/\[\d+\]$/, ''), value);
  if (text !== '') out.push({ group, tag: prefix, value: text });
}

function dimensions(bytes: Uint8Array, s: Structure, exif: ImageMeta['exif']): string | null {
  if (s.png) {
    const ihdr = s.png.chunks.find((c) => c.type === 'IHDR' && c.length >= 8);
    if (ihdr) {
      const d = new DataView(bytes.buffer, bytes.byteOffset + ihdr.dataStart, 8);
      return `${d.getUint32(0)}x${d.getUint32(4)}`;
    }
  }
  if (s.jpeg) {
    const sof = s.jpeg.segments.find((g) => isSof(g.marker) && g.dataLength >= 5);
    if (sof) return `${u16be(bytes, sof.dataStart + 3)}x${u16be(bytes, sof.dataStart + 1)}`;
  }
  if (s.gif) return `${s.gif.width}x${s.gif.height}`;
  if (s.size) return `${s.size[0]}x${s.size[1]}`;
  const w = exif.ifd0?.ImageWidth ?? exif.exif?.ExifImageWidth;
  const h = exif.ifd0?.ImageHeight ?? exif.exif?.ExifImageHeight;
  return typeof w === 'number' && typeof h === 'number' ? `${w}x${h}` : null;
}

const hex = (n: number) => `0x${n.toString(16)}`;

/** Every TIFF block of the file: JPEG APP1 "Exif", PNG eXIf, WebP EXIF, or the file itself. */
function findTiffBlocks(bytes: Uint8Array, s: Structure): { where: string; offset: number }[] {
  const out: { where: string; offset: number }[] = [];
  if (s.sig?.id === 'tiff-le' || s.sig?.id === 'tiff-be')
    return [{ where: 'the TIFF file', offset: 0 }];
  const withHeader = (at: number) =>
    latin1Decode(bytes.subarray(at, at + 6)) === 'Exif\0\0' ? at + 6 : at;
  for (const seg of s.jpeg?.segments ?? []) {
    if (
      seg.marker !== 0xe1 ||
      latin1Decode(bytes.subarray(seg.dataStart, seg.dataStart + 4)) !== 'Exif'
    )
      continue;
    out.push({ where: `APP1 at ${hex(seg.offset)}`, offset: seg.dataStart + 6 });
  }
  for (const c of s.png?.chunks ?? []) {
    if (c.type === 'eXIf')
      out.push({ where: `eXIf chunk at ${hex(c.offset)}`, offset: withHeader(c.dataStart) });
  }
  for (const c of s.riff) {
    if (c.id === 'EXIF')
      out.push({ where: `EXIF chunk at ${hex(c.offset)}`, offset: withHeader(c.dataStart) });
  }
  return out;
}

function blockEnd(bytes: Uint8Array, s: Structure, offset: number): number {
  const seg = s.jpeg?.segments.find((g) => g.dataStart + 6 === offset);
  if (seg) return seg.dataStart + seg.dataLength;
  const chunk = s.png?.chunks.find((c) => offset >= c.dataStart && offset <= c.dataStart + 6);
  if (chunk) return Math.min(bytes.length, chunk.dataStart + chunk.length);
  const riff = s.riff.find((c) => offset >= c.dataStart && offset <= c.dataStart + 6);
  if (riff) return Math.min(bytes.length, riff.dataStart + riff.size);
  return bytes.length;
}

function readBlocks(bytes: Uint8Array, s: Structure): ExifBlock[] {
  const out: ExifBlock[] = [];
  for (const { where, offset } of findTiffBlocks(bytes, s)) {
    const t = bytes.subarray(offset, blockEnd(bytes, s, offset));
    const read = readTiff(t);
    if (!read) {
      const problem =
        t.length < 4
          ? `the EXIF block (${where}) is cut before its TIFF header.`
          : `the EXIF block (${where}) does not start with a TIFF header (II*\\0 or MM\\0*).`;
      out.push({ where, offset, groups: {}, problems: [problem], thumbnail: null });
      continue;
    }
    const { groups, thumbnail } = tiffGroups(read, t);
    out.push({
      where,
      offset,
      groups,
      problems: read.problems,
      thumbnail:
        thumbnail && 'data' in thumbnail
          ? { data: thumbnail.data, offset: offset + thumbnail.offset }
          : thumbnail,
    });
  }
  return out;
}

/**
 * IPTC record 1:90 (coded character set): 'utf8' for ESC % G, 'other' for anything else, null
 * when absent. exifr reads only record 2, and decodes it as Latin-1.
 */
function iptcCharset(bytes: Uint8Array, s: Structure): 'utf8' | 'other' | null {
  for (const seg of s.jpeg?.segments ?? []) {
    if (seg.marker !== 0xed) continue;
    const d = bytes.subarray(seg.dataStart, seg.dataStart + seg.dataLength);
    for (let i = 0; i + 5 <= d.length; i++) {
      if (d[i] === 0x1c && d[i + 1] === 1 && d[i + 2] === 90) {
        const n = (d[i + 3]! << 8) | d[i + 4]!;
        const utf8 = n === 3 && d[i + 5] === 0x1b && d[i + 6] === 0x25 && d[i + 7] === 0x47;
        return utf8 ? 'utf8' : 'other';
      }
    }
  }
  return null;
}

/** Latin-1 text with at least one byte above 0x7F: what exifr makes of UTF-8 IPTC bytes. */
function highLatin1(v: string): boolean {
  let high = false;
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c > 0xff) return false;
    if (c > 0x7f) high = true;
  }
  return high;
}

/** Redo exifr's Latin-1 IPTC strings as UTF-8, unless 1:90 names another character set. */
function recodeIptc(v: unknown, charset: 'utf8' | 'other' | null): unknown {
  if (Array.isArray(v)) return v.map((x) => recodeIptc(x, charset));
  if (charset === 'other' || typeof v !== 'string' || !highLatin1(v)) return v;
  const b = latin1Encode(v);
  return isValidUtf8(b) ? utf8Decode(b) : v;
}

/**
 * Every metadata field of the file as flat rows. EXIF comes from our own IFD walker (every
 * block, damaged ones included); IPTC/ICC/JFIF/XMP from exifr, XMP in a pass of its own because
 * exifr merges XMP tiff:/exif: properties into the EXIF groups otherwise.
 */
export async function readMetadata(
  bytes: Uint8Array,
  structure: Structure,
  file: { type: string | null; size: number },
  /** What exifr reads, when it is not the file itself (WebP metadata wrapped as a JPEG). */
  exifSource: Uint8Array = bytes,
): Promise<ImageMeta> {
  const errors: string[] = [];
  const blocks = readBlocks(bytes, structure);
  const isTiff = structure.sig?.id === 'tiff-le' || structure.sig?.id === 'tiff-be';
  // Our walker reads the EXIF; exifr still has to walk a TIFF file to find its IPTC/ICC tags.
  const exifOptions =
    blocks.length && !isTiff
      ? { ...PARSE_OPTIONS, ...NO_TIFF, xmp: false }
      : { ...PARSE_OPTIONS, xmp: false };
  const exifErrors: string[] = [];
  const rawExif = await parseWith(exifSource, exifOptions, blocks.length ? exifErrors : errors);
  // A TIFF file's own damage is already described by the walker.
  if (!isTiff) errors.push(...exifErrors);
  const rawXmp = await parseWith(exifSource, XMP_OPTIONS, errors);

  const exif: ImageMeta['exif'] = {};
  let userComment: unknown;
  for (const [name, value] of Object.entries(rawExif)) {
    if (blocks.length && (TIFF_GROUPS.has(name) || name === 'userComment' || name === 'makerNote'))
      continue;
    if (name === 'userComment') userComment = value;
    else if (isRecord(value)) exif[name] = value;
  }
  if (userComment !== undefined) {
    const b = bytesOfLike(userComment);
    const text = b ? decodeUserComment(b) : typeof userComment === 'string' ? userComment : '';
    exif.exif = { ...exif.exif, UserComment: text };
  }
  const first = blocks[0];
  if (first) for (const [name, g] of Object.entries(first.groups)) exif[name] = g;
  if (exif.ihdr) {
    exif.ihdr = Object.fromEntries(Object.entries(exif.ihdr).filter(([k]) => IHDR_KEYS.has(k)));
  }
  const charset = exif.iptc ? iptcCharset(bytes, structure) : null;
  if (exif.iptc) {
    exif.iptc = Object.fromEntries(
      Object.entries(exif.iptc).map(([k, v]) => [k, recodeIptc(v, charset)]),
    );
  }
  const xmp: ImageMeta['xmp'] = {};
  for (const [name, value] of Object.entries(rawXmp)) {
    if (!isRecord(value)) continue;
    const ns = XMP_NS_OF_GROUP[name] ?? name;
    xmp[ns] = { ...xmp[ns], ...value };
  }

  const rows: MetaRow[] = [];
  const dims = dimensions(bytes, structure, exif);
  rows.push({ group: 'File', tag: 'Type', value: file.type ?? 'unknown' });
  rows.push({ group: 'File', tag: 'Size', value: `${file.size} bytes` });
  if (dims) rows.push({ group: 'File', tag: 'Dimensions', value: dims });

  for (const [name, value] of Object.entries(exif)) {
    const group = EXIF_GROUPS[name] ?? name;
    for (const [tag, v] of Object.entries(value)) {
      // exifr's own decimal conversion: GPS details shows ours, computed from the refs.
      if (name === 'gps' && (tag === 'latitude' || tag === 'longitude')) continue;
      flattenInto(rows, group, name, tag, v);
    }
  }
  if (charset === 'utf8') {
    rows.push({ group: 'IPTC', tag: 'CodedCharacterSet', value: 'UTF-8 (ESC % G)' });
  }
  // Further EXIF blocks: most software reads only the first one, which makes them a hiding place.
  blocks.slice(1).forEach((b, i) => {
    for (const [name, value] of Object.entries(b.groups)) {
      const group = `EXIF #${i + 2} ${EXIF_GROUPS[name] ?? name}`;
      for (const [tag, v] of Object.entries(value)) flattenInto(rows, group, name, tag, v);
    }
  });
  for (const [ns, value] of Object.entries(xmp)) {
    for (const [tag, v] of Object.entries(value))
      flattenInto(rows, 'XMP', 'xmp', `${ns}:${tag}`, v);
  }

  if (structure.png) {
    const hasXmp = Object.keys(xmp).length > 0;
    for (const t of pngTexts(bytes, structure.png.chunks)) {
      if (hasXmp && t.keyword === 'XML:com.adobe.xmp') continue;
      rows.push({
        group: 'PNG text',
        tag: `${t.chunk} ${t.keyword}`.trim(),
        value: t.note ? `${t.text} (${t.note})` : t.text,
      });
    }
    const time = pngTime(bytes, structure.png.chunks);
    if (time) rows.push({ group: 'PNG tIME', tag: 'Modified', value: time });
  }
  if (structure.jpeg) {
    const comments = jpegComments(bytes, structure.jpeg);
    comments.forEach((c, i) =>
      rows.push({
        group: 'JPEG comment',
        tag: comments.length > 1 ? `Comment ${i + 1}` : 'Comment',
        value: c,
      }),
    );
  }
  const gif = structure.gif;
  if (gif) {
    gif.comments.forEach((c, i) =>
      rows.push({
        group: 'GIF comment',
        tag: gif.comments.length > 1 ? `Comment ${i + 1}` : 'Comment',
        value: c,
      }),
    );
  }

  const rank = (g: string) => {
    const i = GROUP_ORDER.indexOf(g.replace(/^EXIF #\d+ /, ''));
    const extra = g.startsWith('EXIF #') ? 0.5 : 0;
    return (i < 0 ? GROUP_ORDER.length : i) + extra;
  };
  rows.sort((a, b) => rank(a.group) - rank(b.group));
  const thumbnail = first ? first.thumbnail : undefined;
  return { rows, exif, xmp, errors: [...new Set(errors)], blocks, thumbnail };
}

// ---------------------------------------------------------------- GPS

export interface GpsFix {
  lat: number;
  lon: number;
  /** Why this is not a usable position: 0, 0 (an empty fix) or numbers off the globe. */
  problem: 'zero' | 'range' | null;
  source: string;
  /** Hemisphere references the file lacks (N / E assumed): "GPSLatitudeRef"... */
  missingRefs: string[];
}

export interface GpsInfo extends GpsFix {
  valid: boolean;
  details: [string, string][];
  /** Other positions in the file (XMP, a further EXIF block) that are not the same place. */
  others: GpsFix[];
}

const EXIF_GPS = 'EXIF GPS IFD';
const XMP_GPS = 'XMP exif:GPSLatitude / exif:GPSLongitude';

function fixOf(g: Record<string, unknown>, source: string): GpsFix | null {
  let lat = toDecimal(g.GPSLatitude, g.GPSLatitudeRef);
  let lon = toDecimal(g.GPSLongitude, g.GPSLongitudeRef);
  if ((!lat || !lon) && typeof g.latitude === 'number' && typeof g.longitude === 'number') {
    lat = { value: g.latitude, hemisphere: true };
    lon = { value: g.longitude, hemisphere: true };
  }
  if (!lat || !lon) return null;
  const missingRefs = [
    ...(lat.hemisphere ? [] : ['GPSLatitudeRef']),
    ...(lon.hemisphere ? [] : ['GPSLongitudeRef']),
  ];
  return {
    lat: lat.value,
    lon: lon.value,
    problem: positionProblem(lat.value, lon.value),
    source,
    missingRefs,
  };
}

const samePlace = (a: GpsFix, b: GpsFix) =>
  Math.abs(a.lat - b.lat) < 1e-5 && Math.abs(a.lon - b.lon) < 1e-5;

const fmtNum = (n: number) => String(Math.round(n * 1000) / 1000);

/**
 * GPS position and details from the EXIF GPS IFD, else from XMP exif:GPSLatitude/Longitude,
 * else from a further EXIF block; every other position that disagrees is listed too.
 */
export function readGps(meta: ImageMeta): GpsInfo | null {
  const g = meta.exif.gps ?? {};
  const xe = meta.xmp.exif ?? {};
  const candidates = [
    fixOf(g, EXIF_GPS),
    fixOf(xe, XMP_GPS),
    ...meta.blocks
      .slice(1)
      .map((b, i) => (b.groups.gps ? fixOf(b.groups.gps, `EXIF #${i + 2} GPS IFD`) : null)),
  ].filter((f): f is GpsFix => f !== null);
  const primary = candidates[0];
  if (!primary) return null;
  const others: GpsFix[] = [];
  for (const c of candidates.slice(1)) {
    if (!samePlace(c, primary) && !others.some((o) => samePlace(o, c))) others.push(c);
  }
  const src =
    primary.source === XMP_GPS
      ? xe
      : primary.source === EXIF_GPS
        ? g
        : (meta.blocks.find((_, i) => primary.source === `EXIF #${i + 1} GPS IFD`)?.groups.gps ??
          {});
  const details: [string, string][] = [
    ['Latitude', primary.lat.toFixed(6)],
    ['Longitude', primary.lon.toFixed(6)],
  ];
  const rawLat =
    dmsText(src.GPSLatitude) ?? (typeof src.GPSLatitude === 'string' ? src.GPSLatitude : null);
  const rawLon =
    dmsText(src.GPSLongitude) ?? (typeof src.GPSLongitude === 'string' ? src.GPSLongitude : null);
  const ref = (v: unknown) => (typeof v === 'string' && v ? ` ${v}` : '');
  if (rawLat) details.push(['Raw latitude', `${rawLat}${ref(src.GPSLatitudeRef)}`]);
  if (rawLon) details.push(['Raw longitude', `${rawLon}${ref(src.GPSLongitudeRef)}`]);
  for (const missing of primary.missingRefs) {
    const isLat = missing === 'GPSLatitudeRef';
    const v = isLat ? primary.lat : primary.lon;
    details.push([
      'Hemisphere',
      `unknown: ${missing} is missing, so the ${isLat ? 'latitude' : 'longitude'} is ${fmtNum(Math.abs(v))} ${isLat ? 'N or S' : 'E or W'} (${isLat ? 'N' : 'E'} assumed; it could be ${(-Math.abs(v)).toFixed(6)})`,
    ]);
  }
  details.push(['Source', primary.source]);

  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const alt = num(src.GPSAltitude);
  if (alt !== null) {
    const below = firstNumber(src.GPSAltitudeRef) === 1;
    details.push(['Altitude', `${fmtNum(alt)} m ${below ? 'below' : 'above'} sea level`]);
  }
  const bearing = (value: unknown, refValue: unknown) => {
    const n = num(value);
    if (n === null) return null;
    const r = typeof refValue === 'string' ? NORTH_REF[refValue] : undefined;
    return `${fmtNum(n)}°${r ? ` (${r})` : ''}`;
  };
  const dir = bearing(src.GPSImgDirection, src.GPSImgDirectionRef);
  if (dir) details.push(['Direction', dir]);
  const track = bearing(src.GPSTrack, src.GPSTrackRef);
  if (track) details.push(['Track (movement)', track]);
  const speed = num(src.GPSSpeed);
  if (speed !== null) {
    const unit = typeof src.GPSSpeedRef === 'string' ? (SPEED_REF[src.GPSSpeedRef] ?? '') : '';
    details.push(['Speed', `${fmtNum(speed)}${unit ? ` ${unit}` : ''}`]);
  }
  const date = typeof src.GPSDateStamp === 'string' ? src.GPSDateStamp.replace(/:/g, '-') : null;
  const time = timeText(src.GPSTimeStamp);
  if (date || time) {
    details.push([
      'GPS date/time',
      `${[date, time].filter(Boolean).join(' ')}${time ? ' UTC' : ''}`,
    ]);
  }
  if (typeof src.GPSMapDatum === 'string' && src.GPSMapDatum)
    details.push(['Map datum', src.GPSMapDatum]);
  if (typeof src.GPSSatellites === 'string' && src.GPSSatellites) {
    details.push(['Satellites', src.GPSSatellites]);
  }
  const hErr = num(src.GPSHPositioningError);
  if (hErr !== null) details.push(['Horizontal error', `${fmtNum(hErr)} m`]);
  const dop = num(src.GPSDOP);
  if (dop !== null) details.push(['Dilution of precision', fmtNum(dop)]);
  for (const [tag, label] of [
    ['GPSProcessingMethod', 'Processing method'],
    ['GPSAreaInformation', 'Area information'],
  ] as const) {
    if (src[tag] !== undefined) {
      const text = typeof src[tag] === 'string' ? src[tag] : formatValue('gps', tag, src[tag]);
      if (text) details.push([label, text]);
    }
  }
  const dLat = toDecimal(src.GPSDestLatitude, src.GPSDestLatitudeRef);
  const dLon = toDecimal(src.GPSDestLongitude, src.GPSDestLongitudeRef);
  if (dLat && dLon) {
    details.push(['Destination', `${dLat.value.toFixed(6)}, ${dLon.value.toFixed(6)}`]);
  }
  return { ...primary, valid: primary.problem === null, details, others };
}
