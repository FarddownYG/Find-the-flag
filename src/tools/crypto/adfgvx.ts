import { bool, defineTool, text, toggle } from '../../core/define';
import { ToolError } from '../../core/errors';
import type { Output } from '../../core/types';
import { toolT } from '../../i18n/tool-text';
import { flagForm } from './_classical';
import { buildSquare } from './polybius';
import {
  columnarPermutation,
  keyGridRows,
  parseColumnKey,
  permute,
  unpermute,
  type ColumnKey,
} from './_transposition';

const T = toolT('adfgvx');

type Variant = 'adfgx' | 'adfgvx';
type Fill = 'letters' | 'digits';

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DIGITS = '0123456789';
const DEFAULT_LABELS: Record<Variant, string> = { adfgx: 'ADFGX', adfgvx: 'ADFGVX' };

export interface Square {
  size: 5 | 6;
  /** size² characters, row by row. */
  cells: string[];
  /** The coordinate letters, one per row and column. */
  labels: string[];
  /** Where each character sits (with I and J sharing a cell in a 5 × 5 square). */
  index: Map<string, number>;
  /** 'ij': I and J share the cell (J is read as I, or I as J when only J is in the square). */
  merged: boolean;
}

const unique = (chars: readonly string[]): string[] => [...new Set(chars)];

/** Text without accents and spaces, upper-case, as single characters. */
const cleanChars = (s: string): string[] => [
  ...s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[\s,;]+/g, '')
    .toUpperCase(),
];

/**
 * The square from a keyword (its distinct characters first, then the rest of the alphabet) or,
 * when the text already holds every cell once (25 or 36 distinct characters), the square itself.
 */
export function makeSquare(variant: Variant, key: string, labelText: string, fill: Fill): Square {
  const size = variant === 'adfgx' ? 5 : 6;
  const wanted = cleanChars(labelText);
  const labels = wanted.length ? wanted : [...DEFAULT_LABELS[variant]];
  if (labels.length !== size || unique(labels).length !== size) {
    throw new ToolError(T('error.labels', { size }));
  }
  const chars = unique(cleanChars(key));
  let cells: string[];
  if (chars.length === size * size) {
    cells = chars;
  } else if (size === 5) {
    cells = [...buildSquare('polybius', key)];
  } else {
    const alphabet = fill === 'digits' ? DIGITS + LETTERS : LETTERS + DIGITS;
    cells = unique([...chars.filter((c) => alphabet.includes(c)), ...alphabet]);
  }
  const index = new Map<string, number>();
  cells.forEach((c, i) => index.set(c, i));
  let merged = false;
  if (size === 5) {
    // Letters share a cell: J reads as I, or I as J in a square that has only J.
    if (index.has('I') && !index.has('J')) {
      index.set('J', index.get('I')!);
      merged = true;
    } else if (index.has('J') && !index.has('I')) {
      index.set('I', index.get('J')!);
      merged = true;
    }
  }
  return { size, cells, labels, index, merged };
}

/** Keeps the label characters; drops spaces and the usual separators between groups. */
function readCipher(text: string, labels: readonly string[]): string[] {
  const out: string[] = [];
  for (const ch of text.toUpperCase()) {
    if (labels.includes(ch)) out.push(ch);
    else if (!/[\s,;:./|-]/.test(ch)) {
      throw new ToolError(T('error.badChar', { char: ch, labels: labels.join(' ') }));
    }
  }
  return out;
}

export interface Encrypted {
  /** The fractionated message: two coordinate letters per character. */
  stream: string[];
  cipher: string[];
  skipped: number;
}

