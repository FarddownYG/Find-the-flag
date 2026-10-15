import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { carveFile, type CarvedRecord } from './_sqlite-carve';
import { loadSql } from './_sqlite-engine';
import { openFile, parseBtreePage, type CellValue } from './_sqlite-format';
import { noise } from './_fixtures';

type Param = string | number | null | Uint8Array;
type Run = (sql: string, params?: Param[]) => void;

/** Build a database with sql.js, the engine the tool uses, and hand back the file bytes. */
async function build(setup: (run: Run, query: (sql: string) => unknown[][]) => void) {
  const SQL = await loadSql();
  const db = new SQL.Database();
  let live: unknown[][] = [];
  setup(
    (sql, params) => db.run(sql, params),
    (sql) => {
      live = db.exec(sql)[0]?.values ?? [];
      return live;
    },
  );
  const bytes = db.export();
  db.close();
  return bytes;
}

const show = (v: CellValue): string | number | null =>
  v.kind === 'null'
    ? null
    : v.kind === 'blob' || v.kind === 'lost'
      ? `<${v.value.length}>`
      : v.kind === 'int'
        ? Number(v.value)
        : v.value;
const rows = (rs: CarvedRecord[]) => rs.map((r) => r.values.map(show));
const carve = (bytes: Uint8Array) => carveFile(openFile(bytes)!);
const deleted = (bytes: Uint8Array) => carve(bytes).records.filter((r) => !r.liveCopy);

function rng(seed: number) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 4294967296;
  };
}
const WORDS =
  'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu'.split(
    ' ',
  );
const sentence = (r: () => number, n: number) =>
  Array.from({ length: n }, () => WORDS[Math.floor(r() * WORDS.length)]).join(' ');

/** Rows [a, b, c] of words, inserted into t(first, a, b, c) with the first column NULL (a rowid alias). */
function makeRows(n: number, seed: number): string[][] {
  const r = rng(seed);
  return Array.from({ length: n }, () => [
    sentence(r, 1 + Math.floor(r() * 2)),
    sentence(r, 2 + Math.floor(r() * 6)),
    sentence(r, 1 + Math.floor(r() * 3)),
  ]);
}

const ALIAS = 'CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT, b TEXT, c TEXT)';

/**
 * Insert `all` into t, delete the rowids picked, and check what the carver gives back: every
 * deleted row that is physically still in the file must come back with exactly its values, and
 * nothing that is still a row of the table may be reported as deleted.
 */
async function scenario(ddl: string, all: string[][], pick: (id: number) => boolean, alias = true) {
  let liveRows: unknown[][] = [];
  const bytes = await build((run, query) => {
    run(ddl);
    for (const row of all)
      run(
        `INSERT INTO t VALUES (${alias ? 'NULL' : '?'}, ?, ?, ?)`,
        alias ? row : [row[0]!, row[1]!, row[2]!, 'x'],
      );
    const ids = all.map((_, i) => i + 1).filter(pick);
    if (ids.length) run(`DELETE FROM t WHERE rowid IN (${ids.join(',')})`);
    liveRows = query('SELECT * FROM t');
  });
  const ids = all.map((_, i) => i + 1).filter(pick);
  const found = rows(deleted(bytes));
  const file = openFile(bytes)!;
  const buf = Buffer.from(bytes);
  /**
   * Is the text in a page that still has its b-tree header? A page that went to the freelist
   * whole has lost its header, and a cell in it whose first bytes were already overwritten by a
   * freeblock is only found as free-space text, not as a record.
   */
  const readable = (needle: string) => {
    for (let at = buf.indexOf(needle); at >= 0; at = buf.indexOf(needle, at + 1)) {
      const no = Math.floor(at / file.pageSize) + 1;
      if (parseBtreePage(file.page(no)!, no, file.usable)) return true;
    }
    return false;
  };
  const missing = ids.filter((id) => {
    const row = alias ? all[id - 1]! : [all[id - 1]![0]!, all[id - 1]![1]!, all[id - 1]![2]!, 'x'];
    return (
      readable(row.slice(-2).join('')) && !found.some((f) => row.every((cell) => f.includes(cell)))
    );
  });
  const live = new Set(liveRows.map((r) => r.join('\u0001')));
  const wrong = found.filter((f) =>
    live.has(f.map((v) => (v === null ? 'null' : String(v))).join('\u0001')),
  );
  return { found, missing, wrong, ids, bytes };
}

