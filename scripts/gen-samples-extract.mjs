// Generates the sample of the "Universal extractor" tool in public/samples/. Deterministic: run it
// again and the bytes are identical. Everything in it is made up (a striped 32x32 PNG, a flag that
// only exists here); there is no real challenge file. Depends on fflate and fast-png only.
//
//   node scripts/gen-samples-extract.mjs
//
// Files:
//   extract-nested.zip   a ZIP (deflated entries) holding readme.txt and layers/pic.png.
//                        pic.png has a tEXt chunk "Comment" holding a Base64 text, and a gzip
//                        stream glued after IEND. Four levels down the flag appears:
//                        zip > pic.png > tEXt-Comment > Base64 > FTF{extract_unwraps_layers}
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { deflateSync, gzipSync, strToU8 } from 'fflate';
import { encode as encodePng } from 'fast-png';

const outDir = fileURLToPath(new URL('../public/samples/', import.meta.url));
mkdirSync(outDir, { recursive: true });

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes) => {
  let c = 0xffffffff;
  for (const x of bytes) c = (CRC_TABLE[(c ^ x) & 0xff] ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
};
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const le = (value, bytes) => {
  const out = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) out[i] = Math.floor(value / 2 ** (8 * i)) & 0xff;
  return out;
};
const be32 = (v) => Uint8Array.of((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);

const DOS_DATE = ((2024 - 1980) << 9) | (1 << 5) | 15; // 2024-01-15
const DOS_TIME = (12 << 11) | (30 << 5); // 12:30:00

/** entries: { name, data, method: 0 | 8 }. Fixed timestamps so the output is reproducible. */
function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = strToU8(e.name);
    const crc = crc32(e.data);
    const payload = e.method === 8 ? deflateSync(e.data, { level: 9 }) : e.data;
    const common = concat(
      le(0x0800, 2),
      le(e.method, 2),
      le(DOS_TIME, 2),
      le(DOS_DATE, 2),
      le(crc, 4),
      le(payload.length, 4),
      le(e.data.length, 4),
      le(name.length, 2),
    );
    const local = concat(le(0x04034b50, 4), le(20, 2), common, le(0, 2), name, payload);
    centrals.push(
      concat(
        le(0x02014b50, 4),
        le((3 << 8) | 20, 2),
        le(20, 2),
        common,
        le(0, 2),
        le(0, 2),
        le(0, 2),
        le(0, 2),
        le(0o100644 << 16, 4),
        le(offset, 4),
        name,
      ),
    );
    locals.push(local);
    offset += local.length;
  }
  const cd = concat(...centrals);
  const eocd = concat(
    le(0x06054b50, 4),
    le(0, 2),
    le(0, 2),
    le(entries.length, 2),
    le(entries.length, 2),
    le(cd.length, 4),
    le(offset, 4),
    le(0, 2),
  );
  return concat(...locals, cd, eocd);
}

const FLAG = 'FTF{extract_unwraps_layers}';

function picture() {
  const w = 32;
  const data = new Uint8Array(w * w * 3);
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 3;
      const band = Math.floor((x + y) / 4) % 3;
      data[o] = band === 0 ? 220 : 40;
      data[o + 1] = band === 1 ? 200 : 60;
      data[o + 2] = band === 2 ? 210 : 80;
    }
  }
  const png = encodePng({ width: w, height: w, data, channels: 3, depth: 8 });
  // A tEXt chunk with the Base64 of the flag, put right before IEND (the last 12 bytes).
  const body = concat(
    strToU8('Comment'),
    Uint8Array.of(0),
    strToU8(Buffer.from(FLAG).toString('base64')),
  );
  const type = strToU8('tEXt');
  const chunk = concat(be32(body.length), type, body, be32(crc32(concat(type, body))));
  const tail = gzipSync(strToU8('second drawer: look at the Comment chunk\n'), {
    level: 9,
    mtime: 0,
    filename: 'hint.txt',
  });
  return concat(png.subarray(0, png.length - 12), chunk, png.subarray(png.length - 12), tail);
}

const zip = buildZip([
  { name: 'readme.txt', data: strToU8('Keep digging.\n'), method: 8 },
  { name: 'layers/pic.png', data: picture(), method: 8 },
]);
writeFileSync(outDir + 'extract-nested.zip', zip);
console.log(`extract-nested.zip: ${zip.length} bytes`);
