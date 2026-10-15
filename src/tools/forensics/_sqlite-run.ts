/**
 * The SQLite tool, loaded on demand (it pulls in the SQL engine). `run` reads the file, works out
 * what it is (a database, a write-ahead log, a rollback journal) and builds the view asked for.
 */
import { buildFlagRegex } from '../../core/flags';
import { ToolError } from '../../core/errors';
import type { FileInput, LazyFile, Output, ToolResult } from '../../core/types';
import { formatSize } from '../../lib/bytes';
import { toolT } from '../../i18n/tool-text';
import {
  browseView,
  clampPaging,
  requireDb,
  sqlView,
  tablesAndViews,
  type Paging,
} from './_sqlite-browse';
import { createContext, type Context } from './_sqlite-ctx';
import { quoteIdent, scalar } from './_sqlite-engine';
import {
  deletedView,
  headerEntries,
  headerNotes,
  isRollbackJournal,
  journalView,
  walOnlyView,
  walView,
} from './_sqlite-forensics';
import { hasSqliteMagic } from './_sqlite-format';
import {
  chromeDownloads,
  chromeSearchTerms,
  detectBrowser,
  visitsPage,
  type Browser,
} from './_sqlite-history';
import { searchFlags } from './_sqlite-search';
import { looksLikeWal, parseWal } from './_sqlite-wal';

const T = toolT('sqlite');

/** Largest file read into memory: the page keeps the bytes, a copy and the engine's own copy. */
export const MAX_BYTES = 128 * 1024 * 1024;
/** Above this size the overview leaves the free-space scan to its own view. */
const OVERVIEW_CARVE_BYTES = 8 * 1024 * 1024;

export interface SqliteOptions {
  mode: string;
  table: string;
  page: number;
  rows: number;
  sql: string;
  flagPattern: string;
  wal: FileInput | null;
  applyWal: boolean;
}

function notDatabase(bytes: Uint8Array): ToolError {
  // A file of random-looking bytes, in whole pages, is how an encrypted database looks.
  const sample = bytes.subarray(0, Math.min(bytes.length, 4096));
  const counts = new Uint32Array(256);
  for (const b of sample) counts[b]!++;
  let entropy = 0;
  for (const c of counts) if (c) entropy -= (c / sample.length) * Math.log2(c / sample.length);
  const whole = bytes.length >= 1024 && bytes.length % 1024 === 0;
  return new ToolError(T(entropy > 7.5 && whole ? 'error.encrypted' : 'error.notDatabase'));
}

export async function runSqlite(input: LazyFile, opts: SqliteOptions): Promise<ToolResult> {
  if (input.size === 0) throw new ToolError(T('error.empty'));
  if (input.size > MAX_BYTES) {
    throw new ToolError(
      T('error.tooLarge', { size: formatSize(input.size), max: formatSize(MAX_BYTES) }),
    );
  }
  const bytes = await input.read(0, input.size);

  if (looksLikeWal(bytes)) {
    const info = parseWal(bytes)!;
    return [{ type: 'note', level: 'info', text: T('note.isWal') }, ...walOnlyView(bytes, info)];
  }
  if (isRollbackJournal(bytes)) return journalView(bytes);
  if (!hasSqliteMagic(bytes)) throw notDatabase(bytes);

  const ctx = createContext(bytes, input.name, opts.wal, opts.applyWal);
  try {
    const paging = clampPaging(opts.page, opts.rows);
    switch (opts.mode) {
      case 'browse':
        return await browseView(ctx, opts.table, paging);
      case 'sql':
        return await sqlView(ctx, opts.sql, paging);
      case 'deleted':
        return [...headerNotes(ctx), ...(await deletedView(ctx))];
      case 'wal':
        return await walView(ctx);
      case 'history':
        return await historyView(ctx, paging);
      case 'flags':
        return await flagsView(ctx, opts.flagPattern);
      default:
        return await overview(ctx, opts);
    }
  } finally {
    ctx.close();
  }
}

// ---------- overview ----------

interface ObjectRow {
  type: string;
  name: string;
  table: string;
  root: number;
  sql: string | null;
}

