import { bool, defineTool, number, select, toggle } from '../../core/define';
import { ToolError } from '../../core/errors';
import type { Output } from '../../core/types';
import { toolT } from '../../i18n/tool-text';
import {
  concatBytes,
  fromBase64,
  isValidUtf8,
  toBase64,
  utf8Decode,
  utf8Encode,
} from '../../lib/bytes';
import { bytesResult } from './_common';

const T = toolT('quoted-printable');

// ---------------------------------------------------------------------------------------------
// Quoted-printable (RFC 2045 section 6.7)
// ---------------------------------------------------------------------------------------------

export interface QpProblem {
  line: number;
  column: number;
  /** The "=" and what follows it (up to two characters). */
  text: string;
}

export interface QpDecoded {
  bytes: Uint8Array;
  /** Escapes that are not "=" and two hex digits: kept as they are (strict mode throws instead). */
  problems: QpProblem[];
  /** Escapes written with lower-case hex digits (RFC 2045 asks for capitals): read anyway. */
  lowercase: number;
  softBreaks: number;
  /** Characters above U+007F in the text: copied as UTF-8, since the text should be 7-bit. */
  nonAscii: number;
}

const isHex = (s: string): boolean => /^[0-9A-Fa-f]{2}$/.test(s);

/**
 * Decode quoted-printable text to bytes. "=XX" is a byte; "=" at the end of a line (after any
 * blanks) is a soft line break and vanishes; blanks at the end of a line are not data and are
 * dropped; a hard line break stays as it was written (CRLF or LF). A "=" that starts neither is
 * invalid: with `strict` it throws a ToolError with the line and column, otherwise it is kept
 * and listed in `problems`.
 */
export function qpDecode(text: string, strict = false): QpDecoded {
  const out: number[] = [];
  const problems: QpProblem[] = [];
  let lowercase = 0;
  let softBreaks = 0;
  let nonAscii = 0;
  let lineNo = 0;

  for (const m of text.matchAll(/([^\n]*)(\n|$)/g)) {
    if (m.index === text.length && m[0] === '' && lineNo > 0) break;
    lineNo++;
    let body = m[1]!;
    let eol = m[2]!;
    if (eol && body.endsWith('\r')) {
      body = body.slice(0, -1);
      eol = '\r\n';
    }
    let line = body.replace(/[ \t]+$/, '');
    const soft = line.endsWith('=');
    if (soft) line = line.slice(0, -1);

    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (ch === '=') {
        const hex = line.slice(i + 1, i + 3);
        if (isHex(hex)) {
          if (/[a-f]/.test(hex)) lowercase++;
          out.push(parseInt(hex, 16));
          i += 2;
        } else {
          const bad = { line: lineNo, column: i + 1, text: line.slice(i, i + 3) };
          if (strict) throw new ToolError(T('error.escape', bad));
          problems.push(bad);
          out.push(0x3d);
        }
      } else if (ch.charCodeAt(0) < 0x80) {
        out.push(ch.charCodeAt(0));
      } else {
        const cp = line.codePointAt(i)!;
        if (cp > 0xffff) i++;
        nonAscii++;
        out.push(...utf8Encode(String.fromCodePoint(cp)));
      }
    }
    if (soft) softBreaks++;
    else for (const c of eol) out.push(c.charCodeAt(0));
  }
  return { bytes: Uint8Array.from(out), problems, lowercase, softBreaks, nonAscii };
}

export interface QpEncodeOptions {
  /** Encode CR and LF as well (binary data) instead of keeping line breaks. */
  binary?: boolean;
  /** Line break written for a hard break and after a soft break: "\r\n" (MIME) or "\n". */
  eol?: '\r\n' | '\n';
  /** Longest line, soft-break "=" included. RFC 2045: 76. */
  lineLength?: number;
}

const QP_HEX = '0123456789ABCDEF';
const esc = (b: number): string => `=${QP_HEX[b >> 4]}${QP_HEX[b & 15]}`;

/**
 * RFC 2045 encoding. Printable ASCII except "=" stays as it is; a blank stays unless it ends a
 * line; everything else is "=XX" with capital hex digits. Lines are cut with a soft break "="
 * so that none is longer than `lineLength`; an "=XX" is never cut in two. In text mode (the
 * default) CR, LF and CRLF are hard line breaks; in binary mode they are encoded.
 */
