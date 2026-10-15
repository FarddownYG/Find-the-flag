import type { Output, ToolResult } from '../../core/types';
import { toHex, utf8Encode } from '../../lib/bytes';
import base64 from '../encoding/base64';
import hex from '../encoding/hex';
import adfgvx from './adfgvx';
import affine from './affine';
import atbash from './atbash';
import bacon from './bacon';
import bifid from './bifid';
import caesar from './caesar';
import columnar from './columnar';
import enigma from './enigma';
import hill from './hill';
import nihilist from './nihilist';
import playfair from './playfair';
import polybius from './polybius';
import railFence from './rail-fence';
import substitution from './substitution';
import vigenere from './vigenere';
import xor from './xor';

/**
 * Ciphertexts made with the project's own tools (their `run`, in encrypt mode), for the unit
 * tests of the cipher identifier and for its Try examples. Nothing here is a real challenge: the
 * plaintext is original prose and the keys are made up.
 */

/** What this file needs of a tool: its option defaults and its run (any tool fits). */
interface Runnable {
  options?: Record<string, { default: unknown }>;
  run: (input: never, options: never) => ToolResult | Promise<ToolResult>;
}

/** The options a tool starts with (the registry does the same, but importing it from here would loop). */
function defaults(tool: Runnable): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(tool.options ?? {})) out[key] = spec.default;
  return out;
}

async function run(
  tool: Runnable,
  input: unknown,
  options: Record<string, unknown>,
): Promise<ToolResult> {
  return tool.run(input as never, { ...defaults(tool), ...options } as never);
}

const firstText = (result: ToolResult): string => {
  const block = result.find((o): o is Extract<Output, { type: 'text' }> => o.type === 'text');
  if (!block) throw new Error('the tool returned no text');
  return block.value;
};

/** The ciphertext block of a tool that also prints its working (the one labelled "Ciphertext"). */
const cipherText = (result: ToolResult): string => {
  const labelled = result.find(
    (o): o is Extract<Output, { type: 'text' }> =>
      o.type === 'text' && /ciphertext|result/i.test(o.label ?? ''),
  );
  return labelled ? labelled.value : firstText(result);
};

/** Uppercase letters only, the first `count` of them. */
export function lettersOf(text: string, count = 300): string {
  return text
    .normalize('NFD')
    .replace(/[^A-Za-z]/g, '')
    .slice(0, count)
    .toUpperCase();
}

/** Blocks of five, the way ciphertexts are usually written down. */
export const inFives = (s: string): string => s.replace(/(.{5})(?=.)/g, '$1 ');

export type Kind =
  | 'caesar'
  | 'atbash'
  | 'affine'
  | 'substitution'
  | 'vigenere'
  | 'beaufort'
  | 'autokey'
  | 'columnar'
  | 'rail-fence'
  | 'playfair'
  | 'bifid'
  | 'adfgx'
  | 'adfgvx'
  | 'hill'
  | 'hill3'
  | 'polybius'
  | 'nihilist'
  | 'bacon'
  | 'enigma'
  | 'base64'
  | 'hex'
  | 'xor-hex';

/** A few made-up keys per cipher: variant i uses key i modulo the list. */
const KEYS = {
  caesar: [3, 7, 11, 19],
  vigenere: ['LEMON', 'CRYPT', 'FLAGS', 'MAPLE'],
  beaufort: ['LEMON', 'CRYPT'],
  autokey: ['KEYWORD', 'PRIMER'],
  columnar: ['ZEBRAS', 'CRYPTO', '3 1 4 2 5', 'MONARCHY'],
  railFence: [3, 4, 5, 6],
  playfair: ['playfair example', 'monarchy', 'cipher puzzle', 'wheatstone'],
  bifid: ['bgwkzqpndsioaxefclumthyvr', 'phqgmeaylnofdxkrcvszwbuti', 'keyword', 'delastelle'],
  adfgx: ['phqgmeaylnofdxkrcvszwbuti', 'ZEBRAS', 'cipher'],
  adfgvx: ['ph0qg64mea1yl2nofdxkr3cvs5zw7bj9uti8', 'zebras', 'cipher'],
  adfgxKeys: ['PRIVACY', 'GERMAN', 'ZEBRAS'],
  hill: ['DDCF', '5 8 17 3', '2 3 1 2', '7 8 11 11'],
  hill3: ['GYBNQKURP', '2 4 5 9 2 1 3 17 7', 'RRFVSVCCT'],
  affine: [
    [5, 8],
    [7, 3],
    [11, 6],
    [17, 20],
  ],
  nihilist: ['RUSSIAN', 'SECRET'],
  substitution: [
    'QWERTYUIOPASDFGHJKLZXCVBNM',
    'ZEBRASCDFGHIJKLMNOPQTUVWXY',
    'MNBVCXZLKJHGFDSAPOIUYTREWQ',
    'PHQGMEAYLNOFDXKRCVSZWBUTIJ',
  ],
  xor: ['secret', 'k3y', 'Flagger'],
} as const;

const pick = <T>(list: readonly T[], i: number): T => list[i % list.length]!;

/**
 * One ciphertext of `kind` for `plain` (any text: the letter ciphers read its letters), variant
 * `i` choosing the key. `layout` 'fives' writes the letters in blocks of five.
 */
