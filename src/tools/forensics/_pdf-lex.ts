/**
 * PDF syntax (ISO 32000-1, 7.2 and 7.3): a tolerant tokenizer and object parser. It is used for
 * the file body (objects, trailers, xref streams' dictionaries), for content streams (operands
 * and operators come out as `kw` values) and for CMaps. It never throws on garbage except for
 * `PdfSyntaxError` (nesting too deep), which callers catch: a damaged file must not stop the
 * analysis.
 */
import { isValidUtf8, latin1Decode, utf8Decode } from '../../lib/bytes';

export interface PdfName {
  readonly k: 'name';
  readonly v: string;
}
export interface PdfString {
  readonly k: 'str';
  readonly b: Uint8Array;
  readonly hex: boolean;
}
export interface PdfRef {
  readonly k: 'ref';
  readonly num: number;
  readonly gen: number;
}
export interface PdfArray {
  readonly k: 'arr';
  readonly items: PdfValue[];
}
export interface PdfDict {
  readonly k: 'dict';
  readonly map: Map<string, PdfValue>;
}
/** A bare word: an operator in a content stream, or a keyword such as `obj` / `stream`. */
export interface PdfKeyword {
  readonly k: 'kw';
  readonly v: string;
}
export type PdfValue =
  null | boolean | number | PdfName | PdfString | PdfRef | PdfArray | PdfDict | PdfKeyword;

export class PdfSyntaxError extends Error {
  override name = 'PdfSyntaxError';
}

const MAX_DEPTH = 100;

// ---------- character classes (7.2.2) ----------

const WS = 1;
const DELIM = 2;
const CLASS = new Uint8Array(256);
for (const c of [0, 9, 10, 12, 13, 32]) CLASS[c] = WS;
for (const ch of '()<>[]{}/%') CLASS[ch.charCodeAt(0)] = DELIM;

export const isSpace = (c: number | undefined): boolean => c !== undefined && CLASS[c] === WS;
export const isDelimiter = (c: number | undefined): boolean =>
  c !== undefined && CLASS[c] === DELIM;
/** A byte that can be part of a name or a keyword. */
export const isRegular = (c: number | undefined): boolean => c !== undefined && CLASS[c] === 0;

const isDigit = (c: number | undefined): boolean => c !== undefined && c >= 0x30 && c <= 0x39;

// ---------- small constructors and accessors ----------

export const name = (v: string): PdfName => ({ k: 'name', v });
export const kw = (v: string): PdfKeyword => ({ k: 'kw', v });
export const newDict = (entries: [string, PdfValue][] = []): PdfDict => ({
  k: 'dict',
  map: new Map(entries),
});

export const isName = (v: PdfValue | undefined, n?: string): v is PdfName =>
  typeof v === 'object' && v !== null && v.k === 'name' && (n === undefined || v.v === n);
export const isDict = (v: PdfValue | undefined): v is PdfDict =>
  typeof v === 'object' && v !== null && v.k === 'dict';
export const isArray = (v: PdfValue | undefined): v is PdfArray =>
  typeof v === 'object' && v !== null && v.k === 'arr';
export const isRef = (v: PdfValue | undefined): v is PdfRef =>
  typeof v === 'object' && v !== null && v.k === 'ref';
export const isString = (v: PdfValue | undefined): v is PdfString =>
  typeof v === 'object' && v !== null && v.k === 'str';
export const isKeyword = (v: PdfValue | undefined, w?: string): v is PdfKeyword =>
  typeof v === 'object' && v !== null && v.k === 'kw' && (w === undefined || v.v === w);
export const isNum = (v: PdfValue | undefined): v is number =>
  typeof v === 'number' && Number.isFinite(v);

// ---------- the lexer ----------

export class Lexer {
  pos: number;

  /**
   * @param refs read `n g R` as a reference (file body); off for content streams.
   */
  constructor(
    readonly buf: Uint8Array,
    pos = 0,
    readonly end = buf.length,
    private readonly refs = true,
  ) {
    this.pos = pos;
  }

  /** Skip white space and comments. */
  skip(): void {
    const { buf, end } = this;
    while (this.pos < end) {
      const c = buf[this.pos]!;
      if (CLASS[c] === WS) this.pos++;
      else if (c === 0x25) {
        while (this.pos < end && buf[this.pos] !== 10 && buf[this.pos] !== 13) this.pos++;
      } else break;
    }
  }

