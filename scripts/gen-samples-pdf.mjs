// Generates the PDF analyzer samples in public/samples/. Deterministic: run it again and the bytes
// are identical. Every PDF is written by hand (objects, xref tables, trailers, an xref stream, an
// RC4 encryption) with the small writer of src/tools/forensics/_pdf-kit.ts, loaded through Vite
// like the other TS-aware scripts. Nothing comes from a real challenge; the secrets are made up.
//
//   node scripts/gen-samples-pdf.mjs
//
// Files:
//   pdf-revisions.pdf      two saves: the first page said FTF{old_revision}, the update replaced it
//   pdf-embedded-js.pdf    an embedded file (FTF{embedded_file}), JavaScript that only calls
//                          app.alert('demo'), a link and a form field holding FTF{form_value}
//   pdf-invisible-text.pdf text that is drawn but cannot be seen, five ways (render mode 3, white,
//                          tiny, off the page, under a black box): FTF{invisible_text} ...
//   pdf-objstm.pdf         an object stream and an xref stream; FTF{object_stream} is in the Info
//   pdf-encrypted-rc4.pdf  RC4 128-bit, empty user password; the page says FTF{rc4_encrypted}
//   pdf-encrypted-password.pdf  RC4 128-bit, user password "demo123"; the page says FTF{password_ok}
//   pdf-broken-xref.pdf    wrong xref offsets (FTF{rebuilt_xref}), a comment between objects and
//                          data after the last %%EOF (FTF{after_eof})
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
  const fx = await vite.ssrLoadModule('/src/tools/forensics/_pdf-fixtures.ts');
  for (const { name, bytes } of fx.buildSamples()) {
    if (bytes.length >= 16_000) throw new Error(`${name} is too big (${bytes.length} bytes)`);
    writeFileSync(outDir + name, bytes);
    console.log(`${name}: ${bytes.length} bytes`);
  }
} finally {
  await vite.close();
}
