import { bool, defineTool, select, text } from '../../core/define';
import { registeredTools } from '../../core/tool-list';
import type { Output } from '../../core/types';
import { toolName, toolT } from '../../i18n/tool-text';
import {
  type BaseInfo,
  baseInfo,
  blendScore,
  decodeBytes,
  latin1,
  orderingMap,
  printScore,
  type Reading,
  solve,
  tokenize,
  type Vocab,
} from './_symbol-words';

const T = toolT('symbol-words');

const KIND_KEY: Record<BaseInfo['kind'], string> = {
  binary: 'base.binary',
  quaternary: 'base.quaternary',
  octal: 'base.octal',
  hex: 'base.hex',
  base32: 'base.base32',
  base64: 'base.base64',
  other: 'base.other',
};

const MAX_VOCAB_ROWS = 300;
const MAX_TEXT = 20_000;
const show = (s: string) => s.replace(/[^\x20-\x7e]/g, '·');

/** Parse the "token=digit token=digit" lock option into token→digit, ignoring unknown tokens. */
function parseLocks(spec: string, vocab: Vocab, n: number): Map<number, number> {
  const idOf = new Map(vocab.distinct.map((t, i) => [t, i]));
  const locked = new Map<number, number>();
  const seen = new Set<number>();
  for (const part of spec.trim().split(/\s+/).filter(Boolean)) {
    const eq = part.lastIndexOf('=');
    if (eq <= 0) continue;
    const tok = part.slice(0, eq);
    const d = Number(part.slice(eq + 1));
    const id = idOf.get(tok);
    if (id === undefined || !Number.isInteger(d) || d < 0 || d >= n || seen.has(d)) continue;
    locked.set(id, d);
    seen.add(d);
  }
  return locked;
}

interface Candidate {
  name: string;
  label: string;
  value: number[];
  bytes: Uint8Array;
  score: number;
}

/** Downstream tools the decoded bytes often feed into: a base64 or hex blob to decode next. */
function nextSteps(textOut: string): Output[] {
  const tools = registeredTools();
  const out: Output[] = [];
  const add = (id: string, blob: string) => {
    const tool = tools.find((t) => t.id === id);
    if (tool) {
      out.push({
        type: 'actions',
        actions: [
          {
            label: T('open', { tool: toolName(tool) }),
            options: {},
            open: { tool: id, text: blob },
          },
        ],
      });
    }
  };
  const b64 = textOut.match(/[A-Za-z0-9+/]{24,}={0,2}/);
  if (b64) add('base64', b64[0]);
  const hex = textOut.match(/\b(?:[0-9a-fA-F]{2}){12,}\b/);
  if (hex && !b64) add('hex', hex[0]);
  return out;
}

