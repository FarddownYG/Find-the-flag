import { SQUARES, keyedSquare, type SquareKind } from './_square';

/**
 * Delastelle's fractionating ciphers on a keyed grid: Bifid (a square, two coordinates per
 * symbol) and Trifid (a 3 x 3 x 3 cube, three coordinates per symbol). Pure functions; the tool in
 * bifid.ts adds the options, the tables and the messages.
 *
 * Encrypting a block of L symbols: write every symbol's coordinates as columns, read the lines one
 * after the other (all rows, then all columns; for Trifid layers, rows, columns), and cut that
 * stream into groups of 2 (3) coordinates, each of which names a ciphertext symbol. Decrypting
 * is the same in reverse. With a period, the text is cut into blocks of that many symbols first;
 * period 0 means one block, the whole message.
 */

export type Fractionation = 'bifid' | 'trifid';
export type Direction = 'encrypt' | 'decrypt';

export interface Grid {
  kind: Fractionation;
  /** Coordinates per symbol: 2 (square) or 3 (cube). */
  dims: number;
  /** Length of each coordinate axis: 5 or 6 (Bifid), 3 (Trifid). */
  side: number;
  /** Every cell, layer by layer, row by row. */
  symbols: string[];
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function bifidGrid(kind: SquareKind, key: string): Grid {
  return { kind: 'bifid', dims: 2, side: SQUARES[kind].size, symbols: keyedSquare(kind, key) };
}

/** The 27 symbols of a Trifid cube: the 26 letters and one more. */
export function trifidGrid(extra: string, key: string): Grid {
  const seen = new Set<string>();
  const symbols: string[] = [];
  const take = (s: string) => {
    if (!seen.has(s)) {
      seen.add(s);
      symbols.push(s);
    }
  };
  for (const ch of key) {
    const up = ch.toUpperCase();
    if ((up >= 'A' && up <= 'Z') || up === extra) take(up);
  }
  for (const ch of LETTERS) take(ch);
  take(extra);
  return { kind: 'trifid', dims: 3, side: 3, symbols };
}

/** The symbol a character stands for in a Trifid cube (letters upper-cased, the extra symbol). */
export function trifidSymbol(extra: string, ch: string): string | null {
  const up = ch.toUpperCase();
  if (up.length === 1 && up >= 'A' && up <= 'Z') return up;
  return ch === extra ? extra : null;
}

/** 0-based coordinates of every symbol of the grid. */
export function coordinatesOf(grid: Grid): Map<string, number[]> {
  const { dims, side } = grid;
  const map = new Map<string, number[]>();
  grid.symbols.forEach((s, i) => {
    const c: number[] = [];
    let rest = i;
    for (let k = dims - 1; k >= 0; k--) {
      c[k] = rest % side;
      rest = Math.floor(rest / side);
    }
    map.set(s, c);
  });
  return map;
}

export interface Block {
  /** The block as given: plaintext when encrypting, ciphertext when decrypting. */
  input: string[];
  /** The coordinate lines: one per axis, one number (1-based) per plaintext symbol. */
  lines: number[][];
  /** The lines read one after the other, as the symbols' coordinates are read back. */
  stream: number[];
  output: string[];
}

/** Sizes of the blocks a text of `length` symbols is cut into. */
export function blockSizes(length: number, period: number): number[] {
  if (period <= 0 || period >= length) return length ? [length] : [];
  const sizes: number[] = [];
  for (let at = 0; at < length; at += period) sizes.push(Math.min(period, length - at));
  return sizes;
}

export function fractionate(
  grid: Grid,
  symbols: readonly string[],
  period: number,
  direction: Direction,
): Block[] {
  const { dims, side } = grid;
  const coords = coordinatesOf(grid);
  const at = (c: readonly number[]): string => {
    let i = 0;
    for (const x of c) i = i * side + x;
    return grid.symbols[i]!;
  };
  const blocks: Block[] = [];
  let start = 0;
  for (const size of blockSizes(symbols.length, period)) {
    const input = symbols.slice(start, start + size);
    start += size;
    let lines: number[][];
    let stream: number[];
    let output: string[];
    if (direction === 'encrypt') {
      lines = Array.from({ length: dims }, (_, k) => input.map((s) => coords.get(s)![k]!));
      stream = lines.flat();
      output = Array.from({ length: size }, (_, j) => at(stream.slice(j * dims, j * dims + dims)));
    } else {
      stream = input.flatMap((s) => coords.get(s)!);
      lines = Array.from({ length: dims }, (_, k) => stream.slice(k * size, (k + 1) * size));
      output = Array.from({ length: size }, (_, i) => at(lines.map((line) => line[i]!)));
    }
    blocks.push({
      input,
      lines: lines.map((line) => line.map((x) => x + 1)),
      stream: stream.map((x) => x + 1),
      output,
    });
  }
  return blocks;
}

/** The output of every block, joined. */
export const joinBlocks = (blocks: readonly Block[]): string =>
  blocks.map((b) => b.output.join('')).join('');
