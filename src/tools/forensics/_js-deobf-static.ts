/**
 * The static peeler of the JavaScript deobfuscator: it removes the layers that can be removed by
 * READING the code, never by running it. Each round it
 *
 *  - decodes the escapes written in string literals (\xHH, \uHHHH, \u{…}, octal \141 \75),
 *  - joins "a" + "b" into "ab",
 *  - replaces unescape("…"), decodeURIComponent("…"), String.fromCharCode(…) and atob("…") that
 *    only hold literals by the text they produce,
 *  - opens eval("…") and Function("…")() written as a statement, so the next layer shows up,
 *
 * and starts again, until nothing changes. The decoders are the ones of the Unicode escapes, Char
 * codes, URL and Base64 tools. Whatever needs a real evaluation (a computed key, a loop that
 * builds a string) stays as it is: that is the sandbox's job.
 */
import { fromBase64, isValidUtf8, latin1Decode, utf8Decode } from '../../lib/bytes';
import { charcodeDecode } from '../encoding/charcode';
import { unicodeUnescape } from '../encoding/unicode-escape';
import { urlDecodeOnce } from '../encoding/url';
import { lex, quoteJs, type Tok } from './_js-deobf-lex';

export type PeelRule = 'escapes' | 'concat' | 'unescape' | 'uri' | 'fromCharCode' | 'atob' | 'eval';

export interface PeelStep {
  rule: PeelRule;
  count: number;
}

export interface PeelRound {
  round: number;
  steps: PeelStep[];
  /** The code after this round (cut for the rounds before the last one). */
  code: string;
  /** Length of the whole code after this round. */
  size: number;
}

export interface PeelResult {
  code: string;
  rounds: PeelRound[];
  /** Why it stopped: nothing left to peel, or a limit. */
  stop: 'done' | 'rounds' | 'work';
  changed: boolean;
}

export const MAX_ROUNDS = 20;
/** Total characters read over all the rounds. */
export const MAX_WORK = 24_000_000;
const PREVIEW = 4000;

interface Edit {
  start: number;
  end: number;
  text: string;
}

// ---------- string literals ----------

const SIMPLE: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v' };

/** Length and value of the legacy octal escape whose digits start at `at` (\141, \75, \7, \0). */
function octal(body: string, at: number): [number, number] {
  const max = body[at]! <= '3' ? 3 : 2;
  let len = 0;
  while (len < max && body[at + len]! >= '0' && body[at + len]! <= '7') len++;
  return [parseInt(body.slice(at, at + len), 8), len];
}

/**
 * The value of the text between the quotes of a JavaScript string literal, or null when it is not
 * a valid one. \xHH, \uHHHH, \u{…} and octal escapes go through the Unicode escapes decoder (a
 * run at a time, so surrogate pairs join); the one-letter escapes are read here.
 */
export function decodeJsString(body: string): string | null {
  let out = '';
  let i = 0;
  while (i < body.length) {
    if (body[i] !== '\\') {
      out += body[i]!;
      i++;
      continue;
    }
    const pieces: string[] = [];
    let j = i;
    while (body[j] === '\\') {
      const next = body[j + 1];
      if (next === 'x') {
        if (!/^[0-9a-fA-F]{2}$/.test(body.slice(j + 2, j + 4))) return null;
        pieces.push(body.slice(j, j + 4));
        j += 4;
      } else if (next === 'u' && body[j + 2] === '{') {
        const close = body.indexOf('}', j + 3);
        const digits = close < 0 ? '' : body.slice(j + 3, close);
        if (!/^[0-9a-fA-F]{1,6}$/.test(digits) || parseInt(digits, 16) > 0x10ffff) return null;
        pieces.push(body.slice(j, close + 1));
        j = close + 1;
      } else if (next === 'u') {
        if (!/^[0-9a-fA-F]{4}$/.test(body.slice(j + 2, j + 6))) return null;
        pieces.push(body.slice(j, j + 6));
        j += 6;
      } else if (next !== undefined && next >= '0' && next <= '7') {
        const [value, len] = octal(body, j + 1);
        pieces.push(`\\${value.toString(8).padStart(3, '0')}`);
        j += 1 + len;
      } else break;
    }
    if (pieces.length > 0) {
      const decoded = decodeEscapes(pieces);
      if (decoded === null) return null;
      out += decoded;
      i = j;
      continue;
    }
    const next = body[i + 1];
    if (next === undefined) return null;
    if (next === '\r') {
      i += body[i + 2] === '\n' ? 3 : 2;
      continue;
    }
    if (next === '\n' || next === '\u2028' || next === '\u2029') {
      i += 2;
      continue;
    }
    out += SIMPLE[next] ?? next;
    i += 2;
  }
  return out;
}

