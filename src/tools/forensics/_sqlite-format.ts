/**
 * The SQLite file format, read straight from the bytes (https://www.sqlite.org/fileformat2.html).
 * Pure TypeScript, no sql.js: this is what keeps the header, the freelist and the carver working
 * on a file the SQL engine refuses to open.
 */
import { u16be, u32be } from '../../lib/bytes';

export const SQLITE_MAGIC = 'SQLite format 3\0';

export const hasSqliteMagic = (b: Uint8Array): boolean =>
  b.length >= 16 && [...SQLITE_MAGIC].every((c, i) => b[i] === c.charCodeAt(0));

export type TextEncoding = 'utf-8' | 'utf-16le' | 'utf-16be';

export interface DbHeader {
  pageSize: number;
  /** 1 = rollback journal, 2 = WAL (the persistent journal mode of the file). */
  writeVersion: number;
  readVersion: number;
  /** Unused bytes at the end of each page. */
  reserved: number;
  changeCounter: number;
  /** Database size in pages as written in the header (0 = unknown). */
  pagesInHeader: number;
  firstFreelistTrunk: number;
  freelistCount: number;
  schemaCookie: number;
  schemaFormat: number;
  cacheSize: number;
  /** Non-zero in auto-vacuum databases: the largest root b-tree page. */
  largestRootPage: number;
  /** Raw value of the text encoding field (1, 2 or 3). */
  encodingCode: number;
  encoding: TextEncoding;
  userVersion: number;
  incrementalVacuum: number;
  applicationId: number;
  versionValidFor: number;
  /** SQLITE_VERSION_NUMBER of the library that last wrote the file (3049001 = 3.49.1). */
  sqliteVersion: number;
}

const ENCODINGS: TextEncoding[] = ['utf-8', 'utf-16le', 'utf-16be'];

/** The 100-byte header, or null when the bytes are not a SQLite database header. */
export function parseHeader(b: Uint8Array): DbHeader | null {
  if (b.length < 100 || !hasSqliteMagic(b)) return null;
  const raw = u16be(b, 16);
  const pageSize = raw === 1 ? 65536 : raw;
  if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0) return null;
  const encodingCode = u32be(b, 56);
  const i32 = (o: number) => u32be(b, o) | 0;
  return {
    pageSize,
    writeVersion: b[18]!,
    readVersion: b[19]!,
    reserved: b[20]!,
    changeCounter: u32be(b, 24),
    pagesInHeader: u32be(b, 28),
    firstFreelistTrunk: u32be(b, 32),
    freelistCount: u32be(b, 36),
    schemaCookie: u32be(b, 40),
    schemaFormat: u32be(b, 44),
    cacheSize: i32(48),
    largestRootPage: u32be(b, 52),
    encodingCode,
    encoding: ENCODINGS[encodingCode - 1] ?? 'utf-8',
    userVersion: i32(60),
    incrementalVacuum: u32be(b, 64),
    applicationId: u32be(b, 68),
    versionValidFor: u32be(b, 92),
    sqliteVersion: u32be(b, 96),
  };
}

/** "3.49.1" from SQLITE_VERSION_NUMBER (3049001). */
export function versionText(n: number): string {
  if (n <= 0) return '';
  return `${Math.floor(n / 1_000_000)}.${Math.floor(n / 1000) % 1000}.${n % 1000}`;
}

export type JournalFromHeader = 'wal' | 'rollback' | 'unknown';

/** Header bytes 18 and 19: 2 means the file was last used in WAL mode, 1 in a rollback mode. */
export function journalFromHeader(h: DbHeader): JournalFromHeader {
  if (h.writeVersion === 2 || h.readVersion === 2) return 'wal';
  if (h.writeVersion === 1 && h.readVersion === 1) return 'rollback';
  return 'unknown';
}

/**
 * Page count the way SQLite works it out: the header value is trusted only when
 * "version-valid-for" equals the change counter, otherwise the file size decides.
 */
export function pageCountOf(h: DbHeader, fileSize: number): number {
  if (h.pagesInHeader > 0 && h.versionValidFor === h.changeCounter) return h.pagesInHeader;
  return Math.floor(fileSize / h.pageSize);
}

