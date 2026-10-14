import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { encode } from 'fast-png';
import { prepareInput } from '../../core/prepare';
import { resultToText } from '../../core/result-text';
import type { ImageInput, Output, RgbaImage } from '../../core/types';
import { utf8Decode, utf8Encode } from '../../lib/bytes';
import { extractBits, type LsbParams, parseChannels, parsePlanes } from './_lsb-core';
import lsb from './lsb';

function noiseImage(w: number, h: number, seed = 7): RgbaImage {
  const data = new Uint8ClampedArray(w * h * 4);
  let s = seed;
  for (let i = 0; i < data.length; i++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    data[i] = i % 4 === 3 ? 255 : (s >>> 16) & 0xff;
  }
  return { width: w, height: h, data };
}

/** Inverse of extractBits: write `payload` into the chosen bits (the test's own embedder). */
function embed(img: RgbaImage, p: LsbParams, payload: Uint8Array): RgbaImage {
  const data = new Uint8ClampedArray(img.data);
  const planes = p.bitOrder === 'msb' ? [...p.planes].reverse() : p.planes;
  let bit = 0;
  const total = payload.length * 8;
  const n = img.width * img.height;
  for (let k = 0; k < n && bit < total; k++) {
    let pix = k;
    if (p.order === 'col') {
      const y = k % img.height;
      pix = y * img.width + (k - y) / img.height;
    }
    for (const ch of p.channels) {
      for (const pl of planes) {
        if (bit >= total) break;
        const byte = payload[bit >> 3]!;
        const v = p.bitOrder === 'msb' ? (byte >> (7 - (bit & 7))) & 1 : (byte >> (bit & 7)) & 1;
        data[pix * 4 + ch] = (data[pix * 4 + ch]! & ~(1 << pl)) | (v << pl);
        bit++;
      }
    }
  }
  return { width: img.width, height: img.height, data };
}

const asInput = (image: RgbaImage): ImageInput => ({ bytes: new Uint8Array(), image });
interface Opts {
  mode: 'auto' | 'manual';
  channels: string;
  planes: string;
  order: 'row' | 'col';
  bitOrder: 'msb' | 'lsb';
  skip: number;
  limit: number;
}
const defaults: Opts = {
  mode: 'auto',
  channels: 'rgb',
  planes: '0',
  order: 'row',
  bitOrder: 'msb',
  skip: 0,
  limit: 0,
};
const run = (image: RgbaImage, o: Partial<Opts> = {}) =>
  lsb.run(asInput(image), { ...defaults, ...o }) as Output[];
const bytesOf = (out: Output[]) => {
  const b = out.find((x) => x.type === 'bytes');
  if (b?.type !== 'bytes') throw new Error('no bytes output');
  return b;
};

describe('extractBits / embed round trip', () => {
  const combos: LsbParams[] = [];
  for (const channels of ['r', 'rgb', 'bgr', 'rgba', 'abgr']) {
    for (const planes of [[0], [1], [0, 1], [0, 1, 2]]) {
      for (const order of ['row', 'col'] as const) {
        for (const bitOrder of ['msb', 'lsb'] as const) {
          combos.push({ channels: parseChannels(channels), planes, order, bitOrder });
        }
      }
    }
  }
  it.each(combos.map((c) => [JSON.stringify(c), c] as const))('%s', (_n, params) => {
    const payload = utf8Encode('flag{round_trip_ok} 0123456789');
    const base = noiseImage(37, 29);
    const stego = embed(base, params, payload);
    expect(utf8Decode(extractBits(stego, params, payload.length))).toBe(utf8Decode(payload));
  });
});

