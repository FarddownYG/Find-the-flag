// Generates the Unicode Tags corpus. Usage: node bench/unicode-tags/gen.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { encodeTags } from './encode.ts';

const OUT = fileURLToPath(new URL('./corpus/', import.meta.url));

const CASES: [string, string, string][] = [
  [
    '01-greeting',
    'ftf_unicodetags_1',
    'Hello there, I hope you are having a wonderful day and a great week ahead.',
  ],
  ['02-short', 'ftf_tags_2', 'See you tomorrow.'],
  [
    '03-meeting',
    'meet me at 9:30 by the old bridge',
    'Reminder: the team meeting has moved to Thursday afternoon, please check the calendar invite for details.',
  ],
  [
    '04-punctuation',
    'ftf_unicodetags_4 (flag) [ok]!',
    'Thanks so much for the kind words, they really made my day -- talk soon, friends & family!',
  ],
  [
    '05-long',
    'the quick brown fox jumps over the lazy dog 0123456789 ftf_unicodetags_5',
    'The old library at the end of the street opens at nine every morning. Inside, the shelves smell of paper and dust, and the reading room is always quiet.',
  ],
  ['06-newline-cover', 'ftf_unicodetags_6', 'Line one of the note.\nLine two of the note.\nBye!'],
];

mkdirSync(OUT, { recursive: true });
const manifest = CASES.map(([name, secret, cover]) => {
  const file = `${name}.txt`;
  writeFileSync(`${OUT}${file}`, encodeTags(cover, secret), 'utf8');
  return { file, secret, cover };
});
writeFileSync(`${OUT}manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`wrote ${manifest.length} fixtures to ${OUT}`);
