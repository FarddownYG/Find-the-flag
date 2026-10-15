// Deterministic sample messages for the "Enigma machine" tool.
// Run: node scripts/gen-samples-enigma.mjs   (run it again: the bytes are identical)
//
//   enigma-m3-weather.txt  M3 message that starts with the crib WETTERBERICHT, no plugboard
//   enigma-m4-flag.txt     M4 message with the crib FLAGENIGMA in the middle, no plugboard
//   enigma-i-plug.txt      Enigma I message with ten plugboard pairs, hides a demo flag
//
// The texts are made up and run through the tool's own engine (loaded through Vite), so the
// samples and the tool cannot drift apart. The settings are in src/tools/crypto/_enigma-samples.ts
// and in the comments of the examples. No real traffic, no real challenge file.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'vite';

const vite = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent',
});
let samples;
try {
  const { buildSamples } = await vite.ssrLoadModule('/src/tools/crypto/_enigma-samples.ts');
  samples = buildSamples();
} finally {
  await vite.close();
}

const OUT = new URL('../public/samples/', import.meta.url);
mkdirSync(OUT, { recursive: true });
for (const [name, text] of Object.entries(samples)) {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length >= 100 * 1024) throw new Error(`${name} is ${bytes.length} bytes`);
  writeFileSync(new URL(name, OUT), bytes);
  console.log(`${name}: ${bytes.length} bytes`);
}
