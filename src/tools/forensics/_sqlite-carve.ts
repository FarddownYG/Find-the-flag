/**
 * Records that are no longer in the database but whose bytes are still in the file.
 *
 * SQLite does not erase a deleted row: the cell becomes a "freeblock" inside its page (its first
 * four bytes are overwritten by the freeblock's own bookkeeping), or the page's unallocated gap
 * grows over it, or the whole page goes to the freelist with its content untouched. This module
 * looks for cells that still parse as records there: a varint header length, one serial type per
 * column, and then exactly the number of bytes those serial types announce. Everything it finds is
 * "possibly deleted": the file cannot say when or why the bytes stopped being a live row.
 *
 * What survives depends on the cell:
 *  - a cell in unallocated space or in a freed page is complete (payload length, rowid, record);
 *  - a cell turned into a freeblock lost its first four bytes, which are the payload length, the
 *    rowid, and often the record's header length and first column type. The header is rebuilt
 *    from the freeblock size (see `repairFreeblock`).
 */
import {
  PAGE_INDEX_LEAF,
  PAGE_TABLE_LEAF,
  cellExtent,
  cellPayload,
  decodeText,
  decodeValue,
  freeblocks,
  pageOwners,
  parseBtreePage,
  parseRecord,
  readSchema,
  readVarint,
  serialSize,
  walkBtree,
  walkFreelist,
  type CellValue,
  type FreeBlock,
  type SchemaEntry,
  type SqliteFile,
  type TextEncoding,
} from './_sqlite-format';
import { toHex, u32be } from '../../lib/bytes';

export type CarveWhere = 'freeblock' | 'unallocated' | 'free space' | 'freed page';
export type Confidence = 'high' | 'medium' | 'low';

export interface CarvedRecord {
  /** 1-based page number. */
  page: number;
  /** Offset of the cell (or of the record, when its cell prefix is gone) inside the page. */
  offset: number;
  fileOffset: number;
  where: CarveWhere;
  /** Table or index the page belongs to, null for freelist pages (their owner is unknown). */
  owner: string | null;
  /** Row id when the cell prefix survived. */
  rowid: number | null;
  values: CellValue[];
  confidence: Confidence;
  /** The cell prefix or record header was rebuilt from the freeblock size. */
  repaired: boolean;
  /** Part of the record lives on overflow pages that are not here. */
  truncated: boolean;
  /** Bytes the record occupied. */
  length: number;
  kind: 'table' | 'index';
  /** An identical row is in the table now: a stale copy left by a page split, not a deleted row. */
  liveCopy: boolean;
}

export interface ResidualText {
  page: number;
  offset: number;
  fileOffset: number;
  where: CarveWhere;
  text: string;
}

export interface CarveStats {
  pagesScanned: number;
  freeTrunks: number;
  freeLeaves: number;
  freeBytes: number;
  freelistProblems: string[];
  /** The record limit or the time limit ended the scan before the last page. */
  truncated: boolean;
  /** The time limit was the reason, with the first page that was not read. */
  timedOutAtPage: number | null;
}

export interface CarveResult {
  records: CarvedRecord[];
  residual: ResidualText[];
  stats: CarveStats;
}

export interface CarveOptions {
  schema?: SchemaEntry[];
  /** Stop after this many records (the result says it was cut). */
  maxRecords?: number;
  maxResidual?: number;
  /** Shortest text run reported as residual. */
  minText?: number;
  /** Stop after this long (a page of adversarial bytes costs milliseconds, a disk image a lot). */
  timeBudgetMs?: number;
}

// ---------- plausibility ----------

const MAX_COLUMNS = 512;

function printable(text: string): boolean {
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c === 0xfffd || c === 0x7f || (c < 0x20 && c !== 9 && c !== 10 && c !== 13)) return false;
  }
  return true;
}