  atEnd(): boolean {
    this.skip();
    return this.pos >= this.end;
  }

  /** The next byte after white space and comments, without consuming it. */
  peek(): number | undefined {
    this.skip();
    return this.pos < this.end ? this.buf[this.pos] : undefined;
  }

  /** Does `word` start right here (as a whole word)? Nothing is consumed. */
  atWord(word: string): boolean {
    const { buf } = this;
    if (this.pos + word.length > this.end) return false;
    for (let i = 0; i < word.length; i++)
      if (buf[this.pos + i] !== word.charCodeAt(i)) return false;
    const after = this.pos + word.length;
    return after >= this.end || !isRegular(buf[after]);
  }

  /** The next value, or undefined at the end of the data. */
  readValue(depth = 0): PdfValue | undefined {
    if (depth > MAX_DEPTH) throw new PdfSyntaxError('nested too deeply');
    this.skip();
    if (this.pos >= this.end) return undefined;
    const { buf } = this;
    const c = buf[this.pos]!;
    switch (c) {
      case 0x2f:
        return this.readName();
      case 0x28:
        return this.readLiteral();
      case 0x3c:
        if (buf[this.pos + 1] === 0x3c) {
          this.pos += 2;
          return this.readDict(depth);
        }
        return this.readHex();
      case 0x5b:
        this.pos++;
        return this.readArray(depth);
      case 0x3e:
        if (buf[this.pos + 1] === 0x3e) {
          this.pos += 2;
          return kw('>>');
        }
        this.pos++;
        return kw('>');
      case 0x5d:
      case 0x29:
      case 0x7b:
      case 0x7d:
        this.pos++;
        return kw(String.fromCharCode(c));
      default:
        return this.readToken();
    }
  }

  private readName(): PdfName {
    const { buf, end } = this;
    this.pos++; // the slash
    const bytes: number[] = [];
    let escaped = false;
    while (this.pos < end && CLASS[buf[this.pos]!] === 0) {
      const c = buf[this.pos]!;
      if (c === 0x23) {
        const h = hexPair(buf[this.pos + 1], buf[this.pos + 2]);
        if (h >= 0) {
          bytes.push(h);
          this.pos += 3;
          escaped = true;
          continue;
        }
      }
      bytes.push(c);
      this.pos++;
    }
    return name(nameText(bytes, escaped));
  }

  private readLiteral(): PdfString {
    const { buf, end } = this;
    this.pos++; // (
    const out: number[] = [];
    let depth = 1;
    while (this.pos < end) {
      const c = buf[this.pos++]!;
      if (c === 0x5c) {
        const n = buf[this.pos++];
        if (n === undefined) break;
        switch (n) {
          case 0x6e:
            out.push(10);
            break;
          case 0x72:
            out.push(13);
            break;
          case 0x74:
            out.push(9);
            break;
          case 0x62:
            out.push(8);
            break;
          case 0x66:
            out.push(12);
            break;
          case 0x0d:
            if (buf[this.pos] === 0x0a) this.pos++;
            break;
          case 0x0a:
            break;
          default:
            if (n >= 0x30 && n <= 0x37) {
              let v = n - 0x30;
              for (let i = 0; i < 2; i++) {
                const d = buf[this.pos];
                if (d === undefined || d < 0x30 || d > 0x37) break;
                v = v * 8 + (d - 0x30);
                this.pos++;
              }
              out.push(v & 0xff);
            } else out.push(n);
        }
      } else if (c === 0x28) {
        depth++;
        out.push(c);
      } else if (c === 0x29) {
        if (--depth === 0) break;
        out.push(c);
      } else if (c === 0x0d) {
        if (buf[this.pos] === 0x0a) this.pos++;
        out.push(10);
      } else out.push(c);
    }
    return { k: 'str', b: Uint8Array.from(out), hex: false };
  }

  private readHex(): PdfString {
    const { buf, end } = this;
    this.pos++; // <
    const out: number[] = [];
    let hi = -1;
    while (this.pos < end) {
      const c = buf[this.pos++]!;
      if (c === 0x3e) break;
      const v = hexDigit(c);
      if (v < 0) continue;
      if (hi < 0) hi = v;
      else {
        out.push(hi * 16 + v);
        hi = -1;
      }
    }
    if (hi >= 0) out.push(hi * 16);
    return { k: 'str', b: Uint8Array.from(out), hex: true };
  }

