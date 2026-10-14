/**
 * Synthetic PNGs for the PNG chunk surgeon: its samples (scripts/gen-samples-png-surgeon.mjs
 * loads this file through Vite) and its tests. Everything is drawn here with a hand-rolled
 * bitmap font and encoded with fast-png; no real challenge file is used.
 */
import { encode as encodePng } from 'fast-png';
import { zipSync } from 'fflate';
import type { RgbaImage } from '../../core/types';
import { concatBytes, latin1Encode, utf8Encode } from '../../lib/bytes';
import { crc32 } from '../../lib/signatures';

// ---------------------------------------------------------------- drawing

/** 5x7 capitals and digits. */
const FONT: Record<string, string[]> = {
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.###.'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  I: ['.###.', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  J: ['..###', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  N: ['#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  Q: ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '##.##', '#...#'],
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
  '0': ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  '3': ['#####', '...#.', '..#..', '...#.', '....#', '#...#', '.###.'],
  '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  '6': ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
  '7': ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  '9': ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
  '-': ['.....', '.....', '.....', '#####', '.....', '.....', '.....'],
  '.': ['.....', '.....', '.....', '.....', '.....', '.##..', '.##..'],
};

export interface TextLine {
  text: string;
  x: number;
  y: number;
  scale: number;
}

/** 8-bit RGB raster. */
export interface RgbImage {
  width: number;
  height: number;
  data: Uint8Array;
}

/** A light gradient card with dark capitals on it (gradient: every row and column differ). */
export function drawCard(width: number, height: number, lines: TextLine[]): RgbImage {
  const data = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 3;
      data[o] = (236 - (x * 40) / width) | 0;
      data[o + 1] = (226 + ((x + y) * 20) / (width + height)) | 0;
      data[o + 2] = (250 - (y * 60) / height) | 0;
    }
  }
  for (const line of lines) {
    let cx = line.x;
    for (const ch of line.text) {
      const glyph = FONT[ch];
      if (!glyph) throw new Error(`no glyph for ${ch}`);
      glyph.forEach((row, gy) => {
        [...row].forEach((px, gx) => {
          if (px !== '#') return;
          for (let dy = 0; dy < line.scale; dy++) {
            for (let dx = 0; dx < line.scale; dx++) {
              const x = cx + gx * line.scale + dx;
              const y = line.y + gy * line.scale + dy;
              if (x < 0 || y < 0 || x >= width || y >= height) continue;
              const o = (y * width + x) * 3;
              data[o] = 24;
              data[o + 1] = 32 + ((x * 3) & 31);
              data[o + 2] = 72;
            }
          }
        });
      });
      cx += 6 * line.scale;
    }
  }
  return { width, height, data };
}

export function rgbToRgba(img: RgbImage): RgbaImage {
  const n = img.width * img.height;
  const data = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    data[i * 4] = img.data[i * 3]!;
    data[i * 4 + 1] = img.data[i * 3 + 1]!;
    data[i * 4 + 2] = img.data[i * 3 + 2]!;
    data[i * 4 + 3] = 255;
  }
  return { width: img.width, height: img.height, data };
}

// ---------------------------------------------------------------- PNG bytes

const be32 = (n: number) =>
  new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);

export function pngChunk(type: string, data: Uint8Array, crc?: number): Uint8Array {
  const t = latin1Encode(type);
  return concatBytes(be32(data.length), t, data, be32(crc ?? crc32(concatBytes(t, data))));
}

export const PNG_SIG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function tEXt(keyword: string, text: string): Uint8Array {
  return pngChunk(
    'tEXt',
    concatBytes(latin1Encode(keyword), new Uint8Array([0]), latin1Encode(text)),
  );
}

/** IHDR payload and the whole zlib stream of a fast-png encoding. */
export function encodeParts(
  img: RgbImage,
  interlace: 'null' | 'Adam7' = 'null',
): { ihdr: Uint8Array; zlib: Uint8Array } {
  const png = encodePng(
    { width: img.width, height: img.height, data: img.data, channels: 3, depth: 8 },
    { interlace },
  );
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let ihdr = new Uint8Array(0);
  const idat: Uint8Array[] = [];
  for (let p = 8; p + 12 <= png.length;) {
    const len = dv.getUint32(p);
    const type = String.fromCharCode(...png.subarray(p + 4, p + 8));
    const data = png.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') ihdr = data.slice();
    if (type === 'IDAT') idat.push(data);
    p += 12 + len;
  }
  return { ihdr, zlib: concatBytes(...idat) };
}

/** Deterministic pseudo-random generator (mulberry32). */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Cut a stream into `count` pieces of uneven, deterministic sizes. */
export function splitStream(stream: Uint8Array, count: number, seed = 7): Uint8Array[] {
  const rnd = prng(seed);
  const weights = Array.from({ length: count }, () => 0.6 + rnd());
  const sum = weights.reduce((a, b) => a + b, 0);
  const cuts = [0];
  let acc = 0;
  for (let i = 0; i < count - 1; i++) {
    acc += weights[i]!;
    cuts.push(Math.max(cuts[cuts.length - 1]! + 1, Math.round((acc / sum) * stream.length)));
  }
  cuts.push(stream.length);
  return cuts.slice(0, -1).map((c, i) => stream.subarray(c, cuts[i + 1]!));
}