/** How believable a record is as a table row. null = reject. */
function judge(values: CellValue[], prefix: boolean, repaired: boolean): Confidence | null {
  if (values.length === 0 || values.length > MAX_COLUMNS) return null;
  let content = 0;
  let textChars = 0;
  for (const v of values) {
    switch (v.kind) {
      case 'text':
        if (!printable(v.value)) return null;
        textChars += v.value.length;
        if (v.value.length > 0) content++;
        break;
      case 'int':
        if (v.value !== 0n && v.value !== 1n) content++;
        break;
      case 'float': {
        // Doubles read out of text or zeros are huge, tiny or not numbers at all.
        const m = Math.abs(v.value);
        if (!Number.isFinite(m) || (m !== 0 && (m < 1e-12 || m > 1e18))) return null;
        content++;
        break;
      }
      case 'blob':
      case 'lost':
        if (v.value.some((b) => b !== 0)) content++;
        break;
      case 'null':
        break;
    }
  }
  if (content === 0) return null;
  if (textChars >= 3) return prefix && !repaired ? 'high' : 'medium';
  return 'low';
}

// ---------- what the live rows of a table look like ----------

type Kind = 'int' | 'float' | 'text' | 'blob';

/**
 * The column counts and the kinds of value seen in a table's live rows. A cell rebuilt from a
 * freeblock has to look like those rows: it is what keeps text read as serial types, and the
 * other ways of reading a record wrongly, out of the results.
 */
interface TableShape {
  counts: Set<number>;
  kinds: Set<Kind>[];
  /** Columns that were NULL in some live row, and how many live rows were looked at. */
  nulls: boolean[];
  samples: number;
}

const newShape = (): TableShape => ({ counts: new Set(), kinds: [], nulls: [], samples: 0 });

function kindOf(st: number): Kind | null {
  if (st === 0) return null;
  if (st === 7) return 'float';
  if (st < 12) return 'int';
  return st % 2 === 0 ? 'blob' : 'text';
}

/** Add the record header at `p` to the shape. */
function learn(shape: TableShape, page: Uint8Array, p: number, limit: number): void {
  const hv = readVarint(page, p, limit);
  if (!hv) return;
  const headerEnd = Math.min(p + hv.value, limit);
  let q = p + hv.len;
  let n = 0;
  while (q < headerEnd) {
    const sv = readVarint(page, q, headerEnd);
    if (!sv) break;
    q += sv.len;
    const k = kindOf(sv.value);
    if (k) (shape.kinds[n] ??= new Set()).add(k);
    else shape.nulls[n] = true;
    n++;
  }
  if (n > 0) {
    shape.counts.add(n);
    shape.samples++;
  }
}

/** True when a rebuilt record could be a row of the table. */
function fitsShape(shape: TableShape, values: CellValue[]): boolean {
  if (shape.counts.size === 0) return true;
  const widest = Math.max(...shape.counts);
  if (values.length > widest) return false;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    const seen = shape.kinds[i];
    if (v.kind === 'null' || v.kind === 'lost' || !seen || seen.size === 0) continue;
    if (seen.has(v.kind)) continue;
    if ((v.kind === 'int' && seen.has('float')) || (v.kind === 'float' && seen.has('int')))
      continue;
    return false;
  }
  return true;
}

/** NULLs in columns that no live row has a NULL in (enough rows seen to call it odd). */
function surprises(shape: TableShape, values: CellValue[]): number {
  if (shape.samples < 5) return 0;
  let n = 0;
  values.forEach((v, i) => {
    if (v.kind === 'null' && !shape.nulls[i] && (shape.kinds[i]?.size ?? 0) > 0) n++;
  });
  return n;
}

// ---------- one page ----------

interface Candidate {
  /** Offset of the cell or record start. */
  start: number;
  end: number;
  rowid: number | null;
  values: CellValue[];
  confidence: Confidence;
  repaired: boolean;
  truncated: boolean;
  kind: 'table' | 'index';
  /** NULLs where the table's live rows never have one. */
  surprise?: number;
}

interface Span {
  start: number;
  end: number;
}

