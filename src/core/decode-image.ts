import { decode as decodePng, type DecodedPng } from 'fast-png';
import { ToolError } from './errors';
import { t } from '../i18n';
import type { RgbaImage } from './types';
import { u16le, u32le } from '../lib/bytes';

/**
 * Pixel-exact image decoding. Browsers colour-manage and premultiply alpha when drawing
 * to a canvas, which silently destroys LSB payloads, so PNG and BMP are decoded in pure JS.
 * Other formats fall back to the browser decoder (see decodeImageInBrowser).
 */
export function decodeImageExact(bytes: Uint8Array): RgbaImage | null {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    let png: DecodedPng;
    try {
      png = decodePng(bytes);
    } catch (e) {
      throw new ToolError(t('core.png.failed', { message: (e as Error).message }));
    }
    return pngToRgba(png);
  }
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return decodeBmp(bytes);
  if (bytes[0] === 0x50 && bytes[1]! >= 0x31 && bytes[1]! <= 0x36) return decodeNetpbm(bytes);
  return null;
}

const NETPBM_MAX_PIXELS = 100_000_000;
const isBlank = (c: number) =>
  c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x0b || c === 0x0c;

/**
 * Netpbm: PBM/PGM/PPM, ASCII (P1/P2/P3) and binary (P4/P5/P6). Handles `#` header comments,
 * a maxval other than 255 (scaled to 8 bits) and 16-bit samples (big-endian). Browsers do not
 * decode Netpbm, so a Piet program saved as a .ppm needs this pure-JS reader.
 */
export function decodeNetpbm(b: Uint8Array): RgbaImage {
  const type = b[0] === 0x50 ? b[1]! - 0x30 : 0;
  if (type < 1 || type > 6) throw new ToolError(t('core.netpbm.header'));
  const ascii = type <= 3;
  const bitmap = type === 1 || type === 4; // PBM: 1 = black, 0 = white, no maxval

  let pos = 2;
  const skipBlanksAndComments = () => {
    for (;;) {
      while (pos < b.length && isBlank(b[pos]!)) pos++;
      if (b[pos] === 0x23) while (pos < b.length && b[pos] !== 0x0a) pos++;
      else break;
    }
  };
  const headerUint = (): number => {
    skipBlanksAndComments();
    const start = pos;
    let v = 0;
    while (pos < b.length && b[pos]! >= 0x30 && b[pos]! <= 0x39) v = v * 10 + (b[pos++]! - 0x30);
    if (pos === start) throw new ToolError(t('core.netpbm.header'));
    return v;
  };

  const width = headerUint();
  const height = headerUint();
  const maxval = bitmap ? 1 : headerUint();
  if (width <= 0 || height <= 0 || width * height > NETPBM_MAX_PIXELS) {
    throw new ToolError(t('core.netpbm.size', { width, height }));
  }
  if (!bitmap && (maxval < 1 || maxval > 65535)) {
    throw new ToolError(t('core.netpbm.maxval', { maxval }));
  }

  const n = width * height;
  const out = new Uint8ClampedArray(n * 4);
  const scale = (v: number) =>
    maxval === 255 ? v : Math.round((Math.min(v, maxval) * 255) / maxval);

  if (ascii) {
    const nextToken = (): number => {
      skipBlanksAndComments();
      if (bitmap) {
        // A PBM sample is a single 0/1 digit; whitespace between them is optional.
        if (pos >= b.length) throw new ToolError(t('core.netpbm.truncated'));
        const c = b[pos++]!;
        if (c !== 0x30 && c !== 0x31) throw new ToolError(t('core.netpbm.truncated'));
        return c - 0x30;
      }
      const start = pos;
      let v = 0;
      while (pos < b.length && b[pos]! >= 0x30 && b[pos]! <= 0x39) v = v * 10 + (b[pos++]! - 0x30);
      if (pos === start) throw new ToolError(t('core.netpbm.truncated'));
      return v;
    };
    for (let i = 0; i < n; i++) {
      if (bitmap) {
        const v = nextToken() ? 0 : 255; // 1 = black
        out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = v;
      } else if (type === 2) {
        const g = scale(nextToken());
        out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = g;
      } else {
        out[i * 4] = scale(nextToken());
        out[i * 4 + 1] = scale(nextToken());
        out[i * 4 + 2] = scale(nextToken());
      }
      out[i * 4 + 3] = 255;
    }
    return { width, height, data: out };
  }

  // Binary: exactly one whitespace byte closes the header; the raster follows.
  if (pos < b.length && isBlank(b[pos]!)) pos++;
  const two = maxval > 255;
  const need =
    type === 4 ? Math.ceil(width / 8) * height : n * (type === 6 ? 3 : 1) * (two ? 2 : 1);
  if (b.length - pos < need) throw new ToolError(t('core.netpbm.truncated'));
  let rp = pos;
  const sample = () => (two ? (b[rp++]! << 8) | b[rp++]! : b[rp++]!);

  if (type === 4) {
    const rowBytes = Math.ceil(width / 8);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const bit = (b[pos + y * rowBytes + (x >> 3)]! >> (7 - (x & 7))) & 1;
        const v = bit ? 0 : 255; // 1 = black
        const o = (y * width + x) * 4;
        out[o] = out[o + 1] = out[o + 2] = v;
        out[o + 3] = 255;
      }
    }
  } else {
    for (let i = 0; i < n; i++) {
      if (type === 5) {
        const g = scale(sample());
        out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = g;
      } else {
        out[i * 4] = scale(sample());
        out[i * 4 + 1] = scale(sample());
        out[i * 4 + 2] = scale(sample());
      }
      out[i * 4 + 3] = 255;
    }
  }
  return { width, height, data: out };
}

