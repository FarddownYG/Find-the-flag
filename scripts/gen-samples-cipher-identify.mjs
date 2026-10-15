// Deterministic sample files for the cipher identifier's Try examples.
// Run: node scripts/gen-samples-cipher-identify.mjs   (run it again: the bytes are identical)
//
//   cipher-identify-caesar.txt     Caesar shift 11, letters in blocks of five
//   cipher-identify-vigenere.txt   Vigenère, key CRYPT, blocks of five
//   cipher-identify-playfair.txt   Playfair, key "monarchy", blocks of five
//   cipher-identify-columnar.txt   columnar transposition, key ZEBRAS, blocks of five
//   cipher-identify-adfgx.txt      ADFGX, made-up square and key, blocks of five
//   cipher-identify-base64.txt     the start of the same prose in Base64
//
// They are made with the encrypt modes of the project's own tools (loaded through Vite), so the
// samples and the tools cannot drift apart. The plaintext is original prose and the keys are made
// up: no real challenge file.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'vite';

const vite = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent',
});
const { buildSamples } = await vite.ssrLoadModule('/src/tools/crypto/_cipher-identify-samples.ts');
const { PROSE_A } = await vite.ssrLoadModule('/src/tools/crypto/_sample-text.ts');
const samples = await buildSamples(PROSE_A);
await vite.close();

const OUT = new URL('../public/samples/', import.meta.url);
mkdirSync(OUT, { recursive: true });
for (const [name, text] of Object.entries(samples)) {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length >= 100 * 1024) throw new Error(`${name} is ${bytes.length} bytes`);
  writeFileSync(new URL(name, OUT), bytes);
  console.log(`${name}: ${bytes.length} bytes`);
}
