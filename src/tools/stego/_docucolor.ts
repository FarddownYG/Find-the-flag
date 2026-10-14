/**
 * Xerox DocuColor "yellow dots" (Machine Identification Code): layout, parity, decode, encode.
 *
 * Facts come from these sources (no code was copied):
 * - EFF, "DocuColor Tracking Dot Decoding Guide" — https://w2.eff.org/Privacy/printers/docucolor/
 *   A tile is 15 columns × 8 rows. Row 1 (top) and column 1 (left) are parity: "every column
 *   contains an odd number of dots, and every row (except the topmost row) contains an odd number
 *   of dots". Each other column is read top to bottom as a 7-bit value (rows 2-8 weigh 64, 32, 16,
 *   8, 4, 2, 1). Column 2 is the minute, 5 the hour, 6 the day, 7 the month, 8 the year (two
 *   digits, no century); 10 is a separator, typically all dots; 11-14 hold the printer serial
 *   number as decimal digits, two per column, read in the order 14, 13, 12, 11; 15 is unknown;
 *   3, 4 and 9 carry nothing known.
 * - DEDA by dfd-tud, libdeda/pattern_handler.py, class Pattern4 —
 *   https://github.com/dfd-tud/deda/blob/master/libdeda/pattern_handler.py
 *   The same layout drawn mirrored, in an 8 × 16 block whose column 0 is empty and column 15 is
 *   the parity column, so EFF column = 16 − DEDA column. Its encoder sets every parity dot with
 *   `1 - sum % 2` (odd parity), the corner included, so all 15 columns end up odd. Its checker
 *   tests the 7 data rows and the 14 data columns only, i.e. it does not look at the parity
 *   column; we follow the EFF sentence above and check column 1 too (a flipped corner dot is then
 *   caught). Its "printer" field is EFF columns 14, 13, 12, 11 (eight digits, "%02d" each, most
 *   significant first) and its six-digit "serial" field EFF columns 13, 12, 11. It reads EFF column
 *   4 as a maker code (0 or 4 Xerox, 3 Epson, 20 Dell; a Dell tile has no real serial). The
 *   century is not in the tile: DEDA picks the one closest to 2018, i.e. 00-68 → 20xx and
 *   69-99 → 19xx, our default (AyWiZz/docucolor-decode cuts at 70 instead; only 69 differs).
 *
 * Parity detail: 7 odd data rows and 15 odd columns are consistent (the 15 column counts add up to
 * an odd total; the 7 data rows to an odd total too, so row 1 holds an even number of dots). Row 1
 * is therefore not checked, as the EFF says.
 *
 * Everything below uses EFF numbering: rows 1-8, columns 1-15, 1 = parity. Arrays are 0-based.
 */
import { ToolError } from '../../core/errors';
import type { RgbaImage } from '../../core/types';

const p2 = (n: number) => String(n).padStart(2, '0');

export const ROWS = 8;
export const COLS = 15;
/** Weight of rows 2..8 (array rows 1..7). */
export const WEIGHTS = [64, 32, 16, 8, 4, 2, 1] as const;
/** EFF: "column 10 ... a separator, typically all ones". */
export const SEPARATOR_COLUMN = 10;
/** EFF: column 15 is unknown. */
export const UNKNOWN_COLUMN = 15;
/** DEDA: EFF column 4 is a maker code. */
export const MAKER_COLUMN = 4;
export const MAKERS: Readonly<Record<number, string>> = {
  0: 'Xerox',
  3: 'Epson',
  4: 'Xerox',
  20: 'Dell',
};
/** DEDA: the century closest to 2018 — two-digit years from this one up are 19xx. */
export const YEAR_PIVOT = 69;

/** How the two-digit year column becomes a full year. 'pivot': 00-68 → 20xx, 69-99 → 19xx. */
export type Century = 'pivot' | 1900 | 2000;

/** [row 0..7][col 0..14] in canonical orientation: row 0 = parity row, col 0 = parity column. */
export type Matrix = boolean[][];