/** The escapes of a run, decoded by the Unicode escapes tool a few thousand at a time. */
function decodeEscapes(pieces: string[]): string | null {
  const GROUP = 2000;
  let out = '';
  for (let k = 0; k < pieces.length;) {
    let end = Math.min(pieces.length, k + GROUP);
    // A pair of surrogates is one character: never cut between its two halves.
    while (end < pieces.length && /^\\u[dD][89abAB]/.test(pieces[end - 1]!)) end++;
    const run = pieces.slice(k, end).join('');
    let decoded: string;
    try {
      decoded = unicodeUnescape(run, 'codepoint', false);
    } catch {
      return null;
    }
    // A lone surrogate comes back as U+FFFD: keep such a literal as it was written.
    if (decoded.includes('\ufffd') && !/fffd/i.test(run)) return null;
    out += decoded;
    k = end;
  }
  return out;
}

const bodyOf = (src: string, t: Tok): string => src.slice(t.start + 1, t.end - 1);

function stringValue(src: string, t: Tok): string | null {
  return t.kind === 'string' && !t.bad && t.end - t.start >= 2
    ? decodeJsString(bodyOf(src, t))
    : null;
}

// ---------- token helpers ----------

interface View {
  src: string;
  toks: Tok[];
  /** Indexes in `toks` of the tokens that are neither white space nor comments. */
  sig: number[];
}

function view(src: string): View {
  const toks = lex(src);
  const sig: number[] = [];
  toks.forEach((t, i) => {
    if (t.kind !== 'ws' && t.kind !== 'comment') sig.push(i);
  });
  return { src, toks, sig };
}

const tokAt = (v: View, k: number): Tok | undefined => {
  const i = v.sig[k];
  return i === undefined ? undefined : v.toks[i];
};
const textAt = (v: View, k: number): string => {
  const t = tokAt(v, k);
  return t ? v.src.slice(t.start, t.end) : '';
};
const isPunct = (v: View, k: number, text: string): boolean =>
  tokAt(v, k)?.kind === 'punct' && textAt(v, k) === text;
const isWord = (v: View, k: number, text: string): boolean =>
  tokAt(v, k)?.kind === 'word' && textAt(v, k) === text;

function applyEdits(src: string, edits: Edit[]): string {
  let out = '';
  let at = 0;
  for (const e of edits.sort((a, b) => a.start - b.start)) {
    if (e.start < at) continue;
    out += src.slice(at, e.start) + e.text;
    at = e.end;
  }
  return out + src.slice(at);
}

const GLOBALS = new Set(['window', 'self', 'globalThis']);

/**
 * Where a call of the function named at sig index k starts: that word, or the `window.` / `self.`
 * / `globalThis.` before it. null when it is a method of something else (`x.atob(…)`).
 */
function callStart(v: View, k: number): number | null {
  if (!isPunct(v, k - 1, '.')) return tokAt(v, k)!.start;
  const owner = tokAt(v, k - 2);
  if (owner && owner.kind === 'word' && GLOBALS.has(textAt(v, k - 2)) && !isPunct(v, k - 3, '.')) {
    return owner.start;
  }
  return null;
}

/** `name ( "literal" )` at sig index k: the start and end of the call, and the literal's value. */
function stringCall(
  v: View,
  k: number,
  name: string,
): { edit: [number, number]; value: string } | null {
  if (!isWord(v, k, name) || !isPunct(v, k + 1, '(') || !isPunct(v, k + 3, ')')) return null;
  const arg = tokAt(v, k + 2);
  const start = callStart(v, k);
  const close = tokAt(v, k + 3);
  if (!arg || !close || start === null) return null;
  const value = stringValue(v.src, arg);
  return value === null ? null : { edit: [start, close.end], value };
}

// ---------- the rules ----------

