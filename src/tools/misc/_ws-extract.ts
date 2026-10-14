/**
 * Finding a Whitespace program inside a text, and making invisible characters visible.
 *
 * In CTFs the program is hidden in a cover text (a poem, a README...). Depending on the
 * challenge the code is every space/tab/line feed of the file, only the spaces and tabs at the
 * end of each line (plus the line breaks), or whatever lies between two marker strings.
 */

import { classify } from '../stego/_zerowidth';

export interface Extraction {
  /** The program as S/T/L letters. */
  code: string;
  /** 1-based source line of each token of `code`. */
  lines: Int32Array;
}

// ---------- decoding the file ----------

export type Encoding = 'UTF-8' | 'UTF-16LE' | 'UTF-16BE' | 'Latin-1';

export interface Decoded {
  text: string;
  encoding: Encoding;
  /** Why an encoding other than UTF-8 was used. */
  why?: string;
}

/** UTF-16 without a byte order mark: ASCII text has a 0 byte in every other position. */
function utf16Guess(bytes: Uint8Array): 'UTF-16LE' | 'UTF-16BE' | null {
  const n = Math.min(bytes.length, 4096) & ~1;
  if (n < 8) return null;
  let evenZero = 0;
  let oddZero = 0;
  for (let i = 0; i < n; i += 2) {
    if (bytes[i] === 0) evenZero++;
    if (bytes[i + 1] === 0) oddZero++;
  }
  const half = n / 2;
  if (oddZero >= 0.9 * half && evenZero <= 0.1 * half) return 'UTF-16LE';
  if (evenZero >= 0.9 * half && oddZero <= 0.1 * half) return 'UTF-16BE';
  return null;
}

/**
 * Decode a file as text. UTF-8 keeps a leading BOM (the reveal shows it; Whitespace ignores it).
 * UTF-16 is recognised by its byte order mark or by its 0 bytes (Windows "Unicode" files), and a
 * file that is not valid UTF-8 is read as Latin-1. Spaces, tabs and line feeds are the same bytes
 * in UTF-8 and Latin-1, so only how the cover text looks depends on that guess.
 */
export function decodeSource(bytes: Uint8Array): Decoded {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    const text = new TextDecoder('utf-16le').decode(bytes);
    return { text, encoding: 'UTF-16LE', why: 'it starts with the byte order mark FF FE' };
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const text = new TextDecoder('utf-16be').decode(bytes);
    return { text, encoding: 'UTF-16BE', why: 'it starts with the byte order mark FE FF' };
  }
  const guess = utf16Guess(bytes);
  if (guess) {
    const text = new TextDecoder(guess.toLowerCase()).decode(bytes);
    return { text, encoding: guess, why: 'every other byte is 0' };
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    return { text, encoding: 'UTF-8' };
  } catch (e) {
    if (!(e instanceof TypeError)) throw e;
    const text = new TextDecoder('windows-1252').decode(bytes);
    return { text, encoding: 'Latin-1', why: 'it is not valid UTF-8' };
  }
}

// ---------- extractions ----------

const LETTER: Record<string, string> = { ' ': 'S', '\t': 'T', '\n': 'L' };

function collect(text: string, from: number, to: number, firstLine: number): Extraction {
  let code = '';
  const lines: number[] = [];
  let line = firstLine;
  for (let i = from; i < to; i++) {
    const letter = LETTER[text[i]!];
    if (letter) {
      code += letter;
      lines.push(line);
    }
    if (text[i] === '\n') line++;
  }
  return { code, lines: Int32Array.from(lines) };
}

/** 1-based line of a text offset. */
function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = text.indexOf('\n'); i >= 0 && i < offset; i = text.indexOf('\n', i + 1)) line++;
  return line;
}

/** Every space, tab and line feed of the text. */
export const extractAll = (text: string): Extraction => collect(text, 0, text.length, 1);

/** A line's trailing spaces and tabs, ignoring carriage returns among them (CRLF files). */
export function trailingRun(line: string): { visible: string; ws: string } {
  let i = line.length;
  while (i > 0 && (line[i - 1] === ' ' || line[i - 1] === '\t' || line[i - 1] === '\r')) i--;
  return { visible: line.slice(0, i), ws: line.slice(i).replace(/\r/g, '') };
}

