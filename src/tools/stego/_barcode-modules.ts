/**
 * A barcode written out as text -> a picture the reader can scan (pure).
 *
 * Three notations: modules (one character per module, 1 or ▮ is a bar, 0 or ▯ a space, one line
 * for a 1D code, one line per row for a 2D code), and widths (the width in modules of each bar
 * and space in turn, "2112141..."). The picture is drawn with a quiet zone of light modules.
 */
import { ToolError } from '../../core/errors';
import type { RgbaImage } from '../../core/types';
import { toolT } from '../../i18n/tool-text';

const T = toolT('barcode-pattern');

/** Largest pattern accepted, per side (modules). */
export const MAX_SIDE = 1200;

/** Characters read as a dark module whatever the polarity of 0 and 1. */
const DARK_GLYPHS = new Set([...'▮█■▉▇#|Xx']);
const LIGHT_GLYPHS = new Set([...'▯□░_.·']);

export interface Pattern {
  /** true = dark module. Rows are all the same width. */
  rows: boolean[][];
  cols: number;
}

export interface ParseOptions {
  /** Read 1 as a light module and 0 as a dark one. */
  onesAreLight: boolean;
  /** A space is a light module (otherwise it only separates). */
  spaceIsLight: boolean;
}

function checkSize(cols: number, rows: number): void {
  if (cols > MAX_SIDE || rows > MAX_SIDE) {
    throw new ToolError(T('error.tooLarge', { cols, rows, max: MAX_SIDE }));
  }
}

/** Modules: one character per module, one line per row. */
export function parseModules(text: string, opts: ParseOptions): Pattern {
  const rows: boolean[][] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    const row: boolean[] = [];
    for (const ch of line) {
      if (ch === '1') row.push(!opts.onesAreLight);
      else if (ch === '0') row.push(opts.onesAreLight);
      else if (DARK_GLYPHS.has(ch)) row.push(true);
      else if (LIGHT_GLYPHS.has(ch)) row.push(false);
      else if (ch === ' ') {
        if (opts.spaceIsLight) row.push(false);
      } else if (ch === '\t' || ch === ',' || ch === ';') continue;
      else throw new ToolError(T('error.char', { char: ch, line: i + 1 }));
    }
    if (row.length) rows.push(row);
  });
  if (!rows.length) throw new ToolError(T('error.empty'));
  const cols = rows[0]!.length;
  rows.forEach((row, i) => {
    if (row.length !== cols) {
      throw new ToolError(T('error.rows', { line: i + 1, count: row.length, first: cols }));
    }
  });
  checkSize(cols, rows.length);
  return { rows, cols };
}

/** Widths: bar, space, bar... each given in modules ("211214" or "2 1 1 2 14"). */
export function parseWidths(text: string): Pattern {
  const body = text.trim();
  if (!body) throw new ToolError(T('error.empty'));
  if (/\r?\n\s*\S/.test(body)) throw new ToolError(T('error.widths'));
  const separated = /[\s,;]/.test(body);
  const tokens = separated ? body.split(/[\s,;]+/).filter(Boolean) : [...body];
  const row: boolean[] = [];
  tokens.forEach((token, i) => {
    if (!/^\d+$/.test(token)) throw new ToolError(T('error.widths'));
    const width = Number(token);
    if (width < 1 || width > 99) throw new ToolError(T('error.widths'));
    for (let k = 0; k < width; k++) row.push(i % 2 === 0);
  });
  checkSize(row.length, 1);
  return { rows: [row], cols: row.length };
}

/** The pattern with every module flipped (the other reading of 1 and 0). */
export function flipped(p: Pattern): Pattern {
  return { cols: p.cols, rows: p.rows.map((r) => r.map((m) => !m)) };
}

/**
 * The picture of a pattern: black modules on white with a quiet zone. A single row is a 1D code
 * (bars drawn tall); several rows are a 2D code (square modules).
 */
export function renderPattern(p: Pattern): RgbaImage {
  const oneD = p.rows.length === 1;
  const px = oneD
    ? Math.max(2, Math.min(8, Math.floor(1200 / p.cols)))
    : Math.max(2, Math.min(10, Math.floor(800 / p.cols)));
  const quietX = oneD ? 12 * px : 6 * px;
  const quietY = oneD ? 20 : 6 * px;
  const barHeight = oneD ? 100 : p.rows.length * px;
  const width = p.cols * px + 2 * quietX;
  const height = barHeight + 2 * quietY;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  const dark = (x: number, y: number): boolean => {
    const row = oneD ? p.rows[0]! : p.rows[Math.floor((y - quietY) / px)];
    return row?.[Math.floor((x - quietX) / px)] === true;
  };
  for (let y = quietY; y < quietY + barHeight; y++) {
    for (let x = quietX; x < quietX + p.cols * px; x++) {
      if (!dark(x, y)) continue;
      const i = (y * width + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 0;
    }
  }
  return { width, height, data };
}