describe('lsb tool', () => {
  it('auto-scans the sample image and finds the flag', async () => {
    const bytes = new Uint8Array(
      readFileSync(new URL('../../../public/samples/stego-lsb.png', import.meta.url)),
    );
    const input = (await prepareInput('image', { bytes })) as ImageInput;
    const out = lsb.run(input, { ...defaults }) as Output[];
    expect(resultToText(out)).toContain('flag{lsb_hidden_in_pixels}');
    const best = bytesOf(out);
    expect(utf8Decode(best.value)).toBe('flag{lsb_hidden_in_pixels}');
    const table = out.find((x) => x.type === 'table');
    expect(table?.type === 'table' && table.rows[0]![0]).toBe('rgb, bit 0, row-major, MSB-first');
  });

  it('finds data in column-major, LSB-first order on other channels', () => {
    const params: LsbParams = {
      channels: parseChannels('bgr'),
      planes: [1],
      order: 'col',
      bitOrder: 'lsb',
    };
    const img = embed(noiseImage(120, 90), params, utf8Encode('flag{column_major_lsb_first}\0'));
    const out = run(img);
    expect(utf8Decode(bytesOf(out).value)).toBe('flag{column_major_lsb_first}');
    expect(resultToText(out)).toContain('bgr, bit 1, column-major, LSB-first');
  });

  it('finds a multi-bit embedding', () => {
    const params: LsbParams = {
      channels: parseChannels('rgb'),
      planes: [0, 1],
      order: 'row',
      bitOrder: 'msb',
    };
    const img = embed(noiseImage(60, 60), params, utf8Encode('flag{two_bits_per_channel}\0'));
    expect(utf8Decode(bytesOf(run(img)).value)).toBe('flag{two_bits_per_channel}');
  });

  it('recognises an embedded file by its magic bytes and carves it exactly', () => {
    const inner = encode({
      width: 8,
      height: 8,
      data: new Uint8Array(8 * 8 * 3).map((_, i) => (i * 7) & 0xff),
      depth: 8,
      channels: 3,
    });
    const params: LsbParams = {
      channels: parseChannels('rgb'),
      planes: [0],
      order: 'row',
      bitOrder: 'msb',
    };
    const img = embed(noiseImage(200, 200), params, inner);
    const out = run(img);
    const b = bytesOf(out);
    expect(resultToText(out)).toContain('PNG image');
    expect(b.filename).toBe('lsb-extract.png');
    expect(Array.from(b.value)).toEqual(Array.from(inner));
  });

  it('reads a length-prefixed message', () => {
    const msg = utf8Encode('the password is hunter2');
    const prefixed = new Uint8Array(4 + msg.length);
    new DataView(prefixed.buffer).setUint32(0, msg.length);
    prefixed.set(msg, 4);
    const params: LsbParams = {
      channels: parseChannels('g'),
      planes: [0],
      order: 'row',
      bitOrder: 'msb',
    };
    const out = run(embed(noiseImage(80, 80), params, prefixed));
    expect(resultToText(out)).toContain('length-prefixed');
    expect(utf8Decode(bytesOf(out).value)).toBe('the password is hunter2');
  });

  it('does not invent a result on plain noise, and is fast on 1000x1000', () => {
    const t0 = performance.now();
    const out = run(noiseImage(1000, 1000, 99));
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(4000);
    expect(resultToText(out)).not.toMatch(/flag|magic bytes/);
  });

  it('skips alpha channel orders for opaque images (no hits in constant alpha)', () => {
    const out = run(noiseImage(40, 40));
    expect(resultToText(out)).toMatch(/Scanned (\d+) combinations/);
    const m = /Scanned (\d+)/.exec(resultToText(out));
    expect(Number(m![1])).toBe(5 * 7 * 4);
  });

  it('manual mode honours skip and limit', () => {
    const params: LsbParams = {
      channels: parseChannels('rgb'),
      planes: [0],
      order: 'row',
      bitOrder: 'msb',
    };
    const img = embed(noiseImage(50, 50), params, utf8Encode('XXXXflag{skipped}'));
    const out = run(img, { mode: 'manual', skip: 4, limit: 13 });
    expect(utf8Decode(bytesOf(out).value)).toBe('flag{skipped}');
  });

  it('manual mode tells you when it finds a file', () => {
    const params: LsbParams = {
      channels: parseChannels('rgb'),
      planes: [0],
      order: 'row',
      bitOrder: 'msb',
    };
    const zip = new Uint8Array([0x50, 0x4b, 3, 4, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const out = run(embed(noiseImage(50, 50), params, zip), { mode: 'manual' });
    expect(resultToText(out)).toMatch(/magic bytes/);
    expect(bytesOf(out).filename).toBe('lsb-extract.zip');
  });

  it('rejects bad manual settings with a helpful message', () => {
    const img = noiseImage(10, 10);
    expect(() => run(img, { mode: 'manual', channels: 'rgx' })).toThrow(/Unknown channel "x"/);
    expect(() => run(img, { mode: 'manual', planes: '9' })).toThrow(/use 0 \(lowest\) to 7/);
    expect(() => run(img, { mode: 'manual', planes: 'a' })).toThrow(/Bad bit list/);
    expect(() => run(img, { mode: 'manual', skip: 1_000_000 })).toThrow(/Nothing left/);
  });
});

describe('option parsers', () => {
  it('parsePlanes expands ranges and sorts', () => {
    expect(parsePlanes('2, 0-1')).toEqual([0, 1, 2]);
    expect(parsePlanes('7')).toEqual([7]);
  });
  it('parseChannels keeps the order', () => {
    expect(parseChannels('BGR')).toEqual([2, 1, 0]);
  });
});
