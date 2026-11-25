// Generates public/samples/apng-hidden.png. Deterministic: run it again and the bytes are
// identical. Everything is made up (a 24x24 animated PNG, a fabricated flag); no real challenge.
//
//   node scripts/gen-samples-apng.mjs
//
// The file is a valid APNG: IHDR, acTL (4 frames, 0 loops), then fcTL/IDAT (default image),
// fcTL/fdAT x3 with varied delays, correct CRCs and sequence numbers. The fabricated flag
// FTF{apng_frames} is split in three pieces, one per extra frame, each in a zlib-compressed
// zTXt chunk "frame-note-N" that follows that frame's fdAT. A tEXt "Comment" hints at it.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { zlibSync } from 'fflate';

const outDir = fileURLToPath(new URL('../public/samples/', import.meta.url));
mkdirSync(outDir, { recursive: true });

const enc = new TextEncoder();
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b) => {
  let c = 0xffffffff;
  for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u16 = (n) => [(n >>> 8) & 255, n & 255];
const chunk = (type, data) => {
  const td = new Uint8Array([...enc.encode(type), ...data]);
  return new Uint8Array([...u32(data.length), ...td, ...u32(crc32(td))]);
};

const W = 24;
const H = 24;
// Frame pixels (RGB): a coloured square on a dark ground, moving each frame.
const frameRaw = (i) => {
  const raw = new Uint8Array((W * 3 + 1) * H);
  const cols = [
    [220, 60, 60],
    [60, 200, 90],
    [70, 110, 230],
    [230, 200, 50],
  ];
  for (let y = 0; y < H; y++) {
    raw[y * (W * 3 + 1)] = 0;
    for (let x = 0; x < W; x++) {
      const inside = x >= i * 4 + 2 && x < i * 4 + 10 && y >= 8 && y < 16;
      const c = inside ? cols[i] : [24, 28, 40];
      raw.set(c, y * (W * 3 + 1) + 1 + x * 3);
    }
  }
  return zlibSync(raw, { level: 9 });
};

const ihdr = chunk('IHDR', [...u32(W), ...u32(H), 8, 2, 0, 0, 0]);
const actl = chunk('acTL', [...u32(4), ...u32(0)]);
const delays = [
  [1, 10],
  [3, 100],
  [1, 4],
  [7, 50],
]; // num/den, varied
let seq = 0;
const fctl = (i) =>
  chunk('fcTL', [
    ...u32(seq++),
    ...u32(W),
    ...u32(H),
    ...u32(0),
    ...u32(0),
    ...u16(delays[i][0]),
    ...u16(delays[i][1]),
    0,
    0,
  ]);
const text = (k, v) => chunk('tEXt', [...enc.encode(k), 0, ...enc.encode(v)]);
const ztxt = (k, v) => chunk('zTXt', [...enc.encode(k), 0, 0, ...zlibSync(enc.encode(v))]);

const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), ihdr, actl];
parts.push(fctl(0), chunk('IDAT', frameRaw(0)));
parts.push(text('Comment', 'frame 0 is the cover; look at the other frames'));
const pieces = ['FTF{apng', '_fram', 'es}'];
for (let i = 1; i < 4; i++) {
  parts.push(fctl(i));
  parts.push(chunk('fdAT', [...u32(seq++), ...frameRaw(i)]));
  parts.push(ztxt(`frame-note-${i}`, pieces[i - 1]));
}
parts.push(chunk('IEND', []));

const total = parts.reduce((n, p) => n + p.length, 0);
const out = new Uint8Array(total);
let o = 0;
for (const p of parts) {
  out.set(p, o);
  o += p.length;
}
writeFileSync(outDir + 'apng-hidden.png', out);
console.log(`apng-hidden.png: ${out.length} bytes`);
