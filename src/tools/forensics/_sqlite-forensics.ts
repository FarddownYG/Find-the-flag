/**
 * The views that read the file itself rather than the database: the header, the freelist, the
 * records left in free space, and the write-ahead log.
 */
import { formatSize, toHex } from '../../lib/bytes';
import type { Output } from '../../core/types';
import { toolT } from '../../i18n/tool-text';
import type { CarvedRecord, CarveWhere } from './_sqlite-carve';
import type { Context } from './_sqlite-ctx';
import { openDatabase, queryPage, quoteIdent, scalar, type Database } from './_sqlite-engine';
import { formatValue } from './_sqlite-cells';
import {
  PAGE_TABLE_LEAF,
  cellExtent,
  journalFromHeader,
  openFile,
  parseBtreePage,
  parseRecord,
  versionText,
  walkFreelist,
  type CellValue,
  type SqliteFile,
} from './_sqlite-format';
import {
  framePage,
  pageKindOf,
  type WalFrame,
  type WalInfo,
  type WalPageKind,
} from './_sqlite-wal';

const T = toolT('sqlite');

const hex32 = (n: number) => `0x${n.toString(16).padStart(8, '0')}`;

// ---------- header ----------

export function headerEntries(ctx: Context): [string, string][] {
  const f = ctx.file;
  const h = f.header;
  const journal = journalFromHeader(h);
  const free = walkFreelist(f);
  const pagesFromSize = Math.floor(f.bytes.length / f.pageSize);
  const entries: [string, string][] = [
    [T('kv.fileSize'), `${formatSize(f.bytes.length)} (${f.bytes.length} B)`],
    [T('kv.pageSize'), `${f.pageSize} B`],
    [
      T('kv.pages'),
      f.pageCount === pagesFromSize
        ? String(f.pageCount)
        : T('value.pagesDiffer', { header: f.pageCount, size: pagesFromSize }),
    ],
    [T('kv.encoding'), h.encoding.toUpperCase()],
    [T('kv.userVersion'), String(h.userVersion)],
    [T('kv.applicationId'), `${h.applicationId} (${hex32(h.applicationId)})`],
    [T('kv.schemaVersion'), String(h.schemaCookie)],
    [T('kv.schemaFormat'), String(h.schemaFormat)],
    [T('kv.journalMode'), T(`value.journal.${journal}`)],
    [
      T('kv.freelist'),
      h.freelistCount === 0 && free.trunks.length === 0
        ? T('value.none')
        : T('value.freelist', {
            header: h.freelistCount,
            found: free.trunks.length + free.leaves.length,
            trunk: h.firstFreelistTrunk,
          }),
    ],
    [
      T('kv.autoVacuum'),
      T(
        `value.autoVacuum.${h.largestRootPage === 0 ? 'off' : h.incrementalVacuum ? 'incremental' : 'full'}`,
      ),
    ],
    [T('kv.changeCounter'), String(h.changeCounter)],
  ];
  if (h.reserved) entries.push([T('kv.reserved'), `${h.reserved} B`]);
  if (h.sqliteVersion) entries.push([T('kv.writtenBy'), `SQLite ${versionText(h.sqliteVersion)}`]);
  return entries;
}

/** Notes about the header that matter for the analysis. */
export function headerNotes(ctx: Context): Output[] {
  const f = ctx.file;
  const h = f.header;
  const out: Output[] = [];
  const pagesFromSize = Math.floor(f.bytes.length / f.pageSize);
  if (f.bytes.length % f.pageSize !== 0) {
    out.push({
      type: 'note',
      level: 'warn',
      text: T('note.truncatedPage', { extra: f.bytes.length % f.pageSize }),
    });
  }
  if (
    h.pagesInHeader > 0 &&
    h.versionValidFor === h.changeCounter &&
    h.pagesInHeader > pagesFromSize
  ) {
    out.push({
      type: 'note',
      level: 'warn',
      text: T('note.shortFile', { header: h.pagesInHeader, size: pagesFromSize }),
    });
  }
  if (h.pagesInHeader > 0 && h.versionValidFor !== h.changeCounter) {
    out.push({ type: 'note', level: 'info', text: T('note.staleCount') });
  }
  if (journalFromHeader(h) === 'wal' && !ctx.wal) {
    out.push({ type: 'note', level: 'warn', text: T('note.walMode') });
  }
  if (h.encoding === 'utf-8' && h.encodingCode !== 1) {
    out.push({
      type: 'note',
      level: 'warn',
      text: T('note.badEncoding', { code: h.encodingCode }),
    });
  }
  return out;
}

