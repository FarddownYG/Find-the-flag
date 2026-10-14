import { ToolError } from '../../core/errors';
import type { RgbaImage } from '../../core/types';
import { toolT } from '../../i18n/tool-text';

const T = toolT('lsb');

export type PixelOrder = 'row' | 'col';
export type BitOrder = 'msb' | 'lsb';

export interface LsbParams {
  /** Indices into RGBA (0 = R ... 3 = A), in reading order. */
  channels: number[];
  /** Bit planes to read from every channel (0 = least significant). */
  planes: number[];
  order: PixelOrder;
  bitOrder: BitOrder;
}

const CHANNEL_INDEX: Record<string, number> = { r: 0, g: 1, b: 2, a: 3 };
const CHANNEL_LETTERS = ['r', 'g', 'b', 'a'];

export const channelsToString = (channels: number[]) =>
  channels.map((c) => CHANNEL_LETTERS[c]).join('');

/** "rgb", "bgr", "rgba", "a" ... any sequence of r/g/b/a (repeats allowed). */
export function parseChannels(text: string): number[] {
  const letters = [...text.toLowerCase().replace(/[\s,]/g, '')];
  if (!letters.length) {
    throw new ToolError(T('error.noChannel'));
  }
  return letters.map((l) => {
    const idx = CHANNEL_INDEX[l];
    if (idx === undefined) {
      throw new ToolError(T('error.badChannel', { letter: l }));
    }
    return idx;
  });
}

/** "0", "0,1", "0-2", "7": sorted unique bit numbers, 0 = least significant. */
export function parsePlanes(text: string): number[] {
  const set = new Set<number>();
  for (const part of text.split(/[\s,]+/).filter(Boolean)) {
    const m = /^(\d)(?:-(\d))?$/.exec(part);
    if (!m) throw new ToolError(T('error.badBits', { part }));
    const lo = Number(m[1]);
    const hi = m[2] === undefined ? lo : Number(m[2]);
    if (hi < lo) throw new ToolError(T('error.badRange', { part }));
    if (hi > 7) throw new ToolError(T('error.noSuchBit', { bit: hi }));
    for (let b = lo; b <= hi; b++) set.add(b);
  }
  if (!set.size) throw new ToolError(T('error.noPlane'));
  return [...set].sort((a, b) => a - b);
}

export const planesLabel = (planes: number[]) =>
  planes.length === 1
    ? T('value.bit', { bit: planes[0]! })
    : T('value.bits', { bits: planes.join(',') });

export const paramsLabel = (p: LsbParams) =>
  [
    channelsToString(p.channels),
    planesLabel(p.planes),
    p.order === 'row' ? T('value.rowMajor') : T('value.colMajor'),
    p.bitOrder === 'msb' ? T('value.msbFirst') : T('value.lsbFirst'),
  ].join(', ');

/**
 * Read the selected bit planes of every pixel and pack them into bytes.
 * Pixels are visited row by row (x fastest) or column by column (y fastest); inside a pixel the
 * channels are read in the given order. With several planes per channel, they are read from the
 * high bit to the low bit for MSB-first packing and low to high for LSB-first, which is what
 * "write the next n message bits into the low n bits" embedders produce.
 */
export function extractBits(img: RgbaImage, p: LsbParams, maxBytes = Infinity): Uint8Array {
  const { width: w, height: h, data } = img;
  const planes = p.bitOrder === 'msb' ? [...p.planes].reverse() : p.planes;
  const perPixel = p.channels.length * planes.length;
  const total = w * h;
  const outLen = Math.min(maxBytes, Math.floor((total * perPixel) / 8));
  const out = new Uint8Array(outLen);
  const msb = p.bitOrder === 'msb';
  let acc = 0;
  let nb = 0;
  let o = 0;
  for (let k = 0; k < total && o < outLen; k++) {
    let pix = k;
    if (p.order === 'col') {
      const y = k % h;
      pix = y * w + (k - y) / h;
    }
    const base = pix * 4;
    for (const ch of p.channels) {
      const v = data[base + ch]!;
      for (const pl of planes) {
        const bit = (v >> pl) & 1;
        if (msb) acc = (acc << 1) | bit;
        else acc |= bit << nb;
        if (++nb === 8) {
          if (o < outLen) out[o++] = acc & 0xff;
          acc = 0;
          nb = 0;
        }
      }
    }
  }
  return out;
}

/** Number of bytes a full extraction yields. */
export const capacityBytes = (img: RgbaImage, p: LsbParams) =>
  Math.floor((img.width * img.height * p.channels.length * p.planes.length) / 8);
