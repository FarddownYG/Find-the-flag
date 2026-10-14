import { decode as decodePng, type DecodedPng } from 'fast-png';
import { ToolError } from './errors';
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
      throw new ToolError(`PNG decode failed: ${(e as Error).message}`);
    }
    return pngToRgba(png);
  }
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return decodeBmp(bytes);
  return null;
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
  if (b.length < 54) throw new ToolError('BMP too short.');
  const dataOffset = u32le(b, 10);
  const headerSize = u32le(b, 14);
  const width = u32le(b, 18) | 0;
  const rawHeight = u32le(b, 22) | 0;
  const bpp = u16le(b, 28);
  const compression = u32le(b, 30);
  if (compression !== 0 && compression !== 3) {
    throw new ToolError(`BMP compression ${compression} is not supported (only uncompressed).`);
  }
  const height = Math.abs(rawHeight);
  const bottomUp = rawHeight > 0;
  if (width <= 0 || height <= 0 || width * height > 100_000_000) {
    throw new ToolError(`Implausible BMP size ${width}x${height}.`);
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
        throw new ToolError(`BMP with ${bpp} bits per pixel is not supported.`);
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
    throw new ToolError('This file is not an image format the browser can decode.');
  }
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new ToolError('Canvas 2D is unavailable in this browser.');
  ctx.drawImage(bmp, 0, 0);
  const img = ctx.getImageData(0, 0, bmp.width, bmp.height);
  return { width: img.width, height: img.height, data: img.data };
}
