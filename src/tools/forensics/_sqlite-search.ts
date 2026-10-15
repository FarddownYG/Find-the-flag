/**
 * Flag-shaped strings in the database: every text cell of every table (and BLOBs that read as
 * text), the CREATE statements, the records the carver found in free space, and the text left
 * in free space that belongs to no record.
 */
import { findFlags } from '../../core/flags';
import type { Context } from './_sqlite-ctx';
import { blobText } from './_sqlite-cells';
import { quoteIdent, type Statement } from './_sqlite-engine';
import type { CellValue } from './_sqlite-format';
import { toolT } from '../../i18n/tool-text';

const T = toolT('sqlite');

export interface FlagHit {
  where: string;
  flag: string;
}

export interface SearchBudget {
  /** Cells looked at in live tables before the search stops. */
  cells: number;
  /** Characters of text looked at in live tables. */
  chars: number;
}

export interface SearchResult {
  hits: FlagHit[];
  scannedCells: number;
  /** A budget ran out before every table was read. */
  truncated: boolean;
  /** Tables SQLite could not read (all of them, or from some page on). */
  errors: { table: string; message: string }[];
}

function textOf(v: CellValue): string | null {
  if (v.kind === 'text') return v.value;
  if (v.kind === 'blob' || v.kind === 'lost') return blobText(v.value);
  return null;
}

export async function searchFlags(
  ctx: Context,
  re: RegExp,
  budget: SearchBudget,
  limit: number,
  includeCarved: boolean,
): Promise<SearchResult> {
  const hits: FlagHit[] = [];
  const seen = new Set<string>();
  const add = (where: string, flag: string) => {
    const key = `${where}\u0000${flag}`;
    if (hits.length < limit && !seen.has(key)) {
      seen.add(key);
      hits.push({ where, flag });
    }
  };
  const scan = (where: string, s: string) => {
    for (const f of findFlags(s, re, 20)) add(where, f.value);
  };
  let scannedCells = 0;
  let chars = 0;
  let truncated = false;
  const errors: { table: string; message: string }[] = [];

  for (const e of ctx.schema) if (e.sql) scan(T('where.schema', { name: e.name }), e.sql);

  const db = await ctx.db();
  if (db) {
    const tables = db.exec(
      "SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND sql NOT LIKE 'CREATE VIRTUAL%'",
    )[0]?.values;
    for (const [name, sql] of tables ?? []) {
      if (typeof name !== 'string' || hits.length >= limit) continue;
      const rowid = !/WITHOUT\s+ROWID/i.test(String(sql));
      let stmt: Statement;
      try {
        stmt = db.prepare(`SELECT ${rowid ? 'rowid, ' : ''}* FROM ${quoteIdent(name)}`);
      } catch (e) {
        errors.push({ table: name, message: e instanceof Error ? e.message : String(e) });
        continue;
      }
      try {
        const cols = stmt.getColumnNames();
        let n = 0;
        while (stmt.step()) {
          n++;
          const row = stmt.get();
          for (let c = rowid ? 1 : 0; c < row.length; c++) {
            const v = row[c]!;
            const s = typeof v === 'string' ? v : v instanceof Uint8Array ? blobText(v) : null;
            if (s === null) continue;
            scannedCells++;
            chars += s.length;
            if (scannedCells > budget.cells || chars > budget.chars) {
              truncated = true;
              break;
            }
            scan(
              T('where.cell', {
                table: name,
                column: cols[c] ?? '',
                row: rowid ? String(row[0]) : n,
              }),
              s,
            );
          }
          if (truncated || hits.length >= limit) break;
        }
      } catch (e) {
        // A damaged page in the middle of a table: what was read before it still counts.
        errors.push({ table: name, message: e instanceof Error ? e.message : String(e) });
      } finally {
        stmt.free();
      }
      if (truncated) break;
    }
  }

  if (includeCarved && hits.length < limit) {
    const carved = ctx.carve();
    for (const r of carved.records) {
      if (r.liveCopy) continue;
      for (const v of r.values) {
        const s = textOf(v);
        if (s) scan(T('where.deleted', { page: r.page, offset: r.offset }), s);
      }
    }
    for (const r of carved.residual) {
      scan(T('where.free', { page: r.page, offset: r.offset }), r.text);
    }
  }
  return { hits, scannedCells, truncated, errors };
}
