// Deterministic sample files for the stego tools. Run: node scripts/gen-samples-stego.mjs
// Uses only fast-png (PNG encoding) and fflate (zlib); everything else is hand-rolled.
import { mkdirSync, writeFileSync } from 'node:fs';
import { zlibSync } from 'fflate';
import { encode } from 'fast-png';

const OUT = new URL('../public/samples/', import.meta.url);
mkdirSync(OUT, { recursive: true });
const write = (name, bytes) => {
  writeFileSync(new URL(name, OUT), bytes);
  console.log(`${name}: ${bytes.length} bytes`);
};

// ---------- helpers ----------

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

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (b) => {
  let c = 0xffffffff;
  for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
};
const u32be = (n) => new Uint8Array([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const u16le = (n) => new Uint8Array([n & 255, (n >> 8) & 255]);
const u32le = (n) => new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);

/** PNG chunk with a correct CRC. */
const chunk = (type, data) => {
  const t = enc.encode(type);
  return concat(u32be(data.length), t, data, u32be(crc32(concat(t, data))));
};

/** Split a PNG file into [type, data] pairs. */
const splitChunks = (png) => {
  const out = [];
  let off = 8;
  while (off < png.length) {
    const len = new DataView(png.buffer, png.byteOffset + off).getUint32(0);
    out.push([
      String.fromCharCode(...png.subarray(off + 4, off + 8)),
      png.subarray(off + 8, off + 8 + len),
    ]);
    off += 12 + len;
  }
  return out;
};
const PNG_SIG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** mulberry32: tiny seeded PRNG. */
const prng = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// ---------- 5x8 bitmap font (lowercase, digits, { } _ - space) ----------

const FONT = {
  a: ['.....', '.....', '.###.', '....#', '.####', '#...#', '.####', '.....'],
  b: ['#....', '#....', '####.', '#...#', '#...#', '#...#', '####.', '.....'],
  c: ['.....', '.....', '.###.', '#...#', '#....', '#...#', '.###.', '.....'],
  d: ['....#', '....#', '.####', '#...#', '#...#', '#...#', '.####', '.....'],
  e: ['.....', '.....', '.###.', '#...#', '#####', '#....', '.###.', '.....'],
  f: ['..##.', '.#...', '####.', '.#...', '.#...', '.#...', '.#...', '.....'],
  g: ['.....', '.####', '#...#', '#...#', '.####', '....#', '#...#', '.###.'],
  h: ['#....', '#....', '####.', '#...#', '#...#', '#...#', '#...#', '.....'],
  i: ['..#..', '.....', '.##..', '..#..', '..#..', '..#..', '.###.', '.....'],
  j: ['...#.', '.....', '..##.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
  k: ['#....', '#....', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '.....'],
  l: ['.##..', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.', '.....'],
  m: ['.....', '.....', '##.#.', '#.#.#', '#.#.#', '#...#', '#...#', '.....'],
  n: ['.....', '.....', '####.', '#...#', '#...#', '#...#', '#...#', '.....'],
  o: ['.....', '.....', '.###.', '#...#', '#...#', '#...#', '.###.', '.....'],
  p: ['.....', '####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  q: ['.....', '.####', '#...#', '#...#', '.####', '....#', '....#', '....#'],
  r: ['.....', '.....', '#.###', '##...', '#....', '#....', '#....', '.....'],
  s: ['.....', '.....', '.####', '#....', '.###.', '....#', '####.', '.....'],
  t: ['.#...', '.#...', '####.', '.#...', '.#...', '.#..#', '..##.', '.....'],
  u: ['.....', '.....', '#...#', '#...#', '#...#', '#..##', '.##.#', '.....'],
  v: ['.....', '.....', '#...#', '#...#', '#...#', '.#.#.', '..#..', '.....'],
  w: ['.....', '.....', '#...#', '#...#', '#.#.#', '#.#.#', '.#.#.', '.....'],
  x: ['.....', '.....', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '.....'],
  y: ['.....', '#...#', '#...#', '#...#', '.####', '....#', '#...#', '.###.'],
  z: ['.....', '.....', '#####', '...#.', '..#..', '.#...', '#####', '.....'],
  0: ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.', '.....'],
  1: ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.', '.....'],
  2: ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####', '.....'],
  3: ['.###.', '#...#', '....#', '..##.', '....#', '#...#', '.###.', '.....'],
  4: ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.', '.....'],
  5: ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.', '.....'],
  6: ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.', '.....'],
  7: ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...', '.....'],
  8: ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.', '.....'],
  9: ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..', '.....'],
  '{': ['..##.', '.#...', '.#...', '#....', '.#...', '.#...', '..##.', '.....'],
  '}': ['.##..', '...#.', '...#.', '....#', '...#.', '...#.', '.##..', '.....'],
  _: ['.....', '.....', '.....', '.....', '.....', '.....', '.....', '#####'],
  '-': ['.....', '.....', '.....', '#####', '.....', '.....', '.....', '.....'],
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....', '.....'],
};

/** Set mask[y*w+x] = 1 where the text is lit. */
function drawText(mask, w, text, x0, y0, scale) {
  let cx = x0;
  for (const ch of text) {
    const glyph = FONT[ch];
    if (!glyph) throw new Error(`no glyph for ${ch}`);
    glyph.forEach((row, gy) => {
      [...row].forEach((px, gx) => {
        if (px !== '#') return;
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            mask[(y0 + gy * scale + dy) * w + cx + gx * scale + dx] = 1;
          }
        }
      });
    });
    cx += 6 * scale;
  }
}

const encodeRgb = (width, height, data) => encode({ width, height, data, depth: 8, channels: 3 });

// ---------- 1. stego-lsb.png: flag in bit 0 of R,G,B, row-major, MSB first ----------

{
  const W = 96;
  const H = 64;
  const data = new Uint8Array(W * H * 3);
  const rnd = prng(1);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 3;
      // Soft blue-green gradient with a faint diagonal texture; low bits stay quiet.
      data[o] = (40 + (x * 90) / W + (y * 30) / H) & 0xfc;
      data[o + 1] = (80 + (y * 120) / H) & 0xfc;
      data[o + 2] = (150 + ((x + y) % 24)) & 0xfc;
      // A little noise in bit 0 so the untouched pixels do not look suspiciously clean.
      for (let c = 0; c < 3; c++) data[o + c] |= rnd() < 0.5 ? 1 : 0;
    }
  }
  const message = enc.encode('flag{lsb_hidden_in_pixels}\0');
  let bit = 0;
  for (const byte of message) {
    for (let k = 7; k >= 0; k--, bit++) {
      data[bit] = (data[bit] & 0xfe) | ((byte >> k) & 1);
    }
  }
  write('stego-lsb.png', encodeRgb(W, H, data));
}

