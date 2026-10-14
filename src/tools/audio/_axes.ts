/**
 * Axes of a spectrogram picture: tick positions, labels and a tiny bitmap font to draw them,
 * so the PNG shows time and frequency whatever the sample rate. No DOM, no canvas.
 */
import type { RgbaImage } from '../../core/types';

export interface Tick {
  value: number;
  label: string;
}

// ---------- tick values ----------

/** A 1-2-5 step giving at most `count` ticks over `span`. */
export function niceStep(span: number, count: number): number {
  const rough = span / Math.max(1, count);
  const pow = 10 ** Math.floor(Math.log10(rough));
  for (const m of [1, 2, 5, 10]) if (m * pow >= rough) return m * pow;
  return 10 * pow;
}

/** Trim trailing zeros of a fixed-point number: 1.50 -> 1.5, 2.00 -> 2. */
const trim = (n: number, digits: number): string => String(Number(n.toFixed(digits)));

/** "500Hz", "1.5kHz", "11kHz": kHz from 1 kHz up, with just enough decimals for the step. */
export function formatFrequency(hz: number, step: number): string {
  if (hz < 1000 || step < 10) {
    const digits = step >= 1 ? 0 : Math.min(3, Math.ceil(-Math.log10(step)));
    return `${trim(hz, digits)}Hz`;
  }
  const digits = step % 1000 === 0 ? 0 : step % 100 === 0 ? 1 : 2;
  return `${trim(hz / 1000, digits)}kHz`;
}

/** Ticks of a linear frequency axis between `min` and `max` Hz. */
export function linearFrequencyTicks(min: number, max: number, count: number): Tick[] {
  const step = niceStep(max - min, count);
  const out: Tick[] = [];
  for (let k = Math.ceil(min / step - 1e-9); k * step <= max + step * 1e-9; k++) {
    const value = Number((k * step).toPrecision(12));
    out.push({ value, label: formatFrequency(value, step) });
  }
  return out;
}

/** Ticks of a logarithmic frequency axis: 1, 2, 5 x 10^n, thinned so labels never touch. */
export function logFrequencyTicks(min: number, max: number, heightPx: number, gapPx = 26): Tick[] {
  const span = Math.log(max / min);
  const candidates: { value: number; rank: number }[] = [];
  for (let e = Math.floor(Math.log10(min)); 10 ** e <= max; e++) {
    for (const [m, rank] of [
      [1, 0],
      [5, 1],
      [2, 2],
    ] as const) {
      const value = m * 10 ** e;
      if (value >= min * (1 - 1e-9) && value <= max * (1 + 1e-9)) candidates.push({ value, rank });
    }
  }
  const y = (v: number) => (Math.log(v / min) / span) * heightPx;
  const kept: number[] = [];
  for (const c of candidates.sort((a, b) => a.rank - b.rank || a.value - b.value)) {
    if (kept.every((v) => Math.abs(y(v) - y(c.value)) >= gapPx)) kept.push(c.value);
  }
  return kept
    .sort((a, b) => a - b)
    .map((value) => ({ value, label: formatFrequency(value, value >= 1000 ? 100 : 1) }));
}

const TIME_STEPS = [
  0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900,
  1800, 3600, 7200, 14400, 43200, 86400,
];