function ruleEscapes(v: View): Edit[] {
  const edits: Edit[] = [];
  for (const t of v.toks) {
    if (t.kind !== 'string' || t.bad) continue;
    const body = bodyOf(v.src, t);
    if (!/\\(?:x|u|[0-7])/.test(body)) continue;
    const value = decodeJsString(body);
    if (value === null) continue;
    const text = quoteJs(value, v.src[t.start] === "'" ? "'" : '"');
    if (text !== v.src.slice(t.start, t.end)) edits.push({ start: t.start, end: t.end, text });
  }
  return edits;
}

/** Tokens that bind tighter than +, or that continue the operand, on the right of a literal. */
const TIGHT_AFTER = new Set(['.', '?.', '[', '(', '*', '/', '%', '**', '++', '--']);
/** Punctuation after which a string literal that is joined with + can start an operand. */
const LOOSE_BEFORE = new Set([
  '(',
  ',',
  '=',
  ':',
  ';',
  '{',
  '}',
  '[',
  '?',
  '&&',
  '||',
  '??',
  '&',
  '|',
  '^',
  '==',
  '!=',
  '===',
  '!==',
  '<',
  '>',
  '<=',
  '>=',
  '<<',
  '>>',
  '>>>',
  '=>',
  '+=',
  '||=',
  '&&=',
  '??=',
]);
const LOOSE_WORDS = new Set([
  'return',
  'throw',
  'case',
  'in',
  'of',
  'instanceof',
  'yield',
  'else',
  'do',
]);

function ruleConcat(v: View): Edit[] {
  const edits: Edit[] = [];
  const { sig } = v;
  for (let k = 0; k < sig.length; k++) {
    const first = tokAt(v, k)!;
    if (first.kind !== 'string' || first.bad || stringValue(v.src, first) === null) continue;
    // The run of  "a" + "b" + "c"  that starts here.
    let last = k;
    while (
      isPunct(v, last + 1, '+') &&
      tokAt(v, last + 2)?.kind === 'string' &&
      stringValue(v.src, tokAt(v, last + 2)!) !== null &&
      !TIGHT_AFTER.has(textAt(v, last + 3)) &&
      tokAt(v, last + 3)?.kind !== 'template'
    ) {
      last += 2;
    }
    if (last === k) continue;
    // What comes before must let the run be one operand: `x * "a" + "b"` and `-"a" + "b"` cannot.
    const before = textAt(v, k - 1);
    const beforeTok = tokAt(v, k - 1);
    let okBefore = k === 0;
    if (!okBefore && beforeTok) {
      if (beforeTok.kind === 'punct') {
        okBefore = LOOSE_BEFORE.has(before);
        if (before === '+') {
          const prior = tokAt(v, k - 2);
          // A binary + (after an operand), not a unary one.
          okBefore =
            !!prior &&
            (prior.kind === 'string' ||
              prior.kind === 'num' ||
              prior.kind === 'template' ||
              (prior.kind === 'word' && !LOOSE_WORDS.has(textAt(v, k - 2))) ||
              [')', ']', '}'].includes(textAt(v, k - 2)));
        }
      } else if (beforeTok.kind === 'word') okBefore = LOOSE_WORDS.has(before);
    }
    if (!okBefore) {
      k = last;
      continue;
    }
    // After the run the next token must not take the last literal for itself either.
    const afterTok = tokAt(v, last + 1);
    if (afterTok && (afterTok.kind === 'template' || TIGHT_AFTER.has(textAt(v, last + 1)))) {
      k = last;
      continue;
    }
    let value = '';
    for (let m = k; m <= last; m += 2) value += stringValue(v.src, tokAt(v, m)!)!;
    edits.push({
      start: first.start,
      end: tokAt(v, last)!.end,
      text: quoteJs(value, v.src[first.start] === "'" ? "'" : '"'),
    });
    k = last;
  }
  return edits;
}

function ruleUnescape(v: View): Edit[] {
  const edits: Edit[] = [];
  for (let k = 0; k < v.sig.length; k++) {
    const call = stringCall(v, k, 'unescape');
    if (!call) continue;
    // unescape() is the browser's own: %XX is a character 0-255, %uXXXX a UTF-16 unit.
    const text = quoteJs(globalThis.unescape(call.value));
    edits.push({ start: call.edit[0], end: call.edit[1], text });
  }
  return edits;
}

