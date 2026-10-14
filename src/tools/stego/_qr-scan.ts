import jsQR, { type QRCode } from 'jsqr';
import type { RgbaImage } from '../../core/types';
import { toolT } from '../../i18n/tool-text';

const T = toolT('qr');

/** A pixel buffer being fed to jsQR, with enough bookkeeping to map hits back to the original. */
interface Pre {
  w: number;
  h: number;
  data: Uint8ClampedArray;
  /** processed = original * scale + pad */
  scale: number;
  pad: number;
  steps: string[];
}

export interface QrHit {
  code: QRCode;
  /** How the image had to be prepared, e.g. "inverted, binarized at 128, with margin". */
  how: string;
  /** Read with light modules on dark (the colour to paint it out with depends on it). */
  inverted: boolean;
  /** Centre of the code in the original image's pixel coordinates. */
  centre: { x: number; y: number };
  /** Side of the code in original pixels (approximate). */
  size: number;
}

export interface QrScan {
  hits: QrHit[];
  /** Number of jsQR runs that were needed. */
  tried: number;
}

const luma = (d: Uint8ClampedArray, i: number) =>
  (299 * d[i]! + 587 * d[i + 1]! + 114 * d[i + 2]!) / 1000;

function hasAlpha(img: RgbaImage): boolean {
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i] !== 255) return true;
  return false;
}

function flatten(img: RgbaImage, bg: number): RgbaImage {
  const data = new Uint8ClampedArray(img.data.length);
  for (let i = 0; i < data.length; i += 4) {
    const a = img.data[i + 3]!;
    for (let c = 0; c < 3; c++)
      data[i + c] = Math.round((img.data[i + c]! * a + bg * (255 - a)) / 255);
    data[i + 3] = 255;
  }
  return { width: img.width, height: img.height, data };
}

function upscale(img: RgbaImage, k: number): RgbaImage {
  const w = img.width * k;
  const h = img.height * k;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.floor(y / k);
    for (let x = 0; x < w; x++) {
      const s = (sy * img.width + Math.floor(x / k)) * 4;
      data.set(img.data.subarray(s, s + 4), (y * w + x) * 4);
    }
  }
  return { width: w, height: h, data };
}

/** Average 2x2 blocks (repeated until the longer side is at most `max`). */
function shrink(img: RgbaImage, max: number): { image: RgbaImage; factor: number } {
  let cur = img;
  let factor = 1;
  while (Math.max(cur.width, cur.height) > max) {
    const w = Math.max(1, cur.width >> 1);
    const h = Math.max(1, cur.height >> 1);
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        for (let c = 0; c < 4; c++) {
          let sum = 0;
          for (let dy = 0; dy < 2; dy++) {
            for (let dx = 0; dx < 2; dx++) {
              const sx = Math.min(cur.width - 1, x * 2 + dx);
              const sy = Math.min(cur.height - 1, y * 2 + dy);
              sum += cur.data[(sy * cur.width + sx) * 4 + c]!;
            }
          }
          data[(y * w + x) * 4 + c] = sum / 4;
        }
      }
    }
    cur = { width: w, height: h, data };
    factor *= 2;
  }
  return { image: cur, factor };
}

function otsu(img: RgbaImage): number {
  const hist = new Array<number>(256).fill(0);
  const n = img.width * img.height;
  for (let i = 0; i < n; i++) hist[Math.round(luma(img.data, i * 4))]!++;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t]!;
  let wB = 0;
  let sumB = 0;
  let best = 128;
  let max = -1;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]!;
    if (!wB) continue;
    const wF = n - wB;
    if (!wF) break;
    sumB += t * hist[t]!;
    const between = wB * wF * (sumB / wB - (sum - sumB) / wF) ** 2;
    if (between > max) {
      max = between;
      best = t;
    }
  }
  return best;
}

function binarize(img: RgbaImage, threshold: number): RgbaImage {
  const data = new Uint8ClampedArray(img.data.length);
  for (let i = 0; i < data.length; i += 4) {
    const v = luma(img.data, i) < threshold ? 0 : 255;
    data[i] = data[i + 1] = data[i + 2] = v;
    data[i + 3] = 255;
  }
  return { width: img.width, height: img.height, data };
}

function addMargin(img: RgbaImage, m: number, value: number): RgbaImage {
  const w = img.width + 2 * m;
  const h = img.height + 2 * m;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = data[i + 1] = data[i + 2] = value;
    data[i + 3] = 255;
  }
  for (let y = 0; y < img.height; y++) {
    data.set(img.data.subarray(y * img.width * 4, (y + 1) * img.width * 4), ((y + m) * w + m) * 4);
  }
  return { width: w, height: h, data };
}

/** Deterministic work limit: jsQR is slow on noisy images, so stop after this many pixels. */
interface Budget {
  left: number;
}
const PIXEL_BUDGET = 8_000_000;

/**
 * One jsQR run. jsQR 1.4's own "onlyInvert" mode crashes (it never computes the inverted matrix),
 * so inverted attempts flip the pixels here and use "dontInvert". It also throws on some inputs
 * where it cannot assemble finder patterns; that simply means "no code here".
 */
