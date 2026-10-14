import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decode, encode } from 'fast-png';
import { resultToText } from '../../core/result-text';
import type { Output } from '../../core/types';
import { concatBytes, utf8Encode } from '../../lib/bytes';
import tool from './image-structure';
import { crc32 } from './_crc32';
import { bruteForceIhdr, parsePng, readIhdr } from './_png';

const sample = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../../../public/samples/${name}`, import.meta.url)));
const run = (bytes: Uint8Array, name = 'test.png') => tool.run({ bytes, name }, {}) as Output[];
const files = (out: Output[]) => {
  const f = out.find((o) => o.type === 'files');
  return f?.type === 'files' ? f.files : [];
};
const table = (out: Output[], label: string) => {
  const t = out.find((o) => o.type === 'table' && o.label === label);
  if (t?.type !== 'table') throw new Error(`no table ${label}`);
  return t;
};

function pngOf(w: number, h: number): Uint8Array {
  const data = new Uint8Array(w * h * 3);
  for (let i = 0; i < data.length; i++) data[i] = (i * 31 + ((i / 3) | 0) * 7) & 0xff;
  return encode({ width: w, height: h, data, depth: 8, channels: 3 });
}
const u32 = (n: number) => new Uint8Array([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const chunk = (type: string, data: Uint8Array) => {
  const t = utf8Encode(type);
  return concatBytes(u32(data.length), t, data, u32(crc32(concatBytes(t, data))));
};
/** Re-serialise a PNG with extra chunks inserted before IDAT. */
function insertBeforeIdat(png: Uint8Array, extra: Uint8Array): Uint8Array {
  const p = parsePng(png)!;
  const idat = p.chunks.find((c) => c.type === 'IDAT')!;
  return concatBytes(png.subarray(0, idat.offset), extra, png.subarray(idat.offset));
}
/** Edit width/height in IHDR without touching the stored CRC (the CTF trick). */
function tamper(png: Uint8Array, w: number, h: number): Uint8Array {
  const out = png.slice();
  const dv = new DataView(out.buffer);
  dv.setUint32(16, w);
  dv.setUint32(20, h);
  return out;
}

describe('PNG: IHDR repair', () => {
  it('recovers the cropped height of the sample and writes a valid PNG', () => {
    const out = run(sample('stego-badcrc.png'), 'stego-badcrc.png');
    expect(resultToText(out)).toContain('Recovered size: 256x64');
    const fixed = files(out).find((f) => f.name === 'stego-badcrc-fixed.png')!;
    const parsed = parsePng(fixed.data)!;
    expect(parsed.chunks.every((c) => c.crcOk)).toBe(true);
    const img = decode(fixed.data);
    expect([img.width, img.height]).toEqual([256, 64]);
    // The flag is drawn in the rows that were cropped away.
    const lastRows = Array.from(img.data.slice(40 * 256 * 3, 56 * 256 * 3));
    expect(lastRows.some((v, i) => i % 3 === 0 && v === 200)).toBe(true);
  });

  it.each([
    ['height', 120, 77, 120, 20],
    ['width', 120, 77, 31, 77],
    ['both', 300, 200, 100, 50],
  ])('recovers a tampered %s exactly', (_kind, w, h, tw, th) => {
    const original = pngOf(w, h);
    const damaged = tamper(original, tw, th);
    const out = run(damaged);
    const fixed = files(out).find((f) => f.name.endsWith('-fixed.png'))!;
    expect(Array.from(fixed.data)).toEqual(Array.from(original));
    expect(resultToText(out)).toContain(`Recovered size: ${w}x${h}`);
  });

  it('prefers the size that fits the image data when several match the CRC', () => {
    const original = pngOf(64, 48);
    const stored = readIhdr(original, 16);
    const found = bruteForceIhdr(
      { ...stored, width: 3, height: 5 },
      parsePng(original)!.chunks[0]!.crcStored,
    );
    expect(found.some((r) => r.ihdr.width === 64 && r.ihdr.height === 48)).toBe(true);
  });

  it('is fast enough for a full width+height search', () => {
    const t0 = performance.now();
    run(tamper(pngOf(40, 30), 7777, 6666));
    expect(performance.now() - t0).toBeLessThan(2500);
  });

  it('derives the height from the image data when the CRC was recomputed', () => {
    const original = pngOf(50, 40);
    const p = parsePng(original)!;
    const ihdr = p.chunks[0]!;
    const forged = original.slice();
    new DataView(forged.buffer).setUint32(ihdr.dataStart + 4, 10);
    new DataView(forged.buffer).setUint32(
      ihdr.dataStart + 13,
      crc32(forged.subarray(ihdr.offset + 4, ihdr.dataStart + 13)),
    );
    expect(parsePng(forged)!.chunks[0]!.crcOk).toBe(true);
    const out = run(forged);
    expect(resultToText(out)).toMatch(/holds 40 rows/);
    const fixed = files(out).find((f) => f.name.endsWith('-fixed.png'))!;
    expect(Array.from(fixed.data)).toEqual(Array.from(original));
  });

  it('flags a clean PNG as sound and offers no repair', () => {
    const out = run(pngOf(20, 20));
    expect(resultToText(out)).toContain('The PNG structure is sound');
    expect(files(out)).toHaveLength(0);
  });
});

describe('PNG: chunks and hidden data', () => {
  it('lists chunks with stored vs computed CRC and marks the bad one', () => {
    const t = table(run(sample('stego-badcrc.png')), 'Chunks');
    expect(t.rows[0]!.slice(2, 3)).toEqual(['IHDR']);
    expect(t.rows[0]![6]).toBe('BAD');
    expect(t.rows[1]![6]).toBe('OK');
    expect(t.rows[0]![4]).not.toBe(t.rows[0]![5]);
    expect(t.highlight).toContain(0);
  });

  it('decodes tEXt, zTXt and iTXt (also compressed iTXt)', () => {
    const itxtCompressed = chunk(
      'iTXt',
      concatBytes(
        utf8Encode('Title'),
        new Uint8Array([0, 1, 0]),
        utf8Encode('fr'),
        new Uint8Array([0, 0]),
        new Uint8Array(deflateSync(utf8Encode('flag{compressed_itxt}'))),
      ),
    );
    const png = insertBeforeIdat(pngOf(8, 8), itxtCompressed);
    const text = resultToText(run(png));
    expect(text).toContain('iTXt Title (language fr): flag{compressed_itxt}');
    const sampleText = resultToText(run(sample('stego-text-chunk.png')));
    expect(sampleText).toContain('tEXt Author: Find The Flag samples');
    expect(sampleText).toContain('zTXt Secret: flag{png_text_chunks}');
    expect(sampleText).toContain('Un message caché');
  });

  it('extracts data after IEND byte for byte', () => {
    const png = pngOf(10, 10);
    const hidden = utf8Encode('flag{after_iend}');
    const out = run(concatBytes(png, hidden), 'cat.png');
    const f = files(out).find((x) => x.name === 'cat-after-iend.txt')!;
    expect(new TextDecoder().decode(f.data)).toBe('flag{after_iend}');
    expect(resultToText(out)).toMatch(
      /16 bytes\) follow the end of the image at offset \d+: plain text/,
    );
  });

  it('identifies an appended ZIP', () => {
    const out = run(sample('stego-trailing.png'), 'stego-trailing.png');
    const f = files(out).find((x) => x.name.endsWith('.zip'))!;
    expect(f.data.slice(0, 4)).toEqual(new Uint8Array([0x50, 0x4b, 3, 4]));
    expect(new TextDecoder().decode(f.data)).toContain('flag{appended_after_iend}');
  });

  it('highlights and extracts private chunks', () => {
    const secret = utf8Encode('flag{private_chunk}');
    const png = insertBeforeIdat(pngOf(8, 8), chunk('sTeG', secret));
    const out = run(png, 'p.png');
    const t = table(out, 'Chunks');
    const row = t.rows.findIndex((r) => r[2] === 'sTeG');
    expect(row).toBeGreaterThan(0);
    expect(t.highlight).toContain(row);
    expect(String(t.rows[row]![7])).toContain('flag{private_chunk}');
    expect(files(out).find((f) => f.name.includes('sTeG'))!.data).toEqual(secret);
  });

  it('reads a PNG with a damaged signature and says so', () => {
    const png = pngOf(8, 8).slice();
    png[1] = 0x51;
    const out = run(png);
    expect(resultToText(out)).toContain('signature is damaged');
    expect(table(out, 'Chunks').rows[0]![2]).toBe('IHDR');
  });

  it('reports a corrupt chunk length instead of crashing', () => {
    const png = pngOf(8, 8).slice();
    new DataView(png.buffer).setUint32(33, 0x7fffff00); // IDAT length
    const text = resultToText(run(png));
    expect(text).toMatch(/Chunk "IDAT" at offset 33 claims/);
  });

  it('groups consecutive IDAT chunks', () => {
    const png = pngOf(64, 64);
    const p = parsePng(png)!;
    const idat = p.chunks.find((c) => c.type === 'IDAT')!;
    const payload = png.subarray(idat.dataStart, idat.dataStart + idat.length);
    const pieces: Uint8Array[] = [];
    for (let i = 0; i < payload.length; i += 100)
      pieces.push(chunk('IDAT', payload.subarray(i, i + 100)));
    const split = concatBytes(
      png.subarray(0, idat.offset),
      ...pieces,
      png.subarray(idat.offset + 12 + idat.length),
    );
    const t = table(run(split), 'Chunks');
    expect(t.rows).toHaveLength(3);
    expect(String(t.rows[1]![2])).toMatch(/^IDAT x\d+$/);
  });
});

describe('JPEG', () => {
  it('lists segments, decodes the comment and finds dimensions', () => {
    const out = run(sample('stego-exif.jpg'), 'x.jpg');
    const t = table(out, 'Segments');
    expect(t.rows.map((r) => r[3])).toEqual([
      'SOI',
      'APP1',
      'COM',
      'DQT',
      'SOF0',
      'DHT',
      'DHT',
      'SOS',
      'EOI',
    ]);
    expect(String(t.rows[4]![5])).toContain('16x16');
    expect(resultToText(out)).toContain('Created by gen-samples-stego.mjs');
    expect(resultToText(out)).toContain('Application segments: APP1 Exif');
  });

  it('extracts bytes appended after the final FFD9', () => {
    const jpg = sample('stego-exif.jpg');
    const payload = utf8Encode('PK-not-really: flag{after_ffd9}');
    const out = run(concatBytes(jpg, payload), 'photo.jpg');
    const f = files(out).find((x) => x.name.startsWith('photo-after-eoi'))!;
    expect(new TextDecoder().decode(f.data)).toBe('PK-not-really: flag{after_ffd9}');
  });

  it('reports truncation', () => {
    const jpg = sample('stego-exif.jpg');
    expect(resultToText(run(jpg.subarray(0, jpg.length - 2)))).toContain('No end-of-image marker');
  });
});

describe('GIF', () => {
  function gif(): Uint8Array {
    const text = (s: string) => utf8Encode(s);
    const sub = (b: Uint8Array) => concatBytes(new Uint8Array([b.length]), b, new Uint8Array([0]));
    const gce = (delay: number) =>
      concatBytes(new Uint8Array([0x21, 0xf9, 4, 0, delay & 255, delay >> 8, 0, 0]));
    const frame = concatBytes(
      new Uint8Array([0x2c, 0, 0, 0, 0, 2, 0, 2, 0, 0, 2]),
      sub(new Uint8Array([0x44, 0x01])),
    );
    return concatBytes(
      text('GIF89a'),
      new Uint8Array([2, 0, 2, 0, 0x80, 0, 0]),
      new Uint8Array([0, 0, 0, 255, 255, 255]),
      new Uint8Array([0x21, 0xff, 11]),
      text('NETSCAPE2.0'),
      sub(new Uint8Array([1, 0, 0])),
      new Uint8Array([0x21, 0xfe]),
      sub(text('flag{gif_comment}')),
      gce(10),
      frame,
      gce(65),
      frame,
      new Uint8Array([0x3b]),
    );
  }

  it('reports version, size, frames, delays and comments', () => {
    const text = resultToText(run(gif(), 'a.gif'));
    expect(text).toContain('Format: GIF (GIF89a)');
    expect(text).toContain('Dimensions: 2x2');
    expect(text).toContain('Frames: 2');
    expect(text).toContain('Frame delays (1/100 s): 10 65');
    expect(text).toContain('Loop count: forever');
    expect(text).toContain('flag{gif_comment}');
    expect(text).not.toContain('truncated');
  });

  it('extracts data after the trailer', () => {
    const out = run(concatBytes(gif(), utf8Encode('flag{gif_tail}')), 'a.gif');
    const f = files(out).find((x) => x.name.startsWith('a-after-trailer'))!;
    expect(new TextDecoder().decode(f.data)).toBe('flag{gif_tail}');
  });
});

describe('input handling and triage', () => {
  it('rejects other formats with a pointer to the right tool', () => {
    expect(() => run(new Uint8Array([0x50, 0x4b, 3, 4, 0, 0, 0, 0]))).toThrow(
      /ZIP archive.*PNG, JPEG and GIF/,
    );
    expect(() => run(utf8Encode('hello'))).toThrow(/PNG, JPEG and GIF/);
    expect(() => run(new Uint8Array())).toThrow(/Drop a PNG/);
  });

  it('detect scores damaged files higher than clean ones', () => {
    const png = pngOf(8, 8);
    const clean = tool.detect!({ text: null, bytes: png })!;
    const dirty = tool.detect!({ text: null, bytes: concatBytes(png, utf8Encode('x')) })!;
    expect(dirty.score).toBeGreaterThan(clean.score);
    expect(tool.detect!({ text: null, bytes: sample('stego-exif.jpg') })!.score).toBeGreaterThan(
      0.25,
    );
    expect(tool.detect!({ text: 'hello', bytes: utf8Encode('hello') })).toBeNull();
  });
});
