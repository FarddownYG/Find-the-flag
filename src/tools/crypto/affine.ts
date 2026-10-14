import { defineTool, number, toggle } from '../../core/define';
import { ToolError } from '../../core/errors';
import { toolT } from '../../i18n/tool-text';
import { mod, preview } from './_classical';
import { rankScore } from './_fitness';

const T = toolT('affine');

/** The 12 multipliers that are coprime with 26 (the others are not invertible). */
export const VALID_A = [1, 3, 5, 7, 9, 11, 15, 17, 19, 21, 23, 25] as const;

const INVERSE: Record<number, number> = {
  1: 1,
  3: 9,
  5: 21,
  7: 15,
  9: 3,
  11: 19,
  15: 7,
  17: 23,
  19: 11,
  21: 5,
  23: 17,
  25: 25,
};

/** a must be coprime with 26 or the cipher cannot be decrypted. */
export function checkA(a: number): number {
  const m = mod(a, 26);
  if (!Number.isInteger(a) || INVERSE[m] === undefined) {
    throw new ToolError(T('error.invalidA', { a, values: VALID_A.join(', ') }));
  }
  return m;
}

/** Apply x -> (mul·x + add) mod 26 to the letters; case and other characters are kept. */
function mapLetters(text: string, mul: number, add: number): string {
  let out = '';
  for (const ch of text) {
    const c = ch.charCodeAt(0);
    if (c >= 65 && c <= 90) out += String.fromCharCode(65 + mod(mul * (c - 65) + add, 26));
    else if (c >= 97 && c <= 122) out += String.fromCharCode(97 + mod(mul * (c - 97) + add, 26));
    else out += ch;
  }
  return out;
}

export function affineEncrypt(text: string, a: number, b: number): string {
  return mapLetters(text, checkA(a), mod(b, 26));
}

export function affineDecrypt(text: string, a: number, b: number): string {
  const inv = INVERSE[checkA(a)]!;
  return mapLetters(text, inv, mod(-inv * b, 26));
}

export default defineTool({
  id: 'affine',
  name: 'Affine cipher',
  category: 'crypto',
  description: 'Affine cipher E(x) = a·x + b mod 26. Brute-force mode ranks all 312 keys.',
  tags: ['affine', 'a*x+b', 'monoalphabetic', 'linear cipher', 'decimation'],
  input: 'text',
  placeholder: 'IHHWVC SWFRCP',
  options: {
    mode: toggle('Mode', [
      { value: 'brute', label: 'Try all keys' },
      { value: 'decrypt', label: 'Decrypt' },
      { value: 'encrypt', label: 'Encrypt' },
    ]),
    a: number('a', 5, {
      min: 1,
      max: 25,
      showIf: (v) => v.mode !== 'brute',
      hint: 'coprime with 26',
    }),
    b: number('b', 8, { min: 0, max: 25, showIf: (v) => v.mode !== 'brute' }),
  },
  examples: [
    {
      label: 'Brute-force a flag',
      input: 'hlim{ihhwvc_swfrcp_wu_ua_lwvcip}',
      expect: 'flag{affine_cipher_is_so_linear}',
    },
    {
      label: 'Decrypt with a=5, b=8',
      input: 'IHHWVC SWFRCP',
      options: { mode: 'decrypt' },
      expect: 'AFFINE CIPHER',
    },
    {
      label: 'Encrypt with a=7, b=3',
      input: 'flag{affine}',
      options: { mode: 'encrypt', a: 7, b: 3 },
      expect: 'mcdt{dmmhqf}',
    },
  ],
  run(text, { mode, a, b }) {
    if (mode === 'decrypt') return [{ type: 'text', value: affineDecrypt(text, a, b) }];
    if (mode === 'encrypt') return [{ type: 'text', value: affineEncrypt(text, a, b) }];
    if (!/[A-Za-z]/.test(text)) throw new ToolError(T('error.noLetters'));
    const rows = VALID_A.flatMap((ka) =>
      Array.from({ length: 26 }, (_, kb) => {
        const out = affineDecrypt(text, ka, kb);
        return { a: ka, b: kb, out, score: rankScore(out) };
      }),
    );
    const ranked = rows.sort((x, y) => y.score - x.score || x.a - y.a || x.b - y.b);
    const best = ranked[0]!;
    return [
      { type: 'text', label: T('label.best', { a: best.a, b: best.b }), value: best.out },
      {
        type: 'table',
        label: T('label.all'),
        columns: ['a', 'b', T('col.score'), T('col.result')],
        rows: ranked.map((r) => [r.a, r.b, r.score.toFixed(1), preview(r.out, 100)]),
        highlight: [0],
      },
    ];
  },
});
