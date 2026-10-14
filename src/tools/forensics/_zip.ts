/**
 * ZIP reading for the Archive tool: structure (central directory, local headers, zip64,
 * extra fields, prefix data, damaged archives) and extraction (stored, deflate, ZipCrypto).
 * Pure functions over bytes: nothing here touches a file system, names are only ever text.
 */
import { inflateSync } from 'fflate';
import { isValidUtf8, u16le, u32le, utf8Decode } from '../../lib/bytes';
import { crc32, deflateScan } from '../../lib/signatures';
import { checkByteMatches, zipCryptoDecrypt, ZIPCRYPTO_HEADER } from './_zipcrypto';

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const EOCD = 0x06054b50;
const EOCD64 = 0x06064b50;
const LOCATOR64 = 0x07064b50;

/** The most one entry (or all entries together) may expand to. */
export const MAX_OUTPUT = 256 * 1024 * 1024;

const u64le = (b: Uint8Array, o: number) => u32le(b, o) + u32le(b, o + 4) * 4294967296;
const has = (b: Uint8Array, o: number, n: number) => o >= 0 && o + n <= b.length;

export interface ExtraField {
  id: number;
  data: Uint8Array;
}

export interface ZipEntry {
  /** Display name (decoded; never used as a path). */
  name: string;
  nameFrom: 'utf8' | 'cp437' | 'unicode-extra';
  flags: number;
  method: number;
  dosTime: number;
  dosDate: number;
  crc: number;
  csize: number;
  usize: number;
  /** Absolute offset of the local header in the input. */
  lhOffset: number;
  /** Absolute offset of the (possibly encrypted) data, or -1 if no local header was found. */
  dataStart: number;
  comment: string;
  extra: ExtraField[];
  /** Extra-field bytes that do not parse as fields. */
  extraJunk: Uint8Array;
  versionMade: number;
  extAttr: number;
  kind: 'file' | 'dir' | 'symlink';
  encrypted: boolean;
  aes: { strength: number; method: number; version: number } | null;
  hasDescriptor: boolean;
  /** Findings about this entry's structure (local header disagrees with the central one...). */
  notes: string[];
}

export interface Gap {
  offset: number;
  size: number;
  where: string;
}

export interface ZipInfo {
  entries: ZipEntry[];
  comment: string;
  /** Offset of the first byte of the ZIP (after any data that precedes it). */
  start: number;
  /** Offset just after the end-of-central-directory record and its comment. */
  end: number;
  centralDirectory: 'found' | 'missing';
  zip64: boolean;
  gaps: Gap[];
}

// ---------- text ----------

const CP437_HIGH =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

export function cp437Decode(b: Uint8Array): string {
  let s = '';
  for (const c of b) s += c < 0x80 ? String.fromCharCode(c) : CP437_HIGH[c - 0x80]!;
  return s;
}

/** UTF-8 if flagged or plausible, otherwise code page 437 as the ZIP spec says. */
function decodeText(raw: Uint8Array, flags: number): { text: string; utf8: boolean } {
  if (flags & 0x800 || (isValidUtf8(raw) && raw.some((c) => c >= 0x80))) {
    return { text: utf8Decode(raw), utf8: true };
  }
  return { text: cp437Decode(raw), utf8: false };
}

