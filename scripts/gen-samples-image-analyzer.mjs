// Synthetic samples for the "Image analyzer" tool. Deterministic: run it again and the bytes
// are identical. Nothing here is a real photo, a real person or a real CTF challenge.
//
//   node scripts/gen-samples-image-analyzer.mjs
//
// Files:
//   meta-eiffel.jpg  320x200 drawing of a tower with EXIF (description, owner name, GPS of the
//                    Eiffel Tower 48.8584 N 2.2945 E, altitude 35 m), an IFD1 thumbnail that is a
//                    DIFFERENT picture (the word ORIGINAL), XMP, IPTC, a JPEG comment, and a small
//                    ZIP (note.txt) appended after the end-of-image marker.
//   meta-plain.png   160x100 PNG with tEXt chunks and an iTXt XMP packet, no GPS.
//
// Uses jpeg-js (JPEG encoding), fast-png (PNG encoding) and fflate (ZIP); the EXIF/TIFF,
// XMP and IPTC writers are below.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';
import { encode as encodePng } from 'fast-png';
import { zipSync } from 'fflate';

const outDir = fileURLToPath(new URL('../public/samples/', import.meta.url));
mkdirSync(outDir, { recursive: true });
const write = (name, bytes) => {
  writeFileSync(join(outDir, name), bytes);
  console.log(`${name}: ${bytes.length} bytes`);
};

// ---------- byte helpers ----------

const enc = new TextEncoder();
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const be16 = (n) => new Uint8Array([(n >>> 8) & 255, n & 255]);
const be32 = (n) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes) => {
  let c = 0xffffffff;
  for (const x of bytes) c = (CRC_TABLE[(c ^ x) & 0xff] ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
};

// ---------- drawing ----------

function canvas(w, h) {
  const data = new Uint8Array(w * h * 4);
  const set = (x, y, [r, g, b]) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = (y * w + x) * 4;
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = 255;
  };
  return { w, h, data, set };
}

// 5x7 glyphs, '#' = lit.
const FONT = {
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  I: ['.###.', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.###.'],
  N: ['#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#', '#...#'],
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
};

function drawText(c, text, x0, y0, scale, color) {
  let x = x0;
  for (const ch of text) {
    const glyph = FONT[ch];
    for (let gy = 0; gy < 7; gy++) {
      for (let gx = 0; gx < 5; gx++) {
        if (glyph[gy][gx] !== '#') continue;
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++)
            c.set(x + gx * scale + dx, y0 + gy * scale + dy, color);
        }
      }
    }
    x += 6 * scale;
  }
}

/** The displayed picture: sky, grass, sun and a lattice tower silhouette. */
function drawTower() {
  const c = canvas(320, 200);
  for (let y = 0; y < 200; y++) {
    for (let x = 0; x < 320; x++) {
      if (y < 160) c.set(x, y, [70 + y / 2, 130 + y / 3, 225 - y / 6].map(Math.round));
      else c.set(x, y, [60, 140 - (y - 160), 60]);
    }
  }
  // sun
  for (let y = 0; y < 200; y++) {
    for (let x = 0; x < 320; x++) {
      if ((x - 265) ** 2 + (y - 40) ** 2 < 18 ** 2) c.set(x, y, [250, 220, 90]);
    }
  }
  // tower: legs that curve in towards a thin spire, two platforms, an arch between the legs
  const cx = 150;
  const top = 18;
  const base = 168;
  for (let y = top; y < base; y++) {
    const t = (y - top) / (base - top); // 0 at the tip, 1 at the ground
    const half = Math.round(2 + 58 * t ** 2.2);
    for (let x = cx - half; x <= cx + half; x++) {
      const inner = half - Math.max(3, Math.round(half * 0.28));
      const archY = base - 26;
      const inArch =
        y > archY - 4 &&
        Math.abs(x - cx) < inner &&
        (x - cx) ** 2 / inner ** 2 + ((y - base) / 30) ** 2 < 1;
      const lattice =
        half > 8 && Math.abs(x - cx) < inner && (x + y) % 6 !== 0 && (x - y + 600) % 6 !== 0;
      if (inArch || lattice) continue;
      c.set(x, y, [55, 45, 40]);
    }
    if (y === 70 || y === 71 || y === 118 || y === 119 || y === 120) {
      const w = Math.round(2 + 58 * t ** 2.2) + 6;
      for (let x = cx - w; x <= cx + w; x++) c.set(x, y, [40, 32, 28]);
    }
  }
  return c;
}