  private readArray(depth: number): PdfArray {
    const items: PdfValue[] = [];
    for (;;) {
      this.skip();
      if (this.pos >= this.end) break;
      if (this.buf[this.pos] === 0x5d) {
        this.pos++;
        break;
      }
      const at = this.pos;
      const v = this.readValue(depth + 1);
      if (v === undefined) break;
      if (isKeyword(v) && (v.v === 'endobj' || v.v === 'stream' || v.v === 'endstream')) {
        this.pos = at;
        break;
      }
      if (isKeyword(v) && v.v === '>>') continue;
      items.push(v);
    }
    return { k: 'arr', items };
  }

  private readDict(depth: number): PdfDict {
    const map = new Map<string, PdfValue>();
    for (;;) {
      this.skip();
      if (this.pos >= this.end) break;
      const at = this.pos;
      const key = this.readValue(depth + 1);
      if (key === undefined) break;
      if (isKeyword(key, '>>')) break;
      if (isKeyword(key) && (key.v === 'endobj' || key.v === 'stream' || key.v === 'endstream')) {
        this.pos = at;
        break;
      }
      if (!isName(key)) continue; // garbage between entries
      this.skip();
      if (this.buf[this.pos] === 0x3e && this.buf[this.pos + 1] === 0x3e) {
        this.pos += 2;
        map.set(key.v, null);
        break;
      }
      const vAt = this.pos;
      const value = this.readValue(depth + 1);
      if (value === undefined) break;
      if (isKeyword(value) && (value.v === 'endobj' || value.v === 'stream')) {
        this.pos = vAt;
        break;
      }
      if (isKeyword(value, '>>')) {
        map.set(key.v, null);
        break;
      }
      map.set(key.v, value);
    }
    return { k: 'dict', map };
  }

  /** A number, a reference (`12 0 R`) or a keyword. */
  private readToken(): PdfValue {
    const { buf, end } = this;
    const start = this.pos;
    while (this.pos < end && CLASS[buf[this.pos]!] === 0) this.pos++;
    if (this.pos === start) {
      this.pos++; // cannot happen (delimiters are handled), but never loop
      return kw('');
    }
    const first = buf[start]!;
    if (isDigit(first) || first === 0x2b || first === 0x2d || first === 0x2e) {
      const n = parseNumber(buf, start, this.pos);
      if (n !== null) {
        if (this.refs && Number.isInteger(n) && n >= 0 && isDigit(first)) {
          const ref = this.tryRef(n);
          if (ref) return ref;
        }
        return n;
      }
    }
    const word = latin1Decode(buf.subarray(start, this.pos));
    if (word === 'true') return true;
    if (word === 'false') return false;
    if (word === 'null') return null;
    return kw(word);
  }

  /** After an integer: `g R` makes it a reference. Restores the position when it is not one. */
  private tryRef(num: number): PdfRef | null {
    const { buf, end } = this;
    const save = this.pos;
    let p = save;
    while (p < end && CLASS[buf[p]!] === WS) p++;
    const g0 = p;
    while (p < end && isDigit(buf[p])) p++;
    if (p === g0 || p - g0 > 5 || p === save) return null;
    const gen = Number(latin1Decode(buf.subarray(g0, p)));
    const afterGen = p;
    while (p < end && CLASS[buf[p]!] === WS) p++;
    if (p === afterGen || buf[p] !== 0x52) return null;
    if (p + 1 < end && !isSpace(buf[p + 1]) && !isDelimiter(buf[p + 1])) return null;
    this.pos = p + 1;
    return { k: 'ref', num, gen };
  }
}

function hexDigit(c: number | undefined): number {
  if (c === undefined) return -1;
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10;
  if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10;
  return -1;
}

function hexPair(a: number | undefined, b: number | undefined): number {
  const x = hexDigit(a);
  const y = hexDigit(b);
  return x < 0 || y < 0 ? -1 : x * 16 + y;
}

