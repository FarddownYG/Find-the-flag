/**
 * Picture alphabets: Pigpen (Freemason), flag Semaphore and Braille. Every symbol is drawn here
 * from a few SVG paths (nothing is copied from a picture or a font), so one table serves the
 * on-screen keyboard, the symbols row of a text, the reference sheet and the tests.
 */
import type { Glyph, GlyphShape } from '../../core/types';

export type AlphabetId = 'pigpen' | 'semaphore' | 'braille';

/** What a symbol is drawn for; `text` is what pressing its key types. */
export interface SymbolKey {
  text: string;
  /** Label under it in the reference sheet and the screen-reader name of its key. */
  name: string;
  glyph: Glyph;
  /**
   * What its keyboard key shows when that is not the glyph itself: a Braille digit is the cell of a
   * letter behind the number sign, so its key shows both cells and cannot be taken for the letter.
   */
  keyGlyph?: Glyph;
  /** The Unicode character that stands for it, when the alphabet has one (Braille cells). */
  unicode?: string;
}

/** One thing in a text: a drawn symbol, a character with no symbol, a word gap or a line break. */
export type Token =
  | { type: 'glyph'; key: SymbolKey; source: string }
  | { type: 'plain'; ch: string }
  | { type: 'space' }
  | { type: 'newline' };

export interface SymbolOptions {
  /** Semaphore: draw the figure as seen from the other side (A's flag on the left). */
  mirror: boolean;
}

export interface Alphabet {
  id: AlphabetId;
  /** Symbols the keyboard offers, in reading order. */
  keys(options: SymbolOptions): SymbolKey[];
  /** Symbols that exist but are put in by the encoder itself (Braille's number sign...). */
  extras(options: SymbolOptions): SymbolKey[];
  tokenize(text: string, options: SymbolOptions): Token[];
  /** The letters a text stands for (Unicode symbols read back as letters). */
  plain(text: string): string;
  /** Columns of the reference sheet. */
  sheetColumns: number;
  /** Width of one symbol's cell in the row (its glyph plus a margin). */
  cellWidth: number;
}

// ---------------------------------------------------------------------------------------------
// shared helpers

const r2 = (n: number): string => String(Math.round(n * 100) / 100);

/** A full circle as path data (so a dot is an ordinary filled shape). */
const circle = (cx: number, cy: number, r: number): string =>
  `M${r2(cx - r)} ${r2(cy)}a${r2(r)} ${r2(r)} 0 1 0 ${r2(2 * r)} 0a${r2(r)} ${r2(r)} 0 1 0 ${r2(-2 * r)} 0z`;

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Letters a-z (any case) and nothing else: what the picture alphabets draw. */
const isLetter = (ch: string): boolean => /^[A-Za-z]$/.test(ch);

