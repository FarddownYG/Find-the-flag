import * as exifrNs from 'exifr';
import { isValidUtf8, latin1Decode, toHex, utf8Decode } from '../../lib/bytes';

// exifr's package.json points `main` at a UMD file and `module` at an ES build. Vite uses the
// ES build (named exports); Node/Vitest may hand us the CommonJS object under `default`.
type ExifrApi = Pick<typeof exifrNs, 'parse' | 'thumbnail' | 'tagKeys' | 'tagValues'>;
export const exifr: ExifrApi =
  typeof exifrNs.parse === 'function' ? exifrNs : (exifrNs.default as unknown as ExifrApi);

export const PARSE_OPTIONS = {
  tiff: true,
  ifd1: true,
  exif: true,
  gps: true,
  interop: true,
  xmp: true,
  iptc: true,
  icc: true,
  jfif: true,
  ihdr: true,
  makerNote: false,
  userComment: true,
  mergeOutput: false,
  translateKeys: true,
  translateValues: true,
  reviveValues: false,
  sanitize: true,
};

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' &&
  v !== null &&
  !Array.isArray(v) &&
  !ArrayBuffer.isView(v) &&
  !(v instanceof Date) &&
  !(v instanceof BinaryText) &&
  !(v instanceof Unreadable);

export function bytesOfLike(v: unknown): Uint8Array | null {
  if (v instanceof Uint8Array) return v;
  if (
    Array.isArray(v) &&
    v.length &&
    v.every((x) => Number.isInteger(x) && (x as number) >= 0 && (x as number) <= 255)
  ) {
    return Uint8Array.from(v as number[]);
  }
  return null;
}

const stripNul = (s: string) => s.replace(/\0+$/g, '');

/** Control characters other than tab / newline / CR mean the string is really binary. */
export function hasControl(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c < 0x20 && c !== 9 && c !== 10 && c !== 13) || c === 0x7f) return true;
  }
  return false;
}

function utf16(b: Uint8Array, le: boolean): string {
  let s = '';
  for (let i = 0; i + 1 < b.length; i += 2) {
    s += String.fromCharCode(le ? b[i]! | (b[i + 1]! << 8) : (b[i]! << 8) | b[i + 1]!);
  }
  return stripNul(s);
}

/**
 * EXIF UserComment (also GPSProcessingMethod / GPSAreaInformation): an 8-byte charset id, then
 * the text. UNICODE is UCS-2 in the byte order of the TIFF block; pass it when it is known.
 */
export function decodeUserComment(b: Uint8Array, littleEndian?: boolean): string {
  const id = latin1Decode(b.subarray(0, 8));
  const body = b.subarray(8);
  if (id.startsWith('ASCII')) return stripNul(latin1Decode(body));
  if (id.startsWith('UNICODE')) {
    // Byte order unknown (exifr hands over bare bytes): guess from where the zero bytes are.
    const le = littleEndian ?? (body.length > 1 && body[1] === 0 && body[0] !== 0);
    return utf16(body, le);
  }
  if (id.startsWith('JIS'))
    return `[JIS-encoded comment, ${body.length} bytes] ${stripNul(latin1Decode(body))}`;
  const whole = b.every((x, i) => i >= 8 || x === 0) ? body : b;
  return stripNul(utf8Decode(whole));
}

export function fmtValue(key: string, v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) {
    // An all-zero date field (ICC profiles often have one) decodes to 30 Nov 1899.
    return v.getUTCFullYear() < 1900 ? 'not set (all zeros)' : v.toISOString();
  }
  if (v instanceof BinaryText) return toHex(v.bytes, ' ');
  if (v instanceof Unreadable) return v.text;
  if (typeof v === 'string') return stripNul(v);
  if (typeof v === 'number') {
    if (key === 'ExposureTime' && v > 0 && v < 1) return `1/${Math.round(1 / v)} s`;
    if (key === 'FNumber') return `f/${v}`;
    if (key === 'FocalLength' || key === 'FocalLengthIn35mmFormat') return `${v} mm`;
    if (key === 'GPSAltitude') return `${v} m`;
    return Number.isInteger(v) ? String(v) : String(Math.round(v * 1e6) / 1e6);
  }
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  const bytes = bytesOfLike(v);
  if (bytes) {
    if (key.startsWith('XP')) return utf16(bytes, true);
    if (key === 'UserComment') return decodeUserComment(bytes);
    if (bytes.length <= 16 && key.startsWith('GPS')) return Array.from(bytes).join(', ');
    return bytes.length > 32
      ? `<${bytes.length} bytes> ${toHex(bytes.subarray(0, 16), ' ')} …`
      : toHex(bytes, ' ');
  }
  if (Array.isArray(v)) {
    return v.every((x) => x === null || typeof x !== 'object')
      ? v.map((x) => fmtValue(key, x)).join(', ')
      : JSON.stringify(v);
  }
  return JSON.stringify(v);
}