/** A cell with its payload length (and rowid) intact: `[payload][rowid][record]`. */
function intactCell(
  page: Uint8Array,
  p: number,
  limit: number,
  usable: number,
  enc: TextEncoding,
  kind: 'table' | 'index',
): Candidate | null {
  const pl = readVarint(page, p, limit);
  if (!pl || pl.value < 2 || pl.value > 1 << 26) return null;
  // The same size rules SQLite uses for a live cell (local part, overflow pointer).
  const probe = cellExtent(page, kind === 'table' ? PAGE_TABLE_LEAF : PAGE_INDEX_LEAF, p, usable);
  if (!probe || probe.payload !== pl.value) return null;
  const end = p + probe.size;
  if (end > limit) return null;
  const rec = parseRecord(page, probe.recordAt, probe.recordAt + probe.local, enc, true);
  if (!rec || rec.size !== pl.value) return null;
  const confidence = judge(rec.values, true, false);
  if (!confidence) return null;
  return {
    start: p,
    end,
    rowid: probe.rowid,
    values: rec.values,
    confidence,
    repaired: false,
    truncated: rec.truncated || probe.overflow !== 0,
    kind,
  };
}

/** Serial types read one after the other from `p`; stops at the first invalid one. */
function readSerials(page: Uint8Array, p: number, limit: number, max: number) {
  const serials: number[] = [];
  /** End of the n-th type (where the data starts if the header stops there). */
  const ends: number[] = [];
  /** Bytes of data the first n types announce. */
  const sizes: number[] = [];
  let q = p;
  let data = 0;
  while (serials.length < max) {
    const sv = readVarint(page, q, limit);
    if (!sv) break;
    const size = serialSize(sv.value);
    if (size < 0) break;
    data += size;
    q += sv.len;
    serials.push(sv.value);
    ends.push(q);
    sizes.push(data);
  }
  return { serials, ends, sizes };
}

function valuesFrom(
  page: Uint8Array,
  dataStart: number,
  serials: number[],
  enc: TextEncoding,
  first: CellValue | null,
): CellValue[] | null {
  const out: CellValue[] = [];
  if (first) out.push(first);
  let d = dataStart;
  for (const st of serials) {
    const size = serialSize(st);
    if (d + size > page.length) return null;
    const v = decodeValue(page, d, st, enc, true);
    if (!v) return null;
    out.push(v);
    d += size;
  }
  return out;
}

/**
 * The ways a cell can have started at `q` inside a block of deleted cells that ends at `end`.
 * A deleted table cell that became a freeblock lost its first four bytes (they now hold the next
 * freeblock offset and the block size), so what is left of
 * `[payload length][rowid][header length][types...][data]` depends on how long the first two
 * varints were (P = their total length):
 *  - P >= 4: the header length is still readable at offset P: parse a record there;
 *  - P = 3: only the header length is lost: the types start at byte 4;
 *  - P = 2: the header length and the first column's type are lost. A NULL first column (what a
 *    rowid alias is stored as) leaves the other types readable from byte 4 as well.
 * Where the cell ends is not known in the last two cases: every end that makes the data fit the
 * types is a candidate, and `makeTiler` picks the ones that line up with their neighbours.
 * A cell whose start survived (its lower neighbour was freed first and absorbed it) parses as an
 * ordinary intact cell.
 */
