import { bool, defineTool, number, text, toggle } from '../../core/define';
import { ToolError } from '../../core/errors';
import { toolT } from '../../i18n/tool-text';
import {
  averageColumnIoc,
  chiSquaredCounts,
  kasiski,
  keyToString,
  letterIndex,
  letterLike,
  lettersOnly,
  minimalPeriod,
  mod,
  parseLetterKey,
  preview,
} from './_classical';
import { rankScore } from './_fitness';

const T = toolT('vigenere');

export type Variant = 'vigenere' | 'beaufort' | 'autokey';

/**
 * Vigenère family on the letters of `text`; case and every other character are kept.
 * - vigenere: C = P + K, P = C - K
 * - beaufort: C = K - P and P = K - C (the same operation both ways)
 * - autokey:  the key is the primer followed by the plaintext itself (letters only)
 * With `lettersOnly` the key moves on only when a letter is processed; without it, every
 * character (spaces, punctuation) consumes a key letter, as some older tools do.
 */
export function vigenereTransform(
  text: string,
  key: readonly number[],
  variant: Variant,
  decrypt: boolean,
  advanceOnLettersOnly = true,
): string {
  if (!key.length) throw new ToolError(T('error.emptyKey'));
  const stream = [...key]; // autokey: primer + plaintext so far
  let letterPos = 0;
  let pos = 0;
  let out = '';
  for (const ch of text) {
    const v = letterIndex(ch);
    if (v < 0) {
      out += ch;
      if (!advanceOnLettersOnly) pos++;
      continue;
    }
    let result: number;
    if (variant === 'autokey') {
      const k = stream[letterPos]!;
      result = decrypt ? mod(v - k, 26) : mod(v + k, 26);
      stream.push(decrypt ? result : v);
      letterPos++;
    } else {
      const k = key[(advanceOnLettersOnly ? letterPos : pos) % key.length]!;
      if (variant === 'beaufort') result = mod(k - v, 26);
      else result = decrypt ? mod(v - k, 26) : mod(v + k, 26);
      letterPos++;
      pos++;
    }
    out += letterLike(result, ch);
  }
  return out;
}

export interface CrackCandidate {
  length: number;
  key: string;
  ioc: number;
  score: number;
  text: string;
}

interface LetterSlots {
  values: number[];
  /** Key slot of each letter: letter order, or character position when the key skips nothing. */
  slots: number[];
}

function extractLetters(text: string, advanceOnLettersOnly: boolean): LetterSlots {
  const values: number[] = [];
  const slots: number[] = [];
  let pos = 0;
  for (const ch of text) {
    const v = letterIndex(ch);
    if (v >= 0) {
      values.push(v);
      slots.push(advanceOnLettersOnly ? values.length - 1 : pos);
    }
    pos++;
  }
  return { values, slots };
}

/** Best key letter for one column of a Vigenère / Beaufort cipher (chi-squared vs English). */
function bestShift(column: readonly number[], variant: 'vigenere' | 'beaufort'): number {
  if (!column.length) return 0;
  let best = 0;
  let bestChi = Infinity;
  for (let k = 0; k < 26; k++) {
    const counts = new Array<number>(26).fill(0);
    for (const c of column) counts[variant === 'beaufort' ? mod(k - c, 26) : mod(c - k, 26)]!++;
    const chi = chiSquaredCounts(counts);
    if (chi < bestChi) {
      bestChi = chi;
      best = k;
    }
  }
  return best;
}

/** Best primer letter for one autokey column (the plaintext chain depends on it). */
function bestPrimerLetter(column: readonly number[]): number {
  let best = 0;
  let bestChi = Infinity;
  for (let k = 0; k < 26; k++) {
    const counts = new Array<number>(26).fill(0);
    let prev = k;
    for (const c of column) {
      prev = mod(c - prev, 26);
      counts[prev]!++;
    }
    const chi = chiSquaredCounts(counts);
    if (chi < bestChi) {
      bestChi = chi;
      best = k;
    }
  }
  return best;
}

/**
 * Recover the key for every length 1..maxLen: split the letters into columns, pick the
 * best Caesar shift per column by chi-squared, then rank the full decryptions.
 */
export function crackVigenere(
  text: string,
  variant: Variant,
  maxLen: number,
  advanceOnLettersOnly = true,
): { candidates: CrackCandidate[]; limit: number } {
  const { values, slots } = extractLetters(text, variant === 'autokey' || advanceOnLettersOnly);
  const limit = Math.max(1, Math.min(maxLen, Math.floor(values.length / 3)));
  const seen = new Set<string>();
  const candidates: CrackCandidate[] = [];
  for (let len = 1; len <= limit; len++) {
    const columns: number[][] = Array.from({ length: len }, () => []);
    values.forEach((v, i) => columns[slots[i]! % len]!.push(v));
    let key = columns.map((col) =>
      variant === 'autokey' ? bestPrimerLetter(col) : bestShift(col, variant),
    );
    if (variant !== 'autokey') key = key.slice(0, minimalPeriod(key));
    const keyText = keyToString(key);
    if (seen.has(keyText)) continue;
    seen.add(keyText);
    const plain = vigenereTransform(text, key, variant, true, advanceOnLettersOnly);
    candidates.push({
      length: key.length,
      key: keyText,
      ioc: averageColumnIoc(values, len),
      score: rankScore(plain),
      text: plain,
    });
  }
  candidates.sort((a, b) => b.score - a.score || a.length - b.length);
  return { candidates, limit };
}

