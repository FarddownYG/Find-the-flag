import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { encodePdfWithHiddenFlag } from './encode.mjs';

const dir = fileURLToPath(new URL('./corpus/', import.meta.url));
mkdirSync(dir, { recursive: true });
const cases = [
  ['01-appended-png.pdf', 'FTF{pdf_appended_png_1}'],
  ['02-appended-png.pdf', 'FTF{trailing_png_after_eof_2}'],
  ['03-appended-png.pdf', 'FTF{polyglot_pdf_png_3}'],
  ['04-appended-png.pdf', 'FTF{carve_then_read_text_4}'],
];
const manifest = [];
for (const [file, secret] of cases) {
  writeFileSync(dir + file, encodePdfWithHiddenFlag(secret));
  manifest.push({ file, secret });
}
writeFileSync(dir + 'manifest.json', JSON.stringify(manifest, null, 2) + '\n');
console.log(`wrote ${manifest.length} fixtures`);
