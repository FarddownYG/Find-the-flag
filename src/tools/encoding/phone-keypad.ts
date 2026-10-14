import { defineTool, select, toggle } from '../../core/define';
import { ToolError } from '../../core/errors';
import type { Output } from '../../core/types';
import { toolT } from '../../i18n/tool-text';
import { readability, type Lang } from '../../lib/readability';
import {
  KEYPAD,
  applyCase,
  decodeMultitap,
  decodeT9,
  encodeText,
  lettersToDigits,
  separatorName,
  type CaseMode,
  type Separator,
} from './_keypad';

const T = toolT('phone-keypad');

type Mode = 'multitap' | 't9' | 'encode' | 'letters';

/** Words listed per key sequence in T9 mode. */
const T9_LISTED = 8;

function languageName(lang: Lang | null): string {
  if (lang === 'en') return T('lang.en');
  if (lang === 'fr') return T('lang.fr');
  return '—';
}

/** The keypad as a small key → letters list, with the presses each letter takes in multi-tap. */
function mappingBlock(mode: Mode): Output {
  const tap = mode === 'multitap' || mode === 'encode';
  const entries: [string, string][] = [['1', T('mapping.none')]];
  for (const [key, letters] of Object.entries(KEYPAD)) {
    const upper = [...letters.toUpperCase()];
    entries.push([
      key,
      tap ? upper.map((l, i) => `${l} ${key.repeat(i + 1)}`).join(' · ') : upper.join(' '),
    ]);
  }
  entries.push(['0', T('mapping.space')]);
  return { type: 'kv', label: T('label.mapping'), entries };
}

function multitapOutput(input: string, separator: Separator, casing: CaseMode): Output[] {
  const r = decodeMultitap(input, separator);
  const out: Output[] = [];
  if (r.readings) {
    out.push({ type: 'text', label: T('label.best'), value: applyCase(r.text, casing) });
    out.push({
      type: 'table',
      label: T('label.readings'),
      columns: [T('col.rank'), T('col.reading'), T('col.score'), T('col.language')],
      rows: r.readings.map((x, i) => [
        i + 1,
        applyCase(x.text, casing),
        x.score,
        languageName(x.lang),
      ]),
      highlight: [0],
    });
    if (!r.capped) {
      out.push({ type: 'note', level: 'info', text: T('note.tried', { count: r.total }) });
    }
  } else {
    out.push({ type: 'text', value: applyCase(r.text, casing) });
  }
  if (r.capped) out.push({ type: 'note', level: 'warn', text: T('note.capped') });
  if (r.wordBreaks) out.push({ type: 'note', level: 'info', text: T('note.wordBreaks') });
  if (r.separators.length) {
    out.push({
      type: 'note',
      level: 'info',
      text: T('note.separators', { list: r.separators.map(separatorName).join(', ') }),
    });
  }
  if (r.wraps) {
    out.push({
      type: 'note',
      level: 'warn',
      text: T('note.wrapped', { count: r.wraps.count, example: r.wraps.example }),
    });
  }
  if (r.weak) out.push({ type: 'note', level: 'warn', text: T('note.weak') });
  return out;
}

function t9Output(input: string, casing: CaseMode): Output[] {
  const r = decodeT9(input);
  const seen = new Set<string>();
  const rows: string[][] = [];
  for (const token of r.tokens) {
    if (seen.has(token.keys)) continue;
    seen.add(token.keys);
    const shown = token.words.slice(0, T9_LISTED).map((w) => applyCase(w, casing));
    const more = token.words.length - shown.length;
    rows.push([
      token.keys,
      shown.length ? shown.join(', ') + (more > 0 ? ` (+${more})` : '') : T('cell.noWord'),
    ]);
  }
  const out: Output[] = [
    { type: 'text', value: applyCase(r.text, casing) },
    { type: 'table', label: T('label.words'), columns: [T('col.keys'), T('col.words')], rows },
  ];
  if (r.unknown) {
    out.push({ type: 'note', level: 'warn', text: T('note.t9Unknown', { count: r.unknown }) });
  }
  return out;
}

function encodeOutput(input: string, separator: Separator): Output[] {
  const e = encodeText(input, separator);
  if (!e.letters) throw new ToolError(T('error.noLetters'));
  const out: Output[] = [
    { type: 'text', label: T('label.multitap'), value: e.multitap },
    { type: 'text', label: T('label.t9'), value: e.t9 },
  ];
  if (e.skipped.length) {
    out.push({
      type: 'note',
      level: 'warn',
      text: T('note.skipped', { chars: e.skipped.map((c) => `"${c}"`).join(' ') }),
    });
  }
  if (separator === 'none' && e.sameKey) {
    out.push({ type: 'note', level: 'warn', text: T('note.sameKey') });
  }
  return out;
}

function lettersOutput(input: string): Output[] {
  const { text, converted } = lettersToDigits(input.trim());
  const out: Output[] = [
    { type: 'text', value: text },
    {
      type: 'kv',
      entries: [
        [T('label.digitsOnly'), text.replace(/\D/g, '')],
        [T('label.converted'), String(converted)],
      ],
    },
  ];
  if (!converted) out.push({ type: 'note', level: 'info', text: T('note.noLetters') });
  return out;
}

