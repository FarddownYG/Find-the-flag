import { describe, expect, it } from 'vitest';
import type { RgbaImage } from '../../core/types';
import {
  type CodeTable,
  DEFAULT_SETTINGS,
  type PitSettings,
  SLOTS,
  bodyRotStart,
  capacity,
  decode,
  encode,
  headerBytes,
  headerValue,
  slotChannels,
} from './_pit';

/** A noisy RGB cover (so a wrong reading cannot hit by accident). */
function cover(w: number, h: number, seed = 5): RgbaImage {
  const data = new Uint8ClampedArray(w * h * 4);
  let s = seed;
  for (let i = 0; i < w * h; i++) {
    for (let c = 0; c < 3; c++) {
      s = (Math.imul(s, 1103515245) + 12345) >>> 0;
      data[i * 4 + c] = (s >>> 16) & 255;
    }
    data[i * 4 + 3] = 255;
  }
  return { width: w, height: h, data };
}

const msg = (t: string) => new TextEncoder().encode(t);
const str = (b: Uint8Array) => new TextDecoder().decode(b);
const with_ = (o: Partial<PitSettings>): PitSettings => ({ ...DEFAULT_SETTINGS, ...o });

describe('PIT — header', () => {
  it('writes and reads big- and little-endian lengths', () => {
    expect([...headerBytes(0x0102, 4, 'be')]).toEqual([0, 0, 1, 2]);
    expect([...headerBytes(0x0102, 4, 'le')]).toEqual([2, 1, 0, 0]);
    for (const e of ['be', 'le'] as const) {
      expect(headerValue(headerBytes(123456, 8, e), e)).toBe(123456);
    }
  });

  it('maps slots to the two non-indicator channels', () => {
    expect(slotChannels('c1', 1)).toEqual([0]);
    expect(slotChannels('c2', 1)).toEqual([2]);
    expect(slotChannels('c2c1', 1)).toEqual([2, 0]);
    expect(slotChannels('c1c2', 0)).toEqual([1, 2]);
    expect(slotChannels('none', 2)).toEqual([]);
  });

  it('uses R for an even length and G for an odd one on the rotating body', () => {
    expect(bodyRotStart(18)).toBe(0);
    expect(bodyRotStart(19)).toBe(1);
  });
});

describe('PIT — encode → decode round trip', () => {
  const tables: CodeTable[] = [
    ['none', 'c1', 'c2', 'c1c2'],
    ['none', 'c1', 'c2', 'c2c1'],
    ['c2c1', 'c2', 'c1', 'none'],
    ['c1', 'c1c2', 'none', 'c2'],
  ];
  const text = 'FTF{pit_roundtrip_ok}';

  it('recovers the message across indicators, tables, bits per channel, orders and starts', () => {
    const img = cover(40, 30);
    let n = 0;
    for (const indicator of ['r', 'g', 'b', 'rotate'] as const) {
      for (const codeTable of tables) {
        for (const bitsPerChannel of [1, 2, 3, 4]) {
          for (const bitOrder of ['msb', 'lsb'] as const) {
            for (const [startMode, startRow] of [
              ['after', 0],
              ['row', 1],
              ['row', 3],
            ] as const) {
              const s = with_({
                indicator,
                codeTable,
                bitsPerChannel,
                bitOrder,
                startMode,
                startRow,
              });
              const stego = encode(img, msg(text), s);
              const r = decode(stego, s);
              expect(str(r.body)).toBe(text);
              expect(r.header).toBe(text.length);
              n++;
            }
          }
        }
      }
    }
    expect(n).toBe(4 * 4 * 4 * 2 * 3);
  });

  it('round-trips odd and even lengths with a rotating indicator', () => {
    const img = cover(40, 30);
    const s = with_({ indicator: 'rotate', startMode: 'row', startRow: 1 });
    for (const t of ['abc', 'abcd', 'x', 'FTF{odd}', 'FTF{even}!']) {
      expect(str(decode(encode(img, msg(t), s), s).body)).toBe(t);
    }
  });

  it('honours header size, endianness and position', () => {
    const img = cover(40, 30);
    for (const bytes of [1, 2, 4, 8]) {
      for (const endian of ['be', 'le'] as const) {
        const s = with_({ header: { bytes, endian, atPixel: 7 } });
        const r = decode(encode(img, msg(text), s), s);
        expect(str(r.body)).toBe(text);
      }
    }
  });

  it('does not touch pixels outside the walk and keeps the cover otherwise', () => {
    const img = cover(40, 30);
    const s = with_({ startMode: 'row', startRow: 2 });
    const stego = encode(img, msg(text), s);
    // The pixels of row 1 (between the header and the body) are untouched.
    for (let i = 40 * 4; i < 40 * 4 * 2; i++) expect(stego.data[i]).toBe(img.data[i]);
    // Only the low bits changed anywhere (indicator: 2 bits, data: up to 2).
    for (let i = 0; i < img.data.length; i++)
      expect(Math.abs(stego.data[i]! - img.data[i]!)).toBeLessThan(4);
  });

  it('fails with the wrong indicator, start row or bits per channel', () => {
    const img = cover(40, 30);
    const s = with_({ indicator: 'g', startMode: 'row', startRow: 1 });
    const stego = encode(img, msg(text), s);
    expect(str(decode(stego, with_({ ...s, indicator: 'b' })).body)).not.toBe(text);
    expect(str(decode(stego, with_({ ...s, startRow: 2 })).body)).not.toBe(text);
    expect(str(decode(stego, with_({ ...s, bitsPerChannel: 1 })).body)).not.toBe(text);
  });

  it('limits the decoded body and clamps a header larger than the image', () => {
    const img = cover(20, 10);
    const s = with_({});
    const stego = encode(img, msg(text), s);
    expect(str(decode(stego, s, 4).body)).toBe(text.slice(0, 4));
    // A noise image reads an absurd length but never returns more than it can hold.
    const noisy = decode(img, s);
    expect(noisy.body.length).toBeLessThanOrEqual(Math.floor((20 * 10 * 2 * 2) / 8));
  });
});

describe('PIT — capacity', () => {
  it('matches what the encoder accepts', () => {
    const img = cover(24, 12);
    for (const startMode of ['after', 'row'] as const) {
      const s = with_({ startMode, startRow: 1 });
      const cap = capacity(img, s);
      expect(cap).toBeGreaterThan(0);
      const fits = new Uint8Array(cap).fill(65);
      expect(decode(encode(img, fits, s), s).body.length).toBe(cap);
      expect(() => encode(img, new Uint8Array(cap + 1).fill(65), s)).toThrow();
    }
  });

  it('is zero when every code maps to nothing, and grows with bits per channel', () => {
    const img = cover(24, 12);
    expect(capacity(img, with_({ codeTable: ['none', 'none', 'none', 'none'] }))).toBe(0);
    expect(capacity(img, with_({ bitsPerChannel: 4 }))).toBeGreaterThan(
      capacity(img, with_({ bitsPerChannel: 1 })),
    );
    expect(SLOTS).toHaveLength(5);
  });

  it('is zero when the header does not fit', () => {
    expect(capacity(cover(2, 2), with_({}))).toBe(0);
  });
});