// ---------------------------------------------------------------- GPS

/** 0, 0 is what an empty fix looks like; anything off the globe is not a position either. */
export function positionProblem(lat: number, lon: number): 'zero' | 'range' | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return 'range';
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return 'range';
  return lat === 0 && lon === 0 ? 'zero' : null;
}

/**
 * Degrees/minutes/seconds (or one decimal number, or the XMP "48,51.504N" form) with its
 * N/S/E/W reference -> signed decimal. `hemisphere` says whether a reference was found.
 */
export function toDecimal(
  value: unknown,
  ref: unknown,
): { value: number; hemisphere: boolean } | null {
  let abs: number | null = null;
  let r = typeof ref === 'string' ? ref.trim().toUpperCase().charAt(0) : '';
  if (typeof value === 'number') abs = value;
  else if (Array.isArray(value) && value.length && value.every((x) => typeof x === 'number')) {
    const [d = 0, m = 0, s = 0] = value as number[];
    abs = Math.abs(d) + m / 60 + s / 3600;
    if (d < 0) abs = -abs;
  } else if (typeof value === 'string') {
    const m = /^\s*(\d+(?:\.\d+)?)(?:,(\d+(?:\.\d+)?))?(?:,(\d+(?:\.\d+)?))?\s*([NSEW])?\s*$/i.exec(
      value,
    );
    if (!m) return null;
    abs = Number(m[1]) + Number(m[2] ?? 0) / 60 + Number(m[3] ?? 0) / 3600;
    if (!r && m[4]) r = m[4].toUpperCase();
  }
  if (abs === null || !Number.isFinite(abs)) return null;
  if (r === 'S' || r === 'W') return { value: -Math.abs(abs), hemisphere: true };
  if (r === 'N' || r === 'E') return { value: Math.abs(abs), hemisphere: true };
  return { value: abs, hemisphere: false };
}

// ---------------------------------------------------------------- TIFF / IFD walker

/** An ASCII-typed EXIF value whose bytes are not text: kept as bytes, shown as hex. */
class BinaryText {
  constructor(readonly bytes: Uint8Array) {}
}

/** A value whose bytes lie outside the EXIF block (truncated or damaged EXIF). */
class Unreadable {
  constructor(readonly text: string) {}
}

export type IfdName = 'ifd0' | 'exif' | 'gps' | 'interop' | 'ifd1';

export interface TiffEntry {
  tag: number;
  type: number;
  count: number;
  /** Value bytes, or null when they lie outside the block. */
  raw: Uint8Array | null;
  /** Offset of the value inside the TIFF block. */
  at: number;
  size: number;
}

export interface TiffRead {
  le: boolean;
  ifds: Partial<Record<IfdName, TiffEntry[]>>;
  /** Plain-words description of everything that did not add up. */
  problems: string[];
}

const TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8, 4];
const IFD_LABEL: Record<IfdName, string> = {
  ifd0: 'IFD0',
  exif: 'Exif IFD',
  gps: 'GPS IFD',
  interop: 'Interop IFD',
  ifd1: 'IFD1',
};
const POINTERS: Partial<Record<number, IfdName>> = {
  0x8769: 'exif',
  0x8825: 'gps',
  0xa005: 'interop',
};
const MAX_ENTRIES = 1000;

/** True when `b` starts with a TIFF header ("II*\0" or "MM\0*"). */
function isTiffHeader(b: Uint8Array, at = 0): boolean {
  const b0 = b[at];
  const b1 = b[at + 1];
  if (b0 === 0x49 && b1 === 0x49) return b[at + 2] === 0x2a && b[at + 3] === 0;
  if (b0 === 0x4d && b1 === 0x4d) return b[at + 2] === 0 && b[at + 3] === 0x2a;
  return false;
}

const hex4 = (tag: number) => `0x${tag.toString(16).toUpperCase().padStart(4, '0')}`;