describe('carve: rows deleted from a table with a rowid alias', () => {
  const all = makeRows(60, 7);

  it('gives back one row deleted from the middle, exactly', async () => {
    const r = await scenario(ALIAS, all, (id) => id === 25);
    expect(r.found).toEqual([[null, ...all[24]!]]);
    const [rec] = deleted(r.bytes);
    expect(rec!.where).toBe('freeblock');
    expect(rec!.owner).toBe('t');
    expect(rec!.repaired).toBe(true);
    expect(rec!.rowid).toBeNull();
  });

  it('gives back the first row and the last row', async () => {
    for (const id of [1, 60]) {
      const r = await scenario(ALIAS, all, (x) => x === id);
      expect(r.found).toEqual([[null, ...all[id - 1]!]]);
    }
  });

  it('gives back rows deleted one by one', async () => {
    const r = await scenario(ALIAS, all, (id) => id % 7 === 0);
    expect(r.missing).toEqual([]);
    expect(r.found).toHaveLength(8);
    expect(new Set(r.found.map((f) => f.join('|')))).toEqual(
      new Set(all.filter((_, i) => (i + 1) % 7 === 0).map((row) => [null, ...row].join('|'))),
    );
  });

  it('cuts a run of consecutive deleted rows (one merged block) back into rows', async () => {
    const r = await scenario(ALIAS, all, (id) => id >= 20 && id <= 29);
    expect(r.missing).toEqual([]);
    expect(r.found).toHaveLength(10);
    for (const id of r.ids) expect(r.found).toContainEqual([null, ...all[id - 1]!]);
  });

  it('gives back every row when all of them are deleted', async () => {
    const r = await scenario(ALIAS, all.slice(0, 40), () => true);
    expect(r.missing).toEqual([]);
    expect(r.found).toHaveLength(40);
  });

  it('works on a table of many pages, with row ids above 127', async () => {
    const big = makeRows(400, 11);
    const r = await scenario(ALIAS, big, (id) => id % 13 === 0 || (id >= 200 && id < 206));
    expect(r.missing).toEqual([]);
    expect(r.wrong).toEqual([]);
    expect(r.found.length).toBeGreaterThanOrEqual(r.ids.length);
  });

  it('never reports a live row as deleted', async () => {
    const big = makeRows(300, 5);
    const r = await scenario(ALIAS, big, (id) => id % 2 === 0);
    expect(r.wrong).toEqual([]);
    expect(r.missing).toEqual([]);
  });
});

describe('carve: other tables and other ways to lose a row', () => {
  it('reads rows of a table without a rowid alias', async () => {
    const all = makeRows(40, 3);
    const r = await scenario(
      'CREATE TABLE t (z TEXT, a TEXT, b TEXT, c TEXT)',
      all,
      (id) => id % 5 === 0,
      false,
    );
    expect(r.missing).toEqual([]);
    expect(r.wrong).toEqual([]);
    for (const id of r.ids) {
      const row = all[id - 1]!;
      expect(r.found).toContainEqual([row[0], row[1], row[2], 'x']);
    }
  });

  it('reads integers, reals and BLOBs as what they are', async () => {
    const bytes = await build((run) => {
      run('CREATE TABLE m (id INTEGER PRIMARY KEY, n INTEGER, x REAL, s TEXT, b BLOB)');
      for (let i = 1; i <= 30; i++) {
        run('INSERT INTO m VALUES (NULL, ?, ?, ?, ?)', [
          i * 1000003,
          i + 0.5,
          `item number ${i}`,
          Uint8Array.from([i, 0xde, 0xad, 0xbe, 0xef]),
        ]);
      }
      run('DELETE FROM m WHERE id = 12');
    });
    const [rec] = deleted(bytes);
    expect(rec!.values.map((v) => v.kind)).toEqual(['null', 'int', 'float', 'text', 'blob']);
    expect(rec!.values[1]).toEqual({ kind: 'int', value: 12000036n });
    expect(rec!.values[2]).toEqual({ kind: 'float', value: 12.5 });
    expect(rec!.values[3]).toEqual({ kind: 'text', value: 'item number 12' });
    expect(rec!.values[4]).toEqual({
      kind: 'blob',
      value: Uint8Array.from([12, 0xde, 0xad, 0xbe, 0xef]),
    });
  });

  it('finds the old version of an UPDATEd row', async () => {
    const bytes = await build((run) => {
      run(ALIAS);
      run("INSERT INTO t VALUES (NULL, 'who', 'the password is hunter2', 'x')");
      for (const row of makeRows(20, 9)) run('INSERT INTO t VALUES (NULL, ?, ?, ?)', row);
      run(
        "UPDATE t SET b = 'the password was changed to a much longer sentence than before' WHERE a = 'who'",
      );
    });
    expect(rows(deleted(bytes))).toContainEqual([null, 'who', 'the password is hunter2', 'x']);
  });

  it('reads the rows of a dropped table from the freelist', async () => {
    const bytes = await build((run) => {
      run('CREATE TABLE keep (id INTEGER PRIMARY KEY, v TEXT)');
      run('CREATE TABLE gone (id INTEGER PRIMARY KEY, label TEXT, value TEXT)');
      for (let i = 1; i <= 60; i++) {
        run('INSERT INTO gone VALUES (NULL, ?, ?)', [
          `entry ${i}`,
          `payload of the dropped table, number ${i}`,
        ]);
      }
      run('DROP TABLE gone');
    });
    const res = carve(bytes);
    expect(res.stats.freeTrunks + res.stats.freeLeaves).toBeGreaterThan(0);
    const found = rows(res.records);
    for (let i = 1; i <= 60; i++) {
      expect(found).toContainEqual([
        null,
        `entry ${i}`,
        `payload of the dropped table, number ${i}`,
      ]);
    }
    // The freed pages' own cells keep their row ids.
    expect(
      res.records.filter((r) => r.where === 'freed page' && r.rowid !== null).length,
    ).toBeGreaterThan(40);
    // The CREATE statement of the dropped table is in the schema page's free space.
    expect(found.flat().some((v) => String(v).startsWith('CREATE TABLE gone'))).toBe(true);
  });

  it('reads the rows of a table emptied with DELETE FROM', async () => {
    const bytes = await build((run) => {
      run(ALIAS);
      for (const row of makeRows(25, 2)) run('INSERT INTO t VALUES (NULL, ?, ?, ?)', row);
      run('DELETE FROM t');
    });
    expect(deleted(bytes)).toHaveLength(25);
  });

  it('reads text in a UTF-16 database', async () => {
    const SQL = await loadSql();
    const db = new SQL.Database();
    db.run('PRAGMA encoding = "UTF-16le"');
    db.run('CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT)');
    for (let i = 1; i <= 12; i++)
      db.run('INSERT INTO t VALUES (NULL, ?)', [`ligne numéro ${i} é ☃`]);
    db.run('DELETE FROM t WHERE id = 5');
    const bytes = db.export();
    expect(openFile(bytes)!.header.encoding).toBe('utf-16le');
    expect(rows(deleted(bytes))).toEqual([[null, 'ligne numéro 5 é ☃']]);
  });

  it('shows the start of a deleted cell that continued on overflow pages', async () => {
    const long = 'long text '.repeat(900);
    const bytes = await build((run) => {
      run(ALIAS);
      for (const row of makeRows(5, 4)) run('INSERT INTO t VALUES (NULL, ?, ?, ?)', row);
      run('INSERT INTO t VALUES (NULL, ?, ?, ?)', ['big', long, 'end']);
      run("DELETE FROM t WHERE a = 'big'");
    });
    const found = deleted(bytes).filter((r) =>
      r.values.some((v) => v.kind === 'text' && v.value.startsWith('long text')),
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.truncated).toBe(true);
  });
});

