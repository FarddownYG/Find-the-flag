import { defineTool, text, toggle } from '../../core/define';
import { ToolError } from '../../core/errors';
import { ALPHABET, letterIndex, letterLike } from './_classical';
import { toCodes } from './_fitness';
import { solveCodes } from './_substitution';

const MIN_LETTERS = 15;

/**
 * Parse a substitution key into `cipherOf[plain]` (-1 = unknown).
 * Either a 26-letter cipher alphabet (plain A..Z -> the given letters; `_` or `?` for unknown)
 * or comma/space separated pairs plain=cipher such as `a=q, b=w`.
 */
export function parseSubstitutionKey(key: string): number[] {
  const trimmed = key.trim();
  if (!trimmed)
    throw new ToolError('Enter the key: a 26-letter cipher alphabet or pairs like a=q, b=w.');
  const cipherOf = new Array<number>(26).fill(-1);
  const plainOf = new Array<number>(26).fill(-1);
  const set = (p: number, c: number, shown: string) => {
    if (cipherOf[p] !== -1 && cipherOf[p] !== c) {
      throw new ToolError(
        `Plain letter ${ALPHABET[p]} is given two different cipher letters (${shown}).`,
      );
    }
    if (plainOf[c] !== -1 && plainOf[c] !== p) {
      throw new ToolError(
        `Cipher letter ${ALPHABET[c]} is used for two plain letters (${ALPHABET[plainOf[c]!]} and ${ALPHABET[p]}): a substitution maps each letter once.`,
      );
    }
    cipherOf[p] = c;
    plainOf[c] = p;
  };

  const compact = trimmed.replace(/[\s,;]+/g, '');
  if (compact.length === 26 && /^[A-Za-z_?.*-]+$/.test(compact) && !/[=:>]/.test(trimmed)) {
    [...compact].forEach((ch, p) => {
      const c = letterIndex(ch);
      if (c >= 0) set(p, c, `position ${p + 1}`);
    });
    return cipherOf;
  }

  const pairs = trimmed.split(/[\s,;]+/).filter(Boolean);
  for (const pair of pairs) {
    const m = /^([A-Za-z])\s*(?:=|:|->|>)\s*([A-Za-z])$/.exec(pair);
    if (!m) {
      throw new ToolError(
        `"${pair}" is not a valid pair. Use 26 letters for the whole cipher alphabet, or pairs like a=q, b=w (plain=cipher).`,
      );
    }
    set(letterIndex(m[1]!), letterIndex(m[2]!), pair);
  }
  return cipherOf;
}

/** Substitute the letters of `text` through `map` (source index -> destination index, -1 = unknown). */
function substitute(
  text: string,
  map: readonly number[],
  partial: 'decrypt' | 'encrypt' | null,
): string {
  let out = '';
  for (const ch of text) {
    const i = letterIndex(ch);
    if (i < 0) {
      out += ch;
      continue;
    }
    const d = map[i]!;
    if (partial === null) out += letterLike(d, ch);
    else if (d >= 0) out += String.fromCharCode((partial === 'decrypt' ? 97 : 65) + d);
    else out += String.fromCharCode((partial === 'decrypt' ? 65 : 97) + i);
  }
  return out;
}

export function substitutionApply(
  text: string,
  cipherOf: readonly number[],
  direction: 'decrypt' | 'encrypt',
): { text: string; mapped: number; unknown: number } {
  const mapped = cipherOf.filter((c) => c >= 0).length;
  let map: number[];
  if (direction === 'encrypt') {
    map = [...cipherOf];
  } else {
    map = new Array<number>(26).fill(-1);
    cipherOf.forEach((c, p) => {
      if (c >= 0) map[c] = p;
    });
  }
  let unknown = 0;
  for (const ch of text) {
    const i = letterIndex(ch);
    if (i >= 0 && map[i]! < 0) unknown++;
  }
  // Letters outside the key are shown in the opposite case so the gaps stand out.
  return { text: substitute(text, map, unknown ? direction : null), mapped, unknown };
}

const alphabetOf = (cipherOf: readonly number[]): string =>
  cipherOf.map((c) => (c >= 0 ? ALPHABET[c]! : '_')).join('');

export interface AutoSolution {
  text: string;
  /** cipherOf[plain] for letters that occur in the ciphertext, -1 otherwise. */
  cipherOf: number[];
  fitness: number;
  letters: number;
}

/** Break a monoalphabetic substitution cipher (English) with quadgram hill climbing. */
export function autoSolve(cipherText: string): AutoSolution {
  const codes = toCodes(cipherText);
  if (codes.length < MIN_LETTERS) {
    throw new ToolError(
      `Only ${codes.length} letters: a substitution cipher needs about 50-100 letters or more to be solved automatically. Use Key mode to test your own guesses.`,
    );
  }
  const solution = solveCodes(codes);
  const present = new Set(codes);
  const cipherOf = new Array<number>(26).fill(-1);
  solution.map.forEach((plain, cipher) => {
    if (present.has(cipher)) cipherOf[plain] = cipher;
  });
  const map = Array.from(solution.map);
  return {
    text: substitute(cipherText, map, null),
    cipherOf,
    fitness: solution.fitness,
    letters: solution.letters,
  };
}

