import { ToolError } from '../../core/errors';
import { toolT } from '../../i18n/tool-text';
import { makeRng } from './_classical';
import { FITNESS_SCALE, quadTable } from './_fitness';

/**
 * Transposition engine shared by the columnar transposition and ADFGX / ADFGVX tools (not a
 * tool itself): column keys, the permutations of columnar, Myszkowski, route and scytale
 * ciphers, and the ciphertext-only solver for a single columnar transposition.
 *
 * A permutation `perm` lists, for every position k of the ciphertext, the index in the
 * plaintext (written row by row) of the cell that ends up there.
 */

/** Key errors are reported through the columnar tool's messages. */
const T = toolT('columnar');

// ------------------------------------------------------------------------------- keys

export interface ColumnKey {
  /** One symbol per column, as typed (letters and digits upper-cased, or the numbers). */
  symbols: string[];
  /** 1-based rank of each column among the distinct symbols (equal symbols share a rank). */
  groupRank: number[];
  /** 1-based rank of each column, ties broken left to right (all different). */
  rank: number[];
  /** The columns in reading order (ties left to right): `order[i]` is read i-th. */
  order: number[];
  numeric: boolean;
}

const NUMERIC_KEY = /^\d+(?:[\s,;.-]+\d+)*$/;
const MAX_KEY = 256;