export function adfgvxEncrypt(plain: string, sq: Square, key: ColumnKey): Encrypted {
  const stream: string[] = [];
  let skipped = 0;
  for (const ch of plain.normalize('NFD').replace(/\p{M}/gu, '').toUpperCase()) {
    if (/\s/.test(ch)) continue;
    const at = sq.index.get(ch);
    if (at === undefined) {
      skipped++;
      continue;
    }
    stream.push(sq.labels[Math.floor(at / sq.size)]!, sq.labels[at % sq.size]!);
  }
  if (!stream.length) throw new ToolError(T('error.nothing'));
  const cipher = permute(stream, columnarPermutation(stream.length, key));
  return { stream, cipher, skipped };
}

export interface Decrypted {
  stream: string[];
  plain: string;
}

export function adfgvxDecrypt(cipherText: string, sq: Square, key: ColumnKey): Decrypted {
  const cipher = readCipher(cipherText, sq.labels);
  if (!cipher.length) throw new ToolError(T('error.empty'));
  if (cipher.length % 2) throw new ToolError(T('error.odd', { letters: cipher.length }));
  const stream = unpermute(cipher, columnarPermutation(cipher.length, key));
  let plain = '';
  for (let i = 0; i < stream.length; i += 2) {
    const row = sq.labels.indexOf(stream[i]!);
    const col = sq.labels.indexOf(stream[i + 1]!);
    plain += sq.cells[row * sq.size + col]!;
  }
  return { stream, plain };
}

const pairs = (stream: readonly string[]): string => {
  const out: string[] = [];
  for (let i = 0; i < stream.length; i += 2) out.push(stream[i]! + (stream[i + 1] ?? ''));
  return out.join(' ');
};

const groupFives = (s: string): string => s.replace(/(.{5})(?=.)/gu, '$1 ');

function squareTable(sq: Square): Output {
  return {
    type: 'table',
    label: T('label.square'),
    columns: ['', ...sq.labels],
    rows: sq.labels.map((l, r) => [l, ...sq.cells.slice(r * sq.size, (r + 1) * sq.size)]),
  };
}

function gridTable(stream: readonly string[], key: ColumnKey): Output[] {
  const g = keyGridRows(stream, key, false);
  const out: Output[] = [
    { type: 'table', label: T('label.grid'), columns: g.columns, rows: g.rows },
  ];
  if (g.truncated) {
    out.push({
      type: 'note',
      level: 'info',
      text: T('note.truncated', { rows: g.truncated.rows, cols: g.truncated.cols }),
    });
  }
  return out;
}

