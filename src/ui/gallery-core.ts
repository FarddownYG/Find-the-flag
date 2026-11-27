/**
 * The maths and data of the gallery viewer, apart from the DOM: zoom and pan, the pixel
 * inspector's reading, the PNG of an item and the ZIP of all of them.
 */
import { encode as encodePng } from 'fast-png';
import { zipSync } from 'fflate';
import type { GalleryItem, RgbaImage } from '../core/types';
import { utf8Encode } from '../lib/bytes';

export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 64;

/** Scale and top-left offset of the picture inside its viewport, in CSS pixels. */
export interface View {
  scale: number;
  x: number;
  y: number;
}

export const clampZoom = (z: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

/** The scale that shows the whole picture (never above 1:1 for a small one). */
export function fitView(vw: number, vh: number, iw: number, ih: number): View {
  if (iw <= 0 || ih <= 0 || vw <= 0 || vh <= 0) return { scale: 1, x: 0, y: 0 };
  const scale = clampZoom(Math.min(1, vw / iw, vh / ih));
  return { scale, x: (vw - iw * scale) / 2, y: (vh - ih * scale) / 2 };
}

/** The scale that fills the viewport with the picture, small pictures enlarged. */
export function fillView(vw: number, vh: number, iw: number, ih: number): View {
  if (iw <= 0 || ih <= 0 || vw <= 0 || vh <= 0) return { scale: 1, x: 0, y: 0 };
  const scale = clampZoom(Math.min(vw / iw, vh / ih));
  return { scale, x: (vw - iw * scale) / 2, y: (vh - ih * scale) / 2 };
}

/** Zoom by `factor` keeping the picture point under (cx, cy) fixed. */
export function zoomAt(view: View, factor: number, cx: number, cy: number): View {
  const scale = clampZoom(view.scale * factor);
  const k = scale / view.scale;
  return { scale, x: cx - (cx - view.x) * k, y: cy - (cy - view.y) * k };
}

/** The picture pixel under a viewport point, or null outside the picture. */
export function pixelUnder(
  view: View,
  px: number,
  py: number,
  iw: number,
  ih: number,
): { x: number; y: number } | null {
  const x = Math.floor((px - view.x) / view.scale);
  const y = Math.floor((py - view.y) / view.scale);
  return x >= 0 && y >= 0 && x < iw && y < ih ? { x, y } : null;
}

export interface PixelReading {
  x: number;
  y: number;
  rgba: [number, number, number, number];
  /** The 8 bits of each channel, most significant first. */
  bits: [string, string, string, string];
  hex: string;
}

const bits8 = (v: number) => v.toString(2).padStart(8, '0');

export function readPixel(img: RgbaImage, x: number, y: number): PixelReading | null {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return null;
  const o = (y * img.width + x) * 4;
  const [r, g, b, a] = [img.data[o]!, img.data[o + 1]!, img.data[o + 2]!, img.data[o + 3]!];
  const hex = [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
  return {
    x,
    y,
    rgba: [r, g, b, a],
    bits: [bits8(r), bits8(g), bits8(b), bits8(a)],
    hex: `#${hex}`,
  };
}

/** The item `delta` steps away, wrapping around the ends. */
export const stepIndex = (index: number, delta: number, count: number): number =>
  count <= 0 ? 0 : (((index + delta) % count) + count) % count;

/** A file name made of the label: letters, digits, dashes. */
export function itemFileName(item: GalleryItem): string {
  const stem = item.label
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${stem || item.id}.png`;
}

export const imageToPng = (img: RgbaImage): Uint8Array =>
  encodePng({ width: img.width, height: img.height, data: img.data, channels: 4, depth: 8 });

/** Every item as a PNG in one ZIP (stored: PNG is already compressed), plus an index of notes. */
export function zipItems(items: GalleryItem[]): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  const used = new Set<string>();
  const index: string[] = [];
  for (const item of items) {
    let name = itemFileName(item);
    for (let n = 2; used.has(name); n++) name = name.replace(/(-\d+)?\.png$/, `-${n}.png`);
    used.add(name);
    files[name] = imageToPng(item.image);
    index.push(`${name}\t${item.suspect ? 'look-first\t' : '\t'}${item.note ?? item.label}`);
  }
  files['index.txt'] = utf8Encode(`${index.join('\n')}\n`);
  return zipSync(files, { level: 0 });
}
