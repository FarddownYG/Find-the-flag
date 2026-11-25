import { describe, expect, it } from 'vitest';
import type { RgbaImage } from '../../core/types';
import { utf8Decode, utf8Encode } from '../../lib/bytes';
import { capacityBytes, extractBits, type LsbParams } from './_lsb-core';

function blank(w: number, h: number): RgbaImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = 128;
    data[i * 4 + 1] = 128;
    data[i * 4 + 2] = 128;
    data[i * 4 + 3] = 255;
  }
  return { width: w, height: h, data };
}

/** Write bits of `payload` (MSB first) into bit 0 of r,g,b of the given pixel sequence. */
function embedAt(img: RgbaImage, pixels: number[], payload: Uint8Array): void {
  let bit = 0;
  const total = payload.length * 8;
  for (const pix of pixels) {
    for (const ch of [0, 1, 2]) {
      if (bit >= total) return;
      const v = (payload[bit >> 3]! >> (7 - (bit & 7))) & 1;
      img.data[pix * 4 + ch] = (img.data[pix * 4 + ch]! & 0xfe) | v;
      bit++;
    }
  }
}

const base: LsbParams = { channels: [0, 1, 2], planes: [0], order: 'row', bitOrder: 'msb' };

describe('LSB core — zone / step / offset', () => {
  it('reads a message hidden on row 0, every other pixel (step 2)', () => {
    const img = blank(64, 8);
    const msg = utf8Encode('FTF{r0s2}'); // 9 bytes = 72 bits, fits row-0 even pixels (96 bits)
    // Even pixels of row 0 only: indices 0, 2, 4, ...
    const pixels = [];
    for (let x = 0; x < 64; x += 2) pixels.push(x);
    embedAt(img, pixels, msg);

    const got = extractBits(img, { ...base, step: 2 }, msg.length);
    expect(utf8Decode(got)).toBe('FTF{r0s2}');
    // Reading every pixel instead does not recover it (odd pixels are blank).
    expect(utf8Decode(extractBits(img, base, msg.length))).not.toBe('FTF{r0s2}');
  });

  it('honours offset to skip a header region', () => {
    const img = blank(40, 4);
    const msg = utf8Encode('abcd');
    const pixels = [];
    for (let x = 5; x < 40; x++) pixels.push(x); // starts at pixel 5
    embedAt(img, pixels, msg);
    expect(utf8Decode(extractBits(img, { ...base, offset: 5 }, msg.length))).toBe('abcd');
  });

  it('follows an explicit pixel sequence (e.g. a serpentine walk)', () => {
    const img = blank(8, 4);
    const msg = utf8Encode('hiya'); // 32 bits > row-0 capacity (24 bits), so it spills into row 1
    // Serpentine over the first two rows: row 0 L→R, row 1 R→L.
    const seq = [];
    for (let x = 0; x < 8; x++) seq.push(x);
    for (let x = 7; x >= 0; x--) seq.push(8 + x);
    embedAt(img, seq, msg);
    const pixels = Int32Array.from(seq);
    expect(utf8Decode(extractBits(img, { ...base, pixels }, msg.length))).toBe('hiya');
    // Plain row-major misreads the reversed second row, so it differs.
    const rowMajor = extractBits(img, base, msg.length);
    expect(utf8Decode(rowMajor)).not.toBe('hi');
  });

  it('reports capacity after the zone, step and offset', () => {
    const img = blank(100, 1); // 100 pixels, 3 channels, 1 plane -> 300 bits
    expect(capacityBytes(img, base)).toBe(Math.floor((100 * 3) / 8));
    expect(capacityBytes(img, { ...base, step: 2 })).toBe(Math.floor((50 * 3) / 8));
    expect(capacityBytes(img, { ...base, offset: 10, step: 2 })).toBe(Math.floor((45 * 3) / 8));
    const pixels = Int32Array.from([0, 1, 2, 3]);
    expect(capacityBytes(img, { ...base, pixels })).toBe(Math.floor((4 * 3) / 8));
  });
});
