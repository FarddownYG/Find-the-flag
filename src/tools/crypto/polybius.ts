import { bool, defineTool, text, toggle } from '../../core/define';
import { ToolError } from '../../core/errors';
import { flagForm } from './_classical';

export type Cipher = 'polybius' | 'tap' | 'adfgx';

/** I and J share a cell in the Polybius / ADFGX square. */
const POLYBIUS_LETTERS = 'ABCDEFGHIKLMNOPQRSTUVWXYZ';
/** Tap code drops K (it taps as C). */
const TAP_LETTERS = 'ABCDEFGHIJLMNOPQRSTUVWXYZ';

const ADFGX = 'ADFGX';
const ABCDE = 'ABCDE';

/** 25 letters in reading order: keyword letters first (J folded into I), then the rest. */
export function buildSquare(cipher: Cipher, keyword: string): string {
  const base = cipher === 'tap' ? TAP_LETTERS : POLYBIUS_LETTERS;
  if (cipher === 'tap') return base;
  const seen = new Set<string>();
  let square = '';
  for (const ch of (keyword + base).toUpperCase().replace(/J/g, 'I')) {
    if (/[A-Z]/.test(ch) && !seen.has(ch)) {
      seen.add(ch);
      square += ch;
    }
  }
  return square;
}

/** The letter a character is looked up as (I for J, C for K in tap code). */
const fold = (cipher: Cipher, ch: string): string => {
  if (cipher === 'tap') return ch === 'K' ? 'C' : ch;
  return ch === 'J' ? 'I' : ch;
};

export type TapStyle = 'dots' | 'digits';

/** Encode letters as coordinates; returns the coordinate tokens and word breaks as '/'. */
export function polybiusEncode(
  plain: string,
  cipher: Cipher,
  keyword: string,
  tapStyle: TapStyle,
  spaced: boolean,
): { text: string; skipped: number } {
  const square = buildSquare(cipher, keyword);
  const tokens: string[] = [];
  let skipped = 0;
  let pendingBreak = false;
  for (const raw of plain) {
    if (/\s/.test(raw)) {
      pendingBreak = tokens.length > 0;
      continue;
    }
    if (!/[A-Za-z]/.test(raw)) {
      skipped++;
      continue;
    }
    const i = square.indexOf(fold(cipher, raw.toUpperCase()));
    const row = Math.floor(i / 5);
    const col = i % 5;
    if (pendingBreak && spaced) tokens.push('/');
    pendingBreak = false;
    if (cipher === 'tap' && tapStyle === 'dots') {
      tokens.push('.'.repeat(row + 1) + ' ' + '.'.repeat(col + 1));
    } else if (cipher === 'adfgx') {
      tokens.push(ADFGX[row]! + ADFGX[col]!);
    } else {
      tokens.push(`${row + 1}${col + 1}`);
    }
  }
  if (!tokens.length) throw new ToolError('Nothing to encode: the text has no letters (A-Z).');
  const sep = cipher === 'tap' && tapStyle === 'dots' ? '  ' : ' ';
  return { text: tokens.join(spaced ? sep : ''), skipped };
}

interface Coordinates {
  /** [row, col] pairs, 0-based. */
  pairs: [number, number][];
  /** Indices of pairs that start a new word (a '/' came before them). */
  breaks: Set<number>;
  kind: 'digits' | 'digits0' | 'abcde' | 'adfgx' | 'dots';
}

const DOT = /[.•·*]/;

