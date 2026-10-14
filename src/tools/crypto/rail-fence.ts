import { defineTool, number, toggle } from '../../core/define';
import { ToolError } from '../../core/errors';
import { preview } from './_classical';
import { rankScore } from './_fitness';

/** Rail (0-based) of every position of a zigzag with `rails` rails, starting `offset` steps in. */
function railPattern(length: number, rails: number, offset: number): number[] {
  const cycle = 2 * (rails - 1);
  return Array.from({ length }, (_, i) => {
    const pos = (i + offset) % cycle;
    return pos < rails ? pos : cycle - pos;
  });
}

/** Indices in reading order of the rails: rail 0 left to right, then rail 1, ... */
function railOrder(length: number, rails: number, offset: number): number[] {
  const pattern = railPattern(length, rails, offset);
  return pattern
    .map((rail, i) => ({ rail, i }))
    .sort((a, b) => a.rail - b.rail || a.i - b.i)
    .map((x) => x.i);
}

function checkParams(rails: number, offset: number): void {
  if (!Number.isInteger(rails) || rails < 2) {
    throw new ToolError('Rails must be a whole number of at least 2.');
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new ToolError('Offset must be a whole number of 0 or more.');
  }
}

export function railFenceEncrypt(text: string, rails: number, offset = 0): string {
  checkParams(rails, offset);
  const chars = [...text];
  if (rails >= chars.length) return text;
  return railOrder(chars.length, rails, offset)
    .map((i) => chars[i]!)
    .join('');
}

export function railFenceDecrypt(text: string, rails: number, offset = 0): string {
  checkParams(rails, offset);
  const chars = [...text];
  if (rails >= chars.length) return text;
  const out = new Array<string>(chars.length);
  railOrder(chars.length, rails, offset).forEach((target, k) => {
    out[target] = chars[k]!;
  });
  return out.join('');
}

export default defineTool({
  id: 'rail-fence',
  name: 'Rail fence',
  category: 'crypto',
  description: 'Zigzag transposition cipher. Brute-force mode tries every rail count and offset.',
  tags: ['zigzag', 'transposition', 'railfence', 'rail fence cipher', 'dcode'],
  input: 'text',
  placeholder: 'f{lncgtorlgri_ec_hne_h_re}aafeased',
  options: {
    mode: toggle('Mode', [
      { value: 'brute', label: 'Try all rails' },
      { value: 'decrypt', label: 'Decrypt' },
      { value: 'encrypt', label: 'Encrypt' },
    ]),
    rails: number('Rails', 3, { min: 2, max: 200, showIf: (v) => v.mode !== 'brute' }),
    offset: number('Offset', 0, {
      min: 0,
      max: 400,
      showIf: (v) => v.mode !== 'brute',
      hint: 'Start position inside the zigzag (0 = on the top rail)',
    }),
  },
  examples: [
    {
      label: 'Brute-force a flag',
      input: 'f{lncgtorlgri_ec_hne_h_re}aafeased',
      expect: 'flag{rail_fence_changes_the_order}',
    },
    {
      label: 'Decrypt with 3 rails',
      input: 'WECRLTEERDSOEEFEAOCAIVDEN',
      options: { mode: 'decrypt', rails: 3 },
      expect: 'WEAREDISCOVEREDFLEEATONCE',
    },
    {
      label: 'Encrypt with 4 rails',
      input: 'flag{zigzag}',
      options: { mode: 'encrypt', rails: 4 },
      expect: 'filzg}a{zgga',
    },
  ],
  run(text, { mode, rails, offset }) {
    if (mode === 'decrypt') return [{ type: 'text', value: railFenceDecrypt(text, rails, offset) }];
    if (mode === 'encrypt') return [{ type: 'text', value: railFenceEncrypt(text, rails, offset) }];
    const len = [...text].length;
    if (len < 4) throw new ToolError('Need at least 4 characters to brute-force a rail fence.');
    const rows: { rails: number; offset: number; out: string; score: number }[] = [];
    const seen = new Set<string>();
    const maxRails = Math.min(20, len);
    for (let r = 2; r <= maxRails; r++) {
      for (let o = 0; o < 2 * (r - 1); o++) {
        const out = railFenceDecrypt(text, r, o);
        if (seen.has(out)) continue; // as many rails as characters leaves the text unchanged
        seen.add(out);
        rows.push({ rails: r, offset: o, out, score: rankScore(out) });
      }
    }
    const ranked = rows.sort(
      (a, b) => b.score - a.score || a.rails - b.rails || a.offset - b.offset,
    );
    const best = ranked[0]!;
    return [
      {
        type: 'text',
        label: `Best guess · ${best.rails} rails, offset ${best.offset}`,
        value: best.out,
      },
      {
        type: 'table',
        label: `Rails 2–${maxRails} × every offset, most readable first (top 30 of ${ranked.length})`,
        columns: ['Rails', 'Offset', 'Score', 'Result'],
        rows: ranked
          .slice(0, 30)
          .map((r) => [r.rails, r.offset, r.score.toFixed(1), preview(r.out, 120)]),
        highlight: [0],
      },
    ];
  },
});
