import { SQUARES, foldSymbol, keyedSquare, type SquareKind } from './_square';

/**
 * Playfair, two-square (side by side or stacked) and four-square on pairs of symbols. Pure
 * functions; the tool in playfair.ts adds the options, the tables and the messages.
 *
 * Conventions (the usual ones, e.g. Wikipedia):
 *  - Playfair: same row -> the letter to the right (left to decrypt), same column -> the one below
 *    (above), else the other two corners of the rectangle, each letter taking the corner in its
 *    own row.
 *  - Two-square, side by side: the first letter is read in the left square, the second in the
 *    right one. The rectangle's other corners give the ciphertext: the first ciphertext letter is
 *    the corner in the first letter's row (in the right square), the second the corner in the
 *    second letter's row (in the left square). Stacked: the same with columns, the first
 *    ciphertext letter in the bottom square.
 *  - Four-square: plain alphabets top-left and bottom-right, key squares top-right (key 1) and
 *    bottom-left (key 2). The first plain letter is read in the top-left square, the second in the
 *    bottom-right one; the first ciphertext letter is in the top-right square at the first
 *    letter's row and the second letter's column, the second in the bottom-left square at the
 *    second letter's row and the first letter's column.
 */

export type Variant = 'playfair' | 'two-horizontal' | 'two-vertical' | 'four-square';
export type Direction = 'encrypt' | 'decrypt';
export type Rule = 'row' | 'column' | 'rectangle' | 'swap-row' | 'swap-column';

export interface Layout {
  variant: Variant;
  kind: SquareKind;
  size: number;
  /** Playfair: the square. Two-square: key 1 (left or top). Four-square: key 1 (top-right). */
  first: string[];
  /** Two-square: key 2 (right or bottom). Four-square: key 2 (bottom-left). */
  second: string[];
  /** Four-square: the plain alphabet square (top-left and bottom-right). */
  plain: string[];
}

export function buildLayout(
  variant: Variant,
  kind: SquareKind,
  key1: string,
  key2: string,
): Layout {
  const first = keyedSquare(kind, key1);
  return {
    variant,
    kind,
    size: SQUARES[kind].size,
    first,
    second: variant === 'playfair' ? first : keyedSquare(kind, key2),
    plain: [...SQUARES[kind].alphabet],
  };
}

export interface Digraph {
  input: string;
  output: string;
  rule: Rule;
  /** 1-based [row, column] of the two input symbols, each in the square it is read in. */
  cells: [[number, number], [number, number]];
}

const indexOf = (square: readonly string[]): Map<string, number> =>
  new Map(square.map((s, i) => [s, i]));

/**
 * Encrypt or decrypt pairs of symbols (each string holds exactly two). `swapped` reverses the two
 * ciphertext letters of every pair of a two-square cipher, which is how some sources order them.
 */
