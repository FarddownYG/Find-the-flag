/**
 * The SQL box is read-only. The database is an in-memory copy and the engine is also put in
 * query_only mode, but the box still refuses everything that is not a plain read, and says why:
 * a statement that changes the copy would make the evidence in front of the user lie, and
 * ATTACH, extension loading and file functions have no place in a tool that must never touch
 * anything but the bytes it was given.
 */

export type GuardReason =
  | 'empty'
  | 'unterminated'
  | 'multiple'
  | 'write'
  | 'schema'
  | 'attach'
  | 'extension'
  | 'transaction'
  | 'maintenance'
  | 'pragma-write'
  | 'pragma-unknown'
  | 'unknown';

export type Verdict = { ok: true } | { ok: false; reason: GuardReason; keyword: string };

type TokenKind = 'word' | 'quoted' | 'string' | 'number' | 'var' | 'punct';
interface Token {
  kind: TokenKind;
  /** Upper-cased for words, as written otherwise. */
  text: string;
}

/** Split SQL into tokens; comments vanish. Null when a string or quoted name never ends. */
export function tokenize(sql: string): Token[] | null {
  const out: Token[] = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i]!;
    if (/\s/.test(c)) {
      i++;
    } else if (c === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') i++;
    } else if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
    } else if (c === "'" || c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c;
      let j = i + 1;
      for (;;) {
        if (j >= n) return null;
        if (sql[j] === close) {
          // A doubled quote is a quote inside the string (not for [ ]).
          if (close !== ']' && sql[j + 1] === close) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      out.push({ kind: c === "'" ? 'string' : 'quoted', text: sql.slice(i, j + 1) });
      i = j + 1;
    } else if (/[A-Za-z_\u0080-￿]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$\u0080-￿]/.test(sql[j]!)) j++;
      const word = sql.slice(i, j);
      // x'ABCD' is a blob literal, not the word x followed by a string.
      if ((word === 'x' || word === 'X') && sql[j] === "'") {
        const end = sql.indexOf("'", j + 1);
        if (end < 0) return null;
        out.push({ kind: 'string', text: sql.slice(i, end + 1) });
        i = end + 1;
      } else {
        out.push({ kind: 'word', text: word.toUpperCase() });
        i = j;
      }
    } else if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(sql[i + 1] ?? ''))) {
      let j = i + 1;
      while (j < n && /[0-9A-Za-z_.]/.test(sql[j]!)) j++;
      out.push({ kind: 'number', text: sql.slice(i, j) });
      i = j;
    } else if (c === '?' || c === ':' || c === '@' || c === '$') {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(sql[j]!)) j++;
      out.push({ kind: j > i + 1 || c === '?' ? 'var' : 'punct', text: sql.slice(i, j) });
      i = j;
    } else {
      out.push({ kind: 'punct', text: c });
      i++;
    }
  }
  return out;
}

const WRITE = new Set(['INSERT', 'UPDATE', 'DELETE', 'REPLACE']);
const SCHEMA = new Set(['CREATE', 'DROP', 'ALTER']);
const TRANSACTION = new Set(['BEGIN', 'COMMIT', 'END', 'ROLLBACK', 'SAVEPOINT', 'RELEASE']);
const MAINTENANCE = new Set(['VACUUM', 'REINDEX', 'ANALYZE']);
const FILE_FUNCTIONS = new Set([
  'LOAD_EXTENSION',
  'READFILE',
  'WRITEFILE',
  'EDIT',
  'FTS3_TOKENIZER',
]);

/**
 * Pragmas that only report. `none` takes no argument at all (PRAGMA user_version(5) would set
 * it), `name` needs a table or index name, `optional` takes one if you want.
 */
const PRAGMAS: Record<string, 'none' | 'name' | 'optional'> = {
  application_id: 'none',
  auto_vacuum: 'none',
  cache_size: 'none',
  collation_list: 'none',
  compile_options: 'none',
  data_version: 'none',
  database_list: 'none',
  encoding: 'none',
  foreign_keys: 'none',
  freelist_count: 'none',
  function_list: 'none',
  journal_mode: 'none',
  locking_mode: 'none',
  max_page_count: 'none',
  module_list: 'none',
  page_count: 'none',
  page_size: 'none',
  pragma_list: 'none',
  query_only: 'none',
  schema_version: 'none',
  secure_delete: 'none',
  synchronous: 'none',
  temp_store: 'none',
  user_version: 'none',
  wal_autocheckpoint: 'none',
  table_info: 'name',
  table_xinfo: 'name',
  index_list: 'name',
  index_info: 'name',
  index_xinfo: 'name',
  foreign_key_list: 'name',
  table_list: 'optional',
  foreign_key_check: 'optional',
  integrity_check: 'optional',
  quick_check: 'optional',
};

