/**
 * Keyed squares shared by the polygraphic ciphers (Playfair family, Bifid). A square is a string
 * of size² symbols read row by row; the key puts its distinct symbols first, in order, and the
 * rest of the alphabet follows. Not a tool itself.
 */

export type SquareKind = 'ij' | 'q' | 'digits';

export interface SquareFamily {
  kind: SquareKind;
  /** Side of the square: 5 (25 letters) or 6 (letters and digits). */
  size: number;
  /** Every symbol of the square, in the order a keyless square lists them. */
  alphabet: string;
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export const SQUARES: Record<SquareKind, SquareFamily> = {
  /** 5 x 5, J written as I (the classical square). */
  ij: { kind: 'ij', size: 5, alphabet: 'ABCDEFGHIKLMNOPQRSTUVWXYZ' },
  /** 5 x 5, Q left out (the rarest letter) and J kept. */
  q: { kind: 'q', size: 5, alphabet: 'ABCDEFGHIJKLMNOPRSTUVWXYZ' },
  /** 6 x 6, the 26 letters and the 10 digits. */
  digits: { kind: 'digits', size: 6, alphabet: `${LETTERS}0123456789` },
};

/** What a character becomes in a square: the symbol, 'merged' (J read as I), or null. */
export type Folded = { symbol: string; merged: boolean } | null;

/** The symbol of the square that a character stands for, null when it has no place in it. */
export function foldSymbol(kind: SquareKind, ch: string): Folded {
  const up = ch.toUpperCase();
  if (up.length !== 1) return null;
  if (up >= 'A' && up <= 'Z') {
    if (kind === 'ij' && up === 'J') return { symbol: 'I', merged: true };
    if (kind === 'q' && up === 'Q') return null;
    return { symbol: up, merged: false };
  }
  if (kind === 'digits' && up >= '0' && up <= '9') return { symbol: up, merged: false };
  return null;
}

export interface SymbolRun {
  symbols: string[];
  /** J read as I (kind 'ij'). */
  merged: number;
  /** Q removed (kind 'q'). */
  droppedQ: number;
  /** Digits that a 5 x 5 square cannot hold. */
  droppedDigits: number;
  /** Letters of other alphabets and symbols (whitespace is not counted). */
  droppedOther: number;
}

/** The symbols of a text, with a count of what was merged or left out. */
export function toSymbols(kind: SquareKind, text: string): SymbolRun {
  const run: SymbolRun = { symbols: [], merged: 0, droppedQ: 0, droppedDigits: 0, droppedOther: 0 };
  for (const ch of text) {
    const f = foldSymbol(kind, ch);
    if (f) {
      run.symbols.push(f.symbol);
      if (f.merged) run.merged++;
    } else if (kind === 'q' && (ch === 'q' || ch === 'Q')) run.droppedQ++;
    else if (ch >= '0' && ch <= '9') run.droppedDigits++;
    else if (!/\s/.test(ch)) run.droppedOther++;
  }
  return run;
}

/** The keyed square as size² symbols: the key's distinct symbols, then the rest of the alphabet. */
export function keyedSquare(kind: SquareKind, key: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const take = (s: string) => {
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  };
  for (const ch of key) {
    const f = foldSymbol(kind, ch);
    if (f) take(f.symbol);
  }
  for (const s of SQUARES[kind].alphabet) take(s);
  return out;
}

/** How many symbols of the key are usable (none: the square is the plain alphabet). */
export function keySymbols(kind: SquareKind, key: string): string[] {
  const out: string[] = [];
  for (const ch of key) {
    const f = foldSymbol(kind, ch);
    if (f) out.push(f.symbol);
  }
  return out;
}

/**
 * The shortest keyword that gives this square, or null when the square is not of the form
 * "keyword, then the other symbols in alphabetical order". Longer keywords with the same distinct
 * letters give the same square.
 */
export function shortestKeyword(kind: SquareKind, square: readonly string[]): string | null {
  const alphabet = SQUARES[kind].alphabet;
  for (let k = 0; k <= square.length; k++) {
    const head = square.slice(0, k);
    const used = new Set(head);
    if (used.size !== k) return null;
    const rest = [...alphabet].filter((s) => !used.has(s));
    if (rest.length === square.length - k && rest.every((s, i) => s === square[k + i])) {
      return head.join('');
    }
  }
  return null;
}

/** Rows of a square, for display. */
export function squareRows(square: readonly string[], size: number): string[][] {
  const rows: string[][] = [];
  for (let r = 0; r < size; r++) rows.push(square.slice(r * size, r * size + size));
  return rows;
}
