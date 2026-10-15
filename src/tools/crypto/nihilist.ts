import { defineTool, number, text, toggle } from '../../core/define';
import { ToolError } from '../../core/errors';
import type { Output } from '../../core/types';
import { toolT } from '../../i18n/tool-text';
import { ENGLISH_FREQ, flagForm } from './_classical';
import { parseColumnKey, type ColumnKey } from './_transposition';
import { buildSquare } from './polybius';

const T = toolT('nihilist');

type Method = 'numbers' | 'analyse' | 'transposition';

/** Longest key length the number-stream helper looks at. */
const MAX_LENGTH = 40;
/** Two coordinates (11 to 55 each) added: the smallest and the largest possible number. */
const MIN_NUMBER = 22;
const MAX_NUMBER = 110;
/** Fewer numbers than this cannot say anything about a key length. */
const MIN_NUMBERS = 8;
/** A key length is only believed when every position holds at least this many numbers. */
const MIN_EACH = 3;
/** Fewer numbers than this for one key position make a letter-frequency guess unreliable. */
const FEW_EACH = 8;

// ------------------------------------------------------------------ the square

/** Row and column (1 to 5) of a letter as one number such as 23; I and J share a cell. */
function coordinateOf(square: string, letter: string): number {
  const at = square.indexOf(letter === 'J' ? 'I' : letter);
  return (Math.floor(at / 5) + 1) * 10 + (at % 5) + 1;
}

/** The letter at a coordinate such as 23, or null when a digit is outside 1 to 5. */
function letterAt(square: string, n: number): string | null {
  const row = Math.floor(n / 10);
  const col = n % 10;
  if (row < 1 || row > 5 || col < 1 || col > 5) return null;
  return square[(row - 1) * 5 + col - 1]!;
}

const isCoordinate = (n: number): boolean => {
  const row = Math.floor(n / 10);
  const col = n % 10;
  return row >= 1 && row <= 5 && col >= 1 && col <= 5;
};

// -------------------------------------------------------------------------- key

export interface NihilistKey {
  numbers: number[];
  /** The key as it was written: a word, or numbers. */
  kind: 'word' | 'numbers';
}

const NUMERIC = /^[\d\s,;.-]+$/;

/** A key word (each letter becomes its coordinate in the square) or the key numbers themselves. */
export function parseNihilistKey(raw: string, square: string): NihilistKey {
  const s = raw.trim();
  if (!s) throw new ToolError(T('error.noKey'));
  if (NUMERIC.test(s)) {
    const tokens = s.split(/[\s,;.-]+/).filter(Boolean);
    // One long run of digits is read in pairs: 1451212132... is 14 51 21 21 32...
    const numbers =
      tokens.length === 1 && tokens[0]!.length > 2 && tokens[0]!.length % 2 === 0
        ? tokens[0]!.match(/../g)!.map(Number)
        : tokens.map(Number);
    if (numbers.some((n) => !Number.isFinite(n) || n > 999)) {
      throw new ToolError(T('error.keyNumbers'));
    }
    return { numbers, kind: 'numbers' };
  }
  if (/\d/.test(s)) throw new ToolError(T('error.keyMixed'));
  const word = s
    .normalize('NFD')
    .replace(/[^A-Za-z]/g, '')
    .toUpperCase();
  if (!word) throw new ToolError(T('error.keyLetters'));
  return { numbers: [...word].map((c) => coordinateOf(square, c)), kind: 'word' };
}

// ------------------------------------------------------------------ the numbers

/** Letters of the text as the cipher sees them (A to Z, J read as I) and how many were left out. */
function plainLetters(input: string): { letters: string[]; skipped: number } {
  const letters: string[] = [];
  let skipped = 0;
  for (const ch of input.normalize('NFD').replace(/\p{M}/gu, '').toUpperCase()) {
    if (/[A-Z]/.test(ch)) letters.push(ch === 'J' ? 'I' : ch);
    else if (!/\s/.test(ch)) skipped++;
  }
  return { letters, skipped };
}

export function nihilistEncrypt(
  plain: string,
  square: string,
  key: readonly number[],
): { numbers: number[]; skipped: number } {
  const { letters, skipped } = plainLetters(plain);
  if (!letters.length) throw new ToolError(T('error.noLetters'));
  const numbers = letters.map((l, i) => coordinateOf(square, l) + key[i % key.length]!);
  return { numbers, skipped };
}