export interface DocuFields {
  minute: number;
  hour: number;
  day: number;
  month: number;
  /** Full year: the two-digit year column completed by mapping.century (see fullYear). */
  year: number;
  /** Two decimal digits per serial column; an out-of-range column (> 99) shows as [value]. */
  serial: string;
}

export interface Mapping {
  /** Column numbers are 1-based (EFF numbering), between 2 and 15. */
  minute: number;
  hour: number;
  day: number;
  month: number;
  year: number;
  /** Most significant first. */
  serialColumns: number[];
  century: Century;
}

export const DEFAULT_MAPPING: Mapping = {
  minute: 2,
  hour: 5,
  day: 6,
  month: 7,
  year: 8,
  serialColumns: [14, 13, 12, 11],
  century: 'pivot',
};

export interface ParityResult {
  ok: boolean;
  /** 1-based row numbers (2..8) whose dot count has the wrong parity. */
  badRows: number[];
  /** 1-based column numbers (1..15) whose dot count has the wrong parity. */
  badCols: number[];
}

export interface DecodedColumn {
  /** 1-based column number. */
  col: number;
  field: string;
  /** Rows 2..8 top to bottom (64 first), as 0/1. */
  bits: string;
  value: number;
}

export interface Decoded {
  fields: DocuFields;
  columns: DecodedColumn[];
  parity: ParityResult;
  /** dateOk and serialOk. */
  plausible: boolean;
  /** minute < 60, hour < 24, day 1-31, month 1-12, year column <= 99. */
  dateOk: boolean;
  /** Every serial column <= 99 (two decimal digits). */
  serialOk: boolean;
  /** Why it is not plausible (empty when it is). */
  issues: string[];
  /** DEDA's maker for the value of column 4 (null when unknown or when column 4 is mapped). */
  maker: string | null;
}

export type Orientation = { rotate: 0 | 90 | 180 | 270; mirror: boolean };

export interface OrientationTry {
  /** What was applied to the given grid (mirror left-right first, then turn clockwise). */
  orientation: Orientation;
  matrix: Matrix;
  parityOk: boolean;
  plausible: boolean;
  /** Number of rows + columns failing parity. */
  parityErrors: number;
  /** Column 10 is all dots, as the EFF says it typically is (tie-breaker only). */
  separatorFull: boolean;
}

// ---------- year ----------

/** The full year of a two-digit year column value (values above 99 are not a year anyway). */
export function fullYear(yy: number, century: Century): number {
  if (century !== 'pivot') return century + yy;
  return yy >= YEAR_PIVOT && yy <= 99 ? 1900 + yy : 2000 + yy;
}

/** The years a tile can hold with this century setting. */
export function yearRange(century: Century): [number, number] {
  return century === 'pivot' ? [1900 + YEAR_PIVOT, 2000 + YEAR_PIVOT - 1] : [century, century + 99];
}

/** In words, for hints and table labels. */
export function centuryText(century: Century): string {
  return century === 'pivot'
    ? `00-${p2(YEAR_PIVOT - 1)} → 20xx, ${YEAR_PIVOT}-99 → 19xx`
    : `always ${String(century).slice(0, 2)}xx`;
}

// ---------- shape helpers ----------

function assertTile(m: boolean[][]): void {
  const widths = new Set(m.map((r) => r.length));
  if (m.length !== ROWS || widths.size !== 1 || !widths.has(COLS)) {
    const w = m[0]?.length ?? 0;
    throw new ToolError(
      `A DocuColor tile is ${ROWS} rows × ${COLS} columns; this one is ${m.length} × ${w}.`,
    );
  }
}

function assertRectangular(grid: boolean[][]): void {
  const w = grid[0]?.length ?? 0;
  if (!grid.length || !w) throw new ToolError('The dot matrix is empty.');
  grid.forEach((row, i) => {
    if (row.length !== w)
      throw new ToolError(
        `Every row needs the same number of cells (row 1 has ${w}, row ${i + 1} has ${row.length}).`,
      );
  });
}

const blankTile = (): Matrix =>
  Array.from({ length: ROWS }, () => Array<boolean>(COLS).fill(false));