describe('carve: what must not be found', () => {
  it('finds nothing when secure_delete erased the rows', async () => {
    const bytes = await build((run) => {
      run('PRAGMA secure_delete = ON');
      run(ALIAS);
      for (const row of makeRows(30, 6)) run('INSERT INTO t VALUES (NULL, ?, ?, ?)', row);
      run('DELETE FROM t WHERE id % 2 = 0');
    });
    expect(deleted(bytes)).toEqual([]);
  });

  it('finds nothing after a VACUUM', async () => {
    const bytes = await build((run) => {
      run(ALIAS);
      for (const row of makeRows(30, 6)) run('INSERT INTO t VALUES (NULL, ?, ?, ?)', row);
      run('DELETE FROM t WHERE id % 2 = 0');
      run('VACUUM');
    });
    expect(deleted(bytes)).toEqual([]);
  });

  it('finds nothing in a database with no deleted row', async () => {
    const bytes = await build((run) => {
      run(ALIAS);
      for (const row of makeRows(100, 8)) run('INSERT INTO t VALUES (NULL, ?, ?, ?)', row);
    });
    expect(deleted(bytes).filter((r) => !r.liveCopy)).toEqual([]);
  });

  it('does not make records out of noise in free pages', async () => {
    const bytes = readFileSync(
      new URL('../../../public/samples/sqlite-deleted.db', import.meta.url),
    );
    const copy = new Uint8Array(bytes);
    // Overwrite the freelist trunk (page 4) and its leaf pages with noise.
    for (const page of [3, 4, 5, 6]) copy.set(noise(4096, page * 7919, false), (page - 1) * 4096);
    // The trunk page claims leaves; its numbers are noise now, so rebuild a valid empty trunk.
    copy.fill(0, 3 * 4096, 3 * 4096 + 8);
    const res = carve(copy);
    expect(res.records.filter((r) => r.where === 'freed page')).toEqual([]);
  });

  it('stops when its time is up and says where', async () => {
    const bytes = readFileSync(
      new URL('../../../public/samples/sqlite-deleted.db', import.meta.url),
    );
    const res = carveFile(openFile(new Uint8Array(bytes))!, { timeBudgetMs: 0 });
    expect(res.stats.truncated).toBe(true);
    expect(res.stats.timedOutAtPage).toBe(1);
  });
});