export function qpEncode(bytes: Uint8Array, opts: QpEncodeOptions = {}): string {
  const { binary = false, eol = '\n', lineLength = 76 } = opts;
  const max = Math.max(4, lineLength);
  // Tokens of one line: the text each byte becomes
  const lines: string[][] = [[]];
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    const cur = lines[lines.length - 1]!;
    if (!binary && (b === 0x0a || b === 0x0d)) {
      if (b === 0x0d && bytes[i + 1] === 0x0a) i++;
      lines.push([]);
    } else if ((b >= 33 && b <= 126 && b !== 0x3d) || b === 0x20 || b === 0x09) {
      cur.push(String.fromCharCode(b));
    } else {
      cur.push(esc(b));
    }
  }
  // A blank that ends a line (or the text) must be encoded
  for (const line of lines) {
    const last = line[line.length - 1];
    if (last === ' ' || last === '\t') line[line.length - 1] = esc(last.charCodeAt(0));
  }

  const out: string[] = [];
  for (let n = 0; n < lines.length; n++) {
    const tokens = lines[n]!;
    let cur = '';
    for (let t = 0; t < tokens.length; t++) {
      const tok = tokens[t]!;
      // the last token of a line may use the whole width: no "=" follows it
      const room = t === tokens.length - 1 ? max : max - 1;
      if (cur.length + tok.length > room) {
        out.push(cur + '=' + eol);
        cur = '';
      }
      cur += tok;
    }
    out.push(cur);
    if (n < lines.length - 1) out.push(eol);
  }
  return out.join('');
}

/**
 * Cheap test used by Auto-decode and the triage: does this read as quoted-printable and not as
 * ordinary text (a URL, a query string, base64 padding)? Every "=" must start a valid escape
 * with capital hex digits or end a line (a soft break); then it takes a soft break, or two
 * bytes that QP exists for (controls, "=", anything above ASCII) that decode to valid UTF-8, or
 * a text that is nothing but escapes.
 */
export function looksLikeQp(text: string): boolean {
  if (text.length < 8 || text.length > 2_000_000 || !text.includes('=')) return false;
  let escapes = 0;
  let typical = 0;
  let soft = 0;
  for (const m of text.matchAll(/=([0-9A-F]{2})|=[ \t]*\r?\n|=/g)) {
    if (m[1]) {
      escapes++;
      const b = parseInt(m[1], 16);
      if (b < 0x20 || b === 0x3d || b >= 0x7f) typical++;
    } else if (m[0].length > 1) soft++;
    else return false; // an "=" that is neither: ordinary text
  }
  if (/^(?:=[0-9A-F]{2})+$/.test(text.trim()) && escapes >= 4) return true;
  if (soft >= 1) return true;
  return typical >= 2 && isValidUtf8(qpDecode(text).bytes);
}

// ---------------------------------------------------------------------------------------------
// Encoded-words (RFC 2047)
// ---------------------------------------------------------------------------------------------

/** =?charset?Q?text?= and =?charset?B?text?=, with an optional "*language" after the charset. */
const WORD = /=\?([^?\s*]+)(?:\*[^?\s]*)?\?([QqBb])\?([^?\s]*)\?=/g;

export const hasEncodedWords = (text: string): boolean => new RegExp(WORD.source).test(text);

export interface EncodedWord {
  charset: string;
  encoding: 'Q' | 'B';
  /** The word as written. */
  raw: string;
  /** 1-based position of the word in the text. */
  pos: number;
  /** What it says, or null when it could not be decoded. */
  text: string | null;
}

export interface DecodedWords {
  text: string;
  words: EncodedWord[];
  /** Charsets this browser cannot decode: read as Windows-1252 instead. */
  badCharsets: string[];
}

const SUPPORTED = new Map<string, TextDecoder | null>();
/** A decoder for a charset label, or null when the browser does not know it. */
function decoderFor(label: string): TextDecoder | null {
  const key = label.toLowerCase();
  if (!SUPPORTED.has(key)) {
    try {
      SUPPORTED.set(key, new TextDecoder(key));
    } catch {
      SUPPORTED.set(key, null);
    }
  }
  return SUPPORTED.get(key) ?? null;
}

/** Q payload: "_" is a space, "=XX" a byte. Returns null on a bad escape. */
function decodeQ(payload: string): Uint8Array | null {
  const out: number[] = [];
  for (let i = 0; i < payload.length; i++) {
    const ch = payload[i]!;
    if (ch === '_') out.push(0x20);
    else if (ch === '=') {
      const hex = payload.slice(i + 1, i + 3);
      if (!isHex(hex)) return null;
      out.push(parseInt(hex, 16));
      i += 2;
    } else out.push(ch.charCodeAt(0) & 0xff);
  }
  return Uint8Array.from(out);
}

