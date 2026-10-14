/**
 * Test kit for the PNG chunk surgeon regression suites: synthetic pictures in every PNG format
 * (fast-png encodes them), their zlib stream cut into IDAT payloads, shuffled for either
 * reading of an order hint, text chunk builders, a chunk writer that can lie about lengths,
 * types and CRCs, and the checks that a restoration is exact. Nothing here is a real challenge.
 */
import { decode as decodePng, encode as encodePng } from 'fast-png';
import { zlibSync } from 'fflate';
import { expect } from 'vitest';
import { decodeImageExact } from '../../core/decode-image';
import type { Output, RgbaImage } from '../../core/types';
import { concatBytes, latin1Encode, utf8Encode } from '../../lib/bytes';
import { crc32 } from '../../lib/signatures';
import tool from './png-surgeon';
import { PNG_SIGNATURE } from './_png';
import { DEFAULT_OPTIONS, type SurgeryOptions } from './_png-surgeon-core';
import { drawCard, prng, type TextLine } from './_png-surgeon-fixtures';
import { applyReading, type Reading } from './_png-surgeon-order';

export type Opts = Partial<SurgeryOptions>;
export const SIG = new Uint8Array(PNG_SIGNATURE);

// ---------------------------------------------------------------- running the tool

export const run = (bytes: Uint8Array, opts: Opts = {}, name = 'test.png') =>
  tool.run({ bytes, name }, { ...DEFAULT_OPTIONS, ...opts }) as Output[];

export function summary(out: Output[]): { level: string; text: string } {
  const n = out[0];
  if (n?.type !== 'note') throw new Error('no summary');
  return n;
}
export const imageOf = (out: Output[]) => {
  const o = out.find((x) => x.type === 'image');
  return o?.type === 'image' ? o : null;
};
export const filesOf = (out: Output[]) => {
  const o = out.find((x) => x.type === 'files');
  return o?.type === 'files' ? o.files : [];
};
export const repaired = (out: Output[]) =>
  filesOf(out).find((f) => f.name.endsWith('-repaired.png'))?.data ?? null;
export const actionsOf = (out: Output[]) =>
  out.flatMap((o) => (o.type === 'actions' ? o.actions : []));
export const reorderIds = (out: Output[]) => {
  const o = out.find((x) => x.type === 'reorder');
  return o?.type === 'reorder' ? o.items.map((i) => i.id) : null;
};
export const tableOf = (out: Output[], label: string) => {
  const o = out.find((x) => x.type === 'table' && x.label === label);
  return o?.type === 'table' ? o : null;
};
export const kvOf = (out: Output[], label: string): Record<string, string> => {
  const o = out.find((x) => x.type === 'kv' && x.label === label);
  return o?.type === 'kv' ? Object.fromEntries(o.entries) : {};
};
export const textBlocks = (out: Output[]) =>
  out.flatMap((o) => (o.type === 'text' ? [o.value] : [])).join('\n');
export const notes = (out: Output[]) =>
  out.flatMap((o) => (o.type === 'note' ? [o.text] : [])).join('\n');

// ---------------------------------------------------------------- pictures

export interface Picture {
  width: number;
  height: number;
  /** Samples as fast-png takes them (Uint16Array for 16-bit). */
  data: Uint8Array | Uint16Array;
  channels: 1 | 2 | 3 | 4;
  depth: 1 | 2 | 4 | 8 | 16;
  palette?: number[][];
}

export const TEXT = (text: string, x = 2, y = 2, scale = 1): TextLine => ({ text, x, y, scale });