function run(p: Pre, invert: boolean, budget: Budget): QRCode | null {
  budget.left -= p.w * p.h;
  let data = p.data;
  if (invert) {
    data = new Uint8ClampedArray(p.data);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 255 - data[i]!;
      data[i + 1] = 255 - data[i + 1]!;
      data[i + 2] = 255 - data[i + 2]!;
    }
  }
  try {
    return jsQR(data, p.w, p.h, { inversionAttempts: 'dontInvert' });
  } catch {
    return null;
  }
}

function fillBox(p: Pre, code: QRCode, value: number): Pre {
  const pts = [
    code.location.topLeftCorner,
    code.location.topRightCorner,
    code.location.bottomRightCorner,
    code.location.bottomLeftCorner,
  ];
  const xs = pts.map((q) => q.x);
  const ys = pts.map((q) => q.y);
  const pad = (Math.max(...xs) - Math.min(...xs)) / 10;
  const x0 = Math.max(0, Math.floor(Math.min(...xs) - pad));
  const x1 = Math.min(p.w - 1, Math.ceil(Math.max(...xs) + pad));
  const y0 = Math.max(0, Math.floor(Math.min(...ys) - pad));
  const y1 = Math.min(p.h - 1, Math.ceil(Math.max(...ys) + pad));
  const data = new Uint8ClampedArray(p.data);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = (y * p.w + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = value;
      data[i + 3] = 255;
    }
  }
  return { ...p, data };
}

function toHit(p: Pre, code: QRCode, invert: boolean): QrHit {
  const c = code.location;
  const pts = [c.topLeftCorner, c.topRightCorner, c.bottomRightCorner, c.bottomLeftCorner];
  const cx = pts.reduce((s, q) => s + q.x, 0) / 4;
  const cy = pts.reduce((s, q) => s + q.y, 0) / 4;
  const side = Math.hypot(
    c.topRightCorner.x - c.topLeftCorner.x,
    c.topRightCorner.y - c.topLeftCorner.y,
  );
  const steps = [...p.steps];
  if (invert) steps.unshift(T('how.inverted'));
  return {
    code,
    how: steps.length ? steps.join(', ') : T('how.asIs'),
    inverted: invert,
    centre: { x: Math.round((cx - p.pad) / p.scale), y: Math.round((cy - p.pad) / p.scale) },
    size: Math.round(side / p.scale),
  };
}

interface Candidate {
  /** Builds the pixel buffer for a polarity (the margin colour depends on it). */
  build: (invert: boolean) => Pre;
}

/** core: the likely fixes; extra: slower fallbacks; tile: a single cheap pass over a crop. */
type Phase = 'core' | 'extra' | 'tile';

function* candidates(img: RgbaImage, phase: Phase): Generator<Candidate> {
  const bases: { image: RgbaImage; steps: string[]; scale: number }[] = [];
  if (hasAlpha(img)) {
    bases.push({ image: flatten(img, 255), steps: [T('how.flatWhite')], scale: 1 });
    bases.push({ image: flatten(img, 0), steps: [T('how.flatBlack')], scale: 1 });
  } else {
    bases.push({ image: img, steps: [], scale: 1 });
  }
  const side = Math.max(img.width, img.height);
  const big = side > 1600;
  if (big) {
    const { image, factor } = shrink(bases[0]!.image, 1600);
    bases.push({ image, steps: [T('how.shrunk', { factor })], scale: 1 / factor });
  }

  for (const [bi, base] of bases.entries()) {
    const huge = big && bi === 0; // the full-size original only gets the plain pass
    const scales =
      phase === 'extra' && !big
        ? [1, ...(side <= 400 ? [2] : []), ...(side <= 200 ? [4] : []), ...(side <= 64 ? [8] : [])]
        : [1];
    for (const k of scales) {
      const scaled = k === 1 ? base.image : upscale(base.image, k);
      const stepsK = [...base.steps, ...(k > 1 ? [T('how.upscaled', { k })] : [])];
      const m = Math.max(8, Math.round(Math.min(scaled.width, scaled.height) * 0.12));
      const make =
        (image: RgbaImage, extra: string[], margin: boolean) =>
        (invert: boolean): Pre => {
          const framed = margin ? addMargin(image, m, invert ? 0 : 255) : image;
          return {
            w: framed.width,
            h: framed.height,
            data: framed.data,
            scale: base.scale * k,
            pad: margin ? m : 0,
            steps: [...stepsK, ...extra, ...(margin ? [T('how.margin')] : [])],
          };
        };
      const otsuT = otsu(scaled);
      const binarized = (t: number, label: string) => ({
        build: make(binarize(scaled, t), [label], true),
      });
      if (phase === 'tile') {
        yield { build: make(scaled, [], false) };
        continue;
      }
      if (phase === 'core') {
        yield { build: make(scaled, [], false) };
        if (huge) continue;
        yield { build: make(scaled, [], true) };
        yield binarized(otsuT, T('how.otsu'));
        continue;
      }
      // extra
      if (huge) continue;
      if (k === 1) {
        for (const t of [64, 128, 192]) {
          if (Math.abs(t - otsuT) > 8) yield binarized(t, T('how.binarized', { t }));
        }
      } else {
        yield { build: make(scaled, [], false) };
        yield { build: make(scaled, [], true) };
        if (k <= 2) yield binarized(otsuT, T('how.otsu'));
      }
    }
  }
}