function ruleUri(v: View): Edit[] {
  const edits: Edit[] = [];
  for (let k = 0; k < v.sig.length; k++) {
    const call = stringCall(v, k, 'decodeURIComponent');
    if (!call || /%(?![0-9a-fA-F]{2})/.test(call.value)) continue;
    const bytes = urlDecodeOnce(call.value);
    if (!isValidUtf8(bytes)) continue; // decodeURIComponent would throw
    edits.push({ start: call.edit[0], end: call.edit[1], text: quoteJs(utf8Decode(bytes)) });
  }
  return edits;
}

/** A JavaScript integer literal as a number, or null. */
function integerLiteral(text: string): number | null {
  if (/^0\d/.test(text) || text.endsWith('n')) return null; // legacy octal, BigInt
  const n = Number(text.replace(/_/g, ''));
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** The numbers of  ( 1 , 2 , 3 )  or  [ 1 , 2 ]  whose opening bracket is at sig index k. */
function numberList(v: View, k: number, close: string): { values: number[]; end: number } | null {
  const values: number[] = [];
  let m = k + 1;
  for (;;) {
    const t = tokAt(v, m);
    if (t?.kind !== 'num') return null;
    const n = integerLiteral(textAt(v, m));
    if (n === null) return null;
    values.push(n);
    if (isPunct(v, m + 1, ',')) {
      m += 2;
      continue;
    }
    return isPunct(v, m + 1, close) ? { values, end: m + 1 } : null;
  }
}

function ruleFromCharCode(v: View): Edit[] {
  const edits: Edit[] = [];
  for (let k = 0; k < v.sig.length; k++) {
    if (!isWord(v, k, 'String') || isPunct(v, k - 1, '.')) continue;
    // String.fromCharCode  or  String["fromCharCode"]
    let m: number;
    if (isPunct(v, k + 1, '.') && isWord(v, k + 2, 'fromCharCode')) m = k + 3;
    else if (
      isPunct(v, k + 1, '[') &&
      isPunct(v, k + 3, ']') &&
      stringCallName(v, k + 2) === 'fromCharCode'
    )
      m = k + 4;
    else continue;
    let list: { values: number[]; end: number } | null = null;
    if (isPunct(v, m, '(')) {
      list = numberList(v, m, ')');
    } else if (isPunct(v, m, '.') && isWord(v, m + 1, 'apply') && isPunct(v, m + 2, '(')) {
      // String.fromCharCode.apply(null, [72, 105])
      const thisArg = textAt(v, m + 3);
      if (
        ['null', 'undefined', 'String', 'this'].includes(thisArg) &&
        isPunct(v, m + 4, ',') &&
        isPunct(v, m + 5, '[')
      ) {
        const inner = numberList(v, m + 5, ']');
        if (inner && isPunct(v, inner.end + 1, ')'))
          list = { values: inner.values, end: inner.end + 1 };
      }
    }
    if (!list) continue;
    // fromCharCode keeps the low 16 bits of each number.
    const units = list.values.map((n) => n & 0xffff);
    let value: string;
    try {
      value = charcodeDecode(units.join(' '), 'dec', 'codepoint');
    } catch {
      continue;
    }
    // A lone surrogate half cannot go through UTF-8: leave such a call as it is.
    if (value.includes('\ufffd') && !units.includes(0xfffd)) continue;
    edits.push({ start: tokAt(v, k)!.start, end: tokAt(v, list.end)!.end, text: quoteJs(value) });
    k = list.end;
  }
  return edits;
}

function stringCallName(v: View, k: number): string | null {
  const t = tokAt(v, k);
  return t ? stringValue(v.src, t) : null;
}

/** What atob() would return for this text if it is plain printable ASCII, else null. */
export function atobPrintable(value: string): string | null {
  let s = value.replace(/[\t\n\f\r ]+/g, '');
  if (s.length % 4 === 0) s = s.replace(/={1,2}$/, '');
  if (!s || !/^[A-Za-z0-9+/]+$/.test(s) || s.length % 4 === 1) return null;
  const text = latin1Decode(fromBase64(s));
  return /^[\t\n\r\x20-\x7e]+$/.test(text) ? text : null;
}

function ruleAtob(v: View): Edit[] {
  const edits: Edit[] = [];
  for (let k = 0; k < v.sig.length; k++) {
    const call = stringCall(v, k, 'atob');
    if (!call) continue;
    const text = atobPrintable(call.value);
    if (text !== null) edits.push({ start: call.edit[0], end: call.edit[1], text: quoteJs(text) });
  }
  return edits;
}

/** Statement starts: after ; { } or at the very beginning. */
const statementStart = (v: View, k: number): boolean =>
  k === 0 || (tokAt(v, k - 1)?.kind === 'punct' && [';', '{', '}'].includes(textAt(v, k - 1)));
const statementEnd = (v: View, k: number): boolean =>
  k >= v.sig.length || (tokAt(v, k)?.kind === 'punct' && [';', '}'].includes(textAt(v, k)));

function hasReturn(code: string): boolean {
  return lex(code).some((t) => t.kind === 'word' && code.slice(t.start, t.end) === 'return');
}

/** The code that replaces a statement already ends with ; or }: the statement's own ; goes. */
function closeStatement(
  v: View,
  k: number,
  call: { edit: [number, number]; value: string },
): number {
  const semi = tokAt(v, k);
  const ends = /[;}]\s*$/.test(call.value);
  return ends && semi?.kind === 'punct' && v.src[semi.start] === ';' ? semi.end : call.edit[1];
}

