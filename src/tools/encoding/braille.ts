import { bool, defineTool, toggle } from '../../core/define';
import { ToolError } from '../../core/errors';
import type { Output } from '../../core/types';
import { toolT } from '../../i18n/tool-text';
import { utf8Decode } from '../../lib/bytes';
import { bytesResult, showChar } from './_common';

const T = toolT('braille');

export const BRAILLE_BASE = 0x2800;
/** A cell is the 8 dots of Unicode braille: bit n-1 is dot n (dots 1-3 left column, 4-6 right, 7-8 below). */
export const cellChar = (mask: number): string => String.fromCharCode(BRAILLE_BASE + mask);
export const isCell = (cp: number): boolean => cp >= BRAILLE_BASE && cp <= BRAILLE_BASE + 0xff;

/** "1-25-14": the dots of a cell as digits, 0 for the blank cell. */
export const dotsOf = (mask: number): string => {
  let s = '';
  for (let d = 1; d <= 8; d++) if (mask & (1 << (d - 1))) s += d;
  return s || '0';
};

// ---------------------------------------------------------------------------------------------
// English braille, grade 1 (uncontracted): the rules of Unified English Braille for letters,
// numbers, capitals and the punctuation marks below. Contractions (grade 2) are not expanded.
// ---------------------------------------------------------------------------------------------

/** a-j use dots 1, 2, 4, 5; k-t add dot 3; u, v, x, y, z add dots 3 and 6 (w, the odd one out, is 2456). */
const LETTER_DOTS: Record<string, string> = {
  a: '1', b: '12', c: '14', d: '145', e: '15', f: '124', g: '1245', h: '125', i: '24', j: '245',
  k: '13', l: '123', m: '134', n: '1345', o: '135', p: '1234', q: '12345', r: '1235', s: '234',
  t: '2345', u: '136', v: '1236', w: '2456', x: '1346', y: '13456', z: '1356',
}; // prettier-ignore

const maskOfDots = (dots: string): number =>
  [...dots].reduce((m, d) => m | (1 << (Number(d) - 1)), 0);

const LETTER_CELL = new Map<string, number>(
  Object.entries(LETTER_DOTS).map(([l, d]) => [l, maskOfDots(d)]),
);
const CELL_LETTER = new Map<number, string>([...LETTER_CELL].map(([l, m]) => [m, l]));
const DIGIT_LETTER = 'jabcdefghi'; // 0 = j, 1 = a ... 9 = i

const NUMBER_SIGN = maskOfDots('3456');
const CAPITAL_SIGN = maskOfDots('6');
const LETTER_SIGN = maskOfDots('56');
const BLANK = 0;

/** One-cell punctuation. */
const SINGLE: [string, string][] = [
  [',', '2'], [';', '23'], [':', '25'], ['.', '256'], ['!', '235'], ['?', '236'],
  ["'", '3'], ['-', '36'],
]; // prettier-ignore
const OPEN_QUOTE = maskOfDots('236'); // the same cell as "?": told apart by where it stands
const CLOSE_QUOTE = maskOfDots('356');

/** Two-cell symbols: a prefix cell and a second cell. */
const DOUBLE: [string, string, string][] = [
  ['(', '5', '126'], [')', '5', '345'], ['[', '46', '126'], [']', '46', '345'],
  ['{', '456', '126'], ['}', '456', '345'], ['/', '456', '34'], ['\\', '456', '16'],
  ['@', '4', '1'], ['&', '4', '12346'], ['$', '4', '234'], ['#', '46', '3456'],
  ['*', '5', '35'], ['+', '5', '235'], ['=', '5', '2356'], ['%', '46', '356'],
  ['_', '46', '36'], ['<', '5', '13'], ['>', '46', '2'],
]; // prettier-ignore

const SYMBOL_CELL = new Map<string, number[]>([
  ...SINGLE.map(([ch, d]) => [ch, [maskOfDots(d)]] as [string, number[]]),
  ...DOUBLE.map(([ch, a, b]) => [ch, [maskOfDots(a), maskOfDots(b)]] as [string, number[]]),
]);
const SINGLE_SYMBOL = new Map<number, string>(SINGLE.map(([ch, d]) => [maskOfDots(d), ch]));
const DOUBLE_SYMBOL = new Map<string, string>(
  DOUBLE.map(([ch, a, b]) => [`${maskOfDots(a)},${maskOfDots(b)}`, ch]),
);
const PREFIXES = new Set(DOUBLE.map(([, a]) => maskOfDots(a)));
// ⠘⠦ / ⠘⠴: "non-specific" quotation marks
DOUBLE_SYMBOL.set(`${maskOfDots('45')},${OPEN_QUOTE}`, '"');
DOUBLE_SYMBOL.set(`${maskOfDots('45')},${CLOSE_QUOTE}`, '"');
PREFIXES.add(maskOfDots('45'));