// ---------- carved records ----------

const WHERE_KEY: Record<CarveWhere, string> = {
  freeblock: 'freeblock',
  unallocated: 'unallocated',
  'free space': 'freeSpace',
  'freed page': 'freedPage',
};
export const whereText = (w: CarveWhere): string => T(`where.kind.${WHERE_KEY[w]}`);

const VALUE_LIMIT = 300;

export function formatCarvedValue(v: CellValue): string {
  switch (v.kind) {
    case 'null':
      return 'NULL';
    case 'int':
      return v.value.toString();
    case 'float':
      return String(v.value);
    case 'text':
      return v.value.length > VALUE_LIMIT ? `${v.value.slice(0, VALUE_LIMIT)}…` : v.value;
    case 'blob':
      return `x'${toHex(v.value.subarray(0, 16))}${v.value.length > 16 ? '…' : ''}' (${v.value.length} B)`;
    case 'lost':
      return `? x'${toHex(v.value.subarray(0, 16))}' (${v.value.length} B)`;
  }
}

function columnNames(db: Database | null, table: string): string[] | null {
  if (!db) return null;
  try {
    const rows = db.exec(`PRAGMA table_info(${quoteIdent(table)})`)[0]?.values;
    return rows?.length ? rows.map((r) => String(r[1])) : null;
  } catch {
    return null;
  }
}

export function recordRow(r: CarvedRecord, names: string[] | null): (string | number)[] {
  const named = names && names.length === r.values.length ? names : null;
  // The table and the row id lead the values, and the short columns come first: in a narrow
  // pane the values are what needs the room.
  const origin = `${r.owner ?? ''}${r.rowid !== null ? ` #${r.rowid}` : ''}`.trim();
  const values = r.values
    .map((v, i) => `${named ? `${named[i]}=` : ''}${formatCarvedValue(v)}`)
    .join(' | ');
  return [
    `${r.page} · ${r.offset}`,
    whereText(r.where),
    // A star marks a record whose header was rebuilt (see the note under the table).
    `${T(`confidence.${r.confidence}`)}${r.repaired ? '*' : ''}`,
    origin ? `${origin} → ${values}` : values,
  ];
}

const recordColumns = (): string[] => [
  T('col.location'),
  T('col.where'),
  T('col.confidence'),
  T('col.record'),
];

