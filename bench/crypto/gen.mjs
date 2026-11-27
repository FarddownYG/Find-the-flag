import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { case1, case2, case3, case4, case5, case6 } from './encode.mjs';

const dir = fileURLToPath(new URL('./corpus/', import.meta.url));
mkdirSync(dir, { recursive: true });
const cases = [
  ['01-base64.txt', case1, 'FTF{base64_layers_1}'],
  ['02-hex.txt', case2, 'FTF{hex_layer_2}'],
  ['03-base64-twice.txt', case3, 'FTF{double_base64_3}'],
  ['04-base32.txt', case4, 'FTF{base32_rfc4648_4}'],
  ['05-hex-of-base64.txt', case5, 'FTF{mixed_hex_b64_5}'],
  ['06-rot13.txt', case6, 'FTF{rot13_letters_6}'],
];
const manifest = [];
for (const [file, enc, secret] of cases) {
  writeFileSync(dir + file, enc(secret));
  manifest.push({ file, secret });
}
writeFileSync(dir + 'manifest.json', JSON.stringify(manifest, null, 2) + '\n');
console.log(`wrote ${manifest.length} fixtures`);