/** exifr's name for a tag of an IFD, else its number in hex. */
function tagName(ifd: IfdName, tag: number): string {
  return exifr.tagKeys.get(ifd)?.get(tag) ?? hex4(tag);
}

/**
 * Walk the IFDs of a TIFF block (the EXIF payload of a JPEG APP1, a PNG eXIf chunk, a WebP EXIF
 * chunk or a whole TIFF file). Unlike a strict reader it never gives up on a block: every entry
 * that fits is kept, the others are reported.
 */
export function readTiff(t: Uint8Array): TiffRead | null {
  if (!isTiffHeader(t)) return null;
  const le = t[0] === 0x49;
  const dv = new DataView(t.buffer, t.byteOffset, t.byteLength);
  const u16 = (o: number) => dv.getUint16(o, le);
  const u32 = (o: number) => dv.getUint32(o, le);
  const problems: string[] = [];
  const ifds: TiffRead['ifds'] = {};
  const visited = new Set<number>();
  if (t.length < 8) {
    problems.push(`The EXIF block is only ${t.length} bytes long: its header is cut.`);
    return { le, ifds, problems };
  }

  const walk = (name: IfdName, offset: number): number | null => {
    const label = IFD_LABEL[name];
    if (ifds[name]) return null;
    if (offset < 8 || offset + 2 > t.length) {
      problems.push(
        `${label} should start at offset ${offset}, but the EXIF block is only ${t.length} bytes long.`,
      );
      return null;
    }
    if (visited.has(offset)) {
      problems.push(`${label} points back at an IFD already read (offset ${offset}): a loop.`);
      return null;
    }
    visited.add(offset);
    const declared = u16(offset);
    const fit = Math.floor((t.length - offset - 2) / 12);
    const n = Math.min(declared, fit, MAX_ENTRIES);
    if (n < declared) {
      problems.push(
        `${label} declares ${declared} entries but only ${n} fit in the ${t.length}-byte EXIF block: it is cut.`,
      );
    }
    const entries: TiffEntry[] = [];
    for (let i = 0; i < n; i++) {
      const e = offset + 2 + 12 * i;
      const tag = u16(e);
      const type = u16(e + 2);
      const count = u32(e + 4);
      const unit = TYPE_SIZE[type] ?? 0;
      if (!unit) {
        problems.push(`${label} tag ${hex4(tag)} has an unknown value type (${type}).`);
        entries.push({ tag, type, count, raw: null, at: e + 8, size: 0 });
        continue;
      }
      const size = unit * count;
      const at = size <= 4 ? e + 8 : u32(e + 8);
      const fits = size <= t.length && at <= t.length - size;
      if (!fits) {
        problems.push(
          `${label} tag ${hex4(tag)} (${tagName(name, tag)}): its value (${size} bytes at offset ${at}) lies outside the ${t.length}-byte EXIF block.`,
        );
      }
      entries.push({ tag, type, count, raw: fits ? t.subarray(at, at + size) : null, at, size });
    }
    ifds[name] = entries;
    const next = offset + 2 + 12 * declared;
    return n === declared && next + 4 <= t.length ? u32(next) : null;
  };

  const pointer = (entries: TiffEntry[] | undefined, tag: number): number | null => {
    const e = entries?.find((x) => x.tag === tag);
    if (!e?.raw || e.count < 1 || e.raw.length < 4) return null;
    return new DataView(e.raw.buffer, e.raw.byteOffset, 4).getUint32(0, le);
  };

  const next = walk('ifd0', u32(4));
  for (const [tag, name] of Object.entries(POINTERS) as [string, IfdName][]) {
    // The Interop IFD hangs off the Exif IFD (some writers put the pointer in IFD0).
    const at =
      pointer(ifds.ifd0, Number(tag)) ??
      (name === 'interop' ? pointer(ifds.exif, Number(tag)) : null);
    if (at !== null) walk(name, at);
  }
  if (next) walk('ifd1', next);
  return { le, ifds, problems };
}