// ---------- 2. stego-planes.png: text only in bit 1 of the green channel ----------

{
  const W = 176;
  const H = 40;
  const mask = new Uint8Array(W * H);
  drawText(mask, W, 'flag{bit_planes}', 6, 12, 1);
  const data = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 3;
      data[o] = (30 + (x * 100) / W) & 0xfc;
      data[o + 1] = (60 + (y * 80) / H) & 0xfc;
      data[o + 2] = (140 + ((x + y) % 16)) & 0xfc;
      data[o + 1] |= mask[y * W + x] << 1;
    }
  }
  write('stego-planes.png', encodeRgb(W, H, data));
}

// ---------- 3. stego-badcrc.png: IHDR height reduced, CRC left alone ----------

{
  const W = 256;
  const H = 64;
  const mask = new Uint8Array(W * H);
  drawText(mask, W, 'flag{bad_crc_height}', 8, 40, 2);
  // Rows below the cropped height only; the top is a plain banner.
  const data = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 3;
      const lit = mask[y * W + x];
      const base = y < 32 ? [24, 64, 112] : [236, 232, 220];
      data[o] = lit ? 200 : base[0];
      data[o + 1] = lit ? 30 : base[1];
      data[o + 2] = lit ? 30 : base[2];
    }
  }
  const png = encodeRgb(W, H, data);
  const out = png.slice();
  // IHDR data starts at offset 16: width(4) height(4). Halve the height, keep the stored CRC.
  new DataView(out.buffer).setUint32(20, 32);
  write('stego-badcrc.png', out);
}

// ---------- 4. stego-text-chunk.png: tEXt + zTXt + iTXt chunks ----------

