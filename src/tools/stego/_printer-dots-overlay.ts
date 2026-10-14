/**
 * Printer tracking dots, step 3: the picture that shows the fit (pure, no DOM).
 *
 * The revealed channel of a view rectangle, zoomed (nearest neighbour), with the fitted grid
 * drawn on top: cell borders (bright inside the tile window, faint elsewhere), a green ring on
 * every cell read as a dot, a small orange mark on every cell read as empty, the parity row and
 * column tinted blue, any row or column that fails parity tinted red, and the tile's row and
 * column numbers (in tile orientation) next to the window.
 */
import type { RgbaImage } from '../../core/types';
import { poolPreview, type Rect } from './_channel';
import { OUTSIDE, type CellGrid, type Lattice } from './_printer-dots-grid';

export interface OverlayWindow {
  /** Grid position of the top-left cell, and size in cells (as seen in the image). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Window lines (rows by y, columns by x, 0-based inside the window) to tint. */
  parityRows: number[];
  parityCols: number[];
  badRows: number[];
  badCols: number[];
}

/** A number to draw centred on an image point. */
export interface OverlayLabel {
  x: number;
  y: number;
  text: string;
}

/** What the picture shows: lut[source[i]] for every region pixel (rect.w × rect.h). */
export interface Display {
  source: Uint8Array | Uint16Array;
  lut: Uint8Array;
  /** Dots come out bright (else dark): which pixel a reduced picture keeps. */
  dotsBright: boolean;
}

export interface OverlayInput {
  display: Display;
  rect: Rect;
  /** Part of the region to draw (image coordinates, inside `rect`). */
  view: Rect;
  zoom: number;
  lattice: Lattice | null;
  grid: CellGrid | null;
  window: OverlayWindow | null;
  labels?: OverlayLabel[];
}

/** Output pixel budget of the overlay. */
export const OVERLAY_MAX_SIDE = 2048;

type Rgb = readonly [number, number, number];
const WINDOW_LINE: Rgb = [0, 210, 255];
const FAINT_LINE: Rgb = [120, 120, 150];
const DOT_RING: Rgb = [40, 230, 90];
const EMPTY_MARK: Rgb = [255, 150, 0];
const PARITY_TINT: Rgb = [70, 130, 255];
const BAD_TINT: Rgb = [255, 50, 50];

/** Largest zoom (1..16) that keeps the view under the side budget, aiming at `cellPx` per cell. */
export function autoZoom(view: Rect, pitch: number, cellPx = 24): number {
  let z = Math.max(1, Math.min(16, Math.round(cellPx / Math.max(1, pitch))));
  while (z > 1 && Math.max(view.w, view.h) * z > OVERLAY_MAX_SIDE) z--;
  return z;
}

