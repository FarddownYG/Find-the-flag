/**
 * Pure image operations for the image analysis tool. Everything maps an RgbaImage to a new
 * opaque RgbaImage, in O(pixels). The bit-plane, colour-map, channel and equalise primitives live
 * in _pixels.ts / _channel.ts; only what they do not already offer is added here.
 */
import type { RgbaImage } from '../../core/types';
import { buildLut, histogram } from './_channel';
import { mapRgb } from './_pixels';

/** Combine the same bit of R, G and B into one colour (`or`, `and` or `xor` per pixel channel). */
export function superimposePlane(
  img: RgbaImage,
  bit: number,
  mode: 'or' | 'and' | 'xor',
): RgbaImage {
  const n = img.width * img.height;
  const data = new Uint8ClampedArray(n * 4);
  const b = (v: number) => (v >> bit) & 1;
  for (let i = 0; i < n; i++) {
    const r = b(img.data[i * 4]!);
    const g = b(img.data[i * 4 + 1]!);
    const bl = b(img.data[i * 4 + 2]!);
    const v = mode === 'or' ? r | g | bl : mode === 'and' ? r & g & bl : r ^ g ^ bl;
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = v * 255;
    data[i * 4 + 3] = 255;
  }
  return { width: img.width, height: img.height, data };
}

/** Per-pixel minimum, maximum or median of R, G and B, as a grey picture. */
export function rgbReduce(img: RgbaImage, mode: 'min' | 'max' | 'median'): RgbaImage {
  return mapRgb(img, (r, g, b) => {
    const v =
      mode === 'min'
        ? Math.min(r, g, b)
        : mode === 'max'
          ? Math.max(r, g, b)
          : r + g + b - Math.min(r, g, b) - Math.max(r, g, b);
    return [v, v, v];
  });
}

/** Difference map of two colour channels (0 = R, 1 = G, 2 = B): |a - b| or a xor b, in grey. */
export function channelDiff(img: RgbaImage, a: number, b: number, op: 'sub' | 'xor'): RgbaImage {
  const n = img.width * img.height;
  const data = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const x = img.data[i * 4 + a]!;
    const y = img.data[i * 4 + b]!;
    const v = op === 'sub' ? Math.abs(x - y) : x ^ y;
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }
  return { width: img.width, height: img.height, data };
}

/** Sobel edge magnitude of the luma, clamped to 0..255 (borders replicate the edge pixel). */
export function sobel(img: RgbaImage): RgbaImage {
  const { width: w, height: h, data: src } = img;
  const luma = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) {
    luma[i] = 0.299 * src[i * 4]! + 0.587 * src[i * 4 + 1]! + 0.114 * src[i * 4 + 2]!;
  }
  const at = (x: number, y: number) =>
    luma[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))]!;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const gx =
        at(x + 1, y - 1) +
        2 * at(x + 1, y) +
        at(x + 1, y + 1) -
        (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
      const gy =
        at(x - 1, y + 1) +
        2 * at(x, y + 1) +
        at(x + 1, y + 1) -
        (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
      const p = (y * w + x) * 4;
      data[p] = data[p + 1] = data[p + 2] = Math.round(Math.hypot(gx, gy));
      data[p + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

/** Per-channel lookup through the shared LUT builder (same maths as the channel tool). */
function viaLut(img: RgbaImage, stretch: 'none' | 'auto', gamma: number): RgbaImage {
  const n = img.width * img.height;
  const luts: Uint8Array[] = [];
  for (let c = 0; c < 3; c++) {
    const values = new Uint8Array(n);
    for (let i = 0; i < n; i++) values[i] = img.data[i * 4 + c]!;
    luts.push(
      buildLut(histogram(values), { invert: false, stretch, gain: 1, gamma, threshold: 0 }),
    );
  }
  return mapRgb(img, (r, g, b) => [luts[0]![r]!, luts[1]![g]!, luts[2]![b]!]);
}

/** out = 255 * (v / 255) ^ (1 / g) on every channel: g above 1 lifts the shadows. */
export const gammaImage = (img: RgbaImage, g: number): RgbaImage => viaLut(img, 'none', g);

/** Automatic contrast stretch of each channel (robust percentile window). */
export const stretchImage = (img: RgbaImage): RgbaImage => viaLut(img, 'auto', 1);
