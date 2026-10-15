/**
 * Barcodes made on the spot for the tests and for scripts/gen-samples-barcode.mjs: the zxing-wasm
 * writer (the same package as the reader, MIT) draws them, then a few helpers damage the picture
 * the way real photos and screenshots are damaged. Node only: nothing in the app imports it.
 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { prepareZXingModule, writeBarcode, type WriterOptions } from 'zxing-wasm/writer';
import { decodeImageExact } from '../../core/decode-image';
import type { RgbaImage } from '../../core/types';
import { grayToRgba, rotate, toGray, type Gray } from './_barcode-prep';

let ready: Promise<void> | null = null;

function loadWriter(): Promise<void> {
  ready ??= (async () => {
    const path = createRequire(import.meta.url).resolve('zxing-wasm/writer/zxing_writer.wasm');
    const bytes = await readFile(path);
    const wasmBinary = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    await prepareZXingModule({ overrides: { wasmBinary }, fireImmediately: true });
  })();
  return ready;
}

/** A barcode as an RGBA picture (modules `scale` pixels wide, with its quiet zone). */
export async function makeBarcode(
  input: string | Uint8Array,
  options: WriterOptions,
): Promise<RgbaImage> {
  await loadWriter();
  const result = await writeBarcode(input, { scale: 4, ...options });
  if (!result.image) throw new Error(`Could not write the barcode: ${result.error}`);
  const png = new Uint8Array(await result.image.arrayBuffer());
  const image = decodeImageExact(png);
  if (!image) throw new Error('The writer did not return a PNG.');
  return image;
}

/** EAN-13 / UPC-A check digit of the first 12 (11) digits. */
export function checkDigit(body: string): number {
  let sum = 0;
  const digits = [...body].reverse();
  digits.forEach((d, i) => {
    sum += Number(d) * (i % 2 === 0 ? 3 : 1);
  });
  return (10 - (sum % 10)) % 10;
}

export function blank(width: number, height: number, value: number): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4).fill(value);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  return { width, height, data };
}

export function paste(dst: RgbaImage, src: RgbaImage, x0: number, y0: number): void {
  for (let y = 0; y < src.height; y++) {
    dst.data.set(
      src.data.subarray(y * src.width * 4, (y + 1) * src.width * 4),
      ((y0 + y) * dst.width + x0) * 4,
    );
  }
}

export const invertImage = (img: RgbaImage): RgbaImage => ({
  ...img,
  data: img.data.map((v, i) => (i % 4 === 3 ? v : 255 - v)),
});

const asGray = (img: RgbaImage): Gray => toGray(img, 255);

/** The picture turned by any angle (white corners), as RGBA. */
export function turn(img: RgbaImage, degrees: number, fill = 255): RgbaImage {
  return grayToRgba(rotate(asGray(img), degrees, fill).gray);
}

/** Seeded pseudo-random noise added to every pixel (±amount), deterministic. */
export function addNoise(img: RgbaImage, amount: number, seed = 12345): RgbaImage {
  let s = seed >>> 0;
  const rnd = () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
  const data = new Uint8ClampedArray(img.data);
  for (let i = 0; i < data.length; i += 4) {
    const n = (rnd() * 2 - 1) * amount;
    data[i] = data[i]! + n;
    data[i + 1] = data[i + 1]! + n;
    data[i + 2] = data[i + 2]! + n;
  }
  return { ...img, data };
}

/** Salt-and-pepper speckle: a `fraction` of the pixels set to black or white, deterministic. */
export function speckle(img: RgbaImage, fraction: number, seed = 777): RgbaImage {
  let s = seed >>> 0;
  const rnd = () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
  const data = new Uint8ClampedArray(img.data);
  for (let i = 0; i < data.length; i += 4) {
    if (rnd() >= fraction) continue;
    const v = rnd() < 0.5 ? 0 : 255;
    data[i] = data[i + 1] = data[i + 2] = v;
  }
  return { ...img, data };
}

/** A box blur of radius `r` (a soft, out-of-focus picture). */
export function blur(img: RgbaImage, r: number): RgbaImage {
  const { width: w, height: h } = img;
  const src = asGray(img);
  const tmp = new Float32Array(w * h);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      let n = 0;
      for (let k = -r; k <= r; k++) {
        const xx = Math.min(w - 1, Math.max(0, x + k));
        sum += src.data[y * w + xx]!;
        n++;
      }
      tmp[y * w + x] = sum / n;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      let n = 0;
      for (let k = -r; k <= r; k++) {
        const yy = Math.min(h - 1, Math.max(0, y + k));
        sum += tmp[yy * w + x]!;
        n++;
      }
      out[y * w + x] = Math.round(sum / n);
    }
  }
  return grayToRgba({ width: w, height: h, data: out });
}

/** Nearest-neighbour resize to an exact size (scales a code down to a few pixels per module). */
export function resize(img: RgbaImage, width: number, height: number): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(img.height - 1, Math.floor((y * img.height) / height));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(img.width - 1, Math.floor((x * img.width) / width));
      data.set(
        img.data.subarray((sy * img.width + sx) * 4, (sy * img.width + sx) * 4 + 4),
        (y * width + x) * 4,
      );
    }
  }
  return { width, height, data };
}

const EAN_L = [
  '0001101',
  '0011001',
  '0010011',
  '0111101',
  '0100011',
  '0110001',
  '0101111',
  '0111011',
  '0110111',
  '0001011',
];
const EAN_G = [
  '0100111',
  '0110011',
  '0011011',
  '0100001',
  '0011101',
  '0111001',
  '0000101',
  '0010001',
  '0001001',
  '0010111',
];
const EAN_R = [
  '1110010',
  '1100110',
  '1101100',
  '1000010',
  '1011100',
  '1001110',
  '1010000',
  '1000100',
  '1001000',
  '1110100',
];
const EAN_PARITY = [
  'LLLLLL',
  'LLGLGG',
  'LLGGLG',
  'LLGGGL',
  'LGLLGG',
  'LGGLLG',
  'LGGGLL',
  'LGLGLG',
  'LGLGGL',
  'LGGLGL',
];

/**
 * The 95 modules of an EAN-13 for exactly these 13 digits, whatever their check digit. (The
 * writer refuses a wrong check digit; a damaged label is just what the "invalid" option is for.)
 */
export function ean13Modules(digits: string): string {
  if (!/^\d{13}$/.test(digits)) throw new Error('EAN-13 takes 13 digits');
  const parity = EAN_PARITY[Number(digits[0])]!;
  let bits = '101';
  for (let i = 0; i < 6; i++) {
    const d = Number(digits[i + 1]);
    bits += (parity[i] === 'L' ? EAN_L : EAN_G)[d]!;
  }
  bits += '01010';
  for (let i = 7; i < 13; i++) bits += EAN_R[Number(digits[i])]!;
  return `${bits}101`;
}