/** Read coordinates from digits (1-5 or 0-4), letters (A-E or ADFGX) or dot groups (tap code). */
export function readCoordinates(input: string, cipher: Cipher): Coordinates {
  const pairs: [number, number][] = [];
  const breaks = new Set<number>();
  const stripped = input.replace(/[\s/|,;:-]+/g, '');
  if (!stripped) throw new ToolError('Paste the coordinates, for example "23 15 31 31 34".');

  // Tap code written with dots: runs of dots separated by spaces.
  if ([...stripped].every((c) => DOT.test(c))) {
    const groups: number[] = [];
    const wordStarts = new Set<number>();
    let pendingBreak = false;
    for (const token of input.split(/(\/|\||\s+)/)) {
      if (token === '/' || token === '|') {
        pendingBreak = true;
      } else if (token && !/^\s+$/.test(token)) {
        const parts = token.split(/[^.•·*]+/).filter(Boolean);
        for (const p of parts) {
          if (p.length > 5) {
            throw new ToolError(
              `A group of ${p.length} dots is too long: a 5×5 square has 1 to 5 taps.`,
            );
          }
          if (pendingBreak && groups.length % 2 === 0) wordStarts.add(groups.length / 2);
          pendingBreak = false;
          groups.push(p.length);
        }
      }
    }
    if (groups.length % 2) {
      throw new ToolError(
        `Found ${groups.length} dot groups: taps come in pairs (row, column). One group is missing or two were glued together.`,
      );
    }
    for (let i = 0; i < groups.length; i += 2) pairs.push([groups[i]! - 1, groups[i + 1]! - 1]);
    return { pairs, breaks: wordStarts, kind: 'dots' };
  }

  // Digits or letters: one symbol per coordinate, '/' marks a word break.
  const symbols: string[] = [];
  let pending = false;
  for (const ch of input) {
    if (ch === '/' || ch === '|') pending = true;
    else if (/[0-9A-Za-z]/.test(ch)) {
      if (pending && symbols.length % 2 === 0) breaks.add(symbols.length / 2);
      pending = false;
      symbols.push(ch.toUpperCase());
    } else if (!/[\s,;:-]/.test(ch)) {
      throw new ToolError(
        `Unexpected character "${ch}": coordinates are digits 1-5, letters A-E / ADFGX, or dots.`,
      );
    }
  }
  if (symbols.length % 2) {
    throw new ToolError(
      `Found ${symbols.length} coordinate symbols: they come in pairs (row, column), so one is missing.`,
    );
  }
  const joined = symbols.join('');
  let kind: Coordinates['kind'];
  let alphabet: string;
  if (/^[0-9]+$/.test(joined)) {
    const bad = [...joined].find((c) => c > '5');
    if (bad) {
      throw new ToolError(
        `The digit ${bad} is outside 1-5: a 5×5 square only has coordinates 1 to 5.`,
      );
    }
    kind = joined.includes('0') ? 'digits0' : 'digits';
    alphabet = kind === 'digits0' ? '01234' : '12345';
    if (kind === 'digits0' && joined.includes('5')) {
      throw new ToolError('Mixed 0 and 5: use coordinates 1-5 or 0-4, not both.');
    }
  } else if (/^[A-Z]+$/.test(joined)) {
    const set = new Set(joined);
    const inAbcde = [...set].every((c) => ABCDE.includes(c));
    const inAdfgx = [...set].every((c) => ADFGX.includes(c));
    if (!inAbcde && !inAdfgx) {
      throw new ToolError('Coordinate letters must all come from A-E or from A D F G X.');
    }
    kind =
      inAbcde && inAdfgx ? (cipher === 'adfgx' ? 'adfgx' : 'abcde') : inAdfgx ? 'adfgx' : 'abcde';
    alphabet = kind === 'adfgx' ? ADFGX : ABCDE;
  } else {
    throw new ToolError('Do not mix digits and letters in the coordinates.');
  }
  for (let i = 0; i < symbols.length; i += 2) {
    pairs.push([alphabet.indexOf(symbols[i]!), alphabet.indexOf(symbols[i + 1]!)]);
  }
  return { pairs, breaks, kind };
}

export function polybiusDecode(input: string, cipher: Cipher, keyword: string): string {
  const square = buildSquare(cipher, keyword);
  const { pairs, breaks } = readCoordinates(input, cipher);
  let out = '';
  pairs.forEach(([r, c], i) => {
    if (r < 0 || r > 4 || c < 0 || c > 4) {
      throw new ToolError(`Coordinate pair ${i + 1} is outside the 5×5 square.`);
    }
    if (breaks.has(i) && out) out += ' ';
    out += square[r * 5 + c]!;
  });
  return out;
}

