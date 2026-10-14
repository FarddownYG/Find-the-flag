/**
 * Piet, part 1: colours, codel size and the colour-block grid.
 *
 * A Piet program is an image. The image is cut into square "codels" (the smallest unit of
 * colour); neighbouring codels of one colour form a colour block. Everything here is pure: pixels
 * in, a grid of blocks out. The interpreter lives in _piet-vm.ts.
 */
import { ToolError } from '../../core/errors';
import type { RgbaImage } from '../../core/types';
import { toolT } from '../../i18n/tool-text';

const T = toolT('piet');

export const HUES = ['red', 'yellow', 'green', 'cyan', 'blue', 'magenta'] as const;
export const SHADES = ['light', 'normal', 'dark'] as const;

/** Codel kinds: 0..17 are colours (hue * 3 + shade), then white and black. */
export const WHITE = 18;
export const BLACK = 19;

/** Channels that are "high" for each hue (red, yellow, green, cyan, blue, magenta). */
const HUE_CHANNELS = [
  [1, 0, 0],
  [1, 1, 0],
  [0, 1, 0],
  [0, 1, 1],
  [0, 0, 1],
  [1, 0, 1],
] as const;
/** [high, low] channel values for light, normal and dark. */
const SHADE_LEVELS = [
  [0xff, 0xc0],
  [0xff, 0x00],
  [0xc0, 0x00],
] as const;

/** The 20 official colours as 0xRRGGBB, indexed by kind. */
export const PALETTE: readonly number[] = (() => {
  const out: number[] = [];
  for (const channels of HUE_CHANNELS) {
    for (const [high, low] of SHADE_LEVELS) {
      const [r, g, b] = channels.map((on) => (on ? high : low)) as [number, number, number];
      out.push((r << 16) | (g << 8) | b);
    }
  }
  out.push(0xffffff, 0x000000);
  return out;
})();

const KIND_OF_RGB = new Map<number, number>(PALETTE.map((rgb, kind) => [rgb, kind]));

export function kindName(kind: number): string {
  if (kind === WHITE) return 'white';
  if (kind === BLACK) return 'black';
  return `${SHADES[kind % 3]} ${HUES[Math.floor(kind / 3)]}`;
}

export function hexOf(rgb: number): string {
  return rgb.toString(16).padStart(6, '0').toUpperCase();
}

export type UnknownColours = 'white' | 'black' | 'nearest';

/** Exact Piet colour of 0xRRGGBB, or -1. */
export function classify(rgb: number): number {
  return KIND_OF_RGB.get(rgb) ?? -1;
}

/** The closest of the 20 colours (Euclidean distance in RGB). */
export function nearestKind(rgb: number): number {
  const r = (rgb >> 16) & 255;
  const g = (rgb >> 8) & 255;
  const b = rgb & 255;
  let best = 0;
  let bestDist = Infinity;
  PALETTE.forEach((p, kind) => {
    const dr = r - ((p >> 16) & 255);
    const dg = g - ((p >> 8) & 255);
    const db = b - (p & 255);
    const dist = dr * dr + dg * dg + db * db;
    if (dist < bestDist) {
      bestDist = dist;
      best = kind;
    }
  });
  return best;
}

/** Hue steps (0-5) and shade steps (0-2) from one colour to another: they pick the command. */
export function colourChange(from: number, to: number): { hue: number; shade: number } {
  return {
    hue: (Math.floor(to / 3) - Math.floor(from / 3) + 6) % 6,
    shade: ((to % 3) - (from % 3) + 3) % 3,
  };
}

/** How much of a picture is made of the Piet colours (for guessing, not for running). */
export interface PaletteProfile {
  /** Share (0..1) of the sampled pixels that are exactly one of the 20 colours. */
  share: number;
  /** Different hues (red .. magenta) among the sampled Piet-coloured pixels. */
  hues: number;
  /** Different Piet colours (white and black included) among them. */
  colours: number;
}

/** Look at up to ~20 000 pixels spread over the picture. Transparent pixels count as white. */
export function paletteProfile(image: RgbaImage): PaletteProfile {
  const { width, height, data } = image;
  const total = width * height;
  const stride = Math.max(1, Math.floor(total / 20_000));
  const colours = new Set<number>();
  const hues = new Set<number>();
  let sampled = 0;
  let piet = 0;
  for (let i = 0; i < total; i += stride) {
    sampled++;
    const kind = classify(flatten(data, i * 4));
    if (kind < 0) continue;
    piet++;
    colours.add(kind);
    if (kind < WHITE) hues.add(Math.floor(kind / 3));
  }
  return {
    share: sampled === 0 ? 0 : piet / sampled,
    hues: hues.size,
    colours: colours.size,
  };
}