async function overview(ctx: Context, opts: SqliteOptions): Promise<Output[]> {
  const out: Output[] = [];
  const db = await ctx.db();
  out.push(...headerNotes(ctx));
  if (ctx.wal) out.push(...(await walNotes(ctx)));
  if (!db) {
    out.push({
      type: 'note',
      level: 'error',
      text: T('note.engineFailed', { message: ctx.dbError ?? '' }),
    });
  }
  out.push({ type: 'kv', label: T('label.header'), entries: headerEntries(ctx) });

  // The objects: SQLite's own list when it opened the file, the pages' own when it did not.
  let objects: ObjectRow[];
  if (db) {
    objects = (
      db.exec('SELECT type, name, tbl_name, rootpage, sql FROM sqlite_schema ORDER BY rowid')[0]
        ?.values ?? []
    ).map((r) => ({
      type: String(r[0]),
      name: String(r[1]),
      table: String(r[2]),
      root: Number(r[3] ?? 0),
      sql: r[4] === null ? null : String(r[4]),
    }));
  } else {
    objects = ctx.schema.map((e) => ({
      type: e.type,
      name: e.name,
      table: e.table,
      root: e.rootPage,
      sql: e.sql,
    }));
  }
  const counts = new Map<string, number | string>();
  if (db) {
    for (const o of objects) {
      if (o.type !== 'table') continue;
      try {
        counts.set(o.name, Number(scalar(db, `SELECT count(*) FROM ${quoteIdent(o.name)}`)));
      } catch {
        counts.set(o.name, '?');
      }
    }
  }
  out.push({
    type: 'table',
    label: T('label.objects'),
    columns: [T('col.type'), T('col.name'), T('col.table'), T('col.rows'), T('col.rootPage')],
    rows: objects.map((o) => [o.type, o.name, o.table, counts.get(o.name) ?? '-', o.root || '-']),
  });
  const statements = objects.filter((o) => o.sql).map((o) => `${o.sql};`);
  if (statements.length) {
    out.push({ type: 'text', label: T('label.create'), value: statements.join('\n\n') });
  }
  if (ctx.schemaProblems.length) {
    out.push({
      type: 'note',
      level: 'warn',
      text: T('note.schemaProblems', { problems: ctx.schemaProblems.length }),
    });
  }

  // What the file looks like it is.
  if (db) {
    const browser = detectBrowser(db);
    if (browser) {
      out.push({
        type: 'note',
        level: 'info',
        text: T(browser === 'chrome' ? 'note.chromeHistory' : 'note.firefoxHistory'),
      });
      out.push({
        type: 'actions',
        actions: [{ label: T('action.history'), options: { mode: 'history', page: 1 } }],
      });
    }
  }

  // Deleted records and flags: both are cheap on a small file, left to their own view on a big one.
  const small = ctx.file.bytes.length <= OVERVIEW_CARVE_BYTES;
  if (small) {
    const carved = ctx.carve();
    const real = carved.records.filter((r) => !r.liveCopy).length;
    if (real > 0 || carved.residual.length > 0) {
      out.push({
        type: 'note',
        level: 'warn',
        text: T('note.deletedFound', { records: real, text: carved.residual.length }),
      });
    }
  } else {
    out.push({ type: 'note', level: 'info', text: T('note.carveSkipped') });
  }
  const re = buildFlagRegex(opts.flagPattern);
  const found = await searchFlags(ctx, re, { cells: 200_000, chars: 16_000_000 }, 12, small);
  out.push(...readErrorNotes(found.errors));
  if (found.hits.length) {
    out.push({
      type: 'table',
      label: T('label.flagsFound'),
      columns: [T('col.where'), T('col.flag')],
      rows: found.hits.map((h) => [h.where, h.flag]),
      highlight: found.hits.map((_, i) => i),
    });
  }

  // Where to go next.
  const actions: { label: string; options: Record<string, unknown>; primary?: boolean }[] = [];
  if (db) {
    for (const o of tablesAndViews(db).slice(0, 12)) {
      actions.push({
        label: T('action.browse', { name: o.name }),
        options: { mode: 'browse', table: o.name, page: 1 },
      });
    }
    actions.push({ label: T('action.sql'), options: { mode: 'sql' } });
  }
  actions.push({ label: T('action.deleted'), options: { mode: 'deleted' } });
  actions.push({ label: T('action.flags'), options: { mode: 'flags' } });
  out.push({ type: 'actions', label: T('label.next'), actions });
  return out;
}

/** Tables SQLite could not read to the end: a damaged page is a finding, not a reason to stop. */
function readErrorNotes(errors: { table: string; message: string }[]): Output[] {
  return errors.slice(0, 5).map((e) => ({
    type: 'note' as const,
    level: 'warn' as const,
    text: T('note.readError', e),
  }));
}

