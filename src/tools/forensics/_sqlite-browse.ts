/**
 * The table viewer and the read-only SQL box. Both show a bounded page of rows, BLOB cells as a
 * size, a hex preview and a file type, and offer the BLOBs for download.
 */
import { ToolError } from '../../core/errors';
import type { Output } from '../../core/types';
import { toolT } from '../../i18n/tool-text';
import { blobOutputs, formatValue, isImprecise } from './_sqlite-cells';
import type { Context } from './_sqlite-ctx';
import { queryPage, quoteIdent, scalar, type Database } from './_sqlite-engine';
import { checkReadOnly, type GuardReason } from './_sqlite-guard';

const T = toolT('sqlite');

export interface Paging {
  page: number;
  rows: number;
}

export const clampPaging = (page: number, rows: number): Paging => ({
  page: Math.max(1, Math.trunc(Number.isFinite(page) ? page : 1)),
  rows: Math.min(500, Math.max(1, Math.trunc(Number.isFinite(rows) ? rows : 50))),
});

export async function requireDb(ctx: Context): Promise<Database> {
  const db = await ctx.db();
  if (!db) throw new ToolError(T('error.engine', { message: ctx.dbError ?? '' }));
  return db;
}

interface SchemaObject {
  type: string;
  name: string;
}

export function tablesAndViews(db: Database): SchemaObject[] {
  const rows =
    db.exec(
      "SELECT type, name FROM sqlite_schema WHERE type IN ('table', 'view') ORDER BY name LIKE 'sqlite\\_%' ESCAPE '\\', name",
    )[0]?.values ?? [];
  return rows.map((r) => ({ type: String(r[0]), name: String(r[1]) }));
}

/** Buttons that previous / next / first / last page re-run with. */
function pageActions(
  page: number,
  pages: number | null,
  more: boolean,
  extra: Record<string, unknown> = {},
): Output | null {
  const actions: { label: string; options: Record<string, unknown>; primary?: boolean }[] = [];
  if (page > 1) {
    actions.push({ label: T('action.first'), options: { ...extra, page: 1 } });
    actions.push({ label: T('action.prev'), options: { ...extra, page: page - 1 } });
  }
  if (more)
    actions.push({ label: T('action.next'), options: { ...extra, page: page + 1 }, primary: true });
  if (pages !== null && page < pages)
    actions.push({ label: T('action.last'), options: { ...extra, page: pages } });
  return actions.length ? { type: 'actions', actions } : null;
}

export async function browseView(
  ctx: Context,
  requested: string,
  paging: Paging,
): Promise<Output[]> {
  const db = await requireDb(ctx);
  const objects = tablesAndViews(db);
  const wanted = requested.trim();
  const found =
    objects.find((o) => o.name === wanted) ??
    objects.find((o) => o.name.toLowerCase() === wanted.toLowerCase());
  if (!wanted || !found) {
    const out: Output[] = [];
    if (wanted) {
      out.push({ type: 'note', level: 'warn', text: T('error.noTable', { name: wanted }) });
    } else {
      out.push({ type: 'note', level: 'info', text: T('note.pickTable') });
    }
    out.push({
      type: 'actions',
      label: T('label.tables'),
      actions: objects.slice(0, 60).map((o) => ({
        label: o.name,
        options: { mode: 'browse', table: o.name, page: 1 },
      })),
    });
    return out;
  }

  const q = quoteIdent(found.name);
  const out: Output[] = [];
  const info = db.exec(`PRAGMA table_xinfo(${q})`)[0]?.values ?? [];
  let total: number | null;
  try {
    total = Number(scalar(db, `SELECT count(*) FROM ${q}`));
  } catch {
    // A view over something SQLite cannot count: the rows are still shown, without a total.
    total = null;
  }
  const { rows: take } = paging;
  const pages = total === null ? null : Math.max(1, Math.ceil(total / take));
  const page = pages === null ? paging.page : Math.min(paging.page, pages);
  const skip = (page - 1) * take;
  if (page !== paging.page) {
    out.push({
      type: 'note',
      level: 'info',
      text: T('note.pageClamped', { page, pages: pages ?? page }),
    });
  }
  out.push({
    type: 'table',
    label: T('label.columns', { name: found.name }),
    columns: [
      T('col.column'),
      T('col.type'),
      T('col.notNull'),
      T('col.default'),
      T('col.primaryKey'),
    ],
    rows: info.map((r) => [
      String(r[1]),
      String(r[2] ?? ''),
      r[3] ? T('value.yes') : '',
      r[4] === null ? '' : String(r[4]),
      r[5] ? String(r[5]) : '',
    ]),
  });
  let data;
  try {
    data = queryPage(db, `SELECT * FROM ${q}`, skip, take);
  } catch (e) {
    throw new ToolError(T('error.read', { message: e instanceof Error ? e.message : String(e) }));
  }
  out.push(...resultBlocks(found.name, data.columns, data.rows, skip, total, T('label.rows')));
  const nav = pageActions(page, pages, data.more, {});
  if (nav) out.push(nav);
  return out;
}

