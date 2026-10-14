/**
 * Printer tracking dots, step 2: from dot centres to a cell grid, then to a tile (pure, no DOM).
 *
 * 1. Rotation and pitch from nearest-neighbour vectors: the nearest dot is usually the next cell,
 *    so the median nearest-neighbour distance is the pitch; the angles of the near-pitch vectors,
 *    taken four times (so 0°, 90°, 180° and 270° agree), average to the grid rotation.
 * 2. A least-squares affine fit (origin + two cell steps), grown outwards from the central dot so
 *    that integer cell indices stay right over the whole region; dots off the grid are ignored.
 * 3. Every cell centre of the region is sampled: dot or empty.
 * 4. A window of the tile's shape is slid over the cell grid, in the 8 orientations; a window
 *    "passes" when every column and every row but the parity row has the parity the DocuColor
 *    format asks for (EFF; see _docucolor.ts). Line counts come from prefix sums, so the full
 *    search is cheap.
 */
import { median as medianOrZero } from '../audio/_dsp';
import { ORIENTATIONS, orient, type Orientation } from './_docucolor';
import type { Rect } from './_channel';

export interface Point {
  x: number;
  y: number;
}

/** Cell (i, j) has its centre at origin + i·a + j·b (image pixels). i runs along the grid rows. */
export interface Lattice {
  ox: number;
  oy: number;
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

export interface LatticeParams {
  pitchX: number;
  pitchY: number;
  /** Degrees, clockwise on screen (image y points down). */
  rotation: number;
}

const DEG = Math.PI / 180;

export function latticeFrom(p: LatticeParams, ox: number, oy: number): Lattice {
  const c = Math.cos(p.rotation * DEG);
  const s = Math.sin(p.rotation * DEG);
  return { ox, oy, ax: p.pitchX * c, ay: p.pitchX * s, bx: -p.pitchY * s, by: p.pitchY * c };
}

export function latticeParams(l: Lattice): LatticeParams {
  return {
    pitchX: Math.hypot(l.ax, l.ay),
    pitchY: Math.hypot(l.bx, l.by),
    rotation: Math.atan2(l.ay, l.ax) / DEG,
  };
}

export function cellCenter(l: Lattice, i: number, j: number): Point {
  return { x: l.ox + i * l.ax + j * l.bx, y: l.oy + i * l.ay + j * l.by };
}

/** Fractional cell coordinates of an image point. */
export function toCell(l: Lattice, x: number, y: number): { i: number; j: number } {
  const det = l.ax * l.by - l.bx * l.ay;
  const dx = x - l.ox;
  const dy = y - l.oy;
  return { i: (dx * l.by - dy * l.bx) / det, j: (dy * l.ax - dx * l.ay) / det };
}

/** The same grid with cell (i, j) as its new (0, 0). */
export function shiftLattice(l: Lattice, i: number, j: number): Lattice {
  const c = cellCenter(l, i, j);
  return { ...l, ox: c.x, oy: c.y };
}

// ---------- nearest neighbours ----------

/**
 * For each point (or each of `queries`, indices into points), its up-to-k nearest other points
 * (indices, nearest first).
 */
export function nearestNeighbours(points: Point[], k: number, queries?: number[]): number[][] {
  const n = points.length;
  const asked = queries ?? points.map((_, i) => i);
  if (n < 2) return asked.map(() => []);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const area = Math.max(1, (maxX - minX + 1) * (maxY - minY + 1));
  const size = Math.max(2, 1.5 * Math.sqrt(area / n));
  const nx = Math.floor((maxX - minX) / size) + 1;
  const ny = Math.floor((maxY - minY) / size) + 1;
  const bucketOf = (p: Point) =>
    Math.floor((p.y - minY) / size) * nx + Math.floor((p.x - minX) / size);
  // Counting sort of the points into buckets.
  const counts = new Int32Array(nx * ny + 1);
  for (const p of points) counts[bucketOf(p) + 1]!++;
  for (let b = 0; b < nx * ny; b++) counts[b + 1]! += counts[b]!;
  const order = new Int32Array(n);
  const fill = counts.slice(0, nx * ny);
  points.forEach((p, idx) => (order[fill[bucketOf(p)]!++] = idx));

  return asked.map((idx) => {
    const p = points[idx]!;
    const bx = Math.floor((p.x - minX) / size);
    const by = Math.floor((p.y - minY) / size);
    const best: { d: number; q: number }[] = [];
    // Two rings of buckets: at least 3 mean spacings around the point.
    for (let y = Math.max(0, by - 2); y <= Math.min(ny - 1, by + 2); y++) {
      for (let x = Math.max(0, bx - 2); x <= Math.min(nx - 1, bx + 2); x++) {
        const b = y * nx + x;
        for (let t = counts[b]!; t < counts[b + 1]!; t++) {
          const q = order[t]!;
          if (q === idx) continue;
          const d = (points[q]!.x - p.x) ** 2 + (points[q]!.y - p.y) ** 2;
          if (best.length < k || d < best[best.length - 1]!.d) {
            best.push({ d, q });
            best.sort((u, v) => u.d - v.d);
            if (best.length > k) best.pop();
          }
        }
      }
    }
    return best.map((b) => b.q);
  });
}

const median = (xs: number[]): number => (xs.length ? medianOrZero(xs) : NaN);

export interface BasisEstimate extends LatticeParams {
  /** Median nearest-neighbour distance (px). */
  nnPitch: number;
  /** Neighbour vectors used for the rotation. */
  vectors: number;
}

/** Neighbour lists measured at most (spread evenly over the dots): medians need no more. */
const MAX_QUERIES = 4000;

/** Rotation and pitch from the dots alone; null when there is too little to measure. */
export function estimateBasis(points: Point[]): BasisEstimate | null {
  if (points.length < 4) return null;
  const stride = Math.max(1, Math.ceil(points.length / MAX_QUERIES));
  const queries: number[] = [];
  for (let i = 0; i < points.length; i += stride) queries.push(i);
  const lists = nearestNeighbours(points, 6, queries);
  const d1: number[] = [];
  lists.forEach((list, qi) => {
    const i = queries[qi]!;
    const q = list[0];
    if (q === undefined) return;
    const d = Math.hypot(points[q]!.x - points[i]!.x, points[q]!.y - points[i]!.y);
    if (d > 0.5) d1.push(d);
  });
  const nnPitch = median(d1);
  if (!(nnPitch > 1)) return null;
  const vx: number[] = [];
  const vy: number[] = [];
  let sc = 0;
  let ss = 0;
  lists.forEach((list, qi) => {
    const i = queries[qi]!;
    for (const q of list) {
      const dx = points[q]!.x - points[i]!.x;
      const dy = points[q]!.y - points[i]!.y;
      const d = Math.hypot(dx, dy);
      // Axis neighbours only: diagonals (√2 × pitch) would point 45° off and cancel out.
      if (d < 0.75 * nnPitch || d > 1.25 * nnPitch) continue;
      const a = 4 * Math.atan2(dy, dx);
      sc += Math.cos(a);
      ss += Math.sin(a);
      vx.push(dx);
      vy.push(dy);
    }
  });
  if (vx.length < 3) return null;
  const theta = Math.atan2(ss, sc) / 4;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const along: number[] = [];
  const across: number[] = [];
  vx.forEach((dx, k) => {
    const dy = vy[k]!;
    const u = dx * c + dy * s;
    const w = -dx * s + dy * c;
    if (Math.abs(u) >= Math.abs(w)) along.push(Math.abs(u));
    else across.push(Math.abs(w));
  });
  const px = median(along);
  const py = median(across);
  return {
    rotation: theta / DEG,
    pitchX: Number.isFinite(px) ? px : py,
    pitchY: Number.isFinite(py) ? py : px,
    nnPitch,
    vectors: vx.length,
  };
}

// ---------- fitting ----------

export interface FitResult {
  lattice: Lattice;
  /** Dots within 0.3 cell of a cell centre. */
  inliers: number;
  /** Root-mean-square distance of the inliers to their cell centre, in cells. */
  rms: number;
}

const MAX_RESIDUAL = 0.3;

function residuals(l: Lattice, pts: Point[]) {
  return pts.map((p) => {
    const c = toCell(l, p.x, p.y);
    const i = Math.round(c.i);
    const j = Math.round(c.j);
    return { p, i, j, ri: c.i - i, rj: c.j - j };
  });
}

/** Least-squares x = ox + i·ax + j·bx (same for y); null if the indices are degenerate. */
function solveAffine(rows: { p: Point; i: number; j: number }[]): Lattice | null {
  let n = 0;
  let si = 0;
  let sj = 0;
  let sii = 0;
  let sij = 0;
  let sjj = 0;
  let sx = 0;
  let six = 0;
  let sjx = 0;
  let sy = 0;
  let siy = 0;
  let sjy = 0;
  for (const { p, i, j } of rows) {
    n++;
    si += i;
    sj += j;
    sii += i * i;
    sij += i * j;
    sjj += j * j;
    sx += p.x;
    six += i * p.x;
    sjx += j * p.x;
    sy += p.y;
    siy += i * p.y;
    sjy += j * p.y;
  }
  // Symmetric 3 × 3 system [n si sj; si sii sij; sj sij sjj] · [o a b] = rhs, by Cramer's rule.
  const m = [n, si, sj, si, sii, sij, sj, sij, sjj] as const;
  const det3 = (q: readonly number[]) =>
    q[0]! * (q[4]! * q[8]! - q[5]! * q[7]!) -
    q[1]! * (q[3]! * q[8]! - q[5]! * q[6]!) +
    q[2]! * (q[3]! * q[7]! - q[4]! * q[6]!);
  const det = det3(m);
  if (!(Math.abs(det) > 1e-9 * Math.max(1, n) ** 3)) return null;
  const solve = (r0: number, r1: number, r2: number) => {
    const col = (k: number) => {
      const q = [...m];
      q[k] = r0;
      q[k + 3] = r1;
      q[k + 6] = r2;
      return det3(q) / det;
    };
    return [col(0), col(1), col(2)] as const;
  };
  const [ox, ax, bx] = solve(sx, six, sjx);
  const [oy, ay, by] = solve(sy, siy, sjy);
  return { ox, oy, ax, ay, bx, by };
}

function score(l: Lattice, pts: Point[]): { inliers: number; rms: number } {
  let inliers = 0;
  let sq = 0;
  for (const r of residuals(l, pts)) {
    if (Math.abs(r.ri) < MAX_RESIDUAL && Math.abs(r.rj) < MAX_RESIDUAL) {
      inliers++;
      sq += r.ri * r.ri + r.rj * r.rj;
    }
  }
  return { inliers, rms: inliers ? Math.sqrt(sq / inliers) : 1 };
}

/**
 * Refine `init`. With `fitBasis`, the full affine grid is fitted, starting with the dots near the
 * central one and growing the radius, so the integer indices never slip. Without it, only the
 * phase (where the cell centres fall) is fitted, by a circular mean, and the steps stay as given.
 */
export function fitLattice(points: Point[], init: Lattice, fitBasis: boolean): FitResult {
  if (!points.length) return { lattice: init, inliers: 0, rms: 1 };
  // Seed: the dot closest to the centroid of all dots.
  let cx = 0;
  let cy = 0;
  for (const p of points) {
    cx += p.x;
    cy += p.y;
  }
  cx /= points.length;
  cy /= points.length;
  let seed = points[0]!;
  let bestD = Infinity;
  for (const p of points) {
    const d = (p.x - cx) ** 2 + (p.y - cy) ** 2;
    if (d < bestD) {
      bestD = d;
      seed = p;
    }
  }
  let l: Lattice = { ...init, ox: seed.x, oy: seed.y };

  const phase = (pts: Point[]) => {
    for (let pass = 0; pass < 3; pass++) {
      let ci = 0;
      let si = 0;
      let cj = 0;
      let sj = 0;
      for (const r of residuals(l, pts)) {
        ci += Math.cos(2 * Math.PI * r.ri);
        si += Math.sin(2 * Math.PI * r.ri);
        cj += Math.cos(2 * Math.PI * r.rj);
        sj += Math.sin(2 * Math.PI * r.rj);
      }
      const di = Math.atan2(si, ci) / (2 * Math.PI);
      const dj = Math.atan2(sj, cj) / (2 * Math.PI);
      l = { ...l, ox: l.ox + di * l.ax + dj * l.bx, oy: l.oy + di * l.ay + dj * l.by };
    }
  };

  if (!fitBasis) {
    phase(points);
    return { lattice: l, ...score(l, points) };
  }

  const step = Math.max(Math.hypot(l.ax, l.ay), Math.hypot(l.bx, l.by));
  let maxD = 0;
  for (const p of points) maxD = Math.max(maxD, Math.hypot(p.x - seed.x, p.y - seed.y));
  let radius = 6 * step;
  const p0 = latticeParams(init);
  for (let iter = 0, finals = 0; iter < 40 && finals < 3; iter++) {
    const r2 = radius * radius;
    const near = points.filter((p) => (p.x - seed.x) ** 2 + (p.y - seed.y) ** 2 <= r2);
    const kept = residuals(l, near).filter(
      (r) => Math.abs(r.ri) < MAX_RESIDUAL && Math.abs(r.rj) < MAX_RESIDUAL,
    );
    const fit = kept.length >= 6 ? solveAffine(kept) : null;
    if (fit) {
      const q = latticeParams(fit);
      const sane =
        q.pitchX > 0.6 * p0.pitchX &&
        q.pitchX < 1.6 * p0.pitchX &&
        q.pitchY > 0.6 * p0.pitchY &&
        q.pitchY < 1.6 * p0.pitchY &&
        Math.abs(fit.ax * fit.by - fit.bx * fit.ay) > 0.5 * q.pitchX * q.pitchY;
      if (sane) l = fit;
    } else if (kept.length) {
      phase(near);
    }
    if (radius >= maxD) finals++;
    else radius *= 1.6;
  }
  // Put cell (0, 0) on the cell nearest the seed, so the numbers stay small.
  const c = toCell(l, seed.x, seed.y);
  l = shiftLattice(l, Math.round(c.i), Math.round(c.j));
  return { lattice: l, ...score(l, points) };
}

// ---------- cell grid ----------

export const OUTSIDE = 2;

export interface CellGrid {
  /** Lattice cell index of grid cell (0, 0). */
  i0: number;
  j0: number;
  w: number;
  h: number;
  /** 0 = empty, 1 = dot, OUTSIDE = centre outside the region; row-major (j, then i). */
  cells: Uint8Array;
}

/** Cells whose centre falls in `rect` (others are OUTSIDE), each sampled with `isDot`. */
export function sampleGrid(
  l: Lattice,
  rect: Rect,
  isDot: (x: number, y: number) => boolean,
  maxCells: number,
): CellGrid | null {
  const corners = [
    toCell(l, rect.x, rect.y),
    toCell(l, rect.x + rect.w, rect.y),
    toCell(l, rect.x, rect.y + rect.h),
    toCell(l, rect.x + rect.w, rect.y + rect.h),
  ];
  const i0 = Math.floor(Math.min(...corners.map((c) => c.i)));
  const i1 = Math.ceil(Math.max(...corners.map((c) => c.i)));
  const j0 = Math.floor(Math.min(...corners.map((c) => c.j)));
  const j1 = Math.ceil(Math.max(...corners.map((c) => c.j)));
  const w = i1 - i0 + 1;
  const h = j1 - j0 + 1;
  if (w * h > maxCells) return null;
  const cells = new Uint8Array(w * h);
  for (let gy = 0; gy < h; gy++) {
    for (let gx = 0; gx < w; gx++) {
      const p = cellCenter(l, i0 + gx, j0 + gy);
      const inside =
        p.x >= rect.x && p.y >= rect.y && p.x < rect.x + rect.w && p.y < rect.y + rect.h;
      cells[gy * w + gx] = !inside ? OUTSIDE : isDot(p.x, p.y) ? 1 : 0;
    }
  }
  return { i0, j0, w, h, cells };
}

// ---------- tile windows ----------

/** A line of the window: a row (index = y) or a column (index = x). */
interface Line {
  col: boolean;
  index: number;
}

export interface OrientedShape {
  orientation: Orientation;
  /** Window size in the image grid. */
  h: number;
  w: number;
  /** Canonical tile row r (0 = parity row) lies on this window line. */
  rowLine: Line[];
  /** Canonical tile column c (0 = parity column) lies on this window line. */
  colLine: Line[];
}

const shapeCache = new Map<string, OrientedShape[]>();

/** For each of the 8 orientations: the window shape and where each tile row / column lands. */
export function shapesFor(rows: number, cols: number): OrientedShape[] {
  const key = `${rows}x${cols}`;
  const cached = shapeCache.get(key);
  if (cached) return cached;
  const shapes = ORIENTATIONS.map((orientation) => {
    const turned = orientation.rotate % 180 !== 0;
    const h = turned ? cols : rows;
    const w = turned ? rows : cols;
    // Where each window cell lands in the tile: orient the bit planes of the cell numbers
    // (orient moves booleans, so a cell number goes through one plane per bit).
    const index: number[][] = Array.from({ length: rows }, () => Array<number>(cols).fill(0));
    for (let bit = 0; 1 << bit < h * w; bit++) {
      const plane = Array.from({ length: h }, (_, y) =>
        Array.from({ length: w }, (_, x) => (((y * w + x) >> bit) & 1) === 1),
      );
      orient(plane, orientation).forEach((row, r) =>
        row.forEach((v, c) => {
          if (v) index[r]![c]! |= 1 << bit;
        }),
      );
    }
    const where = index.map((row) => row.map((n) => ({ y: Math.floor(n / w), x: n % w })));
    const lineOf = (cells: { y: number; x: number }[]): Line =>
      cells.every((c) => c.y === cells[0]!.y)
        ? { col: false, index: cells[0]!.y }
        : { col: true, index: cells[0]!.x };
    return {
      orientation,
      h,
      w,
      rowLine: where.map((row) => lineOf(row)),
      colLine: Array.from({ length: cols }, (_, c) => lineOf(where.map((row) => row[c]!))),
    };
  });
  shapeCache.set(key, shapes);
  return shapes;
}

export interface WindowHit {
  /** Index into the shapes (= ORIENTATIONS order). */
  shape: number;
  /** Grid position of the window's top-left cell. */
  x: number;
  y: number;
  /** Rows 2.. and columns (all, the parity column included) with the wrong parity. */
  errors: number;
  dots: number;
}

export interface SearchResult {
  /** Windows where every data row and column passes (capped at MAX_HITS). */
  passing: WindowHit[];
  /**
   * Near misses: the failing windows with at most max(fewest errors, 2) errors, fewest first
   * (capped). Two is what one misread data dot costs (its row and its column), so the true tile
   * is in here when a single dot is wrong, even if another window happens to have fewer errors.
   */
  closest: WindowHit[];
  /** Per orientation: its lowest-error window (null when no window of that shape fits). */
  perShape: (WindowHit | null)[];
  /** Windows examined (position × window size). */
  examined: number;
  /** Windows left out because they hold some dots but too few to be a tile. */
  sparse: number;
  truncated: boolean;
}

export const MAX_HITS = 4096;
const MAX_CLOSE = 2048;

/** A shape's parity lines as flat index lists: which counts to read, at which indices. */
interface Plan {
  rowsOnCols: boolean;
  /** Canonical rows 2.. (the parity row is not checked). */
  rows: Int32Array;
  colsOnCols: boolean;
  /** Every canonical column, the parity column included. */
  cols: Int32Array;
}

function planOf(s: OrientedShape): Plan {
  const rows = s.rowLine.slice(1);
  return {
    rowsOnCols: rows[0]?.col ?? false,
    rows: Int32Array.from(rows.map((l) => l.index)),
    colsOnCols: s.colLine[0]?.col ?? true,
    cols: Int32Array.from(s.colLine.map((l) => l.index)),
  };
}

/**
 * Slide every allowed shape over the grid (or only at `at`, a fixed top-left cell), in one pass.
 * A window is skipped when a cell lies outside the region, and when it holds fewer dots than a
 * tile can (one per column minus one: with odd parity every column holds at least one dot). With
 * odd parity, every column and every row but the parity row must hold an odd number of dots; with
 * even parity, an even one.
 */
export function searchWindows(
  grid: CellGrid,
  shapes: OrientedShape[],
  allowed: boolean[],
  odd: boolean,
  at?: { x: number; y: number },
): SearchResult {
  const { w: gw, h: gh, cells } = grid;
  const want = odd ? 1 : 0;
  // Prefix sums: dots along each row / column, and outside cells in 2-D.
  const rowPre = new Int32Array(gh * (gw + 1));
  const colPre = new Int32Array(gw * (gh + 1));
  const outPre = new Int32Array((gh + 1) * (gw + 1));
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const v = cells[y * gw + x]!;
      const dot = v === 1 ? 1 : 0;
      rowPre[y * (gw + 1) + x + 1] = rowPre[y * (gw + 1) + x]! + dot;
      colPre[x * (gh + 1) + y + 1] = colPre[x * (gh + 1) + y]! + dot;
      outPre[(y + 1) * (gw + 1) + x + 1] =
        outPre[y * (gw + 1) + x + 1]! +
        outPre[(y + 1) * (gw + 1) + x]! -
        outPre[y * (gw + 1) + x]! +
        (v === OUTSIDE ? 1 : 0);
    }
  }
  const outsideIn = (x: number, y: number, w: number, h: number) =>
    outPre[(y + h) * (gw + 1) + x + w]! -
    outPre[y * (gw + 1) + x + w]! -
    outPre[(y + h) * (gw + 1) + x]! +
    outPre[y * (gw + 1) + x]!;

  const rows = shapes[0]!.rowLine.length;
  const cols = shapes[0]!.colLine.length;
  const minDots = Math.max(rows, cols) - 1;
  const plans = shapes.map(planOf);
  const perShape: (WindowHit | null)[] = shapes.map(() => null);
  const bestErrors = shapes.map(() => Infinity);
  const passing: WindowHit[] = [];
  // Near misses: every failing window with at most 2 errors, plus, while nothing that close has
  // been seen, the windows at the lowest error count so far.
  const near: WindowHit[] = [];
  let above: WindowHit[] = [];
  let aboveMin = Infinity;
  let truncated = false;
  let examined = 0;
  let sparse = 0;

  // Shapes sharing a window size share the line counts.
  const sizes = [...new Set(shapes.map((s) => `${s.h}x${s.w}`))];
  for (const size of sizes) {
    const group = shapes
      .map((s, k) => ({ s, k }))
      .filter(({ s, k }) => allowed[k] && `${s.h}x${s.w}` === size);
    if (!group.length) continue;
    const { h, w } = group[0]!.s;
    const rowCnt = new Int32Array(h);
    const colCnt = new Int32Array(w);
    const y0 = at ? at.y : 0;
    const y1 = at ? at.y : gh - h;
    const x0 = at ? at.x : 0;
    const x1 = at ? at.x : gw - w;
    for (let y = Math.max(0, y0); y <= y1; y++) {
      for (let x = Math.max(0, x0); x <= x1; x++) {
        if (x + w > gw || y + h > gh) continue;
        if (outsideIn(x, y, w, h) > 0) continue;
        examined++;
        let total = 0;
        for (let r = 0; r < h; r++) {
          const base = (y + r) * (gw + 1);
          const c = rowPre[base + x + w]! - rowPre[base + x]!;
          rowCnt[r] = c;
          total += c;
        }
        if (total === 0) continue;
        if (total < minDots) {
          sparse++;
          continue;
        }
        for (let c = 0; c < w; c++) {
          const base = (x + c) * (gh + 1);
          colCnt[c] = colPre[base + y + h]! - colPre[base + y]!;
        }
        for (const { k } of group) {
          const plan = plans[k]!;
          const pr = plan.rowsOnCols ? colCnt : rowCnt;
          const pc = plan.colsOnCols ? colCnt : rowCnt;
          let errors = 0;
          for (let i = 0; i < plan.rows.length; i++)
            if ((pr[plan.rows[i]!]! & 1) !== want) errors++;
          for (let i = 0; i < plan.cols.length; i++)
            if ((pc[plan.cols[i]!]! & 1) !== want) errors++;
          const better = errors < bestErrors[k]!;
          if (errors === 0) {
            const hit: WindowHit = { shape: k, x, y, errors, dots: total };
            if (better) {
              bestErrors[k] = 0;
              perShape[k] = hit;
            }
            if (passing.length < MAX_HITS) passing.push(hit);
            else truncated = true;
            continue;
          }
          if (!better && errors > 2 && errors > aboveMin) continue;
          const hit: WindowHit = { shape: k, x, y, errors, dots: total };
          if (better) {
            bestErrors[k] = errors;
            perShape[k] = hit;
          }
          if (errors <= 2) {
            if (near.length < MAX_CLOSE) near.push(hit);
          } else if (errors < aboveMin) {
            aboveMin = errors;
            above = [hit];
          } else if (errors === aboveMin && above.length < MAX_CLOSE) above.push(hit);
        }
      }
    }
  }
  const closest = near.length ? near : above;
  closest.sort((a, b) => a.errors - b.errors);
  return { passing, closest, perShape, examined, sparse, truncated };
}

