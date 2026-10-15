// Deterministic sample files for the "hidden bits in base64 / base32 padding" tool.
// Run: node scripts/gen-samples-basen-padding.mjs   (run it again: the bytes are identical)
//
//   basen-padding-base64.txt  "HIDDEN_OK" in the padding bits of 18 base64 lines (4 bits each)
//   basen-padding-base32.txt  "HIDDEN_OK" in the padding bits of 18 base32 lines (4 bits each)
//   basen-padding-layers.txt  base64 lines whose padding hides base32 lines, whose padding hides
//                             "LAYERED_OK": two layers
//
// The files are made with the tool's own encoder (loaded through Vite), so the samples and the
// tool cannot drift apart. Made-up messages, no real challenge file.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'vite';

const vite = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent',
});
const { buildSamples } = await vite.ssrLoadModule('/src/tools/stego/_basen-padding-samples.ts');
await vite.close();

const OUT = new URL('../public/samples/', import.meta.url);
mkdirSync(OUT, { recursive: true });
for (const [name, text] of Object.entries(buildSamples())) {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length >= 100 * 1024) throw new Error(`${name} is ${bytes.length} bytes`);
  writeFileSync(new URL(name, OUT), bytes);
  console.log(`${name}: ${bytes.length} bytes, ${text.trim().split('\n').length} lines`);
}