function cellsAt(
  page: Uint8Array,
  q: number,
  end: number,
  usable: number,
  enc: TextEncoding,
  shape: TableShape,
): Candidate[] {
  const out: Candidate[] = [];
  // Erased space (a run of zeros) holds no cell, and is by far the most common thing to meet.
  if (page[q] === 0 && page[q + 1] === 0 && page[q + 2] === 0 && page[q + 3] === 0) return out;
  const intact = intactCell(page, q, end, usable, enc, 'table');
  if (intact) out.push(intact);
  const make = (start: number, stop: number, values: CellValue[]) => {
    const confidence = judge(values, false, true);
    // Text is what makes a rebuilt record believable. Without it, only a table whose live rows
    // have the same shape can vouch for it.
    const vouched = shape.counts.has(values.length) && !values.some((v) => v.kind === 'lost');
    if (confidence && fitsShape(shape, values) && (confidence !== 'low' || vouched)) {
      out.push({
        start,
        end: stop,
        rowid: null,
        values,
        confidence,
        repaired: true,
        truncated: false,
        kind: 'table',
        surprise: surprises(shape, values),
      });
    }
  };
  for (let r = q + 4; r <= q + 9 && r + 3 <= end; r++) {
    const rec = parseRecord(page, r, end, enc, true);
    if (rec) make(q, r + rec.size, rec.values);
  }
  const types = readSerials(page, q + 4, end, 64);
  for (let n = 1; n <= types.serials.length; n++) {
    const ds = types.ends[n - 1]!;
    const stop = ds + types.sizes[n - 1]!;
    if (stop > end) break;
    const serials = types.serials.slice(0, n);
    // A one-byte payload length is needed for a two-byte prefix: cells under 130 bytes.
    if (stop - q - 2 < 128) {
      const v = valuesFrom(page, ds, serials, enc, { kind: 'null' });
      if (v) make(q, stop, v);
    }
    const v = valuesFrom(page, ds, serials, enc, null);
    if (v) make(q, stop, v);
  }
  // The last cell of a block, whose first column was not NULL: its type is lost, but the block
  // size says how many bytes it had.
  for (let n = 1; n <= types.serials.length; n++) {
    const ds = types.ends[n - 1]!;
    const first = end - ds - types.sizes[n - 1]!;
    if (first < 0) break;
    if (first === 0 || first > 4096) continue;
    const tail = valuesFrom(page, ds + first, types.serials.slice(0, n), enc, null);
    if (!tail) continue;
    const bytes = page.slice(ds, ds + first);
    const text = decodeText(bytes, enc, true);
    const lead: CellValue =
      text !== null && printable(text)
        ? { kind: 'text', value: text }
        : { kind: 'lost', value: bytes };
    const confidence = judge([lead, ...tail], false, true);
    // A table whose first column is always NULL (a rowid alias) has no business with a lost one.
    const leadSeen = shape.kinds[0];
    if (
      confidence &&
      leadSeen &&
      leadSeen.size > 0 &&
      shape.counts.has(tail.length + 1) &&
      fitsShape(shape, [lead, ...tail])
    ) {
      out.push({
        start: q,
        end,
        rowid: null,
        values: [lead, ...tail],
        confidence: 'low',
        repaired: true,
        truncated: false,
        kind: 'table',
      });
    }
  }
  return out;
}

/** Worth of a cell in a tiling. Every cell costs a little, so a block is not cut in more pieces than it has to be. */
const SCORE: Record<Confidence, number> = { high: 7, medium: 6, low: 3 };
/** Extra worth of a cell with as many columns as the live rows of the table have. */
const COUNT_MATCH = 10;
const SURPRISE_COST = 6;
const CELL_COST = 5;
/** Reaching exactly the end of the block is worth about a cell; skipping bytes costs about half of one. */
const EXACT_BONUS = 10;
const GAP_COST = 6;
const MAX_TILER_CALLS = 50_000;

interface Tiling {
  /** The cells reach exactly the end of the block. */
  exact: boolean;
  score: number;
  /** Null for the end of the chain and for a stretch skipped over. */
  cell: Candidate | null;
  next: Tiling | null;
}

const worth = (t: Tiling) => t.score + (t.exact ? EXACT_BONUS : 0);

/**
 * Cut a block of deleted cells into cells that follow one another and end where the block ends.
 * Several readings of a cell can fit; the one whose neighbours also read as rows wins, because a
 * wrong reading of a record almost never leaves a valid record right after it. `shape` (the live
 * rows of the table) breaks the tie between a NULL first column and none. A cell whose bytes were
 * partly overwritten since it was deleted cannot be read; the tiling may jump over it to a cell
 * that parses on its own (an "anchor"), at a cost, so that the cells after it still line up with
 * the end of the block.
 */
