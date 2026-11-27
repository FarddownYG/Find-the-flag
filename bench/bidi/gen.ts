// Generates the Bidi-override corpus. Usage: node bench/bidi/gen.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { embed, lroRun, PDF, RLO, rloRun, visualRlo } from './encode.ts';

const OUT = fileURLToPath(new URL('./corpus/', import.meta.url));

// [name, secret (logical order), file content, description]
const CASES: [string, string, string, string][] = [
  [
    '01-inline-rlo',
    'ftf_bidi_1',
    embed('Please confirm the code: ', 'ftf_bidi_1', ' before Friday, thanks.'),
    'RLO..PDF inside a sentence',
  ],
  ['02-whole-line', 'ftf_bidi_2', `${rloRun('ftf_bidi_2')}\n`, 'entire file is one RLO run'],
  [
    '03-unclosed-rlo',
    'ftf_bidi_3',
    embed('Status report: all systems nominal. Token = ', 'ftf_bidi_3', '', false),
    'RLO never closed by PDF',
  ],
  [
    '04-source-trojan',
    'ftf_bidi_4',
    `const role = "user";\nif (role === "admin${RLO}" ${PDF}) {\n  // ${RLO}ftf_bidi_4${PDF}\n}\n`,
    'source-code style, RLO in a comment',
  ],
  [
    '05-lro-and-rlo',
    'ftf_bidi_5 [ok]',
    `Hello ${lroRun('world')} and ${rloRun('ftf_bidi_5 [ok]')} bye.`,
    'LRO run plus RLO run; secret in the RLO run',
  ],
  [
    '06-multiline',
    'meet at the old bridge 0930',
    `Note one: bring snacks.\n${rloRun('meet at the old bridge 0930')}\nNote three: bring water.\n`,
    'secret on its own line between cover lines',
  ],
];

mkdirSync(OUT, { recursive: true });
const manifest = CASES.map(([name, secret, content, note]) => {
  const file = `${name}.txt`;
  writeFileSync(`${OUT}${file}`, content, 'utf8');
  return { file, secret, visual: visualRlo(secret), note };
});
writeFileSync(`${OUT}manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`wrote ${manifest.length} fixtures to ${OUT}`);
