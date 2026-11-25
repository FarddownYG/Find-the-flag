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
  mode: 'auto' | 'manual' | 'encode';
  channels: string;
  planes: string;
  order: 'row' | 'col';
  bitOrder: 'msb' | 'lsb';
  traversal: 'row' | 'serpentine' | 'column' | 'column-serpentine';
  rows: string;
  step: number;
  offset: number;
  skip: number;
  limit: number;
  message: string;
  writeup: boolean;
  includeFlag: boolean;
}
const defaults: Opts = {
  mode: 'auto',
  channels: 'rgb',
  planes: '0',
  order: 'row',
  bitOrder: 'msb',
  traversal: 'row',
  rows: '',
  step: 1,
  offset: 0,
  skip: 0,
  limit: 0,
  message: 'FTF{lsb}',
  writeup: false,
  includeFlag: false,
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

describe('carrier zone: row 0, every other pixel', () => {
  const loadZone = async (): Promise<ImageInput> =>
    (await prepareInput('image', {
      bytes: new Uint8Array(
        readFileSync(new URL('../../../public/samples/stego-lsb-zone.png', import.meta.url)),
      ),
    })) as ImageInput;
  const FLAG = 'FTF{lsb_row0_step2}';

  it('auto finds the flag, names the zone and reports the carrier row', async () => {
    const out = lsb.run(await loadZone(), { ...defaults }) as Output[];
    const text = resultToText(out);
    expect(utf8Decode(bytesOf(out).value)).toBe(FLAG);
    expect(text).toContain('rows 0, step 2, offset 0');
    const anomalies = out.find((x) => x.type === 'table' && x.columns[0] === 'Row');
    expect(anomalies?.type === 'table' && anomalies.rows[0]![0]).toBe('0');
    expect(text).toContain('every 2 pixels (offset 0)');
  });

  it('a plain full-image scan alone does not recover it', async () => {
    const input = await loadZone();
    const plain = scanWithoutZones(input.image);
    expect(plain).not.toContain(FLAG);
  });

  it('manual with rows, step and offset recovers it', async () => {
    const input = await loadZone();
    const out = lsb.run(input, {
      ...defaults,
      mode: 'manual',
      rows: '0',
      step: 2,
      limit: FLAG.length,
    }) as Output[];
    expect(utf8Decode(bytesOf(out).value)).toBe(FLAG);
  });

  it('a wrong step, offset or zone does not', async () => {
    const input = await loadZone();
    const base = { ...defaults, mode: 'manual' as const, limit: FLAG.length };
    for (const o of [
      { rows: '0', step: 1 },
      { rows: '0', step: 2, offset: 1 },
      { rows: '1', step: 2 },
    ]) {
      const out = lsb.run(input, { ...base, ...o }) as Output[];
      expect(utf8Decode(bytesOf(out).value)).not.toBe(FLAG);
    }
  });

  it('step 2 over the whole image reads the same bits (row 0 comes first)', async () => {
    const out = lsb.run(await loadZone(), {
      ...defaults,
      mode: 'manual',
      step: 2,
      limit: FLAG.length,
    }) as Output[];
    expect(utf8Decode(bytesOf(out).value)).toBe(FLAG);
  });

  it('encode then decode round-trips at the same settings', () => {
    const settings = {
      channels: 'bgr',
      planes: '0,1',
      bitOrder: 'lsb' as const,
      traversal: 'serpentine' as const,
      rows: '3-9',
      step: 3,
      offset: 2,
    };
    const enc = lsb.run(asInput(noiseImage(60, 20)), {
      ...defaults,
      ...settings,
      mode: 'encode',
      message: 'FTF{round_trip}',
    }) as Output[];
    const img = enc.find((x) => x.type === 'image');
    expect(img?.type === 'image' && img.filename).toBe('lsb-stego.png');
    if (img?.type !== 'image') throw new Error('no image output');
    const dec = run(img.image, { ...settings, mode: 'manual', limit: 15 });
    expect(utf8Decode(bytesOf(dec).value)).toBe('FTF{round_trip}');
  });

  it('encode refuses a message that does not fit', () => {
    expect(() =>
      run(noiseImage(8, 8), { mode: 'encode', message: 'x'.repeat(100), rows: '0' }),
    ).toThrow(/does not fit/);
  });

  it('cuts a length-prefixed body and offers the chain decoder', () => {
    const params: LsbParams = {
      channels: parseChannels('rgb'),
      planes: [0],
      order: 'row',
      bitOrder: 'msb',
    };
    const body = 'SGVsbG8gd29ybGQsIGhpZGRlbiBpbiBwaXhlbHM=';
    const img = embed(noiseImage(80, 80), params, utf8Encode(`${body.length}:${body}JUNK`));
    const out = run(img, { mode: 'manual', limit: 50 });
    const text = out.find((x) => x.type === 'text');
    expect(text?.type === 'text' && text.value).toBe(body);
  });
});

/** The auto scan's full-image half only, to prove the zone candidates are what finds the sample. */
function scanWithoutZones(img: RgbaImage): string {
  let all = '';
  for (const chans of ['rgb', 'r', 'g', 'b']) {
    for (const bitOrder of ['msb', 'lsb'] as const) {
      const p: LsbParams = {
        channels: parseChannels(chans),
        planes: [0],
        order: 'row',
        bitOrder,
      };
      all += utf8Decode(extractBits(img, p, 256));
    }
  }
  return all;
}

describe('lsb writeup', () => {
  const writeupOf = (out: Output[]) => {
    const w = out.find((x) => x.type === 'text' && x.label === 'Writeup (Markdown)');
    if (w?.type !== 'text') throw new Error('no writeup output');
    return w.value;
  };
  const flagImage = async () =>
    (await prepareInput('image', {
      bytes: new Uint8Array(
        readFileSync(new URL('../../../public/samples/stego-lsb.png', import.meta.url)),
      ),
    })) as ImageInput;

  it('auto mode: headings, and the flag only when opted in', async () => {
    const input = await flagImage();
    const off = writeupOf(lsb.run(input, { ...defaults, writeup: true }) as Output[]);
    expect(off).toMatch(/^# /);
    expect(off).toContain('## Best hit');
    expect(off).toContain('## Technique');
    expect(off).not.toContain('flag{lsb_hidden_in_pixels}');
    const on = writeupOf(
      lsb.run(input, { ...defaults, writeup: true, includeFlag: true }) as Output[],
    );
    expect(on).toContain('**Flag:** `flag{lsb_hidden_in_pixels}`');
  });

  it('manual mode: extraction table, flag gated', async () => {
    const input = await flagImage();
    const o = { ...defaults, mode: 'manual' as const, limit: 40, writeup: true };
    const off = writeupOf(lsb.run(input, o) as Output[]);
    expect(off).toContain('## Extraction');
    expect(off).toContain('| Bit planes | 0 |');
    expect(off).not.toContain('flag{lsb_hidden_in_pixels}');
    expect(writeupOf(lsb.run(input, { ...o, includeFlag: true }) as Output[])).toContain(
      '**Flag:** `flag{lsb_hidden_in_pixels}`',
    );
  });

  it('adds nothing when writeup is off', async () => {
    const out = lsb.run(await flagImage(), { ...defaults }) as Output[];
    expect(out.some((x) => x.type === 'text')).toBe(false);
  });
});