// ---------- pixels to codels ----------

/** Pixel colour as 0xRRGGBB; transparent pixels are composited over white. */
function flatten(data: Uint8ClampedArray, i: number): number {
  const a = data[i + 3]!;
  let r = data[i]!;
  let g = data[i + 1]!;
  let b = data[i + 2]!;
  if (a !== 255) {
    r = Math.round((r * a + 255 * (255 - a)) / 255);
    g = Math.round((g * a + 255 * (255 - a)) / 255);
    b = Math.round((b * a + 255 * (255 - a)) / 255);
  }
  return (r << 16) | (g << 8) | b;
}

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

/**
 * The largest codel size that divides every run of identical pixels, horizontally and
 * vertically (a run is the unit the picture can not be finer than). Noisy images give 1.
 */
export function detectCodelSize(width: number, height: number, rgb: Int32Array): number {
  let g = 0;
  const column = new Int32Array(width).fill(1);
  for (let y = 0; y < height; y++) {
    let run = 1;
    const row = y * width;
    for (let x = 1; x < width; x++) {
      if (rgb[row + x] === rgb[row + x - 1]) run++;
      else {
        g = gcd(g, run);
        run = 1;
      }
    }
    g = gcd(g, run);
    if (g === 1) return 1;
    if (y > 0) {
      for (let x = 0; x < width; x++) {
        if (rgb[row + x] === rgb[row - width + x]) column[x]!++;
        else {
          g = gcd(g, column[x]!);
          column[x] = 1;
          if (g === 1) return 1;
        }
      }
    }
  }
  for (let x = 0; x < width; x++) g = gcd(g, column[x]!);
  return Math.max(1, g);
}

/** The colour of a codel: its pixels are normally all alike; otherwise the most common one. */
function codelColour(rgb: Int32Array, width: number, cx: number, cy: number, size: number): number {
  const first = rgb[cy * size * width + cx * size]!;
  if (size === 1) return first;
  let uniform = true;
  for (let y = 0; y < size && uniform; y++) {
    const row = (cy * size + y) * width + cx * size;
    for (let x = 0; x < size; x++) {
      if (rgb[row + x] !== first) {
        uniform = false;
        break;
      }
    }
  }
  if (uniform) return first;
  const counts = new Map<number, number>();
  let best = first;
  let bestCount = 0;
  for (let y = 0; y < size; y++) {
    const row = (cy * size + y) * width + cx * size;
    for (let x = 0; x < size; x++) {
      const v = rgb[row + x]!;
      const n = (counts.get(v) ?? 0) + 1;
      counts.set(v, n);
      if (n > bestCount) {
        best = v;
        bestCount = n;
      }
    }
  }
  return best;
}

// ---------- the block grid ----------

/** Direction pointer values: 0 right, 1 down, 2 left, 3 up (clockwise). */
export const DX = [1, 0, -1, 0] as const;
export const DY = [0, 1, 0, -1] as const;

export interface PietGrid {
  /** Size in codels. */
  width: number;
  height: number;
  /** Per codel: 0..17 colour, 18 white, 19 black. */
  kinds: Uint8Array;
  /** Per codel: colour block id, -1 for white and black. */
  blockOf: Int32Array;
  /** Per block. */
  blockKind: Uint8Array;
  blockSize: Int32Array;
  /** Per block: where its codels start in `order`. */
  blockStart: Int32Array;
  /** Codel indices, grouped by block. */
  order: Int32Array;
  blockCount: number;
  /** Cache of the 8 exit codels (4 DP x 2 CC) per block, filled on demand. */
  exits: Map<number, Int32Array>;
}

export interface BuildOptions {
  /** 0 = detect. */
  codel: number;
  unknown: UnknownColours;
}

export interface BuiltGrid {
  grid: PietGrid;
  /** Image size in pixels. */
  imageWidth: number;
  imageHeight: number;
  /** Codel size in pixels. */
  codel: number;
  detected: boolean;
  /** The image width/height was not a multiple of the codel size: the remainder is ignored. */
  cropped: boolean;
  /** Codels whose colour is not one of the 20 (they were mapped as per the option). */
  unknownCodels: number;
}

const MAX_PIXELS = 40_000_000;
const MAX_CODELS = 4_000_000;

