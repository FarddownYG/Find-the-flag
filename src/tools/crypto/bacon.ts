import { bool, defineTool, text, toggle } from '../../core/define';
import { ToolError } from '../../core/errors';
import { toolT } from '../../i18n/tool-text';
import { ALPHABET, flagForm, preview } from './_classical';
import { rankScore } from './_fitness';

const T = toolT('bacon');

export type BaconVariant = '24' | '26';

/** Classic 24-letter alphabet: I=J and U=V share a code. */
const ALPHABET_24 = 'ABCDEFGHIKLMNOPQRSTUWXYZ';

const alphabetOf = (variant: BaconVariant): string => (variant === '24' ? ALPHABET_24 : ALPHABET);

/** Turn a string of '0'/'1' (5 per letter) into letters; invalid codes become '?'. */
export function baconDecodeBits(bits: string, variant: BaconVariant): string {
  const abc = alphabetOf(variant);
  let out = '';
  for (let i = 0; i + 5 <= bits.length; i += 5) {
    out += abc[parseInt(bits.slice(i, i + 5), 2)] ?? '?';
  }
  return out;
}

/** Letters -> '0'/'1' string, 5 bits per letter (other characters are skipped). */
export function baconEncodeBits(plain: string, variant: BaconVariant): string {
  const abc = alphabetOf(variant);
  let bits = '';
  for (const ch of plain.toUpperCase()) {
    let c = ch;
    if (variant === '24') c = c === 'J' ? 'I' : c === 'V' ? 'U' : c;
    const i = abc.indexOf(c);
    if (i >= 0 && /[A-Z]/.test(c)) bits += i.toString(2).padStart(5, '0');
  }
  return bits;
}

/**
 * The Bacon symbol stream of a text and its (one or two) distinct symbols. Tries the text as
 * is, then without separators (/ | , ;), then without any punctuation, then ignoring case,
 * so "ABBAA, abbaa" and "AB/AB" both work.
 */
export function extractSymbols(input: string): { stream: string[]; symbols: string[] } {
  const attempts: ((s: string) => string)[] = [
    (t) => t.replace(/\s+/g, ''),
    (t) => t.replace(/[\s/|,;]+/g, ''),
    (t) => t.replace(/[^\p{L}\p{N}]+/gu, ''),
    (t) => t.replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase(),
  ];
  for (const prepare of attempts) {
    const stream = [...prepare(input)];
    const symbols = [...new Set(stream)].sort();
    if (symbols.length >= 1 && symbols.length <= 2) return { stream, symbols };
  }
  const seen = [...new Set(input.replace(/\s+/g, ''))].sort();
  throw new ToolError(
    T('error.symbols', {
      count: seen.length,
      symbols: `${seen.slice(0, 8).join(' ')}${seen.length > 8 ? ' …' : ''}`,
    }),
  );
}

interface Candidate {
  variant: BaconVariant;
  zero: string;
  one: string;
  text: string;
  score: number;
}

function decodeCandidates(
  stream: readonly string[],
  symbols: readonly string[],
  variants: BaconVariant[],
): Candidate[] {
  const [s0, s1] = symbols;
  const pairs: [string, string][] =
    s1 === undefined
      ? [
          [s0!, ''],
          ['', s0!],
        ]
      : [
          [s0!, s1],
          [s1, s0!],
        ];
  const chars = stream.slice(0, Math.floor(stream.length / 5) * 5);
  const out: Candidate[] = [];
  for (const variant of variants) {
    for (const [zero, one] of pairs) {
      const bits = chars.map((c) => (c === zero ? '0' : '1')).join('');
      const decoded = baconDecodeBits(bits, variant);
      out.push({ variant, zero, one, text: decoded, score: rankScore(decoded) });
    }
  }
  return out;
}

type Show = (symbol: string) => string;

function describe(
  best: Candidate,
  ranked: Candidate[],
  variant: BaconVariant,
  extra: string[],
  show: Show,
) {
  const sym = (s: string) => (s ? show(s) : '·');
  const other = ranked.find((c) => c.variant !== variant);
  const notes: { type: 'note'; level: 'info' | 'warn'; text: string }[] = extra.map((t) => ({
    type: 'note',
    level: 'warn',
    text: t,
  }));
  if (other && other.score > best.score + 15) {
    notes.push({
      type: 'note',
      level: 'info',
      text: T('note.otherVariant', { variant: other.variant, text: other.text }),
    });
  }
  const flag = flagForm(best.text);
  return [
    {
      type: 'text' as const,
      label: T('label.best', { variant: best.variant, a: sym(best.zero), b: sym(best.one) }),
      value: best.text,
    },
    ...(flag ? [{ type: 'text' as const, label: T('label.flag'), value: flag }] : []),
    {
      type: 'table' as const,
      label: T('label.readings'),
      columns: [T('col.alphabet'), 'A', 'B', T('col.score'), T('col.result')],
      rows: ranked.map((c) => [
        T('value.variant', { variant: c.variant }),
        sym(c.zero),
        sym(c.one),
        c.score.toFixed(1),
        preview(c.text, 80),
      ]),
      highlight: [Math.max(0, ranked.indexOf(best))],
    },
    ...notes,
  ];
}

