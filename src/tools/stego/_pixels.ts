import type { RgbaImage } from '../../core/types';

/** Nearest-neighbour shrink so that the longer side is at most `maxSide` (bits stay exact). */
export function fitImage(img: RgbaImage, maxSide: number): { image: RgbaImage; scaled: boolean } {
  const longest = Math.max(img.width, img.height);
  if (longest <= maxSide) return { image: img, scaled: false };
  const w = Math.max(1, Math.floor((img.width * maxSide) / longest));
  const h = Math.max(1, Math.floor((img.height * maxSide) / longest));
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(img.height - 1, Math.floor((y * img.height) / h));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.width - 1, Math.floor((x * img.width) / w));
      const s = (sy * img.width + sx) * 4;
      const d = (y * w + x) * 4;
      data[d] = img.data[s]!;
      data[d + 1] = img.data[s + 1]!;
      data[d + 2] = img.data[s + 2]!;
      data[d + 3] = img.data[s + 3]!;
    }
  }
  return { image: { width: w, height: h, data }, scaled: true };
}

/** Black and white picture of one bit of one channel (0 = R ... 3 = A). */
export function bitPlaneImage(img: RgbaImage, channel: number, bit: number): RgbaImage {
  const n = img.width * img.height;
  const data = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const v = ((img.data[i * 4 + channel]! >> bit) & 1) * 255;
    data[i * 4] = v;
    data[i * 4 + 1] = v;
    data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }
  return { width: img.width, height: img.height, data };
}

/** Apply `f` to every pixel's RGB (alpha forced opaque so hidden colours under alpha 0 show). */
export function mapRgb(
  img: RgbaImage,
  f: (r: number, g: number, b: number) => [number, number, number],
): RgbaImage {
  const n = img.width * img.height;
  const data = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const [r, g, b] = f(img.data[i * 4]!, img.data[i * 4 + 1]!, img.data[i * 4 + 2]!);
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  }
  return { width: img.width, height: img.height, data };
}

/** Grey picture of a single channel. */
export function channelImage(img: RgbaImage, channel: number): RgbaImage {
  const n = img.width * img.height;
  const data = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const v = img.data[i * 4 + channel]!;
    data[i * 4] = v;
    data[i * 4 + 1] = v;
    data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }
  return { width: img.width, height: img.height, data };
}

function hsv(h: number, s: number, v: number): [number, number, number] {
  const c = v * s;
  const hp = (h % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r, g, b] =
    hp < 1
      ? [c, x, 0]
      : hp < 2
        ? [x, c, 0]
        : hp < 3
          ? [0, c, x]
          : hp < 4
            ? [0, x, c]
            : hp < 5
              ? [x, 0, c]
              : [c, 0, x];
  const m = v - c;
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/**
 * Vivid colour for the i-th distinct value. Golden-angle hue steps put consecutive ranks
 * ~137 degrees apart, so values that differ by 1 can never end up with similar colours.
 */
export function rankColour(i: number): [number, number, number] {
  return hsv(i * 137.508, 0.65 + (i % 4) * 0.1, 0.6 + (i % 3) * 0.2);
}

/** Every distinct value of a channel (or of the whole pixel when channel is -1) gets its own colour. */
export function randomColormap(img: RgbaImage, channel: number): RgbaImage {
  const n = img.width * img.height;
  const data = new Uint8ClampedArray(n * 4);
  const keyAt = (i: number) =>
    channel >= 0
      ? img.data[i * 4 + channel]!
      : (img.data[i * 4]! << 16) | (img.data[i * 4 + 1]! << 8) | img.data[i * 4 + 2]!;
  const seen = new Set<number>();
  for (let i = 0; i < n; i++) seen.add(keyAt(i));
  const sorted = Uint32Array.from(seen).sort();
  const colours = new Map<number, [number, number, number]>();
  sorted.forEach((key, rank) => colours.set(key, rankColour(rank)));
  for (let i = 0; i < n; i++) {
    const c = colours.get(keyAt(i))!;
    data[i * 4] = c[0];
    data[i * 4 + 1] = c[1];
    data[i * 4 + 2] = c[2];
    data[i * 4 + 3] = 255;
  }
  return { width: img.width, height: img.height, data };
}

/** Per-channel histogram equalisation (stretches faint differences to full contrast). */
export function equalize(img: RgbaImage): RgbaImage {
  const n = img.width * img.height;
  const luts: Uint8Array[] = [];
  for (let c = 0; c < 3; c++) {
    const hist = new Uint32Array(256);
    for (let i = 0; i < n; i++) hist[img.data[i * 4 + c]!]!++;
    const cdf = new Uint32Array(256);
    let sum = 0;
    for (let v = 0; v < 256; v++) {
      sum += hist[v]!;
      cdf[v] = sum;
    }
    const first = cdf.find((x) => x > 0) ?? 0;
    const lut = new Uint8Array(256);
    for (let v = 0; v < 256; v++) {
      lut[v] = n === first ? v : Math.round(((cdf[v]! - first) / (n - first)) * 255);
    }
    luts.push(lut);
  }
  return mapRgb(img, (r, g, b) => [luts[0]![r]!, luts[1]![g]!, luts[2]![b]!]);
}

export interface PlaneStats {
  ones: number;
  /** Share of horizontally adjacent pixel pairs holding the same bit (0.5 = noise). */
  agree: number;
}

/** Statistics for one bit plane: how many ones and how structured it is. */
export function planeStats(img: RgbaImage, channel: number, bit: number): PlaneStats {
  const { width: w, height: h, data } = img;
  let ones = 0;
  let same = 0;
  let pairs = 0;
  for (let y = 0; y < h; y++) {
    let prev = -1;
    for (let x = 0; x < w; x++) {
      const v = (data[(y * w + x) * 4 + channel]! >> bit) & 1;
      ones += v;
      if (prev >= 0) {
        pairs++;
        if (prev === v) same++;
      }
      prev = v;
    }
  }
  return { ones: ones / (w * h), agree: pairs ? same / pairs : 1 };
}