// ---------------------------------------------------------------------------------------------
// Reading the input: cells (U+2800-U+28FF) or dot numbers (1-25-14)
// ---------------------------------------------------------------------------------------------

export type Item =
  | { kind: 'cell'; mask: number; pos: number }
  /** A space; `blank` when it is the empty braille cell (or the dot number 0), which is data. */
  | { kind: 'space'; blank: boolean }
  | { kind: 'newline' }
  | { kind: 'other'; ch: string; pos: number };

/** Does the text hold braille cells (at least one cell, anywhere)? */
export const hasCells = (text: string): boolean => /[⠀-⣿]/.test(text);

/** Cells and the spaces and line breaks between them; anything else comes back as "other". */
export function readCells(text: string): Item[] {
  const items: Item[] = [];
  let pos = 0;
  for (const ch of text) {
    pos++;
    const cp = ch.codePointAt(0)!;
    if (isCell(cp)) {
      items.push(
        cp === BRAILLE_BASE
          ? { kind: 'space', blank: true }
          : { kind: 'cell', mask: cp - BRAILLE_BASE, pos },
      );
    } else if (ch === '\n') items.push({ kind: 'newline' });
    else if (ch === '\r') continue;
    else if (/\s/.test(ch)) items.push({ kind: 'space', blank: false });
    else items.push({ kind: 'other', ch, pos });
  }
  return items;
}

/**
 * Dot numbers: one group of the digits 1-8 per cell, written in any order ("25" is dots 2 and
 * 5); cells are separated by "-", commas, dots or spaces; "0", "/" and "|" are a blank cell;
 * a line break stays a line break. Throws a ToolError with the position of a bad group.
 */
export function readDots(text: string): Item[] {
  const items: Item[] = [];
  let sawCell = false;
  for (const m of text.matchAll(/[0-9]+|[/|]|\n|[^\s\-,.;_]/g)) {
    const tok = m[0];
    const pos = m.index + 1;
    if (tok === '\n') items.push({ kind: 'newline' });
    else if (tok === '/' || tok === '|' || tok === '0') items.push({ kind: 'space', blank: true });
    else if (/^\d+$/.test(tok)) {
      const bad = tok.match(/[09]/);
      if (bad) {
        throw new ToolError(
          bad[0] === '0'
            ? T('error.dotsZero', { group: tok, pos })
            : T('error.dotsRange', { char: bad[0], group: tok, pos: pos + bad.index! }),
        );
      }
      const digits = new Set(tok);
      if (digits.size !== tok.length)
        throw new ToolError(T('error.dotsRepeat', { group: tok, pos }));
      items.push({ kind: 'cell', mask: maskOfDots(tok), pos });
      sawCell = true;
    } else {
      throw new ToolError(T('error.dotsChar', { char: showChar(tok), pos }));
    }
  }
  if (!sawCell && !items.some((i) => i.kind === 'space')) throw new ToolError(T('error.noCells'));
  return items;
}

/** Cells from the text: braille characters when it has any, else dot numbers. */
export function readBraille(text: string): { items: Item[]; form: 'cells' | 'dots' } {
  if (hasCells(text)) return { items: readCells(text), form: 'cells' };
  if (!/[0-8]/.test(text)) throw new ToolError(T('error.noCells'));
  return { items: readDots(text), form: 'dots' };
}

// ---------------------------------------------------------------------------------------------
// Cells to text
// ---------------------------------------------------------------------------------------------

export interface BrailleText {
  text: string;
  /** Cells read (blank cells and spaces excluded). */
  cells: number;
  /** Cells with no reading in grade 1 (shown as "?"), with their position. */
  unknown: { pos: number; dots: string }[];
  /** Characters of the input that were not braille and were kept as they are. */
  kept: number;
}

/**
 * Letters, the number sign and the digits after it, the capital sign (one letter), the capital
 * word (two signs) and capital passage (three signs, ended by the sign and an apostrophe), and
 * the punctuation of the tables above. A blank cell is a space. A cell with no reading is "?".
 */