/** The window's cells as booleans (OUTSIDE reads as empty). */
export function windowCells(
  grid: CellGrid,
  x: number,
  y: number,
  h: number,
  w: number,
): boolean[][] {
  return Array.from({ length: h }, (_, r) =>
    Array.from({ length: w }, (_, c) => grid.cells[(y + r) * grid.w + x + c] === 1),
  );
}

/**
 * Other places where the same window pattern appears: identical, or within `maxDiff` cells
 * (a copy with a misprinted or misread dot). Windows touching the region edge are skipped.
 */
export function countCopies(
  grid: CellGrid,
  pattern: boolean[][],
  maxDiff: number,
): { exact: number; near: number } {
  const h = pattern.length;
  const w = pattern[0]?.length ?? 0;
  const flat = pattern.flat();
  let exact = 0;
  let near = 0;
  for (let y = 0; y + h <= grid.h; y++) {
    for (let x = 0; x + w <= grid.w; x++) {
      let diff = 0;
      for (let r = 0; r < h && diff <= maxDiff; r++) {
        const base = (y + r) * grid.w + x;
        for (let c = 0; c < w; c++) {
          const v = grid.cells[base + c]!;
          if (v === OUTSIDE) {
            diff = maxDiff + 1;
            break;
          }
          if ((v === 1) !== flat[r * w + c]) diff++;
        }
      }
      if (diff === 0) exact++;
      else if (diff <= maxDiff) near++;
    }
  }
  return { exact, near };
}