/** The drawing as RGB8, then converted to the format asked for. */
export function picture(
  width: number,
  height: number,
  lines: TextLine[],
  format: 'rgb8' | 'rgba8' | 'gray8' | 'gray16' | 'graya16' | 'rgba16' | 'palette8' | 'palette4',
): Picture {
  const rgb = drawCard(width, height, lines);
  const n = width * height;
  const px = (i: number) => [rgb.data[i * 3]!, rgb.data[i * 3 + 1]!, rgb.data[i * 3 + 2]!];
  const gray = (i: number) => {
    const [r, g, b] = px(i);
    return Math.round((r! * 3 + g! * 6 + b!) / 10);
  };
  switch (format) {
    case 'rgb8':
      return { width, height, data: rgb.data, channels: 3, depth: 8 };
    case 'rgba8': {
      const d = new Uint8Array(n * 4);
      for (let i = 0; i < n; i++) d.set([...px(i), 255 - ((i * 7) % 64)], i * 4);
      return { width, height, data: d, channels: 4, depth: 8 };
    }
    case 'gray8':
      return {
        width,
        height,
        data: Uint8Array.from({ length: n }, (_, i) => gray(i)),
        channels: 1,
        depth: 8,
      };
    case 'gray16':
      return {
        width,
        height,
        data: Uint16Array.from({ length: n }, (_, i) => gray(i) * 257 + (i % 251)),
        channels: 1,
        depth: 16,
      };
    case 'graya16': {
      const d = new Uint16Array(n * 2);
      for (let i = 0; i < n; i++) d.set([gray(i) * 257 + (i % 199), 65535 - i * 13], i * 2);
      return { width, height, data: d, channels: 2, depth: 16 };
    }
    case 'rgba16': {
      const d = new Uint16Array(n * 4);
      for (let i = 0; i < n; i++) {
        const [r, g, b] = px(i);
        d.set([r! * 257 + (i % 97), g! * 257, b! * 257 + (i % 31), 60000 - (i % 4000)], i * 4);
      }
      return { width, height, data: d, channels: 4, depth: 16 };
    }
    case 'palette8':
    case 'palette4': {
      // 16 colours: the gray level in 16 steps, with alpha on the darkest (writes tRNS).
      const palette = Array.from({ length: 16 }, (_, k) =>
        format === 'palette8'
          ? [k * 16, 255 - k * 12, (k * 37) % 256, k < 3 ? 128 : 255]
          : [k * 16, 200, 255 - k * 16],
      );
      const index = (i: number) => gray(i) >> 4;
      if (format === 'palette8') {
        const d = Uint8Array.from({ length: n }, (_, i) => index(i));
        return { width, height, data: d, channels: 1, depth: 8, palette };
      }
      // 4-bit: two pixels per byte, each row padded to a whole byte.
      const rowBytes = Math.ceil(width / 2);
      const d = new Uint8Array(rowBytes * height);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          d[y * rowBytes + (x >> 1)]! |= index(y * width + x) << (x & 1 ? 0 : 4);
        }
      }
      return { width, height, data: d, channels: 1, depth: 4, palette };
    }
  }
}

/** Every sample random in [0, max]: no structure at all (stored blocks, filter-byte proof). */
export function noise(width: number, height: number, seed: number, max = 255): Picture {
  const r = prng(seed);
  const data = Uint8Array.from({ length: width * height * 3 }, () => Math.floor(r() * (max + 1)));
  return { width, height, data, channels: 3, depth: 8 };
}

export interface Encoded {
  png: Uint8Array;
  ihdr: Uint8Array;
  /** PLTE, tRNS…: the chunks between IHDR and the image data. */
  before: Uint8Array[];
  zlib: Uint8Array;
}

/** fast-png encoding, taken apart: IHDR payload, the chunks before IDAT, the zlib stream. */
export function encode(
  pic: Picture,
  opts: { interlace?: 'null' | 'Adam7'; level?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 } = {},
): Encoded {
  const png = encodePng(
    {
      width: pic.width,
      height: pic.height,
      data: pic.data,
      channels: pic.channels,
      depth: pic.depth,
      palette: pic.palette,
    },
    {
      interlace: opts.interlace ?? 'null',
      zlib: opts.level === undefined ? undefined : { level: opts.level },
    },
  );
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let ihdr = new Uint8Array(0);
  const before: Uint8Array[] = [];
  const idat: Uint8Array[] = [];
  for (let p = 8; p + 12 <= png.length;) {
    const len = dv.getUint32(p);
    const type = String.fromCharCode(...png.subarray(p + 4, p + 8));
    const data = png.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') ihdr = data.slice();
    else if (type === 'IDAT') idat.push(data);
    else if (type !== 'IEND') before.push(png.slice(p, p + 12 + len));
    p += 12 + len;
  }
  return { png, ihdr, before, zlib: concatBytes(...idat) };
}

/** A zlib stream of raw rows (filter byte 0 + samples) at a given level (0 = stored blocks). */
export function rawStream(pic: Picture, level: 0 | 6 = 0): { ihdr: Uint8Array; zlib: Uint8Array } {
  const rowBytes = pic.width * pic.channels;
  const raw = new Uint8Array((rowBytes + 1) * pic.height);
  for (let y = 0; y < pic.height; y++) {
    raw.set(
      pic.data.subarray(y * rowBytes, (y + 1) * rowBytes) as Uint8Array,
      y * (rowBytes + 1) + 1,
    );
  }
  return {
    ihdr: ihdrBytes(pic.width, pic.height, 8, pic.channels === 4 ? 6 : 2),
    zlib: zlibSync(raw, { level }),
  };
}

export function ihdrBytes(w: number, h: number, depth: number, colour: number, interlace = 0) {
  const b = new Uint8Array(13);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  b.set([depth, colour, 0, 0, interlace], 8);
  return b;
}

// ---------------------------------------------------------------- chunks

const be32 = (n: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0);
  return b;
};

/** A chunk; `length` / `crc` override the true values (to damage them). */
export function chunk(
  type: string | Uint8Array,
  data: Uint8Array,
  over: { length?: number; crc?: number; crcType?: string } = {},
) {
  const t = typeof type === 'string' ? latin1Encode(type) : type;
  const crcT = over.crcType ? latin1Encode(over.crcType) : t;
  return concatBytes(
    be32(over.length ?? data.length),
    t,
    data,
    be32(over.crc ?? crc32(concatBytes(crcT, data))),
  );
}
export const IEND = () => chunk('IEND', new Uint8Array(0));
export const tEXt = (keyword: string, text: string) =>
  chunk('tEXt', concatBytes(latin1Encode(keyword), new Uint8Array([0]), latin1Encode(text)));