function nameText(bytes: number[], escaped: boolean): string {
  if (!escaped || bytes.every((c) => c < 0x80)) return String.fromCharCode(...bytes);
  const raw = Uint8Array.from(bytes);
  return isValidUtf8(raw) ? utf8Decode(raw) : latin1Decode(raw);
}

/** [+-]digits[.digits] (also `.5`, `4.`, `--5`): null when the token is not a number. */
function parseNumber(buf: Uint8Array, from: number, to: number): number | null {
  let p = from;
  let negative = false;
  while (p < to && (buf[p] === 0x2b || buf[p] === 0x2d)) {
    if (buf[p] === 0x2d) negative = true;
    p++;
  }
  let int = 0;
  let digits = 0;
  while (p < to && isDigit(buf[p])) {
    int = int * 10 + (buf[p]! - 0x30);
    digits++;
    p++;
  }
  let value = int;
  if (p < to && buf[p] === 0x2e) {
    p++;
    let scale = 0.1;
    while (p < to && isDigit(buf[p])) {
      value += (buf[p]! - 0x30) * scale;
      scale /= 10;
      digits++;
      p++;
    }
  }
  if (p !== to || digits === 0) return null;
  return negative ? -value : value;
}

/** Parse one value from the start of a byte range (for tests and small helpers). */
export function parseValue(bytes: Uint8Array | string, refs = true): PdfValue | undefined {
  const buf =
    typeof bytes === 'string' ? Uint8Array.from(bytes, (c) => c.charCodeAt(0) & 0xff) : bytes;
  try {
    return new Lexer(buf, 0, buf.length, refs).readValue();
  } catch (e) {
    if (e instanceof PdfSyntaxError) return undefined;
    throw e;
  }
}

// ---------- reading dictionaries ----------

export const dictGet = (d: PdfDict | null | undefined, key: string): PdfValue | undefined =>
  d?.map.get(key);

export function nameOf(v: PdfValue | undefined): string | null {
  return isName(v) ? v.v : null;
}

// ---------- text strings ----------

const PDFDOC_80: Record<number, string> = {
  0x18: '˘',
  0x19: 'ˇ',
  0x1a: 'ˆ',
  0x1b: '˙',
  0x1c: '˝',
  0x1d: '˛',
  0x1e: '˚',
  0x1f: '˜',
  0x80: '•',
  0x81: '†',
  0x82: '‡',
  0x83: '…',
  0x84: '—',
  0x85: '–',
  0x86: 'ƒ',
  0x87: '⁄',
  0x88: '‹',
  0x89: '›',
  0x8a: '−',
  0x8b: '‰',
  0x8c: '„',
  0x8d: '“',
  0x8e: '”',
  0x8f: '‘',
  0x90: '’',
  0x91: '‚',
  0x92: '™',
  0x93: 'ﬁ',
  0x94: 'ﬂ',
  0x95: 'Ł',
  0x96: 'Œ',
  0x97: 'Š',
  0x98: 'Ÿ',
  0x99: 'Ž',
  0x9a: 'ı',
  0x9b: 'ł',
  0x9c: 'œ',
  0x9d: 'š',
  0x9e: 'ž',
  0xa0: '€',
};

/** A PDF "text string": UTF-16 with a BOM, UTF-8 with a BOM, or PDFDocEncoding. */
export function pdfText(b: Uint8Array): string {
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return utf16(b, 2, false);
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return utf16(b, 2, true);
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) {
    return utf8Decode(b.subarray(3));
  }
  let out = '';
  for (const c of b) out += PDFDOC_80[c] ?? String.fromCharCode(c);
  return out;
}

function utf16(b: Uint8Array, from: number, little: boolean): string {
  const units: number[] = [];
  for (let i = from; i + 1 < b.length; i += 2) {
    units.push(little ? b[i]! | (b[i + 1]! << 8) : (b[i]! << 8) | b[i + 1]!);
  }
  let out = '';
  for (let i = 0; i < units.length; i += 4096) {
    out += String.fromCharCode(...units.slice(i, i + 4096));
  }
  return out;
}

/** The text of a string value, '' for anything else. */
export function stringText(v: PdfValue | undefined): string {
  return isString(v) ? pdfText(v.b) : '';
}

// ---------- display ----------

const NAME_PLAIN = /^[\x21-\x7e]+$/;

