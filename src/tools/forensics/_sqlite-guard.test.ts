import { describe, expect, it } from 'vitest';
import { loadSql, openDatabase } from './_sqlite-engine';
import { ALLOWED_PRAGMAS, checkReadOnly, tokenize, type GuardReason } from './_sqlite-guard';

const reason = (sql: string): GuardReason | 'ok' => {
  const v = checkReadOnly(sql);
  return v.ok ? 'ok' : v.reason;
};

describe('SQL box: what is accepted', () => {
  it.each([
    'SELECT * FROM notes',
    '  select 1;',
    'SELECT 1;;',
    'SELECT \'a;b\', "semi;colon" FROM t',
    'SELECT replace(body, "a", "b") FROM notes',
    'SELECT "update", [delete], `insert` FROM t',
    '-- a comment\nSELECT 1 /* inline */ + 1',
    'WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 5) SELECT n FROM c',
    'WITH a AS (SELECT 1), b AS (SELECT 2) SELECT * FROM a, b',
    'VALUES (1), (2)',
    'EXPLAIN SELECT * FROM notes',
    'EXPLAIN QUERY PLAN SELECT * FROM notes WHERE id = 1',
    'PRAGMA page_size',
    'PRAGMA main.page_count',
    'PRAGMA table_info(notes)',
    'PRAGMA table_info("notes")',
    "PRAGMA index_list('notes')",
    'PRAGMA integrity_check',
    'PRAGMA integrity_check(10)',
    'PRAGMA journal_mode',
    'PRAGMA user_version',
    'SELECT * FROM pragma_table_info("notes")',
    "SELECT x'414243'",
  ])('%s', (sql) => {
    expect(reason(sql)).toBe('ok');
  });
});

describe('SQL box: what is refused, and why', () => {
  it.each([
    ['INSERT INTO t VALUES (1)', 'write'],
    ['UPDATE t SET a = 1', 'write'],
    ['DELETE FROM t', 'write'],
    ['REPLACE INTO t VALUES (1)', 'write'],
    ['dElEtE from t', 'write'],
    ['/* hidden */ DELETE FROM t', 'write'],
    ['-- c\nINSERT INTO t VALUES (1)', 'write'],
    ['WITH x AS (SELECT 1) DELETE FROM t', 'write'],
    ['WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x', 'write'],
    ['WITH x AS (SELECT 1) UPDATE t SET a = 1', 'write'],
    ['EXPLAIN DELETE FROM t', 'write'],
    ['CREATE TABLE t (a)', 'schema'],
    ['DROP TABLE t', 'schema'],
    ['ALTER TABLE t ADD COLUMN b', 'schema'],
    ["ATTACH DATABASE 'other.db' AS o", 'attach'],
    ['DETACH o', 'attach'],
    ['SELECT * FROM o.t, (ATTACH x)', 'attach'],
    ["SELECT load_extension('evil.so')", 'extension'],
    ["SELECT readfile('/etc/passwd')", 'extension'],
    ["SELECT writefile('x', 'y')", 'extension'],
    ["SELECT fts3_tokenizer('simple')", 'extension'],
    ['BEGIN', 'transaction'],
    ['COMMIT', 'transaction'],
    ['ROLLBACK', 'transaction'],
    ['SAVEPOINT a', 'transaction'],
    ['VACUUM', 'maintenance'],
    ["VACUUM INTO 'copy.db'", 'maintenance'],
    ['REINDEX', 'maintenance'],
    ['ANALYZE', 'maintenance'],
    ['PRAGMA user_version = 5', 'pragma-write'],
    ['PRAGMA user_version=5', 'pragma-write'],
    ['PRAGMA user_version(5)', 'pragma-write'],
    ['PRAGMA writable_schema = 1', 'pragma-unknown'],
    ['PRAGMA wal_checkpoint', 'pragma-unknown'],
    ['PRAGMA optimize', 'pragma-unknown'],
    ['PRAGMA incremental_vacuum', 'pragma-unknown'],
    ['PRAGMA table_info', 'pragma-unknown'],
    ['SELECT 1; SELECT 2', 'multiple'],
    ['SELECT 1; DROP TABLE t', 'multiple'],
    ["SELECT 'x'; -- ok\nDELETE FROM t", 'multiple'],
    ['', 'empty'],
    ['  -- only a comment', 'empty'],
    [';', 'empty'],
    ["SELECT 'never closed", 'unterminated'],
    ['SELECT "never closed', 'unterminated'],
    ['MAKE IT SO', 'unknown'],
    ['WITH x AS (SELECT 1)', 'unknown'],
  ] as [string, GuardReason][])('%s -> %s', (sql, why) => {
    expect(reason(sql)).toBe(why);
  });

  it('names the keyword that was refused', () => {
    expect(checkReadOnly('DELETE FROM t')).toEqual({
      ok: false,
      reason: 'write',
      keyword: 'DELETE',
    });
    expect(checkReadOnly("ATTACH 'x' AS y")).toEqual({
      ok: false,
      reason: 'attach',
      keyword: 'ATTACH',
    });
    expect(checkReadOnly('PRAGMA user_version = 1')).toEqual({
      ok: false,
      reason: 'pragma-write',
      keyword: 'user_version',
    });
  });

  it('lists the read-only pragmas it allows', () => {
    expect(ALLOWED_PRAGMAS).toContain('table_info');
    expect(ALLOWED_PRAGMAS).not.toContain('writable_schema');
    expect(ALLOWED_PRAGMAS).not.toContain('wal_checkpoint');
  });
});

describe('SQL box: the tokenizer', () => {
  it('drops comments and keeps quoted text in one piece', () => {
    expect(tokenize("select /* x ; */ 'a;b' -- y ;\n, 2")!.map((t) => t.text)).toEqual([
      'SELECT',
      "'a;b'",
      ',',
      '2',
    ]);
  });
  it('doubled quotes stay inside the string', () => {
    expect(tokenize("select 'it''s ; fine'")!.map((t) => t.kind)).toEqual(['word', 'string']);
  });
});

describe('the engine is read-only on its own', () => {
  it('refuses a write even when the filter is bypassed', async () => {
    const SQL = await loadSql();
    const src = new SQL.Database();
    src.run('CREATE TABLE t (a)');
    src.run('INSERT INTO t VALUES (1)');
    const db = await openDatabase(src.export());
    expect(() => db.exec('INSERT INTO t VALUES (2)')).toThrow(/readonly/i);
    expect(() => db.exec('DELETE FROM t')).toThrow(/readonly/i);
    expect(() => db.exec('DROP TABLE t')).toThrow(/readonly/i);
    expect(db.exec('SELECT count(*) FROM t')[0]!.values).toEqual([[1]]);
    db.close();
  });
});