export function brailleToText(items: Item[]): BrailleText {
  let out = '';
  let cells = 0;
  let kept = 0;
  const unknown: { pos: number; dots: string }[] = [];
  let numeric = false;
  let capNext = false;
  let capWord = false;
  let capPassage = false;

  const cellAt = (i: number): number | null => {
    const it = items[i];
    return it?.kind === 'cell' ? it.mask : null;
  };
  const afterWord = () => {
    numeric = false;
    capWord = false;
  };

  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    if (it.kind === 'space' || it.kind === 'newline') {
      out += it.kind === 'space' ? ' ' : '\n';
      afterWord();
      continue;
    }
    if (it.kind === 'other') {
      out += it.ch;
      kept++;
      afterWord();
      continue;
    }
    cells++;
    const m = it.mask;

    // capital indicators: one sign = next letter, two = next word, three = passage
    if (m === CAPITAL_SIGN) {
      if (capPassage && cellAt(i + 1) === maskOfDots('3')) {
        capPassage = false;
        i++;
        continue;
      }
      let run = 1;
      while (cellAt(i + run) === CAPITAL_SIGN && run < 3) run++;
      if (run >= 3) capPassage = true;
      else if (run === 2) capWord = true;
      else capNext = true;
      i += run - 1;
      cells += run - 1;
      continue;
    }
    if (m === LETTER_SIGN) {
      numeric = false;
      continue;
    }
    if (m === NUMBER_SIGN) {
      numeric = true;
      continue;
    }

    const letter = CELL_LETTER.get(m);
    if (numeric && letter && DIGIT_LETTER.includes(letter)) {
      out += DIGIT_LETTER.indexOf(letter);
      capWord = false;
      continue;
    }
    if (letter) {
      numeric = false;
      const up = capNext || capWord || capPassage;
      out += up ? letter.toUpperCase() : letter;
      capNext = false;
      continue;
    }

    // two-cell symbols, then one-cell punctuation (a capital word ends at the first of them)
    capWord = false;
    if (PREFIXES.has(m)) {
      const next = cellAt(i + 1);
      const sym = next === null ? undefined : DOUBLE_SYMBOL.get(`${m},${next}`);
      if (sym) {
        out += sym;
        cells++;
        i++;
        numeric = false;
        continue;
      }
    }
    if (m === OPEN_QUOTE) {
      // "?" after a word or on its own, an opening quotation mark where a word starts
      const prev = out[out.length - 1];
      const starts = !prev || /[\s([{]/.test(prev);
      out += starts && items[i + 1]?.kind === 'cell' ? '"' : '?';
      numeric = false;
      continue;
    }
    if (m === CLOSE_QUOTE) {
      out += '"';
      numeric = false;
      continue;
    }
    const single = SINGLE_SYMBOL.get(m);
    if (single) {
      out += single;
      if (!(numeric && (single === ',' || single === '.'))) numeric = false;
      continue;
    }
    out += '?';
    unknown.push({ pos: it.pos, dots: dotsOf(m) });
  }
  return { text: out, cells, unknown, kept };
}

// ---------------------------------------------------------------------------------------------
// Text to cells
// ---------------------------------------------------------------------------------------------

export interface BrailleCells {
  /** Masks, 0 for a blank cell, -1 for a line break. */
  masks: number[];
  /** Characters with no cell in grade 1, left out. */
  skipped: string[];
}

/**
 * Lower-case letters, a capital sign (or two for an all-capitals word of 2+ letters), the number
 * sign before a run of digits (and a letter sign before a-j right after them) and the
 * punctuation of the tables. Quotation marks open where a word starts and close elsewhere.
 */
export function textToBraille(text: string): BrailleCells {
  const masks: number[] = [];
  const skipped: string[] = [];
  const chars = [...text];
  let numeric = false;
  const skip = (ch: string) => {
    if (!skipped.includes(ch)) skipped.push(ch);
  };

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    if (ch === '\r') continue;
    if (ch === '\n') {
      masks.push(-1);
      numeric = false;
      continue;
    }
    if (/\s/.test(ch)) {
      masks.push(BLANK);
      numeric = false;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      if (!numeric) masks.push(NUMBER_SIGN);
      numeric = true;
      masks.push(LETTER_CELL.get(DIGIT_LETTER[Number(ch)]!)!);
      continue;
    }
    if (numeric && (ch === ',' || ch === '.') && /[0-9]/.test(chars[i + 1] ?? '')) {
      masks.push(...SYMBOL_CELL.get(ch)!);
      continue;
    }
    if (/[A-Za-z]/.test(ch)) {
      const lower = ch.toLowerCase();
      if (numeric && 'abcdefghij'.includes(lower)) masks.push(LETTER_SIGN);
      numeric = false;
      if (ch !== lower) {
        // an all-capitals word of two or more letters takes one capital-word sign
        const prev = chars[i - 1] ?? '';
        const startsWord = !/[A-Za-z]/.test(prev);
        let end = i;
        while (/[A-Z]/.test(chars[end] ?? '')) end++;
        if (startsWord && end - i >= 2 && !/[a-z]/.test(chars[end] ?? '')) {
          masks.push(CAPITAL_SIGN, CAPITAL_SIGN);
          for (let k = i; k < end; k++) masks.push(LETTER_CELL.get(chars[k]!.toLowerCase())!);
          i = end - 1;
          continue;
        }
        masks.push(CAPITAL_SIGN);
      }
      masks.push(LETTER_CELL.get(lower)!);
      continue;
    }
    numeric = false;
    if (ch === '"' || ch === '“' || ch === '”') {
      const prev = chars[i - 1] ?? ' ';
      const opening = ch === '“' || (ch === '"' && /[\s([{]/.test(prev));
      masks.push(opening ? OPEN_QUOTE : CLOSE_QUOTE);
      continue;
    }
    const sym = SYMBOL_CELL.get(ch === '’' ? "'" : ch === '–' || ch === '—' ? '-' : ch);
    if (sym) masks.push(...sym);
    else skip(ch);
  }
  return { masks, skipped };
}

/** Masks to braille text; a line break stays one. `blank` writes a blank cell for a space. */
export function cellsToString(masks: number[], blank: boolean): string {
  return masks.map((m) => (m === -1 ? '\n' : m === BLANK && !blank ? ' ' : cellChar(m))).join('');
}

// ---------------------------------------------------------------------------------------------
// Bytes: 8-dot cells, dot n is bit n-1
// ---------------------------------------------------------------------------------------------

export const bytesToCells = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => cellChar(b)).join('');

/** Every cell is one byte (a blank cell is 0x00); spaces and line breaks are skipped. */
export function cellsToBytes(items: Item[]): { bytes: Uint8Array; skipped: number } {
  const out: number[] = [];
  let skipped = 0;
  for (const it of items) {
    if (it.kind === 'cell') out.push(it.mask);
    else if (it.kind === 'space' && it.blank) out.push(BLANK);
    else if (it.kind === 'other') {
      throw new ToolError(T('error.notCell', { char: showChar(it.ch), pos: it.pos }));
    } else skipped++;
  }
  return { bytes: Uint8Array.from(out), skipped };
}

/** Dot numbers of the cells, "0" for a blank cell, one line per line. */
function itemsToDots(items: Item[]): string {
  const lines: string[] = [''];
  for (const it of items) {
    if (it.kind === 'newline') lines.push('');
    else if (it.kind === 'cell')
      lines[lines.length - 1] += (lines[lines.length - 1] ? '-' : '') + dotsOf(it.mask);
    else if (it.kind === 'space')
      lines[lines.length - 1] += (lines[lines.length - 1] ? '-' : '') + '0';
    else throw new ToolError(T('error.notCell', { char: showChar(it.ch), pos: it.pos }));
  }
  return lines.join('\n');
}

const itemsToCellString = (items: Item[], blank: boolean): string =>
  items
    .map((it) =>
      it.kind === 'cell'
        ? cellChar(it.mask)
        : it.kind === 'space'
          ? blank
            ? cellChar(BLANK)
            : ' '
          : it.kind === 'newline'
            ? '\n'
            : it.ch,
    )
    .join('');

// ---------------------------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------------------------

export default defineTool({
  id: 'braille',
  name: 'Braille',
  category: 'encoding',
  description:
    'Unicode braille cells (⠃⠗⠁⠊⠇⠇⠑) to English text, bytes (8-dot) or dot numbers (1-25-14), and back.',
  tags: [
    'braille',
    'unicode braille',
    'braille patterns',
    'U+2800',
    'dots',
    '8-dot',
    'tactile',
    'grade 1',
    'ueb',
    'blind',
  ],
  input: 'bytes',
  placeholder: '⠓⠑⠇⠇⠕',
  live: true,
  options: {
    mode: toggle('Mode', ['decode', 'encode']),
    as: toggle('Content', [
      { value: 'text', label: 'English text (grade 1)' },
      { value: 'bytes', label: 'Bytes (8-dot cells)' },
      { value: 'dots', label: 'Dot numbers (1-25-14)' },
    ]),
    blank: bool('Blank cell for spaces', false, {
      hint: 'Write a space as the empty braille cell U+2800 instead of a normal space.',
      showIf: (v) => v.mode === 'encode' && v.as !== 'bytes',
    }),
  },
  examples: [
    { label: 'Decode ⠃⠗⠁⠊⠇⠇⠑', input: '⠃⠗⠁⠊⠇⠇⠑', expect: 'braille' },
    {
      label: 'Capitals, a number and punctuation',
      input: '⠠⠠⠋⠇⠁⠛⠖ ⠠⠙⠑⠇⠞⠁ ⠼⠁⠃⠉⠲⠑',
      expect: 'FLAG! Delta 123.5',
    },
    {
      label: 'Dot numbers',
      input: '125-15-123-123-135-0-2456-135-1235-123-145',
      expect: 'hello world',
    },
    {
      label: 'Encode text',
      input: 'Hello, World 42',
      options: { mode: 'encode' },
      expect: '⠠⠓⠑⠇⠇⠕⠂ ⠠⠺⠕⠗⠇⠙ ⠼⠙⠃',
    },
    {
      label: '8-dot cells as bytes',
      input: '⡦⡬⡡⡧⡻⡢⡲⡡⡩⡬⡬⡥⡟⡢⡹⡴⡥⡳⡽',
      options: { as: 'bytes' },
      expect: 'flag{braille_bytes}',
    },
    {
      label: 'Cells to dot numbers',
      input: '⠃⠗⠁⠊⠇⠇⠑',
      options: { as: 'dots' },
      expect: '12-1235-1-24-123-123-15',
    },
  ],
  detect({ text }) {
    const t = text?.trim() ?? '';
    if (t.length < 3) return null;
    const cells = [...t].filter((c) => isCell(c.codePointAt(0)!)).length;
    const visible = [...t].filter((c) => !/\s/.test(c)).length;
    if (cells >= 3 && cells >= visible * 0.8) {
      const eight = [...t].some((c) => c.codePointAt(0)! - BRAILLE_BASE > 0x3f);
      return {
        score: 0.92,
        options: { mode: 'decode', as: eight ? 'bytes' : 'text' },
        reason: T(eight ? 'detect.cells8' : 'detect.cells'),
      };
    }
    // dot numbers: at least four groups of the digits 1-8, each in ascending order
    const groups = t.split(/[-\s,]+/);
    if (
      groups.length >= 4 &&
      groups.every((g) => /^(?:0|[1-8]+)$/.test(g) && g === [...g].sort().join(''))
    ) {
      try {
        const r = brailleToText(readDots(t));
        const letters = (r.text.match(/[A-Za-z]/g) ?? []).length;
        if (!r.unknown.length && letters >= r.text.replace(/\s/g, '').length * 0.8) {
          return { score: 0.5, options: { mode: 'decode', as: 'text' }, reason: T('detect.dots') };
        }
      } catch {
        return null;
      }
    }
    return null;
  },
  run({ bytes }, { mode, as, blank }) {
    const text = utf8Decode(bytes);
    const out: Output[] = [];

    if (mode === 'encode') {
      if (as === 'bytes') return [{ type: 'text', value: bytesToCells(bytes) }];
      if (as === 'dots') {
        return [{ type: 'text', value: itemsToCellString(readDots(text), blank) }];
      }
      const r = textToBraille(text);
      out.push({ type: 'text', value: cellsToString(r.masks, blank) });
      if (r.skipped.length) {
        out.push({
          type: 'note',
          level: 'info',
          text: T('note.skipped', { chars: r.skipped.slice(0, 20).join(' ') }),
        });
      }
      return out;
    }

    if (!text.trim()) throw new ToolError(T('error.empty'));
    const { items, form } = readBraille(text);
    if (as === 'dots') return [{ type: 'text', value: itemsToDots(items) }];
    if (as === 'bytes') {
      const r = cellsToBytes(items);
      return bytesResult(r.bytes);
    }
    const r = brailleToText(items);
    out.push({ type: 'text', value: r.text });
    if (form === 'dots') out.push({ type: 'note', level: 'info', text: T('note.fromDots') });
    if (r.unknown.length) {
      const list = r.unknown
        .slice(0, 8)
        .map((u) => `${u.dots} (${u.pos})`)
        .join(', ');
      out.push({ type: 'note', level: 'warn', text: T('note.unknown', { dots: list }) });
    }
    if (r.kept) out.push({ type: 'note', level: 'info', text: T('note.kept', { count: r.kept }) });
    return out;
  },
});
