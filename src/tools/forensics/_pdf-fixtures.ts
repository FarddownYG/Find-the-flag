/**
 * The sample PDFs of the PDF analyzer, written by hand with the small writer of _pdf-kit.ts:
 * every object, xref table and trailer is spelled out here, none of it comes from the analyzer.
 * scripts/gen-samples-pdf.mjs writes them to public/samples/; the tests decode each one and check
 * that the files on disk are the ones built here.
 *
 *   pdf-revisions.pdf      two saves: the first page said FTF{old_revision}, the update replaced it
 *   pdf-embedded-js.pdf    an embedded file, JavaScript (harmless), a link and a form field
 *   pdf-invisible-text.pdf text that is drawn but cannot be seen, five different ways
 *   pdf-objstm.pdf         an object stream and an xref stream (the Info dictionary is packed)
 *   pdf-encrypted-rc4.pdf  RC4 128-bit, empty user password
 *   pdf-encrypted-password.pdf  RC4 128-bit, user password "demo123"
 *   pdf-broken-xref.pdf    wrong xref offsets, a comment between objects, data after %%EOF
 */
import { createHash } from 'node:crypto';
import { rc4 } from '../crypto/_rc4';
import { bytesOf, flate, join, pad10, PdfWriter, simpleDocument } from './_pdf-kit';

export interface PdfSample {
  name: string;
  bytes: Uint8Array;
}

const ID = '<00112233445566778899aabbccddeeff> <00112233445566778899aabbccddeeff>';

// ---------- two revisions ----------

export function buildRevisions(): Uint8Array {
  const w = simpleDocument('BT /F1 18 Tf 20 100 Td (FTF{old_revision}) Tj ET');
  w.object(6, '<< /Title (Quarterly report) /Author (Alice Example) /Producer (hand-made) >>');
  const first = w.xref([1, 2, 3, 4, 5, 6], `/Size 7 /Root 1 0 R /Info 6 0 R /ID [${ID}]`);
  // The update: a new content stream for the page and a new title; everything else stays.
  w.stream(4, '', 'BT /F1 18 Tf 20 100 Td (Nothing to see here) Tj ET');
  w.object(
    6,
    '<< /Title (Quarterly report - final) /Author (Alice Example) /Producer (hand-made) >>',
  );
  w.xref([4, 6], `/Size 7 /Root 1 0 R /Info 6 0 R /Prev ${first} /ID [${ID}]`, false);
  return w.bytes();
}

// ---------- embedded file, JavaScript, link, form ----------

