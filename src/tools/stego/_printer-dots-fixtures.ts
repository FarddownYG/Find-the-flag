/**
 * Synthetic scans for the printer-dots tests (tests only: nothing here is imported by a tool).
 * Every page is drawn from a tile this code encodes: no real scan, no real printer, no real
 * serial number, no real challenge.
 */
import type { RgbaImage } from '../../core/types';
import type { DocuFields, Matrix } from './_docucolor';

/** mulberry32: seeded floats in [0, 1), so every "random" case is reproducible. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Stroke {
  x: number;
  y: number;
  w: number;
  h: number;
  grey: number;
}

type Rgb = [number, number, number];

export interface ScanSpec {
  width: number;
  height: number;
  /** Cell (c, r) of the page frame is centred on origin + (c · pitch, r · pitchY)... */
  pitch: number;
  /** Row pitch when it differs (a scanner that stretches one axis). */
  pitchY?: number;
  origin: [number, number];
  /** ...then the page is turned clockwise by `rotation` degrees around the picture centre. */
  rotation: number;
  dotAt: (c: number, r: number) => boolean;
  /** Gaussian noise, standard deviation per channel. */
  noise: number;
  /** How much darker a dot is than the paper in blue (red and green are untouched). */
  depth: number;
  /** Dot radius as a fraction of the pitch. */
  radius: number;
  /** Grey strokes, drawn opaque over the dots (toner hides them)... */
  strokes?: Stroke[];
  /** ...or multiplied in (a grey that lets the dots show through). */
  multiplyStrokes?: boolean;
  /** Paper colour at a pixel (default an even off-white). */
  paper?: (x: number, y: number) => Rgb;
  /** Anything printed or lying on top (logos, highlighter), applied after the dots. */
  over?: (x: number, y: number, rgb: Rgb) => Rgb;
  /** Samples per pixel along each axis (anti-aliasing). */
  supersample?: number;
  /** Gaussian blur, sigma in px (focus, scanner optics). */
  blur?: number;
  /** JPEG-like colour loss: 2 × 2 chroma subsampling, chroma rounded to steps of this. */
  chromaStep?: number;
  seed: number;
}

export const OFF_WHITE: Rgb = [246, 244, 238];

/** A page as a scanner would see it: paper, noise, grey strokes, faint yellow dots. */
export function renderScan(s: ScanSpec): RgbaImage {
  const rand = rng(s.seed);
  const gauss = () => {
    const u = Math.max(1e-12, rand());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
  };
  const { width: W, height: H, pitch } = s;
  const pitchY = s.pitchY ?? pitch;
  const th = (s.rotation * Math.PI) / 180;
  const cos = Math.cos(th);
  const sin = Math.sin(th);
  const cx = W / 2;
  const cy = H / 2;
  const R = s.radius * Math.min(pitch, pitchY);
  // Strokes rasterised once in the page frame (grey level, 0 = paper).
  const mask = new Uint8Array(W * H);
  for (const st of s.strokes ?? [])
    for (let v = Math.max(0, Math.floor(st.y)); v < Math.min(H, st.y + st.h); v++)
      for (let u = Math.max(0, Math.floor(st.x)); u < Math.min(W, st.x + st.w); u++)
        mask[v * W + u] = st.grey;
  const k = s.supersample ?? 2;
  const offs = Array.from({ length: k }, (_, i) => (i + 0.5) / k);
  const rgb = new Float32Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let dot = 0;
      let ink = 0;
      for (const oy of offs) {
        for (const ox of offs) {
          const dx = x + ox - cx;
          const dy = y + oy - cy;
          const u = cx + dx * cos + dy * sin;
          const v = cy - dx * sin + dy * cos;
          const c = Math.round((u - s.origin[0]) / pitch);
          const r = Math.round((v - s.origin[1]) / pitchY);
          if (s.dotAt(c, r)) {
            const d = Math.hypot(u - s.origin[0] - c * pitch, v - s.origin[1] - r * pitchY);
            dot += Math.min(1, Math.max(0, R - d + 0.5));
          }
          const mu = Math.floor(u);
          const mv = Math.floor(v);
          if (mu >= 0 && mv >= 0 && mu < W && mv < H && mask[mv * W + mu]) ink = mask[mv * W + mu]!;
        }
      }
      dot /= k * k;
      const [pr, pg, pb] = s.paper ? s.paper(x, y) : OFF_WHITE;
      let px: Rgb = [pr, pg, pb - s.depth * dot];
      if (ink)
        px = s.multiplyStrokes
          ? [px[0] * (ink / 255), px[1] * (ink / 255), px[2] * (ink / 255)]
          : [ink, ink, ink];
      if (s.over) px = s.over(x, y, px);
      const i = (y * W + x) * 3;
      rgb[i] = px[0];
      rgb[i + 1] = px[1];
      rgb[i + 2] = px[2];
    }
  }
  if (s.blur) blurInPlace(rgb, W, H, s.blur);
  if (s.chromaStep) chromaLoss(rgb, W, H, s.chromaStep);
  const data = new Uint8ClampedArray(W * H * 4);
  for (let p = 0; p < W * H; p++) {
    for (let c = 0; c < 3; c++) data[p * 4 + c] = Math.round(rgb[p * 3 + c]! + s.noise * gauss());
    data[p * 4 + 3] = 255;
  }
  return { width: W, height: H, data };
}

