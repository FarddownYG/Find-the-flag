import { bool, defineTool, number } from '../../core/define';
import { ToolError } from '../../core/errors';
import { chiSquared, indexOfCoincidence } from '../../lib/english';
import { ALPHABET, ENGLISH_FREQ, averageColumnIoc, letterCounts } from './_classical';

const ENGLISH_ORDER = 'ETAOINSHRDLCUMWFGYPBVKJXQZ';
const COMMON_BIGRAMS = 'TH HE IN ER AN RE ON AT EN ND TI ES OR TE OF ED IS IT AL AR ST TO NT NG';
const COMMON_TRIGRAMS = 'THE AND ING ENT ION HER FOR THA NTH INT ERE TIO VER EST';
const COMMON_DOUBLES = 'LL EE SS OO TT FF RR NN PP CC';

export interface FrequencyReport {
  letters: number;
  ioc: number;
  chi: number;
  verdict: { level: 'info' | 'warn' | 'success'; text: string };
  /** Smallest Vigenère key length whose columns look like single-alphabet English, if any. */
  keyLength: number | null;
}

/** Interpret the index of coincidence and chi-squared of a text. */
export function analyse(text: string): FrequencyReport {
  const values: number[] = [];
  for (const ch of text) {
    const c = ch.charCodeAt(0) | 0x20;
    if (c >= 97 && c <= 122) values.push(c - 97);
  }
  const n = values.length;
  const ioc = indexOfCoincidence(text);
  const chi = chiSquared(text);
  let keyLength: number | null = null;
  if (n >= 60 && ioc < 0.05) {
    const maxLen = Math.min(20, Math.floor(n / 6));
    const iocs: number[] = [];
    for (let len = 2; len <= maxLen; len++) iocs.push(averageColumnIoc(values, len));
    const top = Math.max(...iocs);
    if (top >= 0.052) keyLength = iocs.findIndex((v) => v >= top - 0.008) + 2;
  }
  const short = n < 40 ? ` Only ${n} letters: treat this as a hint, not a measurement.` : '';
  if (ioc >= 0.058) {
    if (chi < 45 || chi / n < 1.2) {
      return {
        letters: n,
        ioc,
        chi,
        keyLength,
        verdict: {
          level: 'success',
          text:
            'Verdict: IoC ≈ 0.066 and the letter frequencies already look like English. This is plain English or a ' +
            'transposition (rail fence, columnar, reverse): the letters are the right ones, only their order may be scrambled.' +
            short,
        },
      };
    }
    return {
      letters: n,
      ioc,
      chi,
      keyLength,
      verdict: {
        level: 'success',
        text:
          'Verdict: IoC ≈ 0.066 but the frequencies are not English. This is a monoalphabetic substitution ' +
          '(Caesar/ROT, Atbash, Affine or a general substitution): one cipher letter always stands for the same plain letter.' +
          short,
      },
    };
  }
  if (ioc >= 0.05) {
    return {
      letters: n,
      ioc,
      chi,
      keyLength,
      verdict: {
        level: 'info',
        text:
          'Verdict: IoC between English (0.066) and random (0.038). Could be a short or mixed-language text, ' +
          'or a polyalphabetic cipher with a very short key (2 or 3 letters).' +
          short,
      },
    };
  }
  if (ioc >= 0.034) {
    return {
      letters: n,
      ioc,
      chi,
      keyLength,
      verdict: {
        level: 'warn',
        text:
          'Verdict: IoC ≈ 0.038–0.047, a flat distribution. This is polyalphabetic (Vigenère-like: Vigenère, Beaufort, Autokey) ' +
          'or not English at all.' +
          (keyLength ? ` The columns look like English for a key length of ${keyLength}.` : '') +
          short,
      },
    };
  }
  return {
    letters: n,
    ioc,
    chi,
    keyLength,
    verdict: {
      level: 'warn',
      text:
        'Verdict: IoC is lower than random letters would give. This is probably not a letter cipher at all ' +
        '(try the encodings: Base64/32/58, hex), or the text is too short.' +
        short,
    },
  };
}