/**
 * Pieces in file order for a "chunk→position" sequence: file chunk j is piece seq[j] - 1
 * (1-based sequence), so out[seq[j] - 1] = file[j] restores the stream.
 */
export function shuffleByPositions(pieces: Uint8Array[], seq: number[]): Uint8Array[] {
  return seq.map((pos) => pieces[pos - 1]!);
}

export interface Assembly {
  ihdr: Uint8Array;
  idats: Uint8Array[];
  before?: Uint8Array[];
  after?: Uint8Array[];
  trailing?: Uint8Array;
}

export function assemble(a: Assembly): Uint8Array {
  return concatBytes(
    PNG_SIG,
    pngChunk('IHDR', a.ihdr),
    ...(a.before ?? []),
    ...a.idats.map((d) => pngChunk('IDAT', d)),
    ...(a.after ?? []),
    pngChunk('IEND', new Uint8Array(0)),
    a.trailing ?? new Uint8Array(0),
  );
}

// ---------------------------------------------------------------- the samples

export const SAMPLE_W = 320;
export const SAMPLE_H = 120;
/** The order hint of png-shuffled-idat.png, read as chunk→position. */
export const SHUFFLE_SEQ = [4, 9, 1, 11, 6, 2, 8, 10, 3, 7, 5];
/** File order of png-no-hint.png (chunk→position, no hint stored). */
export const NO_HINT_SEQ = [7, 3, 10, 1, 5, 11, 2, 9, 4, 6, 8];

const TITLE: TextLine = { text: 'FTF CHUNK SURGEON', x: 9, y: 16, scale: 3 };

export function shuffledOriginal(): RgbImage {
  return drawCard(SAMPLE_W, SAMPLE_H, [
    TITLE,
    { text: 'IDAT ORDER RESTORED', x: 46, y: 76, scale: 2 },
  ]);
}

export function noHintOriginal(): RgbImage {
  return drawCard(SAMPLE_W, SAMPLE_H, [
    TITLE,
    { text: 'FOUND WITHOUT A HINT', x: 40, y: 76, scale: 2 },
  ]);
}

export function brokenOriginal(): RgbImage {
  return drawCard(SAMPLE_W, SAMPLE_H, [
    TITLE,
    { text: 'HIDDEN BOTTOM HALF', x: 52, y: 84, scale: 2 },
  ]);
}

const COMMENT = 'Synthetic sample made by gen-samples-png-surgeon.mjs for Find The Flag.';

/** 11 IDAT chunks shuffled; tEXt "order" holds the chunk→position sequence. */
export function buildShuffled(): Uint8Array {
  const { ihdr, zlib } = encodeParts(shuffledOriginal());
  const pieces = splitStream(zlib, SHUFFLE_SEQ.length, 11);
  return assemble({
    ihdr,
    before: [tEXt('Comment', COMMENT), tEXt('order', SHUFFLE_SEQ.join(' '))],
    idats: shuffleByPositions(pieces, SHUFFLE_SEQ),
  });
}

/** 11 IDAT chunks shuffled and no hint at all: the order has to be searched. */
export function buildNoHint(): Uint8Array {
  const { ihdr, zlib } = encodeParts(noHintOriginal());
  const pieces = splitStream(zlib, NO_HINT_SEQ.length, 23);
  return assemble({
    ihdr,
    before: [tEXt('Comment', COMMENT)],
    idats: shuffleByPositions(pieces, NO_HINT_SEQ),
  });
}

/** The ZIP glued after IEND of png-broken.png. */
export function brokenZip(): Uint8Array {
  return zipSync(
    {
      'readme.txt': utf8Encode(
        'Synthetic payload appended after IEND by gen-samples-png-surgeon.mjs.\n',
      ),
    },
    // Local components: fflate writes the DOS date from local getters, so the bytes are the
    // same in every time zone.
    { mtime: new Date(2024, 0, 1, 12, 0, 0) },
  );
}

/**
 * Everything at once: one wrong signature byte, a zeroed zlib header in the first IDAT, the
 * CRCs of tEXt and of the third IDAT wrong, the IHDR height halved (its CRC still matches the
 * real height) and a ZIP after IEND.
 */
export function buildBroken(): Uint8Array {
  const { ihdr, zlib } = encodeParts(brokenOriginal());
  const pieces = splitStream(zlib, 4, 5).map((p) => p.slice());
  pieces[0]![0] = 0;
  pieces[0]![1] = 0;
  const realCrc = crc32(concatBytes(latin1Encode('IHDR'), ihdr));
  const low = ihdr.slice();
  new DataView(low.buffer).setUint32(4, SAMPLE_H / 2);
  const text = tEXt('Comment', COMMENT);
  const textBad = text.slice();
  textBad[textBad.length - 1]! ^= 0xff;
  const idats = pieces.map((d, i) => {
    const c = pngChunk('IDAT', d);
    if (i === 2) c[c.length - 2]! ^= 0x5a;
    return c;
  });
  const png = concatBytes(
    PNG_SIG,
    pngChunk('IHDR', low, realCrc),
    textBad,
    ...idats,
    pngChunk('IEND', new Uint8Array(0)),
    brokenZip(),
  );
  png[5] = 0x00;
  return png;
}
