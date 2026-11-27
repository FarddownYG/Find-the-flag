// Generates the variation-selector corpus. Usage: node bench/variation-selectors/gen.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'vite';

const ROOT = new URL('../../', import.meta.url).pathname;
const OUT = join(ROOT, 'bench/variation-selectors/corpus');

// [name, secret (manifest), base (visible cover), payload (defaults to secret)]
const CASES = [
  ['01-emoji', 'ftf_vs_1', '\u{1F600}'],
  ['02-letter', 'ftf_vs_2', 'A'],
  ['03-word', 'hidden under a word', 'hello'],
  ['04-sentence', 'ftf_vs_4', 'Nothing to see here, just a friendly greeting.'],
  ['05-long', 'ftf_the_quick_brown_fox_jumps_over_the_lazy_dog_1234567890', '\u{1F44D}'],
  ['06-low-bytes', 'ftf_vs_6', 'ok', 'ftf_vs_6\n\t\u0001\u000f'], // exercises the U+FE00 range
  ['07-punct', 'meet me at 9:30', 'Hi!'],
  ['08-short', 'ok', 'x'],
];

const vite = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent',
});
try {
  const { encodeVs, decodeVs } = await vite.ssrLoadModule('/bench/variation-selectors/encode.ts');
  mkdirSync(OUT, { recursive: true });
  const manifest = [];
  for (const [name, secret, base, payload = secret] of CASES) {
    const file = `${name}.txt`;
    const text = encodeVs(base, payload);
    const back = new TextDecoder().decode(decodeVs(text));
    if (back !== payload) throw new Error(`self-check failed for ${name}`);
    writeFileSync(join(OUT, file), text, 'utf8');
    manifest.push({ file, secret, base });
  }
  writeFileSync(join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(
    `wrote ${manifest.length} fixtures + manifest.json to bench/variation-selectors/corpus`,
  );
} finally {
  await vite.close();
}
