// Generates the Binary analyzer samples in public/samples/. Deterministic: run it again and the
// bytes are identical. Everything is synthetic, written by our own writers
// (src/tools/forensics/_disk-fixtures.ts, loaded through Vite like the other TS-aware
// scripts) plus fast-png / fflate. No real challenge file is ever used.
//
//   node scripts/gen-samples-binary.mjs
//
// Files:
//   binary-hidden.bin     96 KiB of pseudo-random bytes hiding a PNG (0x3000), a flag-like text
//                         (0x6000), UTF-16LE text (0x6800) and a ZIP with note.txt (0x9000)
//   disk-ftf.iso          ISO 9660, 2048-byte sectors, with Joliet: /README.TXT,
//                         /DOCS/HELLO.TXT, /DOCS/notes about the disk.txt, /HIDDEN.TXT (hidden)
//   disk-ftf-raw.bin      the same volume as raw 2352-byte Mode 1 sectors (sync, header, real
//                         EDC; the ECC parity bytes are left at zero) — a BIN without its CUE
//   disk-ftf-fat12.img    FAT12 with /NOTE.TXT, /DOCS/ (a subdirectory with a long file name)
//                         and a DELETED /old-secret.txt whose clusters are still intact
//   binary-raster.bin     64 × 48 float32 little-endian raster (one NaN) …
//   binary-raster.hdr     … and its ENVI header
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
  const fx = await vite.ssrLoadModule('/src/tools/forensics/_disk-fixtures.ts');
  const iso = fx.buildSampleIso();
  const raster = fx.buildRaster();
  const files = {
    'binary-hidden.bin': fx.buildHiddenBin(),
    'disk-ftf.iso': iso,
    'disk-ftf-raw.bin': fx.cookedToRaw(iso),
    'disk-ftf-fat12.img': fx.buildSampleFat(),
    'binary-raster.bin': raster.data,
    'binary-raster.hdr': new TextEncoder().encode(raster.hdr),
  };
  for (const [name, bytes] of Object.entries(files)) {
    if (bytes.length >= 200_000) throw new Error(`${name} is too big (${bytes.length} bytes)`);
    writeFileSync(outDir + name, bytes);
    console.log(`${name}: ${bytes.length} bytes`);
  }
} finally {
  await vite.close();
}