// ---------- varints and records ----------

export interface Varint {
  value: number;
  len: number;
}

/** SQLite varint (1..9 bytes, big-endian groups of 7 bits; the ninth byte keeps all 8). */
export function readVarint(b: Uint8Array, p: number, end = b.length): Varint | null {
  let value = 0;
  for (let i = 0; i < 9; i++) {
    if (p + i >= end) return null;
    const byte = b[p + i]!;
    if (i === 8) return { value: value * 256 + byte, len: 9 };
    value = value * 128 + (byte & 0x7f);
    if (byte < 0x80) return { value, len: i + 1 };
  }
  return null;
}

/** Content size in bytes of a serial type, or -1 for the reserved types 10 and 11. */
export function serialSize(st: number): number {
  if (st < 12) {
    return st === 10 || st === 11 ? -1 : [0, 1, 2, 3, 4, 6, 8, 8, 0, 0][st]!;
  }
  return Math.floor((st - 12) / 2);
}

export type CellValue =
  | { kind: 'null' }
  | { kind: 'int'; value: bigint }
  | { kind: 'float'; value: number }
  | { kind: 'text'; value: string }
  | { kind: 'blob'; value: Uint8Array }
  /** A column whose serial type was overwritten: only its raw bytes remain. */
  | { kind: 'lost'; value: Uint8Array };

const NULL_VALUE: CellValue = { kind: 'null' };

const decoders = new Map<string, TextDecoder>();

/** Well-formed UTF-8 (no overlong forms, surrogates or values above U+10FFFF). No exceptions: the carver asks this of every byte run it tries. */
function validUtf8(b: Uint8Array): boolean {
  let i = 0;
  const n = b.length;
  while (i < n) {
    const c = b[i]!;
    if (c < 0x80) {
      i++;
      continue;
    }
    let need: number;
    let min: number;
    let cp: number;
    if (c >= 0xc2 && c <= 0xdf) [need, min, cp] = [1, 0x80, c & 0x1f];
    else if (c >= 0xe0 && c <= 0xef) [need, min, cp] = [2, 0x800, c & 0x0f];
    else if (c >= 0xf0 && c <= 0xf4) [need, min, cp] = [3, 0x10000, c & 0x07];
    else return false;
    for (let k = 1; k <= need; k++) {
      const x = b[i + k];
      if (x === undefined || (x & 0xc0) !== 0x80) return false;
      cp = (cp << 6) | (x & 0x3f);
    }
    if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return false;
    i += need + 1;
  }
  return true;
}

/** Well-formed UTF-16 of the given byte order: whole code units, surrogates in pairs. */
function validUtf16(b: Uint8Array, littleEndian: boolean): boolean {
  if (b.length % 2 !== 0) return false;
  for (let i = 0; i < b.length; i += 2) {
    const u = littleEndian ? b[i]! | (b[i + 1]! << 8) : (b[i]! << 8) | b[i + 1]!;
    if (u >= 0xdc00 && u <= 0xdfff) return false;
    if (u >= 0xd800 && u <= 0xdbff) {
      const next =
        i + 3 < b.length
          ? littleEndian
            ? b[i + 2]! | (b[i + 3]! << 8)
            : (b[i + 2]! << 8) | b[i + 3]!
          : 0;
      if (next < 0xdc00 || next > 0xdfff) return false;
      i += 2;
    }
  }
  return true;
}

/** Decode text in the database encoding. `fatal` makes invalid text return null. */
export function decodeText(bytes: Uint8Array, enc: TextEncoding, fatal = false): string | null {
  if (fatal) {
    const ok = enc === 'utf-8' ? validUtf8(bytes) : validUtf16(bytes, enc === 'utf-16le');
    if (!ok) return null;
  }
  let decoder = decoders.get(enc);
  if (!decoder) {
    decoder = new TextDecoder(enc);
    decoders.set(enc, decoder);
  }
  return decoder.decode(bytes);
}