export async function deletedView(ctx: Context): Promise<Output[]> {
  const carved = ctx.carve();
  const out: Output[] = [];
  const stats = carved.stats;
  const real = carved.records.filter((r) => !r.liveCopy);
  const copies = carved.records.length - real.length;
  out.push({
    type: 'note',
    level: 'info',
    text: T('note.possiblyDeleted'),
  });
  out.push({
    type: 'kv',
    label: T('label.carveSummary'),
    entries: [
      [T('kv.pagesScanned'), String(stats.pagesScanned)],
      [T('kv.freeBytes'), formatSize(stats.freeBytes)],
      [
        T('kv.freePages'),
        T('value.freePages', { trunks: stats.freeTrunks, leaves: stats.freeLeaves }),
      ],
      [T('kv.recordsFound'), String(real.length)],
      [T('kv.liveCopies'), String(copies)],
      [T('kv.residualText'), String(carved.residual.length)],
    ],
  });
  for (const p of stats.freelistProblems)
    out.push({ type: 'note', level: 'warn', text: T('note.freelistProblem', { problem: p }) });
  if (stats.timedOutAtPage !== null) {
    out.push({
      type: 'note',
      level: 'warn',
      text: T('note.carveTimeout', { page: stats.timedOutAtPage, records: carved.records.length }),
    });
  } else if (stats.truncated) {
    out.push({
      type: 'note',
      level: 'warn',
      text: T('note.carveTruncated', { records: carved.records.length }),
    });
  }

  const db = real.length ? await ctx.db() : null;
  const names = new Map<string, string[] | null>();
  const columnsFor = (table: string | null) => {
    if (!table) return null;
    if (!names.has(table)) names.set(table, columnNames(db, table));
    return names.get(table) ?? null;
  };
  if (real.length) {
    out.push({
      type: 'table',
      label: T('label.deletedRecords'),
      columns: recordColumns(),
      rows: real.map((r) => recordRow(r, columnsFor(r.owner))),
      highlight: real.flatMap((r, i) => (r.confidence === 'high' ? [i] : [])),
    });
    if (real.some((r) => r.repaired))
      out.push({ type: 'note', level: 'info', text: T('note.repaired') });
    if (real.some((r) => r.truncated))
      out.push({ type: 'note', level: 'info', text: T('note.overflowCut') });
  } else {
    out.push({ type: 'note', level: 'success', text: T('note.noDeleted') });
  }
  if (copies) {
    out.push({
      type: 'table',
      label: T('label.liveCopies'),
      columns: recordColumns(),
      rows: carved.records.filter((r) => r.liveCopy).map((r) => recordRow(r, columnsFor(r.owner))),
    });
  }
  if (carved.residual.length) {
    out.push({
      type: 'table',
      label: T('label.residual'),
      columns: [T('col.page'), T('col.offset'), T('col.where'), T('col.text')],
      rows: carved.residual.map((r) => [r.page, r.offset, whereText(r.where), r.text]),
    });
  }
  const free = walkFreelist(ctx.file);
  if (free.trunks.length) {
    out.push({
      type: 'kv',
      label: T('label.freelist'),
      entries: [
        [T('kv.trunkPages'), free.trunks.slice(0, 50).join(', ')],
        [
          T('kv.leafPages'),
          free.leaves.length
            ? free.leaves.slice(0, 100).join(', ') + (free.leaves.length > 100 ? ' …' : '')
            : '-',
        ],
      ],
    });
  }
  return out;
}

// ---------- write-ahead log ----------

const KIND_KEY: Record<WalPageKind, string> = {
  'table-leaf': 'tableLeaf',
  'table-interior': 'tableInterior',
  'index-leaf': 'indexLeaf',
  'index-interior': 'indexInterior',
  other: 'other',
};
const kindText = (k: WalPageKind) => T(`value.pageKind.${KIND_KEY[k]}`);

function walHeaderEntries(info: WalInfo, size: number): [string, string][] {
  const h = info.header;
  return [
    [T('kv.fileSize'), `${formatSize(size)} (${size} B)`],
    [
      T('kv.walMagic'),
      `${hex32(h.magic)} · ${T(h.bigEndian ? 'value.bigEndian' : 'value.littleEndian')}`,
    ],
    [T('kv.walVersion'), String(h.version)],
    [T('kv.pageSize'), `${h.pageSize} B`],
    [T('kv.checkpointSeq'), String(h.checkpointSeq)],
    [T('kv.salts'), `${hex32(h.salt1)} ${hex32(h.salt2)}`],
    [T('kv.headerChecksum'), T(h.checksumOk ? 'value.ok' : 'value.bad')],
    [
      T('kv.frames'),
      T('value.frames', {
        total: info.frames.length,
        valid: info.validFrames,
        committed: info.committedFrames,
      }),
    ],
    [T('kv.dbPagesAfter'), info.dbPages ? String(info.dbPages) : '-'],
    ...(info.trailing ? ([[T('kv.trailing'), `${info.trailing} B`]] as [string, string][]) : []),
  ];
}

