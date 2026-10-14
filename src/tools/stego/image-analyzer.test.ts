import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { unzipSync } from 'fflate';
import { encode as encodeJpeg } from 'jpeg-js';
import { describe, expect, it } from 'vitest';
import { resultToText } from '../../core/result-text';
import type { FileInput, Output, RgbaImage } from '../../core/types';
import { concatBytes, utf8Decode, utf8Encode } from '../../lib/bytes';
import { compareThumbnail, decodeJpeg } from './_image-analyzer-thumb';
import { parseJpeg } from './_jpeg';
import tool from './image-analyzer';

// ---------------------------------------------------------------- helpers

const sample = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../../../public/samples/${name}`, import.meta.url)));
const EIFFEL = sample('meta-eiffel.jpg');

const run = (bytes: Uint8Array, opts: { compare?: FileInput | null; minLength?: number } = {}) =>
  Promise.resolve(
    tool.run({ bytes, name: 'test.jpg' }, { compare: null, minLength: 6, ...opts }),
  ) as Promise<Output[]>;

const block = <T extends Output['type']>(out: Output[], type: T, label?: string) => {
  const b = out.find(
    (o) => o.type === type && (label === undefined || ('label' in o && o.label === label)),
  );
  return b as Extract<Output, { type: T }> | undefined;
};
const kv = (out: Output[], label: string) => new Map(block(out, 'kv', label)?.entries ?? []);
const files = (out: Output[]) => block(out, 'files')?.files ?? [];
const fileNamed = (out: Output[], name: string) => {
  const f = files(out).find((x) => x.name === name);
  if (!f) throw new Error(`no file ${name}`);
  return f.data;
};
const notes = (out: Output[]) =>
  out.flatMap((o) => (o.type === 'note' ? [`${o.level}: ${o.text}`] : []));

const le16 = (n: number) => new Uint8Array([n & 255, (n >>> 8) & 255]);
const le32 = (n: number) =>
  new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);
const be16 = (n: number) => new Uint8Array([(n >>> 8) & 255, n & 255]);
const ascii = (s: string) => concatBytes(utf8Encode(s), new Uint8Array([0]));
const rational = (...pairs: [number, number][]) =>
  concatBytes(...pairs.flatMap(([n, d]) => [le32(n), le32(d)]));

type Entry = [tag: number, type: number, value: Uint8Array | { ptr: 'gps' | 'ifd1' | 'thumb' }];
const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1 };

/** Minimal little-endian EXIF APP1: IFD0 (+ GPS IFD) (+ IFD1 with a JPEG thumbnail). */
function exifApp1(opts: { ifd0?: Entry[]; gps?: Entry[]; thumbnail?: Uint8Array }): Uint8Array {
  const ifd0: Entry[] = [...(opts.ifd0 ?? [[0x010f, 2, ascii('Test')]])];
  if (opts.gps) ifd0.push([0x8825, 4, { ptr: 'gps' }]);
  const ifds: { name: string; entries: Entry[] }[] = [{ name: 'ifd0', entries: ifd0 }];
  if (opts.gps) ifds.push({ name: 'gps', entries: [...opts.gps] });
  if (opts.thumbnail) {
    ifds.push({
      name: 'ifd1',
      entries: [
        [0x0103, 3, le16(6)],
        [0x0201, 4, { ptr: 'thumb' }],
        [0x0202, 4, le32(opts.thumbnail.length)],
      ],
    });
  }
  const offsets: Record<string, number> = {};
  let pos = 8;
  for (const i of ifds) {
    i.entries.sort((a, b) => a[0] - b[0]);
    offsets[i.name] = pos;
    pos += 2 + 12 * i.entries.length + 4;
  }
  const area: Uint8Array[] = [];
  const placed = new Map<Entry, number>();
  for (const i of ifds) {
    for (const e of i.entries) {
      const v = e[2];
      if (v instanceof Uint8Array && v.length > 4) {
        placed.set(e, pos);
        area.push(v.length % 2 ? concatBytes(v, new Uint8Array(1)) : v);
        pos += v.length + (v.length % 2);
      }
    }
  }
  offsets.thumb = pos;
  const body = ifds.map((i) =>
    concatBytes(
      le16(i.entries.length),
      ...i.entries.map((e) => {
        const [tag, type, v] = e;
        const field =
          v instanceof Uint8Array
            ? placed.has(e)
              ? le32(placed.get(e)!)
              : concatBytes(v, new Uint8Array(4 - v.length))
            : le32(offsets[v.ptr]!);
        const count = v instanceof Uint8Array ? v.length / TYPE_SIZE[type]! : 1;
        return concatBytes(le16(tag), le16(type), le32(count), field);
      }),
      le32(i.name === 'ifd0' && offsets.ifd1 ? offsets.ifd1 : 0),
    ),
  );
  const tiff = concatBytes(
    utf8Encode('II'),
    le16(42),
    le32(8),
    ...body,
    ...area,
    opts.thumbnail ?? new Uint8Array(),
  );
  const payload = concatBytes(utf8Encode('Exif\0\0'), tiff);
  return concatBytes(new Uint8Array([0xff, 0xe1]), be16(payload.length + 2), payload);
}

const gpsEntries = (latRef: string, lonRef: string): Entry[] => [
  [0x0001, 2, ascii(latRef)],
  [0x0002, 5, rational([33, 1], [51, 1], [2448, 100])], // 33° 51' 24.48" = 33.8568
  [0x0003, 2, ascii(lonRef)],
  [0x0004, 5, rational([151, 1], [12, 1], [5508, 100])], // 151° 12' 55.08" = 151.2153
];

/** A procedural "photo": gradient sky, a few shapes. */
function picture(w: number, h: number): RgbaImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let c = [40 + (y * 150) / h, 90 + (x * 100) / w, 200 - (y * 80) / h];
      if ((x - w * 0.3) ** 2 + (y - h * 0.35) ** 2 < (h * 0.18) ** 2) c = [250, 210, 60];
      if (x > w * 0.55 && x < w * 0.85 && y > h * 0.5 && y < h * 0.9) c = [30, 30, 40];
      if (y > h * 0.85) c = [50, 120, 40];
      data[i] = c[0]!;
      data[i + 1] = c[1]!;
      data[i + 2] = c[2]!;
      data[i + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

/** Box-average resize (what a camera does to make the thumbnail). */
function resize(img: RgbaImage, w: number, h: number): RgbaImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sum = [0, 0, 0];
      let n = 0;
      const y0 = Math.floor((y * img.height) / h);
      const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * img.height) / h));
      const x0 = Math.floor((x * img.width) / w);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * img.width) / w));
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          for (let k = 0; k < 3; k++) sum[k]! += img.data[(yy * img.width + xx) * 4 + k]!;
          n++;
        }
      }
      for (let k = 0; k < 3; k++) data[(y * w + x) * 4 + k] = sum[k]! / n;
      data[(y * w + x) * 4 + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

function map(img: RgbaImage, f: (c: number, x: number, y: number) => number): RgbaImage {
  const data = new Uint8ClampedArray(img.data.length);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      for (let k = 0; k < 3; k++) data[i + k] = f(img.data[i + k]!, x, y);
      data[i + 3] = 255;
    }
  }
  return { width: img.width, height: img.height, data };
}

/** Rotate 90° clockwise. */
function rotateCw(img: RgbaImage): RgbaImage {
  const { width: w, height: h } = img;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const src = (y * w + x) * 4;
      const dst = (x * h + (h - 1 - y)) * 4;
      data.set(img.data.subarray(src, src + 4), dst);
    }
  }
  return { width: h, height: w, data };
}

/** Thumbnail with black bars above and below (a 4:3 thumbnail of a wider photo). */
function letterbox(img: RgbaImage, w: number, h: number): RgbaImage {
  const inner = resize(img, w, Math.round((w * img.height) / img.width));
  const top = Math.floor((h - inner.height) / 2);
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  data.set(inner.data, top * w * 4);
  return { width: w, height: h, data };
}

const jpegOf = (img: RgbaImage, quality = 85) =>
  new Uint8Array(
    encodeJpeg({ width: img.width, height: img.height, data: img.data }, quality).data,
  );

/** A JPEG photo carrying `thumb` as its IFD1 thumbnail. */
function photoWithThumbnail(main: RgbaImage, thumb: RgbaImage): Uint8Array {
  const jpg = jpegOf(main, 90);
  return concatBytes(
    jpg.subarray(0, 2),
    exifApp1({ thumbnail: jpegOf(thumb, 60) }),
    jpg.subarray(2),
  );
}

const md5 = (b: Uint8Array) => createHash('md5').update(b).digest('hex');
const sha1 = (b: Uint8Array) => createHash('sha1').update(b).digest('hex');
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

// ---------------------------------------------------------------- tests

describe('Image analyzer: the synthetic Eiffel Tower photo', () => {
  it('starts by saying nothing left the tab', async () => {
    const out = await run(EIFFEL);
    expect(out[0]).toEqual({
      type: 'note',
      level: 'info',
      text: 'Everything below was computed in this tab — the file was not uploaded anywhere.',
    });
    expect(out[1]).toMatchObject({ type: 'kv', label: 'Findings' });
  });

  it('extracts the GPS position exactly and puts it on a map', async () => {
    const out = await run(EIFFEL);
    const m = block(out, 'map');
    expect(m).toBeDefined();
    expect(Math.abs(m!.lat - 48.8584)).toBeLessThan(1e-6);
    expect(Math.abs(m!.lon - 2.2945)).toBeLessThan(1e-6);
    const gps = kv(out, 'GPS details');
    expect(gps.get('Latitude')).toBe('48.858400');
    expect(gps.get('Longitude')).toBe('2.294500');
    // Degrees/minutes/seconds are on the map block; GPS details quotes the file's own values.
    expect(gps.has('Position (DMS)')).toBe(false);
    expect(gps.get('Raw latitude')).toBe('48° 51′ 30.24″ N');
    expect(gps.get('Raw longitude')).toBe('2° 17′ 40.2″ E');
    expect(gps.get('Altitude')).toBe('35 m above sea level');
    expect(gps.get('Direction')).toBe('123.4° (true north)');
    expect(gps.get('Speed')).toBe('0 km/h');
    expect(gps.get('GPS date/time')).toBe('2024-05-01 09:59:30 UTC');
    expect(gps.get('Map datum')).toBe('WGS-84');
    expect(resultToText(out)).toContain(
      'https://www.google.com/maps/search/?api=1&query=48.858400,2.294500',
    );
  });

  it('lists every CTF-relevant fact in Findings', async () => {
    const f = kv(await run(EIFFEL), 'Findings');
    expect([...f.keys()]).toEqual([
      'GPS position',
      'Camera',
      'Taken',
      'Description',
      'User comment',
      'Author / artist',
      'Camera owner',
      'Serial number',
      'Copyright',
      'Software',
      'Keywords',
      'Place names',
      'JPEG comment',
      'Thumbnail',
      'Data after the end',
      'Embedded files',
    ]);
    expect(f.get('GPS position')).toBe('48.858400, 2.294500 (EXIF GPS IFD)');
    expect(f.get('Camera')).toBe('FTF Labs Synthetic Cam 1');
    expect(f.get('Taken')).toBe('2024:05:01 11:59:30 (DateTimeOriginal)');
    expect(f.get('Description')).toBe(
      'Synthetic test picture — Find The Flag (EXIF) | Synthetic IPTC caption for testing (IPTC) | Synthetic XMP description: a drawing, not a photo. (XMP dc:description)',
    );
    expect(f.get('User comment')).toBe('Made up for testing: the GPS points at a landmark. (EXIF)');
    expect(f.get('Author / artist')).toBe('Nobody (EXIF, IPTC, XMP dc:creator)');
    expect(f.get('Camera owner')).toBe('Test Owner (EXIF)');
    expect(f.get('Serial number')).toBe('FTF-000001 (EXIF)');
    expect(f.get('Copyright')).toBe('Public domain (synthetic sample) (EXIF)');
    expect(f.get('Software')).toBe('gen-samples-image-analyzer.mjs (EXIF, XMP xmp:CreatorTool)');
    expect(f.get('Keywords')).toBe('synthetic, tower (IPTC)');
    expect(f.get('Place names')).toBe('Paris (IPTC) | France (IPTC)');
    expect(f.get('JPEG comment')).toBe(
      'Synthetic JPEG comment (gen-samples-image-analyzer.mjs) (COM)',
    );
    expect(f.get('Thumbnail')).toMatch(
      /^differs from the main image \(\d+% similar\): it may show the original picture$/,
    );
    const end = parseJpeg(EIFFEL)!.end!;
    expect(f.get('Data after the end')).toBe(
      `${EIFFEL.length - end} bytes at offset ${end} (0x${end.toString(16)}): ZIP archive`,
    );
    expect(f.get('Embedded files')).toBe(`1: ZIP archive at 0x${end.toString(16)}`);
  });

  it('hashes the file (MD5, SHA-1, SHA-256 checked against node:crypto)', async () => {
    const h = kv(await run(EIFFEL), 'Hashes');
    expect(h.get('MD5')).toBe(md5(EIFFEL));
    expect(h.get('SHA-1')).toBe(sha1(EIFFEL));
    expect(h.get('SHA-256')).toBe(sha256(EIFFEL));
    expect(h.get('Size')).toBe(`${EIFFEL.length} bytes (16.2 KiB)`);
  });

  it('shows the main image and, separately, the EXIF thumbnail', async () => {
    const out = await run(EIFFEL);
    const pictures = out.filter((o) => o.type === 'picture');
    expect(pictures.map((p) => p.label)).toEqual(['Main image', 'EXIF thumbnail']);
    const [main, thumb] = pictures as Extract<Output, { type: 'picture' }>[];
    expect(main!.data).toEqual(EIFFEL);
    expect(thumb!.mime).toBe('image/jpeg');
    expect(Array.from(thumb!.data.subarray(0, 2))).toEqual([0xff, 0xd8]);
    expect(decodeJpeg(thumb!.data)).toMatchObject({ width: 160, height: 100 });
    expect(fileNamed(out, 'test-exif-thumbnail.jpg')).toEqual(thumb!.data);
  });

  it('flags the thumbnail as a different picture', async () => {
    const out = await run(EIFFEL);
    expect(notes(out)).toContain(
      'warn: The EXIF thumbnail does not match the main image — it may show the original picture.',
    );
    const check = kv(out, 'Thumbnail check');
    expect(check.get('Verdict')).toBe('a different picture');
    expect(Number.parseInt(check.get('Similarity')!, 10)).toBeLessThan(30);
  });

  it('extracts the payload appended after FFD9 byte for byte', async () => {
    const out = await run(EIFFEL);
    const end = parseJpeg(EIFFEL)!.end!;
    const t = block(out, 'table', 'Data after the end of the image')!;
    expect(t.rows).toEqual([
      [`${end} (0x${end.toString(16)})`, 'ZIP archive', `${EIFFEL.length - end} bytes`],
    ]);
    const emb = block(out, 'table', 'Embedded files')!;
    expect(emb.rows[0]!.slice(0, 4)).toEqual([
      `${end} (0x${end.toString(16)})`,
      'ZIP archive',
      `${EIFFEL.length - end} bytes`,
      'after the end of the image',
    ]);
    const zip = fileNamed(out, `${end.toString(16).padStart(8, '0')}.zip`);
    expect(zip).toEqual(EIFFEL.subarray(end));
    expect(utf8Decode(unzipSync(zip)['note.txt']!)).toBe('appended payload');
  });

  it('lists every field flat, with readable values', async () => {
    const out = await run(EIFFEL);
    const t = block(out, 'table', 'All metadata')!;
    expect(t.columns).toEqual(['Group', 'Tag', 'Value']);
    for (const row of [
      ['File', 'Dimensions', '320x200'],
      ['JFIF', 'JFIFVersion', '1.01'],
      ['IFD0', 'Make', 'FTF Labs'],
      ['IFD0', 'Model', 'Synthetic Cam 1'],
      ['IFD0', 'Orientation', 'Horizontal (normal)'],
      ['ExifIFD', 'ExposureTime', '1/125 s'],
      ['ExifIFD', 'FNumber', 'f/4'],
      ['ExifIFD', 'ExifVersion', '0232'],
      ['ExifIFD', 'ColorSpace', 'sRGB'],
      ['ExifIFD', 'DateTimeOriginal', '2024:05:01 11:59:30'],
      ['ExifIFD', 'OwnerName', 'Test Owner'],
      ['GPS', 'GPSVersionID', '2.3.0.0'],
      ['GPS', 'GPSLatitude', '48° 51′ 30.24″'],
      ['GPS', 'GPSAltitudeRef', '0 (above sea level)'],
      ['GPS', 'GPSTimeStamp', '09:59:30 UTC'],
      ['IFD1', 'Compression', 'JPEG (old-style)'],
      ['IPTC', 'Caption', 'Synthetic IPTC caption for testing'],
      ['IPTC', 'ApplicationRecordVersion', '00 04'],
      ['XMP', 'dc:description', 'Synthetic XMP description: a drawing, not a photo.'],
      ['XMP', 'dc:creator', 'Nobody'],
      ['JPEG comment', 'Comment', 'Synthetic JPEG comment (gen-samples-image-analyzer.mjs)'],
    ]) {
      expect(t.rows).toContainEqual(row);
    }
    const groups = [...new Set(t.rows.map((r) => r[0]))];
    expect(groups).toEqual([
      'File',
      'JFIF',
      'IFD0',
      'ExifIFD',
      'GPS',
      'IFD1',
      'IPTC',
      'XMP',
      'JPEG comment',
    ]);
  });

  it('exports everything as metadata.json, GPS included', async () => {
    const out = await run(EIFFEL);
    const doc = JSON.parse(utf8Decode(fileNamed(out, 'metadata.json'))) as {
      file: Record<string, unknown>;
      gps: {
        latitude: number;
        longitude: number;
        googleMaps: string;
        details: Record<string, string>;
      };
      metadata: Record<string, Record<string, string>>;
      thumbnail: { verdict: string };
      dataAfterEnd: { type: string };
      findings: Record<string, string>;
    };
    expect(doc.file.md5).toBe(md5(EIFFEL));
    expect(doc.gps.latitude).toBe(48.8584);
    expect(doc.gps.longitude).toBe(2.2945);
    expect(doc.gps.googleMaps).toContain('48.858400,2.294500');
    expect(doc.gps.details.Altitude).toBe('35 m above sea level');
    expect(doc.metadata.ExifIFD!.OwnerName).toBe('Test Owner');
    expect(doc.metadata.XMP!['dc:creator']).toBe('Nobody');
    expect(doc.thumbnail.verdict).toBe('different');
    expect(doc.dataAfterEnd.type).toBe('ZIP archive');
    expect(doc.findings['Camera owner']).toBe('Test Owner (EXIF)');
    // Deterministic: same input, same JSON.
    expect(fileNamed(await run(EIFFEL), 'metadata.json')).toEqual(fileNamed(out, 'metadata.json'));
  });

  it('lists strings with where they sit, flag-like first', async () => {
    const withFlag = concatBytes(EIFFEL, utf8Encode('\0\0flag{after_the_zip}\0'));
    const out = await run(withFlag);
    const t = block(out, 'table', 'Strings')!;
    expect(t.columns).toEqual(['Offset', 'Where', 'Encoding', 'String']);
    expect(t.rows[0]).toEqual([
      `0x${(EIFFEL.length + 2).toString(16)}`,
      'after the end of the image',
      'ascii',
      'flag{after_the_zip}',
    ]);
    expect(t.highlight).toEqual([0]);
    expect(t.rows).toContainEqual(['0x29c', 'APP1 Exif', 'ascii', 'FTF Labs']);
    expect(kv(out, 'Findings').get('Flag-like strings')).toBe('flag{after_the_zip}');
    // Coincidental short strings in the compressed pixels are left out (and counted); the
    // thumbnail and the codec tables are labelled as such and listed after real metadata.
    const where = t.rows.map((r) => String(r[1]));
    expect(t.rows.filter((r) => r[1] === 'image data' && String(r[3]).length < 20)).toEqual([]);
    expect(notes(out).join('\n')).toMatch(
      /short strings inside the compressed image data are not listed/,
    );
    expect(where.indexOf('EXIF thumbnail')).toBeGreaterThan(where.lastIndexOf('COM (comment)'));
    expect(where.indexOf('DHT (Huffman tables)')).toBeGreaterThan(
      where.lastIndexOf('COM (comment)'),
    );
    expect(where.slice(where.indexOf('EXIF thumbnail')).includes('APP1 Exif')).toBe(false);
  });

  it('honours the minimum string length', async () => {
    const count = async (minLength: number) =>
      block(await run(EIFFEL, { minLength }), 'table', 'Strings')!.rows.length;
    expect(await count(20)).toBeLessThan(await count(6));
    const long = block(await run(EIFFEL, { minLength: 20 }), 'table', 'Strings')!;
    expect(long.rows.every((r) => String(r[3]).length >= 20)).toBe(true);
  });
});

describe('Image analyzer: GPS edge cases', () => {
  const base = jpegOf(picture(64, 48));
  const withGps = (gps: Entry[]) =>
    concatBytes(base.subarray(0, 2), exifApp1({ gps }), base.subarray(2));

  it('gives negative coordinates for S and W references', async () => {
    const cases: [string, string, number, number][] = [
      ['N', 'E', 33.8568, 151.2153],
      ['S', 'E', -33.8568, 151.2153],
      ['N', 'W', 33.8568, -151.2153],
      ['S', 'W', -33.8568, -151.2153],
    ];
    for (const [latRef, lonRef, lat, lon] of cases) {
      const out = await run(withGps(gpsEntries(latRef, lonRef)));
      const m = block(out, 'map')!;
      expect(Math.abs(m.lat - lat)).toBeLessThan(1e-6);
      expect(Math.abs(m.lon - lon)).toBeLessThan(1e-6);
      expect(kv(out, 'GPS details').get('Latitude')).toBe(lat.toFixed(6));
      expect(kv(out, 'GPS details').get('Raw latitude')).toBe(`33° 51′ 24.48″ ${latRef}`);
      expect(kv(out, 'GPS details').get('Raw longitude')).toBe(`151° 12′ 55.08″ ${lonRef}`);
    }
  });

  it('ignores a 0, 0 position (an empty fix) with a note instead of a map', async () => {
    const out = await run(
      withGps([
        [0x0001, 2, ascii('N')],
        [0x0002, 5, rational([0, 1], [0, 1], [0, 1])],
        [0x0003, 2, ascii('E')],
        [0x0004, 5, rational([0, 1], [0, 1], [0, 1])],
      ]),
    );
    expect(block(out, 'map')).toBeUndefined();
    expect(kv(out, 'Findings').get('GPS')).toBe('tags hold 0, 0: no real fix, ignored');
    expect(notes(out).join('\n')).toMatch(/empty fix .* no map/);
  });

  it('reads altitude below sea level', async () => {
    const out = await run(
      withGps([
        ...gpsEntries('N', 'E'),
        [0x0005, 1, new Uint8Array([1])],
        [0x0006, 5, rational([125, 10])],
      ]),
    );
    expect(kv(out, 'GPS details').get('Altitude')).toBe('12.5 m below sea level');
  });

  it('falls back to an XMP-only position', async () => {
    const xmp = utf8Encode(
      '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:exif="http://ns.adobe.com/exif/1.0/" exif:GPSLatitude="48,51.504N" exif:GPSLongitude="2,17.67E"/></rdf:RDF></x:xmpmeta>',
    );
    const payload = concatBytes(utf8Encode('http://ns.adobe.com/xap/1.0/\0'), xmp);
    const app1 = concatBytes(new Uint8Array([0xff, 0xe1]), be16(payload.length + 2), payload);
    const out = await run(concatBytes(base.subarray(0, 2), app1, base.subarray(2)));
    const m = block(out, 'map')!;
    expect(Math.abs(m.lat - 48.8584)).toBeLessThan(1e-6);
    expect(Math.abs(m.lon - 2.2945)).toBeLessThan(1e-6);
    expect(kv(out, 'GPS details').get('Source')).toBe('XMP exif:GPSLatitude / exif:GPSLongitude');
  });

  it('shows no GPS block for a picture without GPS', async () => {
    const out = await run(sample('meta-plain.png'));
    expect(block(out, 'map')).toBeUndefined();
    expect(block(out, 'kv', 'GPS details')).toBeUndefined();
  });
});

describe('Image analyzer: thumbnail check', () => {
  const main = picture(240, 160);

  it('does not flag a thumbnail made from the main image', async () => {
    const out = await run(photoWithThumbnail(main, resize(main, 120, 80)));
    const check = kv(out, 'Thumbnail check');
    expect(check.get('Verdict')).toBe('same picture');
    expect(Number.parseInt(check.get('Similarity')!, 10)).toBeGreaterThanOrEqual(95);
    expect(kv(out, 'Findings').has('Thumbnail')).toBe(false);
    expect(notes(out).join('\n')).not.toMatch(/thumbnail/i);
  });

  it('copes with letterbox bars, brightness changes and rotation', () => {
    const decoded = (img: RgbaImage) => decodeJpeg(jpegOf(img, 60));
    const bars = compareThumbnail(main, decoded(letterbox(main, 160, 120)));
    expect(bars).toMatchObject({ verdict: 'match', bars: true, rotation: 0, editedRegion: null });
    const brighter = compareThumbnail(
      main,
      decoded(map(resize(main, 120, 80), (c) => c * 0.7 + 50)),
    );
    expect(brighter).toMatchObject({ verdict: 'match', editedRegion: null });
    const rotated = compareThumbnail(main, decoded(rotateCw(resize(main, 120, 80))));
    expect(rotated.verdict).toBe('match');
    expect(rotated.rotation).toBe(270);
  });

  it('points at a retouched area when only part of the picture differs', async () => {
    // The main image had a bright patch painted over after the thumbnail was made.
    const edited = map(main, (c, x, y) => (x < 70 && y > 105 && y < 150 ? 0 : c));
    const out = await run(photoWithThumbnail(edited, resize(main, 120, 80)));
    expect(kv(out, 'Thumbnail check').get('Verdict')).toBe(
      'same picture, except the bottom-left corner',
    );
    expect(kv(out, 'Findings').get('Thumbnail')).toBe(
      'matches the main image except the bottom-left corner: edited there?',
    );
    expect(notes(out).join('\n')).toMatch(/except around the bottom-left corner/);
    // A big white patch drags the overall score down, but the other eight ninths still match.
    const painted = map(main, (c, x, y) => (x > 80 && x < 160 && y > 53 && y < 107 ? 255 : c));
    const check = compareThumbnail(painted, decodeJpeg(jpegOf(resize(main, 120, 80), 60)));
    expect(check.similarity).toBeLessThan(0.8);
    expect(check).toMatchObject({ verdict: 'match', editedRegion: 'centre' });
  });

  it('calls unrelated pictures different', () => {
    const decoded = (img: RgbaImage) => decodeJpeg(jpegOf(img, 60));
    let seed = 7;
    const noise = map(main, () => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 24) & 255);
    expect(compareThumbnail(main, decoded(resize(noise, 120, 80))).verdict).toBe('different');
    const flat = map(main, () => 128);
    expect(compareThumbnail(main, decoded(resize(flat, 120, 80))).verdict).toBe('different');
  });
});

describe('Image analyzer: comparing two files', () => {
  it('confirms identical files by their hashes', async () => {
    const out = await run(EIFFEL, { compare: { bytes: EIFFEL.slice(), name: 'copy.jpg' } });
    const c = kv(out, 'Comparison');
    expect(c.get('Compared with')).toBe(`copy.jpg (${EIFFEL.length} bytes)`);
    expect(c.get('MD5 (other file)')).toBe(md5(EIFFEL));
    expect(c.get('SHA-1 (other file)')).toBe(sha1(EIFFEL));
    expect(c.get('SHA-256 (other file)')).toBe(sha256(EIFFEL));
    expect(c.get('Verdict')).toBe('Identical files (same MD5/SHA-1/SHA-256)');
    expect(c.has('First difference')).toBe(false);
  });

  it('finds the first differing byte of a 1-byte-modified copy', async () => {
    const copy = EIFFEL.slice();
    copy[5000]! ^= 0x01;
    const out = await run(EIFFEL, { compare: { bytes: copy, name: 'edited.jpg' } });
    const c = kv(out, 'Comparison');
    expect(c.get('MD5 (other file)')).toBe(md5(copy));
    expect(c.get('MD5 (other file)')).not.toBe(md5(EIFFEL));
    expect(c.get('Verdict')).toBe('Different files');
    expect(c.get('First difference')).toBe(
      `offset 5000 (0x1388): 0x${EIFFEL[5000]!.toString(16)} in this file, 0x${copy[5000]!.toString(16)} in the other`,
    );
    expect(c.get('Size difference')).toBe('none (same size)');
    expect(c.has('Collision')).toBe(false);
  });

  it('recognises a copy with data appended', async () => {
    const longer = concatBytes(EIFFEL, utf8Encode('extra'));
    const c = kv(await run(EIFFEL, { compare: { bytes: longer } }), 'Comparison');
    expect(c.get('Verdict')).toBe('Different files');
    expect(c.get('First difference')).toBe(
      `offset ${EIFFEL.length} (0x${EIFFEL.length.toString(16)}): one file ends there`,
    );
    expect(c.get('Size difference')).toBe('+5 bytes (the other file is longer)');
    expect(c.get('Note')).toMatch(/exact start of the longer one/);
  });
});

describe('Image analyzer: other inputs', () => {
  it('reads PNG text chunks and XMP', async () => {
    const out = await run(sample('meta-plain.png'));
    const f = kv(out, 'Findings');
    expect(f.get('Description')).toBe('Synthetic PNG for the image analyzer (XMP dc:description)');
    expect(f.get('Title')).toBe('Plain PNG sample (PNG)');
    expect(f.get('User comment')).toBe('No GPS in this one. (PNG)');
    const t = block(out, 'table', 'All metadata')!;
    expect(t.rows).toContainEqual(['PNG text', 'tEXt Author', 'Nobody']);
    expect(t.rows).toContainEqual(['PNG tIME', 'Modified', '2024-05-01 12:00:00 UTC']);
    expect(t.rows).toContainEqual(['PNG IHDR', 'ColorType', 'RGB']);
    expect(block(out, 'picture', 'Main image')?.mime).toBe('image/png');
    expect(block(out, 'picture', 'EXIF thumbnail')).toBeUndefined();
  });

  it('reads the EXIF chunk of a WebP, and what is appended after it', async () => {
    const chunk = (id: string, d: Uint8Array) =>
      concatBytes(utf8Encode(id), le32(d.length), d, new Uint8Array(d.length % 2));
    // EXIF chunk = the TIFF structure alone (no "Exif\0\0" header, as libwebp writes it).
    const tiff = exifApp1({
      ifd0: [[0x010e, 2, ascii('WebP description')]],
      gps: gpsEntries('S', 'W'),
    }).subarray(10);
    const body = concatBytes(
      utf8Encode('WEBP'),
      chunk('VP8X', new Uint8Array([0x08, 0, 0, 0, 99, 0, 0, 49, 0, 0])),
      chunk('VP8L', new Uint8Array([0x2f, 0, 0, 0, 0])),
      chunk('EXIF', tiff),
    );
    const webp = concatBytes(utf8Encode('RIFF'), le32(body.length), body);
    const out = await run(concatBytes(webp, utf8Encode('appended text')));
    const m = block(out, 'map')!;
    expect(Math.abs(m.lat + 33.8568)).toBeLessThan(1e-6);
    expect(Math.abs(m.lon + 151.2153)).toBeLessThan(1e-6);
    const f = kv(out, 'Findings');
    expect(f.get('Description')).toBe('WebP description (EXIF)');
    expect(f.get('Data after the end')).toBe(
      `13 bytes at offset ${webp.length} (0x${webp.length.toString(16)}): plain text`,
    );
    expect(block(out, 'picture', 'Main image')?.mime).toBe('image/webp');
    expect(block(out, 'table', 'All metadata')!.rows).toContainEqual([
      'File',
      'Dimensions',
      '100x50',
    ]);
    const row = block(out, 'table', 'Strings')!.rows.find((r) => r[3] === 'WebP description');
    expect(row?.slice(1)).toEqual(['EXIF chunk', 'ascii', 'WebP description']);
  });

  it('says so when nothing stands out', async () => {
    const f = kv(await run(jpegOf(picture(32, 32))), 'Findings');
    expect([...f]).toEqual([
      [
        'Nothing unusual found',
        'no GPS, no free-text metadata, no appended data, no flag-like strings',
      ],
    ]);
  });

  it('survives truncated and corrupt EXIF', async () => {
    const end = parseJpeg(EIFFEL)!.end!;
    expect(kv(await run(EIFFEL.slice(0, 4)), 'Hashes').get('MD5')).toBe(md5(EIFFEL.slice(0, 4)));
    for (const cut of [12, 30, 200, 600, 1100, 5000, 9000, end - 1]) {
      const out = await run(EIFFEL.slice(0, cut));
      expect(kv(out, 'Hashes').get('MD5')).toBe(md5(EIFFEL.slice(0, cut)));
      expect(kv(out, 'Findings').get('Structure')).toMatch(/truncated or damaged/);
    }
    // Scramble the TIFF header and IFD0 of the EXIF block.
    const scrambled = EIFFEL.slice();
    for (let i = 30; i < 400; i++) scrambled[i] = (i * 37) & 255;
    const out = await run(scrambled);
    expect(kv(out, 'Hashes').get('MD5')).toBe(md5(scrambled));
    expect(block(out, 'table', 'All metadata')).toBeDefined();
    // An APP1 whose length runs past the end of the file.
    const bogus = concatBytes(
      new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xf0]),
      utf8Encode('Exif\0\0II*\0'),
    );
    expect(kv(await run(bogus), 'Hashes').get('MD5')).toBe(md5(bogus));
  });

  it('still hashes and scans a file that is not an image', async () => {
    const data = concatBytes(
      new Uint8Array([0, 1, 2, 3]),
      utf8Encode('just a secret: flag{not_an_image}'),
      new Uint8Array([0xfe]),
    );
    const out = await run(data);
    expect(kv(out, 'Findings').get('File type')).toMatch(/not an image/);
    expect(kv(out, 'Findings').get('Flag-like strings')).toBe('flag{not_an_image}');
    expect(kv(out, 'Hashes').get('SHA-256')).toBe(sha256(data));
    expect(block(out, 'table', 'Strings')!.rows[0]![3]).toBe('just a secret: flag{not_an_image}');
    expect(out.some((o) => o.type === 'picture' || o.type === 'map')).toBe(false);
  });

  it('rejects empty input', async () => {
    await expect(run(new Uint8Array())).rejects.toThrow(/Drop an image/);
  });

  it('suggests itself for image files only', () => {
    const d = (b: Uint8Array) => tool.detect!({ text: null, bytes: b });
    expect(d(EIFFEL)).toEqual({ score: 0.7, reason: 'Image: metadata, GPS, thumbnail, hashes' });
    expect(d(sample('meta-plain.png'))?.score).toBe(0.7);
    expect(d(new Uint8Array([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0]))?.score).toBe(0.7);
    expect(d(utf8Encode('RIFF\x10\0\0\0WEBPVP8 '))?.score).toBe(0.7);
    expect(d(concatBytes(new Uint8Array([0, 0, 0, 24]), utf8Encode('ftypheic')))?.score).toBe(0.7);
    expect(d(utf8Encode('hello world'))).toBeNull();
  });
});