function buildKey(symbols: string[], numeric: boolean): ColumnKey {
  const cmp = numeric
    ? (a: string, b: string) => Number(a) - Number(b)
    : (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const order = symbols.map((_, i) => i).sort((a, b) => cmp(symbols[a]!, symbols[b]!) || a - b);
  const rank = new Array<number>(symbols.length);
  order.forEach((col, i) => {
    rank[col] = i + 1;
  });
  const distinct: string[] = [];
  for (const col of order) {
    const s = symbols[col]!;
    if (!distinct.length || cmp(distinct[distinct.length - 1]!, s) !== 0) distinct.push(s);
  }
  const groupRank = symbols.map((s) => distinct.findIndex((d) => cmp(d, s) === 0) + 1);
  return { symbols, groupRank, rank, order, numeric };
}

/**
 * A column key written as a word (letters and digits, A before B, ties left to right) or as
 * the reading order of the columns: "3 1 4 2", or "3142" for single digits.
 */
export function parseColumnKey(raw: string): ColumnKey {
  const s = raw.trim();
  if (!s) throw new ToolError(T('error.noKey'));
  let symbols: string[];
  let numeric = false;
  if (NUMERIC_KEY.test(s)) {
    const tokens = s.split(/[\s,;.-]+/);
    symbols = tokens.length === 1 ? [...tokens[0]!] : tokens;
    numeric = true;
  } else {
    symbols = [
      ...s
        .normalize('NFD')
        .replace(/[^A-Za-z0-9]/g, '')
        .toUpperCase(),
    ];
  }
  if (!symbols.length) throw new ToolError(T('error.keyChars'));
  if (symbols.length > MAX_KEY) throw new ToolError(T('error.keyLong', { max: MAX_KEY }));
  return buildKey(symbols, numeric);
}

/** The key 1 2 3 … n: columns read left to right. */
export function identityKey(n: number): ColumnKey {
  return buildKey(
    Array.from({ length: n }, (_, i) => String(i + 1)),
    true,
  );
}

/** A key written back as text: the word, or the numbers separated by spaces. */
export const keyText = (key: ColumnKey): string => key.symbols.join(key.numeric ? ' ' : '');

/** Key from a reading order (order[i] = column read i-th): "3 1 4 2" style, spaced above 9. */
export function orderToDigits(order: readonly number[]): string {
  const rank = new Array<number>(order.length);
  order.forEach((col, i) => {
    rank[col] = i + 1;
  });
  return rank.join(order.length > 9 ? ' ' : '');
}

/** The same key as a word of distinct letters (A first), while it fits in the alphabet. */
export function orderToLetters(order: readonly number[]): string | null {
  if (order.length > 26) return null;
  const rank = new Array<number>(order.length);
  order.forEach((col, i) => {
    rank[col] = i;
  });
  return rank.map((r) => String.fromCharCode(65 + r)).join('');
}

// -------------------------------------------------------------------- permutations

/**
 * Columnar transposition on `length` cells written row by row under the key: the columns are
 * read top to bottom in key order (an incomplete last row simply has fewer cells). With
 * `myszkowski`, columns that share a key symbol are read together, row by row.
 */
export function columnarPermutation(
  length: number,
  key: ColumnKey,
  myszkowski = false,
): Uint32Array {
  const width = key.symbols.length;
  const perm = new Uint32Array(length);
  let k = 0;
  if (!myszkowski) {
    for (const col of key.order) for (let i = col; i < length; i += width) perm[k++] = i;
    return perm;
  }
  const groups = new Map<number, number[]>();
  key.groupRank.forEach((g, col) => {
    const list = groups.get(g);
    if (list) list.push(col);
    else groups.set(g, [col]);
  });
  for (const g of [...groups.keys()].sort((a, b) => a - b)) {
    const cols = groups.get(g)!;
    for (let row = 0; row * width < length; row++) {
      for (const col of cols) {
        const i = row * width + col;
        if (i < length) perm[k++] = i;
      }
    }
  }
  return perm;
}

/** Encrypt direction: out[k] = cells[perm[k]]. */
export function permute<T>(cells: readonly T[], perm: ArrayLike<number>): T[] {
  return Array.from({ length: cells.length }, (_, k) => cells[perm[k]!]!);
}

/** Decrypt direction: out[perm[k]] = cells[k]. */
export function unpermute<T>(cells: readonly T[], perm: ArrayLike<number>): T[] {
  const out = new Array<T>(cells.length);
  for (let k = 0; k < cells.length; k++) out[perm[k]!] = cells[k]!;
  return out;
}

/** Rows of a grid with `width` columns, for display (first `maxRows` only). */
export function gridRows(
  cells: readonly string[],
  width: number,
  maxRows: number,
): { rows: string[][]; total: number } {
  const total = Math.ceil(cells.length / width);
  const rows: string[][] = [];
  for (let r = 0; r < Math.min(total, maxRows); r++) {
    rows.push(cells.slice(r * width, r * width + width));
  }
  return { rows, total };
}

// --------------------------------------------------------------------------- routes

export type RouteFamily = 'spiral' | 'snake-rows' | 'snake-columns' | 'rows' | 'columns';
export type Corner = 'tl' | 'tr' | 'bl' | 'br';

export interface Route {
  family: RouteFamily;
  /** Where the path starts (spiral outward: where it ends). */
  corner: Corner;
  /** Spirals: sense of rotation along the path. */
  clockwise: boolean;
  /** Spirals: start at the centre and end on the corner. */
  outward: boolean;
}

export const ROUTE_FAMILIES: readonly RouteFamily[] = [
  'spiral',
  'snake-rows',
  'snake-columns',
  'rows',
  'columns',
];
export const CORNERS: readonly Corner[] = ['tl', 'tr', 'bl', 'br'];

/** Cells of a rows × width grid in the order the spiral visits them, from a corner inward. */
function spiralInward(rows: number, width: number, corner: Corner, clockwise: boolean): number[] {
  const seen = new Uint8Array(rows * width);
  let r = corner[0] === 'b' ? rows - 1 : 0;
  let c = corner[1] === 'r' ? width - 1 : 0;
  // First direction: along the nearest edge in the chosen sense of rotation.
  const start: Record<Corner, [number, number]> = clockwise
    ? { tl: [0, 1], tr: [1, 0], br: [0, -1], bl: [-1, 0] }
    : { tl: [1, 0], bl: [0, 1], br: [-1, 0], tr: [0, -1] };
  let [dr, dc] = start[corner];
  const out: number[] = [];
  const free = (rr: number, cc: number) =>
    rr >= 0 && rr < rows && cc >= 0 && cc < width && !seen[rr * width + cc];
  for (;;) {
    seen[r * width + c] = 1;
    out.push(r * width + c);
    if (out.length === rows * width) break;
    if (!free(r + dr, c + dc)) {
      [dr, dc] = clockwise ? [dc, -dr] : [-dc, dr];
      if (!free(r + dr, c + dc)) break;
    }
    r += dr;
    c += dc;
  }
  return out;
}

/** Cell indices (row-major, rows × width) in the order a route reads them. */
function routeOrder(rows: number, width: number, route: Route): number[] {
  const { family, corner } = route;
  const fromBottom = corner[0] === 'b';
  const fromRight = corner[1] === 'r';
  const rowSeq = Array.from({ length: rows }, (_, i) => (fromBottom ? rows - 1 - i : i));
  const colSeq = Array.from({ length: width }, (_, i) => (fromRight ? width - 1 - i : i));
  const out: number[] = [];
  switch (family) {
    case 'spiral': {
      // Reading from the centre outward is the inward path walked backwards, which turns the
      // other way round.
      if (!route.outward) return spiralInward(rows, width, corner, route.clockwise);
      return spiralInward(rows, width, corner, !route.clockwise).reverse();
    }
    case 'rows':
      for (const r of rowSeq) for (const c of colSeq) out.push(r * width + c);
      return out;
    case 'columns':
      for (const c of colSeq) for (const r of rowSeq) out.push(r * width + c);
      return out;
    case 'snake-rows':
      rowSeq.forEach((r, i) => {
        const cs = i % 2 === 0 ? colSeq : [...colSeq].reverse();
        for (const c of cs) out.push(r * width + c);
      });
      return out;
    case 'snake-columns':
      colSeq.forEach((c, i) => {
        const rs = i % 2 === 0 ? rowSeq : [...rowSeq].reverse();
        for (const r of rs) out.push(r * width + c);
      });
      return out;
  }
}

/**
 * Route transposition: the plaintext is written row by row into a grid `width` columns wide
 * and read off along the route. A last row with fewer cells just has those cells skipped.
 */
export function routePermutation(length: number, width: number, route: Route): Uint32Array {
  const rows = Math.ceil(length / width);
  const order = routeOrder(rows, width, route).filter((i) => i < length);
  return Uint32Array.from(order);
}

/** Every route the brute-force mode tries (the plain row-by-row reading is left out). */
export function allRoutes(): Route[] {
  const routes: Route[] = [];
  for (const corner of CORNERS) {
    for (const clockwise of [true, false]) {
      for (const outward of [false, true]) {
        routes.push({ family: 'spiral', corner, clockwise, outward });
      }
    }
    for (const family of ['snake-rows', 'snake-columns', 'rows', 'columns'] as const) {
      if (family === 'rows' && corner === 'tl') continue;
      routes.push({ family, corner, clockwise: true, outward: false });
    }
  }
  return routes;
}

// -------------------------------------------------------------------------- scoring

/** Letters of the cells as 0..25, everything else -1 (skipped when scoring). */
export function cellCodes(cells: readonly string[]): Int8Array {
  const out = new Int8Array(cells.length);
  cells.forEach((cell, i) => {
    const c = cell.length === 1 ? cell.charCodeAt(0) | 0x20 : 0;
    out[i] = c >= 97 && c <= 122 ? c - 97 : -1;
  });
  return out;
}

/** Sum of scaled quadgram log-probabilities over the letters (non-letters are skipped). */
function scoreCodes(buf: Int8Array, n: number, table: Int16Array): number {
  let sum = 0;
  let a = -1;
  let b = -1;
  let c = -1;
  for (let i = 0; i < n; i++) {
    const d = buf[i]!;
    if (d < 0) continue;
    if (a >= 0) sum += table[((a * 26 + b) * 26 + c) * 26 + d]!;
    a = b;
    b = c;
    c = d;
  }
  return sum;
}

// --------------------------------------------------------------------------- solver

export interface ColumnarCandidate {
  /** Key length (number of columns). */
  length: number;
  /** Reading order: `order[i]` is the column (0-based) read i-th. */
  order: number[];
  /** Average log10 probability per quadgram of the decrypted letters. */
  fitness: number;
  plain: string;
}

export interface ColumnarSolution {
  /** Best first, a few per key length. */
  candidates: ColumnarCandidate[];
  /** Letters the score is based on. */
  letters: number;
  /** Longest key length searched completely (0 when none). */
  reached: number;
  stopped: 'budget' | 'time' | null;
  /** Key lengths above the exhaustive limit are searched by hill climbing. */
  climbed: boolean;
}

export interface SolveOptions {
  minLength?: number;
  maxLength?: number;
  /** Work in cell operations (deterministic). */
  budget?: number;
  /** Hard stop in milliseconds, a backstop for slow machines. */
  timeLimit?: number;
  /** Candidates kept for each key length (8: the shifted look-alikes of an incomplete grid). */
  perLength?: number;
}

/** Key lengths up to this are searched exhaustively (9! = 362 880 orders). */
export const EXHAUSTIVE_MAX = 9;
const SAMPLE_ROWS = 24;
const SHORTLIST = 64;

interface Scored {
  score: number;
  order: Uint8Array;
}

/** The best few (score, order) pairs seen. */
class Shortlist {
  readonly items: Scored[] = [];
  constructor(private readonly size: number) {}
  offer(score: number, order: Uint8Array): void {
    const items = this.items;
    if (items.length >= this.size && score <= items[items.length - 1]!.score) return;
    let i = items.length;
    while (i > 0 && items[i - 1]!.score < score) i--;
    items.splice(i, 0, { score, order: order.slice() });
    if (items.length > this.size) items.pop();
  }
  get worst(): number {
    return this.items.length < this.size ? -Infinity : this.items[this.items.length - 1]!.score;
  }
}

/** Decrypts the first rows of a K-column grid under a reading order and scores them. */
function makeSampler(codes: Int8Array, width: number, table: Int16Array) {
  const total = codes.length;
  const rows = Math.floor(total / width);
  const extra = total - rows * width;
  const sample = Math.min(rows, SAMPLE_ROWS);
  const buf = new Int8Array(sample * width);
  return {
    cost: sample * width * 2,
    score(order: ArrayLike<number>): number {
      let off = 0;
      for (let i = 0; i < width; i++) {
        const col = order[i]!;
        for (let r = 0; r < sample; r++) buf[r * width + col] = codes[off + r]!;
        off += col < extra ? rows + 1 : rows;
      }
      return scoreCodes(buf, sample * width, table);
    },
  };
}

/** Whole-text decryption under a reading order: the plaintext cells. */
function decryptCells(cells: readonly string[], width: number, order: ArrayLike<number>): string[] {
  const total = cells.length;
  const rows = Math.floor(total / width);
  const extra = total - rows * width;
  const out = new Array<string>(total);
  let off = 0;
  for (let i = 0; i < width; i++) {
    const col = order[i]!;
    const len = col < extra ? rows + 1 : rows;
    for (let r = 0; r < len; r++) out[r * width + col] = cells[off + r]!;
    off += len;
  }
  return out;
}

function nextPermutation(a: Uint8Array): boolean {
  let i = a.length - 2;
  while (i >= 0 && a[i]! >= a[i + 1]!) i--;
  if (i < 0) return false;
  let j = a.length - 1;
  while (a[j]! <= a[i]!) j--;
  const t = a[i]!;
  a[i] = a[j]!;
  a[j] = t;
  for (let l = i + 1, r = a.length - 1; l < r; l++, r--) {
    const x = a[l]!;
    a[l] = a[r]!;
    a[r] = x;
  }
  return true;
}

/**
 * Ciphertext-only attack on a single columnar transposition (rows written, columns read in key
 * order) of English text. Key lengths up to 9 are searched exhaustively: every reading order
 * is scored on the first rows of the decrypted grid (quadgram log-probabilities), and the best
 * few are re-scored on the whole text. Longer keys use seeded hill climbing. The work is
 * bounded by a budget of cell operations, so the outcome never depends on the machine.
 */
export function solveColumnar(
  cells: readonly string[],
  options: SolveOptions = {},
): ColumnarSolution {
  const codes = cellCodes(cells);
  let letters = 0;
  for (const c of codes) if (c >= 0) letters++;
  const table = quadTable();
  const minLength = Math.max(2, options.minLength ?? 2);
  const maxLength = Math.min(options.maxLength ?? EXHAUSTIVE_MAX, Math.floor(cells.length / 2));
  const budget = options.budget ?? 900_000_000;
  const perLength = options.perLength ?? 8;
  const deadline = Date.now() + (options.timeLimit ?? 20_000);
  const found: ColumnarCandidate[] = [];
  let spent = 0;
  let reached = 0;
  let stopped: ColumnarSolution['stopped'] = null;
  let climbed = false;

  const finish = (width: number, list: Shortlist) => {
    const best: ColumnarCandidate[] = [];
    for (const { order } of list.items) {
      const plainCells = decryptCells(cells, width, order);
      const plainCodes = cellCodes(plainCells);
      const fitness = scoreCodes(plainCodes, plainCodes.length, table) / FITNESS_SCALE;
      best.push({
        length: width,
        order: Array.from(order),
        fitness: letters > 3 ? fitness / (letters - 3) : -Infinity,
        plain: plainCells.join(''),
      });
    }
    best.sort((x, y) => y.fitness - x.fitness);
    found.push(...best.slice(0, perLength));
  };

  for (let width = minLength; width <= maxLength; width++) {
    const sampler = makeSampler(codes, width, table);
    const list = new Shortlist(SHORTLIST);
    if (width <= EXHAUSTIVE_MAX) {
      let count = 1;
      for (let i = 2; i <= width; i++) count *= i;
      if (spent + count * sampler.cost > budget) {
        stopped = 'budget';
        break;
      }
      const order = Uint8Array.from({ length: width }, (_, i) => i);
      let n = 0;
      do {
        const s = sampler.score(order);
        if (s > list.worst) list.offer(s, order);
        if ((++n & 4095) === 0 && Date.now() > deadline) {
          stopped = 'time';
          break;
        }
      } while (nextPermutation(order));
      spent += n * sampler.cost;
      if (stopped) break;
    } else {
      climbed = true;
      const share = Math.max(0, Math.min(budget - spent, 240_000_000));
      if (share < sampler.cost * 2000) {
        stopped = 'budget';
        break;
      }
      const used = climb(width, sampler, list, share, deadline, 0x7ab1e + width);
      spent += used;
      if (Date.now() > deadline) {
        stopped = 'time';
        finish(width, list);
        break;
      }
    }
    finish(width, list);
    reached = width;
  }
  found.sort((x, y) => y.fitness - x.fitness || x.length - y.length);
  return { candidates: found, letters, reached, stopped, climbed };
}

/** Iterated hill climbing over reading orders of one key length; returns the work done. */
function climb(
  width: number,
  sampler: { cost: number; score(order: ArrayLike<number>): number },
  list: Shortlist,
  budget: number,
  deadline: number,
  seed: number,
): number {
  const rng = makeRng(seed);
  const limit = Math.floor(budget / sampler.cost);
  let evals = 0;
  const identity = () => Uint8Array.from({ length: width }, (_, i) => i);
  const shuffle = (a: Uint8Array) => {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = a[i]!;
      a[i] = a[j]!;
      a[j] = t;
    }
    return a;
  };
  const tmp = new Uint8Array(width);

  /** Swaps and single-column moves until no neighbour is better. */
  function polish(order: Uint8Array): number {
    let best = sampler.score(order);
    evals++;
    let improved = true;
    while (improved && evals < limit) {
      improved = false;
      for (let i = 0; i < width - 1 && evals < limit; i++) {
        for (let j = i + 1; j < width && evals < limit; j++) {
          const t = order[i]!;
          order[i] = order[j]!;
          order[j] = t;
          const s = sampler.score(order);
          evals++;
          if (s > best) {
            best = s;
            improved = true;
          } else {
            order[j] = order[i]!;
            order[i] = t;
          }
        }
      }
      for (let i = 0; i < width && evals < limit; i++) {
        for (let j = 0; j < width && evals < limit; j++) {
          if (i === j) continue;
          tmp.set(order);
          const moved = tmp[i]!;
          if (i < j) tmp.copyWithin(i, i + 1, j + 1);
          else tmp.copyWithin(j + 1, j, i);
          tmp[j] = moved;
          const s = sampler.score(tmp);
          evals++;
          if (s > best) {
            best = s;
            order.set(tmp);
            improved = true;
          }
        }
      }
    }
    return best;
  }

  let bestOrder = shuffle(identity());
  let bestScore = polish(bestOrder);
  list.offer(bestScore, bestOrder);
  let stagnation = 0;
  while (evals < limit) {
    if ((evals & 1023) === 0 && Date.now() > deadline) break;
    let cand: Uint8Array;
    if (stagnation > 0 && stagnation % 40 === 0) {
      cand = shuffle(identity());
    } else {
      cand = bestOrder.slice();
      const kicks = 2 + Math.floor(rng() * 3);
      for (let k = 0; k < kicks; k++) {
        const i = Math.floor(rng() * width);
        const j = Math.floor(rng() * width);
        const t = cand[i]!;
        cand[i] = cand[j]!;
        cand[j] = t;
      }
    }
    const s = polish(cand);
    list.offer(s, cand);
    if (s > bestScore) {
      bestScore = s;
      bestOrder = cand;
      stagnation = 0;
    } else {
      stagnation++;
    }
    if (stagnation >= 500) break;
  }
  return evals * sampler.cost;
}
