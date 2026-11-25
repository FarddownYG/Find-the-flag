import { describe, expect, it } from 'vitest';
import { encode } from 'fast-png';
import { decodeImageExact, decodeNetpbm } from './decode-image';

/** Small deterministic generator (xorshift32). */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s;
  };
}

const randomBytes = (len: number, seed: number) => {
  const next = rng(seed);
  return Uint8Array.from({ length: len }, () => next() & 0xff);
};

const decode = (png: Uint8Array) => {
  const img = decodeImageExact(png);
  if (!img) throw new Error('not decoded');
  return img;
};

// Pixel-exact reading is what every stego tool relies on: these pin down which values come out.
describe('decodeImageExact: PNG sample values', () => {
  it('returns the raw 8-bit value of every grayscale sample', () => {
    const data = Uint8Array.from({ length: 256 }, (_, i) => i);
    const img = decode(encode({ width: 16, height: 16, data, depth: 8, channels: 1 }));
    for (let i = 0; i < 256; i++) {
      expect([...img.data.subarray(4 * i, 4 * i + 4)]).toEqual([i, i, i, 255]);
    }
  });

  it('returns the raw 8-bit values of RGB and RGBA images, alpha 0 pixels included', () => {
    const rgb = randomBytes(40 * 30 * 3, 1);
    const a = decode(encode({ width: 40, height: 30, data: rgb, depth: 8, channels: 3 }));
    for (let i = 0; i < 40 * 30; i++) {
      expect([...a.data.subarray(4 * i, 4 * i + 4)]).toEqual([
        rgb[3 * i],
        rgb[3 * i + 1],
        rgb[3 * i + 2],
        255,
      ]);
    }
    const rgba = randomBytes(40 * 30 * 4, 2);
    for (let i = 0; i < 40 * 30; i += 7) rgba[4 * i + 3] = 0; // transparent, colour kept
    const b = decode(encode({ width: 40, height: 30, data: rgba, depth: 8, channels: 4 }));
    expect([...b.data]).toEqual([...rgba]);
  });

  it('reads an Adam7 interlaced PNG exactly too', () => {
    const data = randomBytes(37 * 23, 3);
    const png = encode(
      { width: 37, height: 23, data, depth: 8, channels: 1 },
      { interlace: 'Adam7' },
    );
    expect(png[28]).toBe(1); // IHDR interlace method: Adam7
    const img = decode(png);
    for (let i = 0; i < 37 * 23; i++) expect(img.data[4 * i]).toBe(data[i]);
  });

  it('keeps only the high byte of a 16-bit sample', () => {
    const data = new Uint16Array([0x1234, 0x12ff, 0xff00, 0x00ff, 0xabcd, 0x0000]);
    const img = decode(encode({ width: 3, height: 2, data, depth: 16, channels: 1 }));
    expect([0, 1, 2, 3, 4, 5].map((i) => img.data[4 * i])).toEqual([
      0x12, 0x12, 0xff, 0x00, 0xab, 0x00,
    ]);
  });

  it('gives the palette colour, not the palette index, for an indexed PNG', () => {
    const palette = [
      [10, 20, 30],
      [200, 100, 50],
      [7, 7, 7],
    ];
    const data = Uint8Array.from([0, 1, 2, 1, 0, 2]);
    const img = decode(encode({ width: 3, height: 2, data, depth: 8, channels: 1, palette }));
    expect([0, 1, 2].map((i) => [...img.data.subarray(4 * i, 4 * i + 3)])).toEqual(palette);
  });

  it('rescales samples under 8 bits to 0..255', () => {
    const data = Uint8Array.from({ length: 16 }, (_, i) => i); // 4-bit gray ramp
    const packed = new Uint8Array(8);
    for (let i = 0; i < 16; i++) packed[i >> 1] = (packed[i >> 1] ?? 0) | (i << (i % 2 ? 0 : 4));
    const img = decode(encode({ width: 16, height: 1, data: packed, depth: 4, channels: 1 }));
    expect([...data].map((i) => img.data[4 * i])).toEqual([...data].map((v) => v * 17));
  });
});