function scanOnce(img: RgbaImage, phase: Phase, maxCodes: number, budget: Budget): QrScan {
  const hits: QrHit[] = [];
  let tried = 0;
  for (const cand of candidates(img, phase)) {
    for (const invert of [false, true]) {
      if (budget.left <= 0) return { hits, tried };
      const pre = cand.build(invert);
      tried++;
      const code = run(pre, invert, budget);
      if (!code) continue;
      hits.push(toHit(pre, code, invert));
      // Blank out what we found and keep looking with the same preparation.
      let cur = fillBox(pre, code, invert ? 0 : 255);
      for (const polarity of [invert, !invert]) {
        for (;;) {
          if (hits.length >= maxCodes || budget.left <= 0) return { hits, tried };
          tried++;
          const more = run(cur, polarity, budget);
          if (!more) break;
          hits.push(toHit(cur, more, polarity));
          cur = fillBox(cur, more, polarity ? 0 : 255);
        }
      }
      return { hits, tried };
    }
  }
  return { hits, tried };
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function cropRect(img: RgbaImage, r: Rect): RgbaImage {
  const data = new Uint8ClampedArray(r.w * r.h * 4);
  for (let y = 0; y < r.h; y++) {
    const from = ((r.y + y) * img.width + r.x) * 4;
    data.set(img.data.subarray(from, from + r.w * 4), y * r.w * 4);
  }
  return { width: r.w, height: r.h, data };
}

/** Overlapping columns, rows and grids: jsQR gives up when it sees more than one code at once. */
function tiles(img: RgbaImage): Rect[] {
  const out: Rect[] = [];
  const grids: [number, number][] = [
    [2, 1],
    [1, 2],
    [3, 1],
    [1, 3],
    [2, 2],
    [3, 3],
  ];
  for (const [cols, rows] of grids) {
    const w = Math.min(img.width, Math.ceil((img.width / cols) * 1.3));
    const h = Math.min(img.height, Math.ceil((img.height / rows) * 1.3));
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        out.push({
          x: cols > 1 ? Math.round(((img.width - w) * i) / (cols - 1)) : 0,
          y: rows > 1 ? Math.round(((img.height - h) * j) / (rows - 1)) : 0,
          w,
          h,
        });
      }
    }
  }
  return out;
}

function paintSquare(
  img: RgbaImage,
  cx: number,
  cy: number,
  half: number,
  value: number,
): RgbaImage {
  const data = new Uint8ClampedArray(img.data);
  const x0 = Math.max(0, Math.floor(cx - half));
  const x1 = Math.min(img.width - 1, Math.ceil(cx + half));
  const y0 = Math.max(0, Math.floor(cy - half));
  const y1 = Math.min(img.height - 1, Math.ceil(cy + half));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = (y * img.width + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = value;
      data[i + 3] = 255;
    }
  }
  return { width: img.width, height: img.height, data };
}

function scanWithBudget(img: RgbaImage, maxCodes: number, depth: number, budget: Budget): QrScan {
  let tried = 0;
  const core = scanOnce(img, 'core', maxCodes, budget);
  tried += core.tried;
  if (core.hits.length) return { hits: core.hits, tried };
  // With several codes in view jsQR fails; each overlapping tile may hold just one.
  if (depth < 4 && Math.min(img.width, img.height) >= 120) {
    for (const tile of tiles(img)) {
      if (budget.left <= 0) break;
      const found = scanOnce(cropRect(img, tile), 'tile', 1, budget);
      tried += found.tried;
      const hit = found.hits[0];
      if (!hit) continue;
      const centre = { x: hit.centre.x + tile.x, y: hit.centre.y + tile.y };
      const first: QrHit = {
        ...hit,
        centre,
        how: T('how.tiles', { how: hit.how }),
      };
      const half = hit.size * 0.75;
      const masked = paintSquare(img, centre.x, centre.y, half, hit.inverted ? 0 : 255);
      const rest = scanWithBudget(masked, maxCodes - 1, depth + 1, budget);
      return { hits: [first, ...rest.hits], tried: tried + rest.tried };
    }
  }
  const extra = scanOnce(img, 'extra', maxCodes, budget);
  return { hits: extra.hits, tried: tried + extra.tried };
}

/**
 * Look for QR codes with progressively more drastic preparation: as is, inverted, with a
 * quiet-zone margin, binarized, split into tiles (several codes), rescaled. A code that is found
 * is painted out and the search continues for further codes.
 */
export function scanQr(img: RgbaImage, maxCodes = 8): QrScan {
  return scanWithBudget(img, maxCodes, 0, { left: PIXEL_BUDGET });
}
