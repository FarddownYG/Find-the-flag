// Generates the sample of the "AngeCryption" tool in public/samples/. Deterministic: run it again
// and the bytes are identical. Everything in it is made up (a 32x32 striped PNG, a public demo
// key, a fixed IV); there is no real challenge file.
//
//   node scripts/gen-samples-angecryption.mjs
//
// Files:
//   angecryption-sample.bin   a small PNG zero-padded to whole 16-byte blocks and encrypted with
//                             AES-128-CBC, key "FTF-angecrypt-16" (UTF-8), IV 03 14 25 ... (below).
//                             Decrypting it with that key gives the PNG back. The tool finds the
//                             key from its candidate list WITHOUT being told the IV.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cbc } from '@noble/ciphers/aes.js';
import { encode as encodePng } from 'fast-png';

const outDir = fileURLToPath(new URL('../public/samples/', import.meta.url));
mkdirSync(outDir, { recursive: true });

const KEY = new TextEncoder().encode('FTF-angecrypt-16'); // 16 bytes: AES-128
const IV = Uint8Array.from({ length: 16 }, (_, i) => (i * 17 + 3) & 0xff);

// A 32x32 RGB picture: diagonal stripes.
const W = 32;
const data = new Uint8Array(W * W * 3);
for (let y = 0; y < W; y++) {
  for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 3;
    const band = Math.floor((x + y) / 4) % 3;
    data[o] = band === 0 ? 220 : 40;
    data[o + 1] = band === 1 ? 200 : 60;
    data[o + 2] = band === 2 ? 210 : 80;
  }
}
const png = encodePng({ width: W, height: W, data, channels: 3, depth: 8 });

const padded = new Uint8Array(Math.ceil(png.length / 16) * 16);
padded.set(png);
const out = cbc(KEY, IV, { disablePadding: true }).encrypt(padded);

writeFileSync(outDir + 'angecryption-sample.bin', out);
console.log(`angecryption-sample.bin: ${out.length} bytes (PNG ${png.length} bytes)`);