function makeTiler(
  page: Uint8Array,
  from: number,
  end: number,
  usable: number,
  enc: TextEncoding,
  shape: TableShape,
  stop: () => boolean,
): (start: number) => { exact: boolean; score: number; cells: Candidate[] } {
  const memo = new Map<number, Tiling>();
  let calls = 0;
  let anchors: number[] | null = null;
  const anchorsAfter = (q: number): number[] => {
    if (!anchors) {
      anchors = [];
      for (let p = from; p + 4 <= end; p++) {
        if (
          page[p] !== 0 &&
          intactCell(page, p, end, usable, enc, 'table')?.confidence === 'high'
        ) {
          anchors.push(p);
        }
      }
    }
    return anchors.filter((a) => a > q).slice(0, 3);
  };
  const solve = (q: number): Tiling => {
    const known = memo.get(q);
    if (known) return known;
    let best: Tiling = { exact: q === end, score: 0, cell: null, next: null };
    // A page of repeating text can be read in many ways: give up on it rather than try them all.
    if (++calls > MAX_TILER_CALLS || (calls % 128 === 0 && stop())) return best;
    if (end - q >= 4) {
      for (const c of cellsAt(page, q, end, usable, enc, shape)) {
        if (c.end <= q) continue;
        const rest = solve(c.end);
        const bonus =
          (shape.counts.has(c.values.length) ? COUNT_MATCH : 0) - SURPRISE_COST * (c.surprise ?? 0);
        const cand: Tiling = {
          exact: rest.exact,
          score: rest.score + SCORE[c.confidence] + bonus - CELL_COST,
          cell: c,
          next: rest,
        };
        if (worth(cand) > worth(best)) best = cand;
      }
      for (const a of anchorsAfter(q)) {
        const rest = solve(a);
        const cand: Tiling = {
          exact: rest.exact,
          score: rest.score - GAP_COST,
          cell: null,
          next: rest,
        };
        if (worth(cand) > worth(best)) best = cand;
      }
    }
    memo.set(q, best);
    return best;
  };
  return (start) => {
    const cells: Candidate[] = [];
    const first = solve(start);
    for (let t: Tiling | null = first; t; t = t.next) if (t.cell) cells.push(t.cell);
    return { exact: first.exact, score: worth(first), cells };
  };
}

class PageScan {
  readonly covered: Uint8Array;
  readonly found: Candidate[] = [];
  constructor(
    readonly page: Uint8Array,
    readonly usable: number,
  ) {
    this.covered = new Uint8Array(page.length);
  }
  take(c: Candidate): boolean {
    for (let i = c.start; i < c.end; i++) if (this.covered[i]) return false;
    this.covered.fill(1, c.start, c.end);
    this.found.push(c);
    return true;
  }
}

interface PageInfo {
  no: number;
  owner: string | null;
  table: boolean;
  /** The live rows of the table this page belongs to. */
  shape: TableShape;
  freed: boolean;
}

/**
 * Look for deleted cells in the free bytes [a, b) of a page.
 *  1. Table pages: every freeblock is cut into cells that end where the block ends.
 *  2. What is left (the unallocated gap, space after a page was emptied, fragments): the cells
 *     there are packed against the end of the free space, so the first start from which cells
 *     follow one another all the way to the end is taken.
 *  3. Cells that parse on their own (payload length, rowid and record all intact) wherever they
 *     still sit.
 */