/** JS value of an entry, the way exifr gives it (numbers, arrays, strings, bytes). */
function entryValue(e: TiffEntry, le: boolean): unknown {
  if (!e.raw) {
    return new Unreadable(
      e.size
        ? `unreadable: its ${e.size} bytes would be at offset ${e.at}, outside the EXIF block`
        : `unreadable: unknown value type ${e.type}`,
    );
  }
  const r = e.raw;
  if (e.type === 1 || e.type === 7) return r.slice();
  if (e.type === 2) {
    let end = r.length;
    while (end > 0 && r[end - 1] === 0) end--;
    const body = r.subarray(0, end);
    // Text is UTF-8 (or, failing that, printable Latin-1); anything else is shown as hex.
    const latin1 = body.every((x) => (x >= 0x20 && x < 0x7f) || x >= 0xa0 || x === 9 || x === 10);
    const text = isValidUtf8(body) ? utf8Decode(body) : latin1 ? latin1Decode(body) : null;
    if (text === null || hasControl(text)) return new BinaryText(body.slice());
    const trimmed = text.trim();
    return trimmed === '' ? undefined : trimmed;
  }
  const dv = new DataView(r.buffer, r.byteOffset, r.byteLength);
  const one = (i: number): number => {
    switch (e.type) {
      case 3:
        return dv.getUint16(i * 2, le);
      case 4:
      case 13:
        return dv.getUint32(i * 4, le);
      case 5:
        return dv.getUint32(i * 8, le) / dv.getUint32(i * 8 + 4, le);
      case 6:
        return dv.getInt8(i);
      case 8:
        return dv.getInt16(i * 2, le);
      case 9:
        return dv.getInt32(i * 4, le);
      case 10:
        return dv.getInt32(i * 8, le) / dv.getInt32(i * 8 + 4, le);
      case 11:
        return dv.getFloat32(i * 4, le);
      default:
        return dv.getFloat64(i * 8, le);
    }
  };
  if (e.count === 1) return one(0);
  const out: number[] = [];
  for (let i = 0; i < e.count; i++) out.push(one(i));
  return out;
}

/** Tags that point at other structures: their values mean nothing to a reader. */
const STRUCTURAL = new Set([0x8769, 0x8825, 0xa005, 0x02bc, 0x83bb, 0x8773, 0x8649]);

export interface TiffGroups {
  /** exifr-shaped groups: { ifd0: { Make: 'x', ... }, exif: {...}, gps: {...}, ... }. */
  groups: Partial<Record<IfdName, Record<string, unknown>>>;
  /** IFD1 thumbnail bytes, or why it could not be read. */
  thumbnail: { data: Uint8Array; offset: number } | { error: string } | null;
}

/** Turn a walked TIFF block into named, translated values (exifr's dictionaries). */
export function tiffGroups(read: TiffRead, t: Uint8Array): TiffGroups {
  const groups: TiffGroups['groups'] = {};
  for (const [ifd, entries] of Object.entries(read.ifds) as [IfdName, TiffEntry[]][]) {
    const values = exifr.tagValues.get(ifd) as Map<number, unknown> | undefined;
    const g: Record<string, unknown> = {};
    for (const e of entries) {
      if (STRUCTURAL.has(e.tag)) continue;
      let v = entryValue(e, read.le);
      if (v === undefined) continue;
      if (e.tag === 0x9286 && v instanceof Uint8Array) v = decodeUserComment(v, read.le);
      if ((e.tag === 0xa300 || e.tag === 0xa301) && v instanceof Uint8Array && v.length === 1) {
        v = v[0];
      }
      const dict = values?.get(e.tag);
      if (isRecord(dict) && (typeof v === 'number' || typeof v === 'string')) {
        const mapped = dict[String(v)] ?? dict.DEFAULT;
        if (typeof mapped === 'string') v = mapped;
      }
      let key = tagName(ifd, e.tag);
      for (let n = 2; key in g; n++) key = `${tagName(ifd, e.tag)} #${n}`;
      g[key] = v;
    }
    groups[ifd] = g;
  }
  let thumbnail: TiffGroups['thumbnail'] = null;
  const ifd1 = read.ifds.ifd1;
  const num = (tag: number) => {
    const e = ifd1?.find((x) => x.tag === tag);
    const v = e ? entryValue(e, read.le) : undefined;
    return typeof v === 'number' ? v : null;
  };
  const off = num(0x0201);
  const len = num(0x0202);
  if (off !== null && len !== null) {
    thumbnail =
      len > 0 && off + len <= t.length
        ? { data: t.slice(off, off + len), offset: off }
        : {
            error: `IFD1 says the thumbnail is ${len} bytes at offset ${off}, but the EXIF block is only ${t.length} bytes long`,
          };
  }
  return { groups, thumbnail };
}