/** "1.5s" below a minute, "m:ss" from a minute up, "h:mm:ss" from an hour up. */
export function formatTime(seconds: number, step: number, longRange = seconds >= 60): string {
  const digits = step >= 1 ? 0 : Math.min(3, Math.ceil(-Math.log10(step) - 1e-9));
  if (!longRange) return `${trim(seconds, digits)}s`;
  const whole = Math.floor(seconds + 1e-9);
  const frac = digits
    ? `.${Math.round((seconds - whole) * 10 ** digits)
        .toString()
        .padStart(digits, '0')}`
    : '';
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}${frac}` : `${m}:${ss}${frac}`;
}

/** Ticks of the time axis from `t0` to `t1` seconds, at most `count` of them. */
export function timeTicks(t0: number, t1: number, count: number): Tick[] {
  const span = t1 - t0;
  if (!(span > 0)) return [];
  const step = TIME_STEPS.find((s) => span / s <= count) ?? niceStep(span, count);
  const long = t1 >= 60 && step >= 1;
  const out: Tick[] = [];
  for (let k = Math.ceil(t0 / step - 1e-9); k * step <= t1 + step * 1e-9; k++) {
    const value = Number((k * step).toPrecision(12));
    out.push({ value, label: formatTime(value, step, long) });
  }
  return out;
}

// ---------- picture geometry ----------

/** What the axes need to know about the picture they surround. */
export interface AxesSpec {
  /** Picture size of the plot itself, in pixels (one row per frequency sample). */
  width: number;
  height: number;
  /** Image pixels per time column (short files are stretched). */
  columnWidth: number;
  /** Seconds between two columns, and the time of the centre of the first one. */
  hopSeconds: number;
  t0: number;
  t1: number;
  fMin: number;
  fMax: number;
  scale: 'linear' | 'log';
}

/** Pixels around the plot and the size of the label font, which grows with the picture. */
export interface AxesLayout {
  /** Size of one font pixel: the picture is shown scaled to the page width, so labels of a wide
   * picture must be bigger to stay readable. */
  scale: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Margins wide enough for "12.5kHz" and "1:30:00" at the label scale chosen for the width. */
export function axesLayout(plotWidth: number, scale?: number): AxesLayout {
  const s = scale ?? Math.max(2, Math.min(6, Math.round((plotWidth + 124) / 390)));
  return { scale: s, left: 48 * s, right: 14 * s, top: 6 * s, bottom: 15 * s };
}

/** Where the plot sits in a finished picture of `width` x `height` pixels (inverse of drawAxes). */
export function plotRect(width: number, height: number) {
  for (let s = 2; s <= 6; s++) {
    const l = axesLayout(0, s);
    const w = width - l.left - l.right;
    if (w > 0 && axesLayout(w).scale === s) {
      return { x: l.left, y: l.top, width: w, height: height - l.top - l.bottom, scale: s };
    }
  }
  throw new Error(`Not a picture drawn by drawAxes: ${width}x${height}`);
}

/** Horizontal pixel (from the left edge of the plot) of time `t`: column centres are exact. */
export const timeToX = (a: AxesSpec, t: number): number =>
  ((t - a.t0) / a.hopSeconds + 0.5) * a.columnWidth;

/** Vertical pixel (from the top edge of the plot) of the centre of the row showing `hz`. */
export function frequencyToY(a: AxesSpec, hz: number): number {
  const u =
    a.scale === 'log'
      ? Math.log(hz / a.fMin) / Math.log(a.fMax / a.fMin)
      : (hz - a.fMin) / (a.fMax - a.fMin);
  return a.height - 1 - u * (a.height - 1) + 0.5;
}

// ---------- bitmap font ----------

const GLYPHS: Record<string, readonly string[]> = {
  '0': ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  '3': ['.###.', '#...#', '....#', '..##.', '....#', '#...#', '.###.'],
  '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  '6': ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
  '7': ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  '9': ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
  '.': ['.....', '.....', '.....', '.....', '.....', '.##..', '.##..'],
  ':': ['.....', '.##..', '.##..', '.....', '.##..', '.##..', '.....'],
  k: ['#....', '#....', '#..#.', '#.#..', '##...', '#.#..', '#..#.'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  z: ['.....', '.....', '#####', '...#.', '..#..', '.#...', '#####'],
  s: ['.....', '.....', '.####', '#....', '.###.', '....#', '####.'],
};

/** Width in pixels of `text` drawn by drawText at font scale `scale`. */
export const textWidth = (text: string, scale: number): number => text.length * 6 * scale - scale;

type Rgb = readonly [number, number, number];

function fillRect(img: RgbaImage, x: number, y: number, w: number, h: number, c: Rgb) {
  for (let yy = Math.max(0, y); yy < Math.min(img.height, y + h); yy++) {
    for (let xx = Math.max(0, x); xx < Math.min(img.width, x + w); xx++) {
      const o = (yy * img.width + xx) * 4;
      img.data[o] = c[0];
      img.data[o + 1] = c[1];
      img.data[o + 2] = c[2];
      img.data[o + 3] = 255;
    }
  }
}

function drawText(img: RgbaImage, text: string, x: number, y: number, scale: number, c: Rgb) {
  let cx = x;
  for (const ch of text) {
    const glyph = GLYPHS[ch];
    if (glyph) {
      glyph.forEach((line, gy) => {
        for (let gx = 0; gx < 5; gx++) {
          if (line[gx] === '#') fillRect(img, cx + gx * scale, y + gy * scale, scale, scale, c);
        }
      });
    }
    cx += 6 * scale;
  }
}

const BACKGROUND: Rgb = [17, 22, 32];
const INK: Rgb = [208, 216, 228];

/** Surround `plot` with a frequency axis (left) and a time axis (bottom). */
export function drawAxes(plot: RgbaImage, a: AxesSpec): RgbaImage {
  const { scale, left, right, top, bottom } = axesLayout(plot.width);
  const tick = Math.round(2.5 * scale); // length of a tick mark
  const thin = Math.max(1, scale >> 1); // its thickness
  const width = plot.width + left + right;
  const height = plot.height + top + bottom;
  const img: RgbaImage = { width, height, data: new Uint8ClampedArray(width * height * 4) };
  fillRect(img, 0, 0, width, height, BACKGROUND);
  for (let y = 0; y < plot.height; y++) {
    const src = y * plot.width * 4;
    img.data.set(plot.data.subarray(src, src + plot.width * 4), ((y + top) * width + left) * 4);
  }
  const labelHeight = 7 * scale;

  const freqs =
    a.scale === 'log'
      ? logFrequencyTicks(a.fMin, a.fMax, plot.height)
      : linearFrequencyTicks(a.fMin, a.fMax, Math.max(2, Math.floor(plot.height / (22 * scale))));
  for (const t of freqs) {
    const y = top + Math.round(frequencyToY(a, t.value) - 0.5);
    fillRect(img, left - tick, y - (thin >> 1), tick, thin, INK);
    drawText(
      img,
      t.label,
      left - tick - 2 * scale - textWidth(t.label, scale),
      y - Math.floor(labelHeight / 2),
      scale,
      INK,
    );
  }

  const times = timeTicks(
    a.t0,
    Math.min(a.t1, a.t0 + (plot.width / a.columnWidth - 0.5) * a.hopSeconds),
    Math.max(2, Math.floor(plot.width / (42 * scale))),
  );
  for (const t of times) {
    const x = left + Math.round(timeToX(a, t.value) - 0.5);
    if (x < left || x >= left + plot.width) continue;
    fillRect(img, x - (thin >> 1), top + plot.height, thin, tick, INK);
    const w = textWidth(t.label, scale);
    const labelX = Math.max(2, Math.min(width - w - 2, x - Math.floor(w / 2)));
    drawText(img, t.label, labelX, top + plot.height + tick + Math.round(1.5 * scale), scale, INK);
  }
  return img;
}