export function buildGrid(image: RgbaImage, o: BuildOptions): BuiltGrid {
  const { width, height, data } = image;
  if (width < 1 || height < 1) throw new ToolError(T('error.empty'));
  if (width * height > MAX_PIXELS) {
    throw new ToolError(T('error.tooLarge', { width, height }));
  }
  const rgb = new Int32Array(width * height);
  for (let i = 0; i < rgb.length; i++) rgb[i] = flatten(data, i * 4);

  const detected = !(o.codel > 0);
  const codel = detected ? detectCodelSize(width, height, rgb) : Math.floor(o.codel);
  if (codel > width || codel > height) {
    throw new ToolError(T('error.codelTooLarge', { codel, width, height }));
  }
  const cw = Math.floor(width / codel);
  const ch = Math.floor(height / codel);
  const cropped = cw * codel !== width || ch * codel !== height;
  const n = cw * ch;
  if (n > MAX_CODELS) {
    throw new ToolError(T('error.tooManyCodels', { codels: n.toLocaleString('en-US') }));
  }

  // Colour of every codel.
  const kinds = new Uint8Array(n);
  const memo = new Map<number, number>();
  let unknownCodels = 0;
  for (let cy = 0; cy < ch; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      const colour = codelColour(rgb, width, cx, cy, codel);
      let kind = memo.get(colour);
      if (kind === undefined) {
        const exact = classify(colour);
        kind =
          exact >= 0
            ? exact
            : o.unknown === 'nearest'
              ? nearestKind(colour)
              : o.unknown === 'black'
                ? BLACK
                : WHITE;
        memo.set(colour, kind);
      }
      if (!KIND_OF_RGB.has(colour)) unknownCodels++;
      kinds[cy * cw + cx] = kind;
    }
  }

  // Colour blocks: 4-connected regions of one colour. The depth-first visit order puts the
  // codels of a block next to each other in `order`.
  const blockOf = new Int32Array(n).fill(-1);
  const blockKind = new Uint8Array(n);
  const blockSize = new Int32Array(n);
  const blockStart = new Int32Array(n);
  const order = new Int32Array(n);
  const pending = new Int32Array(n);
  let blocks = 0;
  let filled = 0;
  for (let i = 0; i < n; i++) {
    const k = kinds[i]!;
    if (k >= WHITE || blockOf[i] !== -1) continue;
    const id = blocks++;
    blockKind[id] = k;
    blockStart[id] = filled;
    let sp = 0;
    pending[sp++] = i;
    blockOf[i] = id;
    while (sp > 0) {
      const c = pending[--sp]!;
      order[filled++] = c;
      const x = c % cw;
      for (let d = 0; d < 4; d++) {
        if (
          (d === 0 && x === cw - 1) ||
          (d === 2 && x === 0) ||
          (d === 1 && c >= n - cw) ||
          (d === 3 && c < cw)
        ) {
          continue;
        }
        const m = c + DX[d]! + DY[d]! * cw;
        if (blockOf[m] === -1 && kinds[m] === k) {
          blockOf[m] = id;
          pending[sp++] = m;
        }
      }
    }
    blockSize[id] = filled - blockStart[id]!;
  }

  const grid: PietGrid = {
    width: cw,
    height: ch,
    kinds,
    blockOf,
    blockKind,
    blockSize,
    blockStart,
    order,
    blockCount: blocks,
    exits: new Map(),
  };
  return { grid, imageWidth: width, imageHeight: height, codel, detected, cropped, unknownCodels };
}

/**
 * The codel a block is left from, for a direction pointer (0 right, 1 down, 2 left, 3 up) and a
 * codel chooser (0 left, 1 right): the block's edge furthest along the DP, then the codel on that
 * edge furthest along the CC. The CC points 90 degrees counter-clockwise (left) or clockwise
 * (right) of the DP.
 */
export function exitCodel(grid: PietGrid, block: number, dp: number, cc: number): number {
  let exits = grid.exits.get(block);
  if (!exits) {
    exits = computeExits(grid, block);
    grid.exits.set(block, exits);
  }
  return exits[dp * 2 + cc]!;
}

function computeExits(grid: PietGrid, block: number): Int32Array {
  const { width, order, blockStart, blockSize } = grid;
  const best = new Float64Array(8).fill(-Infinity);
  const cell = new Int32Array(8);
  // The edge dominates: weigh it far above any position along the edge.
  const EDGE = 2 ** 24;
  const start = blockStart[block]!;
  for (let j = start; j < start + blockSize[block]!; j++) {
    const c = order[j]!;
    const x = c % width;
    const y = (c - x) / width;
    for (let dp = 0; dp < 4; dp++) {
      const edge = DX[dp]! * x + DY[dp]! * y;
      for (let cc = 0; cc < 2; cc++) {
        const side = (dp + (cc === 0 ? 3 : 1)) % 4;
        const score = edge * EDGE + (DX[side]! * x + DY[side]! * y);
        const slot = dp * 2 + cc;
        if (score > best[slot]!) {
          best[slot] = score;
          cell[slot] = c;
        }
      }
    }
  }
  return cell;
}