/**
 * What a line without trailing spaces/tabs contributes in the trailing extraction: 'count' its
 * line feed (L) like every other line, 'lead' its line feed only once a line with trailing
 * whitespace has been seen (a title or blank lines before the coded stanza are skipped), 'skip'
 * nothing at all.
 */
export type BareLines = 'count' | 'lead' | 'skip';

/** For each line: its trailing spaces/tabs, then its line feed (see `BareLines`). */
export function extractTrailing(text: string, bare: BareLines, firstLine = 1): Extraction {
  const rows = text.split('\n');
  let code = '';
  const lines: number[] = [];
  let started = false;
  rows.forEach((row, i) => {
    const { ws } = trailingRun(row);
    if (ws) started = true;
    for (const ch of ws) {
      code += ch === ' ' ? 'S' : 'T';
      lines.push(firstLine + i);
    }
    const keep = ws !== '' || bare === 'count' || (bare === 'lead' && started);
    if (i < rows.length - 1 && keep) {
      code += 'L';
      lines.push(firstLine + i);
    }
  });
  return { code, lines: Int32Array.from(lines) };
}

export interface MarkerRegion {
  /** Offset just after the start marker. */
  from: number;
  /**
   * When nothing follows the start marker on its line: the offset after that line break. A marker
   * on its own line ends with a line break that is layout, not code.
   */
  lineFrom: number | null;
  /** Offset of the end marker, or the end of the text. */
  to: number;
  /** False when the end marker was not found and the region runs to the end of the text. */
  endFound: boolean;
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;
const isWordChar = (ch: string | undefined) => ch !== undefined && WORD_CHAR.test(ch);

/**
 * First occurrence of `marker` at or after `from` that is not part of a longer word: BEGIN is
 * not found in "BEGINNER", nor END in "LEGEND" (a marker that starts or ends with punctuation has
 * no such constraint on that side). If every occurrence is inside a word, the first one. -1 if the
 * marker does not appear.
 */
export function findMarker(text: string, marker: string, from = 0): number {
  const first = text.indexOf(marker, from);
  const head = isWordChar(marker[0]);
  const tail = isWordChar(marker[marker.length - 1]);
  if (first < 0 || (!head && !tail)) return first;
  for (let at = first; at >= 0; at = text.indexOf(marker, at + 1)) {
    const glued =
      (head && at > from && isWordChar(text[at - 1])) ||
      (tail && isWordChar(text[at + marker.length]));
    if (!glued) return at;
  }
  return first;
}

/**
 * The text between the first `start` marker and the first `end` marker after it (occurrences
 * inside a longer word are passed over, see findMarker). An empty marker means the beginning / the
 * end of the text. Null if `start` is missing.
 */
export function markerRegion(text: string, start: string, end: string): MarkerRegion | null {
  const at = start ? findMarker(text, start) : 0;
  if (at < 0) return null;
  const from = at + start.length;
  const stop = end ? findMarker(text, end, from) : -1;
  const to = stop < 0 ? text.length : stop;
  const brk = start ? /^\r*\n/.exec(text.slice(from, Math.min(to, from + 64))) : null;
  return {
    from,
    lineFrom: brk ? from + brk[0].length : null,
    to,
    endFound: !end || stop >= 0,
  };
}

/** All whitespace of a marker region; `ownLine` skips the line break after the start marker. */
export function extractMarkers(text: string, region: MarkerRegion, ownLine = false): Extraction {
  const from = ownLine && region.lineFrom !== null ? region.lineFrom : region.from;
  return collect(text, from, region.to, lineAt(text, from));
}

/** The trailing extraction applied to the lines of a marker region. */
export function extractMarkersTrailing(
  text: string,
  region: MarkerRegion,
  bare: BareLines,
): Extraction {
  const from = region.lineFrom ?? region.from;
  return extractTrailing(text.slice(from, region.to), bare, lineAt(text, from));
}

// ---------- programs written as S / T / L letters ----------

const WORD = String.raw`\[\s*(?:space|tab|lf|line ?feed|new ?line|nl|enter|cr ?lf)\s*\]`;
const TOKEN_RE = new RegExp(`${WORD}|[stl]`, 'gi');
const WORD_RE = new RegExp(WORD, 'gi');

/** S, T, L (any case) and the words [Space] [Tab] [LF]; everything else is a comment. */
export function extractLetters(text: string): Extraction {
  let code = '';
  const lines: number[] = [];
  let line = 1;
  let scanned = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    for (let i = text.indexOf('\n', scanned); i >= 0 && i < m.index; i = text.indexOf('\n', i + 1))
      line++;
    scanned = m.index;
    const t = m[0];
    const c =
      t.length === 1 ? t.toUpperCase() : /tab/i.test(t) ? 'T' : /space/i.test(t) ? 'S' : 'L';
    code += c;
    lines.push(line);
  }
  return { code, lines: Int32Array.from(lines) };
}