describe('decodeNetpbm: PBM / PGM / PPM', () => {
  const enc = new TextEncoder();
  const cat = (...parts: (string | number[] | Uint8Array)[]): Uint8Array => {
    const chunks = parts.map((p) =>
      typeof p === 'string' ? enc.encode(p) : p instanceof Uint8Array ? p : Uint8Array.from(p),
    );
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let o = 0;
    for (const c of chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  };
  const px = (img: { data: Uint8ClampedArray }, i: number) => [
    img.data[i * 4],
    img.data[i * 4 + 1],
    img.data[i * 4 + 2],
    img.data[i * 4 + 3],
  ];

  it('reads a binary PPM (P6)', () => {
    const img = decodeNetpbm(cat('P6\n2 2\n255\n', [255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0]));
    expect([img.width, img.height]).toEqual([2, 2]);
    expect(px(img, 0)).toEqual([255, 0, 0, 255]);
    expect(px(img, 3)).toEqual([255, 255, 0, 255]);
  });

  it('reads an ASCII PPM (P3) with header comments and loose whitespace', () => {
    const img = decodeNetpbm(
      cat('P3 # a comment\n2 2\n# another\n255\n 255 0 0  0 255 0\n0 0 255 255 255 0\n'),
    );
    expect(px(img, 0)).toEqual([255, 0, 0, 255]);
    expect(px(img, 2)).toEqual([0, 0, 255, 255]);
  });

  it('matches between P3, P6 and decodeImageExact', () => {
    const p6 = cat('P6\n2 1\n255\n', [10, 20, 30, 40, 50, 60]);
    const p3 = cat('P3\n2 1\n255\n 10 20 30 40 50 60\n');
    expect(decodeNetpbm(p3).data).toEqual(decodeNetpbm(p6).data);
    expect(decodeImageExact(p6)!.data).toEqual(decodeNetpbm(p6).data);
  });

  it('scales a maxval other than 255', () => {
    const img = decodeNetpbm(cat('P3\n1 1\n15\n 15 0 8\n'));
    expect(px(img, 0)).toEqual([255, 0, Math.round((8 * 255) / 15), 255]);
  });

  it('reads 16-bit samples big-endian and scales them', () => {
    const img = decodeNetpbm(cat('P6\n1 1\n65535\n', [0xff, 0xff, 0x00, 0x00, 0x80, 0x00]));
    expect(px(img, 0)).toEqual([255, 0, Math.round((0x8000 * 255) / 65535), 255]);
  });

  it('reads PGM (P2 ASCII and P5 binary)', () => {
    const a = decodeNetpbm(cat('P2\n2 1\n255\n 100 200\n'));
    expect(px(a, 0)).toEqual([100, 100, 100, 255]);
    expect(decodeNetpbm(cat('P5\n2 1\n255\n', [100, 200])).data).toEqual(a.data);
  });

  it('reads PBM bitmaps (P1 ASCII and P4 binary): 1 = black', () => {
    const a = decodeNetpbm(cat('P1\n2 2\n1 0 0 1\n'));
    expect(px(a, 0)).toEqual([0, 0, 0, 255]);
    expect(px(a, 1)).toEqual([255, 255, 255, 255]);
    // Row 0 bits 1 0 -> 0x80; row 1 bits 0 1 -> 0x40 (each row padded to a byte).
    expect(decodeNetpbm(cat('P4\n2 2\n', [0x80, 0x40])).data).toEqual(a.data);
  });

  it('throws on a truncated raster and on a bad header', () => {
    expect(() => decodeNetpbm(cat('P6\n2 2\n255\n', [1, 2, 3]))).toThrow();
    expect(() => decodeNetpbm(enc.encode('P7\n2 2\n255\n'))).toThrow();
  });
});
