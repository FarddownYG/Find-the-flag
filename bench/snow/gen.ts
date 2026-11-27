// Generates the SNOW trailing-whitespace corpus. Usage: node bench/snow/gen.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { encodeSnow, type Options } from './encode.ts';

const OUT = fileURLToPath(new URL('./corpus/', import.meta.url));

const POEM = [
  'The morning light came over the hill,',
  'and the river was calm and the air was still.',
  'A small bird sang on the garden wall,',
  'while the old clock chimed in the hall.',
  'The baker opened his door at six,',
  'and the street smelled of bread and sticks.',
  'Children walked slowly to school,',
  'past the market, the church and the pool.',
  'By noon the sun was warm and high,',
  'and a few white clouds drifted by.',
  'The afternoon passed in a quiet way,',
  'and evening ended a gentle day.',
].join('\n');

const NOTE = [
  'Hi team,',
  'Please find the weekly summary below.',
  'The deployment went fine on Tuesday.',
  'We still need to review the backlog.',
  'Lunch is on Friday at noon.',
  'Thanks,',
  'Sam',
].join('\n');

const CASES: [string, string, string, Options][] = [
  ['01-groups3-poem', 'ftf_snow_1', POEM, { mode: 'groups3' }],
  ['02-groups3-note', 'ftf_snow_2', NOTE, { mode: 'groups3' }],
  ['03-groups3-width80', 'ftf_snow_3', POEM, { mode: 'groups3', width: 80, perLine: 99 }],
  ['04-groups3-crlf', 'ftf_snow_4', NOTE, { mode: 'groups3', eol: '\r\n' }],
  ['05-binary-poem', 'ftf_snow_5', POEM, { mode: 'binary' }],
  ['06-binary-byte-per-line', 'ftf_sn_6', POEM, { mode: 'binary', perLine: 8 }],
  ['07-groups3-no-final-eol', 'ftf_snow_7', NOTE, { mode: 'groups3', finalEol: false }],
  ['08-groups3-longer-secret', 'ftf_snow_secret_message_8', POEM, { mode: 'groups3' }],
];

mkdirSync(OUT, { recursive: true });
const manifest = CASES.map(([name, secret, cover, opts]) => {
  const file = `${name}.txt`;
  writeFileSync(`${OUT}${file}`, encodeSnow(cover, secret, opts), 'utf8');
  return { file, secret };
});
writeFileSync(`${OUT}manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`wrote ${manifest.length} fixtures to ${OUT}`);
