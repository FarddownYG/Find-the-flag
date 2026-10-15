// Deterministic sample texts for the "Hidden Unicode text (homoglyphs + invisibles)" tool.
// Run: node scripts/gen-samples-unicode-hidden.mjs   (run it again: the bytes are identical)
//
//   unicode-hidden-zerowidth.txt  "SECRET42" as 64 zero-width characters (ZWSP = 0, ZWNJ = 1)
//   unicode-hidden-homoglyph.txt  "HIDDEN_OK" in the pattern of letters swapped for lookalikes
//   unicode-hidden-tags.txt       "TAGS_OK" in tag characters, between a language and a cancel tag
//
// The files are made with the tool's own encoders (loaded through Vite), so the samples and the
// tool cannot drift apart. Made-up messages and covers, no real challenge file.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'vite';

const vite = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent',
});
let samples;
try {
  const { loadUnicodeData } = await vite.ssrLoadModule('/src/tools/stego/_unicode-lookup.ts');
  const { buildSamples } = await vite.ssrLoadModule('/src/tools/stego/_unicode-hidden-samples.ts');
  samples = buildSamples(await loadUnicodeData());
} finally {
  await vite.close();
}

const OUT = new URL('../public/samples/', import.meta.url);
mkdirSync(OUT, { recursive: true });
for (const [name, text] of Object.entries(samples)) {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length >= 100 * 1024) throw new Error(`${name} is ${bytes.length} bytes`);
  writeFileSync(new URL(name, OUT), bytes);
  console.log(`${name}: ${bytes.length} bytes, ${[...text].length} code points`);
}
