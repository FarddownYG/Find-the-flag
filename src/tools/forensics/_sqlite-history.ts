/**
 * Browser history databases. Chrome's `History` (tables urls and visits) and Firefox's
 * `places.sqlite` (moz_places and moz_historyvisits) store their times in microseconds under two
 * different epochs; this shows them as UTC dates next to the page.
 */
import type { Database, SqlValue } from './_sqlite-engine';
import { quoteIdent, queryPage, scalar } from './_sqlite-engine';
import { prtimeToIso, webkitToIso } from './_sqlite-times';

export type Browser = 'chrome' | 'firefox';

function columnsOf(db: Database, table: string): Set<string> | null {
  const r = db.exec(`PRAGMA table_info(${quoteIdent(table)})`);
  const names = r[0]?.values.map((row) => String(row[1]).toLowerCase());
  return names?.length ? new Set(names) : null;
}

const hasAll = (cols: Set<string> | null, names: string[]) =>
  cols !== null && names.every((n) => cols.has(n));

/** Which browser's history this database is, judged by its tables and columns. */
export function detectBrowser(db: Database): Browser | null {
  try {
    if (hasAll(columnsOf(db, 'urls'), ['url', 'title', 'visit_count', 'last_visit_time'])) {
      return 'chrome';
    }
    if (hasAll(columnsOf(db, 'moz_places'), ['url', 'title', 'visit_count', 'last_visit_date'])) {
      return 'firefox';
    }
  } catch {
    return null;
  }
  return null;
}

export interface Visit {
  /** ISO 8601 UTC, null when the stored value is 0 or out of range. */
  time: string | null;
  /** The raw stored value, as text. */
  raw: string;
  url: string;
  title: string;
  kind: string;
  visits: number | null;
}

export interface VisitPage {
  visits: Visit[];
  more: boolean;
  total: number;
  first: string | null;
  last: string | null;
  /** The list comes from the per-page last visit only (there is no visit table). */
  summaryOnly: boolean;
}

const CHROME_TRANSITIONS = [
  'link',
  'typed',
  'auto bookmark',
  'auto subframe',
  'manual subframe',
  'generated',
  'start page',
  'form submit',
  'reload',
  'keyword',
  'keyword generated',
];
const FIREFOX_VISIT_TYPES = [
  '',
  'link',
  'typed',
  'bookmark',
  'embed',
  'redirect (permanent)',
  'redirect (temporary)',
  'download',
  'framed link',
  'reload',
];

const text = (v: SqlValue): string => (v === null ? '' : v instanceof Uint8Array ? '' : String(v));
const num = (v: SqlValue): number | null => (typeof v === 'number' ? v : null);

