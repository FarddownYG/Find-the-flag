// Deterministic sample files for the encoding tools that read whole files or messages.
// Run: node scripts/gen-samples-encodings.mjs   (run it again: the bytes are identical)
//
//   quoted-printable-mail.eml  a made-up e-mail: an encoded-word subject (RFC 2047) and a
//                              quoted-printable body with soft line breaks, hiding FTF{qp_in_an_email}
//
// The files are made with the tools' own encoders (loaded through Vite), so the samples and the
// tools cannot drift apart. Made-up messages, no real challenge file.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'vite';

const vite = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent',
});
const samples = {};
try {
  const qp = await vite.ssrLoadModule('/src/tools/encoding/quoted-printable.ts');
  const utf8 = (s) => new TextEncoder().encode(s);

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