const count = (cells: boolean[]) => cells.reduce((n, c) => n + (c ? 1 : 0), 0);
const columnCells = (m: boolean[][], c: number) => m.map((row) => row[c] === true);

/** Value 0-127 of a 1-based column (rows 2..8). */
export function columnValue(m: Matrix, col: number): number {
  let v = 0;
  for (let r = 1; r < ROWS; r++) if (m[r]?.[col - 1]) v += WEIGHTS[r - 1]!;
  return v;
}

function columnBits(m: Matrix, col: number): string {
  let s = '';
  for (let r = 1; r < ROWS; r++) s += m[r]?.[col - 1] ? '1' : '0';
  return s;
}

function setColumn(m: Matrix, col: number, value: number, what: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 127)
    throw new ToolError(`${what} = ${value} does not fit in a column (0-127).`);
  for (let r = 1; r < ROWS; r++) m[r]![col - 1] = (value & WEIGHTS[r - 1]!) !== 0;
}

// ---------- mapping ----------

/** Why this mapping cannot be used (a column out of range or used twice), or null. */
export function mappingProblem(mapping: Mapping): string | null {
  const seen = new Map<number, string>();
  const named: [number, string][] = [
    [mapping.minute, 'minute'],
    [mapping.hour, 'hour'],
    [mapping.day, 'day'],
    [mapping.month, 'month'],
    [mapping.year, 'year'],
    ...mapping.serialColumns.map((col, i): [number, string] => [
      col,
      `serial ${2 * i + 1}-${2 * i + 2}`,
    ]),
  ];
  for (const [col, name] of named) {
    if (!Number.isInteger(col) || col < 2 || col > COLS)
      return `The ${name} column must be a number from 2 to ${COLS} (column 1 is parity); got ${col}.`;
    const prev = seen.get(col);
    if (prev) return `Column ${col} is mapped twice: ${prev} and ${name}.`;
    seen.set(col, name);
  }
  return null;
}

/** Column -> field name for every mapped column. Throws on out-of-range or doubly used columns. */
export function mappedColumns(mapping: Mapping): Map<number, string> {
  const problem = mappingProblem(mapping);
  if (problem) throw new ToolError(problem);
  const out = new Map<number, string>();
  out.set(mapping.minute, 'minute');
  out.set(mapping.hour, 'hour');
  out.set(mapping.day, 'day');
  out.set(mapping.month, 'month');
  out.set(mapping.year, 'year');
  mapping.serialColumns.forEach((col, i) => out.set(col, `serial ${2 * i + 1}-${2 * i + 2}`));
  return out;
}

function fieldName(col: number, mapped: Map<number, string>): string {
  const name = mapped.get(col);
  if (name) return name === 'year' ? 'year (2 digits)' : name;
  if (col === 1) return 'parity';
  if (col === SEPARATOR_COLUMN) return 'separator (EFF)';
  if (col === UNKNOWN_COLUMN) return 'unknown';
  if (col === MAKER_COLUMN) return 'unused (DEDA: maker)';
  return 'unused';
}

// ---------- parity ----------

/**
 * Odd parity (default), as the EFF states it: rows 2-8 (parity column included) and all 15
 * columns (parity row included, so column 1 with the corner) must each hold an odd number of dots.
 * Row 1 is not checked (it is even in every valid tile, see the header).
 */
export function parityCheck(m: Matrix, odd = true): ParityResult {
  assertTile(m);
  const want = odd ? 1 : 0;
  const badRows: number[] = [];
  const badCols: number[] = [];
  for (let r = 1; r < ROWS; r++) if (count(m[r]!) % 2 !== want) badRows.push(r + 1);
  for (let c = 0; c < COLS; c++) if (count(columnCells(m, c)) % 2 !== want) badCols.push(c + 1);
  return { ok: !badRows.length && !badCols.length, badRows, badCols };
}