/** Separable Gaussian blur of an RGB float buffer. */
function blurInPlace(rgb: Float32Array, W: number, H: number, sigma: number): void {
  const r = Math.ceil(3 * sigma);
  const kern = Array.from({ length: 2 * r + 1 }, (_, i) =>
    Math.exp(-((i - r) ** 2) / (2 * sigma * sigma)),
  );
  const sum = kern.reduce((a, b) => a + b, 0);
  const kn = kern.map((v) => v / sum);
  const tmp = new Float32Array(rgb.length);
  const pass = (src: Float32Array, dst: Float32Array, horizontal: boolean) => {
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++)
        for (let c = 0; c < 3; c++) {
          let acc = 0;
          for (let t = -r; t <= r; t++) {
            const xx = horizontal ? Math.min(W - 1, Math.max(0, x + t)) : x;
            const yy = horizontal ? y : Math.min(H - 1, Math.max(0, y + t));
            acc += kn[t + r]! * src[(yy * W + xx) * 3 + c]!;
          }
          dst[(y * W + x) * 3 + c] = acc;
        }
  };
  pass(rgb, tmp, true);
  pass(tmp, rgb, false);
}

/** JPEG-like chroma loss: average Cb/Cr over 2 × 2 blocks and round them to `step`. */
function chromaLoss(rgb: Float32Array, W: number, H: number, step: number): void {
  for (let by = 0; by < H; by += 2) {
    for (let bx = 0; bx < W; bx += 2) {
      const cells: number[] = [];
      for (let y = by; y < Math.min(H, by + 2); y++)
        for (let x = bx; x < Math.min(W, bx + 2); x++) cells.push((y * W + x) * 3);
      let cb = 0;
      let cr = 0;
      const lum = cells.map((i) => {
        const [r, g, b] = [rgb[i]!, rgb[i + 1]!, rgb[i + 2]!];
        const yy = 0.299 * r + 0.587 * g + 0.114 * b;
        cb += -0.168736 * r - 0.331264 * g + 0.5 * b;
        cr += 0.5 * r - 0.418688 * g - 0.081312 * b;
        return yy;
      });
      cb = Math.round(cb / cells.length / step) * step;
      cr = Math.round(cr / cells.length / step) * step;
      cells.forEach((i, n) => {
        const yy = lum[n]!;
        rgb[i] = yy + 1.402 * cr;
        rgb[i + 1] = yy - 0.344136 * cb - 0.714136 * cr;
        rgb[i + 2] = yy + 1.772 * cb;
      });
    }
  }
}

/** DocuColor layout as DEDA describes it: an 8 × 16 cell block, the next band shifted 16 cells. */
export function staggered(pattern: Matrix, offC: number, offR: number) {
  return tiled(pattern, offC, offR, 2 * (Math.max(pattern.length, pattern[0]!.length) + 1), 16);
}

/**
 * Tiles along the long side every `period` cells, bands across every `bandPeriod` cells (the
 * tile's short side by default: no gap), odd bands shifted by `stagger`. period = tile length:
 * tiles printed edge to edge.
 */
export function tiled(
  pattern: Matrix,
  offC: number,
  offR: number,
  period: number,
  stagger: number,
  bandPeriod?: number,
) {
  const ph = pattern.length;
  const pw = pattern[0]!.length;
  const wide = pw >= ph;
  const short = wide ? ph : pw;
  const long = wide ? pw : ph;
  const band = bandPeriod ?? short;
  return (c0: number, r0: number) => {
    const c = c0 + offC;
    const r = r0 + offR;
    const across = wide ? r : c;
    const along = wide ? c : r;
    const k = Math.floor(across / band);
    const a = ((across % band) + band) % band;
    if (a >= short) return false;
    const b = (((along - (k & 1 ? stagger : 0)) % period) + period) % period;
    if (b >= long) return false;
    return wide ? pattern[a]![b]! : pattern[b]![a]!;
  };
}

/** Only one tile, its cell (0, 0) at page cell (c0, r0). */
export const single =
  (pattern: Matrix, c0 = 0, r0 = 0) =>
  (c: number, r: number) =>
    r >= r0 &&
    c >= c0 &&
    r < r0 + pattern.length &&
    c < c0 + pattern[0]!.length &&
    pattern[r - r0]![c - c0]!;

export const p2 = (n: number) => String(n).padStart(2, '0');
export const printed = (f: DocuFields) =>
  `${f.year}-${p2(f.month)}-${p2(f.day)} ${p2(f.hour)}:${p2(f.minute)}`;

/** Years 1969-2068: what the default century pivot can hold. */
export function randomFields(r: () => number): DocuFields {
  const year = 1969 + Math.floor(r() * 100);
  const month = 1 + Math.floor(r() * 12);
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    year,
    month,
    day: 1 + Math.floor(r() * days),
    hour: Math.floor(r() * 24),
    minute: Math.floor(r() * 60),
    serial: Array.from({ length: 8 }, () => Math.floor(r() * 10)).join(''),
  };
}

export const SEP = { 10: 127 };

/** Grey bars laid out like lines of words (page frame). */
export function textLines(
  r: () => number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): Stroke[] {
  const out: Stroke[] = [];
  for (let y = y0; y < y1; y += 40) {
    for (let x = x0; x < x1;) {
      const w = 15 + Math.floor(r() * 50);
      const grey = 60 + Math.floor(r() * 60);
      out.push({ x, y: y + 12, w, h: 3, grey });
      for (let lx = x; lx < x + w - 3; lx += 8) out.push({ x: lx, y: y + 3, w: 3, h: 12, grey });
      x += w + 12;
    }
  }
  return out;
}