function scanRegion(
  scan: PageScan,
  a: number,
  b: number,
  info: PageInfo,
  blocks: FreeBlock[],
  enc: TextEncoding,
  kinds: ('table' | 'index')[],
  stop: () => boolean,
): void {
  if (info.table) {
    const sound = (c: Candidate) =>
      c.confidence === 'high' ||
      (c.confidence === 'medium' &&
        (info.shape.counts.size === 0 || info.shape.counts.has(c.values.length)) &&
        !c.surprise);
    for (const fb of blocks) {
      if (fb.offset < a || fb.offset >= b || stop()) continue;
      const end = Math.min(fb.offset + fb.size, b);
      const tile = makeTiler(scan.page, fb.offset, end, scan.usable, enc, info.shape, stop);
      const { exact, cells } = tile(fb.offset);
      // A block that does not tile exactly may have been partly reused since: its cells have to
      // vouch for themselves one by one.
      for (const c of cells) if (exact || sound(c)) scan.take(c);
    }
    // The uncovered stretches of the region.
    let p = a;
    while (p < b && !stop()) {
      if (scan.covered[p]) {
        p++;
        continue;
      }
      let q = p;
      while (q < b && !scan.covered[q]) q++;
      if (q - p >= 8) {
        const tile = makeTiler(scan.page, p, q, scan.usable, enc, info.shape, stop);
        let best: ReturnType<typeof tile> | null = null;
        for (let s = p; s + 4 <= q && !stop(); s++) {
          const t = tile(s);
          if (t.exact && t.cells.length && t.cells.every(sound) && (!best || t.score > best.score))
            best = t;
        }
        if (best) for (const c of best.cells) scan.take(c);
      }
      p = q;
    }
  }
  let p = a;
  while (p + 4 <= b && !stop()) {
    if (scan.covered[p]) {
      p++;
      continue;
    }
    let took = false;
    for (const kind of kinds) {
      const c = intactCell(scan.page, p, b, scan.usable, enc, kind);
      if (c && scan.take(c)) {
        p = c.end;
        took = true;
        break;
      }
    }
    if (!took) p++;
  }
}

/** The shape of each table's live rows, learnt from a few cells of every leaf page. */
function learnShapes(
  f: SqliteFile,
  owners: Map<number, { owner: string; objectType: string }>,
): Map<string, TableShape> {
  const out = new Map<string, TableShape>();
  const sampled = new Map<string, number>();
  for (const [no, o] of owners) {
    if (o.objectType !== 'table' || (sampled.get(o.owner) ?? 0) >= 400) continue;
    const page = f.page(no);
    const bt = page ? parseBtreePage(page, no, f.usable) : null;
    if (!page || !bt || bt.type !== PAGE_TABLE_LEAF) continue;
    const shape = out.get(o.owner) ?? newShape();
    out.set(o.owner, shape);
    for (const at of bt.cells.slice(0, 6)) {
      const ext = cellExtent(page, bt.type, at, f.usable);
      if (!ext) continue;
      learn(shape, page, ext.recordAt, ext.recordAt + ext.local);
      sampled.set(o.owner, (sampled.get(o.owner) ?? 0) + 1);
    }
  }
  return out;
}

/** Printable ASCII runs of `minLen` or more bytes in [a, b) that no record covers. */
function textRuns(scan: PageScan, a: number, b: number, minLen: number) {
  const out: { offset: number; text: string }[] = [];
  let start = -1;
  const flush = (end: number) => {
    if (start >= 0 && end - start >= minLen) {
      let letters = 0;
      let text = '';
      for (let i = start; i < end; i++) {
        const c = scan.page[i]!;
        text += String.fromCharCode(c);
        if ((c | 32) >= 97 && (c | 32) <= 122) letters++;
      }
      if (letters >= 3) out.push({ offset: start, text });
    }
    start = -1;
  };
  for (let i = a; i < b; i++) {
    const c = scan.page[i]!;
    if (!scan.covered[i] && ((c >= 0x20 && c < 0x7f) || c === 9)) {
      if (start < 0) start = i;
    } else flush(i);
  }
  flush(b);
  return out;
}

const valueKey = (v: CellValue): string => {
  switch (v.kind) {
    case 'null':
      return 'n';
    case 'int':
      return `i${v.value}`;
    case 'float':
      return `f${v.value}`;
    case 'text':
      return `t${v.value}`;
    case 'blob':
      return `b${v.value.length}:${toHex(v.value.subarray(0, 32))}`;
    case 'lost':
      return '?';
  }
};
const rowKey = (values: CellValue[]): string => values.map(valueKey).join('\u0001');

