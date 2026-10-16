// Deterministic sample scripts for the "JavaScript deobfuscator (sandbox)" tool.
// Run: node scripts/gen-samples-js-deobf.mjs   (run it again: the bytes are identical)
//
//   js-deobf-static.txt        escapes, "a" + "b", String.fromCharCode, unescape and atob around
//                              alert("FTF{static_peel}"): the static peel opens it without running it
//   js-deobf-layers.txt        Function(Function("return '<octal escapes>'")())(): two Function layers
//   js-deobf-nested-eval.txt   eval(atob("…")) whose decoded text is eval(atob("…")): two levels
//
// The files are made with the same builders the tests use (loaded through Vite), so the samples and
// the tool cannot drift apart. Made-up payloads, no real challenge file.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'vite';

const vite = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent',
});
let samples;
try {
  const { buildSamples } = await vite.ssrLoadModule('/src/tools/forensics/_js-deobf-samples.ts');
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
