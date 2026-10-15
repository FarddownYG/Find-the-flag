/**
 * The picture with a numbered box around every code found (pure, no DOM). Boxes follow the code's
 * corners, so a tilted code gets a tilted box. A very large picture is brought down first so the
 * result stays cheap to send to the page.
 */
import type { RgbaImage } from '../../core/types';
import type { Point } from './_barcode-prep';

/** Longest side of the drawn picture. */
export const DRAW_MAX_SIDE = 2000;

type Rgb = readonly [number, number, number];

/** Distinct, saturated colours that stay visible on both light and dark pictures. */
const COLOURS: readonly Rgb[] = [
  [230, 25, 75],
  [0, 150, 70],
  [30, 90, 230],
  [245, 130, 0],
  [170, 40, 200],
  [0, 170, 200],
];

/** 3 x 5 digits, one row per string. */
const DIGITS: Record<string, readonly string[]> = {
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '010', '010', '010'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
};

export interface Box {
  corners: [Point, Point, Point, Point];
}

/** Average k x k blocks of an RGBA picture. */
function shrinkRgba(img: RgbaImage, k: number): RgbaImage {
  const w = Math.max(1, Math.floor(img.width / k));
  const h = Math.max(1, Math.floor(img.height / k));
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 4; c++) {
        let sum = 0;
        let n = 0;
        for (let dy = 0; dy < k; dy++) {
          const sy = y * k + dy;
          if (sy >= img.height) break;
          for (let dx = 0; dx < k; dx++) {
            const sx = x * k + dx;
            if (sx >= img.width) break;
            sum += img.data[(sy * img.width + sx) * 4 + c]!;
            n++;
          }
        }
        data[(y * w + x) * 4 + c] = sum / n;
      }
    }
  }
  return { width: w, height: h, data };
}

/** The picture as drawn, and the factor the original was shrunk by (1 = same size). */
export function drawBoxes(img: RgbaImage, boxes: Box[]): { image: RgbaImage; factor: number } {
  let k = 1;
  while (Math.max(img.width, img.height) / k > DRAW_MAX_SIDE) k++;
  const base = k > 1 ? shrinkRgba(img, k) : img;
  const data = new Uint8ClampedArray(base.data);
  // Drawn on a flat opaque copy: a transparent corner would hide the box.
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  const out: RgbaImage = { width: base.width, height: base.height, data };
  const side = Math.max(out.width, out.height);
  const thick = Math.max(2, Math.round(side / 300));
  // Numbers big enough to read once the picture is shown at the width of the page.
  const digit = Math.max(3, Math.round(side / 140));

  const dot = (x: number, y: number, rgb: Rgb, r = thick / 2) => {
    const x0 = Math.max(0, Math.floor(x - r));
    const x1 = Math.min(out.width - 1, Math.ceil(x + r));
    const y0 = Math.max(0, Math.floor(y - r));
    const y1 = Math.min(out.height - 1, Math.ceil(y + r));
    for (let yy = y0; yy <= y1; yy++) {
      for (let xx = x0; xx <= x1; xx++) {
        const i = (yy * out.width + xx) * 4;
        data[i] = rgb[0];
        data[i + 1] = rgb[1];
        data[i + 2] = rgb[2];
      }
    }
  };
  const line = (a: Point, b: Point, rgb: Rgb) => {
    const steps = Math.ceil(Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y))) + 1;
    for (let s = 0; s <= steps; s++) {
      const f = s / steps;
      dot(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f, rgb);
    }
  };
  const label = (n: number, at: Point, rgb: Rgb) => {
    const scale = digit;
    const text = String(n);
    const w = (text.length * 4 - 1) * scale + 2 * scale;
    const h = 5 * scale + 2 * scale;
    const x0 = Math.round(Math.min(Math.max(0, at.x), out.width - w));
    const y0 = Math.round(Math.min(Math.max(0, at.y - h - thick), out.height - h));
    for (let yy = 0; yy < h; yy++) {
      for (let xx = 0; xx < w; xx++) {
        const px = x0 + xx;
        const py = y0 + yy;
        if (px < 0 || py < 0 || px >= out.width || py >= out.height) continue;
        const i = (py * out.width + px) * 4;
        data[i] = rgb[0];
        data[i + 1] = rgb[1];
        data[i + 2] = rgb[2];
      }
    }
    [...text].forEach((ch, ci) => {
      const glyph = DIGITS[ch];
      if (!glyph) return;
      for (let gy = 0; gy < 5; gy++) {
        for (let gx = 0; gx < 3; gx++) {
          if (glyph[gy]![gx] !== '1') continue;
          for (let sy = 0; sy < scale; sy++) {
            for (let sx = 0; sx < scale; sx++) {
              const px = x0 + scale + (ci * 4 + gx) * scale + sx;
              const py = y0 + scale + gy * scale + sy;
              if (px < 0 || py < 0 || px >= out.width || py >= out.height) continue;
              const i = (py * out.width + px) * 4;
              data[i] = data[i + 1] = data[i + 2] = 255;
            }
          }
        }
      }
    });
  };

  boxes.forEach((box, n) => {
    const rgb = COLOURS[n % COLOURS.length]!;
    const pts = box.corners.map((p) => ({ x: p.x / k, y: p.y / k }));
    for (let i = 0; i < 4; i++) line(pts[i]!, pts[(i + 1) % 4]!, rgb);
    // The number sits just above the corner that is highest on the picture.
    const top = pts.reduce((a, b) => (b.y < a.y || (b.y === a.y && b.x < a.x) ? b : a));
    label(n + 1, { x: top.x, y: top.y }, rgb);
  });
  return { image: out, factor: k };
}