/**
 * Splitting a page leaves the old copy of every moved cell behind. When a record found in free
 * space is identical to a row the table has now, it is such a copy and not a deleted row: mark it
 * so the listing can set it apart.
 */
function markLiveCopies(f: SqliteFile, schema: SchemaEntry[], records: CarvedRecord[]): void {
  const byOwner = new Map<string, Map<string, CarvedRecord[]>>();
  for (const r of records) {
    if (!r.owner || r.kind !== 'table' || r.values.some((v) => v.kind === 'lost')) continue;
    const keys = byOwner.get(r.owner) ?? new Map<string, CarvedRecord[]>();
    const key = rowKey(r.values);
    keys.set(key, [...(keys.get(key) ?? []), r]);
    byOwner.set(r.owner, keys);
  }
  for (const [owner, keys] of byOwner) {
    const entry = schema.find((e) => e.type === 'table' && e.name === owner);
    if (!entry || entry.rootPage < 2) continue;
    let seen = 0;
    walkBtree(f, entry.rootPage, (page, bt, at) => {
      if (++seen > 300_000) return;
      const ext = cellExtent(page, bt.type, at, f.usable);
      if (!ext) return;
      const payload = cellPayload(f, page, ext, 1 << 16);
      const rec = parseRecord(payload, 0, payload.length, f.header.encoding, false);
      if (!rec) return;
      for (const r of keys.get(rowKey(rec.values)) ?? []) r.liveCopy = true;
    });
  }
}

// ---------- the whole file ----------

