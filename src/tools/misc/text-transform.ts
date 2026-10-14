import { bool, defineTool, number, select, text } from '../../core/define';
import { ToolError } from '../../core/errors';
import type { Output } from '../../core/types';
import { toolT } from '../../i18n/tool-text';
import { utf8Encode } from '../../lib/bytes';

const T = toolT('text-transform');

const OPS = [
  { value: 'reverse', label: 'Reverse the text' },
  { value: 'reverse-lines', label: 'Reverse each line' },
  { value: 'reverse-word-order', label: 'Reverse the order of words' },
  { value: 'reverse-each-word', label: 'Reverse each word' },
  { value: 'upper', label: 'UPPERCASE' },
  { value: 'lower', label: 'lowercase' },
  { value: 'swap-case', label: 'sWAP cASE' },
  { value: 'remove-whitespace', label: 'Remove all whitespace' },
  { value: 'remove-breaks', label: 'Remove line breaks' },
  { value: 'strip-nonprintable', label: 'Strip non-printable characters' },
  { value: 'letters', label: 'Keep only letters' },
  { value: 'digits', label: 'Keep only digits' },
  { value: 'every-nth', label: 'Every Nth character' },
  { value: 'chunk', label: 'Split into groups of N' },
  { value: 'transpose', label: 'Transpose lines (columns ↔ rows)' },
  { value: 'sort', label: 'Sort lines' },
  { value: 'unique', label: 'Remove duplicate lines' },
  { value: 'count', label: 'Count characters, words, lines' },
] as const;

const reverse = (s: string) => [...s].reverse().join('');

/** Apply `fn` to the lines of the text, keeping a final line break if there was one. */
function mapLines(input: string, fn: (lines: string[]) => string[]): string {
  const trailing = /\r?\n$/.test(input);
  const lines = input.replace(/\r?\n$/, '').split(/\r?\n/);
  return fn(lines).join('\n') + (trailing ? '\n' : '');
}

const compareCodeUnits = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** "\n" and "\t" typed in the separator box mean a real line break / tab. */
const unescapeSeparator = (s: string) => s.replace(/\\n/g, '\n').replace(/\\t/g, '\t');

const NON_PRINTABLE = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}]/u;

function stripNonPrintable(input: string): Output[] {
  const removed = new Map<string, number>();
  let kept = '';
  for (const ch of input) {
    if (ch !== '\n' && ch !== '\r' && ch !== '\t' && NON_PRINTABLE.test(ch)) {
      const label = `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`;
      removed.set(label, (removed.get(label) ?? 0) + 1);
    } else kept += ch;
  }
  const out: Output[] = [{ type: 'text', value: kept }];
  if (removed.size === 0) {
    out.push({
      type: 'note',
      level: 'info',
      text: T('note.nothingToStrip'),
    });
  } else {
    const total = [...removed.values()].reduce((a, b) => a + b, 0);
    const list = [...removed].map(([cp, n]) => (n > 1 ? `${cp} ×${n}` : cp)).join(', ');
    out.push({
      type: 'note',
      level: 'info',
      text: T('note.removed', { count: total, list }),
    });
  }
  return out;
}

function everyNth(input: string, n: number, offset: number): Output[] {
  const chars = [...input];
  const pick = (start: number) => {
    let s = '';
    for (let i = start; i < chars.length; i += n) s += chars[i];
    return s;
  };
  const out: Output[] = [{ type: 'text', value: pick(offset) }];
  if (n >= 2 && n <= 16) {
    out.push({
      type: 'table',
      label: T('label.offsets', { count: n }),
      columns: [T('col.offset'), T('col.characters')],
      rows: Array.from({ length: n }, (_, o) => [o, pick(o)]),
      highlight: offset < n ? [offset] : [],
    });
  }
  return out;
}