/** The thumbnail: a different picture, as if the photo had been edited after it was taken. */
function drawOriginal() {
  const c = canvas(160, 100);
  for (let y = 0; y < 100; y++) {
    for (let x = 0; x < 160; x++) c.set(x, y, [120 + (x >> 2), 25, 35]);
  }
  for (let y = 0; y < 100; y++) {
    for (let x = 0; x < 160; x++) {
      if ((x - 80) ** 2 + (y - 72) ** 2 < 16 ** 2) c.set(x, y, [245, 200, 60]);
    }
  }
  drawText(c, 'ORIGINAL', 8, 14, 3, [255, 255, 255]);
  return c;
}

/** Baseline JPEG: SOI, APP0 (JFIF), then the image. */
const encodeJpeg = (c, quality) =>
  new Uint8Array(jpeg.encode({ width: c.w, height: c.h, data: c.data }, quality).data);

function splitAfterApp0(b) {
  if (b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff || b[3] !== 0xe0) throw new Error('JFIF?');
  const end = 4 + ((b[4] << 8) | b[5]);
  return [b.subarray(0, end), b.subarray(end)];
}

const segment = (marker, payload) => {
  if (payload.length + 2 > 0xffff) throw new Error('segment too large');
  return concat(new Uint8Array([0xff, marker]), be16(payload.length + 2), payload);
};

// ---------- EXIF (big-endian TIFF) ----------

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
const BYTE = 1;
const ASCII = 2;
const SHORT = 3;
const LONG = 4;
const RATIONAL = 5;
const UNDEFINED = 7;
const ascii = (s) => concat(enc.encode(s), new Uint8Array([0]));
const shorts = (...v) => concat(...v.map(be16));
const longs = (...v) => concat(...v.map(be32));
const rationals = (...pairs) => concat(...pairs.flatMap(([n, d]) => [be32(n), be32(d)]));

/**
 * TIFF structure: header, IFD0 -> IFD1 chain, Exif and GPS sub-IFDs, then the out-of-line
 * values, then the thumbnail. Entries are [tag, type, bytes] or [tag, LONG, { ptr }].
 */
function buildTiff(ifds, thumbnail) {
  const order = ['ifd0', 'exif', 'gps', 'ifd1'];
  for (const name of order) ifds[name].sort((a, b) => a[0] - b[0]);
  const offsets = {};
  let pos = 8;
  for (const name of order) {
    offsets[name] = pos;
    pos += 2 + 12 * ifds[name].length + 4;
  }
  const area = [];
  const placed = new Map();
  for (const name of order) {
    for (const entry of ifds[name]) {
      const value = entry[2];
      if (value instanceof Uint8Array && value.length > 4) {
        placed.set(entry, pos);
        area.push(value);
        pos += value.length;
        if (value.length % 2) {
          area.push(new Uint8Array(1));
          pos++;
        }
      }
    }
  }
  const thumbAt = pos;
  const body = [];
  for (const name of order) {
    const parts = [be16(ifds[name].length)];
    for (const entry of ifds[name]) {
      const [tag, type, value] = entry;
      let count;
      let field;
      if (value instanceof Uint8Array) {
        count = value.length / TYPE_SIZE[type];
        field = placed.has(entry)
          ? be32(placed.get(entry))
          : concat(value, new Uint8Array(4 - value.length));
      } else {
        count = 1;
        field = be32(value.ptr === 'thumbnail' ? thumbAt : offsets[value.ptr]);
      }
      parts.push(be16(tag), be16(type), be32(count), field);
    }
    parts.push(be32(name === 'ifd0' ? offsets.ifd1 : 0));
    body.push(concat(...parts));
  }
  return concat(enc.encode('MM'), be16(42), be32(8), ...body, ...area, thumbnail);
}