export default defineTool({
  id: 'substitution',
  name: 'Substitution solver',
  category: 'crypto',
  description:
    'Solve a monoalphabetic substitution cipher automatically (English), or apply a key you know.',
  tags: [
    'monoalphabetic',
    'cryptogram',
    'quipqiup',
    'keyword cipher',
    'simple substitution',
    'hill climbing',
    'quadgram',
    'frequency analysis',
    'cipher alphabet',
  ],
  input: 'text',
  placeholder: 'Paste at least a few lines of ciphertext (50+ letters work best)…',
  options: {
    mode: toggle('Mode', [
      { value: 'solve', label: 'Auto-solve' },
      { value: 'key', label: 'Key' },
    ]),
    direction: toggle('Direction', ['decrypt', 'encrypt'], undefined, {
      showIf: (v) => v.mode === 'key',
    }),
    key: text('Key', '', {
      placeholder: 'QWERTYUIOPASDFGHJKLZXCVBNM  or  a=q, b=w',
      hint: 'Cipher alphabet below plain A..Z, or pairs plain=cipher. Use _ for unknown letters.',
      showIf: (v) => v.mode === 'key',
    }),
  },
  examples: [
    {
      label: 'Auto-solve a cryptogram',
      input:
        'eighynurfnukigo ig eyneakgh n orvoukurukig eksxmy zkuxiru agizkgh uxm amb. mcmyb fmuumy zno ' +
        'oznssmj wiy ngiuxmy, vru mghfkox fmncmo wkghmysykguo mcmybzxmym: uxm piou eippig fmuumyo, uxm ' +
        'fkuufm ziyjo, uxm jirvfmj eigoignguo. xkff efkpvkgh wirgj uxm amb wyip uxiom xkguo nfigm, ngj ' +
        'biry ymznyj ko wfnh{orvoukurukig_oifcmj_vb_xkff_efkpvkgh}. amms uxnu uykea xngjb wiy uxm gmqu ' +
        'srllfm.',
      expect: 'flag{substitution_solved_by_hill_climbing}',
    },
    {
      label: 'Apply a keyboard-order key',
      input: 'ysqu{atn_ztlz_ga}',
      options: { mode: 'key', key: 'QWERTYUIOPASDFGHJKLZXCVBNM' },
      expect: 'flag{key_test_ok}',
    },
    {
      label: 'Encrypt with a key',
      input: 'flag{encrypt_me}',
      options: { mode: 'key', direction: 'encrypt', key: 'QWERTYUIOPASDFGHJKLZXCVBNM' },
      expect: 'ysqu{tfeknhz_dt}',
    },
    {
      label: 'Partial key (pairs)',
      input: 'Xli Qymgo',
      options: { mode: 'key', key: 't=x, h=l, e=i' },
      expect: 'the QYMGO',
    },
  ],
  run(input, { mode, direction, key }) {
    if (!/[A-Za-z]/.test(input)) throw new ToolError('Paste some ciphertext with letters (A-Z).');
    if (mode === 'key') {
      const cipherOf = parseSubstitutionKey(key);
      const { text: out, mapped, unknown } = substitutionApply(input, cipherOf, direction);
      return [
        { type: 'text', value: out },
        {
          type: 'kv',
          label: 'Key',
          entries: [
            ['Plain alphabet', ALPHABET.toLowerCase()],
            ['Cipher alphabet', alphabetOf(cipherOf)],
          ],
        },
        ...(mapped < 26
          ? [
              {
                type: 'note' as const,
                level: 'info' as const,
                text:
                  `${mapped} of 26 letters are in the key.` +
                  (unknown
                    ? direction === 'decrypt'
                      ? ' lowercase = decrypted, UPPERCASE = not in the key yet.'
                      : ' UPPERCASE = encrypted, lowercase = not in the key.'
                    : ''),
              },
            ]
          : []),
      ];
    }
    const sol = autoSolve(input);
    const reliable = sol.letters >= 100 && sol.fitness > -5.4;
    return [
      { type: 'text', label: 'Best guess', value: sol.text },
      {
        type: 'kv',
        label: 'Recovered key',
        entries: [
          ['Plain alphabet', ALPHABET.toLowerCase()],
          ['Cipher alphabet', alphabetOf(sol.cipherOf)],
          ['Letters used', String(sol.letters)],
          ['Fit', `${sol.fitness.toFixed(2)} per quadgram (English text is about -4.3)`],
        ],
      },
      reliable
        ? {
            type: 'note',
            level: 'success',
            text: 'The result reads like English. Copy the cipher alphabet into Key mode to apply it elsewhere.',
          }
        : {
            type: 'note',
            level: 'warn',
            text:
              sol.letters < 100
                ? `Only ${sol.letters} letters: short ciphertexts have several plausible solutions and some letters may be wrong. Fix them with Key mode (pairs like a=q).`
                : 'The result does not read like English: the text may not be a simple substitution, or it is not English.',
          },
    ];
  },
});