{
  const W = 32;
  const H = 32;
  const data = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 3;
      data[o] = x * 8;
      data[o + 1] = y * 8;
      data[o + 2] = 128;
    }
  }
  const base = splitChunks(encodeRgb(W, H, data));
  const latin1 = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
  const text = (kw, v) => chunk('tEXt', concat(latin1(kw), new Uint8Array([0]), latin1(v)));
  const ztxt = (kw, v) =>
    chunk(
      'zTXt',
      concat(latin1(kw), new Uint8Array([0, 0]), zlibSync(enc.encode(v), { level: 9 })),
    );
  const itxt = (kw, lang, v) =>
    chunk(
      'iTXt',
      concat(
        enc.encode(kw),
        new Uint8Array([0, 0, 0]),
        latin1(lang),
        new Uint8Array([0, 0]),
        enc.encode(v),
      ),
    );
  const parts = [PNG_SIG];
  for (const [type, d] of base) {
    if (type === 'IDAT') {
      parts.push(
        text('Author', 'Find The Flag samples'),
        text('Comment', 'Nothing to see here... or is there? Check the compressed chunk.'),
        ztxt('Secret', 'flag{png_text_chunks}'),
        itxt('Description', 'en', 'Un message caché dans un chunk iTXt'),
      );
    }
    parts.push(chunk(type, d));
  }
  write('stego-text-chunk.png', concat(...parts));
}

// ---------- 5. stego-trailing.png: a ZIP appended after IEND ----------

{
  const W = 48;
  const H = 32;
  const data = new Uint8Array(W * H * 3);
  const rnd = prng(5);
  for (let i = 0; i < data.length; i += 3) {
    const v = 90 + Math.floor(rnd() * 12);
    data[i] = v;
    data[i + 1] = v + 20;
    data[i + 2] = v + 60;
  }
  const png = encodeRgb(W, H, data);
  // Minimal ZIP (stored, one file "flag.txt") built by hand so it is byte-for-byte reproducible.
  const name = enc.encode('flag.txt');
  const body = enc.encode('flag{appended_after_iend}\n');
  const crc = crc32(body);
  const local = concat(
    new Uint8Array([0x50, 0x4b, 3, 4]),
    u16le(20),
    u16le(0),
    u16le(0),
    u16le(0),
    u16le(0x5821), // version, flags, method, time, date
    u32le(crc),
    u32le(body.length),
    u32le(body.length),
    u16le(name.length),
    u16le(0),
    name,
    body,
  );
  const central = concat(
    new Uint8Array([0x50, 0x4b, 1, 2]),
    u16le(20),
    u16le(20),
    u16le(0),
    u16le(0),
    u16le(0),
    u16le(0x5821),
    u32le(crc),
    u32le(body.length),
    u32le(body.length),
    u16le(name.length),
    u16le(0),
    u16le(0),
    u16le(0),
    u16le(0),
    u32le(0),
    u32le(0),
    name,
  );
  const eocd = concat(
    new Uint8Array([0x50, 0x4b, 5, 6]),
    u16le(0),
    u16le(0),
    u16le(1),
    u16le(1),
    u32le(central.length),
    u32le(local.length),
    u16le(0),
  );
  write('stego-trailing.png', concat(png, local, central, eocd));
}

// ---------- 6. stego-qr.png: QR code for "flag{qr_scanned}" ----------
// Version 1, error correction L, mask chosen by the standard penalty rules. The module matrix is
// hard-coded (no QR library needed); qr.test.ts checks it against a real encoder and decodes the PNG.

const QR_MODULES = [
  '#######.#.....#######',
  '#.....#..#.##.#.....#',
  '#.###.#..##.#.#.###.#',
  '#.###.#...###.#.###.#',
  '#.###.#...##..#.###.#',
  '#.....#.....#.#.....#',
  '#######.#.#.#.#######',
  '........#####........',
  '##.##.#..####.#.....#',
  '.##....####..#.###...',
  '..#...##..#.##...####',
  '##.#.....#.#.#....#.#',
  '.##.#.##..#....###..#',
  '........###..####.##.',
  '#######..#.##.#.###..',
  '#.....#......######.#',
  '#.###.#.#.#....#.#..#',
  '#.###.#.##.#...#..##.',
  '#.###.#..##.#...#..##',
  '#.....#.#.###.#######',
  '#######.#...####.#...',
];