async function walNotes(ctx: Context): Promise<Output[]> {
  const w = ctx.wal!;
  if (w.mismatch) {
    return [
      {
        type: 'note',
        level: 'error',
        text: T('note.walMismatch', { wal: w.info.header.pageSize, db: ctx.file.pageSize }),
      },
    ];
  }
  if (w.applied) {
    return [
      {
        type: 'note',
        level: 'success',
        text: T('note.walAppliedShort', {
          frames: w.info.committedFrames,
          pages: w.applied.changed.length,
        }),
      },
    ];
  }
  return [{ type: 'note', level: 'info', text: T('note.walNotApplied') }];
}

// ---------- history ----------

async function historyView(ctx: Context, paging: Paging): Promise<Output[]> {
  const db = await requireDb(ctx);
  const browser: Browser | null = detectBrowser(db);
  if (!browser) return [{ type: 'note', level: 'info', text: T('note.noHistory') }];
  const skip = (paging.page - 1) * paging.rows;
  let page;
  try {
    page = visitsPage(db, browser, skip, paging.rows);
  } catch (e) {
    throw new ToolError(T('error.read', { message: e instanceof Error ? e.message : String(e) }));
  }
  const out: Output[] = [
    {
      type: 'kv',
      label: T('label.historySummary'),
      entries: [
        [T('kv.browser'), browser === 'chrome' ? 'Chrome' : 'Firefox'],
        [T('kv.timeFormat'), T(browser === 'chrome' ? 'value.webkit' : 'value.prtime')],
        [T('kv.visits'), String(page.total)],
        [T('kv.firstVisit'), page.first ?? '-'],
        [T('kv.lastVisit'), page.last ?? '-'],
      ],
    },
  ];
  if (page.summaryOnly) out.push({ type: 'note', level: 'info', text: T('note.noVisitTable') });
  out.push({
    type: 'table',
    label: `${T('label.visits')} · ${skip + 1}–${skip + page.visits.length}`,
    columns: [T('col.timeUtc'), T('col.url'), T('col.title'), T('col.kind')],
    rows: page.visits.map((v) => [
      v.time ?? `${T('value.noTime')} (${v.raw})`,
      v.url,
      v.title,
      v.kind,
    ]),
  });
  if (page.more || paging.page > 1) {
    const actions: { label: string; options: Record<string, unknown>; primary?: boolean }[] = [];
    if (paging.page > 1)
      actions.push({ label: T('action.prev'), options: { page: paging.page - 1 } });
    if (page.more)
      actions.push({ label: T('action.next'), options: { page: paging.page + 1 }, primary: true });
    out.push({ type: 'actions', actions });
  }
  if (browser === 'chrome' && paging.page === 1) {
    const downloads = chromeDownloads(db, 100);
    if (downloads.length) {
      out.push({
        type: 'table',
        label: T('label.downloads'),
        columns: [T('col.timeUtc'), T('col.path'), T('col.bytes'), T('col.source')],
        rows: downloads.map((d) => [d.start ?? '-', d.path, d.bytes ?? '', d.source]),
      });
    }
    const terms = chromeSearchTerms(db, 100);
    if (terms.length) {
      out.push({
        type: 'table',
        label: T('label.searchTerms'),
        columns: [T('col.term')],
        rows: terms.map((t) => [t]),
      });
    }
  }
  return out;
}

// ---------- flags ----------

async function flagsView(ctx: Context, pattern: string): Promise<Output[]> {
  const re = buildFlagRegex(pattern);
  const found = await searchFlags(ctx, re, { cells: 2_000_000, chars: 256_000_000 }, 500, true);
  const out: Output[] = [
    {
      type: 'note',
      level: 'info',
      text: T('note.flagSearch', { cells: found.scannedCells }),
    },
  ];
  if (found.truncated) out.push({ type: 'note', level: 'warn', text: T('note.searchTruncated') });
  out.push(...readErrorNotes(found.errors));
  if (found.hits.length) {
    out.push({
      type: 'table',
      label: T('label.flagsFound'),
      columns: [T('col.where'), T('col.flag')],
      rows: found.hits.map((h) => [h.where, h.flag]),
      highlight: found.hits.map((_, i) => i),
    });
  } else {
    out.push({ type: 'note', level: 'info', text: T('note.noFlags') });
  }
  return out;
}
