/**
 * A small JavaScript tokenizer: enough to tell strings, template literals, comments, regular
 * expression literals, words, numbers and punctuation apart, so the static peeler and the beautifier
 * never touch the inside of a string or a comment. It does not parse; it never runs anything.
 * Linear time, one pass.
 */

export type TokKind = 'ws' | 'comment' | 'string' | 'template' | 'regex' | 'word' | 'num' | 'punct';

export interface Tok {
  kind: TokKind;
  start: number;
  end: number;
  /** ws: the run holds a line break · comment: a line comment, or a block one spanning lines. */
  nl?: boolean;
  /** string: not closed before the end of the line (so it is not a literal to rewrite). */
  bad?: boolean;
}

const PUNCT = [
  '>>>=',
  '...',
  '===',
  '!==',
  '**=',
  '<<=',
  '>>=',
  '>>>',
  '&&=',
  '||=',
  '??=',
  '=>',
  '==',
  '!=',
  '<=',
  '>=',
  '&&',
  '||',
  '??',
  '?.',
  '++',
  '--',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '&=',
  '|=',
  '^=',
  '**',
  '<<',
  '>>',
];

/** Punctuators by their first character, longest first. */
const PUNCT_BY_FIRST = new Map<string, string[]>();
for (const p of PUNCT) {
  const list = PUNCT_BY_FIRST.get(p[0]!) ?? [];
  list.push(p);
  PUNCT_BY_FIRST.set(p[0]!, list);
}
for (const list of PUNCT_BY_FIRST.values()) list.sort((a, b) => b.length - a.length);

