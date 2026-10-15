// Deterministic sample pictures for the barcode reader.
// Run: node scripts/gen-samples-barcode.mjs   (run it again: the bytes are identical)
//
// The codes are drawn by the zxing-wasm writer (MIT; zxing-cpp is Apache-2.0), loaded through
// Vite from src/tools/stego/_barcode-fixtures.ts, which the unit tests use too. Every payload is
// made up. Grey 8-bit PNGs written with fast-png.
//
//   barcode-code128.png     Code 128, "FTF{code128_demo}"
//   barcode-ean13.png       EAN-13 2012345678903 (prefix 20 = in-store use; check digit 3 is
//                           computed, then read back from the picture) with its digits printed
//   barcode-datamatrix.png  Data Matrix, "FTF{datamatrix_demo}"
//   barcode-aztec.png       Aztec, "FTF{aztec_demo}"
//   barcode-pdf417.png      PDF417, "FTF{pdf417_demo}"
//   barcode-maxicode.png    MaxiCode, "FTF{maxicode_demo}"
//   barcode-two-codes.png   a Code 128 ("FTF{first_code}") and a QR code ("FTF{second_code}")
//                           on one grey page
//   barcode-hard.png        Code 128 "FTF{hard_to_read}" printed white on black, turned 20 degrees
//                           and speckled: the plain reader finds nothing, the helper passes do
import { mkdirSync, writeFileSync } from 'node:fs';
import { encode } from 'fast-png';
import { createServer } from 'vite';

const vite = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent',
});
const fx = await vite.ssrLoadModule('/src/tools/stego/_barcode-fixtures.ts');
const OUT = new URL('../public/samples/', import.meta.url);
mkdirSync(OUT, { recursive: true });

/** RGBA picture -> 8-bit grey PNG (the pictures here are grey already). */
function png(img) {
  const grey = new Uint8Array(img.width * img.height);
  for (let i = 0; i < grey.length; i++) grey[i] = img.data[i * 4];
  return encode({ width: img.width, height: img.height, data: grey, depth: 8, channels: 1 });
}
const write = (name, img) => {
  const bytes = png(img);
  if (bytes.length >= 40 * 1024) throw new Error(`${name} is ${bytes.length} bytes`);
  writeFileSync(new URL(name, OUT), bytes);
  console.log(`${name}: ${img.width}x${img.height}, ${bytes.length} bytes`);
};

write(
  'barcode-code128.png',
  await fx.makeBarcode('FTF{code128_demo}', { format: 'Code128', scale: 3 }),
);

// EAN-13: the writer takes the 12 digits and adds the check digit; make sure it is the right one.
const body = '201234567890';
write('barcode-ean13.png', await fx.makeBarcode(body, { format: 'EAN13', scale: 3, addHRT: true }));
console.log(`EAN-13 number: ${body}${fx.checkDigit(body)}`);

write(
  'barcode-datamatrix.png',
  await fx.makeBarcode('FTF{datamatrix_demo}', { format: 'DataMatrix', scale: 8 }),
);
write('barcode-aztec.png', await fx.makeBarcode('FTF{aztec_demo}', { format: 'Aztec', scale: 8 }));
write(
  'barcode-pdf417.png',
  await fx.makeBarcode('FTF{pdf417_demo}', { format: 'PDF417', scale: 3 }),
);
write(
  'barcode-maxicode.png',
  await fx.makeBarcode('FTF{maxicode_demo}', { format: 'MaxiCode', scale: 4 }),
);

// Two codes on one grey page.
{
  const a = await fx.makeBarcode('FTF{first_code}', { format: 'Code128', scale: 3 });
  const b = await fx.makeBarcode('FTF{second_code}', { format: 'QRCode', scale: 5 });
  const gap = 40;
  const w = Math.max(a.width, b.width) + 2 * gap;
  const h = a.height + b.height + 3 * gap;
  const page = fx.blank(w, h, 236);
  fx.paste(page, a, gap, gap);
  fx.paste(page, b, Math.round((w - b.width) / 2), 2 * gap + a.height);
  write('barcode-two-codes.png', page);
}

// White on black, turned 20 degrees, with speckle.
{
  const code = await fx.makeBarcode('FTF{hard_to_read}', { format: 'Code128', scale: 2 });
  const inverted = fx.invertImage(code);
  const turned = fx.turn(inverted, 20, 0);
  write('barcode-hard.png', fx.speckle(turned, 0.02, 20260));
}

await vite.close();