/** DOS date/time as "YYYY-MM-DD HH:MM:SS" ("-" when the field is empty). */
export function dosDateTime(date: number, time: number): string {
  if (date === 0 && time === 0) return '-';
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p((date >> 9) + 1980, 4)}-${p((date >> 5) & 15)}-${p(date & 31)} ${p(time >> 11)}:${p((time >> 5) & 63)}:${p((time & 31) * 2)}`;
}

// ---------- extra fields ----------

export function parseExtra(extra: Uint8Array): { fields: ExtraField[]; junk: Uint8Array } {
  const fields: ExtraField[] = [];
  let p = 0;
  while (p + 4 <= extra.length) {
    const id = u16le(extra, p);
    const len = u16le(extra, p + 2);
    if (p + 4 + len > extra.length) break;
    fields.push({ id, data: extra.subarray(p + 4, p + 4 + len) });
    p += 4 + len;
  }
  return { fields, junk: extra.subarray(p) };
}

const EXTRA_NAMES: Record<number, string> = {
  0x0001: 'Zip64',
  0x0007: 'AV info',
  0x0008: 'OS/2 attributes',
  0x0009: 'OS/2 attributes',
  0x000a: 'NTFS times',
  0x000d: 'Unix',
  0x000f: 'Patch descriptor',
  0x4453: 'Digital signature',
  0x5455: 'UT timestamps',
  0x5855: 'UX Unix',
  0x6375: 'Unicode comment',
  0x7075: 'Unicode path',
  0x7855: 'Ux Unix',
  0x7875: 'ux Unix owner',
  0x9901: 'WinZip AES',
  0xcafe: 'Java class',
};

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

/** One line about the extra fields; unknown ones show their content, since data hides there. */
export function describeExtra(fields: ExtraField[], junk: Uint8Array): string {
  const parts: string[] = [];
  for (const f of fields) {
    const name = EXTRA_NAMES[f.id];
    if (name) {
      parts.push(name);
      continue;
    }
    const printable =
      f.data.length >= 4 && f.data.every((c) => (c >= 0x20 && c < 0x7f) || c === 10);
    const preview = printable
      ? `"${utf8Decode(f.data.subarray(0, 80))}"`
      : hex(f.data.subarray(0, 16)) + (f.data.length > 16 ? '…' : '');
    parts.push(
      `unknown 0x${f.id.toString(16).padStart(4, '0')} (${f.data.length} bytes${f.data.length ? `: ${preview}` : ''})`,
    );
  }
  if (junk.length)
    parts.push(
      `${junk.length} stray bytes: ${hex(junk.subarray(0, 16))}${junk.length > 16 ? '…' : ''}`,
    );
  return parts.join(', ');
}

/** Modified time from the "UT" extra field (UTC), if present. */
export function extraModified(fields: ExtraField[]): string | null {
  const ut = fields.find((f) => f.id === 0x5455);
  if (!ut || ut.data.length < 5 || !(ut.data[0]! & 1)) return null;
  const d = new Date(u32le(ut.data, 1) * 1000);
  return `${d.toISOString().slice(0, 19).replace('T', ' ')}Z`;
}

// ---------- structure ----------

interface Eocd {
  pos: number;
  entries: number;
  cdSize: number;
  cdStart: number;
  cdOffset: number;
  comment: Uint8Array;
  zip64: boolean;
}

/** Last valid end-of-central-directory record (it can be followed by its comment only). */
function findEocd(b: Uint8Array): Eocd | null {
  const lowest = Math.max(0, b.length - 22 - 0xffff);
  for (let p = b.length - 22; p >= lowest; p--) {
    if (b[p] !== 0x50 || u32le(b, p) !== EOCD) continue;
    const commentLen = u16le(b, p + 20);
    if (p + 22 + commentLen > b.length) continue;
    let entries = u16le(b, p + 10);
    let cdSize = u32le(b, p + 12);
    let cdOffset = u32le(b, p + 16);
    let anchor = p;
    let zip64 = false;
    if (has(b, p - 20, 20) && u32le(b, p - 20) === LOCATOR64) {
      // The zip64 record usually sits right before its locator.
      for (let r = p - 20 - 56; r >= Math.max(0, p - 20 - 56 - 1024); r--) {
        if (u32le(b, r) === EOCD64 && has(b, r, 56)) {
          entries = u64le(b, r + 32);
          cdSize = u64le(b, r + 40);
          cdOffset = u64le(b, r + 48);
          anchor = r;
          zip64 = true;
          break;
        }
      }
    }
    const cdStart = anchor - cdSize;
    const empty = entries === 0 && cdSize === 0;
    if (!empty && (cdStart < 0 || u32le(b, cdStart) !== CENTRAL)) continue;
    return {
      pos: p,
      entries,
      cdSize,
      cdStart,
      cdOffset,
      comment: b.subarray(p + 22, p + 22 + commentLen),
      zip64,
    };
  }
  return null;
}

interface Local {
  flags: number;
  method: number;
  nameLen: number;
  name: Uint8Array;
  dataStart: number;
  crc: number;
  csize: number;
  usize: number;
  extra: Uint8Array;
}

function readLocal(b: Uint8Array, p: number): Local | null {
  if (!has(b, p, 30) || u32le(b, p) !== LOCAL) return null;
  const nameLen = u16le(b, p + 26);
  const extraLen = u16le(b, p + 28);
  if (!has(b, p + 30, nameLen + extraLen)) return null;
  return {
    flags: u16le(b, p + 6),
    method: u16le(b, p + 8),
    nameLen,
    name: b.subarray(p + 30, p + 30 + nameLen),
    dataStart: p + 30 + nameLen + extraLen,
    crc: u32le(b, p + 14),
    csize: u32le(b, p + 18),
    usize: u32le(b, p + 22),
    extra: b.subarray(p + 30 + nameLen, p + 30 + nameLen + extraLen),
  };
}

function build(
  raw: {
    nameRaw: Uint8Array;
    flags: number;
    method: number;
    dosTime: number;
    dosDate: number;
    crc: number;
    csize: number;
    usize: number;
    lhOffset: number;
    dataStart: number;
    comment: Uint8Array;
    extra: Uint8Array;
    versionMade: number;
    extAttr: number;
  },
  notes: string[],
): ZipEntry {
  const { fields, junk } = parseExtra(raw.extra);
  const decoded = decodeText(raw.nameRaw, raw.flags);
  let name = decoded.text;
  let nameFrom: ZipEntry['nameFrom'] = decoded.utf8 ? 'utf8' : 'cp437';
  const up = fields.find((f) => f.id === 0x7075);
  if (up && up.data.length > 5 && up.data[0] === 1 && u32le(up.data, 1) === crc32(raw.nameRaw)) {
    name = utf8Decode(up.data.subarray(5));
    nameFrom = 'unicode-extra';
  }
  const aesField = fields.find((f) => f.id === 0x9901);
  const aes =
    raw.method === 99 && aesField && aesField.data.length >= 7
      ? {
          version: u16le(aesField.data, 0),
          strength: aesField.data[4]!,
          method: u16le(aesField.data, 5),
        }
      : raw.method === 99
        ? { version: 0, strength: 0, method: 0 }
        : null;
  const unixMode = raw.versionMade >> 8 === 3 ? (raw.extAttr >>> 16) & 0xf000 : 0;
  const kind: ZipEntry['kind'] =
    name.endsWith('/') || raw.extAttr & 0x10 || unixMode === 0x4000
      ? 'dir'
      : unixMode === 0xa000
        ? 'symlink'
        : 'file';
  return {
    name,
    nameFrom,
    flags: raw.flags,
    method: raw.method,
    dosTime: raw.dosTime,
    dosDate: raw.dosDate,
    crc: raw.crc,
    csize: raw.csize,
    usize: raw.usize,
    lhOffset: raw.lhOffset,
    dataStart: raw.dataStart,
    comment: decodeText(raw.comment, raw.flags).text,
    extra: fields,
    extraJunk: junk,
    versionMade: raw.versionMade,
    extAttr: raw.extAttr,
    kind,
    encrypted: (raw.flags & 1) !== 0,
    aes,
    hasDescriptor: (raw.flags & 8) !== 0,
    notes,
  };
}

/** Zip64 values live in extra field 0x0001, only for the 32-bit fields that are 0xFFFFFFFF. */
function applyZip64(
  extra: Uint8Array,
  v: { usize: number; csize: number; lhOffset: number },
): void {
  const z = parseExtra(extra).fields.find((f) => f.id === 1);
  if (!z) return;
  let o = 0;
  if (v.usize === 0xffffffff && o + 8 <= z.data.length) {
    v.usize = u64le(z.data, o);
    o += 8;
  }
  if (v.csize === 0xffffffff && o + 8 <= z.data.length) {
    v.csize = u64le(z.data, o);
    o += 8;
  }
  if (v.lhOffset === 0xffffffff && o + 8 <= z.data.length) v.lhOffset = u64le(z.data, o);
}

/** Entries from the central directory. `base` is added to every stored local-header offset. */
function readCentral(b: Uint8Array, e: Eocd, base: number): ZipEntry[] {
  const out: ZipEntry[] = [];
  let p = e.cdStart;
  for (let i = 0; i < e.entries && has(b, p, 46) && u32le(b, p) === CENTRAL; i++) {
    const nameLen = u16le(b, p + 28);
    const extraLen = u16le(b, p + 30);
    const commentLen = u16le(b, p + 32);
    if (!has(b, p + 46, nameLen + extraLen + commentLen)) break;
    const nameRaw = b.subarray(p + 46, p + 46 + nameLen);
    const extra = b.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
    const comment = b.subarray(
      p + 46 + nameLen + extraLen,
      p + 46 + nameLen + extraLen + commentLen,
    );
    const v = { usize: u32le(b, p + 24), csize: u32le(b, p + 20), lhOffset: u32le(b, p + 42) };
    applyZip64(extra, v);
    const lhOffset = base + v.lhOffset;
    const local = readLocal(b, lhOffset);
    const notes: string[] = [];
    if (!local) {
      notes.push('local header not found where the central directory says it is');
    } else {
      if (local.nameLen !== nameLen || hex(local.name) !== hex(nameRaw)) {
        notes.push(`local header names it "${utf8Decode(local.name)}"`);
      }
      if (local.method !== u16le(b, p + 10)) notes.push(`local header says method ${local.method}`);
    }
    out.push(
      build(
        {
          nameRaw,
          flags: u16le(b, p + 8),
          method: u16le(b, p + 10),
          dosTime: u16le(b, p + 12),
          dosDate: u16le(b, p + 14),
          crc: u32le(b, p + 16),
          csize: v.csize,
          usize: v.usize,
          lhOffset,
          dataStart: local ? local.dataStart : -1,
          comment,
          extra,
          versionMade: u16le(b, p + 4),
          extAttr: u32le(b, p + 38),
        },
        notes,
      ),
    );
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** No usable central directory: rebuild the list by walking local headers from `from`. */
function recoverLocal(b: Uint8Array, from: number): ZipEntry[] {
  const out: ZipEntry[] = [];
  let p = from;
  while (has(b, p, 30) && u32le(b, p) === LOCAL) {
    const l = readLocal(b, p);
    if (!l) break;
    let csize = l.csize;
    const stream = (l.flags & 8) !== 0 && csize === 0;
    if (stream) {
      // Sizes unknown (data descriptor): a deflate stream tells where it ends.
      const scan = l.method === 8 ? deflateScan(b, l.dataStart) : null;
      if (!scan) {
        out.push(
          build(localToRaw(l, p, 0), [
            'size unknown (data descriptor) and not deflate: data not recovered',
          ]),
        );
        break;
      }
      csize = scan.end - l.dataStart;
    }
    const entry = build(localToRaw(l, p, csize), ['recovered from the local header']);
    out.push(entry);
    p = l.dataStart + csize;
    if (l.flags & 8) {
      // Skip the data descriptor: 12 bytes, or 16 with its signature.
      p += u32le(b, p) === 0x08074b50 ? 16 : 12;
    }
  }
  return out;
}

function localToRaw(l: Local, p: number, csize: number) {
  return {
    nameRaw: l.name,
    flags: l.flags,
    method: l.method,
    dosTime: 0,
    dosDate: 0,
    crc: l.crc,
    csize,
    usize: l.usize,
    lhOffset: p,
    dataStart: l.dataStart,
    comment: new Uint8Array(0),
    extra: l.extra,
    versionMade: 0,
    extAttr: 0,
  };
}

function findGaps(entries: ZipEntry[], e: Eocd): Gap[] {
  const gaps: Gap[] = [];
  const sorted = entries.filter((x) => x.dataStart >= 0).sort((a, c) => a.lhOffset - c.lhOffset);
  const tolerance = (x: ZipEntry) => (x.hasDescriptor ? 24 : 0);
  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i]!;
    const used = cur.dataStart + cur.csize;
    const next = i + 1 < sorted.length ? sorted[i + 1]!.lhOffset : e.cdStart;
    const size = next - used;
    if (size > tolerance(cur)) {
      gaps.push({
        offset: used,
        size,
        where:
          i + 1 < sorted.length
            ? `between "${cur.name}" and "${sorted[i + 1]!.name}"`
            : 'between the last entry and the central directory',
      });
    }
  }
  if (!e.zip64) {
    const cdEnd = e.cdStart + e.cdSize;
    if (e.pos > cdEnd) {
      gaps.push({
        offset: cdEnd,
        size: e.pos - cdEnd,
        where: 'between the central directory and the end record',
      });
    }
  }
  return gaps;
}

/** Parse a ZIP anywhere in the input: plain, with data before it, or damaged. Null if none. */
export function parseZip(b: Uint8Array): ZipInfo | null {
  const eocd = findEocd(b);
  if (eocd) {
    let entries: ZipEntry[] = [];
    if (eocd.entries > 0) {
      // Offsets in the archive are relative to its own start, which is later than 0 when
      // something precedes it.
      let base = Math.max(0, eocd.cdStart - eocd.cdOffset);
      const firstLh = has(b, eocd.cdStart, 46) ? u32le(b, eocd.cdStart + 42) : 0;
      if (!has(b, base + firstLh, 4) || u32le(b, base + firstLh) !== LOCAL) {
        base = 0;
      }
      entries = readCentral(b, eocd, base);
      if (entries.length > 0 && entries.every((x) => x.dataStart < 0)) {
        // Offsets are off: anchor on the first local header found.
        for (let p = 0; p + 4 <= b.length; p++) {
          if (b[p] === 0x50 && u32le(b, p) === LOCAL) {
            let lowest = Infinity;
            for (const x of entries) lowest = Math.min(lowest, x.lhOffset - base);
            entries = readCentral(b, eocd, p - lowest);
            break;
          }
        }
      }
    }
    let start = Infinity;
    for (const x of entries) if (x.dataStart >= 0) start = Math.min(start, x.lhOffset);
    return {
      entries,
      comment: decodeText(eocd.comment, 0).text,
      start: Number.isFinite(start) ? start : 0,
      end: eocd.pos + 22 + eocd.comment.length,
      centralDirectory: 'found',
      zip64: eocd.zip64,
      gaps: findGaps(entries, eocd),
    };
  }
  // No end-of-central-directory: walk local headers from the first one.
  for (let p = 0; p + 30 <= b.length; p++) {
    if (b[p] === 0x50 && u32le(b, p) === LOCAL && readLocal(b, p)) {
      const entries = recoverLocal(b, p);
      if (entries.length === 0) return null;
      const last = entries[entries.length - 1]!;
      return {
        entries,
        comment: '',
        start: p,
        end: Math.min(b.length, last.dataStart + last.csize),
        centralDirectory: 'missing',
        zip64: false,
        gaps: [],
      };
    }
  }
  return null;
}

// ---------- extraction ----------

export const METHOD_NAMES: Record<number, string> = {
  0: 'stored',
  1: 'shrunk',
  6: 'imploded',
  8: 'deflate',
  9: 'deflate64',
  12: 'bzip2',
  14: 'LZMA',
  93: 'zstd',
  95: 'xz',
  98: 'PPMd',
  99: 'AES',
};

export interface Extracted {
  data: Uint8Array | null;
  /** Why the content is not available (wrong password, unsupported...). */
  problem: string | null;
  /** Something worth knowing about the data that was extracted. */
  note: string | null;
  /** CRC-32 of the extracted data matches the header (null if it could not be checked). */
  crcOk: boolean | null;
  decrypted: boolean;
}

const fail = (problem: string): Extracted => ({
  data: null,
  problem,
  note: null,
  crcOk: null,
  decrypted: false,
});

/** Decompress (and decrypt with `password`, if the entry needs it) one entry. */
export function extractZipEntry(
  b: Uint8Array,
  e: ZipEntry,
  password: Uint8Array | null,
): Extracted {
  if (e.dataStart < 0) return fail('no local header: the data cannot be located');
  let raw = b.subarray(e.dataStart, Math.min(b.length, e.dataStart + e.csize));
  const truncated = raw.length < e.csize;
  if (e.aes) {
    const bits =
      e.aes.strength === 1 ? 128 : e.aes.strength === 2 ? 192 : e.aes.strength === 3 ? 256 : 0;
    return fail(
      `WinZip AES${bits ? `-${bits}` : ''} encryption is not supported yet. Open it with 7-Zip: 7z x -p<password> file.zip`,
    );
  }
  let decrypted = false;
  if (e.encrypted) {
    if (!password) {
      return fail('encrypted with ZipCrypto: enter the password in the options');
    }
    if (raw.length < ZIPCRYPTO_HEADER) return fail('encrypted data is too short');
    const dec = zipCryptoDecrypt(raw, password);
    if (!checkByteMatches(dec.header, e.crc, e.dosTime, e.hasDescriptor)) {
      return fail('wrong password (the check byte does not match)');
    }
    raw = dec.data;
    decrypted = true;
  }
  let data: Uint8Array;
  if (e.method === 0) {
    data = raw;
  } else if (e.method === 8) {
    const problem = decrypted
      ? 'wrong password (the decrypted data is not a valid deflate stream)'
      : truncated
        ? 'the archive is cut off in the middle of this entry'
        : 'the deflate data is corrupted';
    // Walk the stream first: it is cheap, and tells the unpacked size before any memory is spent.
    const scan = deflateScan(raw, 0);
    if (!scan) return fail(problem);
    if (scan.size > MAX_OUTPUT) {
      return fail(`it would expand to ${scan.size} bytes, more than the browser can hold here`);
    }
    try {
      data = inflateSync(raw.subarray(0, scan.end));
    } catch {
      return fail(problem);
    }
  } else {
    const name = METHOD_NAMES[e.method] ?? `method ${e.method}`;
    return fail(
      `compression method ${e.method} (${name}) is not supported: only stored and deflate`,
    );
  }
  let crcOk: boolean | null = null;
  let note: string | null = truncated ? 'archive is cut off: data may be incomplete' : null;
  if (e.crc !== 0 || data.length === 0) {
    crcOk = crc32(data) === e.crc;
    if (!crcOk) {
      if (decrypted) return fail('wrong password (CRC-32 of the result does not match)');
      note = 'CRC-32 mismatch: the data is damaged or was modified';
    }
  }
  return { data, problem: null, note, crcOk, decrypted };
}
