// Generates the Web source analyzer samples in public/samples/. Deterministic: run it again and
// the bytes are identical. The files are written by src/tools/forensics/_web-source-fixtures.ts
// (loaded through Vite like the other TS-aware scripts). A made-up "demo-shop" web app: nothing
// comes from a real site or a real challenge, and the secrets are plain test words.
//
//   node scripts/gen-samples-web-source.mjs
//
// Files:
//   web-source-bundle.js       a webpack-style bundle that ends with a sourceMappingURL comment
//   web-source-bundle.js.map   its source map; one source (pages/Admin/SecretPanel.js) is imported
//                              by nothing, and its sourcesContent holds "// secret: TEST_FLAG_123"
//   web-source-inline.js       a script with its source map inlined as a base64 data: URI; the
//                              inlined config.js holds adminPassword = 'INLINE_SECRET_456'
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const outDir = fileURLToPath(new URL('../public/samples/', import.meta.url));
const vite = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent',
});
try {
  const fx = await vite.ssrLoadModule('/src/tools/forensics/_web-source-fixtures.ts');
  for (const { name, bytes } of fx.buildSamples()) {
    if (bytes.length >= 16_000) throw new Error(`${name} is too big (${bytes.length} bytes)`);
    writeFileSync(outDir + name, bytes);
    console.log(`${name}: ${bytes.length} bytes`);
  }
} finally {
  await vite.close();
}
