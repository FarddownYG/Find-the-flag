// Synthetic samples for the "Complete image analysis" tool. Deterministic: run it again and the
// bytes are identical. The pictures are drawn by src/tools/stego/_image-lab-fixtures.ts (loaded
// through Vite like the other TS-aware scripts); nothing here is a real photo or a real challenge.
//
//   node scripts/gen-samples-image-lab.mjs
//
// Files:
//   image-lab-bit0-text.png  256x100 noisy scene; the text "FTF 2026" is written into bit 0 of blue
//   image-lab-near-bg.png    256x100 flat 200,200,200 with the text in 200,200,201
//   image-lab-ihdr.png       the bit-0 picture with its IHDR height lowered to 40 (CRC untouched)
//   image-lab-loaded.png     160x120 PNG with an eXIf comment, a tEXt chunk, an LSB message
//                            (b1, rgb, lsb first) and a ZIP glued after IEND
//   image-lab-clean.png      240x160 noisy scene with nothing hidden
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
  const fx = await vite.ssrLoadModule('/src/tools/stego/_image-lab-fixtures.ts');
  const files = {
    'image-lab-bit0-text.png': fx.pngBytes(fx.bit0Text()),
    'image-lab-near-bg.png': fx.pngBytes(fx.nearBackground()),
    'image-lab-ihdr.png': fx.falsifiedHeight().png,
    'image-lab-loaded.png': fx.loaded(),
    'image-lab-clean.png': fx.pngBytes(fx.cleanPhoto()),
  };
  for (const [name, bytes] of Object.entries(files)) {
    writeFileSync(outDir + name, bytes);
    console.log(`${name}: ${bytes.length} bytes`);
  }
} finally {
  await vite.close();
}