/**
 * Replace every encoded word of the text by what it says. Blanks between two words are dropped
 * (RFC 2047 section 6.2); neighbouring words with the same charset are decoded together, so a
 * character cut in two by an encoder comes out whole. A word that cannot be decoded stays as written.
 */
export function decodeEncodedWords(text: string): DecodedWords {
  const matches = [...text.matchAll(WORD)];
  const words: EncodedWord[] = [];
  const badCharsets: string[] = [];
  let out = '';
  let last = 0;
  let run: { charset: string; bytes: Uint8Array }[] = [];

  const flush = () => {
    let i = 0;
    while (i < run.length) {
      let j = i;
      const parts: Uint8Array[] = [];
      while (j < run.length && run[j]!.charset.toLowerCase() === run[i]!.charset.toLowerCase()) {
        parts.push(run[j]!.bytes);
        j++;
      }
      const dec = decoderFor(run[i]!.charset);
      if (!dec && !badCharsets.includes(run[i]!.charset)) badCharsets.push(run[i]!.charset);
      out += (dec ?? decoderFor('windows-1252')!).decode(concatBytes(...parts));
      i = j;
    }
    run = [];
  };

  for (const m of matches) {
    const between = text.slice(last, m.index);
    if (run.length && /^\s*$/.test(between)) {
      // only blanks between two words: they are dropped
    } else {
      flush();
      out += between;
    }
    last = m.index + m[0].length;
    const encoding = m[2]!.toUpperCase() as 'Q' | 'B';
    let bytes: Uint8Array | null;
    try {
      bytes = encoding === 'Q' ? decodeQ(m[3]!) : fromBase64(m[3]!);
    } catch (e) {
      if (!(e instanceof ToolError)) throw e;
      bytes = null;
    }
    const dec = decoderFor(m[1]!) ?? decoderFor('windows-1252')!;
    words.push({
      charset: m[1]!,
      encoding,
      raw: m[0],
      pos: m.index + 1,
      text: bytes === null ? null : dec.decode(bytes),
    });
    if (bytes === null) {
      flush();
      out += m[0];
    } else {
      run.push({ charset: m[1]!, bytes });
    }
  }
  flush();
  out += text.slice(last);

  return { text: out, words, badCharsets };
}

/** Characters that can stand for themselves in a Q word of any header (RFC 2047 section 5). */
const Q_SAFE = /[A-Za-z0-9!*+\-/]/;

/**
 * Write the text as encoded words of at most 75 characters, separated by a space. The text is
 * cut between characters, never inside one. `charset` is only written into the word: the bytes
 * are the UTF-8 (or Latin-1) bytes the caller gives for each character.
 */
export function encodeWords(
  text: string,
  encoding: 'Q' | 'B',
  charset: string,
  encodeChar: (ch: string) => Uint8Array,
): string {
  const prefix = `=?${charset}?${encoding}?`;
  const budget = 75 - prefix.length - 2;
  const words: string[] = [];
  let chars: Uint8Array[] = [];
  let count = 0; // bytes so far (for B)
  let size = 0; // encoded length so far
  const emit = () => {
    if (!chars.length) return;
    const all = concatBytes(...chars);
    words.push(`${prefix}${encoding === 'B' ? toBase64(all) : qEncode(all)}?=`);
    chars = [];
    count = 0;
    size = 0;
  };
  for (const ch of text) {
    const b = encodeChar(ch);
    const next =
      encoding === 'B' ? Math.ceil((count + b.length) / 3) * 4 : size + qEncode(b).length;
    if (chars.length && next > budget) emit();
    chars.push(b);
    count += b.length;
    size = encoding === 'B' ? Math.ceil(count / 3) * 4 : size + qEncode(b).length;
  }
  emit();
  return words.join(' ');
}

const qEncode = (b: Uint8Array): string =>
  Array.from(b, (x) => {
    if (x === 0x20) return '_';
    const c = String.fromCharCode(x);
    return Q_SAFE.test(c) ? c : esc(x);
  }).join('');

// ---------------------------------------------------------------------------------------------
// Whole messages
// ---------------------------------------------------------------------------------------------