/** Set row 1 and column 1 so that the matrix passes parityCheck (corner: parity column odd). */
export function fillParity(m: Matrix, odd = true): Matrix {
  assertTile(m);
  const want = odd ? 1 : 0;
  const out = m.map((row) => [...row]);
  for (let r = 1; r < ROWS; r++) out[r]![0] = (count(out[r]!.slice(1)) + want) % 2 === 1;
  for (let c = 0; c < COLS; c++)
    out[0]![c] = (count(columnCells(out, c).slice(1)) + want) % 2 === 1;
  return out;
}

/**
 * If flipping exactly one dot makes parity pass, return where (1-based) and the fixed matrix.
 * One bad row + one bad column -> their crossing (a parity-column dot upsets its row and column
 * 1); a bad column alone -> its parity-row dot (the corner for column 1). Anything else -> null.
 */
export function singleDotFix(
  m: Matrix,
  odd = true,
): { row: number; col: number; matrix: Matrix } | null {
  const p = parityCheck(m, odd);
  if (p.ok || p.badRows.length > 1 || p.badCols.length > 1) return null;
  const row = p.badRows[0] ?? 1;
  const col = p.badCols[0] ?? 1;
  const matrix = m.map((r) => [...r]);
  matrix[row - 1]![col - 1] = !matrix[row - 1]![col - 1];
  return parityCheck(matrix, odd).ok ? { row, col, matrix } : null;
}

// ---------- decode / encode ----------

export function decodeDocuColor(
  m: Matrix,
  mapping: Mapping = DEFAULT_MAPPING,
  odd = true,
): Decoded {
  assertTile(m);
  const mapped = mappedColumns(mapping);
  const v = (col: number) => columnValue(m, col);
  const serialValues = mapping.serialColumns.map(v);
  const fields: DocuFields = {
    minute: v(mapping.minute),
    hour: v(mapping.hour),
    day: v(mapping.day),
    month: v(mapping.month),
    year: fullYear(v(mapping.year), mapping.century),
    serial: serialValues.map((x) => (x <= 99 ? p2(x) : `[${x}]`)).join(''),
  };
  const issues: string[] = [];
  if (fields.minute > 59) issues.push(`minute ${fields.minute} > 59`);
  if (fields.hour > 23) issues.push(`hour ${fields.hour} > 23`);
  if (fields.day < 1 || fields.day > 31) issues.push(`day ${fields.day} not in 1-31`);
  if (fields.month < 1 || fields.month > 12) issues.push(`month ${fields.month} not in 1-12`);
  if (v(mapping.year) > 99) issues.push(`year column ${v(mapping.year)} > 99`);
  const dateOk = !issues.length;
  serialValues.forEach((x, i) => {
    if (x > 99) issues.push(`serial column ${mapping.serialColumns[i]} = ${x} > 99`);
  });
  const columns: DecodedColumn[] = [];
  for (let col = 1; col <= COLS; col++)
    columns.push({ col, field: fieldName(col, mapped), bits: columnBits(m, col), value: v(col) });
  return {
    fields,
    columns,
    parity: parityCheck(m, odd),
    plausible: !issues.length,
    dateOk,
    serialOk: serialValues.every((x) => x <= 99),
    issues,
    maker: mapped.has(MAKER_COLUMN) ? null : (MAKERS[v(MAKER_COLUMN)] ?? null),
  };
}

/**
 * Build a tile. Every value must fit in 7 bits (0-127); serial digits are padded on the left to
 * two per serial column. `extras` sets unmapped columns (e.g. { 10: 127 } for the separator).
 */
