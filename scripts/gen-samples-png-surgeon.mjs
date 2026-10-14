// Generates the PNG chunk surgeon samples in public/samples/. Deterministic: run it again and
// the bytes are identical. Everything is synthetic: the pictures are drawn by our own bitmap
// font (src/tools/stego/_png-surgeon-fixtures.ts, loaded through Vite like the other TS-aware
// scripts) and encoded with fast-png + fflate. No real challenge file is ever used.
//
//   node scripts/gen-samples-png-surgeon.mjs
//
// Files:
//   png-shuffled-idat.png  320x120 "FTF CHUNK SURGEON / IDAT ORDER RESTORED"; its IDAT is cut
//                          into 11 chunks stored out of order, and a tEXt "order" chunk holds
//                          the sequence. Only the chunk→position reading of it inflates.
//   png-no-hint.png        the same kind of picture, 11 shuffled IDAT chunks and no hint: the
//                          order has to be searched.
//   png-broken.png         one wrong signature byte, the zlib header of the first IDAT zeroed,
//                          wrong CRCs on tEXt and on the third IDAT, the IHDR height halved
//                          (its CRC still matches the real 120) and a ZIP glued after IEND.
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
  const fx = await vite.ssrLoadModule('/src/tools/stego/_png-surgeon-fixtures.ts');
  const files = {
    'png-shuffled-idat.png': fx.buildShuffled(),
    'png-no-hint.png': fx.buildNoHint(),
    'png-broken.png': fx.buildBroken(),
  };
  for (const [name, bytes] of Object.entries(files)) {
    if (bytes.length >= 64_000) throw new Error(`${name} is too big (${bytes.length} bytes)`);
    writeFileSync(outDir + name, bytes);
    console.log(`${name}: ${bytes.length} bytes`);
  }
} finally {
  await vite.close();
}
