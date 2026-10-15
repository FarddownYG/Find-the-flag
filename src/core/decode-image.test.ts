import { describe, expect, it } from 'vitest';
import { encode } from 'fast-png';
import { decodeImageExact } from './decode-image';

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
