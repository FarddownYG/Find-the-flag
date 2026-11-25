// Generates public/samples/zip-in-jpeg.jpg. Deterministic; everything is made up.
//
//   node scripts/gen-samples-zip-jpeg.mjs
//
// A valid baseline JPEG (64x48 gradient, ends at FFD9) with a complete ZIP archive appended AFTER
// the EOI marker. The ZIP holds one stored file, flag.txt, containing the fabricated flag
// FTF{zip_after_jpeg}. Image viewers ignore the trailing bytes; a carver finds the PK archive.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';
import jpeg from 'jpeg-js';

const outDir = fileURLToPath(new URL('../public/samples/', import.meta.url));
mkdirSync(outDir, { recursive: true });

const W = 64;
const H = 48;
const rgba = new Uint8Array(W * H * 4);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 4;
    rgba[o] = Math.round((x / (W - 1)) * 255);
    rgba[o + 1] = Math.round((y / (H - 1)) * 255);
    rgba[o + 2] = (x + y) % 16 < 8 ? 200 : 60;
    rgba[o + 3] = 255;
  }
}
const img = jpeg.encode({ data: rgba, width: W, height: H }, 85).data;
if (img[img.length - 2] !== 0xff || img[img.length - 1] !== 0xd9)
  throw new Error('JPEG must end with EOI');

const zip = zipSync(
  {
    'flag.txt': [
      new TextEncoder().encode('FTF{zip_after_jpeg}\n'),
      { level: 0, mtime: new Date(2020, 0, 1) },
    ],
  },
  { level: 0 },
);

const out = new Uint8Array(img.length + zip.length);
out.set(img, 0);
out.set(zip, img.length);
writeFileSync(outDir + 'zip-in-jpeg.jpg', out);
console.log(`zip-in-jpeg.jpg: ${img.length} B JPEG + ${zip.length} B ZIP`);
