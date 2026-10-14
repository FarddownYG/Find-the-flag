import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resultToText } from '../../core/result-text';
import type { Output } from '../../core/types';
import { concatBytes, latin1Encode, utf8Encode } from '../../lib/bytes';
import { crc32 } from './_crc32';
import tool, { decodeUserComment } from './metadata';

const sample = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../../../public/samples/${name}`, import.meta.url)));
const run = (bytes: Uint8Array, name = 'x') =>
  Promise.resolve(tool.run({ bytes, name }, {})) as Promise<Output[]>;
const kv = (out: Output[], label: string) => {
  const b = out.find((o) => o.type === 'kv' && o.label === label);
  return b?.type === 'kv' ? new Map(b.entries) : new Map<string, string>();
};

/** Find a byte pattern and overwrite its first byte (used to flip GPS references in the sample). */
function patch(bytes: Uint8Array, pattern: number[], offset: number, value: number): Uint8Array {
  const out = bytes.slice();
  for (let i = 0; i + pattern.length <= out.length; i++) {
    if (pattern.every((b, k) => out[i + k] === b)) {
      out[i + offset] = value;
      return out;
    }
  }
  throw new Error('pattern not found');
}

describe('EXIF / metadata', () => {
  it('groups camera, dates, GPS and text fields of a JPEG', async () => {
    const out = await run(sample('stego-exif.jpg'), 'stego-exif.jpg');
    expect(kv(out, 'Camera and image').get('Make')).toBe('FindTheFlag Labs');
    expect(kv(out, 'Camera and image').get('ExposureTime')).toBe('1/250 s');
    const dates = kv(out, 'Dates');
    expect(dates.get('DateTimeOriginal')).toBe('2024:03:15 10:29:41');
    expect(dates.get('ModifyDate')).toBe('2024:03:15 10:30:00');
    expect(dates.has('ExposureTime')).toBe(false);
    const gps = kv(out, 'GPS');
    expect(gps.get('Latitude, longitude')).toBe('48.858400, 2.294500');
    expect(gps.get('Degrees')).toBe('48°51\'30.24"N 2°17\'40.20"E');
    const text = kv(out, 'Software and text');
    expect(text.get('ImageDescription')).toBe('flag{exif}');
    expect(text.get('UserComment')).toBe('The real message is in the description.');
    expect(resultToText(out)).toContain('GPS position embedded: 48.858400, 2.294500');
    expect(resultToText(out)).toMatch(/Free-text fields worth reading: ImageDescription/);
    expect(resultToText(out)).toContain('Created by gen-samples-stego.mjs');
  });

  it('extracts the embedded thumbnail as a JPEG file', async () => {
    const out = await run(sample('stego-exif.jpg'));
    const files = out.find((o) => o.type === 'files');
    if (files?.type !== 'files') throw new Error('no thumbnail');
    const thumb = files.files[0]!;
    expect(thumb.name).toBe('thumbnail.jpg');
    expect(Array.from(thumb.data.slice(0, 3))).toEqual([0xff, 0xd8, 0xff]);
    expect(Array.from(thumb.data.slice(-2))).toEqual([0xff, 0xd9]);
    expect(thumb.note).toContain('8x8 JPEG');
  });

  it('gives negative coordinates for S and W references', async () => {
    let b = patch(sample('stego-exif.jpg'), [1, 0, 2, 0, 2, 0, 0, 0, 0x4e, 0, 0, 0], 8, 0x53);
    b = patch(b, [3, 0, 2, 0, 2, 0, 0, 0, 0x45, 0, 0, 0], 8, 0x57);
    const out = await run(b);
    expect(kv(out, 'GPS').get('Latitude, longitude')).toBe('-48.858400, -2.294500');
    expect(kv(out, 'GPS').get('Degrees')).toBe('48°51\'30.24"S 2°17\'40.20"W');
  });

  it('lists every raw tag with its group', async () => {
    const out = await run(sample('stego-exif.jpg'));
    const t = out.find((o) => o.type === 'table' && o.label === 'All tags');
    if (t?.type !== 'table') throw new Error('no table');
    expect(t.columns).toEqual(['Group', 'Tag', 'Value']);
    expect(t.rows).toContainEqual(['IFD0 (main image)', 'Software', 'stego-sample 1.0']);
    expect(t.rows).toContainEqual(['EXIF', 'ISO', '200']);
  });

  it('reads PNG text chunks (including zTXt that EXIF readers skip)', async () => {
    const out = await run(sample('stego-text-chunk.png'));
    const chunks = kv(out, 'PNG text chunks');
    expect(chunks.get('zTXt Secret')).toBe('flag{png_text_chunks}');
    expect(chunks.get('tEXt Author')).toBe('Find The Flag samples');
  });

  it('shows the PNG modification time', async () => {
    const t = new Uint8Array([0x07, 0xe8, 3, 15, 10, 30, 5]);
    const type = utf8Encode('tIME');
    const u32 = (n: number) =>
      new Uint8Array([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
    const chunk = concatBytes(u32(7), type, t, u32(crc32(concatBytes(type, t))));
    const png = sample('stego-lsb.png');
    const idat = 33;
    const withTime = concatBytes(png.subarray(0, idat), chunk, png.subarray(idat));
    expect(kv(await run(withTime), 'PNG modification time').get('tIME')).toBe(
      '2024-03-15 10:30:05 UTC',
    );
  });

  it('reads a JPEG comment when there is no EXIF at all', async () => {
    const com = utf8Encode('flag{just_a_comment}');
    const jpg = concatBytes(
      new Uint8Array([0xff, 0xd8, 0xff, 0xfe, 0, com.length + 2]),
      com,
      new Uint8Array([0xff, 0xd9]),
    );
    const text = resultToText(await run(jpg));
    expect(text).toContain('flag{just_a_comment}');
  });

  it('says so when a photo has been stripped', async () => {
    const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0, 3, 0, 0xff, 0xd9]);
    expect(resultToText(await run(jpg))).toContain('No EXIF, XMP, IPTC or ICC metadata found');
  });

  it('survives garbage that merely starts like a JPEG', async () => {
    const out = await run(
      concatBytes(new Uint8Array([0xff, 0xd8, 0xff]), utf8Encode('not really a jpeg at all')),
    );
    expect(out.length).toBeGreaterThan(0);
  });

  it('extracts a raw XMP packet from a PNG iTXt chunk', async () => {
    const xmp =
      '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><dc:creator>flag{xmp_packet}</dc:creator></rdf:RDF></x:xmpmeta>';
    const type = utf8Encode('iTXt');
    const body = concatBytes(
      utf8Encode('XML:com.adobe.xmp'),
      new Uint8Array([0, 0, 0, 0, 0]),
      utf8Encode(xmp),
    );
    const u32 = (n: number) =>
      new Uint8Array([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
    const chunk = concatBytes(u32(body.length), type, body, u32(crc32(concatBytes(type, body))));
    const png = sample('stego-lsb.png');
    const text = resultToText(await run(concatBytes(png.subarray(0, 33), chunk, png.subarray(33))));
    expect(text).toContain('flag{xmp_packet}');
  });

  it('reads the information dictionary of a PDF, including old versions', async () => {
    const pdf = latin1Encode(
      '%PDF-1.4\n1 0 obj << /Title (Annual \\(draft\\) report) /Author <FEFF00480069> /Producer (hand-made) >> endobj\n%%EOF\n' +
        '1 0 obj << /Title (Final) >> endobj\n%%EOF\n',
    );
    const out = await run(pdf);
    const info = kv(out, 'PDF document information');
    expect(info.get('PDF version')).toBe('1.4');
    const byPrefix = (prefix: string) => [...info].find(([k]) => k.startsWith(prefix))?.[1];
    expect(byPrefix('Title #1 (offset ')).toBe('Annual (draft) report');
    expect(byPrefix('Title #2 (offset ')).toBe('Final');
    expect(info.get('Author')).toBe('Hi');
    expect(info.get('Producer')).toBe('hand-made');
    expect(resultToText(out)).toContain('2 end-of-file markers');
  });

  it('explains that it is for images when given something else', async () => {
    const out = await run(utf8Encode('just some text, nothing to see'));
    expect(out).toHaveLength(1);
    expect(resultToText(out)).toMatch(/does not look like an image or a PDF/);
  });

  it('rejects empty input', async () => {
    await expect(run(new Uint8Array())).rejects.toThrow(/Drop a photo/);
  });
});

describe('decodeUserComment', () => {
  const id = (s: string) => latin1Encode(s.padEnd(8, '\0'));
  it('handles the EXIF character-code prefixes', () => {
    expect(decodeUserComment(concatBytes(id('ASCII'), utf8Encode('hello\0')))).toBe('hello');
    expect(decodeUserComment(concatBytes(id('UNICODE'), new Uint8Array([0, 0x68, 0, 0x69])))).toBe(
      'hi',
    );
    expect(decodeUserComment(concatBytes(id('UNICODE'), new Uint8Array([0x68, 0, 0x69, 0])))).toBe(
      'hi',
    );
    expect(decodeUserComment(concatBytes(new Uint8Array(8), utf8Encode('héllo')))).toBe('héllo');
  });
});

describe('triage', () => {
  it('scores a JPEG with EXIF above one without', () => {
    const withExif = tool.detect!({ text: null, bytes: sample('stego-exif.jpg') })!;
    const bare = tool.detect!({ text: null, bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]) })!;
    expect(withExif.score).toBeGreaterThan(bare.score);
    expect(tool.detect!({ text: 'abc', bytes: utf8Encode('abc') })).toBeNull();
  });
});