/** The table of rows, the BLOBs in them, and a note about integers the engine cannot hold exactly. */
function resultBlocks(
  source: string,
  columns: string[],
  rows: Parameters<typeof formatValue>[0][][],
  skip: number,
  total: number | null,
  label: string,
): Output[] {
  const out: Output[] = [];
  const first = skip + 1;
  const last = skip + rows.length;
  const range = rows.length
    ? total === null
      ? `${first}–${last}`
      : T('label.range', { from: first, to: last, total })
    : T('label.noRows');
  out.push({
    type: 'table',
    label: `${label} · ${range}`,
    columns,
    rows: rows.map((r) => r.map(formatValue)),
  });
  if (rows.some((r) => r.some(isImprecise))) {
    out.push({ type: 'note', level: 'warn', text: T('note.bigInts') });
  }
  out.push(...blobOutputs(source, columns, rows, first));
  return out;
}

const GUARD_KEY: Record<GuardReason, string> = {
  empty: 'empty',
  unterminated: 'unterminated',
  multiple: 'multiple',
  write: 'write',
  schema: 'schema',
  attach: 'attach',
  extension: 'extension',
  transaction: 'transaction',
  maintenance: 'maintenance',
  'pragma-write': 'pragmaWrite',
  'pragma-unknown': 'pragmaUnknown',
  unknown: 'unknown',
};

const STARTERS: { key: string; sql: string }[] = [
  { key: 'tables', sql: 'SELECT type, name, tbl_name, sql FROM sqlite_schema' },
  { key: 'pragmaPages', sql: 'PRAGMA page_count' },
  { key: 'integrity', sql: 'PRAGMA integrity_check' },
];

export async function sqlView(ctx: Context, sql: string, paging: Paging): Promise<Output[]> {
  const db = await requireDb(ctx);
  if (!sql.trim()) {
    return [
      { type: 'note', level: 'info', text: T('note.sqlHelp') },
      {
        type: 'actions',
        label: T('label.sqlExamples'),
        actions: [
          ...STARTERS.map((s) => ({
            label: T(`action.sql.${s.key}`),
            options: { mode: 'sql', sql: s.sql, page: 1 },
          })),
          ...tablesAndViews(db)
            .slice(0, 8)
            .map((o) => ({
              label: o.name,
              options: {
                mode: 'sql',
                sql: `SELECT * FROM ${quoteIdent(o.name)} LIMIT 20`,
                page: 1,
              },
            })),
        ],
      },
    ];
  }
  const verdict = checkReadOnly(sql);
  if (!verdict.ok) {
    throw new ToolError(T(`guard.${GUARD_KEY[verdict.reason]}`, { keyword: verdict.keyword }));
  }
  const { rows: take } = paging;
  const skip = (paging.page - 1) * take;
  let data;
  try {
    data = queryPage(db, sql, skip, take);
  } catch (e) {
    throw new ToolError(T('error.sql', { message: e instanceof Error ? e.message : String(e) }));
  }
  if (data.columns.length === 0) {
    return [{ type: 'note', level: 'info', text: T('note.sqlNoResult') }];
  }
  const out = resultBlocks('query', data.columns, data.rows, skip, null, T('label.result'));
  if (!data.rows.length && paging.page > 1) {
    // The page option is shared with the other views: it may be left over from a table you browsed.
    out.push({ type: 'note', level: 'info', text: T('note.pastEnd', { page: paging.page }) });
    out.push({
      type: 'actions',
      actions: [{ label: T('action.first'), options: { page: 1 }, primary: true }],
    });
  } else {
    const nav = pageActions(paging.page, null, data.more, {});
    if (nav) out.push(nav);
  }
  return out;
}