export default defineTool({
  id: 'symbol-words',
  name: 'Symbol-word decoder (small vocabulary → base N)',
  category: 'crypto',
  description:
    'Text built from a few repeated words or symbols, each standing for one digit? Reads the vocabulary as base 2/4/8/16/32/64, decodes the bits to bytes, and when no obvious order works recovers the mapping with a constrained, seeded search scored for readable text and code. Lock symbols you are sure of and it searches the rest.',
  tags: [
    'symbol substitution',
    'tokens to bits',
    'base n words',
    'word cipher',
    'lorem ipsum cipher',
    'vocabulary cipher',
    'digit words',
    'positional',
    'simulated annealing',
    'base16',
    'base64',
  ],
  input: 'text',
  placeholder: 'Paste the symbol/word text (e.g. "alfa bravo alfa charlie bravo …")',
  live: true,
  options: {
    reading: select(
      'Mapping',
      [
        { value: 'auto', label: 'Auto (best, then search)' },
        { value: 'cipher', label: 'Order of appearance' },
        { value: 'key', label: 'Order in key text' },
        { value: 'alpha', label: 'Alphabetical' },
        { value: 'frequency', label: 'By frequency' },
        { value: 'solver', label: 'Search (annealing)' },
      ],
      'auto',
    ),
    keyText: text('Key text (optional)', '', {
      placeholder: 'A plaintext whose word order is the mapping',
    }),
    locks: text('Locked symbols', '', { placeholder: 'alfa=2 bravo=5 …' }),
    punctuation: select(
      'Punctuation',
      [
        { value: 'keep', label: 'Keep (code, ≠ code)' },
        { value: 'strip', label: 'Strip' },
      ],
      'keep',
    ),
    fold: bool('Lower-case tokens', false),
  },
  examples: [
    {
      label: 'Two words = binary',
      input:
        'zero one one zero one zero zero zero zero one one zero zero one zero one zero one one zero one one zero zero zero one one zero one one zero zero zero one one zero one one one one',
      expect: 'hello',
    },
  ],
  run(input, o) {
    if (input.length > MAX_TEXT) input = input.slice(0, MAX_TEXT);
    const vocab = tokenize(input, {
      keepPunctuation: o.punctuation === 'keep',
      foldCase: o.fold,
    });
    const out: Output[] = [];
    const n = vocab.distinct.length;
    if (n < 2) {
      return [{ type: 'note', level: 'warn', text: T('note.tooFew', { n }) }];
    }

    const info = baseInfo(n);
    out.push({
      type: 'note',
      level: 'info',
      text: T('note.base', { n, tokens: vocab.tokens.length, base: T(KIND_KEY[info.kind], { n }) }),
    });

    // Vocabulary table.
    const idOf = new Map(vocab.distinct.map((t, i) => [t, i]));
    const vocabRows = vocab.distinct
      .slice(0, MAX_VOCAB_ROWS)
      .map((t) => [show(t), vocab.freq.get(t) ?? 0]);
    out.push({
      type: 'table',
      label: T('label.vocab'),
      columns: [T('col.token'), T('col.count')],
      rows: vocabRows,
    });

    if (info.bits === null) {
      // Not a power of two: bit-packing does not apply.
      const sub = registeredTools().find((x) => x.id === 'substitution');
      out.push({ type: 'note', level: 'warn', text: T('note.notPow2', { n }) });
      if (sub) {
        out.push({
          type: 'actions',
          actions: [
            {
              label: T('open', { tool: toolName(sub) }),
              options: {},
              open: { tool: 'substitution', text: input },
            },
          ],
        });
      }
      return out;
    }
    const bits = info.bits;
    const tokenIds = vocab.tokens.map((t) => idOf.get(t)!);
    const locked = parseLocks(o.locks, vocab, n);

    // Candidate mappings: the quick orderings, plus the search when asked or when nothing reads well.
    const candidates: Candidate[] = [];
    const addOrdering = (name: Reading | 'key', label: string, keyOrder?: string[]) => {
      const value = orderingMap(vocab, name === 'key' ? 'key' : name, keyOrder);
      const bytes = decodeBytes(tokenIds, value, bits);
      candidates.push({ name, label, value, bytes, score: blendScore(bytes) });
    };
    addOrdering('cipher', T('read.cipher'));
    if (o.keyText.trim()) {
      const keyVocab = tokenize(o.keyText, {
        keepPunctuation: o.punctuation === 'keep',
        foldCase: o.fold,
      });
      addOrdering('key', T('read.key'), keyVocab.distinct);
    }
    addOrdering('alpha', T('read.alpha'));
    addOrdering('frequency', T('read.frequency'));

    const bestHyp = candidates.reduce((a, b) => (b.score > a.score ? b : a));
    const readable = (c: Candidate) => printScore(c.bytes) > 0.7;
    const wantSolver =
      o.reading === 'solver' || (o.reading === 'auto' && !readable(bestHyp)) || locked.size > 0;
    if (wantSolver) {
      const r = solve({
        bits,
        tokenIds,
        nDistinct: n,
        locked,
        seed: 0x5eed,
        restarts: n <= 20 ? 40 : 24,
      });
      candidates.push({
        name: 'solver',
        label: T('read.solver'),
        value: r.value,
        bytes: r.bytes,
        score: r.score,
      });
    }

    // Pick the one to show: the requested reading, or the best-scoring when on auto.
    const named = candidates.find((c) => c.name === o.reading);
    const primary =
      o.reading === 'auto'
        ? candidates.reduce((a, b) => (b.score > a.score ? b : a))
        : (named ?? bestHyp);
    const decoded = latin1(primary.bytes);

    out.push({
      type: 'table',
      label: T('label.candidates'),
      columns: [T('col.reading'), T('col.score'), T('col.preview')],
      rows: candidates.map((c) => [
        c.label,
        c.score.toFixed(2),
        show(latin1(c.bytes).slice(0, 48)),
      ]),
      highlight: [candidates.indexOf(primary)].filter((i) => i >= 0),
    });

    out.push({
      type: 'text',
      label: T('label.decoded', { reading: primary.label }),
      value: decoded,
    });
    if (printScore(primary.bytes) < 0.7)
      out.push({ type: 'note', level: 'warn', text: T('note.unsure') });

    // Mapping table + a button to lock it, so the user can edit a digit and re-run respecting it.
    const mapRows = vocab.distinct.map((t, i) => [show(t), primary.value[i]!]);
    out.push({
      type: 'table',
      label: T('label.mapping'),
      columns: [T('col.token'), T('col.digit')],
      rows: mapRows,
    });
    const lockSpec = vocab.distinct.map((t, i) => `${t}=${primary.value[i]}`).join(' ');
    out.push({
      type: 'actions',
      actions: [
        { label: T('action.lock'), options: { locks: lockSpec, reading: 'solver' }, primary: true },
      ],
    });

    out.push(...nextSteps(decoded));
    return out;
  },
});