function unpackSamples(png: DecodedPng): Uint8Array | Uint16Array | Uint8ClampedArray {
  const { depth, width, height, channels } = png;
  if (depth >= 8) return png.data;
  const src = png.data as Uint8Array;
  const perRow = width * channels;
  const rowBytes = Math.ceil((perRow * depth) / 8);
  const out = new Uint8Array(perRow * height);
  const mask = (1 << depth) - 1;
  for (let y = 0; y < height; y++) {
    for (let i = 0; i < perRow; i++) {
      const bit = i * depth;
      const byte = src[y * rowBytes + (bit >> 3)]!;
      out[y * perRow + i] = (byte >> (8 - depth - (bit & 7))) & mask;
    }
  }
  return out;
}

function pngToRgba(png: DecodedPng): RgbaImage {
  const { width, height, channels, depth } = png;
  const samples = unpackSamples(png);
  const out = new Uint8ClampedArray(width * height * 4);
  const n = width * height;
  const max = (1 << depth) - 1;
  // Scale any depth to 0..255 (16-bit: keep the high byte).
  const to8 = (v: number) =>
    depth === 16 ? v >> 8 : depth === 8 ? v : Math.round((v * 255) / max);
  if (png.palette) {
    const pal = png.palette;
    const trns = png.transparency;
    for (let i = 0; i < n; i++) {
      const idx = samples[i]!;
      const c = pal[idx] ?? [0, 0, 0];
      out[i * 4] = c[0]!;
      out[i * 4 + 1] = c[1]!;
      out[i * 4 + 2] = c[2]!;
      out[i * 4 + 3] = c.length > 3 ? c[3]! : (trns?.[idx] ?? 255);
    }
    return { width, height, data: out };
  }
  for (let i = 0; i < n; i++) {
    const s = i * channels;
    if (channels === 1 || channels === 2) {
      const g = to8(samples[s]!);
      out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = g;
      out[i * 4 + 3] = channels === 2 ? to8(samples[s + 1]!) : 255;
    } else {
      out[i * 4] = to8(samples[s]!);
      out[i * 4 + 1] = to8(samples[s + 1]!);
      out[i * 4 + 2] = to8(samples[s + 2]!);
      out[i * 4 + 3] = channels === 4 ? to8(samples[s + 3]!) : 255;
    }
  }
  return { width, height, data: out };
}

/** Uncompressed BMP (1/4/8/24/32 bpp, BI_RGB or BI_BITFIELDS with standard masks). */
export function decodeBmp(b: Uint8Array): RgbaImage {
  if (b.length < 54) throw new ToolError(t('core.bmp.short'));
  const dataOffset = u32le(b, 10);
  const headerSize = u32le(b, 14);
  const width = u32le(b, 18) | 0;
  const rawHeight = u32le(b, 22) | 0;
  const bpp = u16le(b, 28);
  const compression = u32le(b, 30);
  if (compression !== 0 && compression !== 3) {
    throw new ToolError(t('core.bmp.compression', { compression }));
  }
  const height = Math.abs(rawHeight);
  const bottomUp = rawHeight > 0;
  if (width <= 0 || height <= 0 || width * height > 100_000_000) {
    throw new ToolError(t('core.bmp.size', { width, height }));
  }
  const rowSize = Math.ceil((bpp * width) / 32) * 4;
  const palette: number[][] = [];
  if (bpp <= 8) {
    const colors = u32le(b, 46) || 1 << bpp;
    const palStart = 14 + headerSize;
    for (let i = 0; i < colors; i++) {
      const p = palStart + i * 4;
      palette.push([b[p + 2] ?? 0, b[p + 1] ?? 0, b[p] ?? 0]);
    }
  }
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const row = dataOffset + (bottomUp ? height - 1 - y : y) * rowSize;
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (bpp === 24 || bpp === 32) {
        const p = row + x * (bpp / 8);
        out[o] = b[p + 2] ?? 0;
        out[o + 1] = b[p + 1] ?? 0;
        out[o + 2] = b[p] ?? 0;
        out[o + 3] = bpp === 32 && compression === 3 ? (b[p + 3] ?? 255) : 255;
      } else if (bpp <= 8) {
        const bit = x * bpp;
        const byte = b[row + (bit >> 3)] ?? 0;
        const idx = (byte >> (8 - bpp - (bit & 7))) & ((1 << bpp) - 1);
        const c = palette[idx] ?? [0, 0, 0];
        out[o] = c[0]!;
        out[o + 1] = c[1]!;
        out[o + 2] = c[2]!;
        out[o + 3] = 255;
      } else {
        throw new ToolError(t('core.bmp.bpp', { bpp }));
      }
    }
  }
  return { width, height, data: out };
}

/** Browser-only fallback for JPEG/GIF/WebP/... — no colour conversion, no premultiplication. */
export async function decodeImageInBrowser(bytes: Uint8Array): Promise<RgbaImage> {
  const blob = new Blob([bytes as BlobPart]);
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  } catch {
    throw new ToolError(t('core.image.undecodable'));
  }
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new ToolError(t('core.image.noCanvas'));
  ctx.drawImage(bmp, 0, 0);
  const img = ctx.getImageData(0, 0, bmp.width, bmp.height);
  return { width: img.width, height: img.height, data: img.data };
}
