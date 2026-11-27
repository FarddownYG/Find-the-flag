// Generates the zero-width binary corpus. Usage: node bench/zero-width/gen.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { encodeZeroWidth, type Options } from './encode.ts';

const OUT = fileURLToPath(new URL('./corpus/', import.meta.url));

const CASES: [string, string, string, Options][] = [
  [
    '01-after-plain',
    'ftf_zerowidth_1',
    'Hello there, I hope you are having a wonderful day and a great week ahead.',
    { placement: 'after' },
  ],
  [
    '02-after-separator',
    'ftf_zerowidth_2',
    'Reminder: the team meeting has moved to Thursday afternoon.',
    { placement: 'after', separator: true },
  ],
  [
    '03-before',
    'ftf_zerowidth_3',
    'Thanks so much for the kind words, talk soon!',
    { placement: 'before' },
  ],
  [
    '04-inside-word',
    'ftf_zerowidth_4',
    'The old library at the end of the street opens at nine every morning.',
    { placement: 'inside' },
  ],
  [
    '05-spread-chars',
    'ftf_zw_5',
    'The quick brown fox jumps over the lazy dog while the sun sets slowly behind the hills.',
    { placement: 'spread' },
  ],
  [
    '06-spread-separator',
    'ftf_zw_6',
    'The quick brown fox jumps over the lazy dog while the sun sets slowly behind the hills.',
    { placement: 'spread', separator: true },
  ],
  [
    '07-utf8-secret',
    'ftf_zerowidth_é7',
    'See you tomorrow, bring the notes.',
    { placement: 'after' },
  ],
  [
    '08-multiline',
    'meet me at 9:30 by the old bridge',
    'Line one of the note.\nLine two of the note.\nBye!',
    { placement: 'after', separator: true },
  ],
];

mkdirSync(OUT, { recursive: true });
const manifest = CASES.map(([name, secret, cover, opts]) => {
  const file = `${name}.txt`;
  writeFileSync(`${OUT}${file}`, encodeZeroWidth(cover, secret, opts), 'utf8');
  return { file, secret, cover };
});
writeFileSync(`${OUT}manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`wrote ${manifest.length} fixtures to ${OUT}`);
