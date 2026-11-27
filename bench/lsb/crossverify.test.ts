import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const dir = (n: string) => fileURLToPath(new URL(`./corpus/${n}`, import.meta.url));

// Independent minimal decoder (RGBA/RGB 8-bit, filter None/Sub/Up/Avg/Paeth).
function decode(png: Buffer): { w: number; h: number; ch: number; px: Uint8Array } {
  let p = 8,
    w = 0,
    h = 0,
    ch = 4;
  const idat: Buffer[] = [];
  while (p < png.length) {
    const len = png.readUInt32BE(p);
    const type = png.toString('ascii', p + 4, p + 8);
    const data = png.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      ch = data[9] === 6 ? 4 : 3;
    } else if (type === 'IDAT') idat.push(data);
    p += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const px = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]!;
    for (let i = 0; i < stride; i++) {
      const v = raw[y * (stride + 1) + 1 + i]!;
      const a = i >= ch ? px[y * stride + i - ch]! : 0;
      const b = y > 0 ? px[(y - 1) * stride + i]! : 0;
      const c = y > 0 && i >= ch ? px[(y - 1) * stride + i - ch]! : 0;
      let r = v;
      if (f === 1) r = v + a;
      else if (f === 2) r = v + b;
      else if (f === 3) r = v + ((a + b) >> 1);
      else if (f === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a),
          pb = Math.abs(pp - b),
          pc = Math.abs(pp - c);
        r = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      px[y * stride + i] = r & 255;
    }
  }
  return { w, h, ch, px };
}

function extract(png: Buffer): string {
  const { w, h, ch, px } = decode(png);
  const bytes: number[] = [];
  let cur = 0,
    n = 0;
  for (let i = 0; i < w * h; i++) {
    for (let c = 0; c < 3; c++) {
      cur = (cur << 1) | (px[i * ch + c]! & 1);
      if (++n === 8) {
        bytes.push(cur);
        cur = 0;
        n = 0;
      }
    }
  }
  const text = Buffer.from(bytes).toString('latin1');
  const m = /FTF\{[!-z]{4,200}\}/.exec(text);
  return m ? m[0] : '';
}

const manifest = JSON.parse(readFileSync(dir('manifest.json'), 'utf8')) as {
  file: string;
  secret: string;
}[];

describe('LSB reference encoder cross-verification', () => {
  it('has at least 4 fixtures', () => expect(manifest.length).toBeGreaterThanOrEqual(4));
  for (const { file, secret } of manifest) {
    it(`${file} decodes to its secret`, () => {
      expect(extract(readFileSync(dir(file)))).toBe(secret);
    });
  }
});