export function buildEmbeddedJs(): Uint8Array {
  const note = 'FTF{embedded_file}\nThis note travels inside the PDF.\n';
  const w = new PdfWriter('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n');
  w.object(
    1,
    '<< /Type /Catalog /Pages 2 0 R /OpenAction 9 0 R ' +
      '/Names << /EmbeddedFiles << /Names [(hidden-note.txt) 7 0 R] >> /JavaScript << /Names [(boot) 11 0 R] >> >> ' +
      '/AcroForm << /Fields [10 0 R] /DA (/Helv 0 Tf 0 g) >> >>',
  );
  w.object(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  w.object(
    3,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Annots [10 0 R 12 0 R] ' +
      '/Resources << /Font << /F1 5 0 R >> >> >>',
  );
  w.stream(4, '', 'BT /F1 14 Tf 20 150 Td (An embedded file, JavaScript and a form) Tj ET');
  w.object(5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  w.object(
    7,
    '<< /Type /Filespec /F (hidden-note.txt) /UF (hidden-note.txt) /Desc (A note) /EF << /F 8 0 R /UF 8 0 R >> >>',
  );
  w.stream(
    8,
    `/Type /EmbeddedFile /Subtype /text#2Fplain /Filter /FlateDecode /Params << /Size ${note.length} /CreationDate (D:20250101000000Z) >>`,
    flate(note),
  );
  w.object(9, "<< /S /JavaScript /JS (app.alert\\('demo'\\);) >>");
  w.object(
    10,
    '<< /Type /Annot /Subtype /Widget /FT /Tx /T (note) /V (FTF{form_value}) /DV (default text) /Rect [20 20 200 40] /P 3 0 R /F 4 >>',
  );
  w.object(11, '<< /S /JavaScript /JS 13 0 R >>');
  w.object(
    12,
    '<< /Type /Annot /Subtype /Link /Rect [20 100 200 120] /Border [0 0 0] /A << /S /URI /URI (https://example.com/ftf-demo) >> >>',
  );
  w.stream(13, '/Filter /FlateDecode', flate("this.getField('note').value = 'demo';"));
  w.xref([1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12, 13], `/Size 14 /Root 1 0 R /ID [${ID}]`);
  return w.bytes();
}

// ---------- invisible text ----------

export function buildInvisibleText(): Uint8Array {
  const content = [
    'BT /F1 16 Tf 0 g 20 170 Td (Public page: nothing to see) Tj ET',
    // render mode 3: drawn with neither fill nor stroke
    'BT /F1 12 Tf 3 Tr 20 140 Td (FTF{invisible_text}) Tj ET',
    // white on the white page
    'BT /F1 12 Tf 0 Tr 1 g 20 120 Td (FTF{white_text}) Tj ET',
    // a font size nobody can read
    'BT /F1 0.8 Tf 0 g 20 100 Td (FTF{tiny_text}) Tj ET',
    // far below the page
    'BT /F1 12 Tf 0 g 20 -400 Td (FTF{offpage_text}) Tj ET',
    // a black box drawn on top: fake redaction
    'BT /F1 12 Tf 0 g 20 60 Td (FTF{covered_text}) Tj ET',
    '0 g 15 55 150 20 re f',
    'BT /F1 12 Tf 0 g 20 30 Td (The box above hides a line) Tj ET',
  ].join('\n');
  const w = simpleDocument(content);
  w.xref([1, 2, 3, 4, 5], `/Size 6 /Root 1 0 R /ID [${ID}]`);
  return w.bytes();
}

// ---------- object stream and xref stream ----------

/** PNG "Up" filter (predictor 12) applied to rows of `columns` bytes. */
function pngUp(data: Uint8Array, columns: number): Uint8Array {
  const rows = data.length / columns;
  const out = new Uint8Array(rows * (columns + 1));
  for (let r = 0; r < rows; r++) {
    out[r * (columns + 1)] = 2;
    for (let c = 0; c < columns; c++) {
      const above = r > 0 ? data[(r - 1) * columns + c]! : 0;
      out[r * (columns + 1) + 1 + c] = (data[r * columns + c]! - above) & 255;
    }
  }
  return out;
}

export function buildObjectStream(): Uint8Array {
  const w = new PdfWriter('%PDF-1.5\n%\xe2\xe3\xcf\xd3\n');
  // Objects 1, 2, 3, 6 and 7 live inside object stream 5; 4 (content) and 5 are plain.
  w.stream(
    4,
    '/Filter /FlateDecode',
    flate('BT /F1 14 Tf 20 100 Td (Packed objects and an xref stream) Tj ET'),
  );
  const packed = [
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
    [
      3,
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 6 0 R >> >> >>',
    ],
    [6, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'],
    [7, '<< /Title (Packed) /Secret (FTF{object_stream}) /Producer (hand-made) >>'],
  ] as const;
  let header = '';
  let body = '';
  for (const [num, text] of packed) {
    header += `${num} ${body.length} `;
    body += `${text}\n`;
  }
  const first = header.length;
  w.stream(
    5,
    `/Type /ObjStm /N ${packed.length} /First ${first} /Filter /FlateDecode`,
    flate(header + body),
  );
  // The xref stream (object 8): one 4-byte row per object, 0..8
  const at4 = w.offsets.get(4)!.offset;
  const at5 = w.offsets.get(5)!.offset;
  const at8 = w.length;
  const rows: [number, number, number][] = [
    [0, 0, 255],
    [2, 5, 0],
    [2, 5, 1],
    [2, 5, 2],
    [1, at4, 0],
    [1, at5, 0],
    [2, 5, 3],
    [2, 5, 4],
    [1, at8, 0],
  ];
  const table = new Uint8Array(rows.length * 4);
  rows.forEach(([type, f2, f3], i) => {
    table[i * 4] = type;
    table[i * 4 + 1] = (f2 >> 8) & 255;
    table[i * 4 + 2] = f2 & 255;
    table[i * 4 + 3] = f3 & 255;
  });
  w.stream(
    8,
    `/Type /XRef /Size 9 /W [1 2 1] /Root 1 0 R /Info 7 0 R /ID [${ID}] /Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 4 >>`,
    flate(pngUp(table, 4)),
  );
  w.raw(`startxref\n${at8}\n%%EOF\n`);
  return w.bytes();
}

// ---------- RC4 encryption ----------

const PAD = Uint8Array.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

const md5 = (...parts: Uint8Array[]): Uint8Array => {
  const h = createHash('md5');
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
};

function padded(pw: string): Uint8Array {
  const b = bytesOf(pw).subarray(0, 32);
  return join(b, PAD.subarray(0, 32 - b.length));
}

const hexOf = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** Standard security handler, V 2 R 3, 128-bit RC4 (ISO 32000-1, algorithms 2 to 5). */
function encryptedRc4(userPassword: string, pageText: string, title: string): Uint8Array {
  const id = Uint8Array.from({ length: 16 }, (_, i) => (i * 17 + 3) & 255);
  const permissions = -1340; // print and copy allowed, the rest not: only a number to display
  const le = Uint8Array.from([
    permissions & 255,
    (permissions >> 8) & 255,
    (permissions >> 16) & 255,
    (permissions >> 24) & 255,
  ]);
  // Algorithm 3: the owner entry from the owner password
  let ownerKey = md5(padded('owner-secret'));
  for (let i = 0; i < 50; i++) ownerKey = md5(ownerKey);
  ownerKey = ownerKey.subarray(0, 16);
  let o = rc4(ownerKey, padded(userPassword));
  for (let i = 1; i <= 19; i++)
    o = rc4(
      ownerKey.map((b) => b ^ i),
      o,
    );
  // Algorithm 2: the file key from the user password
  let key = md5(padded(userPassword), o, le, id);
  for (let i = 0; i < 50; i++) key = md5(key.subarray(0, 16));
  key = key.subarray(0, 16);
  // Algorithm 5: the user entry
  let u = rc4(key, md5(PAD, id));
  for (let i = 1; i <= 19; i++)
    u = rc4(
      key.map((b) => b ^ i),
      u,
    );
  const userEntry = join(u, new Uint8Array(16));

  const objectKey = (num: number) =>
    md5(key, Uint8Array.from([num & 255, (num >> 8) & 255, (num >> 16) & 255, 0, 0])).subarray(
      0,
      16,
    );
  const encrypt = (num: number, data: Uint8Array | string) =>
    rc4(objectKey(num), typeof data === 'string' ? bytesOf(data) : data);

  const w = new PdfWriter('%PDF-1.6\n%\xe2\xe3\xcf\xd3\n');
  w.object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  w.object(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  w.object(
    3,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
  );
  w.stream(4, '', encrypt(4, `BT /F1 18 Tf 20 100 Td (${pageText}) Tj ET`));
  w.object(5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  // Strings are encrypted too: the title is <hex> of the RC4 output
  w.object(6, `<< /Title <${hexOf(encrypt(6, title))}> >>`);
  w.object(
    7,
    `<< /Filter /Standard /V 2 /R 3 /Length 128 /P ${permissions} /O <${hexOf(o)}> /U <${hexOf(userEntry)}> >>`,
  );
  w.xref(
    [1, 2, 3, 4, 5, 6, 7],
    `/Size 8 /Root 1 0 R /Info 6 0 R /Encrypt 7 0 R /ID [<${hexOf(id)}> <${hexOf(id)}>]`,
  );
  return w.bytes();
}

// ---------- damaged xref, comment, trailing data ----------

export function buildBrokenXref(): Uint8Array {
  const w = new PdfWriter();
  w.object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  w.raw('% FTF{comment_between_objects}\n');
  w.object(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  w.object(
    3,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
  );
  w.stream(4, '/Filter /FlateDecode', flate('BT /F1 18 Tf 20 100 Td (FTF{rebuilt_xref}) Tj ET'));
  w.object(5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  // An xref table whose offsets are all off by 7: a reader that trusts it finds nothing.
  const at = w.length;
  let table = 'xref\n0 6\n0000000000 65535 f \n';
  for (let n = 1; n <= 5; n++) table += `${pad10(w.offsets.get(n)!.offset + 7)} 00000 n \n`;
  w.raw(`${table}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${at}\n%%EOF\n`);
  w.raw('FTF{after_eof}\n');
  return w.bytes();
}

/** RC4 128-bit with the empty user password. */
export const buildEncryptedRc4 = (): Uint8Array =>
  encryptedRc4('', 'FTF{rc4_encrypted}', 'Encrypted with an empty password');

/** RC4 128-bit; the user password is "demo123". */
export const buildEncryptedPassword = (): Uint8Array =>
  encryptedRc4('demo123', 'FTF{password_ok}', 'Locked with a user password');

export function buildSamples(): PdfSample[] {
  return [
    { name: 'pdf-revisions.pdf', bytes: buildRevisions() },
    { name: 'pdf-embedded-js.pdf', bytes: buildEmbeddedJs() },
    { name: 'pdf-invisible-text.pdf', bytes: buildInvisibleText() },
    { name: 'pdf-objstm.pdf', bytes: buildObjectStream() },
    { name: 'pdf-encrypted-rc4.pdf', bytes: buildEncryptedRc4() },
    { name: 'pdf-encrypted-password.pdf', bytes: buildEncryptedPassword() },
    { name: 'pdf-broken-xref.pdf', bytes: buildBrokenXref() },
  ];
}