function topNgrams(words: string[], size: number, top: number): [string, number][] {
  const counts = new Map<string, number>();
  for (const w of words) {
    for (let i = 0; i + size <= w.length; i++) {
      const g = w.slice(i, i + size);
      counts.set(g, (counts.get(g) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, top);
}

function doubles(words: string[], top: number): [string, number][] {
  const counts = new Map<string, number>();
  for (const w of words) {
    for (let i = 0; i + 2 <= w.length; i++) {
      if (w[i] === w[i + 1])
        counts.set(w.slice(i, i + 2), (counts.get(w.slice(i, i + 2)) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, top);
}

export default defineTool({
  id: 'frequency',
  name: 'Frequency analysis',
  category: 'crypto',
  description:
    'Letter frequencies, index of coincidence and n-grams: tells you which classical cipher to try.',
  tags: [
    'letter frequency',
    'ioc',
    'index of coincidence',
    'chi squared',
    'bigram',
    'trigram',
    'histogram',
    'cryptanalysis',
    'counter',
  ],
  input: 'text',
  placeholder: 'Paste the ciphertext you are trying to identify…',
  options: {
    top: number('N-grams shown', 10, { min: 3, max: 50 }),
    across: bool('N-grams across spaces', false, {
      hint: 'Count pairs over the continuous letter stream (for ciphertext split in 5-letter groups)',
    }),
  },
  examples: [
    {
      label: 'Plain English',
      input:
        'The flag is hidden where nobody would think to look for it, and the players who read the ' +
        'challenge description carefully will find the first clue on the very first line.',
      expect: 'plain English or a transposition',
    },
    {
      label: 'ROT13 text (monoalphabetic)',
      input:
        'Gur synt vf uvqqra jurer abobql jbhyq guvax gb ybbx sbe vg, naq gur cynlref jub ernq gur ' +
        'punyyratr qrfpevcgvba pner shyyl jvyy svaq gur svefg pyhr ba gur irel svefg yvar.',
      expect: 'monoalphabetic substitution',
    },
    {
      label: 'Vigenère ciphertext',
      input:
        'Toikertppnkijrf, pop fefkz xuv cdtuvr rmgyopx rmem oafwdrt khz orp. Tci scab mf wlvk{xrsdwxz_wjyyu_bz_tefuy} ' +
        'eau io anj hdhveg dr ccadr fzgcx, ff kzic popv sielyrect xnslzw urnyc sfr olr eesx pyagpregz.',
      expect: 'polyalphabetic',
    },
  ],
  run(text, { top, across }) {
    const wordsRaw = text.toUpperCase().match(/[A-Z]+/g) ?? [];
    if (!wordsRaw.length) throw new ToolError('No letters found: paste some ciphertext (A-Z).');
    const words = across ? [wordsRaw.join('')] : wordsRaw;
    const counts = letterCounts(text);
    const total = counts.reduce((a, b) => a + b, 0);
    const report = analyse(text);

    const ranked = counts
      .map((count, i) => ({ letter: ALPHABET[i]!, count, expected: ENGLISH_FREQ[i]! }))
      .sort((a, b) => b.count - a.count || (a.letter < b.letter ? -1 : 1));
    const pct = (n: number) => ((n / total) * 100).toFixed(1);
    const ngramRows = (list: [string, number][], size: number) => {
      const all = Math.max(
        1,
        words.reduce((a, w) => a + Math.max(0, w.length - size + 1), 0),
      );
      return list.map(([g, c]) => [g, c, `${((c / all) * 100).toFixed(1)}%`]);
    };

    return [
      {
        type: 'note',
        level: report.verdict.level,
        text: report.verdict.text,
      },
      {
        type: 'kv',
        label: 'Summary',
        entries: [
          ['Letters', String(total)],
          ['Distinct letters', String(counts.filter((c) => c > 0).length)],
          ['Index of coincidence', `${report.ioc.toFixed(4)} (English 0.066, random 0.038)`],
          ['Chi-squared vs English', Number.isFinite(report.chi) ? report.chi.toFixed(1) : 'n/a'],
          ['Cipher order', ranked.map((r) => r.letter).join('')],
          ['English order', ENGLISH_ORDER],
          ...(report.keyLength
            ? ([['Likely key length', `${report.keyLength} (if Vigenère-like)`]] as [
                string,
                string,
              ][])
            : []),
        ],
      },
      {
        type: 'table',
        label: 'Letter frequencies',
        columns: ['Letter', 'Count', '%', 'English %', 'Δ'],
        rows: ranked.map((r) => {
          const p = (r.count / total) * 100;
          const d = p - r.expected;
          return [
            r.letter,
            r.count,
            pct(r.count),
            r.expected.toFixed(1),
            `${d >= 0 ? '+' : ''}${d.toFixed(1)}`,
          ];
        }),
      },
      {
        type: 'table',
        label: `Top bigrams (English: ${COMMON_BIGRAMS})`,
        columns: ['Bigram', 'Count', '%'],
        rows: ngramRows(topNgrams(words, 2, top), 2),
      },
      {
        type: 'table',
        label: `Top trigrams (English: ${COMMON_TRIGRAMS})`,
        columns: ['Trigram', 'Count', '%'],
        rows: ngramRows(topNgrams(words, 3, top), 3),
      },
      {
        type: 'table',
        label: `Doubled letters (English: ${COMMON_DOUBLES})`,
        columns: ['Pair', 'Count', '%'],
        rows: ngramRows(doubles(words, top), 2),
      },
    ];
  },
});