/** eval("code") and Function("code")() written as a statement: the code takes their place. */
function ruleEval(v: View): Edit[] {
  const edits: Edit[] = [];
  for (let k = 0; k < v.sig.length; k++) {
    if (isWord(v, k, 'eval')) {
      const call = stringCall(v, k, 'eval');
      if (!call || !statementStart(v, k) || !statementEnd(v, k + 4)) continue;
      edits.push({ start: call.edit[0], end: closeStatement(v, k + 4, call), text: call.value });
    } else if (isWord(v, k, 'Function') || (isWord(v, k, 'new') && isWord(v, k + 1, 'Function'))) {
      const f = isWord(v, k, 'new') ? k + 1 : k;
      const call = stringCall(v, f, 'Function');
      if (!call || !statementStart(v, k) || !isPunct(v, f + 4, '(') || !isPunct(v, f + 5, ')'))
        continue;
      if (!statementEnd(v, f + 6) || hasReturn(call.value)) continue;
      edits.push({
        start: tokAt(v, k)!.start,
        end: closeStatement(v, f + 6, { edit: [0, tokAt(v, f + 5)!.end], value: call.value }),
        text: call.value,
      });
    }
  }
  return edits;
}

const RULES: [PeelRule, (v: View) => Edit[]][] = [
  ['escapes', ruleEscapes],
  ['concat', ruleConcat],
  ['unescape', ruleUnescape],
  ['uri', ruleUri],
  ['fromCharCode', ruleFromCharCode],
  ['atob', ruleAtob],
  ['eval', ruleEval],
];

/** Peel `source` round after round until nothing changes (or a limit is reached). */
export function peel(source: string): PeelResult {
  let code = source;
  const rounds: PeelRound[] = [];
  let work = 0;
  let stop: PeelResult['stop'] = 'done';
  for (let round = 1; ; round++) {
    if (round > MAX_ROUNDS) {
      stop = 'rounds';
      break;
    }
    const steps: PeelStep[] = [];
    const before = code;
    let v: View | null = null;
    for (const [rule, apply] of RULES) {
      if (work > MAX_WORK) {
        stop = 'work';
        break;
      }
      v ??= view(code);
      work += code.length;
      const edits = apply(v).filter((e) => e.text !== v!.src.slice(e.start, e.end));
      if (edits.length === 0) continue;
      steps.push({ rule, count: edits.length });
      code = applyEdits(v.src, edits);
      v = null;
    }
    if (code === before) break;
    // Only the last round keeps its whole code: the others are there to show what happened.
    const prev = rounds[rounds.length - 1];
    if (prev && prev.code.length > PREVIEW) prev.code = prev.code.slice(0, PREVIEW);
    rounds.push({ round, steps, code, size: code.length });
    if (stop === 'work') break;
  }
  return { code, rounds, stop, changed: code !== source };
}