/** One page of visits, newest first. */
export function visitsPage(db: Database, browser: Browser, skip: number, take: number): VisitPage {
  const chrome = browser === 'chrome';
  const perVisit = chrome
    ? hasAll(columnsOf(db, 'visits'), ['url', 'visit_time', 'transition'])
    : hasAll(columnsOf(db, 'moz_historyvisits'), ['place_id', 'visit_date', 'visit_type']);
  const convert = chrome ? webkitToIso : prtimeToIso;
  let sql: string;
  let totalSql: string;
  let rangeSql: string;
  if (chrome && perVisit) {
    sql = `SELECT CAST(v.visit_time AS TEXT), u.url, u.title, v.transition & 255, u.visit_count
           FROM visits v LEFT JOIN urls u ON u.id = v.url ORDER BY v.visit_time DESC`;
    totalSql = 'SELECT count(*) FROM visits';
    rangeSql =
      'SELECT CAST(min(visit_time) AS TEXT), CAST(max(visit_time) AS TEXT) FROM visits WHERE visit_time > 0';
  } else if (chrome) {
    sql = `SELECT CAST(last_visit_time AS TEXT), url, title, NULL, visit_count
           FROM urls ORDER BY last_visit_time DESC`;
    totalSql = 'SELECT count(*) FROM urls';
    rangeSql =
      'SELECT CAST(min(last_visit_time) AS TEXT), CAST(max(last_visit_time) AS TEXT) FROM urls WHERE last_visit_time > 0';
  } else if (perVisit) {
    sql = `SELECT CAST(h.visit_date AS TEXT), p.url, p.title, h.visit_type, p.visit_count
           FROM moz_historyvisits h LEFT JOIN moz_places p ON p.id = h.place_id ORDER BY h.visit_date DESC`;
    totalSql = 'SELECT count(*) FROM moz_historyvisits';
    rangeSql =
      'SELECT CAST(min(visit_date) AS TEXT), CAST(max(visit_date) AS TEXT) FROM moz_historyvisits WHERE visit_date > 0';
  } else {
    sql = `SELECT CAST(last_visit_date AS TEXT), url, title, NULL, visit_count
           FROM moz_places WHERE last_visit_date IS NOT NULL ORDER BY last_visit_date DESC`;
    totalSql = 'SELECT count(*) FROM moz_places WHERE last_visit_date IS NOT NULL';
    rangeSql =
      'SELECT CAST(min(last_visit_date) AS TEXT), CAST(max(last_visit_date) AS TEXT) FROM moz_places WHERE last_visit_date > 0';
  }
  const page = queryPage(db, sql, skip, take);
  const kinds = chrome ? CHROME_TRANSITIONS : FIREFOX_VISIT_TYPES;
  const visits = page.rows.map((r) => {
    const raw = text(r[0]!);
    const k = num(r[3]!);
    return {
      time: convert(raw),
      raw,
      url: text(r[1]!),
      title: text(r[2]!),
      kind: k === null ? '' : (kinds[k] ?? String(k)),
      visits: num(r[4]!),
    };
  });
  const range = db.exec(rangeSql)[0]?.values[0] ?? [null, null];
  return {
    visits,
    more: page.more,
    total: Number(scalar(db, totalSql) ?? 0),
    first: convert(text(range[0]!) || null),
    last: convert(text(range[1]!) || null),
    summaryOnly: !perVisit,
  };
}

export interface Download {
  path: string;
  start: string | null;
  end: string | null;
  bytes: number | null;
  source: string;
}

/** Chrome's downloads table, newest first (empty when there is none). */
export function chromeDownloads(db: Database, limit: number): Download[] {
  const cols = columnsOf(db, 'downloads');
  if (!cols || !cols.has('start_time')) return [];
  const pick = (...names: string[]) => names.find((n) => cols.has(n)) ?? null;
  const path = pick('target_path', 'current_path');
  const source = pick('tab_url', 'referrer', 'site_url');
  const select = [
    path ?? "''",
    'CAST(start_time AS TEXT)',
    cols.has('end_time') ? 'CAST(end_time AS TEXT)' : 'NULL',
    cols.has('total_bytes')
      ? 'total_bytes'
      : cols.has('received_bytes')
        ? 'received_bytes'
        : 'NULL',
    source ?? "''",
  ].join(', ');
  const page = queryPage(db, `SELECT ${select} FROM downloads ORDER BY start_time DESC`, 0, limit);
  return page.rows.map((r) => ({
    path: text(r[0]!),
    start: webkitToIso(text(r[1]!)),
    end: webkitToIso(text(r[2]!)),
    bytes: num(r[3]!),
    source: text(r[4]!),
  }));
}

/** What was typed in Chrome's search boxes (keyword_search_terms), most used first. */
export function chromeSearchTerms(db: Database, limit: number): string[] {
  const cols = columnsOf(db, 'keyword_search_terms');
  if (!cols || !cols.has('term')) return [];
  return queryPage(
    db,
    `SELECT term FROM keyword_search_terms GROUP BY term ORDER BY count(*) DESC, term`,
    0,
    limit,
  ).rows.map((r) => text(r[0]!));
}