export function crypt(
  layout: Layout,
  direction: Direction,
  pairs: readonly string[],
  swapped = false,
): Digraph[] {
  const { variant, size } = layout;
  const flip = swapped && (variant === 'two-horizontal' || variant === 'two-vertical');
  const encrypting = direction === 'encrypt';
  const at = (square: readonly string[], r: number, c: number): string =>
    square[(((r % size) + size) % size) * size + (((c % size) + size) % size)]!;
  const first = indexOf(layout.first);
  const second = indexOf(layout.second);
  const plain = indexOf(layout.plain);
  const cell = (i: number): [number, number] => [Math.floor(i / size) + 1, (i % size) + 1];
  const split = (i: number) => [Math.floor(i / size), i % size] as const;

  /** One pair, with the letters in the order the rules below expect. */
  function apply(x: string, y: string): Omit<Digraph, 'input'> {
    if (variant === 'playfair') {
      const a = first.get(x)!;
      const b = first.get(y)!;
      const [ra, ca] = split(a);
      const [rb, cb] = split(b);
      const step = encrypting ? 1 : -1;
      let output: string;
      let rule: Rule;
      if (ra === rb) {
        output = at(layout.first, ra, ca + step) + at(layout.first, rb, cb + step);
        rule = 'row';
      } else if (ca === cb) {
        output = at(layout.first, ra + step, ca) + at(layout.first, rb + step, cb);
        rule = 'column';
      } else {
        output = at(layout.first, ra, cb) + at(layout.first, rb, ca);
        rule = 'rectangle';
      }
      return { output, rule, cells: [cell(a), cell(b)] };
    }

    if (variant === 'four-square') {
      // Plain letters are read in the plain square; ciphertext letters in the key squares.
      const a = (encrypting ? plain : first).get(x)!;
      const b = (encrypting ? plain : second).get(y)!;
      const [ra, ca] = split(a);
      const [rb, cb] = split(b);
      const output = encrypting
        ? at(layout.first, ra, cb) + at(layout.second, rb, ca)
        : at(layout.plain, ra, cb) + at(layout.plain, rb, ca);
      return { output, rule: 'rectangle', cells: [cell(a), cell(b)] };
    }

    // Two-square. Encrypting reads x in the first square and y in the second; decrypting reads x
    // in the second square and y in the first (ciphertext lies in the opposite squares).
    const a = (encrypting ? first : second).get(x)!;
    const b = (encrypting ? second : first).get(y)!;
    const [ra, ca] = split(a);
    const [rb, cb] = split(b);
    const horizontal = variant === 'two-horizontal';
    const sameLine = horizontal ? ra === rb : ca === cb;
    const rule: Rule = sameLine ? (horizontal ? 'swap-row' : 'swap-column') : 'rectangle';
    let output: string;
    if (horizontal) {
      // x at (ra, ca) in the left square, y at (rb, cb) in the right one: the first ciphertext
      // letter is in the right square on x's row, the second in the left square on y's row.
      output = encrypting
        ? at(layout.second, ra, cb) + at(layout.first, rb, ca)
        : at(layout.first, ra, cb) + at(layout.second, rb, ca);
    } else {
      // Stacked: x in the top square, y in the bottom one: the first ciphertext letter is in the
      // bottom square on x's column, the second in the top square on y's column.
      output = encrypting
        ? at(layout.second, rb, ca) + at(layout.first, ra, cb)
        : at(layout.first, rb, ca) + at(layout.second, ra, cb);
    }
    return { output, rule, cells: [cell(a), cell(b)] };
  }

  return pairs.map((pair) => {
    // A swapped ciphertext pair is read back to front before it is decrypted.
    const read = flip && !encrypting ? pair[1]! + pair[0]! : pair;
    const r = apply(read[0]!, read[1]!);
    const output = flip && encrypting ? r.output[1]! + r.output[0]! : r.output;
    return { input: pair, output, rule: r.rule, cells: r.cells };
  });
}

export interface Prepared {
  pairs: string[];
  /** Pairs made by splitting a doubled letter: the pair index, the letter and the filler used. */
  split: { pair: number; letter: string; filler: string }[];
  /** The filler added at the end because the length was odd (and the letter it follows). */
  padding: { filler: string; after: string } | null;
}

/** The filler to use after `letter`: the chosen one, unless that would make the pair a double. */
export function fillerAfter(kind: SquareKind, filler: string, letter: string): string {
  if (letter !== filler) return filler;
  const alternatives = ['X', 'Q', 'Z', 'K', 'W'];
  return alternatives.find((c) => c !== filler && foldSymbol(kind, c)?.symbol === c) ?? 'X';
}

/**
 * Cut plaintext symbols into pairs. Playfair cannot encrypt a pair of equal letters, so a double
 * is split with the filler (LL -> LX, then the second L starts the next pair); every variant
 * pads an odd length with the filler.
 */
export function pairUp(
  symbols: readonly string[],
  variant: Variant,
  kind: SquareKind,
  filler: string,
): Prepared {
  const pairs: string[] = [];
  const split: Prepared['split'] = [];
  let padding: Prepared['padding'] = null;
  let i = 0;
  while (i < symbols.length) {
    const a = symbols[i]!;
    const b = symbols[i + 1];
    if (b === undefined) {
      const f = fillerAfter(kind, filler, a);
      pairs.push(a + f);
      padding = { filler: f, after: a };
      i++;
    } else if (variant === 'playfair' && a === b) {
      const f = fillerAfter(kind, filler, a);
      split.push({ pair: pairs.length, letter: a, filler: f });
      pairs.push(a + f);
      i++;
    } else {
      pairs.push(a + b);
      i += 2;
    }
  }
  return { pairs, split, padding };
}

/** Cut ciphertext symbols into pairs; an odd last symbol has no partner and is reported. */
export function pairsOf(symbols: readonly string[]): { pairs: string[]; leftover: string | null } {
  const pairs: string[] = [];
  for (let i = 0; i + 1 < symbols.length; i += 2) pairs.push(symbols[i]! + symbols[i + 1]!);
  return { pairs, leftover: symbols.length % 2 ? symbols[symbols.length - 1]! : null };
}

/**
 * Remove the filler where Playfair put it: between two equal letters (AXA -> AA) and at the very
 * end. A guess: a real X between equal letters (TAXATION) is removed too.
 */
export function stripFiller(symbols: readonly string[], filler: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < symbols.length; i++) {
    const s = symbols[i]!;
    if (s === filler && i > 0 && i + 1 < symbols.length && symbols[i - 1] === symbols[i + 1])
      continue;
    out.push(s);
  }
  if (out.length > 1 && out[out.length - 1] === filler) out.pop();
  return out;
}
