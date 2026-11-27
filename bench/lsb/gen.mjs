import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { encodeLsbPng } from './encode.mjs';

const dir = fileURLToPath(new URL('./corpus/', import.meta.url));
mkdirSync(dir, { recursive: true });
const cases = [
  ['01-standard.png', 128, 128, 'FTF{lsb_hidden_pixels_1}'],
  ['02-short.png', 64, 64, 'FTF{abcd}'],
  ['03-long.png', 200, 200, 'FTF{' + 'long_flag_content-0123456789_'.repeat(6).slice(0, 180) + '}'],
  ['04-wide.png', 256, 32, 'FTF{wide_image_lsb_2}'],
  ['05-small.png', 48, 48, 'FTF{tiny_carrier_3!}'],
];
const manifest = [];
for (const [file, w, h, secret] of cases) {
  writeFileSync(dir + file, encodeLsbPng(w, h, secret));
  manifest.push({ file, secret });
}
writeFileSync(dir + 'manifest.json', JSON.stringify(manifest, null, 2) + '\n');
console.log(`wrote ${manifest.length} fixtures`);