export function encodeDocuColor(
  f: DocuFields,
  mapping: Mapping = DEFAULT_MAPPING,
  extras: Partial<Record<number, number>> = {},
  odd = true,
): Matrix {
  const mapped = mappedColumns(mapping);
  const m = blankTile();
  setColumn(m, mapping.minute, f.minute, 'minute');
  setColumn(m, mapping.hour, f.hour, 'hour');
  setColumn(m, mapping.day, f.day, 'day');
  setColumn(m, mapping.month, f.month, 'month');
  const [first, last] = yearRange(mapping.century);
  if (!Number.isInteger(f.year) || f.year < first || f.year > last)
    throw new ToolError(
      `The year column holds two digits: with the century set to ${centuryText(mapping.century)} the year must be ${first}-${last}; got ${f.year}.`,
    );
  setColumn(m, mapping.year, f.year % 100, 'year');
  const digits = f.serial.replace(/[\s-]/g, '');
  if (!/^\d*$/.test(digits))
    throw new ToolError(`The serial number must be decimal digits; got "${f.serial}".`);
  const width = 2 * mapping.serialColumns.length;
  if (digits.length > width)
    throw new ToolError(
      `The serial has ${digits.length} digits but ${mapping.serialColumns.length} serial columns hold at most ${width}.`,
    );
  const padded = digits.padStart(width, '0');
  mapping.serialColumns.forEach((col, i) =>
    setColumn(m, col, Number(padded.slice(2 * i, 2 * i + 2)), `serial column ${col}`),
  );
  for (const [key, value] of Object.entries(extras)) {
    const col = Number(key);
    if (value === undefined) continue;
    if (!Number.isInteger(col) || col < 2 || col > COLS)
      throw new ToolError(`Extra column ${key} must be a number from 2 to ${COLS}.`);
    const used = mapped.get(col);
    if (used) throw new ToolError(`Column ${col} already holds the ${used}.`);
    setColumn(m, col, value, `column ${col}`);
  }
  return fillParity(m, odd);
}

// ---------- orientation ----------

/** Mirror false first, turns in clockwise order: the order ties are broken in. */
export const ORIENTATIONS: readonly Orientation[] = [false, true].flatMap((mirror) =>
  ([0, 90, 180, 270] as const).map((rotate) => ({ rotate, mirror })),
);

function rotateCw(m: boolean[][]): boolean[][] {
  const h = m.length;
  const w = m[0]?.length ?? 0;
  return Array.from({ length: w }, (_, i) =>
    Array.from({ length: h }, (_, j) => m[h - 1 - j]?.[i] === true),
  );
}

/** Mirror left-right (if asked), then turn clockwise by `rotate` degrees. */
export function orient(m: boolean[][], o: Orientation): boolean[][] {
  let out = o.mirror ? m.map((row) => [...row].reverse()) : m.map((row) => [...row]);
  for (let k = 0; k < o.rotate / 90; k++) out = rotateCw(out);
  return out;
}

/** The orientation that undoes `o`: orient(orient(m, o), inverseOrientation(o)) equals m. */
export function inverseOrientation(o: Orientation): Orientation {
  // A mirror followed by a turn is an involution; a plain turn is undone by the opposite turn.
  if (o.mirror) return o;
  return { rotate: ((360 - o.rotate) % 360) as Orientation['rotate'], mirror: false };
}

export function orientationKey(o: Orientation): string {
  return `${o.mirror ? 'm' : 'r'}${o.rotate}`;
}

export function describeOrientation(o: Orientation): string {
  const turn =
    o.rotate === 0
      ? ''
      : o.rotate === 180
        ? 'turned 180°'
        : o.rotate === 90
          ? 'turned 90° clockwise'
          : 'turned 90° counter-clockwise';
  if (!o.mirror) return turn || 'as given';
  if (o.rotate === 180) return 'mirrored left-right, then turned 180° (flipped top-bottom)';
  return turn ? `mirrored left-right, then ${turn}` : 'mirrored left-right';
}

/**
 * Try every orientation that turns `grid` (8 × 15, or 15 × 8 if the tile was read sideways) into
 * an 8 × 15 tile — 4 of the 8, since the tile is not square — best first: parity OK, then
 * plausible values, then column 10 full, then fewest parity errors, then ORIENTATIONS order.
 */