/** Headers and body of a pasted message (a header line, then a blank line), or null. */
export function splitMessage(text: string): { head: string; sep: string; body: string } | null {
  if (!/^[\x21-\x39\x3b-\x7e]+:[ \t]/.test(text)) return null;
  const m = /\r?\n\r?\n/.exec(text);
  if (!m) return null;
  const headLines = text.slice(0, m.index).split(/\r?\n/);
  if (!headLines.every((l) => /^[\x21-\x39\x3b-\x7e]+:/.test(l) || /^[ \t]/.test(l))) return null;
  return {
    head: text.slice(0, m.index),
    sep: m[0],
    body: text.slice(m.index + m[0].length),
  };
}

/** Header values may be folded over several lines: put them back on one line each. */
export const unfold = (head: string): string => head.replace(/\r?\n[ \t]+/g, ' ');

// ---------------------------------------------------------------------------------------------
// Result charsets
// ---------------------------------------------------------------------------------------------

type ResultCharset =
  | 'auto'
  | 'utf-8'
  | 'iso-8859-1'
  | 'windows-1252'
  | 'iso-8859-15'
  | 'windows-1251'
  | 'koi8-r'
  | 'shift_jis'
  | 'gb18030'
  | 'big5';

/** Bytes to text: "auto" is UTF-8 when the bytes are valid UTF-8, else Windows-1252. */
export function bytesToText(
  bytes: Uint8Array,
  charset: ResultCharset,
): { text: string; used: string; fellBack: boolean } {
  if (charset === 'auto') {
    return isValidUtf8(bytes)
      ? { text: utf8Decode(bytes), used: 'utf-8', fellBack: false }
      : { text: decoderFor('windows-1252')!.decode(bytes), used: 'windows-1252', fellBack: true };
  }
  const dec = decoderFor(charset) ?? decoderFor('windows-1252')!;
  return { text: dec.decode(bytes), used: charset, fellBack: false };
}

export interface DecodedMessage {
  text: string;
  head: DecodedWords;
  body: QpDecoded;
  /** The charset the body was read in. */
  charset: string;
  /** True when the Content-Type header gave it. */
  fromHeader: boolean;
  /** True when the bytes were not UTF-8 and Windows-1252 stood in. */
  fellBack: boolean;
}

/**
 * Header values (folded lines put back together) have their encoded words decoded; the body is
 * quoted-printable. In "auto" the body is read in the charset the Content-Type header names.
 */
export function decodeMessage(
  msg: { head: string; sep: string; body: string },
  strict: boolean,
  charset: ResultCharset,
): DecodedMessage {
  const head = decodeEncodedWords(unfold(msg.head));
  const body = qpDecode(msg.body, strict);
  const declared = /charset\s*=\s*"?([\w.:-]+)"?/i.exec(msg.head)?.[1]?.toLowerCase();
  const known = declared && decoderFor(declared) ? declared : null;
  const r =
    known && charset === 'auto'
      ? { text: decoderFor(known)!.decode(body.bytes), used: known, fellBack: false }
      : bytesToText(body.bytes, charset);
  return {
    text: head.text + msg.sep + r.text,
    head,
    body,
    charset: r.used,
    fromHeader: !!known && charset === 'auto',
    fellBack: r.fellBack,
  };
}

function latin1Bytes(text: string): Uint8Array {
  const out: number[] = [];
  let pos = 0;
  for (const ch of text) {
    pos++;
    const cp = ch.codePointAt(0)!;
    if (cp > 0xff) {
      throw new ToolError(
        T('error.notLatin1', {
          char: ch,
          hex: cp.toString(16).toUpperCase().padStart(4, '0'),
          pos,
        }),
      );
    }
    out.push(cp);
  }
  return Uint8Array.from(out);
}

// ---------------------------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------------------------

const CHARSET_NAMES: Record<string, string> = {
  'utf-8': 'UTF-8',
  'iso-8859-1': 'ISO-8859-1',
  'us-ascii': 'US-ASCII',
};