export function renderOverlay(o: OverlayInput): RgbaImage {
  const { view, rect, zoom: z, lattice: l, grid, window: win } = o;
  const { source, lut } = o.display;
  const W = view.w * z;
  const H = view.h * z;
  const data = new Uint8ClampedArray(W * H * 4);
  const det = l ? l.ax * l.by - l.bx * l.ay : 1;
  const px = l ? Math.hypot(l.ax, l.ay) * z : 1; // output pixels per cell, both directions
  const py = l ? Math.hypot(l.bx, l.by) * z : 1;
  const showFaint = Math.min(px, py) >= 6;
  const ringR = 0.38 * Math.min(px, py);
  const markR = Math.max(1, 0.08 * Math.min(px, py));
  const sets = win && {
    parityRows: new Set(win.parityRows),
    parityCols: new Set(win.parityCols),
    badRows: new Set(win.badRows),
    badCols: new Set(win.badCols),
  };
  let o4 = 0;
  for (let Y = 0; Y < H; Y++) {
    const fy = view.y + (Y + 0.5) / z;
    const sy = Math.min(rect.h - 1, Math.floor(fy) - rect.y);
    for (let X = 0; X < W; X++, o4 += 4) {
      const fx = view.x + (X + 0.5) / z;
      const sx = Math.min(rect.w - 1, Math.floor(fx) - rect.x);
      const g = lut[source[sy * rect.w + sx]!]!;
      let r = g;
      let gg = g;
      let b = g;
      if (l && grid) {
        const dx = fx - l.ox;
        const dy = fy - l.oy;
        const ci = (dx * l.by - dy * l.bx) / det;
        const cj = (dy * l.ax - dx * l.ay) / det;
        const i = Math.round(ci);
        const j = Math.round(cj);
        const di = ci - i;
        const dj = cj - j;
        const gx = i - grid.i0;
        const gy = j - grid.j0;
        const cell =
          gx >= 0 && gy >= 0 && gx < grid.w && gy < grid.h
            ? grid.cells[gy * grid.w + gx]!
            : OUTSIDE;
        const wx = win ? gx - win.x : -1;
        const wy = win ? gy - win.y : -1;
        const inWin = !!win && wx >= 0 && wy >= 0 && wx < win.w && wy < win.h;
        // At most a tint, then a mark: two blends, applied in that order.
        let tint: Rgb | null = null;
        if (inWin && sets) {
          if (sets.badRows.has(wy) || sets.badCols.has(wx)) tint = BAD_TINT;
          else if (sets.parityRows.has(wy) || sets.parityCols.has(wx)) tint = PARITY_TINT;
        }
        if (tint) {
          r += (tint[0] - r) * 0.5;
          gg += (tint[1] - gg) * 0.5;
          b += (tint[2] - b) * 0.5;
        }
        const edge = Math.min((0.5 - Math.abs(di)) * px, (0.5 - Math.abs(dj)) * py);
        const rr = Math.hypot(di * px, dj * py);
        let mark: Rgb | null = null;
        let alpha = 1;
        if (edge < 1) {
          if (inWin) mark = WINDOW_LINE;
          else if (showFaint && cell !== OUTSIDE) [mark, alpha] = [FAINT_LINE, 0.45];
        } else if (cell === 1 && Math.abs(rr - ringR) <= 1) {
          [mark, alpha] = [DOT_RING, inWin ? 1 : 0.55];
        } else if (cell === 0 && rr <= markR) {
          [mark, alpha] = [EMPTY_MARK, inWin ? 1 : 0.5];
        }
        if (mark) {
          r += (mark[0] - r) * alpha;
          gg += (mark[1] - gg) * alpha;
          b += (mark[2] - b) * alpha;
        }
      }
      data[o4] = r;
      data[o4 + 1] = gg;
      data[o4 + 2] = b;
      data[o4 + 3] = 255;
    }
  }
  const image = { width: W, height: H, data };
  const cell = l ? Math.min(px, py) : 0;
  for (const lab of o.labels ?? [])
    drawText(image, (lab.x - view.x) * z, (lab.y - view.y) * z, lab.text, cell);
  return image;
}

// ---------- numbers ----------

/** 3 × 5 digits, one row of 3 bits per string. */
const DIGITS: Record<string, readonly string[]> = {
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '001', '001', '001'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
};

/** White digits with a dark outline, centred on (cx, cy), sized to fit a cell of `cell` px. */
function drawText(img: RgbaImage, cx: number, cy: number, text: string, cell: number): void {
  const s = Math.max(1, Math.min(4, Math.floor(cell / 11)));
  const glyphs = [...text].map((ch) => DIGITS[ch]).filter((g): g is readonly string[] => !!g);
  if (!glyphs.length || cell < 8) return;
  const tw = (glyphs.length * 4 - 1) * s;
  const th = 5 * s;
  const x0 = Math.round(cx - tw / 2);
  const y0 = Math.round(cy - th / 2);
  const on = (gx: number, gy: number) => {
    const k = Math.floor(gx / (4 * s));
    const lx = Math.floor((gx - k * 4 * s) / s);
    const ly = Math.floor(gy / s);
    return lx < 3 && ly >= 0 && ly < 5 && glyphs[k]?.[ly]?.[lx] === '1';
  };
  const put = (x: number, y: number, v: number) => {
    if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
    const i = (y * img.width + x) * 4;
    img.data[i] = v;
    img.data[i + 1] = v;
    img.data[i + 2] = v;
  };
  // Outline first (every pixel next to a lit one), then the digits.
  for (let gy = -1; gy <= th; gy++)
    for (let gx = -1; gx <= tw; gx++) {
      if (on(gx, gy)) continue;
      let near = false;
      for (let dy = -1; dy <= 1 && !near; dy++)
        for (let dx = -1; dx <= 1 && !near; dx++)
          near = gx + dx >= 0 && gy + dy >= 0 && on(gx + dx, gy + dy);
      if (near) put(x0 + gx, y0 + gy, 0);
    }
  for (let gy = 0; gy < th; gy++)
    for (let gx = 0; gx < tw; gx++) if (on(gx, gy)) put(x0 + gx, y0 + gy, 255);
}

/**
 * The region shrunk by an integer factor, keeping the most dot-like pixel of each block (the
 * brightest, or the darkest when the dots are dark), so isolated dots survive the reduction.
 */
export function poolLevel(display: Display, rect: Rect, maxSide: number): RgbaImage {
  return poolPreview(display.source, display.lut, rect.w, rect.h, maxSide, display.dotsBright)
    .image;
}
