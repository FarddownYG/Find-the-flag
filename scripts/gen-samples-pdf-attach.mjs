// Generates public/samples/pdf-attachment-b64.pdf. Deterministic: run it again and the bytes are
// identical. Everything is made up: a tiny PNG whose tEXt chunk holds FTF{pdf_attached_b64}, which
// is base64-encoded (as text) and stored as an embedded file of a minimal hand-written PDF.
//
//   node scripts/gen-samples-pdf-attach.mjs
//
// Chain: PDF /EmbeddedFile (note.b64) -> base64 text -> PNG -> tEXt chunk -> the flag.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { encode as encodePng } from 'fast-png';

const outDir = fileURLToPath(new URL('../public/samples/', import.meta.url));
const FLAG = 'FTF{pdf_attached_b64}';

// 16x16 gradient PNG with the flag in a tEXt chunk.
const W = 16;
const data = new Uint8Array(W * W * 3);
for (let i = 0; i < W * W; i++) {
  data[i * 3] = (i % W) * 16;
  data[i * 3 + 1] = Math.floor(i / W) * 16;
  data[i * 3 + 2] = 128;
}
const png = encodePng({
  width: W,
  height: W,
  data,
  channels: 3,
  depth: 8,
  text: { Comment: FLAG },
});
const b64 =
  Buffer.from(png)
    .toString('base64')
    .replace(/(.{76})/g, '$1\n') + '\n';

const enc = new TextEncoder();
const parts = [];
let len = 0;
const push = (s) => {
  const b = typeof s === 'string' ? enc.encode(s) : s;
  parts.push(b);
  len += b.length;
};
const offsets = [];
const obj = (n, body) => {
  offsets[n] = len;
  push(`${n} 0 obj\n${body}\nendobj\n`);
};

push('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n');
obj(
  1,
  '<< /Type /Catalog /Pages 2 0 R /Names << /EmbeddedFiles << /Names [(note.b64) 5 0 R] >> >> >>',
);
obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
obj(
  3,
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>',
);
const content = 'BT /F1 14 Tf 20 100 Td (Nothing to see here.) Tj ET';
obj(4, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
obj(
  5,
  '<< /Type /Filespec /F (note.b64) /UF (note.b64) /Desc (notes) /EF << /F 6 0 R /UF 6 0 R >> >>',
);
offsets[6] = len;
push(
  `6 0 obj\n<< /Type /EmbeddedFile /Subtype /text#2Fplain /Length ${b64.length} /Params << /Size ${b64.length} >> >>\nstream\n${b64}endstream\nendobj\n`,
);

const xref = len;
let x = 'xref\n0 7\n0000000000 65535 f \n';
for (let n = 1; n <= 6; n++) x += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
push(x + `trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

const out = new Uint8Array(len);
let p = 0;
for (const b of parts) {
  out.set(b, p);
  p += b.length;
}
writeFileSync(outDir + 'pdf-attachment-b64.pdf', out);
console.log(`pdf-attachment-b64.pdf: ${out.length} bytes`);
