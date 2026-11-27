import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeZip, makePngZipPolyglot } from './encode.mjs';

const out = fileURLToPath(new URL('./corpus/', import.meta.url));
mkdirSync(out, { recursive: true });
const manifest = [];
const add = (file, buf, secret) => {
  writeFileSync(out + file, buf);
  manifest.push({ file, secret });
};
for (const [i, s] of ['FTF{zip_stored_1}', 'FTF{zip_stored_2}'].entries())
  add(`simple-${i + 1}.zip`, makeZip([{ name: 'flag.txt', data: s }]), s);
for (const [i, s] of ['FTF{png_zip_polyglot_1}', 'FTF{png_zip_polyglot_2}'].entries())
  add(`polyglot-${i + 1}.png`, makePngZipPolyglot(s), s);
writeFileSync(out + 'manifest.json', JSON.stringify(manifest, null, 2) + '\n');
console.log(`wrote ${manifest.length} files`);
