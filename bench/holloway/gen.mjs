// Generates the Holloway homoglyph corpus. Usage: node bench/holloway/gen.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'vite';

const ROOT = new URL('../../', import.meta.url).pathname;
const OUT = join(ROOT, 'bench/holloway/corpus');

const PARA =
  'The old library at the end of the street opens at nine every morning. Inside, the shelves smell of paper ' +
  'and dust, and the reading room is always quiet. People come to borrow novels, to study for exams, or just ' +
  'to sit by the window and watch the rain run down the glass. Nobody hurries here, and that is exactly why ' +
  'so many of us keep coming back.';

const CASES = [
  [
    '01-tweet-weather',
    'ftf_homoglyph_1',
    'Just landed in town and the weather is lovely, so I am heading out for a long walk by the river!',
  ],
  ['02-paragraph', 'secret message', PARA],
  [
    '03-multispace',
    'hidden in plain sight',
    'Meeting  notes:   we   talked   about   the   roadmap,  the   budget,  and   the   next   release   date   for   the   team.   Nothing   else   to   report   today.',
  ],
  [
    '04-punctuation',
    'meet me at 9:30',
    'Wow -- (really?) it\'s "amazing" [and] #blessed; see you soon, friends & family! Thanks for all the love, the support, and the kind words today.',
  ],
  [
    '05-flag-url',
    'ftf_stego-2',
    'New post is up on the blog today, read it when you have a minute and tell me what you think about the ending, I would love to hear your honest opinion.',
  ],
  ['06-short-tweet', 'ok', 'Coffee first, then everything else.'],
  [
    '07-lines',
    'two lines of cover',
    'Line one of the cover text goes here with a few words.\nLine two follows right after, also with plenty of ordinary words in it.\n\nLast line, after a blank one, closes the note.',
  ],
  [
    '08-numbers',
    'a.b/c%d_e-f?g',
    'Order 4521 shipped on 2026-03-14 to 12 Baker Street, flat 7. Expect delivery between 10 and 12, and call 555-0142 if the courier is late.',
  ],
  ['09-long-flag', 'ftf_the_quick_brown_fox_jumps_over_the_lazy_dog_1234567890', PARA + ' ' + PARA],
];

const vite = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent',
});
try {
  const { encodeHolloway } = await vite.ssrLoadModule('/bench/holloway/encode.ts');
  mkdirSync(OUT, { recursive: true });
  const manifest = [];
  for (const [name, secret, cover] of CASES) {
    const file = `${name}.txt`;
    writeFileSync(join(OUT, file), encodeHolloway(cover, secret), 'utf8');
    manifest.push({ file, secret, cover });
  }
  writeFileSync(join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`wrote ${manifest.length} fixtures + manifest.json to bench/holloway/corpus`);
} finally {
  await vite.close();
}