export async function makeSample(
  kind: Kind,
  plain: string,
  variant = 0,
  layout: 'continuous' | 'fives' | 'natural' = 'continuous',
  count = 300,
): Promise<string> {
  const letters = lettersOf(plain, count);
  // Ciphers that keep the layout of the text work on the text as written when asked to.
  const text = layout === 'natural' ? plain.slice(0, Math.round(count * 1.15)) : letters;
  let out: string;
  switch (kind) {
    case 'caesar':
      out = firstText(
        await run(caesar, text, { mode: 'shift', shift: pick(KEYS.caesar, variant) }),
      );
      break;
    case 'atbash':
      out = firstText(await run(atbash, text, {}));
      break;
    case 'affine': {
      const [a, b] = pick(KEYS.affine, variant);
      out = firstText(await run(affine, text, { mode: 'encrypt', a, b }));
      break;
    }
    case 'substitution':
      out = firstText(
        await run(substitution, text, {
          mode: 'key',
          direction: 'encrypt',
          key: pick(KEYS.substitution, variant),
        }),
      );
      break;
    case 'vigenere':
    case 'beaufort':
    case 'autokey': {
      const key = pick(KEYS[kind], variant);
      out = firstText(await run(vigenere, text, { mode: 'encrypt', variant: kind, key }));
      break;
    }
    case 'columnar':
      out = cipherText(
        await run(columnar, letters, {
          method: 'columnar',
          mode: 'encrypt',
          key: pick(KEYS.columnar, variant),
        }),
      );
      break;
    case 'rail-fence':
      out = firstText(
        await run(railFence, letters, { mode: 'encrypt', rails: pick(KEYS.railFence, variant) }),
      );
      break;
    case 'playfair':
      out = cipherText(
        await run(playfair, letters, { mode: 'encrypt', key: pick(KEYS.playfair, variant) }),
      );
      break;
    case 'bifid':
      out = cipherText(
        await run(bifid, letters, {
          mode: 'encrypt',
          cipher: 'bifid',
          key: pick(KEYS.bifid, variant),
          period: variant % 2 === 0 ? 5 : 0,
        }),
      );
      break;
    case 'adfgx':
      out = firstText(
        await run(adfgvx, letters, {
          mode: 'encrypt',
          variant: 'adfgx',
          square: pick(KEYS.adfgx, variant),
          key: pick(KEYS.adfgxKeys, variant),
          group: false,
        }),
      );
      break;
    case 'adfgvx':
      out = firstText(
        await run(adfgvx, letters, {
          mode: 'encrypt',
          variant: 'adfgvx',
          square: pick(KEYS.adfgvx, variant),
          key: pick(KEYS.adfgxKeys, variant),
          group: false,
        }),
      );
      break;
    case 'hill':
      out = cipherText(
        await run(hill, letters, { mode: 'encrypt', key: pick(KEYS.hill, variant) }),
      );
      break;
    case 'hill3':
      out = cipherText(
        await run(hill, letters, { mode: 'encrypt', key: pick(KEYS.hill3, variant) }),
      );
      break;
    case 'polybius':
      out = firstText(
        await run(polybius, letters, {
          cipher: 'polybius',
          mode: 'encode',
          spaced: variant % 2 === 0,
        }),
      );
      break;
    case 'nihilist':
      out = firstText(
        await run(nihilist, letters, {
          method: 'numbers',
          mode: 'encrypt',
          key: pick(KEYS.nihilist, variant),
        }),
      );
      break;
    case 'bacon':
      out = firstText(
        await run(bacon, letters.slice(0, Math.min(80, count)), {
          mode: 'encode',
          symbols: variant % 2 === 0 ? 'AB' : '01',
        }),
      );
      break;
    case 'enigma':
      out = cipherText(await run(enigma, letters, {}));
      break;
    case 'base64':
      out = firstText(
        await run(base64, { bytes: utf8Encode(plain.slice(0, 220)) }, { mode: 'encode' }),
      );
      break;
    case 'hex':
      out = firstText(
        await run(hex, { bytes: utf8Encode(plain.slice(0, 160)) }, { mode: 'encode' }),
      );
      break;
    case 'xor-hex': {
      const result = await run(
        xor,
        { bytes: utf8Encode(plain.slice(0, 160)) },
        { mode: 'key', keyFormat: 'text', key: pick(KEYS.xor, variant) },
      );
      const block = result.find((o): o is Extract<Output, { type: 'bytes' }> => o.type === 'bytes');
      if (!block) throw new Error('XOR returned no bytes');
      out = toHex(block.value);
      break;
    }
  }
  if (layout === 'fives' && /^[A-Za-z]+$/.test(out)) return inFives(out.toUpperCase());
  return out.trim();
}

/**
 * The sample files of the cipher identifier's Try examples (public/samples/), made with the tools
 * themselves from original prose. scripts/gen-samples-cipher-identify.mjs writes them; the tests
 * rebuild them and compare, so the files and the tools cannot drift apart.
 */
export async function buildSamples(plain: string): Promise<Record<string, string>> {
  const files: [string, Kind, number, 'fives' | 'continuous'][] = [
    ['cipher-identify-caesar.txt', 'caesar', 2, 'fives'],
    ['cipher-identify-vigenere.txt', 'vigenere', 1, 'fives'],
    ['cipher-identify-playfair.txt', 'playfair', 1, 'fives'],
    ['cipher-identify-columnar.txt', 'columnar', 0, 'fives'],
    ['cipher-identify-adfgx.txt', 'adfgx', 0, 'fives'],
    ['cipher-identify-base64.txt', 'base64', 0, 'continuous'],
  ];
  const out: Record<string, string> = {};
  for (const [name, kind, variant, layout] of files) {
    out[name] = `${await makeSample(kind, plain, variant, layout)}\n`;
  }
  return out;
}