const frameStatus = (fr: WalFrame): string =>
  fr.committed
    ? T('value.frame.applied')
    : fr.valid
      ? T('value.frame.uncommitted')
      : fr.saltOk
        ? T('value.frame.badChecksum')
        : T('value.frame.older');

function framesTable(info: WalInfo, walBytes: Uint8Array, db: SqliteFile | null): Output {
  const ps = info.header.pageSize;
  return {
    type: 'table',
    label: T('label.walFrames'),
    columns: [
      T('col.frame'),
      T('col.page'),
      T('col.pageType'),
      T('col.commit'),
      T('col.status'),
      T('col.changedBytes'),
    ],
    rows: info.frames.slice(0, 2000).map((fr) => {
      const data = framePage(walBytes, info, fr);
      const before = db?.page(fr.page) ?? null;
      let diff: string | number = '-';
      if (before && before.length === ps) {
        let n = 0;
        for (let i = 0; i < ps; i++) if (before[i] !== data[i]) n++;
        diff = n;
      }
      const status = frameStatus(fr);
      return [
        fr.index,
        fr.page,
        kindText(pageKindOf(data, fr.page)),
        fr.commitSize ? T('value.commit', { pages: fr.commitSize }) : '',
        status,
        diff,
      ];
    }),
    highlight: info.frames.slice(0, 2000).flatMap((fr, i) => (fr.committed ? [i] : [])),
  };
}

function countRows(db: Database, name: string): number | null {
  try {
    return Number(scalar(db, `SELECT count(*) FROM ${quoteIdent(name)}`));
  } catch {
    return null;
  }
}

const DIFF_ROWS = 20_000;

/** Rows only in `before` and rows only in `after` (rowid first), as text; tables over 20 000 rows are skipped. */
function diffTable(before: Database, after: Database, name: string): [string[], string[]] {
  const rows = (db: Database): string[] | null => {
    try {
      const page = queryPage(db, `SELECT rowid, * FROM ${quoteIdent(name)}`, 0, DIFF_ROWS + 1);
      return page.more ? null : page.rows.map((r) => r.map(formatValue).join(' | '));
    } catch {
      return null;
    }
  };
  const a = rows(before);
  const b = rows(after);
  if (!a || !b) return [[], []];
  const inA = new Set(a);
  const inB = new Set(b);
  return [a.filter((r) => !inB.has(r)), b.filter((r) => !inA.has(r))];
}

export async function walView(ctx: Context): Promise<Output[]> {
  const w = ctx.wal;
  if (!w) {
    return [
      {
        type: 'note',
        level: journalFromHeader(ctx.file.header) === 'wal' ? 'warn' : 'info',
        text: T(journalFromHeader(ctx.file.header) === 'wal' ? 'note.walMode' : 'note.noWal'),
      },
    ];
  }
  const out: Output[] = [];
  if (w.mismatch) {
    out.push({
      type: 'note',
      level: 'error',
      text: T('note.walMismatch', { wal: w.info.header.pageSize, db: ctx.file.pageSize }),
    });
  }
  if (!w.info.header.checksumOk)
    out.push({ type: 'note', level: 'warn', text: T('note.walHeaderBad') });
  out.push({
    type: 'kv',
    label: T('label.walHeader'),
    entries: walHeaderEntries(w.info, w.bytes.length),
  });
  out.push(framesTable(w.info, w.bytes, w.mismatch ? null : openFile(ctx.original)));

  if (w.info.committedFrames === 0) {
    out.push({ type: 'note', level: 'warn', text: T('note.walNothingCommitted') });
    return out;
  }
  if (w.applied) {
    out.push({
      type: 'note',
      level: 'success',
      text: T('note.walApplied', {
        frames: w.info.committedFrames,
        pages: w.applied.changed.length,
        list: w.applied.changed.slice(0, 40).join(', '),
      }),
    });
    // How many rows each table has without and with the log.
    const before = await openDatabase(ctx.original).catch(() => null);
    const after = await ctx.db();
    try {
      if (before && after) {
        const names = (
          after.exec("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")[0]
            ?.values ?? []
        ).map((r) => String(r[0]));
        const rows = names.map((n) => [n, countRows(before, n) ?? '?', countRows(after, n) ?? '?']);
        out.push({
          type: 'table',
          label: T('label.walRowCounts'),
          columns: [T('col.table'), T('col.rowsFile'), T('col.rowsWal')],
          rows,
          highlight: rows.flatMap((r, i) => (r[1] !== r[2] ? [i] : [])),
        });
        const added: (string | number)[][] = [];
        const removed: (string | number)[][] = [];
        for (const n of names) {
          const [gone, fresh] = diffTable(before, after, n);
          for (const row of fresh) added.push([n, row]);
          for (const row of gone) removed.push([n, row]);
        }
        if (added.length) {
          out.push({
            type: 'table',
            label: T('label.walAdded'),
            columns: [T('col.table'), T('col.row')],
            rows: added.slice(0, 500),
            highlight: added.slice(0, 500).map((_, i) => i),
          });
        }
        if (removed.length) {
          out.push({
            type: 'table',
            label: T('label.walRemoved'),
            columns: [T('col.table'), T('col.row')],
            rows: removed.slice(0, 500),
          });
        }
      }
    } finally {
      before?.close();
    }
  } else {
    out.push({ type: 'note', level: 'info', text: T('note.walNotApplied') });
  }
  return out;
}