function readInt(b: Uint8Array, p: number, size: number): bigint {
  let v = 0n;
  for (let i = 0; i < size; i++) v = (v << 8n) | BigInt(b[p + i]!);
  // Two's complement.
  const bits = BigInt(size * 8);
  return v >= 1n << (bits - 1n) ? v - (1n << bits) : v;
}

/** One value of serial type `st` whose content starts at `p`; null if it is not valid text. */
export function decodeValue(
  b: Uint8Array,
  p: number,
  st: number,
  enc: TextEncoding,
  strict: boolean,
): CellValue | null {
  if (st === 0) return NULL_VALUE;
  if (st === 8) return { kind: 'int', value: 0n };
  if (st === 9) return { kind: 'int', value: 1n };
  if (st <= 6) return { kind: 'int', value: readInt(b, p, serialSize(st)) };
  if (st === 7) {
    const dv = new DataView(b.buffer, b.byteOffset + p, 8);
    return { kind: 'float', value: dv.getFloat64(0, false) };
  }
  const size = serialSize(st);
  const bytes = b.subarray(p, p + size);
  if (st % 2 === 0) return { kind: 'blob', value: bytes.slice() };
  const text = decodeText(bytes, enc, strict);
  return text === null ? null : { kind: 'text', value: text };
}

export interface ParsedRecord {
  /** Header length (the varint) and the serial types, in column order. */
  headerLen: number;
  serials: number[];
  values: CellValue[];
  /** Bytes the full record needs: header plus every column. */
  size: number;
  /** True when the end of the record lies beyond `limit` (data continues on overflow pages). */
  truncated: boolean;
}

/**
 * Parse the record that starts at `p`. `limit` is the end of the bytes that are really there
 * (the local part of a cell). Returns null when the header is not a valid record header.
 * With `strict` an invalid UTF-8 text makes the record invalid.
 */
export function parseRecord(
  b: Uint8Array,
  p: number,
  limit: number,
  enc: TextEncoding,
  strict = false,
): ParsedRecord | null {
  const hv = readVarint(b, p, limit);
  if (!hv || hv.value < 2 || hv.value > 8192 || p + hv.value > limit) return null;
  const headerEnd = p + hv.value;
  const serials: number[] = [];
  let q = p + hv.len;
  let dataSize = 0;
  while (q < headerEnd) {
    const sv = readVarint(b, q, headerEnd);
    if (!sv) return null;
    const size = serialSize(sv.value);
    if (size < 0 || size > 1 << 30) return null;
    serials.push(sv.value);
    dataSize += size;
    q += sv.len;
  }
  if (q !== headerEnd || serials.length === 0) return null;
  const values: CellValue[] = [];
  let d = headerEnd;
  let truncated = false;
  for (const st of serials) {
    const size = serialSize(st);
    if (d + size > limit) {
      // Only the start of this column is on the page.
      truncated = true;
      const have = Math.max(0, limit - d);
      const part = b.subarray(d, d + have);
      if (st >= 12) {
        const text = st % 2 === 1 ? decodeText(part, enc, false) : null;
        values.push(
          text !== null && st % 2 === 1
            ? { kind: 'text', value: text }
            : { kind: 'blob', value: part.slice() },
        );
      } else values.push({ kind: 'lost', value: part.slice() });
      d = limit;
      continue;
    }
    const v = decodeValue(b, d, st, enc, strict);
    if (!v) return null;
    values.push(v);
    d += size;
  }
  return { headerLen: hv.value, serials, values, size: hv.value + dataSize, truncated };
}

// ---------- pages ----------

export const PAGE_TABLE_INTERIOR = 5;
export const PAGE_TABLE_LEAF = 13;
export const PAGE_INDEX_INTERIOR = 2;
export const PAGE_INDEX_LEAF = 10;

export interface BtreePage {
  type: 2 | 5 | 10 | 13;
  /** Where the b-tree page header starts (100 on page 1, else 0). */
  base: number;
  firstFreeblock: number;
  cellCount: number;
  contentStart: number;
  fragmented: number;
  rightmost: number | null;
  cells: number[];
  /** End of the cell pointer array: the unallocated gap starts here. */
  arrayEnd: number;
}

