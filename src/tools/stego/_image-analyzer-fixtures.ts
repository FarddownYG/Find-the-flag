/**
 * Builders for synthetic test images (tests only: nothing here is imported by a tool). Every
 * file the image-analyzer tests use is made from these: no real photo, no real position, no
 * real challenge.
 */
import { encode as encodePng } from 'fast-png';
import { zlibSync } from 'fflate';
import { encode as encodeJpegJs } from 'jpeg-js';
import type { RgbaImage } from '../../core/types';
import { concatBytes, latin1Encode, utf8Encode } from '../../lib/bytes';
import { crc32 } from '../../lib/signatures';

// ---------------------------------------------------------------- bytes

export const u8 = (...b: number[]) => new Uint8Array(b);
export const be16 = (n: number) => u8((n >>> 8) & 255, n & 255);
export const be32 = (n: number) => u8((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
export const le32 = (n: number) => u8(n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255);
const w16 = (n: number, le: boolean) => (le ? u8(n & 255, (n >>> 8) & 255) : be16(n));
const w32 = (n: number, le: boolean) => (le ? le32(n) : be32(n));

export function utf16(s: string, le: boolean): Uint8Array {
  const out = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out[i * 2] = le ? c & 255 : c >> 8;
    out[i * 2 + 1] = le ? c >> 8 : c & 255;
  }
  return out;
}

// ---------------------------------------------------------------- TIFF / EXIF

/** A tag value; the byte order is only known when the block is written. */
export type TagValue = (le: boolean) => { type: number; bytes: Uint8Array; count: number };
export type Entry = [tag: number, value: TagValue];

/** ASCII, NUL-terminated (raw bytes are written as given: add the NUL yourself). */
export const ascii =
  (s: string | Uint8Array): TagValue =>
  () => {
    const bytes = typeof s === 'string' ? concatBytes(utf8Encode(s), u8(0)) : s;
    return { type: 2, bytes, count: bytes.length };
  };
export const bytes =
  (b: Uint8Array | number[], type: 1 | 7 = 1): TagValue =>
  () => {
    const v = b instanceof Uint8Array ? b : Uint8Array.from(b);
    return { type, bytes: v, count: v.length };
  };
export const undef = (b: Uint8Array | number[]) => bytes(b, 7);
export const short =
  (...n: number[]): TagValue =>
  (le) => ({ type: 3, bytes: concatBytes(...n.map((x) => w16(x, le))), count: n.length });
export const long =
  (...n: number[]): TagValue =>
  (le) => ({ type: 4, bytes: concatBytes(...n.map((x) => w32(x, le))), count: n.length });
export const rational =
  (...pairs: [number, number][]): TagValue =>
  (le) => ({
    type: 5,
    bytes: concatBytes(...pairs.flatMap(([a, b]) => [w32(a, le), w32(b, le)])),
    count: pairs.length,
  });
/** UserComment-style value: 8-byte charset id + body. */
export const comment = (charset: 'ASCII' | 'UNICODE', body: Uint8Array) =>
  undef(concatBytes(latin1Encode(charset.padEnd(8, '\0')), body));

export interface TiffSpec {
  le?: boolean;
  ifd0?: Entry[];
  exif?: Entry[];
  gps?: Entry[];
  interop?: Entry[];
  /** An IFD1 with a JPEG thumbnail (Compression 6 + offset + length). */
  thumbnail?: Uint8Array;
}

/** A TIFF block: header, IFD0 -> IFD1, Exif/GPS/Interop sub-IFDs, values, then the thumbnail. */
export function tiff(spec: TiffSpec): Uint8Array {
  const le = spec.le ?? true;
  type Ptr = { ptr: 'exif' | 'gps' | 'interop' | 'thumb' };
  type Item = [number, TagValue | Ptr];
  const ifds: { name: string; entries: Item[] }[] = [];
  const ifd0: Item[] = [...(spec.ifd0 ?? [])];
  if (spec.exif || spec.interop) ifd0.push([0x8769, { ptr: 'exif' }]);
  if (spec.gps) ifd0.push([0x8825, { ptr: 'gps' }]);
  ifds.push({ name: 'ifd0', entries: ifd0 });
  if (spec.exif || spec.interop) {
    const exif: Item[] = [...(spec.exif ?? [])];
    if (spec.interop) exif.push([0xa005, { ptr: 'interop' }]);
    ifds.push({ name: 'exif', entries: exif });
  }
  if (spec.gps) ifds.push({ name: 'gps', entries: [...spec.gps] });
  if (spec.interop) ifds.push({ name: 'interop', entries: [...spec.interop] });
  if (spec.thumbnail) {
    ifds.push({
      name: 'ifd1',
      entries: [
        [0x0103, short(6)],
        [0x0201, { ptr: 'thumb' }],
        [0x0202, long(spec.thumbnail.length)],
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
  const written = new Map<Item, { type: number; bytes: Uint8Array; count: number; at: number }>();
  for (const i of ifds) {
    for (const e of i.entries) {
      if (typeof e[1] !== 'function') continue;
      const v = e[1](le);
      const out = { ...v, at: -1 };
      if (v.bytes.length > 4) {
        out.at = pos;
        area.push(v.bytes.length % 2 ? concatBytes(v.bytes, u8(0)) : v.bytes);
        pos += v.bytes.length + (v.bytes.length % 2);
      }
      written.set(e, out);
    }
  }
  offsets.thumb = pos;
  const body = ifds.map((i) =>
    concatBytes(
      w16(i.entries.length, le),
      ...i.entries.map((e) => {
        const [tag, v] = e;
        if (typeof v !== 'function') {
          return concatBytes(w16(tag, le), w16(4, le), w32(1, le), w32(offsets[v.ptr]!, le));
        }
        const x = written.get(e)!;
        const field =
          x.at >= 0 ? w32(x.at, le) : concatBytes(x.bytes, new Uint8Array(4 - x.bytes.length));
        return concatBytes(w16(tag, le), w16(x.type, le), w32(x.count, le), field);
      }),
      w32(i.name === 'ifd0' && offsets.ifd1 ? offsets.ifd1 : 0, le),
    ),
  );
  return concatBytes(
    latin1Encode(le ? 'II' : 'MM'),
    w16(42, le),
    w32(8, le),
    ...body,
    ...area,
    spec.thumbnail ?? new Uint8Array(),
  );
}

export const gpsDms = (
  latRef: string,
  lat: [number, number][],
  lonRef: string,
  lon: [number, number][],
): Entry[] => [
  [0x0001, ascii(latRef)],
  [0x0002, rational(...lat)],
  [0x0003, ascii(lonRef)],
  [0x0004, rational(...lon)],
];

// ---------------------------------------------------------------- JPEG

export const segment = (marker: number, payload: Uint8Array) =>
  concatBytes(u8(0xff, marker), be16(payload.length + 2), payload);
export const app1Exif = (t: Uint8Array) => segment(0xe1, concatBytes(latin1Encode('Exif\0\0'), t));
export const xmpPacket = (inner: string, ns = '') =>
  `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:exif="http://ns.adobe.com/exif/1.0/" xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/" ${ns}>${inner}</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
export const app1Xmp = (packet: string) =>
  segment(0xe1, concatBytes(latin1Encode('http://ns.adobe.com/xap/1.0/\0'), utf8Encode(packet)));
export const com = (text: string | Uint8Array) =>
  segment(0xfe, typeof text === 'string' ? utf8Encode(text) : text);

/** APP13 Photoshop 3.0 with an IPTC (8BIM 0x0404) resource. Values: UTF-8 strings or raw bytes. */
export function app13Iptc(records: [record: number, id: number, value: string | Uint8Array][]) {
  const iim = concatBytes(
    ...records.map(([r, id, v]) => {
      const data = typeof v === 'string' ? utf8Encode(v) : v;
      return concatBytes(u8(0x1c, r, id), be16(data.length), data);
    }),
  );
  const padded = iim.length % 2 ? concatBytes(iim, u8(0)) : iim;
  return segment(
    0xed,
    concatBytes(
      latin1Encode('Photoshop 3.0\0'),
      latin1Encode('8BIM'),
      be16(0x0404),
      u8(0, 0),
      be32(iim.length),
      padded,
    ),
  );
}

/** A v2 ICC profile with a 'desc' (textDescriptionType) and a 'cprt' (text) tag; date all zeros. */
export function iccProfile(description: string, copyright: string): Uint8Array {
  const desc = concatBytes(
    latin1Encode('desc\0\0\0\0'),
    be32(description.length + 1),
    latin1Encode(description),
    u8(0),
    new Uint8Array(4 + 4 + 2 + 1 + 67),
  );
  const cprt = concatBytes(latin1Encode('text\0\0\0\0'), latin1Encode(copyright), u8(0));
  const pad4 = (b: Uint8Array) => concatBytes(b, new Uint8Array((4 - (b.length % 4)) % 4));
  const tags = [
    ['desc', pad4(desc)],
    ['cprt', pad4(cprt)],
  ] as const;
  let pos = 128 + 4 + 12 * tags.length;
  const table: Uint8Array[] = [be32(tags.length)];
  const data: Uint8Array[] = [];
  for (const [sig, d] of tags) {
    table.push(latin1Encode(sig), be32(pos), be32(d.length));
    data.push(d);
    pos += d.length;
  }
  const header = new Uint8Array(128);
  header.set(be32(pos), 0);
  header.set(latin1Encode('none'), 4);
  header.set(u8(2, 0x10, 0, 0), 8);
  header.set(latin1Encode('mntrRGB XYZ '), 12);
  // 24..35: date and time, all zeros.
  header.set(latin1Encode('acsp'), 36);
  return concatBytes(header, ...table, ...data);
}
export const app2Icc = (profile: Uint8Array) =>
  segment(0xe2, concatBytes(latin1Encode('ICC_PROFILE\0'), u8(1, 1), profile));

/** A procedural "photo": gradient sky, a sun, a dark block, grass. */
export function picture(w: number, h: number): RgbaImage {
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

/** An image from a colour function. */
export function draw(w: number, h: number, f: (x: number, y: number) => number[]): RgbaImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r = 0, g = r, b = r] = f(x, y);
      data.set([r, g, b, 255], (y * w + x) * 4);
    }
  }
  return { width: w, height: h, data };
}

export const jpegOf = (img: RgbaImage, quality = 85) =>
  new Uint8Array(
    encodeJpegJs({ width: img.width, height: img.height, data: img.data }, quality).data,
  );

/** A JPEG with `segments` inserted right after SOI (before jpeg-js's own APP0). */
export const jpegWith = (jpeg: Uint8Array, ...segments: Uint8Array[]) =>
  concatBytes(jpeg.subarray(0, 2), ...segments, jpeg.subarray(2));

// ---------------------------------------------------------------- PNG

export const pngChunk = (type: string, data: Uint8Array) => {
  const t = latin1Encode(type);
  return concatBytes(be32(data.length), t, data, be32(crc32(concatBytes(t, data))));
};

export function pngOf(img: RgbaImage): Uint8Array {
  return encodePng({
    width: img.width,
    height: img.height,
    data: new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength),
    channels: 4,
    depth: 8,
  });
}

/** A PNG with `chunks` inserted right after IHDR. */
export const pngWith = (png: Uint8Array, ...chunks: Uint8Array[]) =>
  concatBytes(png.subarray(0, 33), ...chunks, png.subarray(33));

export const tEXt = (key: string, text: Uint8Array | string) =>
  pngChunk(
    'tEXt',
    concatBytes(latin1Encode(key), u8(0), typeof text === 'string' ? latin1Encode(text) : text),
  );
export const zTXt = (key: string, text: string) =>
  pngChunk('zTXt', concatBytes(latin1Encode(key), u8(0, 0), zlibSync(latin1Encode(text))));
export const iTXt = (
  key: string,
  text: string,
  opts: { lang?: string; translated?: string; compress?: boolean } = {},
) => {
  const body = utf8Encode(text);
  return pngChunk(
    'iTXt',
    concatBytes(
      utf8Encode(key),
      u8(0, opts.compress ? 1 : 0, 0),
      latin1Encode(opts.lang ?? ''),
      u8(0),
      utf8Encode(opts.translated ?? ''),
      u8(0),
      opts.compress ? zlibSync(body) : body,
    ),
  );
};

// ---------------------------------------------------------------- WebP

const riffChunk = (id: string, d: Uint8Array) =>
  concatBytes(latin1Encode(id), le32(d.length), d, new Uint8Array(d.length % 2));

/** A 1x1 lossless WebP (VP8X + VP8L) carrying `exif` in an EXIF chunk. */
export function webpWithExif(exif: Uint8Array): Uint8Array {
  const body = concatBytes(
    latin1Encode('WEBP'),
    riffChunk('VP8X', u8(0x08, 0, 0, 0, 0, 0, 0, 0, 0, 0)),
    riffChunk('VP8L', u8(0x2f, 0, 0, 0, 0x10, 0x07, 0x10, 0x11, 0x11, 0x88, 0x88, 0xfe, 0x07)),
    riffChunk('EXIF', exif),
  );
  return concatBytes(latin1Encode('RIFF'), le32(body.length), body);
}

// ---------------------------------------------------------------- JPEGs only libjpeg makes

/**
 * Small JPEGs jpeg-js cannot write (progressive, chroma subsampling, restart markers, grayscale,
 * Adobe CMYK), made with Pillow from a formula, nothing else:
 *
 *   im = Image.new('RGB', (72, 40)); px = im.load()
 *   for y in range(40):
 *     for x in range(72):
 *       px[x, y] = (int(128 + 100 * math.sin(x / 7)), int(y * 255 / 40), int(255 - x * 255 / 72))
 *   im.save('progressive420.jpg', quality=80, progressive=True, subsampling=2)
 *   im.save('restart420.jpg', quality=80, subsampling=2, restart_marker_blocks=3)
 *   im.convert('L').save('grayProgressive.jpg', quality=80, progressive=True)
 *   im.save('baseline422.jpg', quality=80, subsampling=1)
 *   im.convert('CMYK').save('cmyk.jpg', quality=90)
 */
export const PILLOW_SCENE = (x: number, y: number) => [
  Math.trunc(128 + 100 * Math.sin(x / 7)),
  Math.trunc((y * 255) / 40),
  Math.trunc(255 - (x * 255) / 72),
];
export const PILLOW_JPEGS: Record<string, string> = {
  progressive420:
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wgARCAAoAEgDASIAAhEBAxEB/8QAGQAAAgMBAAAAAAAAAAAAAAAAAAUDBAYC/8QAGQEAAgMBAAAAAAAAAAAAAAAABQYCAwQB/9oADAMBAAIQAxAAAAFPPdnZWLOqdUpziUt6W/ipi4b8AmfLDMivbOe7OwxzqnVKc4lJflv4aYuG/ANmyo0Ir+znBj7RUhQJgvhhpv8AAA2dSBFe/8QAGBABAQEBAQAAAAAAAAAAAAAAAgADARL/2gAIAQEAAQUCAvFqJi4LMXBMWogLxaiYuCzFwTFqIC8WomLgsxcExaiAvFqJi4LMXBMWogLxaiYuCzFwTFqL/8QAHBEAAgIDAQEAAAAAAAAAAAAAAAMEIgECEhMR/9oACAEDAQE/AY76E95BfY96D33I76E95BfY96D33I++eCfvn6Qd89HeeB++ez//xAAcEQACAgMBAQAAAAAAAAAAAAAAAwECBBEhExL/2gAIAQIBAT8Be3pDTJaMb09R7ekNMloxvT1H2nZFpMm0jLTs+pP/xAAUEAEAAAAAAAAAAAAAAAAAAABQ/9oACAEBAAY/Ajf/xAAXEAEBAQEAAAAAAAAAAAAAAAAhEAAB/9oACAEBAAE/Id9MWywPDX6YtlieGv0xbLE8Nbpi+WJ4a3TB8sTww//aAAwDAQACAAMAAAAQVrIqPUgqr8fBig9//8QAGREAAwEBAQAAAAAAAAAAAAAAAAEhUREQ/9oACAEDAQE/ENhZ0go9Symws6QUepRfI6BwBh7B/8QAGBEBAQEBAQAAAAAAAAAAAAAAARAhABH/2gAIAQIBAT8QicWYtOLEWA8DIOP/xAAYEAEBAQEBAAAAAAAAAAAAAAAhAAFRMf/aAAgBAQABPxAsLlg0nFyXmXJMJNIsLlg0nFyXkXJMJNIsLlg0nFyXkXJMJNI8Llg0mFyXkXJMJNI8Llh0mFyXkXJMJdL/2Q==',
  restart420:
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAoAEgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/90ABAAD/9oADAMBAAIRAxEAPwDj7Cx4HFX3sfk6Vs2FjwOKvvY/J0r9Kx2L94/Rcux37nc871Sx4PFclf2XzHivVdUseDxXJX9l8x4rgjiz5PP8dq9Ti4rH5ulbmnWXTircVj83St3TrHpxXiZli9GcWR4794tT/9DhILH5elQXtj8p4rr4LH5elQXtj8p4rxsTi/eP1p479xueW6pY8niiun1Sx5PFFZrFn59j8d++ep7LYWPA4q+9j8nStmwsuBxV97H5OlfoOOxfvGWXY79zuf/R09UseDxXJX9l8x4r1TVLHg8Vyd/Y/MeK9SOLPHz/AB2r1OKisfm6Vu6dY9OKtxWPzdK3dOsenFeJmWL0Zx5Hjv3i1K0Fj8vSoL2x+U8V18Fj8vSoL2x+U8V8PiMX7x+mvHfuNz//0sLVLHk8UV1GqWPJ4or87WLPHx2O/fPU9lsLLgcVfex+TpRRX6PjqkuYvLq0vYmFqllweK5O/sfmPFFFcEakj5PPq0uZn//T6mKx+bpW7p1j04oor5jMqkrM/McjrS9ojfgsfl6VBe2PyniiivhsTUlzH6c60vYHKapZcniiiis1Ukfn2PrS9sz/2Q==',
  grayProgressive:
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/wgALCAAoAEgBAREA/8QAGAAAAwEBAAAAAAAAAAAAAAAAAwQFAgb/2gAIAQEAAAABjnRkhefxK7I6MkD7+JPZnRkgffxJ7M6MkD7+JPZnRkgffxJ//8QAGBABAQEBAQAAAAAAAAAAAAAAAgADARL/2gAIAQEAAQUCAvFqJi4LMXBMWogLxaiYuCzFwTFqIC8WomLgsxcExaiAvFqJi4LMXBMWogLxaiYuCzFwTFqL/8QAFBABAAAAAAAAAAAAAAAAAAAAUP/aAAgBAQAGPwI3/8QAFxABAQEBAAAAAAAAAAAAAAAAIRAAAf/aAAgBAQABPyHfTFssDw1+mLZYnhr9MWyxPDW6YvlieGt0wfLE8MP/2gAIAQEAAAAQYjVaqVSv/8QAGBABAQEBAQAAAAAAAAAAAAAAIQABUTH/2gAIAQEAAT8QLC5YNJxcl5lyTCTSLC5YNJxcl5FyTCTSLC5YNJxcl5FyTCTSPC5YNJhcl5FyTCTSPC5YdJhcl5FyTCXS/9k=',
  baseline422:
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAoAEgDASEAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDj7Cx4HFX3sfk6V+qY6t7x+o5dX/cmHqljweK5K/svmPFefGqfJ59X1ZTisfm6VuadZdOK8XMqujOPI6/7xG/BY/L0qC9sflPFfDYmt7x+muv+4OV1Sx5PFFZqqfn2Pr/vmeyWFjwOKvvY/J0r9Ux1b3j1Mur/ALkw9UseDxXJX9l8x4rz41T5LPq+rKUVj83St3TrHpxXiZlV0Zx5HX/eI34LH5elQXtj8p4r4fEVveP051/3BymqWPJ4orJVT89x9f8AfM9lsLHgcVfex+TpX6pjq3vHqZdX/cmHqljweK5K/svmPFcEauh8nn9fVlKKx+bpW7p1j04rxMyq6M48jr/vEb8Fj8vSoL2x+U8V8NiKvvH6c6/7g5TVLHk8UVmqp+e46v8Avmey2FlwOKvvY/J0r9Ux1b3j1Mur/uTC1Sx4PFcnf2PzHivPjV0Pk8+r6spRWPzdK3dOsenFeLmVXRnFkdf94jfgsfl6VBe2PynivhsTV94/TnX/AHBymqWPJ4orNVT8+x9f98z2WwsuBxV97H5OlfqmOq+8enl1f9yYWqWXB4rk7+x+Y8V58auh8nn1fVlKKx+bpW7p1j04rxcyq6M48jr/ALxG/BY/L0qC9sflPFfDYmr7x+nOv+4OU1Sy5PFFZKqfnuPr/vmf/9k=',
  cmyk: '/9j/7gAOQWRvYmUAZAAAAAAA/9sAQwADAgIDAgIDAwMDBAMDBAUIBQUEBAUKBwcGCAwKDAwLCgsLDQ4SEA0OEQ4LCxAWEBETFBUVFQwPFxgWFBgSFBUU/8AAFAgAKABIBEMRAE0RAFkRAEsRAP/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/aAA4EQwBNAFkASwAAPwD3j4If8e8H0FfnJ/wgv/TP9K/TDxB1ev1Tr6CuP+Qd+FH/AAgv/TP9K808Q/xUV8ufHb/UXH40f8IL/wBM/wBK8z8QfxUV+enxZ/4/ZfrR/wAIL/0z/SvNPEHV6K4Xwn/yEE+tH/CC/wDTP9K8z8Q/xUV9ufAHrb/hR/wgv/TP9K808QfxUV93+A/+Qen0o/4QX/pn+leZ+IOr0VlfEv8A48ZfpR/wgv8A0z/SvM/EP8VFfn/8e/8AWXH40f8ACC/9M/0rzTxB/FRX1h8EP+PeD6Cvoj/hBf8Apn+lf0ueIOr0V9BXH/IO/Cj/AIQX/pn+leaeIf4qK+XPjt/qLj8aP+EF/wCmf6V5n4g/ior89Piz/wAfsv1o/wCEF/6Z/pXmniDq9FcL4T/5CCfWj/hBf+mf6V5n4h/ior7c+APW3/Cj/hBf+mf6V5p4g/ior7v8B/8AIPT6Uf8ACC/9M/0rzPxB1eisr4l/8eMv0o/4QX/pn+leZ+If4qK/P/49/wCsuPxo/wCEF/6Z/pXmniD+KivrD4If8e8H0FfRH/CC/wDTP9K/pc8QdXor6CuP+Qd+FH/CC/8ATP8ASvNPEP8AFRXy58dv9RcfjR/wgv8A0z/SvM/EH8VFfnp8Wf8Aj9l+tH/CC/8ATP8ASvNPEHV6K4Xwn/yEE+tH/CC/9M/0rzPxD/FRX258Aetv+FH/AAgv/TP9K808QfxUV93+A/8AkHp9KP8AhBf+mf6V5n4g6vRWV8S/+PGX6Uf8IL/0z/SvM/EP8VFfn/8AHv8A1lx+NH/CC/8ATP8ASvNPEH8VFfWHwQ/494PoK+iP+EF/6Z/pX9LniDq9FfQVx/yDvwo/4QX/AKZ/pXmniH+Kivlz47f6i4/Gj/hBf+mf6V5n4g/ior89Piz/AMfsv1o/4QX/AKZ/pXmniDq9FcL4T/5CCfWj/hBf+mf6V5n4h/ior7c+APW3/Cj/AIQX/pn+leaeIP4qK+7/AAH/AMg9PpR/wgv/AEz/AErzPxB1eisr4l/8eMv0o/4QX/pn+leZ+If4qK/P/wCPf+suPxo/4QX/AKZ/pXmniD+KivrD4If8e8H0FfRH/CC/9M/0r+lzxB1eivoK4/5B34Uf8IL/ANM/0rzTxD/FRXy58dv9RcfjR/wgv/TP9K8z8QfxUV+enxZ/4/ZfrR/wgv8A0z/SvNPEHV6K4Xwn/wAhBPrR/wAIL/0z/SvM/EP8VFfbnwB62/4Uf8IL/wBM/wBK808QfxUV93+A/wDkHp9KP+EF/wCmf6V5n4g6vRWV8S/+PGX6Uf8ACC/9M/0rzPxD/FRX5/8Ax7/1lx+NH/CC/wDTP9K808QfxUV//9k=',
};
