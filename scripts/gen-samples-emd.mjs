// Deterministic sample files for the EMD (Exploiting Modification Direction) tool.
// Run: node scripts/gen-samples-emd.mjs   (run it again: the bytes are identical)
//
//   emd-cover.png  256x128 colour gradient with seeded noise (3 low bits). Nothing is hidden in it.
//   emd-hello.png  the same cover with "HELLO_EMD" embedded: n = 2 (base 5), red channel,
//                  horizontal order, offset 0, 4 digits per byte, most significant digit first.
//
// The stego image is made with the tool's own embed code (loaded through Vite), so the sample
// and the tool cannot drift apart. A made-up message, no real challenge file.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'vite';

const vite = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent',
});
const { embedMessage, stegoPng } = await vite.ssrLoadModule('/src/tools/stego/_emd-run.ts');
const { readDigits } = await vite.ssrLoadModule('/src/tools/stego/_emd-core.ts');
const { digitsToBytes } = await vite.ssrLoadModule('/src/tools/stego/_emd-text.ts');
await vite.close();

const OUT = new URL('../public/samples/', import.meta.url);
mkdirSync(OUT, { recursive: true });
const write = (name, bytes) => {
  writeFileSync(new URL(name, OUT), bytes);
  console.log(`${name}: ${bytes.length} bytes`);
};

// ---------- cover: gradient + seeded noise ----------

const W = 256;
const H = 128;
const cover = { width: W, height: H, data: new Uint8ClampedArray(W * H * 4) };
let seed = 0x2545f491;
const noise = () => {
  // xorshift32: deterministic, no dependency
  seed ^= seed << 13;
  seed >>>= 0;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  seed >>>= 0;
  return seed & 7;
};
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const k = (y * W + x) * 4;
    // Stay away from 0 and 255 so that the sample never needs the saturation fallback.
    cover.data[k] = 24 + Math.floor((x * 200) / (W - 1)) + noise();
    cover.data[k + 1] = 24 + Math.floor((y * 200) / (H - 1)) + noise();
    cover.data[k + 2] = 24 + Math.floor(((x + y) * 200) / (W + H - 2)) + noise();
    cover.data[k + 3] = 255;
  }
}
write('emd-cover.png', stegoPng(cover));

// ---------- stego: "HELLO_EMD" ----------

const params = { n: 2, channel: 'r', traversal: 'horizontal', offset: 0 };
const conv = { grouping: 'fixed', order: 'msd' };
const message = new TextEncoder().encode('HELLO_EMD');
const { stego } = embedMessage(cover, params, conv, message);
write('emd-hello.png', stegoPng(stego));

// Prove it before saving anything else: read it back with the extractor.
const back = digitsToBytes(readDigits(stego, params, 36), 5, conv, message.length);
if (new TextDecoder().decode(back) !== 'HELLO_EMD') throw new Error('round trip failed');
console.log('round trip: HELLO_EMD');
