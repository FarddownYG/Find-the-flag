/**
 * The write-ahead log (https://www.sqlite.org/fileformat2.html#walformat). A -wal file holds
 * whole pages that were written after the last checkpoint: the database file does not show them
 * until the log is checkpointed, so a database copied without its -wal file is an older state.
 */
import { u32be } from '../../lib/bytes';
import {
  PAGE_INDEX_INTERIOR,
  PAGE_INDEX_LEAF,
  PAGE_TABLE_INTERIOR,
  PAGE_TABLE_LEAF,
} from './_sqlite-format';

export const WAL_HEADER = 32;
export const WAL_FRAME_HEADER = 24;

export interface WalHeader {
  magic: number;
  /** The checksum reads its words big-endian (magic ends in 3). */
  bigEndian: boolean;
  version: number;
  pageSize: number;
  checkpointSeq: number;
  salt1: number;
  salt2: number;
  checksum1: number;
  checksum2: number;
  checksumOk: boolean;
}

export interface WalFrame {
  /** 1-based position in the file. */
  index: number;
  offset: number;
  page: number;
  /** Database size in pages after this commit, 0 when the frame does not commit. */
  commitSize: number;
  salt1: number;
  salt2: number;
  /** The salts equal the header's: the frame belongs to this generation of the log. */
  saltOk: boolean;
  checksumOk: boolean;
  /** Part of the chain SQLite would replay (all frames before it are valid too). */
  valid: boolean;
  /** Valid and followed (at or after it) by a commit frame: applied by a reader. */
  committed: boolean;
}

export interface WalInfo {
  header: WalHeader;
  frames: WalFrame[];
  /** Frames of the valid chain. */
  validFrames: number;
  /** Frames a reader replays: the valid chain up to its last commit. */
  committedFrames: number;
  /** Database size in pages after the last commit (0 when nothing is committed). */
  dbPages: number;
  /** Bytes after the last whole frame. */
  trailing: number;
}

const WAL_MAGICS = [0x377f0682, 0x377f0683];

export function looksLikeWal(b: Uint8Array): boolean {
  if (b.length < WAL_HEADER || !WAL_MAGICS.includes(u32be(b, 0))) return false;
  const pageSize = u32be(b, 8);
  return pageSize >= 512 && pageSize <= 65536 && (pageSize & (pageSize - 1)) === 0;
}