{
  const size = QR_MODULES.length;
  const SCALE = 8;
  const QUIET = 4;
  const side = (size + 2 * QUIET) * SCALE;
  const data = new Uint8Array(side * side).fill(255);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (QR_MODULES[y][x] !== '#') continue;
      for (let dy = 0; dy < SCALE; dy++) {
        for (let dx = 0; dx < SCALE; dx++) {
          data[((y + QUIET) * SCALE + dy) * side + (x + QUIET) * SCALE + dx] = 0;
        }
      }
    }
  }
  write('stego-qr.png', encode({ width: side, height: side, data, depth: 8, channels: 1 }));
}

// ---------- 7. stego-exif.jpg: tiny JPEG with EXIF (text, GPS, thumbnail) ----------

/** Baseline grayscale JPEG made of flat 8x8 blocks (custom Huffman tables, no DCT needed). */
function tinyJpeg(widthBlocks, heightBlocks, levels) {
  const w = widthBlocks * 8;
  const h = heightBlocks * 8;
  const seg = (marker, payload) =>
    concat(new Uint8Array([0xff, marker]), u16be(payload.length + 2), payload);
  const dqt = seg(0xdb, concat(new Uint8Array([0]), new Uint8Array(64).fill(1)));
  const sof = seg(0xc0, new Uint8Array([8, h >> 8, h & 255, w >> 8, w & 255, 1, 1, 0x11, 0]));
  // Standard luminance DC table (categories 0..11); AC table has only the end-of-block symbol.
  const dcCounts = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
  const dht = concat(
    seg(
      0xc4,
      concat(
        new Uint8Array([0x00]),
        new Uint8Array(dcCounts),
        new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
      ),
    ),
    seg(
      0xc4,
      concat(
        new Uint8Array([0x10]),
        new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
        new Uint8Array([0]),
      ),
    ),
  );
  // Canonical DC codes.
  const dcCodes = [];
  let code = 0;
  let sym = 0;
  for (let len = 1; len <= 16; len++) {
    for (let k = 0; k < dcCounts[len - 1]; k++) dcCodes[sym++] = { code: code++, len };
    code <<= 1;
  }
  const bits = [];
  const push = (value, n) => {
    for (let i = n - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  let prev = 0;
  for (const level of levels) {
    const dc = Math.round((level - 128) * 8);
    const diff = dc - prev;
    prev = dc;
    const cat = diff === 0 ? 0 : Math.floor(Math.log2(Math.abs(diff))) + 1;
    push(dcCodes[cat].code, dcCodes[cat].len);
    if (cat) push(diff >= 0 ? diff : diff + (1 << cat) - 1, cat);
    push(0, 1); // AC end-of-block, code "0"
  }
  while (bits.length % 8) bits.push(1);
  const scan = [];
  for (let i = 0; i < bits.length; i += 8) {
    const b = parseInt(bits.slice(i, i + 8).join(''), 2);
    scan.push(b);
    if (b === 0xff) scan.push(0);
  }
  const sos = seg(0xda, new Uint8Array([1, 1, 0x00, 0, 63, 0]));
  return concat(
    new Uint8Array([0xff, 0xd8]),
    dqt,
    sof,
    dht,
    sos,
    new Uint8Array(scan),
    new Uint8Array([0xff, 0xd9]),
  );
}
function u16be(n) {
  return new Uint8Array([(n >> 8) & 255, n & 255]);
}

/** Little-endian TIFF with IFD0, Exif IFD, GPS IFD and IFD1 (JPEG thumbnail). */
function buildTiff(thumbnail) {
  const ascii = (s) => concat(enc.encode(s), new Uint8Array([0]));
  const rational = (...pairs) => concat(...pairs.flatMap(([n, d]) => [u32le(n), u32le(d)]));
  // entry: [tag, type, count, bytes] or [tag, 4, 1, {ptr: name}]
  const ifd0 = [
    [0x010e, 2, ascii('flag{exif}')],
    [0x010f, 2, ascii('FindTheFlag Labs')],
    [0x0110, 2, ascii('CTF-1000')],
    [0x0112, 3, u16le(1)],
    [0x0131, 2, ascii('stego-sample 1.0')],
    [0x0132, 2, ascii('2024:03:15 10:30:00')],
    [0x013b, 2, ascii('ctf-author')],
    [0x8298, 2, ascii('Public domain')],
    [0x8769, 4, { ptr: 'exif' }],
    [0x8825, 4, { ptr: 'gps' }],
  ];
  const exif = [
    [0x829a, 5, rational([1, 250])],
    [0x829d, 5, rational([28, 10])],
    [0x8827, 3, u16le(200)],
    [0x9003, 2, ascii('2024:03:15 10:29:41')],
    [
      0x9286,
      7,
      concat(enc.encode('ASCII\0\0\0'), enc.encode('The real message is in the description.')),
    ],
    [0xa002, 4, u32le(16)],
    [0xa003, 4, u32le(16)],
  ];
  const gps = [
    [0x0001, 2, ascii('N')],
    [0x0002, 5, rational([48, 1], [51, 1], [3024, 100])],
    [0x0003, 2, ascii('E')],
    [0x0004, 5, rational([2, 1], [17, 1], [4020, 100])],
    [0x0005, 1, new Uint8Array([0])],
    [0x0006, 5, rational([330, 10])],
  ];
  const ifd1 = [
    [0x0103, 3, u16le(6)],
    [0x0201, 4, { ptr: 'thumb' }],
    [0x0202, 4, u32le(thumbnail.length)],
  ];
  const ifds = { ifd0, ifd1, exif, gps };
  const order = ['ifd0', 'ifd1', 'exif', 'gps'];
  const offsets = {};
  let pos = 8;
  for (const name of order) {
    offsets[name] = pos;
    pos += 2 + 12 * ifds[name].length + 4;
  }
  const area = [];
  let areaPos = pos;
  const alloc = (bytes) => {
    const at = areaPos;
    area.push(bytes);
    areaPos += bytes.length + (bytes.length % 2);
    if (bytes.length % 2) area.push(new Uint8Array(1));
    return at;
  };
  const body = [];
  for (const name of order) {
    const entries = ifds[name];
    const parts = [u16le(entries.length)];
    for (const [tag, type, value] of entries) {
      let count;
      let bytes;
      if (!(value instanceof Uint8Array)) {
        count = 1;
        bytes = u32le(value.ptr === 'thumb' ? 0 : offsets[value.ptr]);
      } else {
        const size = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1 }[type];
        count = value.length / size;
        bytes = value;
      }
      const inline =
        bytes.length <= 4 ? concat(bytes, new Uint8Array(4 - bytes.length)) : u32le(alloc(bytes));
      parts.push(u16le(tag), u16le(type), u32le(count), inline);
    }
    parts.push(u32le(name === 'ifd0' ? offsets.ifd1 : 0));
    body.push(concat(...parts));
  }
  const thumbAt = areaPos;
  const tiff = concat(enc.encode('II'), u16le(42), u32le(8), ...body, ...area, thumbnail);
  // Patch the thumbnail offset now that the data area size is known.
  const dv = new DataView(tiff.buffer);
  const ifd1At = offsets.ifd1;
  for (let k = 0; k < ifd1.length; k++) {
    const entryAt = ifd1At + 2 + k * 12;
    if (dv.getUint16(entryAt, true) === 0x0201) dv.setUint32(entryAt + 8, thumbAt, true);
  }
  return tiff;
}

{
  const thumbnail = tinyJpeg(1, 1, [64]);
  const tiff = buildTiff(thumbnail);
  const exifPayload = concat(enc.encode('Exif\0\0'), tiff);
  const app1 = concat(new Uint8Array([0xff, 0xe1]), u16be(exifPayload.length + 2), exifPayload);
  const comment = enc.encode('Created by gen-samples-stego.mjs');
  const com = concat(new Uint8Array([0xff, 0xfe]), u16be(comment.length + 2), comment);
  const main = tinyJpeg(2, 2, [60, 120, 180, 240]);
  // SOI, APP1(EXIF), COM, then the rest of the baseline JPEG.
  write('stego-exif.jpg', concat(main.subarray(0, 2), app1, com, main.subarray(2)));
}
