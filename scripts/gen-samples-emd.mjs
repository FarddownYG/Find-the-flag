// Deterministic sample files for the EMD (Exploiting Modification Direction) tool.
// Run: node scripts/gen-samples-emd.mjs   (run it again: the bytes are identical)
//
//   emd-cover.png  256x128 colour gradient with seeded noise, every value kept within 5..250 so
//                  that nothing ever needs the 0/255 saturation fallback. Nothing is hidden in it.
//   emd-hello.png  the grayscale (luma) version of the cover with "HELLO_EMD_123" hidden in it:
//                  n = 2 (base 5), k = 3 digits per character, most significant digit first,
//                  weights 1..n, row by row, offset 0. An 8-bit grayscale PNG.
//
// The stego image is made with the tool's own core (loaded through Vite), so the sample and the
// tool cannot drift apart. A made-up message, no real challenge file.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'vite';

const vite = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent',
});
const core = await vite.ssrLoadModule('/src/tools/stego/_emd.ts');
const image = await vite.ssrLoadModule('/src/tools/stego/_emd-image.ts');
await vite.close();

const OUT = new URL('../public/samples/', import.meta.url);
mkdirSync(OUT, { recursive: true });
const write = (name, bytes) => {
  if (bytes.length >= 200 * 1024) throw new Error(`${name} is ${bytes.length} bytes`);
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
    cover.data[k] = 8 + Math.floor((x * 232) / (W - 1)) + noise();
    cover.data[k + 1] = 8 + Math.floor((y * 232) / (H - 1)) + noise();
    cover.data[k + 2] = 8 + Math.floor(((x + y) * 232) / (W + H - 2)) + noise();
    cover.data[k + 3] = 255;
  }
}
for (let i = 0; i < cover.data.length; i++) {
  const v = cover.data[i];
  if (i % 4 !== 3 && (v < 5 || v > 250)) throw new Error(`cover value ${v} out of 5..250`);
}
write('emd-cover.png', image.rgbaPng(cover));

// ---------- stego: "HELLO_EMD_123" in the luma of the cover ----------

const MESSAGE = 'HELLO_EMD_123';
const params = { ...core.DEFAULTS, length: MESSAGE.length };
const gray = image.rgbaToGray(cover, 'gray');
const before = Uint8Array.from(gray.data);
const overflow = core.encodeEmd(gray, MESSAGE, params);
if (overflow !== 0) throw new Error(`${overflow} groups overflowed`);
for (let i = 0; i < before.length; i++) {
  if (Math.abs(gray.data[i] - before[i]) > 1) throw new Error('a pixel moved by more than 1');
}
const png = image.grayPng(gray);
write('emd-hello.png', png);

// Prove it before finishing: read the file back the way the tool reads an uploaded one.
const back = core.decodeEmd(image.rgbaToGray(image.readBackPng(png), 'gray'), params);
if (back.text !== MESSAGE) throw new Error(`round trip failed: ${back.text}`);
console.log(`round trip: ${back.text}`);