/** The checksum SQLite keeps along the log: two running sums over 32-bit words. */
export function walChecksum(
  b: Uint8Array,
  start: number,
  length: number,
  bigEndian: boolean,
  seed: [number, number] = [0, 0],
): [number, number] {
  let [s1, s2] = seed;
  for (let i = start; i < start + length; i += 8) {
    const w = (o: number) =>
      bigEndian
        ? u32be(b, o)
        : (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
    s1 = (s1 + w(i) + s2) >>> 0;
    s2 = (s2 + w(i + 4) + s1) >>> 0;
  }
  return [s1, s2];
}

export function parseWal(b: Uint8Array): WalInfo | null {
  if (!looksLikeWal(b)) return null;
  const magic = u32be(b, 0);
  const bigEndian = (magic & 1) === 1;
  const pageSize = u32be(b, 8);
  const [h1, h2] = walChecksum(b, 0, 24, bigEndian);
  const header: WalHeader = {
    magic,
    bigEndian,
    version: u32be(b, 4),
    pageSize,
    checkpointSeq: u32be(b, 12),
    salt1: u32be(b, 16),
    salt2: u32be(b, 20),
    checksum1: u32be(b, 24),
    checksum2: u32be(b, 28),
    checksumOk: false,
  };
  header.checksumOk = h1 === header.checksum1 && h2 === header.checksum2;

  const frameSize = WAL_FRAME_HEADER + pageSize;
  const count = Math.floor((b.length - WAL_HEADER) / frameSize);
  const frames: WalFrame[] = [];
  let sum: [number, number] = [header.checksum1, header.checksum2];
  let chain = header.checksumOk;
  let lastCommit = 0;
  for (let i = 0; i < count; i++) {
    const offset = WAL_HEADER + i * frameSize;
    const salt1 = u32be(b, offset + 8);
    const salt2 = u32be(b, offset + 12);
    const saltOk = salt1 === header.salt1 && salt2 === header.salt2;
    let checksumOk = false;
    if (chain && saltOk) {
      let s = walChecksum(b, offset, 8, bigEndian, sum);
      s = walChecksum(b, offset + WAL_FRAME_HEADER, pageSize, bigEndian, s);
      checksumOk = s[0] === u32be(b, offset + 16) && s[1] === u32be(b, offset + 20);
      if (checksumOk) sum = s;
    }
    const valid = chain && saltOk && checksumOk;
    if (!valid) chain = false;
    const commitSize = u32be(b, offset + 4);
    if (valid && commitSize !== 0) lastCommit = i + 1;
    frames.push({
      index: i + 1,
      offset,
      page: u32be(b, offset),
      commitSize,
      salt1,
      salt2,
      saltOk,
      checksumOk,
      valid,
      committed: false,
    });
  }
  for (const fr of frames) fr.committed = fr.valid && fr.index <= lastCommit;
  return {
    header,
    frames,
    validFrames: frames.filter((f) => f.valid).length,
    committedFrames: lastCommit,
    dbPages: lastCommit ? frames[lastCommit - 1]!.commitSize : 0,
    trailing: (b.length - WAL_HEADER) % frameSize,
  };
}

/** The page image a frame carries. */
export const framePage = (b: Uint8Array, wal: WalInfo, fr: WalFrame): Uint8Array =>
  b.subarray(fr.offset + WAL_FRAME_HEADER, fr.offset + WAL_FRAME_HEADER + wal.header.pageSize);

export interface AppliedWal {
  bytes: Uint8Array;
  /** Pages that now differ from the database file, ascending. */
  changed: number[];
  pages: number;
}

/**
 * The database as a reader would see it with the log: every committed frame written over the
 * file, later frames over earlier ones, and the size the last commit gives. The inputs are not
 * modified.
 */
export function applyWal(db: Uint8Array, walBytes: Uint8Array, wal: WalInfo): AppliedWal {
  const pageSize = wal.header.pageSize;
  const pages = wal.dbPages || Math.floor(db.length / pageSize);
  const out = new Uint8Array(pages * pageSize);
  out.set(db.subarray(0, Math.min(db.length, out.length)));
  const touched = new Set<number>();
  for (const fr of wal.frames) {
    if (!fr.committed || fr.page < 1 || fr.page > pages) continue;
    out.set(framePage(walBytes, wal, fr), (fr.page - 1) * pageSize);
    touched.add(fr.page);
  }
  const differs = (page: number) => {
    const at = (page - 1) * pageSize;
    for (let i = 0; i < pageSize; i++) if (out[at + i] !== (db[at + i] ?? 0)) return true;
    return false;
  };
  return { bytes: out, changed: [...touched].filter(differs).sort((a, b) => a - b), pages };
}

export type WalPageKind =
  'table-leaf' | 'table-interior' | 'index-leaf' | 'index-interior' | 'other';

/** What kind of page an image is, from its first byte (page 1 starts after the 100-byte header). */
export function pageKindOf(data: Uint8Array, pageNo: number): WalPageKind {
  switch (data[pageNo === 1 ? 100 : 0]) {
    case PAGE_TABLE_LEAF:
      return 'table-leaf';
    case PAGE_TABLE_INTERIOR:
      return 'table-interior';
    case PAGE_INDEX_LEAF:
      return 'index-leaf';
    case PAGE_INDEX_INTERIOR:
      return 'index-interior';
    default:
      return 'other';
  }
}