/** True when the text is (almost) only S/T/L letters or [Space]/[Tab]/[LF] words. */
export function looksLikeLetters(text: string): boolean {
  let tokens = 0;
  let other = 0;
  const rest = text.slice(0, 1 << 16).replace(WORD_RE, () => {
    tokens++;
    return ' ';
  });
  for (const ch of rest) {
    if (/[stl]/i.test(ch)) tokens++;
    else if (!/[\s,;:|./_()[\]{}'"`+-]/.test(ch)) other++;
  }
  return tokens >= 8 && other <= tokens * 0.05;
}

// ---------- revealing invisible characters ----------

/**
 * The marker shown instead of an invisible or unusual character, or null for an ordinary one.
 * Space, tab, LF and CR are handled by the caller.
 */
export const invisibleName = (cp: number): string | null => classify(cp)?.abbr ?? null;

/**
 * Program output with its control and invisible characters written ⟨NUL⟩, ⟨BEL⟩... (line feeds,
 * carriage returns, tabs and spaces are kept). `count` is how many were replaced.
 */
export function markInvisible(text: string): { text: string; count: number } {
  let count = 0;
  let out = '';
  for (const ch of text) {
    const sc = classify(ch.codePointAt(0)!, false);
    if (sc) {
      count++;
      out += `⟨${sc.abbr}⟩`;
    } else out += ch;
  }
  return { text: out, count };
}

export interface Revealed {
  text: string;
  /** True when the input was longer than the limit and the view stops early. */
  truncated: boolean;
  /** Count of each unusual character (by marker name), spaces/tabs/LF/CR excluded. */
  special: Map<string, number>;
}

/** Space → ·, tab → →, LF → ⏎ + newline, CR → ␍, invisible characters → ⟨NAME⟩. */
export function reveal(text: string, maxChars = 200_000): Revealed {
  const special = new Map<string, number>();
  const parts: string[] = [];
  let shown = 0;
  let truncated = false;
  for (const ch of text) {
    if (shown >= maxChars) {
      truncated = true;
      break;
    }
    shown++;
    if (ch === ' ') parts.push('·');
    else if (ch === '\t') parts.push('→');
    else if (ch === '\n') parts.push('⏎\n');
    else if (ch === '\r') parts.push('␍');
    else {
      const name = invisibleName(ch.codePointAt(0)!);
      if (name) {
        special.set(name, (special.get(name) ?? 0) + 1);
        parts.push(`⟨${name}⟩`);
      } else parts.push(ch);
    }
  }
  return { text: parts.join(''), truncated, special };
}

/** Like reveal() but keeps ordinary spaces: for previewing the visible part of a line. */
export function revealInline(text: string): string {
  let out = '';
  for (const ch of text) {
    if (ch === ' ') out += ' ';
    else if (ch === '\t') out += '→';
    else if (ch === '\r') out += '␍';
    else {
      const name = invisibleName(ch.codePointAt(0)!);
      out += name ? `⟨${name}⟩` : ch;
    }
  }
  return out;
}

export interface LineSummary {
  line: number;
  visible: string;
  /** Trailing spaces/tabs as S/T letters. */
  trailing: string;
}

/** Per-line split into visible text and trailing whitespace (no row after a final line feed). */
export function summarizeLines(text: string): LineSummary[] {
  const rows = text.split('\n');
  if (rows.length > 1 && rows[rows.length - 1] === '') rows.pop();
  return rows.map((row, i) => {
    const { visible, ws } = trailingRun(row);
    return {
      line: i + 1,
      visible,
      trailing: ws.replace(/ /g, 'S').replace(/\t/g, 'T'),
    };
  });
}
