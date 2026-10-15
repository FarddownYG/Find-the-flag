import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decode as decodePng, encode as encodePng } from 'fast-png';
import { decodeImageExact } from '../../core/decode-image';
import { ToolError } from '../../core/errors';
import { prepareInput } from '../../core/prepare';
import type { ImageInput, Output, RgbaImage } from '../../core/types';
import {
  autoSearch,
  DEFAULTS,
  decodeEmd,
  type EmdParams,
  encodeEmd,
  extractDigits,
  flatten,
  type Gray,
} from './_emd';
import { inputIssues, rgbaToGray } from './_emd-image';
import emd from './emd';

// ---------- helpers ----------

const sample = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../../../public/samples/${name}`, import.meta.url)));

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

function noiseGray(w: number, h: number, seed: number, lo = 0, hi = 255): Gray {
  const next = rng(seed);
  const data = Uint8Array.from({ length: w * h }, () => lo + (next() % (hi - lo + 1)));
  return { data, width: w, height: h };
}

function noiseRgba(w: number, h: number, seed: number): RgbaImage {
  const next = rng(seed);
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i++) data[i] = i % 4 === 3 ? 255 : 5 + (next() % 241);
  return { width: w, height: h, data };
}

const asInput = (image: RgbaImage, bytes = new Uint8Array()): ImageInput => ({ bytes, image });

const sampleInput = async (name: string) =>
  (await prepareInput('image', { bytes: sample(name), name })) as ImageInput;

interface Opts {
  mode: 'decode' | 'auto' | 'encode';
  message: string;
  n: '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8';
  length: number;
  k: number;
  weights: 'asc' | 'desc';
  digitOrder: 'msb' | 'lsb';
  scan: 'row' | 'col';
  offset: number;
  channel: 'gray' | 'r' | 'g' | 'b';
}
const defaults: Opts = {
  mode: 'decode',
  message: 'HELLO_EMD_123',
  n: '2',
  length: DEFAULTS.length,
  k: DEFAULTS.k,
  weights: DEFAULTS.weights,
  digitOrder: DEFAULTS.digitOrder,
  scan: DEFAULTS.scan,
  offset: DEFAULTS.offset,
  channel: 'gray',
};
const run = (input: ImageInput, o: Partial<Opts> = {}) =>
  emd.run(input, { ...defaults, ...o }) as Output[];

const pick = <T extends Output['type']>(out: Output[], type: T) =>
  out.filter((o): o is Extract<Output, { type: T }> => o.type === type);
const kv = (out: Output[], key: string) =>
  pick(out, 'kv')
    .flatMap((o) => o.entries)
    .find(([k]) => k === key)?.[1];
const notes = (out: Output[], level: string) =>
  pick(out, 'note')
    .filter((o) => o.level === level)
    .map((o) => o.text);

// ---------- the core: round trips of the reference test ----------

describe('EMD core round trip', () => {
  const message = 'EMD round trip: the flag is Abc123!? (ok)';
  const cases: [number, 'asc' | 'desc', 'msb' | 'lsb', 'row' | 'col'][] = [];
  for (const n of [2, 3, 4])
    for (const weights of ['asc', 'desc'] as const)
      for (const digitOrder of ['msb', 'lsb'] as const)
        for (const scan of ['row', 'col'] as const) cases.push([n, weights, digitOrder, scan]);

  it('has the 24 cases of the reference test', () => expect(cases).toHaveLength(24));

  it.each(cases)('n = %i, %s, %s, %s', (n, weights, digitOrder, scan) => {
    const m = 2 * n + 1;
    let k = 1;
    while (m ** k < 128) k++;
    const im = noiseGray(64, 64, 100 + n, 5, 244);
    const p: EmdParams = {
      ...DEFAULTS,
      n,
      k,
      length: message.length,
      weights,
      digitOrder,
      scan,
      offset: 7,
    };
    const before = Uint8Array.from(im.data);
    const overflow = encodeEmd(im, message, p);
    expect(decodeEmd(im, p).text).toBe(message);
    expect(overflow).toBe(0);
    let changed = 0;
    let maxDiff = 0;
    for (let i = 0; i < before.length; i++) {
      const d = Math.abs(before[i]! - im.data[i]!);
      if (d) changed++;
      maxDiff = Math.max(maxDiff, d);
    }
    expect(maxDiff).toBeLessThanOrEqual(1);
    expect(changed).toBeLessThanOrEqual(message.length * k); // at most one pixel per group
  });

  it('the core refuses "}" with n = 2, k = 3 (code 125 = 5^3)', () => {
    const img = { data: new Uint8Array(64 * 64).fill(100), width: 64, height: 64 };
    expect(() => encodeEmd(img, '}', { ...DEFAULTS, length: 1 })).toThrow(/125/);
  });

  it('reads the digits with the weights and the scan asked for', () => {
    // 2x2 image, n = 2: group = two pixels, f = 1*g1 + 2*g2 (asc) or 2*g1 + 1*g2 (desc) mod 5.
    const img: Gray = { data: Uint8Array.from([1, 2, 3, 4]), width: 2, height: 2 };
    expect(extractDigits(flatten(img, 'row'), 2, 'asc', 0, 2)).toEqual([(1 + 4) % 5, (3 + 8) % 5]);
    expect(extractDigits(flatten(img, 'row'), 2, 'desc', 0, 2)).toEqual([(2 + 2) % 5, (6 + 4) % 5]);
    expect([...flatten(img, 'col')]).toEqual([1, 3, 2, 4]);
  });
});

// ---------- the sample ----------

describe('emd-hello.png', () => {
  const bytes = sample('emd-hello.png');

  it('is a small 8-bit grayscale PNG', () => {
    expect(bytes.length).toBeLessThan(200 * 1024);
    const png = decodePng(bytes);
    expect([png.channels, png.depth]).toEqual([1, 8]);
    expect(bytes[25]).toBe(0); // IHDR colour type 0: grayscale
  });

  it('decodes to exactly HELLO_EMD_123 with n = 2, k = 3, msb, asc, row, gray', () => {
    const img = decodeImageExact(bytes)!;
    const r = decodeEmd(rgbaToGray(img, 'gray'), { ...DEFAULTS, length: 13 });
    expect(r.text).toBe('HELLO_EMD_123');
    expect(r.text).toHaveLength(13);
    expect([r.printable, r.readable]).toEqual([1, 1]);
  });

  it('autoSearch finds row, asc, msb, k = 3 first', () => {
    const gray = rgbaToGray(decodeImageExact(bytes)!, 'gray');
    const ranked = autoSearch(gray, 2, 13);
    expect(ranked).toHaveLength(2 * 2 * 2 * 8);
    expect(ranked[0]!.params).toEqual({ ...DEFAULTS, length: 13 });
    expect(ranked[0]!.result.text).toBe('HELLO_EMD_123');
    expect(ranked[1]!.result.readable).toBeLessThan(0.9);
    // Sorted by readable, which is not the same order as printable.
    const readable = ranked.map((c) => c.result.readable);
    expect(readable).toEqual([...readable].sort((a, b) => b - a));
    const printable = ranked.map((c) => c.result.printable);
    expect(printable).not.toEqual([...printable].sort((a, b) => b - a));
  });
});

describe('printable % proves nothing', () => {
  it('pure noise is about 74 % printable with n = 2, k = 3, but far less readable', () => {
    const noise = noiseGray(400, 400, 77);
    const r = decodeEmd(noise, { ...DEFAULTS, length: 5000 });
    expect(r.printable).toBeGreaterThan(0.71); // 93 printable codes out of 125 = 74.4 %
    expect(r.printable).toBeLessThan(0.78);
    expect(r.readable).toBeLessThan(0.7); // the real message scores 1
    expect(r.readable).toBeLessThan(r.printable - 0.08);
  });

  it('the real message stays on top of the ranking among noisy readings', () => {
    const sampleGray = rgbaToGray(decodeImageExact(sample('emd-hello.png'))!, 'gray');
    const noisy = autoSearch(sampleGray, 2, 13).filter((c) => c.result.printable > 0.7);
    expect(noisy.length).toBeGreaterThan(1); // several readings look printable
    expect(noisy[0]!.result.readable).toBe(1);
  });
});

// ---------- reading the pixels ----------

describe('rgbaToGray', () => {
  it('is the reference formula, or one channel as is', () => {
    const img = noiseRgba(50, 40, 3);
    const gray = rgbaToGray(img, 'gray');
    const r = rgbaToGray(img, 'r');
    const g = rgbaToGray(img, 'g');
    const b = rgbaToGray(img, 'b');
    for (let i = 0; i < 2000; i++) {
      const [R, G, B] = [img.data[4 * i]!, img.data[4 * i + 1]!, img.data[4 * i + 2]!];
      expect(gray.data[i]).toBe(Math.round(0.299 * R + 0.587 * G + 0.114 * B));
      expect([r.data[i], g.data[i], b.data[i]]).toEqual([R, G, B]);
    }
  });

  it('gives a gray PNG sample back unchanged, for all 256 values', () => {
    const data = Uint8Array.from({ length: 256 }, (_, i) => i);
    const png = encodePng({ width: 16, height: 16, data, depth: 8, channels: 1 });
    const gray = rgbaToGray(decodeImageExact(png)!, 'gray');
    expect([...gray.data]).toEqual([...data]);
  });
});

describe('inputIssues', () => {
  it('flags JPEG and other lossy files', () => {
    expect(inputIssues(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toEqual([
      { kind: 'jpeg' },
    ]);
    const webp = (chunk: string) =>
      Uint8Array.from([...('RIFF\0\0\0\0WEBP' + chunk)].map((c) => c.charCodeAt(0)));
    expect(inputIssues(webp('VP8 '))).toEqual([{ kind: 'lossy', format: 'WebP' }]);
    expect(inputIssues(webp('VP8L'))).toEqual([{ kind: 'browser', format: 'WebP' }]);
  });

  it('reads the PNG header: 16-bit, low depth, palette', () => {
    const png16 = encodePng({
      width: 2,
      height: 2,
      data: new Uint16Array(4),
      depth: 16,
      channels: 1,
    });
    expect(inputIssues(png16)).toEqual([{ kind: 'depth16' }]);
    const pal = encodePng({
      width: 2,
      height: 1,
      data: Uint8Array.from([0, 1]),
      depth: 8,
      channels: 1,
      palette: [
        [1, 2, 3],
        [4, 5, 6],
      ],
    });
    expect(inputIssues(pal)).toEqual([{ kind: 'palette' }]);
    expect(inputIssues(sample('emd-hello.png'))).toEqual([]);
    expect(inputIssues(sample('emd-cover.png'))).toEqual([]);
  });
});

// ---------- the tool: decode ----------

describe('emd tool: decode', () => {
  it('starts on Decode with the core defaults and the gray channel', () => {
    const shown = Object.fromEntries(
      Object.entries(emd.options ?? {}).map(([k, v]) => [k, v.default]),
    );
    expect(shown).toMatchObject({
      mode: 'decode',
      n: String(DEFAULTS.n),
      length: 892,
      k: DEFAULTS.k,
      weights: DEFAULTS.weights,
      digitOrder: DEFAULTS.digitOrder,
      scan: DEFAULTS.scan,
      offset: DEFAULTS.offset,
      channel: 'gray',
    });
  });

  it('shows the text, both rates and the raw digit stream', async () => {
    const out = run(await sampleInput('emd-hello.png'), { length: 13 });
    const texts = pick(out, 'text');
    expect(texts[0]!.value).toBe('HELLO_EMD_123');
    expect(kv(out, 'Printable %')).toBe('100.0 % (13/13)');
    expect(kv(out, 'Readable %')).toBe('100.0 % (13/13)');
    // 'H' = 72 = 2*25 + 4*5 + 2 -> 242, 'E' = 69 -> 234, 'L' = 76 -> 301, 'O' = 79 -> 304, '_' = 95 -> 340
    expect(texts[1]!.value.startsWith('242 234 301 301 304 340 ')).toBe(true);
    expect(texts[1]!.label).toBe('Raw digit stream (base 5, 3 digits per character)');
  });

  it('keeps the standing reminder, and warns about a JPEG', async () => {
    const input = await sampleInput('emd-hello.png');
    expect(notes(run(input, { length: 13 }), 'info').join('\n')).toMatch(/Lossless PNG only/);
    expect(notes(run(input, { length: 13 }), 'warn')).toEqual([]);
    const jpeg = asInput(input.image, Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]));
    expect(notes(run(jpeg, { length: 13 }), 'warn').join('\n')).toMatch(/JPEG/);
  });

  it('warns about a 16-bit PNG and an indexed PNG (and reads what FTF decodes)', async () => {
    const values = Uint16Array.from({ length: 16 * 16 }, (_, i) => (i % 256) * 256 + 77);
    const png16 = encodePng({ width: 16, height: 16, data: values, depth: 16, channels: 1 });
    const input = (await prepareInput('image', { bytes: png16 })) as ImageInput;
    expect(input.image.data[4 * 5]).toBe(5); // the high byte
    expect(notes(run(input, { length: 5 }), 'warn').join('\n')).toMatch(/16-bit/);
    const indexed = encodePng({
      width: 4,
      height: 4,
      data: new Uint8Array(16),
      depth: 8,
      channels: 1,
      palette: [[9, 9, 9]],
    });
    const pal = (await prepareInput('image', { bytes: indexed })) as ImageInput;
    expect(notes(run(pal, { length: 2 }), 'warn').join('\n')).toMatch(/palette/i);
  });

  it('with the default length the message is followed by noise and Auto is suggested', async () => {
    const out = run(await sampleInput('emd-hello.png'));
    const text = pick(out, 'text')[0]!.value;
    expect(text).toHaveLength(892);
    expect(text.startsWith('HELLO_EMD_123')).toBe(true);
    expect(pick(out, 'actions')[0]!.actions[0]!.options).toEqual({ mode: 'auto' });
  });

  it('reads the other channels, scans and weights from the options', () => {
    const cover = noiseRgba(40, 40, 11);
    const plane = rgbaToGray(cover, 'g');
    const p: EmdParams = {
      n: 3,
      k: 3,
      length: 9,
      weights: 'desc',
      digitOrder: 'lsb',
      scan: 'col',
      offset: 5,
    };
    expect(encodeEmd(plane, 'flag{abc}', p)).toBe(0);
    for (let i = 0; i < plane.data.length; i++) cover.data[4 * i + 1] = plane.data[i]!;
    const out = run(asInput(cover), {
      n: '3',
      k: 3,
      length: 9,
      weights: 'desc',
      digitOrder: 'lsb',
      scan: 'col',
      offset: 5,
      channel: 'g',
    });
    expect(pick(out, 'text')[0]!.value).toBe('flag{abc}');
  });

  it('says how many characters the image really holds', () => {
    const out = run(asInput(noiseRgba(8, 8, 1)), { length: 100 });
    // 64 pixels, 2 per group, 3 groups per character: 10 characters
    expect(kv(out, 'Characters decoded')).toBe('10');
    expect(notes(out, 'warn').join('\n')).toMatch(/only holds 10 of the 100/);
    expect(() => run(asInput(noiseRgba(2, 2, 1)), { length: 5 })).toThrow(ToolError);
  });

  it('rejects out-of-range settings with a plain sentence', () => {
    const img = asInput(noiseRgba(10, 10, 1));
    expect(() => run(img, { length: 0 })).toThrow(/Message length/);
    expect(() => run(img, { k: 0 })).toThrow(/Digits per character/);
    expect(() => run(img, { offset: -1 })).toThrow(/Start offset/);
    expect(() => run(img, { n: '9' as Opts['n'] })).toThrow(/Group size/);
  });
});

// ---------- the tool: auto ----------

describe('emd tool: auto', () => {
  it('lists the top 5 by readable %, side by side with printable %', async () => {
    const out = run(await sampleInput('emd-hello.png'), { mode: 'auto', length: 13 });
    const table = pick(out, 'table')[0]!;
    expect(table.rows).toHaveLength(5);
    expect(table.columns).toEqual([
      '#',
      'Readable %',
      'Printable %',
      'Settings',
      'Text (first 160 characters)',
    ]);
    expect(table.rows[0]).toEqual([
      1,
      '100.0 %',
      '100.0 %',
      'Rows, 1..n, MSB first, k = 3',
      'HELLO_EMD_123',
    ]);
    const readable = table.rows.map((r) => parseFloat(String(r[1])));
    expect(readable).toEqual([...readable].sort((a, b) => b - a));
    expect(table.highlight).toEqual([0]);
  });

  it('offers one "use these settings" button per row, and they work', async () => {
    const input = await sampleInput('emd-hello.png');
    const out = run(input, { mode: 'auto', length: 13 });
    const buttons = pick(out, 'actions').find((a) => a.label === 'Use these settings')!.actions;
    expect(buttons).toHaveLength(5);
    expect(buttons[0]!.label).toBe('#1: Rows, 1..n, MSB first, k = 3');
    expect(buttons[0]!.options).toEqual({
      mode: 'decode',
      n: '2',
      length: 13,
      k: 3,
      weights: 'asc',
      digitOrder: 'msb',
      scan: 'row',
      offset: 0,
    });
    const decoded = run(input, { ...(buttons[0]!.options as Partial<Opts>) });
    expect(pick(decoded, 'text')[0]!.value).toBe('HELLO_EMD_123');
  });

  it('explains why printable % proves nothing', async () => {
    const out = run(await sampleInput('emd-hello.png'), { mode: 'auto', length: 13 });
    expect(notes(out, 'info').join('\n')).toMatch(/74 %/);
  });

  it('uses n and the channel from the options', () => {
    const cover = noiseRgba(64, 64, 21);
    const plane = rgbaToGray(cover, 'b');
    const p: EmdParams = {
      n: 4,
      k: 3,
      length: 11,
      weights: 'desc',
      digitOrder: 'msb',
      scan: 'col',
      offset: 0,
    };
    encodeEmd(plane, 'Hello wor.d', p);
    for (let i = 0; i < plane.data.length; i++) cover.data[4 * i + 2] = plane.data[i]!;
    const out = run(asInput(cover), { mode: 'auto', n: '4', length: 11, channel: 'b' });
    const best = pick(out, 'table')[0]!.rows[0]!;
    expect(best.slice(3)).toEqual(['Columns, n..1, MSB first, k = 3', 'Hello wor.d']);
  });

  it('warns when nothing reads well', () => {
    const out = run(asInput(noiseRgba(64, 64, 4)), { mode: 'auto', length: 200 });
    expect(notes(out, 'warn').join('\n')).toMatch(/clearly readable/);
  });
});

// ---------- the tool: encode ----------

describe('emd tool: encode', () => {
  const grayPngInfo = (png: Uint8Array) => {
    const d = decodePng(png);
    return { channels: d.channels, depth: d.depth, colorType: png[25] };
  };

  it('hides the message in the cover and proves it with a round trip', async () => {
    const out = run(await sampleInput('emd-cover.png'), { mode: 'encode' });
    expect(notes(out, 'success')).toEqual(["Round trip: OK, 'HELLO_EMD_123'"]);
    expect(kv(out, 'Groups that overflowed 0/255')).toBe('0');
    expect(kv(out, 'Largest change')).toBe('±1');
    expect(kv(out, 'Pixels changed')).toMatch(/^\d+ of 32768 \(0\.\d+ %\)$/);
    expect(kv(out, 'Groups used')).toBe('39 of 16384');
    expect(kv(out, 'Characters × digits per character')).toBe('13 × 3 = 39 groups of n = 2 pixels');
    expect(notes(out, 'warn')).toEqual([]);
  });

  it('writes a grayscale PNG with channel gray, and it is the shipped sample', async () => {
    const out = run(await sampleInput('emd-cover.png'), { mode: 'encode' });
    const picture = pick(out, 'picture')[0]!;
    expect(picture.mime).toBe('image/png');
    expect(grayPngInfo(picture.data)).toEqual({ channels: 1, depth: 8, colorType: 0 });
    const file = pick(out, 'files')[0]!.files[0]!;
    expect(file.name).toBe('emd-stego.png');
    expect([...file.data]).toEqual([...picture.data]);
    expect([...picture.data]).toEqual([...sample('emd-hello.png')]);
    expect(notes(out, 'info').join('\n')).toMatch(/grayscale PNG/);
  });

  it('changes at most one pixel per group, by 1', async () => {
    const input = await sampleInput('emd-cover.png');
    const out = run(input, { mode: 'encode', message: 'flag{abc}', n: '3', k: 3 });
    const picture = pick(out, 'picture')[0]!;
    const before = rgbaToGray(input.image, 'gray').data;
    const after = rgbaToGray(decodeImageExact(picture.data)!, 'gray').data;
    let changed = 0;
    for (let i = 0; i < before.length; i++) {
      const d = Math.abs(before[i]! - after[i]!);
      expect(d).toBeLessThanOrEqual(1);
      if (d) changed++;
    }
    expect(changed).toBeLessThanOrEqual(9 * 3);
    expect(kv(out, 'Pixels changed')).toMatch(new RegExp(`^${changed} of `));
  });

  it('with a colour channel only that channel changes, and the file is RGB', async () => {
    const input = await sampleInput('emd-cover.png');
    for (const [channel, idx] of [
      ['r', 0],
      ['g', 1],
      ['b', 2],
    ] as const) {
      const out = run(input, { mode: 'encode', channel });
      expect(notes(out, 'success')).toEqual(["Round trip: OK, 'HELLO_EMD_123'"]);
      const png = pick(out, 'picture')[0]!.data;
      expect(grayPngInfo(png)).toEqual({ channels: 3, depth: 8, colorType: 2 });
      const after = decodeImageExact(png)!;
      let changed = 0;
      for (let i = 0; i < input.image.data.length; i++) {
        const d = Math.abs(input.image.data[i]! - after.data[i]!);
        if (d && i % 4 !== idx) throw new Error(`channel ${channel}: byte ${i} changed`);
        if (d) changed++;
      }
      expect(changed).toBeGreaterThan(0);
      expect(notes(out, 'info').join('\n')).not.toMatch(/grayscale PNG/);
    }
  });

  it('keeps the transparency of the cover in colour channels, drops it in gray', () => {
    const cover = noiseRgba(40, 40, 8);
    cover.data[3] = 128;
    const rgb = run(asInput(cover), { mode: 'encode', channel: 'r' });
    expect(grayPngInfo(pick(rgb, 'picture')[0]!.data).channels).toBe(4);
    expect(decodeImageExact(pick(rgb, 'picture')[0]!.data)!.data[3]).toBe(128);
    const gray = run(asInput(cover), { mode: 'encode' });
    expect(notes(gray, 'info').join('\n')).toMatch(/transparency/);
  });

  it('can be decoded again with the settings it reports', async () => {
    const input = await sampleInput('emd-cover.png');
    const settings: Partial<Opts> = {
      n: '4',
      k: 3,
      weights: 'desc',
      digitOrder: 'lsb',
      scan: 'col',
      offset: 321,
    };
    const out = run(input, { mode: 'encode', message: 'Offset ok!', ...settings });
    expect(kv(out, 'Settings to decode it')).toBe(
      'n = 4 (base 9), k = 3, length = 10, n..1, LSB first, Columns, offset 321, Gray (luma)',
    );
    const stego = (await prepareInput('image', {
      bytes: pick(out, 'picture')[0]!.data,
    })) as ImageInput;
    const back = run(stego, { ...settings, length: 10 });
    expect(pick(back, 'text')[0]!.value).toBe('Offset ok!');
  });

  it('counts the groups that overflow 0/255 and warns', () => {
    const white: RgbaImage = {
      width: 32,
      height: 32,
      data: new Uint8ClampedArray(32 * 32 * 4).fill(255),
    };
    const message = 'overflow test 123';
    const expected = encodeEmd(rgbaToGray(white, 'gray'), message, {
      ...DEFAULTS,
      length: message.length,
    });
    expect(expected).toBeGreaterThan(0);
    const out = run(asInput(white), { mode: 'encode', message });
    expect(kv(out, 'Groups that overflowed 0/255')).toBe(String(expected));
    expect(notes(out, 'warn').join('\n')).toContain(`${expected} groups could not be adjusted`);
    expect(notes(out, 'error').join('\n')).toMatch(/Round trip: FAILED/);
    expect(notes(out, 'success')).toEqual([]);
  });

  it('refuses "}" with n = 2, k = 3 in plain English, before the core is called', async () => {
    const input = await sampleInput('emd-cover.png');
    const attempt = () => run(input, { mode: 'encode', message: 'a}b' });
    expect(attempt).toThrow(ToolError);
    expect(attempt).toThrow(
      /character "\}" \(code 125\) cannot be hidden with n = 2 \(base 5\) and k = 3/,
    );
    expect(attempt).not.toThrow(/caractere/);
    expect(() => run(input, { mode: 'encode', message: 'a}b', k: 4 })).not.toThrow();
  });

  it('refuses a cover that is too small, and an empty message', () => {
    const small = asInput(noiseRgba(16, 16, 2));
    const tiny = asInput(noiseRgba(8, 8, 2));
    const attempt = () => run(tiny, { mode: 'encode' });
    expect(attempt).toThrow(ToolError);
    expect(attempt).toThrow(
      /too small.*needs 78 pixels = 13 \(characters\) × 3 \(digits\) × 2 \(pixels per digit\) \+ 0 \(offset\), but the image has 64/,
    );
    expect(attempt).not.toThrow(/image trop petite/);
    expect(() => run(small, { mode: 'encode' })).not.toThrow();
    expect(() => run(small, { mode: 'encode', message: '' })).toThrow(/Type the message/);
    expect(() => run(small, { mode: 'encode', offset: 200 })).toThrow(/too small/);
  });

  it('reports a round trip that fails instead of hiding it (non-ASCII text)', async () => {
    const out = run(await sampleInput('emd-cover.png'), {
      mode: 'encode',
      message: 'café',
      n: '4',
    });
    expect(notes(out, 'error').join('\n')).toMatch(/Round trip: FAILED.*'caf·'.*'café'/);
  });
});