function exifApp1(thumbnail) {
  const ifds = {
    ifd0: [
      [0x010e, ASCII, ascii('Synthetic test picture — Find The Flag')],
      [0x010f, ASCII, ascii('FTF Labs')],
      [0x0110, ASCII, ascii('Synthetic Cam 1')],
      [0x0112, SHORT, shorts(1)],
      [0x011a, RATIONAL, rationals([72, 1])],
      [0x011b, RATIONAL, rationals([72, 1])],
      [0x0128, SHORT, shorts(2)],
      [0x0131, ASCII, ascii('gen-samples-image-analyzer.mjs')],
      [0x0132, ASCII, ascii('2024:05:01 12:00:00')],
      [0x013b, ASCII, ascii('Nobody')],
      [0x8298, ASCII, ascii('Public domain (synthetic sample)')],
      [0x8769, LONG, { ptr: 'exif' }],
      [0x8825, LONG, { ptr: 'gps' }],
    ],
    exif: [
      [0x829a, RATIONAL, rationals([1, 125])],
      [0x829d, RATIONAL, rationals([40, 10])],
      [0x8827, SHORT, shorts(100)],
      [0x9000, UNDEFINED, enc.encode('0232')],
      [0x9003, ASCII, ascii('2024:05:01 11:59:30')],
      [0x9004, ASCII, ascii('2024:05:01 11:59:30')],
      [0x9209, SHORT, shorts(0)],
      [0x920a, RATIONAL, rationals([35, 1])],
      [
        0x9286,
        UNDEFINED,
        concat(
          enc.encode('ASCII\0\0\0'),
          enc.encode('Made up for testing: the GPS points at a landmark.'),
        ),
      ],
      [0xa001, SHORT, shorts(1)],
      [0xa002, SHORT, shorts(320)],
      [0xa003, SHORT, shorts(200)],
      [0xa430, ASCII, ascii('Test Owner')],
      [0xa431, ASCII, ascii('FTF-000001')],
    ],
    gps: [
      [0x0000, BYTE, new Uint8Array([2, 3, 0, 0])],
      [0x0001, ASCII, ascii('N')],
      // 48.8584 = 48° 51' 30.24"
      [0x0002, RATIONAL, rationals([48, 1], [51, 1], [3024, 100])],
      [0x0003, ASCII, ascii('E')],
      // 2.2945 = 2° 17' 40.20"
      [0x0004, RATIONAL, rationals([2, 1], [17, 1], [4020, 100])],
      [0x0005, BYTE, new Uint8Array([0])],
      [0x0006, RATIONAL, rationals([35, 1])],
      [0x0007, RATIONAL, rationals([9, 1], [59, 1], [30, 1])],
      [0x000c, ASCII, ascii('K')],
      [0x000d, RATIONAL, rationals([0, 1])],
      [0x0010, ASCII, ascii('T')],
      [0x0011, RATIONAL, rationals([1234, 10])],
      [0x0012, ASCII, ascii('WGS-84')],
      [0x001d, ASCII, ascii('2024:05:01')],
    ],
    ifd1: [
      [0x0103, SHORT, shorts(6)],
      [0x011a, RATIONAL, rationals([72, 1])],
      [0x011b, RATIONAL, rationals([72, 1])],
      [0x0128, SHORT, shorts(2)],
      [0x0201, LONG, { ptr: 'thumbnail' }],
      [0x0202, LONG, longs(thumbnail.length)],
    ],
  };
  return segment(0xe1, concat(enc.encode('Exif\0\0'), buildTiff(ifds, thumbnail)));
}

// ---------- XMP and IPTC ----------

function xmpApp1(fields) {
  const packet =
    '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>' +
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
    '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/">' +
    `<xmp:CreatorTool>${fields.tool}</xmp:CreatorTool>` +
    `<dc:description><rdf:Alt><rdf:li xml:lang="x-default">${fields.description}</rdf:li></rdf:Alt></dc:description>` +
    `<dc:creator><rdf:Seq><rdf:li>${fields.creator}</rdf:li></rdf:Seq></dc:creator>` +
    '</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
  return enc.encode(packet);
}