/**
 * The b-tree header of a page, or null when the bytes cannot be one (wrong type, pointers outside
 * the page). `usable` is the page size minus the reserved bytes.
 */
export function parseBtreePage(page: Uint8Array, pageNo: number, usable: number): BtreePage | null {
  const base = pageNo === 1 ? 100 : 0;
  if (page.length < base + 8 || usable > page.length) return null;
  const type = page[base]!;
  if (type !== 2 && type !== 5 && type !== 10 && type !== 13) return null;
  const interior = type === 2 || type === 5;
  const headerSize = interior ? 12 : 8;
  const cellCount = u16be(page, base + 3);
  const arrayEnd = base + headerSize + 2 * cellCount;
  if (arrayEnd > usable) return null;
  const rawStart = u16be(page, base + 5);
  const contentStart = rawStart === 0 ? 65536 : rawStart;
  if (contentStart > usable || contentStart < arrayEnd) return null;
  const cells: number[] = [];
  for (let i = 0; i < cellCount; i++) {
    const ptr = u16be(page, base + headerSize + 2 * i);
    if (ptr < arrayEnd || ptr > usable - 4) return null;
    cells.push(ptr);
  }
  return {
    type,
    base,
    firstFreeblock: u16be(page, base + 1),
    cellCount,
    contentStart,
    fragmented: page[base + 7]!,
    rightmost: interior ? u32be(page, base + 8) : null,
    cells,
    arrayEnd,
  };
}

export interface FreeBlock {
  offset: number;
  size: number;
}

/** The freeblock chain of a page (stops quietly at the first inconsistent link). */
export function freeblocks(page: Uint8Array, bt: BtreePage, usable: number): FreeBlock[] {
  const out: FreeBlock[] = [];
  let at = bt.firstFreeblock;
  let last = -1;
  while (at !== 0 && out.length < 4096) {
    if (at <= last || at < bt.arrayEnd || at + 4 > usable) break;
    const size = u16be(page, at + 2);
    if (size < 4 || at + size > usable) break;
    out.push({ offset: at, size });
    last = at;
    at = u16be(page, at);
  }
  return out;
}

export interface CellExtent {
  /** Total bytes of the cell on this page. */
  size: number;
  /** Payload length in bytes (whole record, local part plus overflow). */
  payload: number;
  rowid: number | null;
  /** Offset of the record bytes. */
  recordAt: number;
  /** Bytes of the record on this page. */
  local: number;
  /** First overflow page, 0 when the whole record is local. */
  overflow: number;
  leftChild: number | null;
}

function localPayload(payload: number, usable: number, table: boolean): number | null {
  const x = table ? usable - 35 : Math.floor(((usable - 12) * 64) / 255) - 23;
  if (payload <= x) return payload;
  const m = Math.floor(((usable - 12) * 32) / 255) - 23;
  const k = m + ((payload - m) % (usable - 4));
  return k <= x ? k : m;
}

/** Size and layout of the cell at `at`, or null when it does not parse. */
export function cellExtent(
  page: Uint8Array,
  type: BtreePage['type'],
  at: number,
  usable: number,
): CellExtent | null {
  let p = at;
  let leftChild: number | null = null;
  if (type === PAGE_TABLE_INTERIOR || type === PAGE_INDEX_INTERIOR) {
    if (p + 4 > usable) return null;
    leftChild = u32be(page, p);
    p += 4;
    if (type === PAGE_TABLE_INTERIOR) {
      const key = readVarint(page, p, usable);
      return key
        ? {
            size: 4 + key.len,
            payload: 0,
            rowid: key.value,
            recordAt: p,
            local: 0,
            overflow: 0,
            leftChild,
          }
        : null;
    }
  }
  const pl = readVarint(page, p, usable);
  if (!pl) return null;
  p += pl.len;
  let rowid: number | null = null;
  if (type === PAGE_TABLE_LEAF) {
    const rv = readVarint(page, p, usable);
    if (!rv) return null;
    rowid = rv.value;
    p += rv.len;
  }
  const local = localPayload(pl.value, usable, type === PAGE_TABLE_LEAF);
  if (local === null) return null;
  const overflowPtr = local < pl.value;
  const end = p + local + (overflowPtr ? 4 : 0);
  if (end > usable) return null;
  return {
    size: end - at,
    payload: pl.value,
    rowid,
    recordAt: p,
    local,
    overflow: overflowPtr ? u32be(page, p + local) : 0,
    leftChild,
  };
}