function baseTokens(text: string, symbol: (ch: string) => SymbolKey | undefined): Token[] {
  const out: Token[] = [];
  const chars = [...text];
  for (const [i, ch] of chars.entries()) {
    // A line break is \n, \r or \r\n (the \r of a \r\n is skipped).
    if (ch === '\n' || (ch === '\r' && chars[i + 1] !== '\n')) out.push({ type: 'newline' });
    else if (ch === '\r') continue;
    else if (ch === ' ' || ch === '\t' || ch === '\u00a0') out.push({ type: 'space' });
    else {
      const key = symbol(ch);
      out.push(key ? { type: 'glyph', key, source: ch } : { type: 'plain', ch });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Pigpen (Freemason) cipher
//
// The common layout: two tic-tac-toe grids (#) then two X grids. A letter is the part of its
// grid that surrounds its cell (the lines the grid has there), with a dot in the second grid of
// each kind:
//
//     A | B | C        J | K | L        S: top wedge        W: top wedge
//    ---+---+---      ---+---+---       T: left wedge       X: left wedge
//     D | E | F        M | N | O        U: right wedge      Y: right wedge
//    ---+---+---      ---+---+---       V: bottom wedge     Z: bottom wedge
//     G | H | I        P | Q | R        (no dot)            (with a dot)
//    (A-I: no dot)    (J-R: a dot)

const PIG = { lo: 9, hi: 31, mid: 20 };
const { lo, hi, mid } = PIG;

/** The lines drawn around each cell of the # grid (no outline where the grid is open). */
const PIGPEN_GRID: readonly string[] = [
  `M${hi} ${lo}V${hi}H${lo}`, // A: right and bottom
  `M${lo} ${lo}V${hi}H${hi}V${lo}`, // B: left, bottom, right
  `M${lo} ${lo}V${hi}H${hi}`, // C: left and bottom
  `M${lo} ${lo}H${hi}V${hi}H${lo}`, // D: top, right, bottom
  `M${lo} ${lo}H${hi}V${hi}H${lo}Z`, // E: all four sides
  `M${hi} ${lo}H${lo}V${hi}H${hi}`, // F: top, left, bottom
  `M${lo} ${lo}H${hi}V${hi}`, // G: top and right
  `M${lo} ${hi}V${lo}H${hi}V${hi}`, // H: left, top, right (open at the bottom)
  `M${hi} ${lo}H${lo}V${hi}`, // I: top and left
];

/** The four wedges of an X: top, left, right, bottom (S T U V, then W X Y Z with a dot). */
const PIGPEN_WEDGES: readonly { d: string; dot: [number, number] }[] = [
  { d: `M${lo} ${lo}L${mid} ${mid}L${hi} ${lo}`, dot: [mid, 12.5] },
  { d: `M${lo} ${lo}L${mid} ${mid}L${lo} ${hi}`, dot: [12.5, mid] },
  { d: `M${hi} ${lo}L${mid} ${mid}L${hi} ${hi}`, dot: [27.5, mid] },
  { d: `M${lo} ${hi}L${mid} ${mid}L${hi} ${hi}`, dot: [mid, 27.5] },
];

function pigpenGlyph(letter: string): Glyph {
  const i = LETTERS.indexOf(letter);
  const dotted = (i >= 9 && i < 18) || i >= 22;
  const shapes: GlyphShape[] = [];
  if (i < 18) {
    shapes.push({ d: PIGPEN_GRID[i % 9]! });
    if (dotted) shapes.push({ d: circle(mid, mid, 2.7), fill: 'ink', stroke: 'none' });
  } else {
    const wedge = PIGPEN_WEDGES[(i - 18) % 4]!;
    shapes.push({ d: wedge.d });
    if (dotted)
      shapes.push({ d: circle(wedge.dot[0], wedge.dot[1], 2.7), fill: 'ink', stroke: 'none' });
  }
  return { w: 40, h: 40, shapes };
}

const PIGPEN_KEYS: readonly SymbolKey[] = [...LETTERS].map((l) => ({
  text: l,
  name: l,
  glyph: pigpenGlyph(l),
}));

const pigpenByLetter = new Map(PIGPEN_KEYS.map((k) => [k.text, k]));

const pigpen: Alphabet = {
  id: 'pigpen',
  keys: () => [...PIGPEN_KEYS],
  extras: () => [],
  tokenize: (text) =>
    baseTokens(text, (ch) => (isLetter(ch) ? pigpenByLetter.get(ch.toUpperCase()) : undefined)),
  plain: (text) => text,
  sheetColumns: 9,
  cellWidth: 46,
};

// ---------------------------------------------------------------------------------------------
// Flag semaphore
//
// Eight arm positions, numbered from straight down (0) by steps of 45 degrees towards the right
// of the picture: 0 down, 1 low right, 2 right, 3 high right, 4 up, 5 high left, 6 left,
// 7 low left. A letter is the pair of positions of the two arms (arms are interchangeable).

const SEMAPHORE_PAIRS: Record<string, readonly [number, number]> = {
  A: [0, 1],
  B: [0, 2],
  C: [0, 3],
  D: [0, 4],
  E: [0, 5],
  F: [0, 6],
  G: [0, 7],
  H: [1, 2],
  I: [1, 3],
  J: [4, 6],
  K: [1, 4],
  L: [1, 5],
  M: [1, 6],
  N: [1, 7],
  O: [2, 3],
  P: [2, 4],
  Q: [2, 5],
  R: [2, 6],
  S: [2, 7],
  T: [3, 4],
  U: [3, 5],
  V: [4, 7],
  W: [5, 6],
  X: [5, 7],
  Y: [3, 6],
  Z: [6, 7],
};

const SEM = { w: 60, h: 72, cx: 30, shoulderY: 25, shoulderDx: 6, arm: 9, pole: 13, flag: 11 };
const FLAG_RED = '#d83a34';
const FLAG_YELLOW = '#f2c200';

type Vec = [number, number];

/** Unit vector of arm position i (0 = down, 2 = right, 4 = up), y pointing down the picture. */
const armDirection = (i: number): Vec => {
  const a = (i * Math.PI) / 4;
  return [Math.sin(a), Math.cos(a)];
};

/** Which shoulder an arm hangs from: -1 left, +1 right, 0 either (straight up or down). */
const sideOf = (i: number): number => (i >= 1 && i <= 3 ? 1 : i >= 5 ? -1 : 0);

function semaphoreGlyph(pair: readonly [number, number], mirror: boolean): Glyph {
  const [pa, pb] = pair;
  const sa = sideOf(pa);
  const sb = sideOf(pb);
  // Straight up or down takes the shoulder the other arm leaves free (D: down left, up right).
  const sides: [number, number] = [sa || (sb === 0 ? -1 : -sb), sb || (sa === 0 ? 1 : -sa)];
  const arms = [pa, pb].map((p, n) => ({ p, side: sides[n]!, dir: armDirection(p) }));
  const sameShoulder = arms[0]!.side === arms[1]!.side;
  const shapes: GlyphShape[] = [];
  const { cx, shoulderY: sy, shoulderDx: dx } = SEM;
  const flip = (x: number) => (mirror ? 2 * cx - x : x);
  const line = (x1: number, y1: number, x2: number, y2: number, width = 2.6): GlyphShape => ({
    d: `M${r2(flip(x1))} ${r2(y1)}L${r2(flip(x2))} ${r2(y2)}`,
    width,
  });
  // The figure: head, shoulders, body and legs.
  shapes.push({ d: circle(flip(cx), 12, 4.5), width: 2.2 });
  shapes.push(line(cx, 16.5, cx, 46, 2.6));
  shapes.push(line(cx - dx, sy, cx + dx, sy, 2.6));
  shapes.push(line(cx, 46, cx - 6, 69, 2.6));
  shapes.push(line(cx, 46, cx + 6, 69, 2.6));
  for (const [n, arm] of arms.entries()) {
    const other = arms[1 - n]!;
    const [ux, uy] = arm.dir;
    const x0 = cx + arm.side * dx;
    const hand: Vec = [x0 + ux * SEM.arm, sy + uy * SEM.arm];
    const tip: Vec = [x0 + ux * (SEM.arm + SEM.pole), sy + uy * (SEM.arm + SEM.pole)];
    // The flag hangs on the side of the pole that points away from the other arm; arms from
    // different shoulders point outwards, and a horizontal pole carries its flag above it.
    const cand: [Vec, Vec] = [
      [uy, -ux],
      [-uy, ux],
    ];
    const score = (c: Vec): number =>
      (sameShoulder ? -(c[0] * other.dir[0] + c[1] * other.dir[1]) : c[0] * arm.side) - c[1] * 0.01;
    const perp = score(cand[0]) >= score(cand[1]) ? cand[0] : cand[1];
    const near: Vec = [hand[0] + ux * 2, hand[1] + uy * 2];
    const f = SEM.flag;
    const p0 = near;
    const p1 = tip;
    const p2: Vec = [tip[0] + perp[0] * f, tip[1] + perp[1] * f];
    const p3: Vec = [near[0] + perp[0] * f, near[1] + perp[1] * f];
    const pt = (p: Vec) => `${r2(flip(p[0]))} ${r2(p[1])}`;
    shapes.push(line(x0, sy, hand[0], hand[1], 2.8));
    shapes.push(line(hand[0], hand[1], tip[0], tip[1], 1.6));
    shapes.push({ d: `M${pt(p0)}L${pt(p1)}L${pt(p3)}Z`, fill: FLAG_RED, stroke: 'none' });
    shapes.push({ d: `M${pt(p1)}L${pt(p2)}L${pt(p3)}Z`, fill: FLAG_YELLOW, stroke: 'none' });
  }
  return { w: SEM.w, h: SEM.h, shapes };
}

const semaphoreKeys = (mirror: boolean): SymbolKey[] =>
  [...LETTERS].map((l) => ({
    text: l,
    name: l,
    glyph: semaphoreGlyph(SEMAPHORE_PAIRS[l]!, mirror),
  }));

const semaphore: Alphabet = {
  id: 'semaphore',
  keys: ({ mirror }) => semaphoreKeys(mirror),
  extras: () => [],
  tokenize: (text, { mirror }) => {
    const byLetter = new Map(semaphoreKeys(mirror).map((k) => [k.text, k]));
    return baseTokens(text, (ch) => (isLetter(ch) ? byLetter.get(ch.toUpperCase()) : undefined));
  },
  plain: (text) => text,
  sheetColumns: 9,
  cellWidth: 66,
};

// ---------------------------------------------------------------------------------------------
// Braille (English, grade 1): letters, digits behind the number sign, a few punctuation marks.
// A cell is six dots numbered 1 2 3 down the left column and 4 5 6 down the right one; as a
// Unicode character it is U+2800 plus one bit per raised dot (dot 1 = 1, dot 2 = 2, dot 3 = 4,
// dot 4 = 8, dot 5 = 16, dot 6 = 32).

/** Letters by the dots that are raised. */
const BRAILLE_DOTS: Record<string, string> = {
  a: '1',
  b: '12',
  c: '14',
  d: '145',
  e: '15',
  f: '124',
  g: '1245',
  h: '125',
  i: '24',
  j: '245',
  k: '13',
  l: '123',
  m: '134',
  n: '1345',
  o: '135',
  p: '1234',
  q: '12345',
  r: '1235',
  s: '234',
  t: '2345',
  u: '136',
  v: '1236',
  w: '2456',
  x: '1346',
  y: '13456',
  z: '1356',
};

const BRAILLE_PUNCTUATION: Record<string, string> = {
  ',': '2',
  ';': '23',
  ':': '25',
  '.': '256',
  '!': '235',
  '?': '236',
  "'": '3',
  '-': '36',
};

const NUMBER_SIGN = '3456';
const LETTER_SIGN = '56';
const CAPITAL_SIGN = '6';

const cellMask = (dots: string): number =>
  [...dots].reduce((m, d) => m | (1 << (Number(d) - 1)), 0);
export const brailleChar = (dots: string): string => String.fromCodePoint(0x2800 + cellMask(dots));

function brailleGlyph(mask: number, dx = 0): Glyph {
  const xs = [11 + dx, 23 + dx];
  const ys = [9, 22, 35];
  const shapes: GlyphShape[] = [];
  for (let dot = 0; dot < 6; dot++) {
    // Dots 1-3 down the left column, 4-6 down the right one.
    const cx = xs[Math.floor(dot / 3)]!;
    const cy = ys[dot % 3]!;
    if (mask & (1 << dot)) {
      shapes.push({ d: circle(cx, cy, 4.7), fill: 'ink', stroke: 'none' });
    } else shapes.push({ d: circle(cx, cy, 2), fill: 'ink', stroke: 'none', opacity: 0.16 });
  }
  return { w: 34 + dx, h: 44, shapes };
}

const brailleKey = (text: string, name: string, dots: string): SymbolKey => ({
  text,
  name,
  glyph: brailleGlyph(cellMask(dots)),
  unicode: brailleChar(dots),
});

/** The cell for the digit d (1-9, 0): the cell of a-j. */
const DIGIT_LETTER = 'jabcdefghi';

const BRAILLE_KEYS: readonly SymbolKey[] = [
  ...Object.entries(BRAILLE_DOTS).map(([l, dots]) => brailleKey(l, l, dots)),
  ...[...'1234567890'].map((d) => {
    const key = brailleKey(d, d, BRAILLE_DOTS[DIGIT_LETTER[Number(d)]!]!);
    // On the keyboard a digit is drawn as it is printed: the number sign, then its cell.
    const number = brailleGlyph(cellMask(NUMBER_SIGN));
    const cell = brailleGlyph(cellMask(BRAILLE_DOTS[DIGIT_LETTER[Number(d)]!]!), 30);
    return { ...key, keyGlyph: { ...cell, shapes: [...number.shapes, ...cell.shapes] } };
  }),
  ...Object.entries(BRAILLE_PUNCTUATION).map(([p, dots]) => brailleKey(p, p, dots)),
];

const BRAILLE_EXTRAS: readonly SymbolKey[] = [
  brailleKey('', 'number', NUMBER_SIGN),
  brailleKey('', 'letter', LETTER_SIGN),
  brailleKey('', 'capital', CAPITAL_SIGN),
];

const brailleByText = new Map(BRAILLE_KEYS.map((k) => [k.text, k]));
const [NUMBER_KEY, LETTER_KEY] = BRAILLE_EXTRAS as [SymbolKey, SymbolKey, SymbolKey];

/** A braille cell from the Unicode block as a drawn symbol (any of the 64 six-dot patterns). */
function cellFromUnicode(ch: string): SymbolKey {
  const mask = ch.codePointAt(0)! - 0x2800;
  return { text: '', name: ch, glyph: brailleGlyph(mask & 0x3f), unicode: ch };
}

const isCell = (ch: string): boolean => /^[\u2800-\u28ff]$/.test(ch);

function brailleTokens(text: string): Token[] {
  const out: Token[] = [];
  let digits = false;
  const chars = [...text];
  for (const [i, ch] of chars.entries()) {
    if (ch === '\n' || ch === '\r') {
      if (ch === '\n' || chars[i + 1] !== '\n') out.push({ type: 'newline' });
      digits = false;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\u00a0' || ch === '\u2800') {
      out.push({ type: 'space' });
      digits = false;
      continue;
    }
    if (isCell(ch)) {
      out.push({ type: 'glyph', key: cellFromUnicode(ch), source: ch });
      digits = false;
      continue;
    }
    const lower = ch.toLowerCase();
    const key = brailleByText.get(lower);
    if (!key) {
      out.push({ type: 'plain', ch });
      digits = false;
      continue;
    }
    const isDigit = /^[0-9]$/.test(lower);
    if (isDigit && !digits) out.push({ type: 'glyph', key: NUMBER_KEY, source: '' });
    // A letter a-j right behind a number would be read as a digit: the letter sign says it is not.
    if (!isDigit && digits && /^[a-j]$/.test(lower)) {
      out.push({ type: 'glyph', key: LETTER_KEY, source: '' });
    }
    out.push({ type: 'glyph', key, source: ch });
    digits = isDigit;
  }
  return out;
}

/** Cells to letters: number sign, letter sign and capital signs are understood, the rest stays. */
export function brailleToText(text: string): string {
  const byMask = new Map<number, string>();
  for (const [l, dots] of Object.entries(BRAILLE_DOTS)) byMask.set(cellMask(dots), l);
  const punct = new Map<number, string>();
  for (const [p, dots] of Object.entries(BRAILLE_PUNCTUATION)) punct.set(cellMask(dots), p);
  let out = '';
  let digits = false;
  // 0: lower case, 1: the next letter is a capital, 2: capitals until the end of the word.
  let capitals = 0;
  let afterCapital = false;
  for (const ch of text) {
    const wasCapital = afterCapital;
    afterCapital = false;
    if (!isCell(ch)) {
      out += ch;
      digits = false;
      capitals = 0;
      continue;
    }
    const mask = (ch.codePointAt(0)! - 0x2800) & 0x3f;
    if (mask === 0) {
      out += ' ';
      digits = false;
      capitals = 0;
    } else if (mask === cellMask(NUMBER_SIGN)) digits = true;
    else if (mask === cellMask(LETTER_SIGN)) digits = false;
    else if (mask === cellMask(CAPITAL_SIGN)) {
      capitals = wasCapital ? 2 : 1;
      afterCapital = true;
    } else {
      const letter = byMask.get(mask);
      if (letter && digits && /^[a-j]$/.test(letter)) {
        out += String(DIGIT_LETTER.indexOf(letter));
      } else if (letter) {
        out += capitals ? letter.toUpperCase() : letter;
        if (capitals === 1) capitals = 0;
        digits = false;
      } else {
        out += punct.get(mask) ?? ch; // no such sign in grade 1: the cell stays as it is
        digits = false;
      }
    }
  }
  return out;
}

const braille: Alphabet = {
  id: 'braille',
  keys: () => [...BRAILLE_KEYS],
  extras: () => [...BRAILLE_EXTRAS],
  tokenize: (text) => brailleTokens(text),
  plain: brailleToText,
  sheetColumns: 11,
  cellWidth: 40,
};

// ---------------------------------------------------------------------------------------------

export const ALPHABETS: Record<AlphabetId, Alphabet> = { pigpen, semaphore, braille };

export const ALPHABET_IDS = Object.keys(ALPHABETS) as AlphabetId[];

/** Every semaphore pair, for the tests: no two letters share a pair of arm positions. */
export const SEMAPHORE_POSITIONS: Readonly<Record<string, readonly [number, number]>> =
  SEMAPHORE_PAIRS;