/** Words after which a `/` starts a regular expression, not a division. */
const REGEX_AFTER = new Set([
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

const NUMBER =
  /(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?)n?/y;

const isLineBreak = (c: number): boolean => c === 10 || c === 13 || c === 0x2028 || c === 0x2029;

/** JavaScript white space (not line breaks). */
export const isSpace = (c: number): boolean =>
  c === 9 ||
  c === 11 ||
  c === 12 ||
  c === 32 ||
  c === 0xa0 ||
  c === 0xfeff ||
  c === 0x1680 ||
  (c >= 0x2000 && c <= 0x200a) ||
  c === 0x202f ||
  c === 0x205f ||
  c === 0x3000;

const isWordStart = (c: number): boolean =>
  (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36 || c > 127;
const isWordPart = (c: number): boolean => isWordStart(c) || (c >= 48 && c <= 57);

/** End of the string literal that opens at `i` (exclusive), and whether it was closed. */
function scanString(src: string, i: number): { end: number; closed: boolean } {
  const quote = src[i]!;
  let j = i + 1;
  while (j < src.length) {
    const c = src[j]!;
    if (c === '\\') {
      j += src[j + 1] === '\r' && src[j + 2] === '\n' ? 3 : 2;
      continue;
    }
    if (c === quote) return { end: j + 1, closed: true };
    if (c === '\n' || c === '\r') return { end: j, closed: false };
    j++;
  }
  return { end: src.length, closed: false };
}

/** End of the template literal that opens at `i` (exclusive); `${…}` parts are skipped whole. */
function scanTemplate(src: string, i: number): number {
  let j = i + 1;
  while (j < src.length) {
    const c = src[j]!;
    if (c === '\\') j += 2;
    else if (c === '`') return j + 1;
    else if (c === '$' && src[j + 1] === '{') j = skipExpression(src, j + 2);
    else j++;
  }
  return src.length;
}

/** From just after `${` to just after the matching `}`. */
function skipExpression(src: string, i: number): number {
  let depth = 1;
  let j = i;
  while (j < src.length) {
    const c = src[j]!;
    if (c === '"' || c === "'") j = scanString(src, j).end;
    else if (c === '`') j = scanTemplate(src, j);
    else if (c === '/' && src[j + 1] === '/') {
      while (j < src.length && !isLineBreak(src.charCodeAt(j))) j++;
    } else if (c === '/' && src[j + 1] === '*') {
      const close = src.indexOf('*/', j + 2);
      j = close < 0 ? src.length : close + 2;
    } else {
      if (c === '{') depth++;
      else if (c === '}' && --depth === 0) return j + 1;
      j++;
    }
  }
  return src.length;
}

/** End of the regular expression literal that opens at `i`, or -1 if this is not one. */
function scanRegex(src: string, i: number): number {
  let j = i + 1;
  let inClass = false;
  while (j < src.length) {
    const c = src[j]!;
    if (c === '\\') j += 2;
    else if (isLineBreak(src.charCodeAt(j))) return -1;
    else if (c === '[') {
      inClass = true;
      j++;
    } else if (c === ']') {
      inClass = false;
      j++;
    } else if (c === '/' && !inClass) {
      j++;
      while (j < src.length && isWordPart(src.charCodeAt(j))) j++;
      return j;
    } else j++;
  }
  return -1;
}

/** Split `src` into tokens that cover it completely and in order. */
export function lex(src: string): Tok[] {
  const toks: Tok[] = [];
  let prev: { kind: TokKind; text: string } | null = null;
  let i = 0;
  const n = src.length;

  const regexAllowed = (): boolean => {
    if (!prev) return true;
    if (prev.kind === 'punct') return ![')', ']', '++', '--'].includes(prev.text);
    if (prev.kind === 'word') return REGEX_AFTER.has(prev.text);
    return false;
  };
  const push = (t: Tok): void => {
    toks.push(t);
    if (t.kind !== 'ws' && t.kind !== 'comment') {
      prev = {
        kind: t.kind,
        text: t.kind === 'word' || t.kind === 'punct' ? src.slice(t.start, t.end) : '',
      };
    }
    i = t.end;
  };

  while (i < n) {
    const c = src.charCodeAt(i);
    const ch = src[i]!;
    if (isSpace(c) || isLineBreak(c)) {
      let j = i;
      let nl = false;
      while (j < n && (isSpace(src.charCodeAt(j)) || isLineBreak(src.charCodeAt(j)))) {
        if (isLineBreak(src.charCodeAt(j))) nl = true;
        j++;
      }
      push({ kind: 'ws', start: i, end: j, nl });
    } else if (ch === '/' && src[i + 1] === '/') {
      let j = i + 2;
      while (j < n && !isLineBreak(src.charCodeAt(j))) j++;
      push({ kind: 'comment', start: i, end: j, nl: true });
    } else if (ch === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2);
      const end = close < 0 ? n : close + 2;
      push({ kind: 'comment', start: i, end, nl: /[\n\r\u2028\u2029]/.test(src.slice(i, end)) });
    } else if (ch === '"' || ch === "'") {
      const s = scanString(src, i);
      push({ kind: 'string', start: i, end: s.end, bad: !s.closed });
    } else if (ch === '`') {
      push({ kind: 'template', start: i, end: scanTemplate(src, i) });
    } else if (ch === '/' && regexAllowed()) {
      const end = scanRegex(src, i);
      if (end > 0) push({ kind: 'regex', start: i, end });
      else push({ kind: 'punct', start: i, end: i + 1 });
    } else if (isWordStart(c)) {
      let j = i + 1;
      while (j < n && isWordPart(src.charCodeAt(j))) j++;
      push({ kind: 'word', start: i, end: j });
    } else if (
      (c >= 48 && c <= 57) ||
      (ch === '.' && src.charCodeAt(i + 1) >= 48 && src.charCodeAt(i + 1) <= 57)
    ) {
      NUMBER.lastIndex = i;
      const m = NUMBER.exec(src);
      push({ kind: 'num', start: i, end: m ? i + m[0].length : i + 1 });
    } else {
      let len = 1;
      for (const p of PUNCT_BY_FIRST.get(ch) ?? []) {
        if (src.startsWith(p, i)) {
          len = p.length;
          break;
        }
      }
      // `a?.5:b` is a conditional, not an optional chain.
      if (len === 2 && ch === '?' && src[i + 1] === '.' && /\d/.test(src[i + 2] ?? '')) len = 1;
      push({ kind: 'punct', start: i, end: i + len });
    }
  }
  return toks;
}

// ---------- string literals ----------

const hex = (n: number, width: number): string => n.toString(16).padStart(width, '0');

/** Characters that stay written as an escape: invisible or confusing when printed as they are. */
function mustEscape(cp: number): boolean {
  return (
    cp < 0x20 ||
    (cp >= 0x7f && cp <= 0x9f) ||
    cp === 0x2028 ||
    cp === 0x2029 ||
    cp === 0xfeff ||
    cp === 0xad ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x2069) ||
    (cp >= 0xd800 && cp <= 0xdfff)
  );
}

/** `value` as a JavaScript string literal with the given quote. */
export function quoteJs(value: string, quote: '"' | "'" = '"'): string {
  let out = quote;
  for (const ch of value) {
    const cp = ch.codePointAt(0)!;
    if (ch === '\\') out += '\\\\';
    else if (ch === quote) out += `\\${quote}`;
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (mustEscape(cp)) out += cp < 0x100 ? `\\x${hex(cp, 2)}` : `\\u${hex(cp, 4)}`;
    else out += ch;
  }
  return out + quote;
}