function chunk(input: string, n: number, sep: string): string {
  const chars = [...input];
  const parts: string[] = [];
  for (let i = 0; i < chars.length; i += n) parts.push(chars.slice(i, i + n).join(''));
  return parts.join(unescapeSeparator(sep));
}

function transpose(input: string): string {
  return mapLines(input, (lines) => {
    const grid = lines.map((l) => [...l]);
    const width = Math.max(0, ...grid.map((r) => r.length));
    return Array.from({ length: width }, (_, c) => grid.map((row) => row[c] ?? '').join(''));
  });
}

function showChar(ch: string): string {
  if (ch === ' ') return T('value.space');
  if (ch === '\n') return '\\n';
  if (ch === '\r') return '\\r';
  if (ch === '\t') return '\\t';
  return NON_PRINTABLE.test(ch) ? T('value.invisible') : ch;
}

function count(input: string): Output[] {
  const chars = [...input];
  const freq = new Map<string, number>();
  for (const ch of chars) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  const lines = input === '' ? 0 : input.replace(/\r?\n$/, '').split(/\r?\n/).length;
  const words = input.split(/\s+/).filter(Boolean).length;
  const letters = chars.filter((c) => /\p{L}/u.test(c)).length;
  const digits = chars.filter((c) => c >= '0' && c <= '9').length;
  const spaces = chars.filter((c) => /\s/u.test(c)).length;
  const nonAscii = chars.filter((c) => c.codePointAt(0)! > 127).length;
  const ranked = [...freq].sort((a, b) => b[1] - a[1] || compareCodeUnits(a[0], b[0]));
  return [
    {
      type: 'kv',
      entries: [
        [T('kv.characters'), String(chars.length)],
        [T('kv.bytes'), String(utf8Encode(input).length)],
        [T('kv.lines'), String(lines)],
        [T('kv.words'), String(words)],
        [T('kv.unique'), String(freq.size)],
        [T('kv.letters'), String(letters)],
        [T('kv.digits'), String(digits)],
        [T('kv.whitespace'), String(spaces)],
        [T('kv.nonAscii'), String(nonAscii)],
      ],
    },
    {
      type: 'table',
      label: ranked.length > 100 ? T('label.top100') : T('label.byFrequency'),
      columns: [T('col.character'), T('col.codePoint'), T('col.count'), T('col.share')],
      rows: ranked
        .slice(0, 100)
        .map(([ch, n]) => [
          showChar(ch),
          `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`,
          n,
          `${((n / chars.length) * 100).toFixed(1)}%`,
        ]),
    },
  ];
}

/** Keep the first occurrence of each line, in the original order. */
function uniqueLines(input: string, ignoreCase: boolean): Output[] {
  const seen = new Set<string>();
  let dropped = 0;
  const value = mapLines(input, (lines) =>
    lines.filter((line) => {
      const key = ignoreCase ? line.toLowerCase() : line;
      if (seen.has(key)) {
        dropped++;
        return false;
      }
      seen.add(key);
      return true;
    }),
  );
  return [
    { type: 'text', value },
    {
      type: 'note',
      level: 'info',
      text: T('note.dropped', { count: dropped }),
    },
  ];
}

const isNth = (v: Record<string, unknown>) => v.op === 'every-nth' || v.op === 'chunk';

