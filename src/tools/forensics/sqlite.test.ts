import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors';
import { lazyFile } from '../../core/prepare';
import { defaultOptions } from '../../core/registry';
import { resultToText } from '../../core/result-text';
import type { FileInput, Output } from '../../core/types';
import { carveFile } from './_sqlite-carve';
import { openFile } from './_sqlite-format';
import { getTool } from '../../core/registry';

const tool = getTool('sqlite')!;

const sample = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../../../public/samples/${name}`, import.meta.url)));

type Opts = Partial<ReturnType<typeof defaultOptions>> & { wal?: FileInput | null };

async function open(file: string | Uint8Array, opts: Opts = {}): Promise<Output[]> {
  const bytes = typeof file === 'string' ? sample(file) : file;
  const input = lazyFile(new Blob([bytes as BlobPart]), typeof file === 'string' ? file : 'x.db');
  return tool.run(input, { ...defaultOptions(tool), ...opts } as never);
}
const text = async (file: string | Uint8Array, opts: Opts = {}) =>
  resultToText(await open(file, opts));
const wal = (name: string): FileInput => ({ bytes: sample(name), name });

const table = (out: Output[], label: RegExp) =>
  out.find(
    (o): o is Extract<Output, { type: 'table' }> => o.type === 'table' && label.test(o.label ?? ''),
  );
const kv = (out: Output[], label: RegExp) =>
  Object.fromEntries(
    out.find(
      (o): o is Extract<Output, { type: 'kv' }> => o.type === 'kv' && label.test(o.label ?? ''),
    )!.entries,
  );

describe('SQLite tool: the overview', () => {
  it('shows the header of the app database', async () => {
    const out = await open('sqlite-app.db');
    const h = kv(out, /header/i);
    expect(h['Page size']).toBe('4096 B');
    expect(h['Text encoding']).toBe('UTF-8');
    expect(h['User version']).toBe('3');
    expect(h['Schema version (schema cookie)']).toBe('6');
    expect(h['Journal mode (from the header)']).toMatch(/^rollback journal/);
    expect(h['Freelist']).toBe('none');
    expect(h['Pages']).toBe('6');
  });

  it('lists tables, views, indexes and triggers with their row counts and CREATE statements', async () => {
    const out = await open('sqlite-app.db');
    const objects = table(out, /Tables, views/)!;
    const byName = new Map(objects.rows.map((r) => [r[1], r]));
    expect(byName.get('notes')).toEqual(['table', 'notes', 'notes', 8, 4]);
    expect(byName.get('users')![3]).toBe(3);
    expect(byName.get('recent_notes')![0]).toBe('view');
    expect(byName.get('notes_author')![0]).toBe('index');
    expect(byName.get('notes_log')![0]).toBe('trigger');
    const create = out.find((o) => o.type === 'text')!;
    expect((create as { value: string }).value).toContain(
      'CREATE TRIGGER notes_log AFTER INSERT ON notes',
    );
    expect((create as { value: string }).value).toContain('CREATE VIEW recent_notes AS SELECT');
  });

  it('finds the flag in a live cell and says where', async () => {
    const out = await open('sqlite-app.db');
    expect(table(out, /Flag candidates/)!.rows).toEqual([
      ['notes.body, row 3', 'FTF{sqlite_demo}'],
    ]);
  });

  it('uses a flag pattern of your own', async () => {
    const out = await open('sqlite-app.db', { flagPattern: 'vault code is \\w+' });
    expect(table(out, /Flag candidates/)!.rows.map((r) => r[1])).toContain('vault code is FTF');
  });
});

describe('SQLite tool: browsing', () => {
  it('shows one page of rows and offers the next', async () => {
    const out = await open('sqlite-app.db', { mode: 'browse', table: 'notes', rows: 3, page: 2 });
    const rows = table(out, /Rows/)!;
    expect(rows.label).toContain('rows 4–6 of 8');
    expect(rows.rows.map((r) => r[0])).toEqual(['4', '5', '6']);
    expect(rows.rows[0]![3]).toContain('Pancakes');
    const actions = out
      .filter((o) => o.type === 'actions')
      .flatMap((o) => (o as { actions: { label: string }[] }).actions);
    expect(actions.map((a) => a.label)).toEqual([
      'First page',
      'Previous page',
      'Next page',
      'Last page',
    ]);
  });

  it('never shows more rows than asked for', async () => {
    const out = await open('sqlite-deleted.db', { mode: 'browse', table: 'messages', rows: 2 });
    expect(table(out, /Rows/)!.rows).toHaveLength(2);
  });

  it('clamps a page past the end', async () => {
    const out = await open('sqlite-app.db', { mode: 'browse', table: 'notes', rows: 5, page: 99 });
    expect(table(out, /Rows/)!.label).toContain('rows 6–8 of 8');
    expect(resultToText(out)).toContain('The last page is 2');
  });

  it('describes the columns', async () => {
    const out = await open('sqlite-app.db', { mode: 'browse', table: 'users' });
    expect(table(out, /Columns of users/)!.rows).toEqual([
      ['id', 'INTEGER', '', '', '1'],
      ['name', 'TEXT', 'yes', '', ''],
      ['email', 'TEXT', '', '', ''],
    ]);
  });

  it('lists the tables when none is named, and says so when the name is wrong', async () => {
    const none = await open('sqlite-app.db', { mode: 'browse' });
    const buttons = none.find(
      (o): o is Extract<Output, { type: 'actions' }> => o.type === 'actions',
    )!;
    expect(buttons.actions.map((a) => a.options.table)).toContain('notes');
    expect(await text('sqlite-app.db', { mode: 'browse', table: 'nope' })).toContain(
      'no table or view called “nope”',
    );
  });

  it('matches a table name without regard to case', async () => {
    expect(await text('sqlite-app.db', { mode: 'browse', table: 'NOTES' })).toContain(
      'Shopping list',
    );
  });
});

describe('SQLite tool: BLOBs', () => {
  it('shows size, a hex preview and the file type of a BLOB cell', async () => {
    const out = await open('sqlite-blob.db', { mode: 'browse', table: 'files' });
    const rows = table(out, /Rows/)!.rows;
    expect(rows[0]![3]).toMatch(/^BLOB 363 B · 89 50 4e 47 0d 0a 1a 0a 00 00 00 0d … · PNG image$/);
    expect(rows[1]![3]).toMatch(/^BLOB 43 B · 47 49 46 38 39 61 .* GIF image$/);
    expect(rows[2]![3]).toMatch(/^BLOB 36 B · 4e 6f 74 68 .* · text$/);
  });

  it('offers every BLOB as a download whose bytes are the stored ones', async () => {
    const out = await open('sqlite-blob.db', { mode: 'browse', table: 'files' });
    const files = out.find(
      (o): o is Extract<Output, { type: 'files' }> => o.type === 'files',
    )!.files;
    expect(files.map((f) => f.name)).toEqual([
      'files_data_row1.png',
      'files_data_row2.gif',
      'files_data_row3.txt',
    ]);
    expect(Array.from(files[0]!.data.subarray(0, 8))).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    expect(files[0]!.data).toHaveLength(363);
    expect(new TextDecoder().decode(files[2]!.data)).toBe('Nothing to see here.\nFTF{blob_text}\n');
  });

  it('shows pictures for the images and finds a flag inside a text BLOB', async () => {
    const out = await open('sqlite-blob.db', { mode: 'browse', table: 'files' });
    const pictures = out.filter(
      (o): o is Extract<Output, { type: 'picture' }> => o.type === 'picture',
    );
    expect(pictures.map((p) => p.mime)).toEqual(['image/png', 'image/gif']);
    const flags = await open('sqlite-blob.db', { mode: 'flags' });
    expect(table(flags, /Flag candidates/)!.rows).toContainEqual([
      'files.data, row 3',
      'FTF{blob_text}',
    ]);
  });
});

describe('SQLite tool: read-only SQL', () => {
  it('runs a SELECT, a WITH and a read-only PRAGMA', async () => {
    const select = await open('sqlite-app.db', {
      mode: 'sql',
      sql: 'SELECT author, count(*) AS n FROM notes GROUP BY author ORDER BY author',
    });
    expect(table(select, /Result/)!.rows).toEqual([
      ['alice', '3'],
      ['bob', '3'],
      ['carol', '2'],
    ]);
    const cte = await open('sqlite-app.db', {
      mode: 'sql',
      sql: 'WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n<4) SELECT sum(n) FROM c',
    });
    expect(table(cte, /Result/)!.rows).toEqual([['10']]);
    const pragma = await open('sqlite-app.db', { mode: 'sql', sql: 'PRAGMA page_size' });
    expect(table(pragma, /Result/)!.rows).toEqual([['4096']]);
    const info = await open('sqlite-app.db', { mode: 'sql', sql: 'PRAGMA table_info(users)' });
    expect(table(info, /Result/)!.rows.map((r) => r[1])).toEqual(['id', 'name', 'email']);
  });

  it('pages through a long result and says there is more', async () => {
    const out = await open('sqlite-app.db', {
      mode: 'sql',
      sql: 'SELECT id FROM notes ORDER BY id',
      rows: 3,
      page: 2,
    });
    expect(table(out, /Result/)!.rows).toEqual([['4'], ['5'], ['6']]);
    expect(resultToText(out)).toContain('Next page');
  });

  it.each([
    ['DELETE FROM notes', /DELETE is refused: this box only reads/],
    ["UPDATE notes SET body = 'x'", /UPDATE is refused/],
    ["INSERT INTO notes (author) VALUES ('x')", /INSERT is refused/],
    ['DROP TABLE notes', /DROP is refused: this box does not change the schema/],
    ["ATTACH DATABASE 'x.db' AS x", /ATTACH is refused: attaching another database/],
    ["SELECT load_extension('x')", /load_extension\(\) is refused: loading extensions/],
    ['PRAGMA user_version = 9', /PRAGMA user_version is refused in this form/],
    ['VACUUM', /VACUUM is refused/],
    ['SELECT 1; SELECT 2', /One statement at a time/],
    ['WITH x AS (SELECT 1) DELETE FROM notes', /DELETE is refused/],
  ])('refuses %s and says why', async (sql, why) => {
    const run = open('sqlite-app.db', { mode: 'sql', sql });
    await expect(run).rejects.toBeInstanceOf(ToolError);
    await expect(run).rejects.toThrow(why);
  });

  it('leaves the file as it was', async () => {
    const bytes = sample('sqlite-app.db');
    const before = bytes.slice();
    await open(bytes, { mode: 'sql', sql: 'SELECT * FROM notes' }).catch(() => undefined);
    await open(bytes, { mode: 'sql', sql: 'DELETE FROM notes' }).catch(() => undefined);
    expect(bytes).toEqual(before);
    expect(await text(bytes, { mode: 'sql', sql: 'SELECT count(*) FROM notes' })).toContain('8');
  });

  it("reports SQLite's own error for a statement it cannot run", async () => {
    await expect(
      open('sqlite-app.db', { mode: 'sql', sql: 'SELECT * FROM missing_table' }),
    ).rejects.toThrow(/SQLite refused the statement: no such table: missing_table/);
  });

  it('warns that big integers are approximate', async () => {
    const out = await open('sqlite-app.db', { mode: 'sql', sql: 'SELECT 9007199254740993' });
    expect(resultToText(out)).toContain('larger than 2^53');
  });
});

describe('SQLite tool: deleted records', () => {
  const f = openFile(sample('sqlite-deleted.db'))!;
  const carved = carveFile(f);

  it('carves the row that was DELETEd, exactly', () => {
    const rows = carved.records.map((r) => r.values);
    expect(rows).toContainEqual([
      { kind: 'null' },
      { kind: 'text', value: 'dave' },
      { kind: 'text', value: 'The access token is FTF{deleted_row}, delete this after reading' },
    ]);
    const hit = carved.records.find((r) =>
      r.values.some((v) => v.kind === 'text' && v.value.includes('FTF{deleted_row}')),
    )!;
    expect(hit).toMatchObject({ owner: 'messages', where: 'freeblock', page: 2, repaired: true });
  });

  it('carves the last row too (in the unallocated gap, with its row id)', () => {
    const last = carved.records.find((r) =>
      r.values.some((v) => v.kind === 'text' && v.value === 'Last message: see you there'),
    )!;
    expect(last).toMatchObject({
      owner: 'messages',
      where: 'unallocated',
      rowid: 9,
      confidence: 'high',
    });
  });

  it('carves the rows of the dropped table from the freelist', () => {
    const freed = carved.records.filter((r) => r.where === 'freed page');
    expect(freed).toHaveLength(90);
    expect(freed.map((r) => r.rowid).sort((a, b) => a! - b!)).toEqual(
      Array.from({ length: 90 }, (_, i) => i + 1),
    );
    const row17 = freed.find((r) => r.rowid === 17)!;
    expect(row17.values[2]).toEqual({
      kind: 'text',
      value:
        'archived credential FTF{freelist_page} for the old server, kept in the table for later',
    });
  });

  it('keeps the dropped table definition from the schema page', () => {
    const create = carved.records.find((r) => r.owner === 'sqlite_schema')!;
    expect(create.values[4]).toEqual({
      kind: 'text',
      value: 'CREATE TABLE secrets (id INTEGER PRIMARY KEY, label TEXT, value TEXT)',
    });
  });

  it('lists them with their page, marked as possibly deleted', async () => {
    const out = await open('sqlite-deleted.db', { mode: 'deleted' });
    const t = resultToText(out);
    expect(t).toContain('possibly deleted');
    const rows = table(out, /Possibly deleted records/)!.rows;
    const row = rows.find((r) => String(r[3]).includes('FTF{deleted_row}'))!;
    expect(row.slice(0, 3)).toEqual(['2 · 3867', 'freeblock', 'medium*']);
    expect(row[3]).toBe(
      'messages → id=NULL | sender=dave | body=The access token is FTF{deleted_row}, delete this after reading',
    );
    const last = rows.find((r) => String(r[3]).includes('Last message'))!;
    expect(last[3]).toBe('messages #9 → id=NULL | sender=dave | body=Last message: see you there');
  });

  it('says so when nothing is left', async () => {
    expect(await text('sqlite-app.db', { mode: 'deleted' })).toContain(
      'No record left in free space was found',
    );
  });

  it('finds flags in deleted records and in the live rows', async () => {
    const flags = table(
      await open('sqlite-deleted.db', { mode: 'flags' }),
      /Flag candidates/,
    )!.rows.map((r) => r[1]);
    expect(flags).toContain('FTF{deleted_row}');
    expect(flags).toContain('FTF{freelist_page}');
  });
});

describe('SQLite tool: Chrome and Firefox history', () => {
  it('Chrome: WebKit microseconds become UTC, newest first', async () => {
    const out = await open('sqlite-chrome-history.db', { mode: 'history' });
    const summary = kv(out, /History/);
    expect(summary['Browser']).toBe('Chrome');
    expect(summary['First visit (UTC)']).toBe('2024-03-14T09:26:53.123Z');
    expect(summary['Last visit (UTC)']).toBe('2024-03-15T11:01:40.000Z');
    const visits = table(out, /Visits/)!.rows;
    expect(visits).toHaveLength(6);
    expect(visits[0]!.slice(0, 2)).toEqual([
      '2024-03-15T11:01:40.000Z',
      'https://docs.example.net/sqlite/wal',
    ]);
    expect(visits[5]!.slice(0, 4)).toEqual([
      '2024-03-14T09:26:53.123Z',
      'https://www.example.com/',
      'Example Domain',
      'typed',
    ]);
    expect(table(out, /Downloads/)!.rows[0]).toEqual([
      '2024-03-14T10:28:20.000Z',
      '/mnt/data/Downloads/challenge.zip',
      20480,
      'https://ctf.example.org/challenges',
    ]);
    expect(table(out, /Search terms/)!.rows.flat()).toContain('ctf sqlite forensics');
  });

  it('Firefox: PRTime microseconds become UTC', async () => {
    const out = await open('sqlite-firefox-places.db', { mode: 'history' });
    const summary = kv(out, /History/);
    expect(summary['Browser']).toBe('Firefox');
    expect(summary['First visit (UTC)']).toBe('2023-11-14T22:13:20.250Z');
    const visits = table(out, /Visits/)!.rows;
    expect(visits.map((r) => r[0])).toContain('2023-11-14T22:13:20.250Z');
    expect(visits.at(-1)![3]).toBe('typed');
  });

  it('the overview recognises a browser history and offers its view', async () => {
    const t = await text('sqlite-chrome-history.db');
    expect(t).toContain('Chrome / Chromium history');
    expect(await text('sqlite-firefox-places.db')).toContain('Firefox places.sqlite');
    expect(await text('sqlite-app.db', { mode: 'history' })).toContain(
      'does not look like a Chrome history',
    );
  });
});

describe('SQLite tool: write-ahead log', () => {
  it('shows the committed state when the -wal file is given', async () => {
    const out = await open('sqlite-wal.db', {
      wal: wal('sqlite-wal.db-wal'),
      mode: 'browse',
      table: 'notes',
    });
    const rows = table(out, /Rows/)!.rows;
    expect(rows).toHaveLength(4);
    expect(rows[3]![2]).toBe('The flag is FTF{in_the_wal}');
  });

  it('shows the older state without it, and says the file may have a log', async () => {
    const out = await open('sqlite-wal.db', { mode: 'browse', table: 'notes' });
    expect(table(out, /Rows/)!.rows).toHaveLength(3);
    expect(await text('sqlite-wal.db')).toContain('in WAL mode');
  });

  it('lists the frames and what the log adds', async () => {
    const out = await open('sqlite-wal.db', { wal: wal('sqlite-wal.db-wal'), mode: 'wal' });
    const frames = table(out, /Frames/)!.rows;
    expect(frames.map((r) => [r[0], r[1], r[4]])).toEqual([
      [1, 1, 'applied'],
      [2, 2, 'applied'],
      [3, 2, 'older log generation'],
    ]);
    expect(table(out, /Rows per table/)!.rows).toEqual([['notes', 3, 4]]);
    expect(table(out, /adds or changes/)!.rows.map((r) => r[1])).toEqual([
      '2 | 2 | bob | A copy of the .db without its -wal is an older state (edited)',
      '4 | 4 | mallory | The flag is FTF{in_the_wal}',
    ]);
    expect(table(out, /removes or replaces/)!.rows).toHaveLength(1);
    expect(kv(out, /WAL header/)['Header checksum']).toBe('correct');
  });

  it('can leave the frames out', async () => {
    const out = await open('sqlite-wal.db', {
      wal: wal('sqlite-wal.db-wal'),
      applyWal: false,
      mode: 'browse',
      table: 'notes',
    });
    expect(table(out, /Rows/)!.rows).toHaveLength(3);
    expect(
      await text('sqlite-wal.db', { wal: wal('sqlite-wal.db-wal'), applyWal: false, mode: 'wal' }),
    ).toContain('not applied');
  });

  it('a -wal file opened on its own is recognised, with the rows its pages carry', async () => {
    const out = await open('sqlite-wal.db-wal');
    expect(resultToText(out)).toContain('This file is a SQLite write-ahead log');
    const rows = table(out, /Rows in the table pages/)!.rows;
    expect(rows.map((r) => r[4])).toContain('NULL | mallory | The flag is FTF{in_the_wal}');
    // The older generation's row is listed too, marked as older.
    const old = rows.find((r) => String(r[4]).includes('FTF{older_wal}'))!;
    expect(old[2]).toBe('older log generation');
  });

  it('refuses a log made for another page size', async () => {
    const other = sample('sqlite-wal.db-wal').slice();
    other[10] = 0x08; // page size 0x800 = 2048
    const t = await text('sqlite-wal.db', { wal: { bytes: other, name: 'x-wal' }, mode: 'wal' });
    expect(t).toContain('does not belong to this database');
  });

  it('refuses a "log" that is not one', async () => {
    await expect(
      open('sqlite-wal.db', { wal: { bytes: new Uint8Array(100), name: 'x' } }),
    ).rejects.toThrow(/does not look like a write-ahead log/);
  });
});

describe('SQLite tool: files that are not databases, or not whole ones', () => {
  it('says what is wrong with an empty file or a text file', async () => {
    await expect(open(new Uint8Array(0))).rejects.toThrow('The file is empty.');
    await expect(open(new TextEncoder().encode('just some text'))).rejects.toThrow(
      /not a SQLite database/,
    );
  });

  it('recognises what an encrypted database looks like', async () => {
    const noise = new Uint8Array(4096).map((_, i) => (i * 2654435761) >>> 24);
    await expect(open(noise)).rejects.toThrow(/SQLCipher/);
  });

  it('refuses a header whose page size is nonsense, and says what to repair', async () => {
    const bad = sample('sqlite-app.db').slice();
    bad[16] = 0x03;
    await expect(open(bad)).rejects.toThrow(/offset 16/);
  });

  it('a file cut in the middle of a page still gives its header, its pages and a warning', async () => {
    const cut = sample('sqlite-app.db').slice(0, 5 * 4096 + 100);
    const out = await open(cut);
    expect(resultToText(out)).toContain('The file ends 100 bytes after the last whole page');
    expect(resultToText(out)).toContain('The header says 6 pages but the file holds only 5');
    expect(kv(out, /header/i)['Pages']).toBe('6 in the header, 5 from the file size');
  });

  it('when SQLite cannot open the file the header and the free-space scan still work', async () => {
    const broken = sample('sqlite-deleted.db').slice();
    // Page 1 holds the schema: an invalid b-tree type byte makes SQLite refuse the whole file.
    broken[100] = 0x55;
    const out = await open(broken);
    expect(resultToText(out)).toContain('SQLite could not open this file');
    expect(kv(out, /header/i)['Page size']).toBe('4096 B');
    const deleted = await open(broken, { mode: 'deleted' });
    expect(resultToText(deleted)).toContain('FTF{deleted_row}');
    await expect(open(broken, { mode: 'browse', table: 'messages' })).rejects.toThrow(
      /SQLite could not open this file/,
    );
  });

  it('a damaged page in the middle of a table is reported, and the rest still shows', async () => {
    const broken = sample('sqlite-deleted.db').slice();
    // Page 2 is the root of "messages": its type byte is wrong, so reading the table fails.
    broken[4096] = 0x55;
    const out = await open(broken);
    expect(resultToText(out)).toContain(
      'Reading the table “messages” failed: database disk image is malformed',
    );
    expect(kv(out, /header/i)['Page size']).toBe('4096 B');
    await expect(open(broken, { mode: 'browse', table: 'messages' })).rejects.toThrow(
      /SQLite could not read the rows/,
    );
  });

  it('opens a UTF-16 database and shows its text', async () => {
    const { loadSql } = await import('./_sqlite-engine');
    const SQL = await loadSql();
    const db = new SQL.Database();
    db.run('PRAGMA encoding = "UTF-16le"');
    db.run('CREATE TABLE t (a TEXT)');
    db.run("INSERT INTO t VALUES ('héllo FTF{utf16}')");
    const out = await open(db.export(), { mode: 'browse', table: 't' });
    expect(resultToText(out)).toContain('héllo FTF{utf16}');
    expect(kv(await open(db.export()), /header/i)['Text encoding']).toBe('UTF-16LE');
  });

  it('a rollback journal is recognised and not mistaken for a database', async () => {
    const journal = new Uint8Array(512 + 4104).fill(0);
    journal.set([0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7], 0);
    journal.set([0, 0, 0, 1], 8);
    journal.set([0, 0, 0, 6], 16);
    journal.set([0, 0, 2, 0], 20);
    journal.set([0, 0, 16, 0], 24);
    const t = await text(journal);
    expect(t).toContain('rollback journal');
    expect(t).toContain('Page size: 4096 B');
  });

  it('refuses a file that is too large for the browser', async () => {
    const input = {
      name: 'big.db',
      size: 200 * 1024 * 1024,
      blob: new Blob([]),
      read: async () => new Uint8Array(0),
    };
    await expect(tool.run(input as never, defaultOptions(tool) as never)).rejects.toThrow(
      /more than the 128\.00 MiB/,
    );
  });
});

describe('SQLite tool: triage', () => {
  it('recognises a database and a log by their first bytes', () => {
    const detect = tool.detect!;
    expect(detect({ text: null, bytes: sample('sqlite-app.db') })!.score).toBeGreaterThan(0.9);
    expect(detect({ text: null, bytes: sample('sqlite-wal.db-wal') })!.score).toBeGreaterThan(0.85);
    expect(detect({ text: 'hello', bytes: new TextEncoder().encode('hello') })).toBeNull();
  });
});
