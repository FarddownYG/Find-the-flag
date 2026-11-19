// Synthetic sample for the "Colour inspector" tool. Deterministic: run it again and the bytes are
// identical. Nothing here is a real image or a real CTF challenge.
//
//   node scripts/gen-samples-color.mjs
//
// color-swatches.png  64x16 RGBA. A navy field with a blue block and a light block, plus a single
//                     yellow pixel in the corner — the "rare" colour a palette scan should surface.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encode } from 'fast-png';

const outDir = fileURLToPath(new URL('../public/samples/', import.meta.url));
mkdirSync(outDir, { recursive: true });

const W = 64;
const H = 16;
const data = new Uint8Array(W * H * 4);

const NAVY = [0x0f, 0x17, 0x24];
const SEA = [0x7a, 0xa7, 0xf2];
const TEXT = [0xd9, 0xe1, 0xea];
const SIGNAL = [0xf2, 0xc8, 0x4b];

const put = (x, y, [r, g, b]) => {
  const i = (y * W + x) * 4;
  data[i] = r;
  data[i + 1] = g;
  data[i + 2] = b;
  data[i + 3] = 255;
};

for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    if (x < 16) put(x, y, SEA);
    else if (x < 32) put(x, y, TEXT);
    else put(x, y, NAVY);
  }
}
// One rare pixel of signal yellow.
put(W - 1, H - 1, SIGNAL);

const bytes = encode({ width: W, height: H, data, depth: 8, channels: 4 });
writeFileSync(join(outDir, 'color-swatches.png'), bytes);
console.log(`color-swatches.png: ${bytes.length} bytes`);