// ---------- the file ----------

export class SqliteFile {
  readonly header: DbHeader;
  readonly pageSize: number;
  readonly usable: number;
  readonly pageCount: number;
  constructor(
    readonly bytes: Uint8Array,
    header: DbHeader,
  ) {
    this.header = header;
    this.pageSize = header.pageSize;
    this.usable = header.pageSize - header.reserved;
    this.pageCount = pageCountOf(header, bytes.length);
  }

  /** Pages that are completely in the file. */
  get presentPages(): number {
    return Math.min(this.pageCount, Math.floor(this.bytes.length / this.pageSize));
  }

  /** Page `n` (1-based) or null when the file does not hold all of it. */
  page(n: number): Uint8Array | null {
    if (n < 1 || n > this.presentPages) return null;
    return this.bytes.subarray((n - 1) * this.pageSize, n * this.pageSize);
  }

  /** Auto-vacuum pointer-map pages hold 5-byte entries, never records. */
  isPtrmap(n: number): boolean {
    if (this.header.largestRootPage === 0 || n < 2) return false;
    const per = Math.floor(this.usable / 5);
    return (n - 2) % (per + 1) === 0;
  }

  /** The page that contains the lock byte (file offset 2^30): never part of the data. */
  isLockPage(n: number): boolean {
    return n === Math.floor(0x40000000 / this.pageSize) + 1;
  }
}

export function openFile(bytes: Uint8Array): SqliteFile | null {
  const h = parseHeader(bytes);
  return h ? new SqliteFile(bytes, h) : null;
}

// ---------- freelist ----------

export interface Freelist {
  trunks: number[];
  /** Leaf pages: their old content is usually still there. */
  leaves: number[];
  /** Inconsistencies met while walking the chain (loops, pages outside the file). */
  problems: string[];
}

/** Walk the freelist trunks. Loops, bad page numbers and counts are reported in `problems`. */
export function walkFreelist(f: SqliteFile): Freelist {
  const out: Freelist = { trunks: [], leaves: [], problems: [] };
  const seen = new Set<number>();
  let trunk = f.header.firstFreelistTrunk;
  while (trunk !== 0) {
    if (seen.has(trunk)) {
      out.problems.push(`loop at page ${trunk}`);
      break;
    }
    seen.add(trunk);
    const page = f.page(trunk);
    if (!page) {
      out.problems.push(`trunk page ${trunk} is outside the file`);
      break;
    }
    out.trunks.push(trunk);
    const next = u32be(page, 0);
    const count = u32be(page, 4);
    const max = Math.floor(f.usable / 4) - 2;
    if (count > max) {
      out.problems.push(`trunk ${trunk} claims ${count} leaves (at most ${max})`);
    }
    for (let i = 0; i < Math.min(count, max); i++) {
      const leaf = u32be(page, 8 + 4 * i);
      if (leaf < 1 || leaf > f.pageCount || seen.has(leaf)) {
        out.problems.push(`trunk ${trunk} lists page ${leaf}, which is not a free page`);
        continue;
      }
      seen.add(leaf);
      out.leaves.push(leaf);
    }
    trunk = next;
  }
  return out;
}

// ---------- b-trees and the schema ----------

export interface SchemaEntry {
  type: string;
  name: string;
  table: string;
  rootPage: number;
  sql: string | null;
}