export function formatName(n: string): string {
  if (n !== '' && NAME_PLAIN.test(n) && !/[()<>[\]{}/%#]/.test(n)) return `/${n}`;
  let out = '/';
  for (const byte of new TextEncoder().encode(n)) {
    const ch = String.fromCharCode(byte);
    out += byte > 0x20 && byte < 0x7f && !/[()<>[\]{}/%#]/.test(ch) ? ch : `#${hex2(byte)}`;
  }
  return out;
}

const hex2 = (n: number) => n.toString(16).padStart(2, '0');

/** A string as it would be written: (text) when readable, <hex> otherwise. */
export function formatString(s: PdfString, max = 200): string {
  const b = s.b;
  const bomText = b.length >= 2 && b[0] === 0xfe && b[1] === 0xff;
  if (bomText) {
    const text = pdfText(b);
    return `(${clip(escapeText(text), max)})`;
  }
  let readable = b.length > 0;
  for (const c of b) {
    if (!(c === 9 || c === 10 || c === 13 || (c >= 0x20 && c < 0x7f))) {
      readable = false;
      break;
    }
  }
  if (readable) return `(${clip(escapeText(latin1Decode(b)), max)})`;
  let hex = '';
  for (let i = 0; i < b.length && hex.length < max; i++) hex += hex2(b[i]!);
  return `<${hex}${hex.length < b.length * 2 ? '…' : ''}>`;
}

const escapeText = (s: string) =>
  s
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s);

const numberText = (n: number) =>
  Number.isInteger(n) ? String(n) : String(Math.round(n * 1e6) / 1e6);

/** One-line form of a value, cut at `max` characters. */
export function formatValue(v: PdfValue | undefined, max = 160): string {
  const out: string[] = [];
  let length = 0;
  const push = (s: string): boolean => {
    out.push(s);
    length += s.length;
    return length <= max;
  };
  const walk = (x: PdfValue | undefined, depth: number): boolean => {
    if (x === undefined) return push('');
    if (x === null) return push('null');
    if (typeof x === 'boolean') return push(String(x));
    if (typeof x === 'number') return push(numberText(x));
    switch (x.k) {
      case 'name':
        return push(formatName(x.v));
      case 'str':
        return push(formatString(x, 80));
      case 'ref':
        return push(`${x.num} ${x.gen} R`);
      case 'kw':
        return push(x.v);
      case 'arr': {
        if (!push('[')) return false;
        if (depth > 6) return push('…]');
        for (let i = 0; i < x.items.length; i++) {
          if (i > 0 && !push(' ')) return false;
          if (!walk(x.items[i], depth + 1)) return false;
        }
        return push(']');
      }
      case 'dict': {
        if (!push('<<')) return false;
        if (depth > 6) return push(' … >>');
        for (const [key, value] of x.map) {
          if (!push(` ${formatName(key)} `) || !walk(value, depth + 1)) return false;
        }
        return push(' >>');
      }
    }
  };
  const complete = walk(v, 0);
  const text = out.join('');
  return complete ? text : `${text.slice(0, max)}…`;
}

/** Multi-line form of a dictionary or array, in the style of pdf-parser. */
export function formatPretty(v: PdfValue | undefined, maxLines = 400): string {
  const lines: string[] = [];
  const walk = (x: PdfValue | undefined, indent: string, prefix: string): void => {
    if (lines.length >= maxLines) return;
    if (isDict(x)) {
      lines.push(`${indent}${prefix}<<`);
      for (const [key, value] of x.map) {
        if (lines.length >= maxLines) break;
        if (isDict(value) || (isArray(value) && value.items.length > 8)) {
          walk(value, `${indent}  `, `${formatName(key)} `);
        } else lines.push(`${indent}  ${formatName(key)} ${formatValue(value, 300)}`);
      }
      lines.push(`${indent}>>`);
    } else if (isArray(x) && x.items.length > 8) {
      lines.push(`${indent}${prefix}[`);
      for (const item of x.items) {
        if (lines.length >= maxLines) break;
        lines.push(`${indent}  ${formatValue(item, 300)}`);
      }
      lines.push(`${indent}]`);
    } else lines.push(`${indent}${prefix}${formatValue(x, 300)}`);
  };
  walk(v, '', '');
  if (lines.length >= maxLines) lines.push('…');
  return lines.join('\n');
}