export function carveFile(f: SqliteFile, opts: CarveOptions = {}): CarveResult {
  const enc = f.header.encoding;
  const schema = opts.schema ?? readSchema(f).entries;
  const owners = pageOwners(f, schema);
  const freelist = walkFreelist(f);
  const trunks = new Set(freelist.trunks);
  const leaves = new Set(freelist.leaves);
  const maxRecords = opts.maxRecords ?? 5000;
  const maxResidual = opts.maxResidual ?? 300;
  const minText = opts.minText ?? 6;
  const shapes = learnShapes(f, owners);

  const result: CarveResult = {
    records: [],
    residual: [],
    stats: {
      pagesScanned: 0,
      freeTrunks: freelist.trunks.length,
      freeLeaves: freelist.leaves.length,
      freeBytes: 0,
      freelistProblems: freelist.problems,
      truncated: false,
      timedOutAtPage: null,
    },
  };
  const started = performance.now();
  const budget = opts.timeBudgetMs ?? 6000;
  let currentPage = 1;
  const full = () => {
    if (result.records.length >= maxRecords) result.stats.truncated = true;
    else if (result.stats.timedOutAtPage === null && performance.now() - started > budget) {
      result.stats.truncated = true;
      result.stats.timedOutAtPage = currentPage;
    }
    return result.stats.truncated;
  };

  const publish = (
    scan: PageScan,
    info: PageInfo,
    whereOf: (offset: number) => CarveWhere,
    regions: Span[],
  ) => {
    const base = (info.no - 1) * f.pageSize;
    for (const c of scan.found) {
      if (result.records.length >= maxRecords) return;
      result.records.push({
        page: info.no,
        offset: c.start,
        fileOffset: base + c.start,
        where: info.freed ? 'freed page' : whereOf(c.start),
        owner: info.owner,
        rowid: c.rowid,
        values: c.values,
        confidence: c.confidence,
        repaired: c.repaired,
        truncated: c.truncated,
        length: c.end - c.start,
        kind: c.kind,
        liveCopy: false,
      });
    }
    for (const r of regions) {
      for (const run of textRuns(scan, r.start, r.end, minText)) {
        if (result.residual.length >= maxResidual) return;
        result.residual.push({
          page: info.no,
          offset: run.offset,
          fileOffset: base + run.offset,
          where: info.freed ? 'freed page' : whereOf(run.offset),
          text: run.text,
        });
      }
    }
  };

  for (let no = 1; no <= f.presentPages && !full(); no++) {
    currentPage = no;
    if (f.isPtrmap(no) || f.isLockPage(no)) continue;
    const page = f.page(no)!;
    const freedTrunk = trunks.has(no);
    const freed = freedTrunk || leaves.has(no);
    const owner = freed ? null : (owners.get(no)?.owner ?? null);
    const info: PageInfo = { no, owner, table: false, shape: newShape(), freed };

    if (freedTrunk) {
      const count = Math.min(u32be(page, 4), Math.floor(f.usable / 4) - 2);
      const start = 8 + 4 * count;
      const scan = new PageScan(page, f.usable);
      scanRegion(scan, start, f.usable, info, [], enc, ['table', 'index'], full);
      result.stats.pagesScanned++;
      result.stats.freeBytes += f.usable - start;
      publish(scan, info, () => 'freed page', [{ start, end: f.usable }]);
      continue;
    }

    const bt = parseBtreePage(page, no, f.usable);
    if (!bt) {
      if (!freed) continue;
      // A freelist leaf that no longer looks like a b-tree page: look through all of it.
      const scan = new PageScan(page, f.usable);
      scanRegion(scan, 0, f.usable, info, [], enc, ['table', 'index'], full);
      result.stats.pagesScanned++;
      result.stats.freeBytes += f.usable;
      publish(scan, info, () => 'freed page', [{ start: 0, end: f.usable }]);
      continue;
    }
    if ((bt.type === 2 || bt.type === 5) && !freed) continue;

    const isTable = bt.type === PAGE_TABLE_LEAF;
    const kind: 'table' | 'index' = isTable ? 'table' : 'index';
    info.table = isTable;
    const scan = new PageScan(page, f.usable);
    result.stats.pagesScanned++;
    if (bt.type === 2 || bt.type === 5) {
      // A freed interior page has keys but no rows; only text left in it is of interest.
      publish(scan, info, () => 'freed page', [{ start: bt.arrayEnd, end: f.usable }]);
      continue;
    }

    if (owner && !freed) info.shape = shapes.get(owner) ?? newShape();
    const live: Span[] = [];
    for (const at of bt.cells) {
      const ext = cellExtent(page, bt.type, at, f.usable);
      if (!ext) continue;
      live.push({ start: at, end: at + ext.size });
      if (!freed) continue;
      // Every cell of a freed page is a record that went away with its table.
      const payload = cellPayload(f, page, ext, 1 << 16);
      const rec = parseRecord(payload, 0, payload.length, enc, false);
      const confidence = rec ? judge(rec.values, true, false) : null;
      if (rec && confidence) {
        scan.take({
          start: at,
          end: at + ext.size,
          rowid: ext.rowid,
          values: rec.values,
          confidence,
          repaired: false,
          truncated: rec.truncated || ext.overflow !== 0,
          kind,
        });
      }
    }
    live.sort((a, b) => a.start - b.start);
    if (!freed) for (const s of live) scan.covered.fill(1, s.start, s.end);
    // The complement of the cells inside [end of the pointer array, usable).
    const regions: Span[] = [];
    let cursor = bt.arrayEnd;
    for (const s of live) {
      if (s.start > cursor) regions.push({ start: cursor, end: s.start });
      cursor = Math.max(cursor, s.end);
    }
    if (cursor < f.usable) regions.push({ start: cursor, end: f.usable });

    const blocks = freeblocks(page, bt, f.usable);
    for (const r of regions) {
      result.stats.freeBytes += r.end - r.start;
      scanRegion(scan, r.start, r.end, info, blocks, enc, [kind], full);
    }
    publish(
      scan,
      info,
      (offset) =>
        blocks.some((b) => offset >= b.offset && offset < b.offset + b.size)
          ? 'freeblock'
          : offset < bt.contentStart
            ? 'unallocated'
            : 'free space',
      regions,
    );
  }
  result.records.sort((a, b) => a.page - b.page || a.offset - b.offset);
  markLiveCopies(f, schema, result.records);
  return result;
}
