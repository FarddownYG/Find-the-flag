/**
 * A small lexer for JavaScript-like text (JS, TS, JSX, JSON, minified bundles): where the string
 * literals and the comments are. It never evaluates anything and never fails: text that is not
 * JavaScript just yields fewer tokens.
 *
 * It knows enough to keep an apostrophe in a comment, a quote inside a regular expression
 * (`/["']/`) or a `//` inside a URL string from confusing what follows. A `/` is a regular
 * expression when the previous significant character cannot end an expression (the usual
 * highlighter rule); after `)`, `]`, `}`, a name or a number it is a division.
 *
 * Cost is linear in the text: a regex jumps to the next quote or slash, so ordinary code between
 * literals is skipped, not walked.
 */

export interface StringToken {
  /** Index of the opening quote. */
  start: number;
  /** Index just after the closing quote. */
  end: number;
  quote: "'" | '"' | '`';
  /** The text between the quotes, escapes not decoded. */
  raw: string;
}

export interface CommentToken {
  start: number;
  end: number;
  block: boolean;
  /** The comment without its comment markers (two slashes, or slash-star and star-slash). */
  text: string;
}

export interface Lexed {
  strings: StringToken[];
  comments: CommentToken[];
}

/** After these characters a `/` starts a regular expression. */
const REGEX_AFTER = new Set([...'(,=:[!&|?{};+-*%<>~^']);
const REGEX_AFTER_WORD = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);
const MAX_TEMPLATE_DEPTH = 24;

const isWordChar = (c: number) =>
  (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36;

/** End (exclusive) of a '…' or "…" literal starting at i, or -1 when it does not close on its line. */
function quotedEnd(src: string, i: number): number {
  const quote = src.charCodeAt(i);
  for (let j = i + 1; j < src.length; j++) {
    const c = src.charCodeAt(j);
    if (c === 92) {
      // A backslash escapes the next character; a backslash before a line break continues the string.
      if (src.charCodeAt(j + 1) === 13 && src.charCodeAt(j + 2) === 10) j += 2;
      else j++;
    } else if (c === quote) return j + 1;
    else if (c === 10 || c === 13) return -1;
  }
  return -1;
}

/** End of a `${ … }` expression whose body starts at j (after the opening brace). */
function expressionEnd(src: string, j: number, depth: number): number {
  let braces = 1;
  while (j < src.length) {
    const c = src[j]!;
    if (c === '{') braces++;
    else if (c === '}') {
      braces--;
      if (braces === 0) return j + 1;
    } else if (c === '"' || c === "'") {
      const e = quotedEnd(src, j);
      if (e > 0) {
        j = e;
        continue;
      }
    } else if (c === '`') {
      const e = templateEnd(src, j, depth + 1);
      if (e > 0) {
        j = e;
        continue;
      }
    }
    j++;
  }
  return src.length;
}

/** End (exclusive) of a template literal starting at i, or -1 when it never closes. */
function templateEnd(src: string, i: number, depth: number): number {
  if (depth > MAX_TEMPLATE_DEPTH) return -1;
  for (let j = i + 1; j < src.length; j++) {
    const c = src[j]!;
    if (c === '\\') j++;
    else if (c === '`') return j + 1;
    else if (c === '$' && src[j + 1] === '{') j = expressionEnd(src, j + 2, depth) - 1;
  }
  return -1;
}

/** Whether the `/` at i begins a regular expression rather than a division. */
function startsRegex(src: string, i: number): boolean {
  let k = i - 1;
  while (k >= 0 && (src[k] === ' ' || src[k] === '\t' || src[k] === '\n' || src[k] === '\r')) k--;
  if (k < 0) return true;
  const p = src[k]!;
  if (REGEX_AFTER.has(p)) return true;
  if (!isWordChar(src.charCodeAt(k))) return false;
  let w = k;
  while (w > 0 && isWordChar(src.charCodeAt(w - 1))) w--;
  return REGEX_AFTER_WORD.has(src.slice(w, k + 1));
}

/** End of a regular expression literal starting at i (flags included), or -1. */
function regexEnd(src: string, i: number): number {
  let inClass = false;
  for (let j = i + 1; j < src.length; j++) {
    const c = src[j]!;
    if (c === '\n' || c === '\r') return -1;
    if (c === '\\') j++;
    else if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) {
      j++;
      while (j < src.length && /[a-z]/i.test(src[j]!)) j++;
      return j;
    }
  }
  return -1;
}