/** Display name of a variant (cipher names have their usual spelling in each language). */
const variantName = (variant: Variant): string =>
  ({
    vigenere: T('value.vigenere'),
    beaufort: T('value.beaufort'),
    autokey: T('value.autokey'),
  })[variant];

export default defineTool({
  id: 'vigenere',
  name: 'Vigenère / Beaufort / Autokey',
  category: 'crypto',
  description:
    'Decrypt, encrypt or crack polyalphabetic ciphers with a keyword (key length found for you).',
  tags: [
    'vigenere',
    'vigenère',
    'beaufort',
    'autokey',
    'polyalphabetic',
    'kasiski',
    'key length',
    'keyword cipher',
  ],
  input: 'text',
  placeholder: 'LXFOPVEFRNHR  (key: LEMON)',
  options: {
    mode: toggle('Mode', [
      { value: 'decrypt', label: 'Decrypt' },
      { value: 'encrypt', label: 'Encrypt' },
      { value: 'crack', label: 'Crack (no key)' },
    ]),
    variant: toggle('Variant', [
      { value: 'vigenere', label: 'Vigenère' },
      { value: 'beaufort', label: 'Beaufort' },
      { value: 'autokey', label: 'Autokey' },
    ]),
    key: text('Key', '', { placeholder: 'LEMON', showIf: (v) => v.mode !== 'crack' }),
    maxLen: number('Max key length', 20, {
      min: 1,
      max: 60,
      showIf: (v) => v.mode === 'crack',
      hint: 'Autokey: the primer length',
    }),
    lettersOnly: bool('Key advances on letters only', true, {
      showIf: (v) => v.variant !== 'autokey',
      hint: 'Off: spaces and punctuation also use up a key letter',
    }),
  },
  examples: [
    {
      label: 'Classic LEMON vector',
      input: 'LXFOPVEFRNHR',
      options: { key: 'LEMON' },
      expect: 'ATTACKATDAWN',
    },
    {
      label: 'Decrypt a flag',
      input: 'xpcx{zbyipvvx_figuw_t_cia}',
      options: { key: 'secret' },
      expect: 'flag{vigenere_needs_a_key}',
    },
    {
      label: 'Crack without the key',
      input:
        'Toikertppnkijrf, pop fefkz xuv cdtuvr rmgyopx rmem oafwdrt khz orp. Tci scab mf wlvk{xrsdwxz_wjyyu_bz_tefuy} ' +
        'eau io anj hdhveg dr ccadr fzgcx, ff kzic popv sielyrect xnslzw urnyc sfr olr eesx pyagpregz.',
      options: { mode: 'crack' },
      expect: 'Congratulations',
    },
    {
      label: 'Autokey (key KILT)',
      input: 'WMPMMXXAEYHBRYOCA',
      options: { variant: 'autokey', key: 'KILT' },
      expect: 'MEETATTHEFOUNTAIN',
    },
  ],
  run(input, { mode, variant, key, maxLen, lettersOnly: advance }) {
    if (!/[A-Za-z]/.test(input)) throw new ToolError(T('error.noLetters'));
    if (mode === 'crack') {
      const letters = lettersOnly(input);
      if (letters.length < 20) {
        throw new ToolError(T('error.tooShort', { count: letters.length }));
      }
      const { candidates, limit } = crackVigenere(input, variant, maxLen, advance);
      const best = candidates[0]!;
      const hint = kasiski(letters, limit).slice(0, 4);
      return [
        {
          type: 'text',
          label: T('label.best', {
            variant: variantName(variant),
            key: best.key,
            length: best.length,
          }),
          value: best.text,
        },
        {
          type: 'table',
          label: T('label.lengths', { max: limit }),
          columns: [T('col.length'), T('col.key'), T('col.ioc'), T('col.score'), T('col.result')],
          rows: candidates
            .slice(0, 12)
            .map((c) => [c.length, c.key, c.ioc.toFixed(3), c.score.toFixed(1), preview(c.text)]),
          highlight: [0],
        },
        {
          type: 'note',
          level: 'info',
          text: hint.length
            ? T('note.kasiski', {
                lengths: hint.map((h) => `${h.length} (${h.votes}×)`).join(', '),
              })
            : T('note.noKasiski'),
        },
      ];
    }
    const k = parseLetterKey(key, T('error.keyOrCrack'));
    return [
      { type: 'text', value: vigenereTransform(input, k, variant, mode === 'decrypt', advance) },
    ];
  },
});