function iptcApp13(datasets) {
  const iptc = concat(
    ...datasets.map(([record, id, value]) => {
      const data = typeof value === 'string' ? enc.encode(value) : value;
      return concat(new Uint8Array([0x1c, record, id]), be16(data.length), data);
    }),
  );
  const padded = iptc.length % 2 ? concat(iptc, new Uint8Array(1)) : iptc;
  const resource = concat(
    enc.encode('8BIM'),
    be16(0x0404),
    new Uint8Array([0, 0]),
    be32(iptc.length),
    padded,
  );
  return segment(0xed, concat(enc.encode('Photoshop 3.0\0'), resource));
}

// ---------- meta-eiffel.jpg ----------

{
  const thumbnail = encodeJpeg(drawOriginal(), 80);
  const [head, rest] = splitAfterApp0(encodeJpeg(drawTower(), 85));
  const xmp = xmpApp1({
    tool: 'gen-samples-image-analyzer.mjs',
    description: 'Synthetic XMP description: a drawing, not a photo.',
    creator: 'Nobody',
  });
  const app1Xmp = segment(0xe1, concat(enc.encode('http://ns.adobe.com/xap/1.0/\0'), xmp));
  const app13 = iptcApp13([
    [1, 90, new Uint8Array([0x1b, 0x25, 0x47])], // coded character set: UTF-8
    [2, 0, new Uint8Array([0, 4])],
    [2, 25, 'synthetic'],
    [2, 25, 'tower'],
    [2, 80, 'Nobody'],
    [2, 90, 'Paris'],
    [2, 101, 'France'],
    [2, 120, 'Synthetic IPTC caption for testing'],
  ]);
  const com = segment(0xfe, enc.encode('Synthetic JPEG comment (gen-samples-image-analyzer.mjs)'));
  const zip = zipSync(
    { 'note.txt': [enc.encode('appended payload'), { mtime: new Date(2024, 4, 1, 12, 0, 0) }] },
    { level: 6 },
  );
  write('meta-eiffel.jpg', concat(head, exifApp1(thumbnail), app1Xmp, app13, com, rest, zip));
}

// ---------- meta-plain.png ----------

function pngChunk(type, data) {
  const typeBytes = enc.encode(type);
  return concat(be32(data.length), typeBytes, data, be32(crc32(concat(typeBytes, data))));
}

{
  const c = canvas(160, 100);
  for (let y = 0; y < 100; y++) {
    for (let x = 0; x < 160; x++) {
      const inBox = x > 50 && x < 110 && y > 25 && y < 75;
      c.set(x, y, inBox ? [230, 230, 240] : [30 + (x & ~15), 60 + (y & ~15), 140]);
    }
  }
  const rgb = new Uint8Array(160 * 100 * 3);
  for (let i = 0; i < 160 * 100; i++) rgb.set(c.data.subarray(i * 4, i * 4 + 3), i * 3);
  const png = encodePng({ width: 160, height: 100, data: rgb, channels: 3, depth: 8 });
  const ihdrEnd = 8 + 25;
  const text = (k, v) =>
    pngChunk('tEXt', concat(enc.encode(k), new Uint8Array([0]), enc.encode(v)));
  const xmp = xmpApp1({
    tool: 'gen-samples-image-analyzer.mjs',
    description: 'Synthetic PNG for the image analyzer',
    creator: 'Nobody',
  });
  const itxt = pngChunk(
    'iTXt',
    concat(enc.encode('XML:com.adobe.xmp'), new Uint8Array([0, 0, 0, 0, 0]), xmp),
  );
  const time = pngChunk('tIME', new Uint8Array([0x07, 0xe8, 5, 1, 12, 0, 0]));
  write(
    'meta-plain.png',
    concat(
      png.subarray(0, ihdrEnd),
      text('Title', 'Plain PNG sample'),
      text('Author', 'Nobody'),
      text('Comment', 'No GPS in this one.'),
      itxt,
      time,
      png.subarray(ihdrEnd),
    ),
  );
}