export default defineTool({
  id: 'text-transform',
  name: 'Text transforms',
  category: 'misc',
  description:
    'Reverse, change case, strip, split, sort, pick every Nth character, transpose, count.',
  tags: [
    'reverse',
    'uppercase',
    'lowercase',
    'swapcase',
    'strip',
    'zero-width',
    'every nth',
    'chunk',
    'split',
    'transpose',
    'sort',
    'uniq',
    'wc',
    'count',
    'remove spaces',
  ],
  input: 'text',
  placeholder: '}desrever{galf',
  options: {
    op: select('Operation', OPS, 'reverse'),
    n: number('N', 2, { min: 1, max: 100000, showIf: isNth }),
    offset: number('Offset', 0, {
      min: 0,
      max: 100000,
      showIf: (v) => v.op === 'every-nth',
      hint: 'Start at this character (0 = the first one).',
    }),
    sep: text('Separator', ' ', {
      showIf: (v) => v.op === 'chunk',
      hint: 'Put between the groups. \\n means a line break, \\t a tab.',
    }),
    descending: bool('Descending', false, { showIf: (v) => v.op === 'sort' }),
    ignoreCase: bool('Ignore case', false, { showIf: (v) => v.op === 'sort' || v.op === 'unique' }),
  },
  examples: [
    { label: 'Reverse', input: '}desrever{galf', expect: 'flag{reversed}' },
    {
      label: 'Every 2nd character',
      input: 'fzlzazgz{zhzizdzdzeznz}z',
      options: { op: 'every-nth', n: 2, offset: 0 },
      expect: 'flag{hidden}',
    },
    {
      label: 'Groups of 2',
      input: '666c61677b7d',
      options: { op: 'chunk', n: 2 },
      expect: '66 6c 61 67 7b 7d',
    },
    {
      label: 'Strip invisible characters',
      input: 'fl​ag{z​w}',
      options: { op: 'strip-nonprintable' },
      expect: 'flag{zw}',
    },
    {
      label: 'Transpose columns',
      input: 'ab\ncd',
      options: { op: 'transpose' },
      expect: 'ac',
    },
    {
      label: 'Count',
      input: 'hello world',
      options: { op: 'count' },
      expect: 'Characters: 11',
    },
  ],
  run(input, { op, n, offset, sep, descending, ignoreCase }) {
    if (input === '') throw new ToolError(T('error.empty'));
    const size = Math.floor(n);
    if ((op === 'every-nth' || op === 'chunk') && (!Number.isFinite(size) || size < 1))
      throw new ToolError(T('error.n'));
    const t = (value: string): Output[] => [{ type: 'text', value }];

    switch (op) {
      case 'reverse':
        return t(reverse(input));
      case 'reverse-lines':
        return t(mapLines(input, (lines) => lines.map(reverse)));
      case 'reverse-word-order':
        return t(
          mapLines(input, (lines) =>
            lines.map((line) => {
              const parts = line.split(/(\s+)/);
              const words = parts.filter((_, i) => i % 2 === 0).reverse();
              return parts.map((p, i) => (i % 2 === 0 ? words[i / 2]! : p)).join('');
            }),
          ),
        );
      case 'reverse-each-word':
        return t(input.replace(/\S+/g, reverse));
      case 'upper':
        return t(input.toUpperCase());
      case 'lower':
        return t(input.toLowerCase());
      case 'swap-case':
        return t(
          [...input]
            .map((c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()))
            .join(''),
        );
      case 'remove-whitespace':
        return t(input.replace(/\s+/g, ''));
      case 'remove-breaks':
        return t(input.replace(/\r?\n|\r/g, ''));
      case 'strip-nonprintable':
        return stripNonPrintable(input);
      case 'letters':
        return t(input.match(/\p{L}/gu)?.join('') ?? '');
      case 'digits':
        return t(input.match(/[0-9]/g)?.join('') ?? '');
      case 'every-nth':
        return everyNth(input, size, Math.max(0, Math.floor(offset)));
      case 'chunk':
        return t(chunk(input, size, sep));
      case 'transpose':
        return t(transpose(input));
      case 'sort': {
        const key = (s: string) => (ignoreCase ? s.toLowerCase() : s);
        const sorted = mapLines(input, (lines) => {
          const out = [...lines].sort((a, b) => compareCodeUnits(key(a), key(b)));
          return descending ? out.reverse() : out;
        });
        return t(sorted);
      }
      case 'unique':
        return uniqueLines(input, ignoreCase);
      case 'count':
        return count(input);
    }
  },
});
