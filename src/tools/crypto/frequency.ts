import { bool, defineTool, number } from '../../core/define';
import { ToolError } from '../../core/errors';
import { registeredTools } from '../../core/tool-list';
import type { Output } from '../../core/types';
import { toolName, toolT } from '../../i18n/tool-text';
import { chiSquared, indexOfCoincidence } from '../../lib/english';
import { ALPHABET, ENGLISH_FREQ, averageColumnIoc, letterCounts } from './_classical';

const T = toolT('frequency');

/** Offer the cipher identifier for text with enough letters (the identifier links back here). */
function identifyLink(text: string, letters: number): Output[] {
  const tool =
    letters >= 20 ? registeredTools().find((t) => t.id === 'cipher-identify') : undefined;
  return tool
    ? [
        {
          type: 'actions',
          actions: [
            {
              label: T('open', { tool: toolName(tool) }),
              options: {},
              open: { tool: tool.id, text },
            },
          ],
        },
      ]
    : [];
}

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
  // Appended sentences carry their own leading separator (none in Chinese).
  const short = n < 40 ? T('verdict.short', { count: n }) : '';
  if (ioc >= 0.058) {
    if (chi < 45 || chi / n < 1.2) {
      return {
        letters: n,
        ioc,
        chi,
        keyLength,
        verdict: {
          level: 'success',
          text: T('verdict.plain') + short,
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
        text: T('verdict.mono') + short,
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
        text: T('verdict.between') + short,
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
          T('verdict.poly') +
          (keyLength ? T('verdict.keyLength', { length: keyLength }) : '') +
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
      text: T('verdict.random') + short,
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
    if (!wordsRaw.length) throw new ToolError(T('error.noLetters'));
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
        label: T('label.summary'),
        entries: [
          [T('kv.letters'), String(total)],
          [T('kv.distinct'), String(counts.filter((c) => c > 0).length)],
          [T('kv.ioc'), T('value.ioc', { ioc: report.ioc.toFixed(4) })],
          [T('kv.chi'), Number.isFinite(report.chi) ? report.chi.toFixed(1) : T('value.na')],
          [T('kv.cipherOrder'), ranked.map((r) => r.letter).join('')],
          [T('kv.englishOrder'), ENGLISH_ORDER],
          ...(report.keyLength
            ? ([[T('kv.keyLength'), T('value.keyLength', { length: report.keyLength })]] as [
                string,
                string,
              ][])
            : []),
        ],
      },
      {
        type: 'table',
        label: T('label.letters'),
        columns: [T('col.letter'), T('col.count'), '%', T('col.englishPct'), 'Δ'],
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
        label: T('label.bigrams', { list: COMMON_BIGRAMS }),
        columns: [T('col.bigram'), T('col.count'), '%'],
        rows: ngramRows(topNgrams(words, 2, top), 2),
      },
      {
        type: 'table',
        label: T('label.trigrams', { list: COMMON_TRIGRAMS }),
        columns: [T('col.trigram'), T('col.count'), '%'],
        rows: ngramRows(topNgrams(words, 3, top), 3),
      },
      {
        type: 'table',
        label: T('label.doubles', { list: COMMON_DOUBLES }),
        columns: [T('col.pair'), T('col.count'), '%'],
        rows: ngramRows(doubles(words, top), 2),
      },
      ...identifyLink(text, total),
    ];
  },
});
