// Independent ZIP (STORE) + PNG encoder, written from the public formats only.
import { deflateSync } from 'node:zlib';

const T = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  T[n] = c >>> 0;
}
export function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = T[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const u16 = (v) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v);
  return b;
};
const u32 = (v) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v >>> 0);
  return b;
};

// entries: [{name, data: Buffer|string}] -> ZIP Buffer (method 0 = STORE)
export function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let off = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8');
    const crc = crc32(data);
    const lh = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      u16(10),
      u16(0),
      u16(0),
      u16(0),
      u16(0x21),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(name.length),
      u16(0),
      name,
      data,
    ]);
    centrals.push(
      Buffer.concat([
        Buffer.from([0x50, 0x4b, 0x01, 0x02]),
        u16(20),
        u16(10),
        u16(0),
        u16(0),
        u16(0),
        u16(0x21),
        u32(crc),
        u32(data.length),
        u32(data.length),
        u16(name.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(off),
        name,
      ]),
    );
    locals.push(lh);
    off += lh.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x05, 0x06]),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(cd.length),
    u32(off),
    u16(0),
  ]);
  return Buffer.concat([...locals, cd, eocd]);
}

function chunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  return Buffer.concat([u32be(data.length), t, data, u32be(crc32(Buffer.concat([t, data])))]);
}
function u32be(v) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(v >>> 0);
  return b;
}

// 16x16 RGB gradient PNG
export function makePng() {
  const w = 16,
    h = 16;
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const r = y * (1 + w * 3);
    raw[r] = 0;
    for (let x = 0; x < w; x++) {
      raw[r + 1 + x * 3] = x * 16;
      raw[r + 2 + x * 3] = y * 16;
      raw[r + 3 + x * 3] = 128;
    }
  }
  const ihdr = Buffer.concat([u32be(w), u32be(h), Buffer.from([8, 2, 0, 0, 0])]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function makePngZipPolyglot(flag) {
  return Buffer.concat([makePng(), makeZip([{ name: 'flag.txt', data: flag }])]);
}
