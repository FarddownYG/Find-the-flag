// Independent reference LSB encoder (public technique only). No dependency besides node:zlib.
import { deflateSync } from 'node:zlib';

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** RGBA 8-bit PNG; flag bits (MSB first) go in LSB of R,G,B (not A) of each pixel, row-major. */
export function encodeLsbPng(width, height, flag) {
  const payload = Buffer.from(flag, 'utf8');
  const nbits = payload.length * 8;
  if (nbits > width * height * 3) throw new Error('flag too long for image');
  const stride = 1 + width * 4;
  const raw = Buffer.alloc(stride * height);
  let bit = 0;
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter None
    for (let x = 0; x < width; x++) {
      const o = y * stride + 1 + x * 4;
      // fixed cover: smooth gradient with LSB cleared
      const cover = [(x * 2) & 0xfe, (y * 2) & 0xfe, ((x + y) * 1) & 0xfe];
      for (let c = 0; c < 3; c++) {
        let v = cover[c];
        if (bit < nbits) {
          v |= (payload[bit >> 3] >> (7 - (bit & 7))) & 1;
          bit++;
        }
        raw[o + c] = v;
      }
      raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
