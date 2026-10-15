/**
 * sql.js (SQLite compiled to WebAssembly, MIT) loaded on demand. The .wasm is a build asset
 * served from our own origin: no CDN, no network beyond the page's own files. The database is
 * opened from an in-memory copy of the bytes; nothing is ever written back to the user's file.
 *
 * In Node (the unit tests) sql.js finds its own .wasm next to its script; in the browser the URL
 * of the bundled asset is passed through `locateFile`.
 */
import initSqlJs, { type Database, type SqlJsStatic, type SqlValue, type Statement } from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm-browser.wasm?url';

export type { Database, SqlValue, Statement };

let loading: Promise<SqlJsStatic> | null = null;

const inNode = (): boolean =>
  typeof (globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node ===
  'string';

export function loadSql(): Promise<SqlJsStatic> {
  if (!loading) {
    const pending = initSqlJs(inNode() ? {} : { locateFile: () => wasmUrl });
    loading = pending;
    // A failed load (offline cache, blocked wasm) is not remembered: the next run tries again.
    pending.catch(() => {
      if (loading === pending) loading = null;
    });
  }
  return loading;
}

/**
 * Open a copy of the database. A WAL-mode file is opened as a rollback-mode copy (header bytes 18
 * and 19 set to 1 in the copy): there is no -wal file next to an in-memory database, and the
 * engine would otherwise try to create one. The pages are the ones in `bytes`.
 */
export async function openDatabase(bytes: Uint8Array): Promise<Database> {
  const SQL = await loadSql();
  const copy = bytes.slice();
  if (copy.length >= 20 && (copy[18] === 2 || copy[19] === 2)) {
    copy[18] = 1;
    copy[19] = 1;
  }
  const db = new SQL.Database(copy);
  try {
    // Reads the schema: fails here, with SQLite's own message, when this is not a database.
    db.exec('SELECT count(*) FROM sqlite_schema');
    // Belt and braces next to the statement filter: the engine itself refuses every write.
    db.exec('PRAGMA query_only = ON');
  } catch (e) {
    db.close();
    throw e;
  }
  return db;
}

export interface QueryPage {
  columns: string[];
  rows: SqlValue[][];
  /** True when more rows exist after this page. */
  more: boolean;
}

/**
 * Run one statement and return rows `[skip, skip + take)`. The statement is stepped, not
 * collected, so a huge result never sits in memory.
 */
export function queryPage(
  db: Database,
  sql: string,
  skip: number,
  take: number,
  params?: SqlValue[],
): QueryPage {
  const stmt = db.prepare(sql);
  try {
    if (params) stmt.bind(params);
    const columns = stmt.getColumnNames();
    const rows: SqlValue[][] = [];
    let seen = 0;
    let more = false;
    while (stmt.step()) {
      if (seen++ < skip) continue;
      if (rows.length >= take) {
        more = true;
        break;
      }
      rows.push(stmt.get());
    }
    return { columns, rows, more };
  } finally {
    stmt.free();
  }
}

/** First column of the first row, or null. */
export function scalar(db: Database, sql: string): SqlValue {
  const r = db.exec(sql);
  return r[0]?.values[0]?.[0] ?? null;
}

/** "table" with its quotes doubled, to put a name into a statement safely. */
export const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;
