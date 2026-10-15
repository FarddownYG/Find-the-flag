/**
 * Draws the symbols of a picture alphabet as a standalone SVG document (dark ink on white paper,
 * like the pictures a challenge hands out): a row of symbols for a text, and a reference sheet of
 * every symbol with its letter. Pure string building: the output is plain well-formed XML, with
 * every text escaped and no script, font file or external reference in it.
 */
import type { Glyph, GlyphShape } from '../../core/types';
import type { Alphabet, SymbolKey, SymbolOptions, Token } from './_symbols';

export const INK = '#161d2b';
export const PAPER = '#ffffff';

const PAD = 14;

/** Characters XML 1.0 cannot carry (control codes, lone surrogates, U+FFFE/FFFF) become U+FFFD. */
function xmlSafe(text: string): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const ok =
      cp === 0x9 ||
      cp === 0xa ||
      cp === 0xd ||
      (cp >= 0x20 && cp <= 0xd7ff) ||
      (cp >= 0xe000 && cp <= 0xfffd) ||
      (cp >= 0x10000 && cp <= 0x10ffff);
    out += ok ? ch : '�';
  }
  return out;
}

export function xmlEscape(text: string): string {
  return xmlSafe(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const colour = (c: string): string => (c === 'ink' ? INK : c);

function shapeMarkup(s: GlyphShape): string {
  const attrs = [`d="${xmlEscape(s.d)}"`];
  if (s.fill !== undefined) attrs.push(`fill="${xmlEscape(colour(s.fill))}"`);
  if (s.stroke !== undefined) attrs.push(`stroke="${xmlEscape(colour(s.stroke))}"`);
  if (s.width !== undefined && s.width !== 3) attrs.push(`stroke-width="${s.width}"`);
  if (s.opacity !== undefined) attrs.push(`opacity="${s.opacity}"`);
  return `<path ${attrs.join(' ')}/>`;
}

const num = (n: number): string => String(Math.round(n * 100) / 100);

function glyphMarkup(glyph: Glyph, x: number, y: number, char: string | null): string {
  const label = char === null ? '' : ` data-char="${xmlEscape(char)}"`;
  return (
    `<g class="glyph"${label} transform="translate(${num(x)} ${num(y)})">` +
    glyph.shapes.map(shapeMarkup).join('') +
    '</g>'
  );
}

/** A character that has no symbol, drawn as plain text so that a flag keeps its braces. */
function plainMarkup(ch: string, x: number, y: number, size: number): string {
  return (
    `<text class="plain" x="${num(x)}" y="${num(y)}" text-anchor="middle" ` +
    `font-family="monospace" font-size="${num(size)}" fill="${INK}" stroke="none">` +
    `${xmlEscape(ch)}</text>`
  );
}

function svgDocument(width: number, height: number, label: string | null, body: string): string {
  const w = Math.ceil(width);
  const h = Math.ceil(height);
  const aria = label === null ? '' : ` role="img" aria-label="${xmlEscape(label)}"`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"` +
    ` fill="none" stroke="${INK}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"${aria}>` +
    (label === null ? '' : `<title>${xmlEscape(label)}</title>`) +
    `<rect width="${w}" height="${h}" fill="${PAPER}" stroke="none"/>` +
    body +
    '</svg>\n'
  );
}

export interface RowOptions {
  /** Symbols per line before a word moves down. */
  perRow: number;
  /**
   * Put the letters in the file (a title and a data-char on every symbol). A picture meant as a
   * puzzle leaves them out.
   */
  labelled: boolean;
  /** Title and accessible name of the picture (only when labelled). */
  title: string;
}

export interface Row {
  svg: string;
  /** How many drawn symbols the picture holds. */
  glyphs: number;
}

interface Item {
  token: Token;
  width: number;
}

/** The text as a row of symbols, wrapped at word boundaries. */
export function renderRow(alphabet: Alphabet, tokens: Token[], options: RowOptions): Row {
  const cellW = alphabet.cellWidth;
  const first = alphabet.keys({ mirror: false })[0]!.glyph;
  const cellH = first.h;
  const plainW = Math.max(14, cellW * 0.45);
  const spaceW = cellW * 0.6;
  const maxW = Math.max(3, options.perRow) * cellW;
  const lineH = cellH + 12;

  const widthOf = (t: Token): number => (t.type === 'plain' ? plainW : cellW);

  // Split into words (runs of symbols and plain characters) separated by spaces and breaks.
  type Piece = { kind: 'word'; items: Item[] } | { kind: 'space' } | { kind: 'break' };
  const pieces: Piece[] = [];
  let word: Item[] = [];
  const endWord = () => {
    if (word.length) pieces.push({ kind: 'word', items: word });
    word = [];
  };
  for (const token of tokens) {
    if (token.type === 'space') {
      endWord();
      pieces.push({ kind: 'space' });
    } else if (token.type === 'newline') {
      endWord();
      pieces.push({ kind: 'break' });
    } else word.push({ token, width: widthOf(token) });
  }
  endWord();

  const placed: { token: Token; x: number; line: number }[] = [];
  let x = 0;
  let line = 0;
  let widest = 0;
  let pendingSpace = false;
  const newLine = () => {
    widest = Math.max(widest, x);
    line++;
    x = 0;
    pendingSpace = false;
  };
  for (const piece of pieces) {
    if (piece.kind === 'break') newLine();
    else if (piece.kind === 'space') pendingSpace = x > 0;
    else {
      const wordW = piece.items.reduce((sum, i) => sum + i.width, 0);
      if (x > 0 && x + (pendingSpace ? spaceW : 0) + wordW > maxW) newLine();
      if (pendingSpace) x += spaceW;
      pendingSpace = false;
      for (const item of piece.items) {
        // A word longer than a line is cut where the line is full.
        if (x > 0 && x + item.width > maxW + 0.5) newLine();
        placed.push({ token: item.token, x, line });
        x += item.width;
      }
    }
  }
  widest = Math.max(widest, x);

  const width = Math.max(widest, cellW) + 2 * PAD;
  const height = (line + 1) * lineH - 12 + 2 * PAD;
  let glyphs = 0;
  let body = '';
  for (const { token, x: px, line: py } of placed) {
    const left = PAD + px;
    const top = PAD + py * lineH;
    if (token.type === 'glyph') {
      glyphs++;
      const g = token.key.glyph;
      // The letter it stands for; a sign the encoder added has none, a pasted cell is its own.
      const char = options.labelled ? token.key.text || token.source : null;
      body += glyphMarkup(g, left + (cellW - g.w) / 2, top + (cellH - g.h) / 2, char);
    } else if (token.type === 'plain') {
      const size = Math.min(30, cellH * 0.55);
      body += plainMarkup(token.ch, left + plainW / 2, top + cellH / 2 + size * 0.33, size);
    }
  }
  return { svg: svgDocument(width, height, options.labelled ? options.title : null, body), glyphs };
}

/** Every symbol of an alphabet with its letter under it: a sheet to keep or print. */
export function renderSheet(
  alphabet: Alphabet,
  options: SymbolOptions,
  title: string,
  labelOf: (key: SymbolKey) => string = (key) => key.name,
): { svg: string; glyphs: number } {
  const items: SymbolKey[] = [...alphabet.keys(options), ...alphabet.extras(options)];
  const cellW = Math.max(alphabet.cellWidth + 8, 58);
  const glyphH = items[0]!.glyph.h;
  const labelH = 24;
  const cellH = glyphH + labelH + 8;
  const cols = alphabet.sheetColumns;
  const rows = Math.ceil(items.length / cols);
  const headH = 30;
  const width = cols * cellW + 2 * PAD;
  const height = headH + rows * cellH + 2 * PAD;
  let body = `<text class="title" x="${PAD}" y="${PAD + 14}" font-family="monospace" font-size="15" font-weight="bold" fill="${INK}" stroke="none">${xmlEscape(title)}</text>`;
  for (const [i, key] of items.entries()) {
    const left = PAD + (i % cols) * cellW;
    const top = PAD + headH + Math.floor(i / cols) * cellH;
    const g = key.glyph;
    const label = labelOf(key);
    body += glyphMarkup(g, left + (cellW - g.w) / 2, top, key.name);
    body +=
      `<text class="label" x="${num(left + cellW / 2)}" y="${num(top + glyphH + 16)}" ` +
      `text-anchor="middle" font-family="monospace" font-size="${[...label].length > 3 ? 11 : 15}" ` +
      `fill="${INK}" stroke="none">${xmlEscape(label)}</text>`;
  }
  return { svg: svgDocument(width, height, title, body), glyphs: items.length };
}