/** Lex `src`; every position is shifted by `offset` (for a script found inside an HTML page). */
export function lexJs(src: string, offset = 0): Lexed {
  const strings: StringToken[] = [];
  const comments: CommentToken[] = [];
  const next = /["'`/]/g;
  let i = 0;
  while (i < src.length) {
    next.lastIndex = i;
    const m = next.exec(src);
    if (!m) break;
    i = m.index;
    const c = src[i]!;
    if (c === '/') {
      const d = src[i + 1];
      if (d === '/') {
        let e = src.indexOf('\n', i);
        if (e < 0) e = src.length;
        comments.push({
          start: offset + i,
          end: offset + e,
          block: false,
          text: src.slice(i + 2, e),
        });
        i = e;
      } else if (d === '*') {
        const close = src.indexOf('*/', i + 2);
        const e = close < 0 ? src.length : close + 2;
        comments.push({
          start: offset + i,
          end: offset + e,
          block: true,
          text: src.slice(i + 2, close < 0 ? src.length : close),
        });
        i = e;
      } else {
        const e = startsRegex(src, i) ? regexEnd(src, i) : -1;
        i = e > 0 ? e : i + 1;
      }
      continue;
    }
    const e = c === '`' ? templateEnd(src, i, 0) : quotedEnd(src, i);
    if (e < 0) {
      i++;
      continue;
    }
    strings.push({
      start: offset + i,
      end: offset + e,
      quote: c as StringToken['quote'],
      raw: src.slice(i + 1, e - 1),
    });
    i = e;
  }
  return { strings, comments };
}

const SIMPLE_ESCAPES: Record<string, string> = {
  n: '\n',
  r: '\r',
  t: '\t',
  b: '\b',
  f: '\f',
  v: '\v',
  '0': '\0',
};

/**
 * The value of a JavaScript string literal body: \xHH, \uHHHH, \u{H…}, \n \t …, octal and line
 * continuations. Anything else after a backslash stands for itself. `encoded` counts the escapes
 * that write a character by its number (hex, unicode or octal), which is how strings are hidden:
 * a caller can tell `"\x66\x6c\x61\x67"` from a stray `\n` or an escaped backslash.
 */
export function unescapeJs(raw: string): { value: string; encoded: number } {
  if (!raw.includes('\\')) return { value: raw, encoded: 0 };
  let out = '';
  let encoded = 0;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (c !== '\\') {
      out += c;
      continue;
    }
    const d = raw[i + 1];
    if (d === undefined) {
      out += c;
      break;
    }
    if (d === 'x' && /^[0-9a-fA-F]{2}$/.test(raw.slice(i + 2, i + 4))) {
      out += String.fromCharCode(parseInt(raw.slice(i + 2, i + 4), 16));
      encoded++;
      i += 3;
    } else if (d === 'u' && raw[i + 2] === '{') {
      const close = raw.indexOf('}', i + 3);
      const hex = close < 0 ? '' : raw.slice(i + 3, close);
      const cp = /^[0-9a-fA-F]{1,6}$/.test(hex) ? parseInt(hex, 16) : NaN;
      if (cp <= 0x10ffff) {
        out += String.fromCodePoint(cp);
        encoded++;
        i = close;
      } else out += d;
    } else if (d === 'u' && /^[0-9a-fA-F]{4}$/.test(raw.slice(i + 2, i + 6))) {
      out += String.fromCharCode(parseInt(raw.slice(i + 2, i + 6), 16));
      encoded++;
      i += 5;
    } else if (/[0-7]/.test(d) && !(d === '0' && !/[0-7]/.test(raw[i + 2] ?? ''))) {
      let j = i + 1;
      while (j < raw.length && j < i + 4 && /[0-7]/.test(raw[j]!)) j++;
      out += String.fromCharCode(parseInt(raw.slice(i + 1, j), 8) & 0xff);
      encoded++;
      i = j - 1;
    } else if (d === '\r' || d === '\n') {
      // A line continuation: nothing is written.
      if (d === '\r' && raw[i + 2] === '\n') i++;
      i++;
    } else {
      out += SIMPLE_ESCAPES[d] ?? d;
      i++;
    }
  }
  return { value: out, encoded };
}

/** Line and column (both 1-based) of text offsets, found by binary search over the line starts. */
export class LineIndex {
  private readonly starts: number[] = [0];

  constructor(text: string) {
    for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) this.starts.push(i + 1);
  }

  at(offset: number): { line: number; col: number } {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, col: offset - this.starts[lo]! + 1 };
  }
}