export function bestOrientations(
  grid: boolean[][],
  mapping: Mapping = DEFAULT_MAPPING,
  odd = true,
): OrientationTry[] {
  assertRectangular(grid);
  const h = grid.length;
  const w = grid[0]!.length;
  if (!((h === ROWS && w === COLS) || (h === COLS && w === ROWS)))
    throw new ToolError(
      `A DocuColor tile is ${ROWS} rows × ${COLS} columns (or ${COLS} × ${ROWS} if read sideways); this grid is ${h} × ${w}.`,
    );
  const separatorMapped = mappedColumns(mapping).has(SEPARATOR_COLUMN);
  const tries: (OrientationTry & { order: number })[] = [];
  ORIENTATIONS.forEach((orientation, order) => {
    const matrix = orient(grid, orientation);
    if (matrix.length !== ROWS) return;
    const d = decodeDocuColor(matrix, mapping, odd);
    tries.push({
      orientation,
      matrix,
      parityOk: d.parity.ok,
      plausible: d.plausible,
      parityErrors: d.parity.badRows.length + d.parity.badCols.length,
      separatorFull: !separatorMapped && columnValue(matrix, SEPARATOR_COLUMN) === 127,
      order,
    });
  });
  const rank = (t: OrientationTry) =>
    (t.parityOk ? 4 : 0) + (t.plausible ? 2 : 0) + (t.separatorFull ? 1 : 0);
  tries.sort((a, b) => rank(b) - rank(a) || a.parityErrors - b.parityErrors || a.order - b.order);
  return tries.map(({ order: _order, ...t }) => t);
}

// ---------- text ----------

const ON = new Set([...'1xX●•*#oO■█']);
const OFF = new Set([...'0.·-_○□']);
const IGNORED = /[\s,;|[\]]/g;

/**
 * Rows of cells, one per line: 1/0, x/., ●/·, o/. (also * # ■ for a dot, - _ ○ for none).
 * Spaces, commas, | and brackets between cells are ignored, so "1 0 1" and "[1,0,1]" work.
 */
export function parseMatrixText(s: string): boolean[][] {
  const rows: boolean[][] = [];
  s.split(/\r?\n/).forEach((line, i) => {
    const cells = [...line.replace(IGNORED, '')];
    if (!cells.length) return;
    rows.push(
      cells.map((ch) => {
        if (ON.has(ch)) return true;
        if (OFF.has(ch)) return false;
        throw new ToolError(
          `Line ${i + 1}: "${ch}" is not a cell (use 1, x, ● or o for a dot and 0, . or · for none).`,
        );
      }),
    );
  });
  assertRectangular(rows);
  return rows;
}

/** One line per row, ● for a dot and · for none, cells separated by a space. */
export function matrixToText(m: boolean[][]): string {
  return m.map((row) => row.map((c) => (c ? '●' : '·')).join(' ')).join('\n');
}

// ---------- picture ----------

export interface RenderOptions {
  /** Pixels per cell. */
  cell?: number;
  /** Faint cell guides and a tinted parity row/column. */
  guides?: boolean;
  /** Dot colour (RGB). */
  color?: [number, number, number];
}

/** One tile as yellow dots on white, enlarged, with a one-cell margin. */
export function renderMatrix(m: boolean[][], opts: RenderOptions = {}): RgbaImage {
  const cell = Math.max(4, Math.round(opts.cell ?? 16));
  const guides = opts.guides ?? true;
  const [cr, cg, cb] = opts.color ?? [255, 214, 0];
  const rows = m.length;
  const cols = m[0]?.length ?? 0;
  const width = (cols + 2) * cell;
  const height = (rows + 2) * cell;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  const put = (x: number, y: number, r: number, g: number, b: number) => {
    const i = (y * width + x) * 4;
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
  };
  const radius = cell * 0.32;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x0 = (c + 1) * cell;
      const y0 = (r + 1) * cell;
      const parity = r === 0 || c === 0;
      for (let y = 0; y < cell; y++) {
        for (let x = 0; x < cell; x++) {
          const dx = x + 0.5 - cell / 2;
          const dy = y + 0.5 - cell / 2;
          if (m[r]?.[c] && dx * dx + dy * dy <= radius * radius) put(x0 + x, y0 + y, cr, cg, cb);
          else if (guides && (x === 0 || y === 0)) put(x0 + x, y0 + y, 225, 228, 235);
          else if (guides && parity) put(x0 + x, y0 + y, 242, 245, 252);
        }
      }
    }
  }
  return { width, height, data };
}
