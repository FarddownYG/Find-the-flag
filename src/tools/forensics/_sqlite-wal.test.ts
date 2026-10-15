import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { openDatabase } from './_sqlite-engine';
import {
  WAL_FRAME_HEADER,
  WAL_HEADER,
  applyWal,
  framePage,
  looksLikeWal,
  pageKindOf,
  parseWal,
  walChecksum,
} from './_sqlite-wal';

const sample = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../../../public/samples/${name}`, import.meta.url)));

// public/samples/sqlite-wal.db-wal was written by scripts/gen-samples-sqlite.mjs. While building
// it, it was also opened with the real SQLite library (the sqlite3 module of Python, SQLite 3.45.1) next to
// sqlite-wal.db: SQLite replayed its committed transaction (the row FTF{in_the_wal} appeared),
// which only happens when the header checksum, the salts and every frame checksum are right.
describe('the sample write-ahead log', () => {
  const walBytes = sample('sqlite-wal.db-wal');
  const wal = parseWal(walBytes)!;

  it('has a good header', () => {
    expect(looksLikeWal(walBytes)).toBe(true);
    expect(wal.header.bigEndian).toBe(false);
    expect(wal.header.pageSize).toBe(4096);
    expect(wal.header.version).toBe(3007000);
    expect(wal.header.checksumOk).toBe(true);
    expect(wal.header.checkpointSeq).toBe(7);
  });

  it('has two frames of this log and one of an older generation', () => {
    expect(wal.frames).toHaveLength(3);
    expect(wal.frames.map((f) => f.page)).toEqual([1, 2, 2]);
    expect(wal.frames.map((f) => f.saltOk)).toEqual([true, true, false]);
    expect(wal.frames.map((f) => f.valid)).toEqual([true, true, false]);
    expect(wal.validFrames).toBe(2);
    expect(wal.committedFrames).toBe(2);
    expect(wal.dbPages).toBe(2);
    expect(wal.trailing).toBe(0);
  });

  it('only the last frame of a transaction commits', () => {
    expect(wal.frames.map((f) => f.commitSize)).toEqual([0, 2, 2]);
    expect(wal.frames.map((f) => f.committed)).toEqual([true, true, false]);
  });

  it('page images are table pages', () => {
    expect(pageKindOf(framePage(walBytes, wal, wal.frames[0]!), 1)).toBe('table-leaf');
    expect(pageKindOf(framePage(walBytes, wal, wal.frames[1]!), 2)).toBe('table-leaf');
  });

  it('applied to the database, it shows the newer state', async () => {
    const db = sample('sqlite-wal.db');
    const applied = applyWal(db, walBytes, wal);
    expect(applied.pages).toBe(2);
    expect(applied.changed).toEqual([1, 2]);
    // The inputs are untouched.
    expect(db).toEqual(sample('sqlite-wal.db'));
    const engine = await openDatabase(applied.bytes);
    const rows = engine.exec('SELECT id, author, body FROM notes ORDER BY id')[0]!.values;
    engine.close();
    expect(rows).toHaveLength(4);
    expect(rows[3]).toEqual([4, 'mallory', 'The flag is FTF{in_the_wal}']);
    expect(rows[1]![2]).toMatch(/\(edited\)$/);

    const before = await openDatabase(db);
    expect(before.exec('SELECT count(*) FROM notes')[0]!.values).toEqual([[3]]);
    before.close();
  });
});

describe('what makes a frame count', () => {
  const clean = sample('sqlite-wal.db-wal');

  it('a flipped bit in a page makes its checksum, and every later frame, invalid', () => {
    const bad = clean.slice();
    bad[WAL_HEADER + WAL_FRAME_HEADER + 100] = bad[WAL_HEADER + WAL_FRAME_HEADER + 100]! ^ 1; // inside frame 1's page
    const wal = parseWal(bad)!;
    expect(wal.validFrames).toBe(0);
    expect(wal.committedFrames).toBe(0);
    expect(wal.frames[0]!.saltOk).toBe(true);
    expect(wal.frames[0]!.checksumOk).toBe(false);
  });

  it('a wrong header checksum invalidates the whole log', () => {
    const bad = clean.slice();
    bad[24] = bad[24]! ^ 0xff;
    const wal = parseWal(bad)!;
    expect(wal.header.checksumOk).toBe(false);
    expect(wal.validFrames).toBe(0);
  });

  it('a log cut after a frame still counts that frame, and the cut tail is reported', () => {
    const cut = clean.slice(0, WAL_HEADER + 4120 + 100);
    const wal = parseWal(cut)!;
    expect(wal.frames).toHaveLength(1);
    expect(wal.trailing).toBe(100);
    // Frame 1 alone does not commit: a reader would ignore it.
    expect(wal.validFrames).toBe(1);
    expect(wal.committedFrames).toBe(0);
  });

  it('is not a log when the magic is wrong or the page size is not a power of two', () => {
    const noMagic = clean.slice();
    noMagic[3] = 0x84;
    expect(parseWal(noMagic)).toBeNull();
    const badSize = clean.slice();
    badSize[10] = 0x03;
    expect(parseWal(badSize)).toBeNull();
    expect(looksLikeWal(new Uint8Array(10))).toBe(false);
  });
});

describe('the checksum', () => {
  it('is the sum SQLite keeps: s1 += w0 + s2; s2 += w1 + s1, over 32-bit words', () => {
    // Two words, little-endian: 1 and 2 -> s1 = 0 + 1 + 0 = 1, s2 = 0 + 2 + 1 = 3.
    expect(walChecksum(Uint8Array.of(1, 0, 0, 0, 2, 0, 0, 0), 0, 8, false)).toEqual([1, 3]);
    // The same bytes read big-endian are the words 0x01000000 and 0x02000000.
    expect(walChecksum(Uint8Array.of(1, 0, 0, 0, 2, 0, 0, 0), 0, 8, true)).toEqual([
      0x01000000,
      (0x02000000 + 0x01000000) >>> 0,
    ]);
  });
  it('wraps at 32 bits and continues from a seed', () => {
    const [s1] = walChecksum(Uint8Array.of(255, 255, 255, 255, 1, 0, 0, 0), 0, 8, false, [1, 0]);
    expect(s1).toBe(0); // 1 + 0xffffffff wraps to 0
  });

  it('a log written with big-endian checksums (magic ...83) reads too', () => {
    const pageSize = 512;
    const u32 = (n: number) => Uint8Array.of(n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
    const cat = (...p: Uint8Array[]) => {
      const out = new Uint8Array(p.reduce((n, x) => n + x.length, 0));
      let o = 0;
      for (const x of p) {
        out.set(x, o);
        o += x.length;
      }
      return out;
    };
    const header = cat(u32(0x377f0683), u32(3007000), u32(pageSize), u32(1), u32(11), u32(22));
    let sum = walChecksum(header, 0, 24, true);
    const page = new Uint8Array(pageSize).map((_, i) => (i * 7) & 255);
    const fh = cat(u32(3), u32(3), u32(11), u32(22));
    sum = walChecksum(page, 0, pageSize, true, walChecksum(fh, 0, 8, true, sum));
    const log = cat(
      header,
      u32(walChecksum(header, 0, 24, true)[0]),
      u32(walChecksum(header, 0, 24, true)[1]),
      fh,
      u32(sum[0]),
      u32(sum[1]),
      page,
    );
    const wal = parseWal(log)!;
    expect(wal.header.bigEndian).toBe(true);
    expect(wal.header.checksumOk).toBe(true);
    expect(wal.frames[0]).toMatchObject({ page: 3, commitSize: 3, valid: true, committed: true });
    expect(wal.dbPages).toBe(3);
  });
});