export default defineTool({
  id: 'quoted-printable',
  name: 'Quoted-printable / MIME words',
  category: 'encoding',
  description:
    'Encode or decode quoted-printable (RFC 2045: =XX, soft line breaks) and MIME encoded words (=?UTF-8?Q?…?=, RFC 2047); reads whole e-mails.',
  tags: [
    'qp',
    'quoted printable',
    'mime',
    'rfc2045',
    'rfc2047',
    'encoded-word',
    'email',
    'eml',
    'subject',
    'soft line break',
    '=3D',
    '=?utf-8?q?',
    'From Quoted Printable',
    'To Quoted Printable',
  ],
  input: 'bytes',
  placeholder: 'caf=C3=A9 cr=C3=A8me =?UTF-8?B?4pyT?=',
  live: true,
  options: {
    mode: toggle('Mode', ['decode', 'encode']),
    form: toggle(
      'Text is',
      [
        { value: 'auto', label: 'Auto' },
        { value: 'body', label: 'Quoted-printable body' },
        { value: 'words', label: 'Encoded words' },
      ],
      'auto',
      { showIf: (v) => v.mode === 'decode' },
    ),
    strict: bool('Strict', false, {
      hint: 'Stop at the first invalid =XX instead of keeping it as written.',
      showIf: (v) => v.mode === 'decode' && v.form !== 'words',
    }),
    encodeAs: toggle(
      'Write as',
      [
        { value: 'body', label: 'Quoted-printable body' },
        { value: 'q', label: 'Encoded words (Q)' },
        { value: 'b', label: 'Encoded words (B)' },
      ],
      'body',
      { showIf: (v) => v.mode === 'encode' },
    ),
    charset: select(
      'Charset',
      [
        { value: 'auto', label: 'Automatic (UTF-8, else Windows-1252)' },
        { value: 'utf-8', label: 'UTF-8' },
        { value: 'iso-8859-1', label: 'ISO-8859-1 (Latin-1)' },
        { value: 'windows-1252', label: 'Windows-1252' },
        { value: 'iso-8859-15', label: 'ISO-8859-15 (Latin-9)' },
        { value: 'windows-1251', label: 'Windows-1251 (Cyrillic)' },
        { value: 'koi8-r', label: 'KOI8-R (Cyrillic)' },
        { value: 'shift_jis', label: 'Shift_JIS' },
        { value: 'gb18030', label: 'GB18030' },
        { value: 'big5', label: 'Big5' },
      ],
      'auto',
      {
        hint: 'The charset of the decoded text. Writing is possible in UTF-8 and ISO-8859-1.',
        showIf: (v) => v.mode === 'encode' || v.form !== 'words',
      },
    ),
    binary: bool('Binary data', false, {
      hint: 'Encode line breaks too (=0D=0A) instead of keeping them as line breaks.',
      showIf: (v) => v.mode === 'encode' && v.encodeAs === 'body',
    }),
    eol: toggle(
      'Line ends',
      [
        { value: 'lf', label: 'LF' },
        { value: 'crlf', label: 'CRLF (MIME)' },
      ],
      'lf',
      { showIf: (v) => v.mode === 'encode' && v.encodeAs === 'body' },
    ),
    lineLength: number('Line length', 76, {
      min: 8,
      max: 998,
      hint: 'RFC 2045 allows 76 characters per line, the soft-break "=" included.',
      showIf: (v) => v.mode === 'encode' && v.encodeAs === 'body',
    }),
  },
  examples: [
    {
      label: 'RFC 2045: soft line breaks',
      input: "Now's the time =\nfor all folk to come=\n to the aid of their country.",
      expect: "Now's the time for all folk to come to the aid of their country.",
    },
    {
      label: 'Accents and the euro sign',
      input: 'Caf=C3=A9 cr=C3=A8me: 5=E2=82=AC =3D cinq euros',
      expect: 'Café crème: 5€ = cinq euros',
    },
    {
      label: 'RFC 2047: encoded words in a header',
      input:
        'Subject: =?ISO-8859-1?B?SWYgeW91IGNhbiByZWFkIHRoaXMgeW8=?=\n =?ISO-8859-2?B?dSB1bmRlcnN0YW5kIHRoZSBleGFtcGxlLg==?=',
      expect: 'Subject: If you can read this you understand the example.',
    },
    {
      label: 'A whole e-mail (headers and body)',
      input: { sample: 'quoted-printable-mail.eml' },
      expect: 'FTF{qp_in_an_email}',
    },
    {
      label: 'Encode text',
      input: 'Café: 5€ = cinq euros',
      options: { mode: 'encode' },
      expect: 'Caf=C3=A9: 5=E2=82=AC =3D cinq euros',
    },
    {
      label: 'Encode a header as an encoded word',
      input: 'Café crème ✓',
      options: { mode: 'encode', encodeAs: 'q' },
      expect: '=?UTF-8?Q?Caf=C3=A9_cr=C3=A8me_=E2=9C=93?=',
    },
  ],
  detect({ text }) {
    if (!text) return null;
    if (hasEncodedWords(text.slice(0, 100000))) {
      return { score: 0.85, options: { mode: 'decode', form: 'auto' }, reason: T('detect.words') };
    }
    if (looksLikeQp(text.slice(0, 100000))) {
      return { score: 0.75, options: { mode: 'decode', form: 'auto' }, reason: T('detect.body') };
    }
    return null;
  },
  run({ bytes }, { mode, form, strict, encodeAs, charset, binary, eol, lineLength }) {
    const out: Output[] = [];

    if (mode === 'encode') {
      const latin = charset === 'iso-8859-1';
      const label = latin ? 'ISO-8859-1' : 'UTF-8';
      if (charset !== 'auto' && charset !== 'utf-8' && !latin) {
        throw new ToolError(T('error.cannotWrite', { charset: CHARSET_NAMES[charset] ?? charset }));
      }
      if (encodeAs === 'body') {
        const data = latin ? latin1Bytes(utf8Decode(bytes)) : bytes;
        const value = qpEncode(data, {
          binary,
          eol: eol === 'crlf' ? '\r\n' : '\n',
          lineLength,
        });
        return [{ type: 'text', value }];
      }
      const encodeChar = latin ? (ch: string) => latin1Bytes(ch) : (ch: string) => utf8Encode(ch);
      const text = utf8Decode(bytes);
      if (!text) throw new ToolError(T('error.empty'));
      return [
        { type: 'text', value: encodeWords(text, encodeAs === 'q' ? 'Q' : 'B', label, encodeChar) },
      ];
    }

    const text = utf8Decode(bytes);
    if (!text.trim()) throw new ToolError(T('error.empty'));
    const resultCharset = charset as ResultCharset;
    const wordsOf = (words: EncodedWord[], badCharsets: string[]) => {
      if (words.length) {
        out.push({
          type: 'table',
          label: T('label.words'),
          columns: [T('col.charset'), T('col.encoding'), T('col.text')],
          rows: words
            .slice(0, 50)
            .map((w) => [w.charset, w.encoding, w.text ?? T('value.undecodable')]),
        });
      }
      for (const c of badCharsets) {
        out.push({ type: 'note', level: 'warn', text: T('note.badCharset', { charset: c }) });
      }
    };
    const bodyNotes = (d: QpDecoded) => {
      if (d.problems.length) {
        const p = d.problems[0]!;
        out.push({
          type: 'note',
          level: 'warn',
          text: T('note.invalid', {
            count: d.problems.length,
            text: p.text,
            line: p.line,
            column: p.column,
          }),
        });
      }
      if (d.lowercase) {
        out.push({
          type: 'note',
          level: 'info',
          text: T('note.lowercase', { count: d.lowercase }),
        });
      }
      if (d.nonAscii) {
        out.push({ type: 'note', level: 'info', text: T('note.nonAscii', { count: d.nonAscii }) });
      }
    };

    // headers and body of a message are told apart in automatic mode
    const msg = form === 'auto' ? splitMessage(text) : null;
    if (msg) {
      const r = decodeMessage(msg, strict, resultCharset);
      out.push({ type: 'text', value: r.text });
      wordsOf(r.head.words, r.head.badCharsets);
      bodyNotes(r.body);
      if (r.fromHeader) {
        out.push({
          type: 'note',
          level: 'info',
          text: T('note.headerCharset', { charset: r.charset }),
        });
      } else if (r.fellBack) {
        out.push({ type: 'note', level: 'info', text: T('note.fellBack') });
      }
      return out;
    }

    if (form === 'words' || (form === 'auto' && hasEncodedWords(text))) {
      const r = decodeEncodedWords(text);
      out.push({ type: 'text', value: r.text });
      wordsOf(r.words, r.badCharsets);
      if (!r.words.length) out.push({ type: 'note', level: 'info', text: T('note.noWords') });
      return out;
    }

    const d = qpDecode(text, strict);
    if (resultCharset === 'utf-8') out.push(...bytesResult(d.bytes));
    else {
      const r = bytesToText(d.bytes, resultCharset);
      out.push({ type: 'text', value: r.text });
      if (r.fellBack) out.push({ type: 'note', level: 'info', text: T('note.fellBack') });
    }
    bodyNotes(d);
    return out;
  },
});