export default defineTool({
  id: 'polybius',
  name: 'Polybius / Tap code',
  category: 'crypto',
  description:
    'Polybius square, tap code and ADFGX coordinates: letters to digit pairs, dots or ADFGX.',
  tags: [
    'polybius square',
    'tap code',
    'knock code',
    'prisoner cipher',
    'adfgx',
    'checkerboard',
    'nihilist',
    '5x5',
    'coordinates',
  ],
  input: 'text',
  placeholder: '23 15 31 31 34   or   .. ...  .  ....',
  options: {
    cipher: toggle('Cipher', [
      { value: 'polybius', label: 'Polybius' },
      { value: 'tap', label: 'Tap code' },
      { value: 'adfgx', label: 'ADFGX' },
    ]),
    mode: toggle('Mode', ['decode', 'encode']),
    keyword: text('Keyword', '', {
      placeholder: 'optional, mixes the square',
      showIf: (v) => v.cipher !== 'tap',
    }),
    tapStyle: toggle(
      'Tap notation',
      [
        { value: 'dots', label: 'Dots' },
        { value: 'digits', label: 'Digits' },
      ],
      'dots',
      { showIf: (v) => v.cipher === 'tap' && v.mode === 'encode' },
    ),
    spaced: bool('Space between letters', true, { showIf: (v) => v.mode === 'encode' }),
  },
  examples: [
    {
      label: 'Polybius digits',
      input: '21 31 11 22 35 34 31 54 12 24 45 43 43 41 45 11 42 15',
      expect: 'flag{polybiussquare}',
    },
    {
      label: 'Keyword square',
      input: '24 34 21 25 33 12 54 52 42 14 23',
      options: { keyword: 'SECRET' },
      expect: 'flag{keyword}',
    },
    {
      label: 'Tap code dots',
      input: '.. .  ... .  . .  .. ..  .... ....  . .  ... .....  . ...  ... ....  . ....  . .....',
      options: { cipher: 'tap' },
      expect: 'flag{tapcode}',
    },
    {
      label: 'Encode HELLO',
      input: 'Hello',
      options: { mode: 'encode' },
      expect: '23 15 31 31 34',
    },
    {
      label: 'ADFGX coordinates',
      input: 'DF AX FA FA FG',
      options: { cipher: 'adfgx' },
      expect: 'HELLO',
    },
  ],
  detect({ text: t }) {
    const s = t?.trim() ?? '';
    // Digit pairs 1-5 separated by spaces or commas (a bare digit blob could be anything).
    if (/^([1-5]{2}[\s,]+){4,}[1-5]{2}$/.test(s)) {
      return { score: 0.55, options: { mode: 'decode' as const }, reason: 'Pairs of digits 1-5' };
    }
    if (/^([.•·]{1,5}\s+[.•·]{1,5}\s*[/|]?\s*){4,}$/.test(s)) {
      return {
        score: 0.6,
        options: { cipher: 'tap' as const, mode: 'decode' as const },
        reason: 'Pairs of dot groups (tap code)',
      };
    }
    return null;
  },
  run(input, { cipher, mode, keyword, tapStyle, spaced }) {
    const square = buildSquare(cipher, keyword);
    const labels = cipher === 'adfgx' ? [...ADFGX] : ['1', '2', '3', '4', '5'];
    const squareTable = {
      type: 'table' as const,
      label: cipher === 'tap' ? 'Square (C also stands for K)' : 'Square (I also stands for J)',
      columns: ['', ...labels],
      rows: labels.map((l, r) => [l, ...[...square.slice(r * 5, r * 5 + 5)]]),
    };
    if (mode === 'encode') {
      const { text: out, skipped } = polybiusEncode(input, cipher, keyword, tapStyle, spaced);
      return [
        { type: 'text', value: out },
        squareTable,
        ...(skipped
          ? [
              {
                type: 'note' as const,
                level: 'info' as const,
                text: `${skipped} digit/punctuation character(s) were skipped: only letters have a cell.`,
              },
            ]
          : []),
      ];
    }
    const decoded = polybiusDecode(input, cipher, keyword);
    const flag = flagForm(decoded);
    return [
      { type: 'text', value: decoded },
      ...(flag ? [{ type: 'text' as const, label: 'Flag form', value: flag }] : []),
      squareTable,
      {
        type: 'note',
        level: 'info',
        text:
          cipher === 'tap'
            ? 'Tap code has no K: a decoded C may be a K.'
            : 'The square merges I and J: a decoded I may be a J.',
      },
    ];
  },
});
