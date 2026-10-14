import { defineTool, number, toggle } from '../../core/define';
import { plaintextScore } from '../../lib/english';

type Alphabet = 'letters' | 'rot47' | 'alnum';

/** Shift every character of the chosen alphabet by n; everything else is kept as-is. */
export function rotate(text: string, n: number, alphabet: Alphabet): string {
  let out = '';
  for (const ch of text) {
    const c = ch.charCodeAt(0);
    if (alphabet === 'rot47') {
      out += c >= 33 && c <= 126 ? String.fromCharCode(33 + ((((c - 33 + n) % 94) + 94) % 94)) : ch;
    } else if (c >= 65 && c <= 90) {
      out += String.fromCharCode(65 + ((((c - 65 + n) % 26) + 26) % 26));
    } else if (c >= 97 && c <= 122) {
      out += String.fromCharCode(97 + ((((c - 97 + n) % 26) + 26) % 26));
    } else if (alphabet === 'alnum' && c >= 48 && c <= 57) {
      out += String.fromCharCode(48 + ((((c - 48 + n) % 10) + 10) % 10));
    } else out += ch;
  }
  return out;
}

export default defineTool({
  id: 'caesar',
  name: 'ROT / Caesar',
  category: 'crypto',
  description: 'Shift letters by N (ROT13, ROT47, Caesar). Brute-force mode ranks every shift.',
  tags: ['rot13', 'rot47', 'rot', 'shift', 'cesar', 'césar'],
  input: 'text',
  placeholder: 'synt{ebg13_vf_abg_rapelcgvba}',
  options: {
    mode: toggle('Mode', [
      { value: 'brute', label: 'Try all shifts' },
      { value: 'shift', label: 'Fixed shift' },
    ]),
    alphabet: toggle('Alphabet', [
      { value: 'letters', label: 'A–Z' },
      { value: 'alnum', label: 'A–Z + 0–9' },
      { value: 'rot47', label: 'ROT47 (!–~)' },
    ]),
    shift: number('Shift', 13, { min: -93, max: 93, showIf: (v) => v.mode === 'shift' }),
  },
  examples: [
    {
      label: 'ROT13',
      input: 'synt{ebg13_vf_abg_rapelcgvba}',
      expect: 'flag{rot13_is_not_encryption}',
    },
    {
      label: 'ROT47',
      input: '7=28L#~%cf0>@C6N',
      options: { alphabet: 'rot47' },
      expect: 'flag{ROT47_more}',
    },
    {
      label: 'Caesar +3',
      input: 'iodj{fdhvdu}',
      options: { mode: 'shift', shift: -3 },
      expect: 'flag{caesar}',
    },
  ],
  run(text, { mode, alphabet, shift }) {
    if (mode === 'shift') return [{ type: 'text', value: rotate(text, shift, alphabet) }];
    const span = alphabet === 'rot47' ? 94 : 26;
    const rows = Array.from({ length: span - 1 }, (_, i) => {
      const n = i + 1;
      const out = rotate(text, n, alphabet);
      return { n, out, score: plaintextScore(out) };
    });
    const ranked = [...rows].sort((a, b) => b.score - a.score);
    const best = ranked[0]!;
    return [
      { type: 'text', label: `Best guess · shift ${best.n}`, value: best.out },
      {
        type: 'table',
        label: 'Every shift, most readable first',
        columns: ['Shift', 'Score', 'Result'],
        rows: ranked.map((r) => [r.n, r.score.toFixed(1), r.out]),
        highlight: [0],
      },
    ];
  },
});