// ---------- a log or a journal opened on its own ----------

/** The rows stored in the table-leaf pages of a log, which holds whole pages. */
export function walOnlyView(bytes: Uint8Array, info: WalInfo): Output[] {
  const out: Output[] = [
    { type: 'note', level: 'warn', text: T('note.walOnly') },
    { type: 'kv', label: T('label.walHeader'), entries: walHeaderEntries(info, bytes.length) },
    framesTable(info, bytes, null),
  ];
  const ps = info.header.pageSize;
  const rows: (string | number)[][] = [];
  for (const fr of info.frames) {
    if (rows.length >= 1000) break;
    const data = framePage(bytes, info, fr);
    const bt = parseBtreePage(data, fr.page, ps);
    if (!bt || bt.type !== PAGE_TABLE_LEAF) continue;
    for (const at of bt.cells) {
      const ext = cellExtent(data, bt.type, at, ps);
      if (!ext) continue;
      // A cell that continues on overflow pages shows its first part: a log holds pages, not chains.
      const payload = data.subarray(ext.recordAt, ext.recordAt + ext.local);
      const rec = parseRecord(payload, 0, payload.length, 'utf-8', false);
      if (!rec) continue;
      rows.push([
        fr.index,
        fr.page,
        frameStatus(fr),
        ext.rowid ?? '-',
        rec.values.map(formatCarvedValue).join(' | '),
      ]);
    }
  }
  if (rows.length) {
    out.push({
      type: 'table',
      label: T('label.walRows'),
      columns: [T('col.frame'), T('col.page'), T('col.status'), T('col.rowid'), T('col.values')],
      rows,
    });
  }
  return out;
}

export function isRollbackJournal(b: Uint8Array): boolean {
  const magic = [0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7];
  return b.length >= 28 && magic.every((v, i) => b[i] === v);
}

export function journalView(b: Uint8Array): Output[] {
  const u32 = (o: number) =>
    ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
  const pageSize = u32(24);
  const records = pageSize >= 512 ? Math.floor((b.length - 512) / (pageSize + 8)) : 0;
  return [
    { type: 'note', level: 'warn', text: T('note.journal') },
    {
      type: 'kv',
      label: T('label.journalHeader'),
      entries: [
        [T('kv.fileSize'), `${formatSize(b.length)} (${b.length} B)`],
        [T('kv.pageSize'), `${pageSize} B`],
        [T('kv.journalRecords'), u32(8) === 0xffffffff ? T('value.unknownCount') : String(u32(8))],
        [T('kv.dbPagesBefore'), String(u32(16))],
        [T('kv.sectorSize'), String(u32(20))],
        [T('kv.wholeRecords'), String(records)],
      ],
    },
  ];
}