export default defineTool({
  id: 'adfgvx',
  name: 'ADFGX / ADFGVX',
  category: 'crypto',
  description:
    'German WWI field ciphers: a keyed Polybius square turns each letter into two coordinate letters, then a columnar transposition mixes them. Encrypt or decrypt with your square and key.',
  tags: [
    'adfgx',
    'adfgvx',
    'fractionated',
    'fractionation',
    'polybius',
    'columnar',
    'transposition',
    'wwi',
    'german',
    'nebel',
    '6x6',
    '5x5',
  ],
  input: 'text',
  placeholder: 'DGDD DAGD DGAF ADDF DADV DVFA ADVX',
  options: {
    variant: toggle('Cipher', [
      { value: 'adfgvx', label: 'ADFGVX (6×6, with digits)' },
      { value: 'adfgx', label: 'ADFGX (5×5)' },
    ]),
    mode: toggle('Mode', [
      { value: 'decrypt', label: 'Decrypt' },
      { value: 'encrypt', label: 'Encrypt' },
    ]),
    square: text('Square', '', {
      placeholder: 'keyword or all the cells',
      hint: 'A keyword (the rest of the alphabet follows) or the whole square written row by row: 25 or 36 different characters',
    }),
    fill: toggle(
      'Then fill with',
      [
        { value: 'letters', label: 'Letters, then digits' },
        { value: 'digits', label: 'Digits, then letters' },
      ],
      undefined,
      {
        hint: 'How a keyword square is completed',
        showIf: (v) => v.variant === 'adfgvx',
      },
    ),
    key: text('Transposition key', '', {
      placeholder: 'PRIVACY   or   3 1 4 2',
      hint: 'A word (A before B, repeated letters read left to right) or the reading order of the columns',
    }),
    labels: text('Coordinate letters', '', {
      placeholder: 'default, or e.g. ABCDEF',
      hint: 'The letters that name the rows and columns, in order: 6 for ADFGVX, 5 for ADFGX',
    }),
    group: bool('Group in fives', true, { showIf: (v) => v.mode === 'encrypt' }),
  },
  examples: [
    {
      label: 'Wikipedia example, decrypt',
      input: 'DGDD DAGD DGAF ADDF DADV DVFA ADVX',
      options: { square: 'na1c3h8tb2ome5wrpd4f6g7i9j0klqsuvxyz', key: 'PRIVACY' },
      expect: 'ATTACKAT1200AM',
    },
    {
      label: 'Encrypt a message',
      input: 'Attack at 1200AM',
      options: {
        mode: 'encrypt',
        square: 'na1c3h8tb2ome5wrpd4f6g7i9j0klqsuvxyz',
        key: 'PRIVACY',
        group: false,
      },
      expect: 'DGDDDAGDDGAFADDFDADVDVFAADVX',
    },
    {
      label: 'ADFGX with a keyword square',
      input: 'FAAGDDDDGXAFXFXGFAFFGADFDFAFXDAAFAADAXFDDAGDXFAXGDAFFXFXGAAF',
      options: { variant: 'adfgx', square: 'GERMANY', key: 'NEBEL' },
      expect: 'THEFLAGISHIDDENINTHESQUAREGRID',
    },
    {
      label: 'Your own coordinate letters',
      input: 'EAFAFEABBDECABCDAFAFAADCDAAEFABCECADCEBE',
      options: { square: 'ENIGMA', key: 'LANTERN', labels: 'ABCDEF' },
      expect: 'MEETATBRIDGE12AT0900',
    },
  ],
  detect({ text: t }) {
    const s = t?.replace(/\s+/g, '') ?? '';
    if (s.length < 24 || s.length % 2 || !/^[ADFGVX]+$/.test(s)) return null;
    const used = new Set(s);
    if (used.size < 4) return null;
    const v = used.has('V');
    // Every coordinate letter in use: nothing else is likely to be made of just these letters.
    const all = used.size === (v ? 6 : 5);
    return {
      score: all ? 0.88 : 0.55,
      options: { variant: v ? ('adfgvx' as const) : ('adfgx' as const), mode: 'decrypt' as const },
      reason: T('detect.letters', { size: v ? 6 : 5 }),
    };
  },
  run(input, { variant, mode, square, fill, key, labels, group }) {
    const sq = makeSquare(variant, square, labels, fill);
    const k = parseColumnKey(key);
    const out: Output[] = [];
    if (mode === 'encrypt') {
      const r = adfgvxEncrypt(input, sq, k);
      const cipher = r.cipher.join('');
      out.push(
        { type: 'text', value: group ? groupFives(cipher) : cipher },
        { type: 'text', label: T('label.stream'), value: pairs(r.stream) },
        ...gridTable(r.stream, k),
        squareTable(sq),
      );
      if (r.skipped) {
        out.push({ type: 'note', level: 'info', text: T('note.skipped', { count: r.skipped }) });
      }
    } else {
      const r = adfgvxDecrypt(input, sq, k);
      const flag = flagForm(r.plain);
      out.push(
        { type: 'text', value: r.plain },
        ...(flag ? [{ type: 'text' as const, label: T('label.flag'), value: flag }] : []),
        { type: 'text', label: T('label.stream'), value: pairs(r.stream) },
        ...gridTable(r.stream, k),
        squareTable(sq),
      );
    }
    if (sq.merged) out.push({ type: 'note', level: 'info', text: T('note.merged') });
    out.push({ type: 'note', level: 'info', text: T('note.related') });
    return out;
  },
});
