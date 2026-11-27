import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { encodeLsbWav } from './encode.mjs';

const dir = fileURLToPath(new URL('./corpus/', import.meta.url));
mkdirSync(dir, { recursive: true });
const cases = [
  ['01-standard.wav', 16000, 'FTF{audio_lsb_silence_1}'],
  ['02-short.wav', 16000, 'FTF{abcd}'],
  ['03-long.wav', 96000, 'FTF{' + 'long_audio_flag-0123456789_'.repeat(8).slice(0, 200) + '}'],
  ['04-medium.wav', 40000, 'FTF{medium_wav_lsb_2}'],
  ['05-punct.wav', 24000, 'FTF{p4ss_w0rd!#$%&_z}'],
];
const manifest = [];
for (const [file, n, secret] of cases) {
  writeFileSync(dir + file, encodeLsbWav(n, secret));
  manifest.push({ file, secret });
}
writeFileSync(dir + 'manifest.json', JSON.stringify(manifest, null, 2) + '\n');
console.log(`wrote ${manifest.length} fixtures`);
