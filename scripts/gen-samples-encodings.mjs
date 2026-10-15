// Deterministic sample files for the encoding tools that read whole files or messages.
// Run: node scripts/gen-samples-encodings.mjs   (run it again: the bytes are identical)
//
//   quoted-printable-mail.eml  a made-up e-mail: an encoded-word subject (RFC 2047) and a
//                              quoted-printable body with soft line breaks, hiding FTF{qp_in_an_email}
//   uuencode-mail.txt          a made-up message with a 16 x 16 PNG (demo.png, an "F" on blue)
//                              attached the old Usenet way: begin 644 demo.png ... end
//
// The files are made with the tools' own encoders (loaded through Vite), so the samples and the
// tools cannot drift apart. Made-up messages and pictures, no real challenge file.
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { createServer } from 'vite';

const utf8 = (s) => new TextEncoder().encode(s);

/** A 16 x 16 RGB PNG: a white "F" on a blue background. */
function demoPng() {
  const F = [
    '................',
    '..############..',
    '..############..',
    '..##............',
    '..##............',
    '..##............',
    '..##............',
    '..########......',
    '..########......',
    '..##............',
    '..##............',
    '..##............',
    '..##............',
    '..##............',
    '..##............',
    '................',
  ];
  const raw = [];
  for (const row of F) {
    raw.push(0); // filter: none
    for (const px of row) raw.push(...(px === '#' ? [255, 255, 255] : [30, 80, 170]));
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const be32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const chunk = (type, data) => {
    const body = [...utf8(type), ...data];
    return [...be32(data.length), ...body, ...be32(crc(Uint8Array.from(body)))];
  };
  const ihdr = [...be32(16), ...be32(16), 8, 2, 0, 0, 0];
  const idat = [...deflateSync(Uint8Array.from(raw), { level: 9 })];
  return Uint8Array.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...chunk('IHDR', ihdr),
    ...chunk('IDAT', idat),
    ...chunk('IEND', []),
  ]);
}

const vite = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent',
});
const samples = {};
try {
  const qp = await vite.ssrLoadModule('/src/tools/encoding/quoted-printable.ts');
  const uu = await vite.ssrLoadModule('/src/tools/encoding/uuencode.ts');

  const subject = qp.encodeWords('Résumé du drapeau ✓', 'B', 'UTF-8', (ch) => utf8(ch));
  const body = [
    'Salut Bob,',
    '',
    'Voilà le drapeau que tu cherchais : FTF{qp_in_an_email} ',
    'Il se cache dans un message envoyé à la va-vite, avec des lignes trop longues coupées par des "soft line breaks" (le signe = en fin de ligne).',
    '',
    'À bientôt,',
    'Alice',
    '',
  ].join('\n');
  const head = [
    'From: Alice <alice@example.org>',
    'To: Bob <bob@example.org>',
    `Subject: ${subject}`,
    'Date: Mon, 07 Oct 2024 09:12:00 +0000',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="utf-8"',
    'Content-Transfer-Encoding: quoted-printable',
  ].join('\n');
  samples['quoted-printable-mail.eml'] = `${head}\n\n${qp.qpEncode(utf8(body), { eol: '\n' })}`;

  samples['uuencode-mail.txt'] = [
    'From: Mallory <mallory@example.org>',
    'To: Eve <eve@example.org>',
    'Subject: the picture you asked for',
    'Date: Tue, 08 Oct 2024 18:30:00 +0000',
    '',
    'Here is the file, uuencoded as in the old days of Usenet. Save everything',
    'from the "begin" line to the "end" line and run uudecode on it.',
    '',
    uu.uuEncode(demoPng(), { name: 'demo.png', mode: '644' }),
    '',
    '-- ',
    'sent from a made-up mailer',
    '',
  ].join('\n');
} finally {
  await vite.close();
}

const OUT = new URL('../public/samples/', import.meta.url);
mkdirSync(OUT, { recursive: true });
for (const [name, text] of Object.entries(samples)) {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length >= 100 * 1024) throw new Error(`${name} is ${bytes.length} bytes`);
  writeFileSync(new URL(name, OUT), bytes);
  console.log(`${name}: ${bytes.length} bytes, ${text.split('\n').length} lines`);
}
