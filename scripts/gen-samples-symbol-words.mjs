// Deterministic sample for the "Symbol-word decoder" tool.
// Run: node scripts/gen-samples-symbol-words.mjs   (run it again: the bytes are identical)
//
//   symbol-words.txt   a short lorem-style text over 16 words; each word is one hex digit
//                      (alphabetical order of the vocabulary = digit 0..15), two words per byte.
//                      It decodes to a sentence containing the flag.
// Made-up flag FTF{symbol_words}, no real challenge file.
import { mkdirSync, writeFileSync } from 'node:fs';

const FLAG = 'FTF{symbol_words}';
// Clear text around the flag; it must use all 16 nibble values so the vocabulary has 16 words.
const MESSAGE = `the flag is ${FLAG} - the quick brown fox jumps over the lazy dog`;
// 16 distinct words, already in alphabetical order: index = hex digit.
const WORDS = [
  'amet',
  'bibendum',
  'commodo',
  'dolor',
  'elit',
  'fusce',
  'gravida',
  'habitant',
  'ipsum',
  'justo',
  'lectus',
  'magna',
  'nulla',
  'orci',
  'purus',
  'quam',
];
const used = new Set();
for (const b of new TextEncoder().encode(MESSAGE)) used.add(b >> 4).add(b & 15);
if (used.size !== 16) throw new Error('need all 16 nibble values, got ' + used.size);
if ([...WORDS].sort().join() !== WORDS.join()) throw new Error('vocabulary not sorted');

const words = [];
for (const b of new TextEncoder().encode(MESSAGE)) words.push(WORDS[b >> 4], WORDS[b & 15]);

// Wrap at 10 words per line, no punctuation (the tool keeps punctuation as part of a token).
const lines = [];
for (let i = 0; i < words.length; i += 10) lines.push(words.slice(i, i + 10).join(' '));

const OUT = new URL('../public/samples/', import.meta.url);
mkdirSync(OUT, { recursive: true });
writeFileSync(new URL('symbol-words.txt', OUT), lines.join('\n') + '\n');
console.log('wrote public/samples/symbol-words.txt');