/** Numbers separated by spaces, commas, line breaks or slashes. */
export function readNumbers(input: string): number[] {
  const t = input.trim();
  if (!t) throw new ToolError(T('error.empty'));
  const out: number[] = [];
  for (const token of t.split(/[\s,;/|]+/).filter(Boolean)) {
    if (!/^\d{1,3}$/.test(token)) {
      throw new ToolError(
        /^\d+$/.test(token) ? T('error.separate', { token }) : T('error.badToken', { token }),
      );
    }
    out.push(Number(token));
  }
  return out;
}

/** Subtracts the key; a number that does not leave a coordinate gives "?". */
export function nihilistDecrypt(
  numbers: readonly number[],
  square: string,
  key: readonly number[],
): { plain: string; invalid: number } {
  let plain = '';
  let invalid = 0;
  numbers.forEach((n, i) => {
    const letter = letterAt(square, n - key[i % key.length]!);
    if (letter === null) invalid++;
    plain += letter ?? '?';
  });
  return { plain, invalid };
}

// ------------------------------------------------------------- key length helper

export interface LengthRow {
  length: number;
  /** Key positions for which some key number turns every number there into a coordinate. */
  fitting: number;
  /** Average amount of numbers per key position. */
  perPosition: number;
  /** Average amount of key numbers that fit, over the fitting positions. */
  candidates: number;
}

/** Key numbers (11 to 55, digits 1 to 5) that leave a coordinate for every number given. */
function fittingKeys(values: readonly number[]): number[] {
  const out: number[] = [];
  for (let tens = 1; tens <= 5; tens++) {
    for (let units = 1; units <= 5; units++) {
      const k = tens * 10 + units;
      if (values.every((v) => isCoordinate(v - k))) out.push(k);
    }
  }
  return out;
}

const positionsOf = (numbers: readonly number[], length: number): number[][] => {
  const cols: number[][] = Array.from({ length }, () => []);
  numbers.forEach((n, i) => cols[i % length]!.push(n));
  return cols;
};

/**
 * Which key lengths could have produced these numbers. Each number is a coordinate plus a key
 * number, and every digit of both is 1 to 5, so the numbers that share a key position must all be
 * explained by one key number. With the right length every position can be; with a wrong one the
 * positions mix different key numbers and, once they hold a few numbers each, stop fitting.
 * Multiples of the right length fit too.
 */
export function keyLengthRows(numbers: readonly number[], maxLength = MAX_LENGTH): LengthRow[] {
  const rows: LengthRow[] = [];
  for (let length = 1; length <= Math.min(maxLength, numbers.length); length++) {
    let fitting = 0;
    let total = 0;
    for (const col of positionsOf(numbers, length)) {
      const keys = fittingKeys(col);
      if (keys.length) {
        fitting++;
        total += keys.length;
      }
    }
    rows.push({
      length,
      fitting,
      perPosition: numbers.length / length,
      candidates: fitting ? total / fitting : 0,
    });
  }
  return rows;
}

/** The smallest length for which every position fits and holds enough numbers to mean something. */
export function likelyLength(rows: readonly LengthRow[], minEach = MIN_EACH): number | null {
  const hit = rows.find((r) => r.fitting === r.length && r.perPosition >= minEach);
  return hit ? hit.length : null;
}

/**
 * The key number for each position that makes the letters look most like English, among the
 * ones that fit (needs the square). A position without any fitting number gives 0.
 */
export function guessKey(
  numbers: readonly number[],
  length: number,
  square: string,
): { key: number[]; smallest: number } {
  const cols = positionsOf(numbers, length);
  const key = cols.map((col) => {
    let best = -Infinity;
    let pick = 0;
    for (const k of fittingKeys(col)) {
      let score = 0;
      for (const v of col) {
        const letter = letterAt(square, v - k)!;
        score += Math.log(ENGLISH_FREQ[letter.charCodeAt(0) - 65]! / 100);
      }
      if (score > best) {
        best = score;
        pick = k;
      }
    }
    return pick;
  });
  return { key, smallest: Math.min(...cols.map((c) => c.length)) };
}

// ---------------------------------------------------------------- transposition

/**
 * Nihilist transposition: the text fills an n × n square row by row (n = key length), the
 * columns and the rows are both put in key order, and the result is read by rows (or by columns).
 * Longer texts are cut into squares.
 */