export const zTXt = (keyword: string, text: string) =>
  chunk(
    'zTXt',
    concatBytes(latin1Encode(keyword), new Uint8Array([0, 0]), zlibSync(latin1Encode(text))),
  );
export const iTXt = (keyword: string, text: string, compressed: boolean, lang = '', trans = '') =>
  chunk(
    'iTXt',
    concatBytes(
      latin1Encode(keyword),
      new Uint8Array([0, compressed ? 1 : 0, 0]),
      latin1Encode(lang),
      new Uint8Array([0]),
      utf8Encode(trans),
      new Uint8Array([0]),
      compressed ? zlibSync(utf8Encode(text)) : utf8Encode(text),
    ),
  );

/** Cut a stream into `count` near-equal pieces, or at the given sizes (the rest goes last). */
export function cut(stream: Uint8Array, count: number | number[]): Uint8Array[] {
  const sizes = Array.isArray(count) ? count : null;
  const n = sizes ? sizes.length + 1 : (count as number);
  const out: Uint8Array[] = [];
  let p = 0;
  for (let i = 0; i < n - 1; i++) {
    const size = sizes ? sizes[i]! : Math.round(stream.length / n);
    out.push(stream.subarray(p, p + size));
    p += size;
  }
  out.push(stream.subarray(p));
  return out;
}

/**
 * The IDAT payloads in file order such that `seq` (1-based, or 0-based when it holds 0) read
 * with `reading` puts them back: restored[i] = file[order[i]].
 */
export function fileOrder(pieces: Uint8Array[], seq: number[], reading: Reading): Uint8Array[] {
  const zero = seq.includes(0);
  const order = applyReading(
    seq.map((v) => (zero ? v : v - 1)),
    reading,
  );
  const file = new Array<Uint8Array>(pieces.length);
  order.forEach((f, i) => (file[f] = pieces[i]!));
  return file;
}

/** A seeded shuffle of 1..n that is not the identity. */
export function shuffled(n: number, seed: number): number[] {
  const r = prng(seed);
  for (;;) {
    const s = Array.from({ length: n }, (_, i) => i + 1);
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [s[i], s[j]] = [s[j]!, s[i]!];
    }
    if (s.some((v, i) => v !== i + 1)) return s;
  }
}

export const inverse = (seq: number[]) => {
  const out = new Array<number>(seq.length);
  seq.forEach((v, i) => (out[v - 1] = i + 1));
  return out;
};

export function png(parts: {
  ihdr: Uint8Array;
  before?: Uint8Array[];
  idats: Uint8Array[];
  after?: Uint8Array[];
  tail?: Uint8Array;
  sig?: Uint8Array;
}): Uint8Array {
  return concatBytes(
    parts.sig ?? SIG,
    chunk('IHDR', parts.ihdr),
    ...(parts.before ?? []),
    ...parts.idats.map((d) => chunk('IDAT', d)),
    ...(parts.after ?? []),
    IEND(),
    parts.tail ?? new Uint8Array(0),
  );
}

// ---------------------------------------------------------------- exactness

/** The tool's restored image is the clean picture, pixel for pixel. */
export function expectPixels(out: Output[], clean: Uint8Array): void {
  const want = decodeImageExact(clean)!;
  const img = imageOf(out);
  expect(img, summary(out).text).not.toBeNull();
  const got: RgbaImage = img!.image;
  expect([got.width, got.height]).toEqual([want.width, want.height]);
  let diff = 0;
  for (let i = 0; i < want.data.length; i++) if (got.data[i] !== want.data[i]) diff++;
  expect(diff, summary(out).text).toBe(0);
}

/** The downloaded file decodes (fast-png, on its own) to the clean samples, 16-bit and palette too. */
export function expectSamples(out: Output[], clean: Uint8Array): void {
  const file = repaired(out);
  expect(file, summary(out).text).not.toBeNull();
  const a = decodePng(file!);
  const b = decodePng(clean);
  expect([a.width, a.height, a.depth, a.channels]).toEqual([
    b.width,
    b.height,
    b.depth,
    b.channels,
  ]);
  expect(Array.from(a.data)).toEqual(Array.from(b.data));
  expect(a.palette ?? null).toEqual(b.palette ?? null);
}

/** Restored exactly: success summary, same pixels, same samples in the repaired file. */
export function expectRestored(out: Output[], clean: Uint8Array): void {
  expect(summary(out).level, summary(out).text).toBe('success');
  expectPixels(out, clean);
  expectSamples(out, clean);
}

/** Never a success with wrong pixels: either restored exactly, or not called a success. */
export function expectHonest(out: Output[], clean: Uint8Array): 'restored' | 'not' {
  if (summary(out).level !== 'success') return 'not';
  expectPixels(out, clean);
  return 'restored';
}
