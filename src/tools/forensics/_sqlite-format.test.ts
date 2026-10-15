import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadSql, openDatabase } from './_sqlite-engine';
import {
  cellExtent,
  decodeText,
  journalFromHeader,
  openFile,
  pageCountOf,
  parseBtreePage,
  parseHeader,
  parseRecord,
  readSchema,
  readVarint,
  serialSize,
  versionText,
  walkFreelist,
} from './_sqlite-format';

const sample = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../../../public/samples/${name}`, import.meta.url)));

describe('varints (https://www.sqlite.org/fileformat2.html, "Variable-Length Integer")', () => {
  const v = (...bytes: number[]) => readVarint(Uint8Array.from(bytes), 0);
  it('one byte holds 0 to 127', () => {
    expect(v(0x00)).toEqual({ value: 0, len: 1 });
    expect(v(0x7f)).toEqual({ value: 127, len: 1 });
  });
  it('the high bit says another byte follows', () => {
    expect(v(0x81, 0x00)).toEqual({ value: 128, len: 2 });
    expect(v(0xff, 0x7f)).toEqual({ value: 16383, len: 2 });
    expect(v(0x81, 0x80, 0x00)).toEqual({ value: 16384, len: 3 });
  });
  it('the ninth byte keeps all eight bits', () => {
    const r = v(0x81, 0x81, 0x81, 0x81, 0x81, 0x81, 0x81, 0x81, 0xff);
    expect(r!.len).toBe(9);
    // 7 bits of 1 in each of the eight first bytes, then 0xff: ((1<<56)+...+(1<<7)) + 255
    const expected = [1, 2, 3, 4, 5, 6, 7, 8].reduce((acc) => acc * 128 + 1, 0) * 256 + 255;
    expect(r!.value).toBe(expected);
  });
  it('stops at the end of the buffer', () => {
    expect(v(0x81)).toBeNull();
    expect(readVarint(Uint8Array.of(1, 2, 3), 3)).toBeNull();
  });
});

describe('serial types (the table in the record format section of the spec)', () => {
  it('sizes of the fixed types', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(serialSize)).toEqual([0, 1, 2, 3, 4, 6, 8, 8, 0, 0]);
  });
  it('10 and 11 are reserved', () => {
    expect(serialSize(10)).toBe(-1);
    expect(serialSize(11)).toBe(-1);
  });
  it('N >= 12: even is a BLOB of (N-12)/2 bytes, odd is text of (N-13)/2 bytes', () => {
    expect([12, 13, 14, 15, 20, 21].map(serialSize)).toEqual([0, 0, 1, 1, 4, 4]);
  });
});

describe('records', () => {
  it('reads NULL, a small integer, a float, text and a BLOB', () => {
    // header: length 6, types 0 (NULL), 1 (int8), 7 (float64), 17 (text of 2), 14 (BLOB of 1)
    const f64 = new DataView(new ArrayBuffer(8));
    f64.setFloat64(0, 3.25);
    const rec = Uint8Array.from([
      6,
      0,
      1,
      7,
      17,
      14,
      0xfb, // int8 -5
      ...new Uint8Array(f64.buffer),
      0x68,
      0x69, // "hi"
      0xaa,
    ]);
    const r = parseRecord(rec, 0, rec.length, 'utf-8')!;
    expect(r.values).toEqual([
      { kind: 'null' },
      { kind: 'int', value: -5n },
      { kind: 'float', value: 3.25 },
      { kind: 'text', value: 'hi' },
      { kind: 'blob', value: Uint8Array.of(0xaa) },
    ]);
    expect(r.size).toBe(rec.length);
  });
  it('reads 8-byte integers and the constants 0 and 1', () => {
    const rec = Uint8Array.from([4, 6, 8, 9, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe]);
    expect(parseRecord(rec, 0, rec.length, 'utf-8')!.values).toEqual([
      { kind: 'int', value: -2n },
      { kind: 'int', value: 0n },
      { kind: 'int', value: 1n },
    ]);
  });
  it('rejects a header that does not end where it says', () => {
    expect(parseRecord(Uint8Array.of(2, 0x81, 0x00, 5), 0, 4, 'utf-8')).toBeNull(); // a 2-byte type crossing the end of the header
    expect(parseRecord(Uint8Array.of(2, 10, 0), 0, 3, 'utf-8')).toBeNull(); // reserved type
    expect(parseRecord(Uint8Array.of(1), 0, 1, 'utf-8')).toBeNull(); // no column
  });
});

describe('text decoding', () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  it('accepts well-formed UTF-8, including 4-byte characters', () => {
    expect(decodeText(enc('café ☃ 𝄞'), 'utf-8', true)).toBe('café ☃ 𝄞');
  });
  it.each([
    ['a lone continuation byte', [0x80]],
    ['a truncated sequence', [0xc3]],
    ['an overlong form', [0xc0, 0x80]],
    ['an overlong 3-byte form', [0xe0, 0x80, 0x80]],
    ['a surrogate', [0xed, 0xa0, 0x80]],
    ['above U+10FFFF', [0xf4, 0x90, 0x80, 0x80]],
    ['a bad continuation', [0xc3, 0x28]],
  ])('refuses %s when strict', (_name, bytes) => {
    expect(decodeText(Uint8Array.from(bytes), 'utf-8', true)).toBeNull();
  });
  it('the same bytes decode with replacement characters when not strict', () => {
    expect(decodeText(Uint8Array.of(0xc3, 0x28), 'utf-8', false)).toBe('�(');
  });
  it('reads UTF-16 of either byte order and refuses lone surrogates when strict', () => {
    expect(decodeText(Uint8Array.of(0x41, 0x00, 0x3d, 0xd8, 0x00, 0xde), 'utf-16le', true)).toBe(
      'A😀',
    );
    expect(decodeText(Uint8Array.of(0x00, 0x41, 0xd8, 0x3d, 0xde, 0x00), 'utf-16be', true)).toBe(
      'A😀',
    );
    expect(decodeText(Uint8Array.of(0x3d, 0xd8, 0x41, 0x00), 'utf-16le', true)).toBeNull();
    expect(decodeText(Uint8Array.of(0x41), 'utf-16le', true)).toBeNull();
  });
});

describe('the header of the samples', () => {
  it('sqlite-app.db', () => {
    const h = parseHeader(sample('sqlite-app.db'))!;
    expect(h.pageSize).toBe(4096);
    expect(h.encoding).toBe('utf-8');
    expect(h.userVersion).toBe(3);
    expect(h.applicationId).toBe(1179796992);
    expect(h.reserved).toBe(0);
    expect(journalFromHeader(h)).toBe('rollback');
    expect(h.freelistCount).toBe(0);
    expect(versionText(h.sqliteVersion)).toMatch(/^3\.\d+\.\d+$/);
  });
  it('sqlite-wal.db says it is in WAL mode', () => {
    expect(journalFromHeader(parseHeader(sample('sqlite-wal.db'))!)).toBe('wal');
  });
  it('the page count follows the file size when the header count is not trusted', () => {
    const bytes = sample('sqlite-app.db');
    const h = parseHeader(bytes)!;
    expect(pageCountOf(h, bytes.length)).toBe(6);
    expect(pageCountOf({ ...h, versionValidFor: h.changeCounter + 1 }, bytes.length)).toBe(6);
    expect(pageCountOf({ ...h, pagesInHeader: 0 }, 5 * 4096)).toBe(5);
  });
  it('not a database', () => {
    expect(parseHeader(new TextEncoder().encode('hello world, this is not a database'))).toBeNull();
    const bad = sample('sqlite-app.db').slice();
    bad[16] = 0x03; // page size 0x300 = 768: not a power of two
    expect(parseHeader(bad)).toBeNull();
  });
  it('page size 1 means 65536', () => {
    const big = sample('sqlite-app.db').slice();
    big[16] = 0;
    big[17] = 1;
    expect(parseHeader(big)!.pageSize).toBe(65536);
  });
});

describe('pages, schema and freelist agree with the SQL engine', () => {
  const NAMES = [
    'sqlite-app.db',
    'sqlite-blob.db',
    'sqlite-deleted.db',
    'sqlite-chrome-history.db',
    'sqlite-firefox-places.db',
    'sqlite-wal.db',
  ];
  it.each(NAMES)('%s: the schema read from the pages is sqlite_schema', async (name) => {
    const bytes = sample(name);
    const db = await openDatabase(bytes);
    const engine = db.exec('SELECT type, name, tbl_name, rootpage, sql FROM sqlite_schema')[0]!
      .values;
    db.close();
    const own = readSchema(openFile(bytes)!);
    expect(own.problems).toEqual([]);
    const key = (r: unknown[]) => JSON.stringify(r);
    expect(
      own.entries.map((e) => key([e.type, e.name, e.table, e.rootPage, e.sql])).sort(),
    ).toEqual(engine.map(key).sort());
  });

  it('the freelist of the deleted sample: a trunk and its leaves, as the header counts them', () => {
    const f = openFile(sample('sqlite-deleted.db'))!;
    const free = walkFreelist(f);
    expect(free.problems).toEqual([]);
    expect(free.trunks.length + free.leaves.length).toBe(f.header.freelistCount);
    expect(free.trunks).toHaveLength(1);
  });

  it('every b-tree page of a sample parses, with cells inside the page', () => {
    const f = openFile(sample('sqlite-chrome-history.db'))!;
    let leaves = 0;
    for (let no = 1; no <= f.pageCount; no++) {
      const bt = parseBtreePage(f.page(no)!, no, f.usable);
      if (!bt) continue;
      if (bt.type === 13) leaves++;
      for (const at of bt.cells) {
        if (bt.type === 2 || bt.type === 5) continue;
        const ext = cellExtent(f.page(no)!, bt.type, at, f.usable)!;
        expect(at + ext.size).toBeLessThanOrEqual(f.usable);
      }
    }
    expect(leaves).toBeGreaterThan(3);
  });

  it('reads a UTF-16 database header and its schema text', async () => {
    const SQL = await loadSql();
    const db = new SQL.Database();
    db.run('PRAGMA encoding = "UTF-16be"');
    db.run('CREATE TABLE naïve (a TEXT)');
    const bytes = db.export();
    const f = openFile(bytes)!;
    expect(f.header.encoding).toBe('utf-16be');
    expect(readSchema(f).entries[0]!.name).toBe('naïve');
  });
});
