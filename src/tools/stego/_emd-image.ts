import { encode as encodePng } from 'fast-png';
import { decodeImageExact } from '../../core/decode-image';
import type { RgbaImage } from '../../core/types';
import type { Gray } from './_emd';

/** Where the pixel value of the EMD groups comes from. */
export type EmdChannel = 'gray' | 'r' | 'g' | 'b';

/**
 * The image the decoder works on, built from the exact RGBA pixels FTF decoded. Same formula as
 * `fileToGray` in the core: gray = Math.round(0.299 r + 0.587 g + 0.114 b), or one channel as is.
 */
export function rgbaToGray(img: RgbaImage, channel: EmdChannel): Gray {
  const { data: rgba, width, height } = img;
  const data = new Uint8Array(width * height);
  for (let i = 0; i < data.length; i++) {
    const r = rgba[4 * i]!,
      g = rgba[4 * i + 1]!,
      b = rgba[4 * i + 2]!;
    data[i] =
      channel === 'r'
        ? r
        : channel === 'g'
          ? g
          : channel === 'b'
            ? b
            : Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  }
  return { data, width, height };
}

/** The cover with one colour channel replaced by `plane`; the other channels and alpha stay. */
export function withChannel(img: RgbaImage, plane: Gray, channel: 'r' | 'g' | 'b'): RgbaImage {
  const offset = channel === 'r' ? 0 : channel === 'g' ? 1 : 2;
  const data = new Uint8ClampedArray(img.data);
  for (let i = 0; i < plane.data.length; i++) data[4 * i + offset] = plane.data[i]!;
  return { width: img.width, height: img.height, data };
}

/** An 8-bit grayscale PNG (one sample per pixel). */
export function grayPng(g: Gray): Uint8Array {
  return encodePng({
    width: g.width,
    height: g.height,
    data: Uint8Array.from(g.data),
    depth: 8,
    channels: 1,
  });
}

/** True when some pixel is not fully opaque. */
export function hasTransparency(img: RgbaImage): boolean {
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i] !== 255) return true;
  return false;
}

/** An 8-bit RGB PNG, or RGBA when the image has transparency. */
export function rgbaPng(img: RgbaImage): Uint8Array {
  const channels = hasTransparency(img) ? 4 : 3;
  const pixels = img.width * img.height;
  const data = new Uint8Array(pixels * channels);
  for (let i = 0; i < pixels; i++) {
    for (let c = 0; c < channels; c++) data[i * channels + c] = img.data[i * 4 + c]!;
  }
  return encodePng({ width: img.width, height: img.height, data, depth: 8, channels });
}

/** Decode a PNG written by this tool the way FTF decodes an uploaded file. */
export function readBackPng(png: Uint8Array): RgbaImage {
  const image = decodeImageExact(png);
  if (!image) throw new Error('the PNG written by the EMD tool cannot be decoded');
  return image;
}

// ---------- what the input file is ----------

/** Why the pixel values read from a file may not be the ones that were hidden in it. */
export type InputIssue =
  | { kind: 'jpeg' }
  | { kind: 'lossy'; format: string }
  | { kind: 'browser'; format: string }
  | { kind: 'depth16' }
  | { kind: 'depthLow'; depth: number }
  | { kind: 'palette' };

const ascii = (b: Uint8Array, from: number, len: number) =>
  String.fromCharCode(...b.subarray(from, from + len));

/**
 * Look at the file header: lossy formats destroy the digits, and a few lossless PNG layouts are
 * not read as raw 8-bit samples (16-bit: high byte only; palette: the palette colour, not the
 * index; under 8 bits: rescaled to 0..255).
 */
export function inputIssues(bytes: Uint8Array): InputIssue[] {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    const depth = bytes[24] ?? 8;
    const colorType = bytes[25];
    const out: InputIssue[] = [];
    if (depth === 16) out.push({ kind: 'depth16' });
    else if (depth < 8) out.push({ kind: 'depthLow', depth });
    if (colorType === 3) out.push({ kind: 'palette' });
    return out;
  }
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) {
    const bpp = (bytes[28] ?? 24) | ((bytes[29] ?? 0) << 8);
    return bpp <= 8 ? [{ kind: 'palette' }] : [];
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return [{ kind: 'jpeg' }];
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    const chunk = ascii(bytes, 12, 4);
    // VP8L is lossless; VP8 is lossy; VP8X (extended) can hold either, so it is not trusted.
    return chunk === 'VP8L'
      ? [{ kind: 'browser', format: 'WebP' }]
      : [{ kind: 'lossy', format: 'WebP' }];
  }
  if (ascii(bytes, 4, 4) === 'ftyp') {
    return [{ kind: 'lossy', format: ascii(bytes, 8, 4).trim() || 'AVIF/HEIC' }];
  }
  if (ascii(bytes, 0, 3) === 'GIF') return [{ kind: 'browser', format: 'GIF' }];
  return [{ kind: 'browser', format: 'image' }];
}