/** The full payload of a cell: the local part, then the overflow chain. */
export function cellPayload(
  f: SqliteFile,
  page: Uint8Array,
  ext: CellExtent,
  maxBytes = 1 << 20,
): Uint8Array {
  if (ext.overflow === 0) return page.subarray(ext.recordAt, ext.recordAt + ext.local);
  const out = new Uint8Array(Math.min(ext.payload, maxBytes));
  let n = Math.min(ext.local, out.length);
  out.set(page.subarray(ext.recordAt, ext.recordAt + n), 0);
  let next = ext.overflow;
  const seen = new Set<number>();
  while (next !== 0 && n < out.length && !seen.has(next)) {
    seen.add(next);
    const op = f.page(next);
    if (!op) break;
    const take = Math.min(f.usable - 4, out.length - n);
    out.set(op.subarray(4, 4 + take), n);
    n += take;
    next = u32be(op, 0);
  }
  return out.subarray(0, n);
}

export interface BtreeWalk {
  /** Interior and leaf pages of the tree that were reached. */
  pages: number[];
  /** Pages that could not be read as b-tree pages, or that were reached twice. */
  problems: string[];
}

/**
 * Visit every page of the b-tree rooted at `root`. `onLeafCell` gets each live cell of a table
 * leaf (rowid tables) or index leaf. A loop or an out-of-range child stops that branch.
 */
export function walkBtree(
  f: SqliteFile,
  root: number,
  onLeafCell?: (page: Uint8Array, bt: BtreePage, at: number, pageNo: number) => void,
  visited: Set<number> = new Set(),
): BtreeWalk {
  const out: BtreeWalk = { pages: [], problems: [] };
  const stack = [root];
  while (stack.length) {
    const no = stack.pop()!;
    if (visited.has(no)) {
      out.problems.push(`page ${no} reached twice`);
      continue;
    }
    visited.add(no);
    const page = f.page(no);
    if (!page) {
      out.problems.push(`page ${no} is outside the file`);
      continue;
    }
    const bt = parseBtreePage(page, no, f.usable);
    if (!bt) {
      out.problems.push(`page ${no} is not a b-tree page`);
      continue;
    }
    out.pages.push(no);
    if (bt.type === PAGE_TABLE_INTERIOR || bt.type === PAGE_INDEX_INTERIOR) {
      const children: number[] = [];
      for (const at of bt.cells) {
        const ext = cellExtent(page, bt.type, at, f.usable);
        if (ext?.leftChild) children.push(ext.leftChild);
      }
      if (bt.rightmost) children.push(bt.rightmost);
      // Pushed in reverse so that the left-most child is visited first.
      for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!);
    } else if (onLeafCell) {
      for (const at of bt.cells) onLeafCell(page, bt, at, no);
    }
  }
  return out;
}

/** sqlite_schema, read from page 1. */
export function readSchema(f: SqliteFile): { entries: SchemaEntry[]; problems: string[] } {
  const entries: SchemaEntry[] = [];
  const walk = walkBtree(f, 1, (page, bt, at) => {
    const ext = cellExtent(page, bt.type, at, f.usable);
    if (!ext) return;
    const payload = cellPayload(f, page, ext);
    const rec = parseRecord(payload, 0, payload.length, f.header.encoding);
    if (!rec || rec.values.length < 5) return;
    const [type, name, table, root, sql] = rec.values;
    if (type?.kind !== 'text' || name?.kind !== 'text' || table?.kind !== 'text') return;
    entries.push({
      type: type.value,
      name: name.value,
      table: table.value,
      rootPage: root?.kind === 'int' ? Number(root.value) : 0,
      sql: sql?.kind === 'text' ? sql.value : null,
    });
  });
  return { entries, problems: walk.problems };
}

/** Which table or index each reachable b-tree page belongs to, by page number. */
export function pageOwners(
  f: SqliteFile,
  schema: SchemaEntry[],
): Map<number, { owner: string; objectType: string }> {
  const out = new Map<number, { owner: string; objectType: string }>();
  out.set(1, { owner: 'sqlite_schema', objectType: 'table' });
  const visited = new Set<number>([1]);
  for (const e of schema) {
    if (e.rootPage < 2 || (e.type !== 'table' && e.type !== 'index')) continue;
    const walk = walkBtree(f, e.rootPage, undefined, visited);
    for (const n of walk.pages) out.set(n, { owner: e.name, objectType: e.type });
  }
  return out;
}
