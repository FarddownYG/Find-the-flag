// Generates three CLEAN control files in public/samples/ with NOTHING hidden in them. They are the
// zero-false-positive controls: the analyzers must report nothing suspicious. Deterministic (fixed
// PRNG, no clock); everything is made up.
//
//   node scripts/gen-samples-clean.mjs
//
// Files:
//   clean-photo.jpg   64x48 baseline JPEG, smooth gradient, no EXIF, no trailing bytes
//   clean-doc.pdf     1 page, plain text, a single revision, no attachment / JavaScript / action
//   clean-video.mp4   ftyp + moov + mdat; EVERY mdat byte is addressed by stts/stsc/stsz/stco
//                     (the honest twin of the encrypted-video sample)
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';

const outDir = fileURLToPath(new URL('../public/samples/', import.meta.url));
mkdirSync(outDir, { recursive: true });

// --- JPEG -------------------------------------------------------------------------------------
{
  const W = 64;
  const H = 48;
  const data = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      data[o] = Math.round(40 + (x / (W - 1)) * 180);
      data[o + 1] = Math.round(90 + (y / (H - 1)) * 120);
      data[o + 2] = Math.round(200 - ((x + y) / (W + H - 2)) * 150);
      data[o + 3] = 255;
    }
  }
  const { data: out } = jpeg.encode({ data, width: W, height: H }, 85);
  writeFileSync(outDir + 'clean-photo.jpg', out);
}

// --- PDF --------------------------------------------------------------------------------------
{
  const stream =
    'BT /F1 18 Tf 72 700 Td (Quarterly notes) Tj ET\n' +
    'BT /F1 12 Tf 72 670 Td (Nothing to see here: a plain page with plain text.) Tj ET\n' +
    'BT /F1 12 Tf 72 650 Td (The meeting is moved to Thursday at ten.) Tj ET\n';
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((b, i) => {
    offs.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${b}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offs) pdf += `${String(o).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  writeFileSync(outDir + 'clean-doc.pdf', Buffer.from(pdf, 'latin1'));
}

// --- MP4 --------------------------------------------------------------------------------------
{
  const u32 = (n) => Uint8Array.of((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
  const u16 = (n) => Uint8Array.of((n >>> 8) & 255, n & 255);
  const cat = (...a) => {
    const out = new Uint8Array(a.reduce((s, x) => s + x.length, 0));
    let p = 0;
    for (const x of a) {
      out.set(x, p);
      p += x.length;
    }
    return out;
  };
  const str = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
  const box = (type, ...kids) => {
    const body = cat(...kids);
    return cat(u32(8 + body.length), str(type), body);
  };
  const full = (type, ver, flags, ...kids) =>
    box(type, Uint8Array.of(ver, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255), ...kids);
  const zeros = (n) => new Uint8Array(n);

  // Fixed PRNG (mulberry32) for the sample payload.
  let seed = 0x46544632;
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const N = 24;
  const sizes = Array.from({ length: N }, (_, i) => 300 + ((i * 37) % 11) * 20);
  const payload = new Uint8Array(sizes.reduce((a, b) => a + b, 0));
  for (let i = 0; i < payload.length; i++) payload[i] = Math.floor(rnd() * 256);

  const W = 64;
  const H = 48;
  const ftyp = box(
    'ftyp',
    str('isom'),
    u32(512),
    str('isom'),
    str('iso2'),
    str('avc1'),
    str('mp41'),
  );
  const mvhd = full(
    'mvhd',
    0,
    0,
    u32(0),
    u32(0),
    u32(1000),
    u32(N * 40),
    u32(0x00010000),
    u16(0x0100),
    zeros(10),
    u32(0x00010000),
    zeros(12),
    u32(0),
    u32(0x00010000),
    zeros(12),
    u32(0),
    u32(0x40000000),
    zeros(24),
    u32(2),
  );
  const tkhd = full(
    'tkhd',
    0,
    3,
    u32(0),
    u32(0),
    u32(1),
    u32(0),
    u32(N * 40),
    zeros(8),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    u32(0x00010000),
    zeros(12),
    u32(0),
    u32(0x00010000),
    zeros(12),
    u32(0),
    u32(0x40000000),
    u32(W << 16),
    u32(H << 16),
  );
  const mdhd = full('mdhd', 0, 0, u32(0), u32(0), u32(1000), u32(N * 40), u16(0x55c4), u16(0));
  const hdlr = full('hdlr', 0, 0, u32(0), str('vide'), zeros(12), str('VideoHandler\0'));
  const vmhd = full('vmhd', 0, 1, zeros(8));
  const dinf = box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1)));
  const avcC = box(
    'avcC',
    Uint8Array.of(1, 0x42, 0xc0, 0x1e, 0xff, 0xe1),
    u16(4),
    Uint8Array.of(0x67, 0x42, 0xc0, 0x1e),
    Uint8Array.of(1),
    u16(2),
    Uint8Array.of(0x68, 0xce),
  );
  const avc1 = box(
    'avc1',
    zeros(6),
    u16(1),
    zeros(16),
    u16(W),
    u16(H),
    u32(0x00480000),
    u32(0x00480000),
    u32(0),
    u16(1),
    zeros(32),
    u16(0x18),
    u16(0xffff),
    avcC,
  );
  const stsd = full('stsd', 0, 0, u32(1), avc1);
  const stts = full('stts', 0, 0, u32(1), u32(N), u32(40));
  const stsc = full('stsc', 0, 0, u32(1), u32(1), u32(N), u32(1)); // all samples in chunk 1
  const stsz = full('stsz', 0, 0, u32(0), u32(N), ...sizes.map(u32));
  const stcoFor = (off) => full('stco', 0, 0, u32(1), u32(off));
  const build = (off) =>
    box(
      'moov',
      mvhd,
      box(
        'trak',
        tkhd,
        box(
          'mdia',
          mdhd,
          hdlr,
          box('minf', vmhd, dinf, box('stbl', stsd, stts, stsc, stsz, stcoFor(off))),
        ),
      ),
    );
  const moovLen = build(0).length; // size does not depend on the offset value
  const mdatStart = ftyp.length + moovLen + 8;
  const mp4 = cat(ftyp, build(mdatStart), box('mdat', payload));
  writeFileSync(outDir + 'clean-video.mp4', mp4);
}