export default defineTool({
  id: 'phone-keypad',
  name: 'Phone keypad',
  category: 'encoding',
  description:
    'Decode multi-tap and T9 phone keypad texts (222 = C), encode text to key presses, or turn vanity numbers into digits.',
  tags: [
    'multi-tap',
    'multitap',
    't9',
    'sms',
    'nokia',
    'old phone',
    'telephone',
    'keypad',
    'predictive text',
    'vanity number',
    '1-800-flowers',
    'abc2',
  ],
  input: 'text',
  placeholder: '44-33-555-555-666   (letters separated by - space , | /   ·   0 = space)',
  options: {
    mode: toggle(
      'Mode',
      [
        { value: 'multitap', label: 'Multi-tap' },
        { value: 't9', label: 'T9' },
        { value: 'encode', label: 'Encode' },
        { value: 'letters', label: 'Phone number' },
      ],
      'multitap',
      {
        hint: 'Multi-tap: 222 = C. T9: one key per letter (43556 = hello). Phone number: 1-800-FLOWERS to digits.',
      },
    ),
    separator: select(
      'Separator',
      [
        { value: 'auto', label: 'Auto-detect' },
        { value: 'dash', label: 'Dash (-)' },
        { value: 'space', label: 'Space' },
        { value: 'comma', label: 'Comma (,)' },
        { value: 'pipe', label: 'Pipe (|)' },
        { value: 'none', label: 'None' },
      ],
      'auto',
      {
        hint: 'Between letters. With none, every way to split a run of one key is ranked by how much it reads as French or English.',
        showIf: (v) => v.mode === 'multitap' || v.mode === 'encode',
      },
    ),
    casing: toggle(
      'Case',
      [
        { value: 'upper', label: 'Upper case' },
        { value: 'lower', label: 'Lower case' },
      ],
      'upper',
      { showIf: (v) => v.mode === 'multitap' || v.mode === 't9' },
    ),
  },
  examples: [
    { label: 'Multi-tap with dashes', input: '44-33-555-555-666', expect: 'HELLO' },
    {
      label: 'Multi-tap: a longer word',
      input: '222-33-555-555-7-44-666-66-33',
      expect: 'CELLPHONE',
    },
    {
      label: 'Two words (0 is a space)',
      input: '44 33 555 555 666 0 9 666 777 555 3',
      expect: 'HELLO WORLD',
    },
    { label: 'No separator: splits ranked', input: '4433555555666', expect: 'HELLO' },
    { label: 'Long presses wrap around', input: '2222-7777-77777', expect: 'ASP' },
    {
      label: 'T9 word',
      input: '43556',
      options: { mode: 't9' },
      expect: 'HELLO',
    },
    {
      label: 'T9 sentence',
      input: '43556 0 96753',
      options: { mode: 't9' },
      expect: 'HELLO WORLD',
    },
    {
      label: 'Encode text',
      input: 'HELLO',
      options: { mode: 'encode' },
      expect: '44 33 555 555 666',
    },
    {
      label: 'Vanity number',
      input: '1-800-FLOWERS',
      options: { mode: 'letters' },
      expect: '1-800-3569377',
    },
    {
      label: 'Lower case',
      input: '44 33 555 555 666',
      options: { casing: 'lower' },
      expect: 'hello',
    },
  ],
  detect({ text }) {
    const t = text?.trim() ?? '';
    if (t.length < 5 || t.length > 20000 || !/^[02-9\s,|/-]+$/.test(t)) return null;
    const groups = t.split(/[\s,|/-]+/).filter(Boolean);
    if (groups.length < 3 || groups.length === 1) return null;
    // Every group is one key pressed as often as the key has letters, and some are repeated.
    const strict = groups.every(
      (g) => /^([0-9])\1*$/.test(g) && (g[0] === '0' || g.length <= KEYPAD[g[0]!]!.length),
    );
    if (!strict || !groups.some((g) => g.length > 1 && g[0] !== '0')) return null;
    try {
      const decoded = decodeMultitap(t, 'auto');
      const reads = readability(decoded.text.toLowerCase()).score >= 20;
      return {
        score: reads ? 0.62 : 0.4,
        options: { mode: 'multitap', separator: 'auto' },
        reason: reads ? T('detect.reads') : T('detect.groups'),
      };
    } catch (e) {
      if (e instanceof ToolError) return null;
      throw e;
    }
  },
  run(input, { mode, separator, casing }) {
    if (!input.trim()) throw new ToolError(T('error.empty'));
    switch (mode) {
      case 'encode':
        return [...encodeOutput(input, separator), mappingBlock(mode)];
      case 't9':
        return [...t9Output(input, casing), mappingBlock(mode)];
      case 'letters':
        return [...lettersOutput(input), mappingBlock(mode)];
      default:
        return [...multitapOutput(input, separator, casing), mappingBlock('multitap')];
    }
  },
});
