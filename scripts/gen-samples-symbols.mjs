// Deterministic sample pictures for the "Picture alphabets" tool (Pigpen, semaphore, Braille).
// Run: node scripts/gen-samples-symbols.mjs   (run it again: the bytes are identical)
//
//   symbols-pigpen-flag.svg       "FTF{PIGPEN}" in Pigpen (the braces stay plain text)
//   symbols-semaphore-line.svg    "FTF{FLAGS}" as semaphore figures
//   symbols-braille-line.svg      "ftf{braille}" in Braille cells
//
// The pictures are drawn by the tool's own symbol table (loaded through Vite), so the samples and
// the tool cannot drift apart. They carry no letters: no title and no data attribute, so reading
// them is the exercise. Made-up messages, no real challenge file.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'vite';

const vite = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent',
});
let samples;
try {
  const { buildSamples } = await vite.ssrLoadModule('/src/tools/crypto/_symbols-samples.ts');
  samples = buildSamples();
} finally {
  await vite.close();
}

const OUT = new URL('../public/samples/', import.meta.url);
mkdirSync(OUT, { recursive: true });
for (const [name, svg] of Object.entries(samples)) {
  const bytes = new TextEncoder().encode(svg);
  if (bytes.length >= 100 * 1024) throw new Error(`${name} is ${bytes.length} bytes`);
  writeFileSync(new URL(name, OUT), bytes);
  console.log(`${name}: ${bytes.length} bytes`);
}