export const ALLOWED_PRAGMAS = Object.keys(PRAGMAS).sort();

const refuse = (reason: GuardReason, keyword: string): Verdict => ({ ok: false, reason, keyword });

function checkPragma(t: Token[], from: number): Verdict {
  let i = from;
  // main.table_info, temp.table_info
  if (t[i + 1]?.text === '.' && t[i + 2]) i += 2;
  const name = t[i];
  if (!name || (name.kind !== 'word' && name.kind !== 'quoted'))
    return refuse('pragma-unknown', '');
  const key = name.text.replace(/^["`[]|["`\]]$/g, '').toLowerCase();
  const rule = PRAGMAS[key];
  if (!rule) return refuse('pragma-unknown', key);
  const rest = t.slice(i + 1);
  if (rest.some((x) => x.text === '=')) return refuse('pragma-write', key);
  if (rest.length === 0) return rule === 'name' ? refuse('pragma-unknown', key) : { ok: true };
  // One argument in parentheses.
  if (
    rest.length === 3 &&
    rest[0]!.text === '(' &&
    rest[2]!.text === ')' &&
    rest[1]!.kind !== 'punct'
  ) {
    return rule === 'none' ? refuse('pragma-write', key) : { ok: true };
  }
  return refuse('pragma-unknown', key);
}

/** Decide whether `sql` may run. Everything outside SELECT, WITH, VALUES, EXPLAIN and the read-only PRAGMAs is refused. */
export function checkReadOnly(sql: string): Verdict {
  const all = tokenize(sql);
  if (!all) return refuse('unterminated', '');
  const t = [...all];
  while (t.length && t[t.length - 1]!.text === ';' && t[t.length - 1]!.kind === 'punct') t.pop();
  if (t.length === 0) return refuse('empty', '');
  if (t.some((x) => x.kind === 'punct' && x.text === ';')) return refuse('multiple', ';');

  const head = t[0]!;
  const word = head.kind === 'word' ? head.text : '';
  if (WRITE.has(word)) return refuse('write', word);
  if (SCHEMA.has(word)) return refuse('schema', word);
  if (TRANSACTION.has(word)) return refuse('transaction', word);
  if (MAINTENANCE.has(word)) return refuse('maintenance', word);
  if (word === 'ATTACH' || word === 'DETACH') return refuse('attach', word);

  for (const [i, x] of t.entries()) {
    if (x.kind !== 'word') continue;
    if (x.text === 'ATTACH' || x.text === 'DETACH') return refuse('attach', x.text);
    if (FILE_FUNCTIONS.has(x.text) && t[i + 1]?.text === '(') {
      return refuse('extension', x.text.toLowerCase());
    }
  }

  if (word === 'PRAGMA') return checkPragma(t, 1);
  if (word === 'EXPLAIN') {
    // EXPLAIN [QUERY PLAN] <statement>: the statement itself has to be a read.
    const skip = t[1]?.text === 'QUERY' && t[2]?.text === 'PLAN' ? 3 : 1;
    const rest = t.slice(skip);
    return rest.length ? checkTokens(rest) : refuse('empty', '');
  }
  return checkTokens(t);
}

function checkTokens(t: Token[]): Verdict {
  const first = t[0]!;
  const word = first.kind === 'word' ? first.text : '';
  if (WRITE.has(word)) return refuse('write', word);
  if (SCHEMA.has(word)) return refuse('schema', word);
  if (word === 'PRAGMA') return checkPragma(t, 1);
  if (word === 'SELECT' || word === 'VALUES') return { ok: true };
  if (word === 'WITH') {
    // The statement a WITH clause leads into: the first of these keywords outside parentheses.
    let depth = 0;
    for (const x of t) {
      if (x.kind === 'punct' && x.text === '(') depth++;
      else if (x.kind === 'punct' && x.text === ')') depth--;
      else if (depth === 0 && x.kind === 'word') {
        if (WRITE.has(x.text)) return refuse('write', x.text);
        if (x.text === 'SELECT' || x.text === 'VALUES') return { ok: true };
      }
    }
    return refuse('unknown', 'WITH');
  }
  return refuse('unknown', first.text);
}
