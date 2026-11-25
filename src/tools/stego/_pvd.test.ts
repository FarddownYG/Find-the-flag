import { describe, expect, it } from 'vitest';
import type { RgbaImage } from '../../core/types';
import {
  adjust,
  bitsToBytes,
  bytesToBits,
  type Channel,
  EQUAL_16,
  EQUAL_8,
  embed,
  extractBits,
  parseTable,
  type RangeTable,
  samplesOf,
  sequence,
  type Traversal,
  WU_TSAI,
} from './_pvd';

/** A deterministic cover whose values sit well inside 0..255, so no pair ever falls off boundary. */
function cover(width: number, height: number): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  let s = 0x1234;
  for (let i = 0; i < width * height; i++) {
    for (let c = 0; c < 3; c++) {
      s = (Math.imul(s, 1103515245) + 12345) >>> 0;
      data[i * 4 + c] = 80 + ((s >>> 16) % 96); // 80..175
    }
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}

const TABLES: [string, RangeTable][] = [
  ['wu-tsai', WU_TSAI],
  ['equal-16', EQUAL_16],
  ['equal-8', EQUAL_8],
];
const TRAVERSALS: Traversal[] = ['row', 'serpentine', 'column', 'column-serpentine'];
const CHANNELS: Channel[] = ['gray', 'r', 'g', 'b', 'rgb'];

describe('PVD — round trip for every combination', () => {
  const msg = Uint8Array.from('16:SGVsbG8h', (c) => c.charCodeAt(0)); // "length:base64" style
  for (const [name, table] of TABLES) {
    for (const traversal of TRAVERSALS) {
      for (const channel of CHANNELS) {
        for (const overflow of [false, true]) {
          for (const msbFirst of [true, false]) {
            it(`${name} / ${traversal} / ${channel} / overflow=${overflow} / msb=${msbFirst}`, () => {
              const img = cover(40, 30);
              const bits = bytesToBits(msg, msbFirst);
              const stego = embed(img, bits, { table, traversal, channel, overflow });
              const s = samplesOf(stego, channel, sequence(stego.width, stego.height, traversal));
              const out = bitsToBytes(extractBits(s, { table, overflow }), msbFirst);
              expect(out.subarray(0, msg.length)).toEqual(msg);
            });
          }
        }
      }
    }
  }
});

describe('PVD — building blocks', () => {
  it('decodes a Wu & Tsai pair by hand', () => {
    // p1=100, p2=120 -> d=20 in range [16,31] (4 bits), value = 20 - 16 = 4 -> bits 0100
    const img: RgbaImage = { width: 2, height: 1, data: new Uint8ClampedArray([100, 100, 100, 255, 120, 120, 120, 255]) };
    const s = samplesOf(img, 'gray', sequence(2, 1, 'row'));
    expect([...extractBits(s, { table: WU_TSAI, overflow: false })]).toEqual([0, 1, 0, 0]);
  });

  it('keeps the average when it pushes a difference, and flags a fall-off pair', () => {
    expect(adjust(100, 120, 31)).toEqual([94, 125]); // d 20 -> 31, split 6/5 around the average
    // A pair near the edges cannot reach the top of a wide range without leaving 0..255.
    const img: RgbaImage = { width: 2, height: 1, data: new Uint8ClampedArray([48, 48, 48, 255, 200, 200, 200, 255]) };
    const s = samplesOf(img, 'gray', sequence(2, 1, 'row'));
    expect(extractBits(s, { table: WU_TSAI, overflow: true })).toEqual([]); // skipped
    expect(extractBits(s, { table: WU_TSAI, overflow: false }).length).toBe(7); // read anyway
  });

  it('serpentine visits odd rows right-to-left', () => {
    expect([...sequence(3, 2, 'serpentine')]).toEqual([0, 1, 2, 5, 4, 3]);
  });

  it('parses a custom range table and rejects a bad one', () => {
    expect(parseTable('8 8 16 32 64 128')).toHaveLength(6);
    expect(parseTable('8 8 16 32 64 128')![2]).toEqual({ lo: 16, hi: 31, bits: 4 });
    expect(parseTable('8 8 16 32 64')).toBeNull(); // does not cover 0..255
    expect(parseTable('3 5')).toBeNull(); // not powers of two
  });
});