export default defineTool({
  id: 'bacon',
  name: 'Bacon cipher',
  category: 'crypto',
  description:
    'Decode or encode Bacon’s two-symbol cipher (A/B, 0/1, or upper/lower case hidden in text).',
  tags: [
    'baconian',
    'francis bacon',
    'aabbb',
    'binary letters',
    '5-bit',
    'steganography',
    'ab cipher',
    'dcode',
  ],
  input: 'text',
  placeholder: 'AABAB ABABA AAAAA ABBAA …',
  options: {
    mode: toggle('Mode', [
      { value: 'decode', label: 'Decode' },
      { value: 'encode', label: 'Encode' },
      { value: 'case', label: 'Letter case' },
    ]),
    variant: toggle('Alphabet', [
      { value: '24', label: '24 letters (I=J, U=V)' },
      { value: '26', label: '26 letters' },
    ]),
    symbols: text('Symbols', 'AB', {
      placeholder: 'AB',
      showIf: (v) => v.mode === 'encode',
      hint: 'Two characters: the first stands for A, the second for B (e.g. 01)',
    }),
    grouped: bool('Space between letters', true, { showIf: (v) => v.mode === 'encode' }),
  },
  examples: [
    {
      label: 'Decode A/B groups',
      input: 'AABAB ABABA AAAAA AABBA AAAAB AAAAA AAABA ABBAB ABBAA ABAAA BAAAB AABAB BAABB ABBAA',
      expect: 'flag{baconisfun}',
    },
    {
      label: 'Decode binary (26 letters)',
      input: '00111 00100 01011 01011 01110',
      options: { variant: '26' },
      expect: 'HELLO',
    },
    {
      label: 'Encode',
      input: 'Hello',
      options: { mode: 'encode' },
      expect: 'AABBB AABAA ABABA ABABA ABBAB',
    },
    {
      label: 'Hidden in letter case',
      input: 'meEt Me At The old pieR After mIdnight anD brINg It HEre',
      options: { mode: 'case' },
      expect: 'flag{bacon',
    },
  ],
  detect({ text: t }) {
    const s = t?.replace(/\s+/g, '') ?? '';
    if (s.length < 15 || s.length % 5 !== 0 || !/^[AB]+$/i.test(s)) return null;
    return /^[AB]+$/.test(s) || /^[ab]+$/.test(s) ? { score: 0.8, reason: T('detect.ab') } : null;
  },
  run(input, { mode, variant, symbols, grouped }) {
    if (!input.trim()) throw new ToolError(T('error.empty'));

    if (mode === 'encode') {
      const syms = [...symbols];
      if (syms.length !== 2 || syms[0] === syms[1]) {
        throw new ToolError(T('error.symbolsOption'));
      }
      const bits = baconEncodeBits(input, variant);
      if (!bits) throw new ToolError(T('error.noLetters'));
      const skipped = [...input].filter((c) => /[^A-Za-z\s]/.test(c)).length;
      const mapped = [...bits].map((b) => (b === '0' ? syms[0]! : syms[1]!));
      const groups: string[] = [];
      for (let i = 0; i < mapped.length; i += 5) groups.push(mapped.slice(i, i + 5).join(''));
      return [
        { type: 'text', value: groups.join(grouped ? ' ' : '') },
        ...(skipped
          ? [
              {
                type: 'note' as const,
                level: 'info' as const,
                text: T('note.skipped', { count: skipped }),
              },
            ]
          : []),
      ];
    }

    const variants: BaconVariant[] = [variant, variant === '24' ? '26' : '24'];
    const rank = (list: Candidate[]) => list.sort((a, b) => b.score - a.score);

    if (mode === 'case') {
      const letters = [...input].filter((c) => /[A-Za-z]/.test(c));
      if (letters.length < 5) {
        throw new ToolError(T('error.fewLetters'));
      }
      const stream = letters.map((c) => (c === c.toUpperCase() ? 'U' : 'l'));
      const ranked = rank(decodeCandidates(stream, ['U', 'l'], variants));
      const best = ranked.find((c) => c.variant === variant)!;
      const leftover = letters.length % 5;
      return describe(
        best,
        ranked,
        variant,
        leftover ? [T('note.trailingLetters', { count: leftover })] : [],
        (s) => (s === 'l' ? T('value.lowercase') : T('value.uppercase')),
      );
    }

    const { stream, symbols: found } = extractSymbols(input);
    if (stream.length < 5) throw new ToolError(T('error.fewSymbols'));
    const ranked = rank(decodeCandidates(stream, found, variants));
    const best = ranked.find((c) => c.variant === variant)!;
    return describe(
      best,
      ranked,
      variant,
      stream.length % 5 ? [T('note.trailingSymbols', { count: stream.length % 5 })] : [],
      (s) => s,
    );
  },
});