export function squareTransposition(
  cells: readonly string[],
  key: ColumnKey,
  decrypt: boolean,
  byColumns: boolean,
): string[] {
  const n = key.symbols.length;
  const out = new Array<string>(cells.length);
  for (let base = 0; base < cells.length; base += n * n) {
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        // After the move, cell (i, j) holds what was written at (order[i], order[j]).
        const written = base + key.order[i]! * n + key.order[j]!;
        const moved = base + (byColumns ? j * n + i : i * n + j);
        if (decrypt) out[written] = cells[moved]!;
        else out[moved] = cells[written]!;
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------------- tool

interface Settings {
  method: Method;
  mode: 'decrypt' | 'encrypt';
  square: string;
  key: string;
  transpositionKey: string;
  read: 'rows' | 'columns';
  pad: string;
  keyLength: number;
}

const note = (level: 'info' | 'warn' | 'success', text: string): Output => ({
  type: 'note',
  level,
  text,
});

/** The 5 × 5 square as a table, rows and columns numbered 1 to 5. */
function squareTable(square: string): Output {
  const labels = ['1', '2', '3', '4', '5'];
  return {
    type: 'table',
    label: T('label.square'),
    columns: ['', ...labels],
    rows: labels.map((l, r) => [l, ...square.slice(r * 5, r * 5 + 5)]),
  };
}

const lettersOf = (square: string, numbers: readonly number[]): string =>
  numbers.map((n) => letterAt(square, n) ?? '?').join('');

function numbersRun(input: string, o: Settings, square: string): Output[] {
  const key = parseNihilistKey(o.key, square);
  const keyBlock: Output = {
    type: 'text',
    label: T('label.keyNumbers'),
    value: key.numbers.join(' '),
  };
  const out: Output[] = [];
  if (o.mode === 'encrypt') {
    const { numbers, skipped } = nihilistEncrypt(input, square, key.numbers);
    out.push({ type: 'text', value: numbers.join(' ') }, keyBlock, squareTable(square));
    if (skipped) out.push(note('info', T('note.skipped', { count: skipped })));
  } else {
    const numbers = readNumbers(input);
    const { plain, invalid } = nihilistDecrypt(numbers, square, key.numbers);
    const flag = invalid ? null : flagForm(plain);
    out.push(
      { type: 'text', value: plain },
      ...(flag ? [{ type: 'text' as const, label: T('label.flag'), value: flag }] : []),
      keyBlock,
      squareTable(square),
    );
    if (invalid) {
      const level = invalid * 2 > numbers.length ? 'warn' : 'info';
      out.push(note(level, T('note.invalid', { invalid, total: numbers.length })));
    }
  }
  out.push(note('info', T('note.mergeIJ')), note('info', T('note.related')));
  return out;
}

function analyseRun(input: string, o: Settings, square: string): Output[] {
  const numbers = readNumbers(input);
  if (numbers.length < MIN_NUMBERS) {
    throw new ToolError(T('error.tooFew', { n: numbers.length, min: MIN_NUMBERS }));
  }
  const outside = numbers.find((n) => n < MIN_NUMBER || n > MAX_NUMBER);
  if (outside !== undefined) throw new ToolError(T('error.range', { n: outside }));
  const rows = keyLengthRows(numbers);
  const likely = likelyLength(rows);
  const length = o.keyLength >= 1 ? Math.min(Math.floor(o.keyLength), numbers.length) : likely;
  const out: Output[] = [
    {
      type: 'kv',
      label: T('label.summary'),
      entries: [
        [T('kv.count'), String(numbers.length)],
        [T('kv.range'), `${Math.min(...numbers)} - ${Math.max(...numbers)}`],
        [T('kv.likely'), likely ? String(likely) : T('value.none')],
      ],
    },
    {
      type: 'table',
      label: T('label.lengths'),
      columns: [T('col.length'), T('col.fitting'), T('col.each'), T('col.keys')],
      rows: rows.map((r) => [
        r.length,
        T('value.fitting', { fitting: r.fitting, length: r.length }),
        r.perPosition.toFixed(1),
        r.fitting ? r.candidates.toFixed(1) : '-',
      ]),
      highlight: rows.flatMap((r, i) => (r.fitting === r.length ? [i] : [])),
    },
    likely
      ? note('success', T('note.lengthYes', { length: likely }))
      : note('warn', T('note.lengthNone', { max: rows.length })),
  ];
  if (length) {
    const g = guessKey(numbers, length, square);
    if (g.key.includes(0)) {
      out.push(note('warn', T('note.noFit', { length })));
    } else {
      out.push(
        {
          type: 'text',
          label: T('label.guessPlain', { length }),
          value: nihilistDecrypt(numbers, square, g.key).plain,
        },
        { type: 'text', label: T('label.guessKey'), value: g.key.join(' ') },
        { type: 'text', label: T('label.guessLetters'), value: lettersOf(square, g.key) },
        {
          type: 'actions',
          actions: [
            {
              label: T('action.decrypt'),
              options: {
                method: 'numbers',
                mode: 'decrypt',
                square: o.square,
                key: g.key.join(' '),
              },
              primary: true,
            },
          ],
        },
        note('info', T('note.guess')),
      );
      if (g.smallest < FEW_EACH) {
        out.push(note('warn', T('note.guessFew', { smallest: g.smallest })));
      }
    }
  }
  out.push(note('info', T('note.proof')));
  return out;
}

/** The squares of the transposition tool never show more than this many rows and columns. */
const SHOWN = 20;

function transpositionRun(input: string, o: Settings): Output[] {
  const key = parseColumnKey(o.transpositionKey);
  const n = key.symbols.length;
  const size = n * n;
  const encrypt = o.mode === 'encrypt';
  let cells = [...input].filter((c) => !/\s/.test(c));
  if (!cells.length) throw new ToolError(T('error.noText'));
  const notes: Output[] = [];
  if (encrypt) {
    const missing = (size - (cells.length % size)) % size;
    if (missing) {
      const pad = [...o.pad][0] ?? 'X';
      cells = [...cells, ...Array.from({ length: missing }, () => pad)];
      notes.push(note('info', T('note.padded', { padded: missing, pad })));
    }
  } else if (cells.length % size) {
    throw new ToolError(T('error.notSquare', { n, cells: size, length: cells.length }));
  }
  const byColumns = o.read === 'columns';
  const result = squareTransposition(cells, key, !encrypt, byColumns);
  const written = encrypt ? cells : result;
  const moved = encrypt ? result : cells;
  const joined = result.join('');
  const flag = !encrypt && !/[{}]/.test(joined) ? flagForm(joined) : null;
  const shown = Math.min(n, SHOWN);
  // The first square: as written (rows and columns named by their rank in the key), then as moved.
  const rowsOf = (cs: readonly string[], label: (i: number) => string, transposed: boolean) =>
    Array.from({ length: shown }, (_, i) => [
      label(i),
      ...Array.from({ length: shown }, (_, j) => cs[transposed ? j * n + i : i * n + j]!),
    ]);
  const symbols = key.symbols.slice(0, shown);
  return [
    { type: 'text', value: joined },
    ...(flag ? [{ type: 'text' as const, label: T('label.flag'), value: flag }] : []),
    {
      type: 'table',
      label: T('label.written'),
      columns: ['', ...symbols],
      rows: [
        ['#', ...key.rank.slice(0, shown).map(String)],
        ...rowsOf(written, (i) => `${key.rank[i]}`, false),
      ],
    },
    {
      type: 'table',
      label: T(byColumns ? 'label.movedColumns' : 'label.movedRows'),
      columns: ['', ...Array.from({ length: shown }, (_, j) => String(j + 1))],
      rows: rowsOf(moved, (i) => String(i + 1), byColumns),
    },
    ...(n > SHOWN ? [note('info', T('note.truncated', { rows: shown, cols: shown }))] : []),
    ...notes,
    note('info', T('note.squareHow')),
  ];
}

/** Self-made: DYNAMITE... style text, square ZEBRAS, key RUSSIAN (scripts/gen-samples-transposition.mjs). */
const NUMBERS_SAMPLE =
  '59 82 33 54 44 70 73 35 66 35 72 53 36 73 29 92 74 63 46 38 56 55 74 66 52 44 39 75 29 76 53 42 63 47 64 37 63 62 53 73 60 72 26 72 72 56 53 57 65 55 102 56 34 44 29 62 26 103 33 35 87 36 53 66 63 62 66 63 56 92 49 64 33 35 53 46 56 28 63 42 36 65 27 96 55 102 56 34 44 29 62 56 73 63 72 73 60 86 45 63 46 35 74 66 84 35 66 62 44 66 57 83 47 66 66 66 63 27 86 26 92 42 36 73 38 92 55 83 66 42 45 27 65 56 65 33 76 74 66 86 28 106 66 63 57 66 53 35 72 66 52 44 68 83 28 74';

export default defineTool({
  id: 'nihilist',
  name: 'Nihilist cipher',
  category: 'crypto',
  description:
    'Nihilist cipher: Polybius coordinates plus a repeating numeric key, added as numbers. Encrypt, decrypt, guess the key length from the numbers, or run the Nihilist transposition.',
  tags: [
    'nihilist',
    'nihilist cipher',
    'polybius',
    'numbers',
    'checkerboard',
    'addition',
    'russian nihilists',
    'nihilist transposition',
    'key length',
  ],
  input: 'text',
  placeholder: '37 106 62 36 67 47 86 26 …',
  options: {
    method: toggle('Method', [
      { value: 'numbers', label: 'Numbers' },
      { value: 'analyse', label: 'Key length' },
      { value: 'transposition', label: 'Transposition' },
    ]),
    mode: toggle(
      'Mode',
      [
        { value: 'decrypt', label: 'Decrypt' },
        { value: 'encrypt', label: 'Encrypt' },
      ],
      undefined,
      { showIf: (v) => v.method !== 'analyse' },
    ),
    square: text('Square keyword', '', {
      placeholder: 'ZEBRAS (empty = A to Z)',
      hint: 'Keyword of the 5×5 Polybius square (I and J share a cell)',
      showIf: (v) => v.method !== 'transposition',
    }),
    key: text('Key', '', {
      placeholder: 'RUSSIAN   or   14 51 21 21 32 15 41',
      hint: 'A word (its letters are looked up in the square) or the key numbers',
      showIf: (v) => v.method === 'numbers',
    }),
    transpositionKey: text('Transposition key', '', {
      placeholder: 'ZEBRAS   or   3 1 4 2',
      hint: 'A word or the order of the columns and rows; the square is as wide as the key is long',
      showIf: (v) => v.method === 'transposition',
    }),
    read: toggle(
      'Read the result',
      [
        { value: 'rows', label: 'By rows' },
        { value: 'columns', label: 'By columns' },
      ],
      undefined,
      { showIf: (v) => v.method === 'transposition' },
    ),
    pad: text('Padding character', 'X', {
      showIf: (v) => v.method === 'transposition' && v.mode === 'encrypt',
    }),
    keyLength: number('Key length', 0, {
      min: 0,
      max: MAX_LENGTH,
      hint: '0 = the smallest length that fits every position',
      showIf: (v) => v.method === 'analyse',
    }),
  },
  examples: [
    {
      label: 'Wikipedia example, decrypt',
      input: '37 106 62 36 67 47 86 26 104 53 62 77 27 55 57 66 55 36 54 27',
      options: { square: 'ZEBRAS', key: 'RUSSIAN' },
      expect: 'DYNAMITEWINTERPALACE',
    },
    {
      label: 'Encrypt a message',
      input: 'Dynamite winter palace',
      options: { mode: 'encrypt', square: 'ZEBRAS', key: 'RUSSIAN' },
      expect: '37 106 62 36 67 47 86 26 104 53 62 77 27 55 57 66 55 36 54 27',
    },
    {
      label: 'Key given as numbers',
      input: '37 106 62 36 67 47 86 26 104 53 62 77 27 55 57 66 55 36 54 27',
      options: { square: 'ZEBRAS', key: '14 51 21 21 32 15 41' },
      expect: 'DYNAMITEWINTERPALACE',
    },
    {
      label: 'Find the key length',
      input: NUMBERS_SAMPLE,
      options: { method: 'analyse', square: 'ZEBRAS' },
      expect: 'THEKEYISARUSSIANWORD',
    },
    {
      label: 'Nihilist transposition',
      input: 'us_qat{algnfwnso_iiihlsik_eo}rtaedhr',
      options: { method: 'transposition', transpositionKey: 'ZEBRAS' },
      expect: 'readthisnow_flag{nihilist_square_ok}',
    },
  ],
  detect({ text: t }) {
    const s = t?.trim() ?? '';
    if (!/^(\d{2,3}[\s,;]+){7,}\d{2,3}$/.test(s)) return null;
    const numbers = s.split(/[\s,;]+/).map(Number);
    // Two coordinates added: 22 to 110, and not all below 55 (those are plain Polybius numbers).
    if (numbers.some((n) => n < MIN_NUMBER || n > MAX_NUMBER) || numbers.every((n) => n <= 55)) {
      return null;
    }
    return {
      score: 0.6,
      options: { method: 'analyse' as const },
      reason: T('detect.numbers'),
    };
  },
  run(input, o) {
    if (o.method === 'transposition') return transpositionRun(input, o);
    const square = buildSquare('polybius', o.square);
    return o.method === 'analyse' ? analyseRun(input, o, square) : numbersRun(input, o, square);
  },
});
