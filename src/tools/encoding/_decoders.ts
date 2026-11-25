import { ToolError } from '../../core/errors';
import { signatureName } from '../../i18n/tool-text';
import { fromBase64, printableRatio, utf8Encode } from '../../lib/bytes';
import { identify } from '../../lib/signatures';
import { inflateCapped, isGzip, isZlib } from './_inflate';
import { base100Decode } from './base100';
import { base32Decode } from './base32';
import { base26Decode, base36Decode } from './base36';
import { base45DecodeText } from './base45';
import { base58Decode } from './base58';
import { base62Decode } from './base62';
import { base85Decode } from './base85';
import { base91Decode } from './base91';
import { binaryDecode } from './binary';
import { brailleToText, cellsToBytes, readCells } from './braille';
import { BUBBLEBABBLE_SHAPE, bubbleBabbleDecode } from './bubblebabble';
import { charcodeDecodeBytes } from './charcode';
import { hexDecode } from './hex';
import { htmlDecodeBytes } from './html-entities';
import { morseDecode } from './morse';
import { looksLikeNato, natoDecode } from './nato';
import { decodeAceLabels } from './punycode';
import {
  decodeEncodedWords,
  decodeMessage,
  hasEncodedWords,
  looksLikeQp,
  qpDecode,
  splitMessage,
} from './quoted-printable';
import { hasUnicodeEscape, unicodeUnescapeBytes } from './unicode-escape';
import { uuDecodeStrict } from './uuencode';
import { urlDecodeOnce } from './url';

/** Candidates larger than this are treated as binary and never parsed as text. */
const MAX_TEXT = 2 * 1024 * 1024;

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

export interface Info {
  /** Valid UTF-8 decoding, or null for binary data. */
  text: string | null;
  /** Text without control characters: worth feeding to the text decoders. */
  textLike: boolean;
}

export function analyse(bytes: Uint8Array): Info {
  if (bytes.length === 0 || bytes.length > MAX_TEXT) return { text: null, textLike: false };
  let text: string;
  try {
    text = strictUtf8.decode(bytes);
  } catch {
    return { text: null, textLike: false };
  }
  let controls = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if ((c < 0x20 && c !== 9 && c !== 10 && c !== 13) || c === 0x7f) controls++;
  }
  return { text, textLike: controls < text.length * 0.05 };
}

export function strongSignature(bytes: Uint8Array): string | null {
  const sig = identify(bytes.subarray(0, 600)).find((s) => !s.weak);
  return sig ? signatureName(sig) : null;
}

// ---------------------------------------------------------------------------------------------
// Decoders and transforms
// ---------------------------------------------------------------------------------------------

export interface Ctx {
  bytes: Uint8Array;
  /** Trimmed text when the candidate is text-like, otherwise ''. */
  t: string;
  /** The text as it is (spaces and line breaks kept) when the candidate is text-like, else ''. */
  raw: string;
  textLike: boolean;
}

export interface Step {
  name: string;
  /** Returns the decoded bytes, or null when this step does not apply / the data is invalid. */
  run: (c: Ctx) => Uint8Array | null;
}

/** A step that only looks at text; `fn` may throw (ToolError...) to say "does not apply". */
const onText = (name: string, fn: (t: string) => Uint8Array | null): Step => ({
  name,
  run: (c) => (c.textLike && c.t ? fn(c.t) : null),
});

const stripNl = (t: string) => t.replace(/[\r\n]/g, '');

/**
 * Decoders that answer a yes/no question about their input (Base45, Base36...) accept a payload
 * only when it looks like something: mostly text, or a compressed stream, or a known file.
 */
const plausible = (b: Uint8Array): boolean =>
  printableRatio(b) >= 0.9 || isGzip(b) || isZlib(b) || strongSignature(b) !== null;

/** Try each text variant in turn; a ToolError means "not this encoding" for that variant. */
function firstDecoded(variants: string[], fn: (s: string) => Uint8Array | null): Uint8Array | null {
  for (const s of variants) {
    try {
      const out = fn(s);
      if (out) return out;
    } catch (e) {
      if (!(e instanceof ToolError)) throw e;
    }
  }
  return null;
}

const RE_B64 = /^[A-Za-z0-9+/_-]+={0,2}$/;
const RE_B32_UP = /^[A-Z2-7]+={0,6}$/;
const RE_B32_LOW = /^[a-z2-7]+={0,6}$/;
const RE_B45 = /^[0-9A-Z $%*+\-./:]{6,}$/;
const RE_BRAILLE = /^[\u2800-\u28ff\s]+$/;
const RE_B100 = /^(?:[\u{1F3F7}-\u{1F4F6}]|\uFE0F|\s)+$/u;
const RE_B36_LOW = /^(?=.*\d)(?=.*[a-z])[0-9a-z]{10,20000}$/;
const RE_B36_UP = /^(?=.*\d)(?=.*[A-Z])[0-9A-Z]{10,20000}$/;
const RE_B26 = /^(?:[a-z]{12,20000}|[A-Z]{12,20000})$/;
const RE_B58 = /^[1-9A-HJ-NP-Za-km-z]{10,20000}$/;
const RE_B62 = /^[0-9A-Za-z]{10,20000}$/;
const RE_A85 = /^[!-u]{10,}$/;
const RE_Z85 = /^[0-9a-zA-Z.\-:+=^!/*?&<>()[\]{}@%$#]{10,}$/;
const RE_B85 = /^[0-9A-Za-z!#$%&()*+\-;<=>?@^_`{|}~]{10,}$/;
const RE_B91 = /^[A-Za-z0-9!#$%&()*+,./:;<=>?@[\]^_`{|}~"]{10,}$/;
const RE_HEX = /^(?:0x|\\x)?[0-9a-fA-F]{2}(?:[\s:,;-]*(?:0x|\\x)?[0-9a-fA-F]{2})*$/;
const RE_BIN = /^(?:0b)?[01](?:[\s,;|]*(?:0b)?[01])*$/;
const RE_DEC_LIST = /^\d{1,7}(?:[\s,;]+\d{1,7}){2,}$/;
const RE_OCT_LIST = /^[0-7]{1,3}(?:[\s,;]+[0-7]{1,3}){2,}$/;
const RE_MORSE = /^[.\-•·∙−–—_\s/]+$/;

const rot = (s: string, n: number) =>
  s.replace(/[A-Za-z]/g, (ch) => {
    const base = ch <= 'Z' ? 65 : 97;
    return String.fromCharCode(base + ((ch.charCodeAt(0) - base + n) % 26));
  });
const rot47 = (s: string) =>
  s.replace(/[!-~]/g, (ch) => String.fromCharCode(33 + ((ch.charCodeAt(0) - 33 + 47) % 94)));
const atbash = (s: string) =>
  s.replace(/[A-Za-z]/g, (ch) => {
    const base = ch <= 'Z' ? 65 : 97;
    return String.fromCharCode(base + 25 - (ch.charCodeAt(0) - base));
  });
const reverse = (s: string) => Array.from(s).reverse().join('');

export const DECODERS: Step[] = [
  {
    name: 'gzip',
    run: (c) => (isGzip(c.bytes) ? inflateCapped(c.bytes, 'gzip') : null),
  },
  {
    name: 'zlib',
    run: (c) => (isZlib(c.bytes) && !isGzip(c.bytes) ? inflateCapped(c.bytes, 'zlib') : null),
  },
  {
    // Compressed data has no header worth checking, so only try it on binary-looking bytes.
    name: 'inflate',
    run: (c) =>
      !c.textLike && c.bytes.length >= 4 && !isGzip(c.bytes) && !isZlib(c.bytes)
        ? inflateCapped(c.bytes, 'raw')
        : null,
  },
  onText('base64', (t) => {
    const s = stripNl(t);
    if (!RE_B64.test(s)) return null;
    const n = s.replace(/=+$/, '').length;
    if (n % 4 === 1 || (n < 8 && !s.includes('='))) return null;
    return fromBase64(s);
  }),
  onText('base32', (t) => {
    const s = stripNl(t);
    if (!RE_B32_UP.test(s) && !RE_B32_LOW.test(s)) return null;
    const n = s.replace(/=+$/, '').length;
    if (n < 8 || [1, 3, 6].includes(n % 8)) return null;
    return base32Decode(s);
  }),
  {
    // The alphabet has a space, so upper-case words fit it: only keep payloads that look like data.
    name: 'base45',
    run: (c) => {
      const s = stripNl(c.raw);
      if (!RE_B45.test(s) || /^[A-Z ]+$/.test(s)) return null;
      return firstDecoded(s === s.trim() ? [s] : [s, s.trim()], (v) => {
        const { bytes } = base45DecodeText(v);
        return plausible(bytes) ? bytes : null;
      });
    },
  },
  {
    // Any digits-and-letters token is valid Base36: only keep a payload that looks like data.
    name: 'base36',
    run: (c) => {
      const out = RE_B36_LOW.test(c.t) || RE_B36_UP.test(c.t) ? base36Decode(c.t) : null;
      return out && out.length >= 5 && plausible(out) ? out : null;
    },
  },
  {
    // Same for a single-case run of letters (words are valid Base26), so the bar is higher.
    name: 'base26',
    run: (c) => {
      const out = RE_B26.test(c.t) ? base26Decode(c.t) : null;
      return out && out.length >= 7 && plausible(out) ? out : null;
    },
  },
  onText('base58', (t) => (RE_B58.test(t) ? base58Decode(t) : null)),
  onText('bubblebabble', (t) => {
    // The exact shape plus a checksum that runs through the whole string: nothing else passes.
    const s = t.replace(/\s+/g, '');
    if (s.length < 11 || !BUBBLEBABBLE_SHAPE.test(s)) return null;
    return bubbleBabbleDecode(s).bytes;
  }),
  onText('base100', (t) => {
    // Only the base100 emoji; a short or repetitive run of emoji is just a message, not data.
    if (!RE_B100.test(t)) return null;
    const { bytes } = base100Decode(t);
    return bytes.length >= 5 && new Set(bytes).size >= 3 && plausible(bytes) ? bytes : null;
  }),
  onText('base62', (t) => (RE_B62.test(t) ? base62Decode(t, 'digitsUpper') : null)),
  onText('base62 (0-9a-zA-Z)', (t) => (RE_B62.test(t) ? base62Decode(t, 'digitsLower') : null)),
  onText('ascii85', (t) => {
    const s = stripNl(t);
    const framed = s.startsWith('<~') && s.endsWith('~>') && s.length >= 6;
    return framed || RE_A85.test(s) ? base85Decode(s, 'ascii85') : null;
  }),
  onText('z85', (t) => (RE_Z85.test(t) && t.length % 5 === 0 ? base85Decode(t, 'z85') : null)),
  onText('base85', (t) =>
    RE_B85.test(t) && t.length % 5 !== 1 ? base85Decode(t, 'rfc1924') : null,
  ),
  onText('base91', (t) => (RE_B91.test(t) && /[^A-Za-z0-9]/.test(t) ? base91Decode(t) : null)),
  onText('hex', (t) => (t.length >= 8 && RE_HEX.test(t) ? hexDecode(t) : null)),
  onText('binary', (t) =>
    RE_BIN.test(t) && t.replace(/[^01]/g, '').length >= 8 ? binaryDecode(t) : null,
  ),
  onText('charcode', (t) =>
    RE_DEC_LIST.test(t) ? charcodeDecodeBytes(t, 'dec', 'codepoint') : null,
  ),
  onText('charcode (bytes)', (t) =>
    RE_DEC_LIST.test(t) && /(?:^|\D)(?:1[2-9]\d|2\d\d)(?:\D|$)/.test(t)
      ? charcodeDecodeBytes(t, 'dec', 'utf8')
      : null,
  ),
  onText('charcode (octal)', (t) =>
    RE_OCT_LIST.test(t) ? charcodeDecodeBytes(t, 'oct', 'codepoint') : null,
  ),
  onText('braille', (t) => {
    // Six-dot cells read as English grade 1; a text full of cells that mean nothing is not braille.
    if (!RE_BRAILLE.test(t) || /[\u2840-\u28ff]/.test(t)) return null;
    const r = brailleToText(readCells(t));
    if (r.cells < 3 || r.unknown.length > r.cells * 0.1) return null;
    return utf8Encode(r.text);
  }),
  onText('braille (8-dot bytes)', (t) => {
    // Cells with dot 7 or 8 are bytes: one cell, one byte
    if (!RE_BRAILLE.test(t) || !/[\u2840-\u28ff]/.test(t)) return null;
    const { bytes } = cellsToBytes(readCells(t));
    return bytes.length >= 3 && plausible(bytes) ? bytes : null;
  }),
  onText('nato', (t) => {
    // Four or more words, every one of them in the alphabet, and some letters among them.
    if (t.length < 15 || !/^[A-Za-z0-9\s,.;:\-_/|]+$/.test(t)) return null;
    const r = looksLikeNato(t);
    return r && r.letters >= 3 ? utf8Encode(natoDecode(t).text) : null;
  }),
  onText('punycode', (t) => {
    // Only real "xn--" labels that decode to something non-ASCII; a bad label is left alone.
    if (!/xn--/i.test(t)) return null;
    const r = decodeAceLabels(t, true);
    return r.rows.some((x) => /\P{ASCII}/u.test(x.to)) ? utf8Encode(r.text) : null;
  }),
  onText('uudecode', (t) => {
    // "begin 644 name" ... "end" is proof enough; bare lines must all fit and decode to data
    const out = uuDecodeStrict(t, 'uu');
    return out && (/^begin/m.test(t) || plausible(out)) ? out : null;
  }),
  onText('xxdecode', (t) => {
    const out = uuDecodeStrict(t, 'xx');
    return out && (/^begin/m.test(t) || plausible(out)) ? out : null;
  }),
  onText('mime message', (t) => {
    // Headers, a blank line, then a quoted-printable body: header words and body together
    const msg = splitMessage(t);
    if (!msg) return null;
    const qpBody =
      /^content-transfer-encoding:\s*quoted-printable/im.test(msg.head) || looksLikeQp(msg.body);
    if (!qpBody && !hasEncodedWords(msg.head)) return null;
    const r = decodeMessage(msg, false, 'auto');
    return r.text === t ? null : utf8Encode(r.text);
  }),
  onText('mime words', (t) => {
    // =?charset?Q?…?= and =?charset?B?…?= words, wherever they are in the text
    if (!hasEncodedWords(t)) return null;
    const r = decodeEncodedWords(t);
    return r.words.some((w) => w.text !== null) ? utf8Encode(r.text) : null;
  }),
  onText('quoted-printable', (t) => (looksLikeQp(t) ? qpDecode(t).bytes : null)),
  onText('url', (t) => (/%[0-9a-fA-F]{2}/.test(t) ? urlDecodeOnce(t) : null)),
  onText('html entities', (t) =>
    /&(?:#\d+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);/.test(t) ? htmlDecodeBytes(t) : null,
  ),
  onText('unicode escapes', (t) =>
    hasUnicodeEscape(t) ? unicodeUnescapeBytes(t, 'auto', true) : null,
  ),
  onText('morse', (t) => {
    if (!RE_MORSE.test(t) || !/[.\-•·∙−–—_]/.test(t)) return null;
    const { text, unknown } = morseDecode(t);
    const letters = text.replace(/\s/g, '').length;
    return letters >= 2 && unknown <= letters * 0.25 ? utf8Encode(text) : null;
  }),
];

/**
 * Transforms only count when they make the result read better (see transformHelps).
 * "reverse" followed by a letter substitution is tried as one step: neither half improves the
 * text on its own, and ROT13 and reversing commute, so one order is enough.
 */
export const TRANSFORMS: Step[] = [
  ['rot13', (t: string) => rot(t, 13)],
  ['rot47', rot47],
  ['atbash', atbash],
  ['reverse', reverse],
  ['reverse → rot13', (t: string) => rot(reverse(t), 13)],
  ['reverse → rot47', (t: string) => rot47(reverse(t))],
  ['reverse → atbash', (t: string) => atbash(reverse(t))],
].map(([name, fn]) => onText(name as string, (t) => utf8Encode((fn as (s: string) => string)(t))));

/** The Ctx the beam search hands to every step for a candidate's bytes. */
export function buildCtx(bytes: Uint8Array): Ctx {
  const info = analyse(bytes);
  return {
    bytes,
    t: info.textLike && info.text ? info.text.trim() : '',
    raw: info.textLike && info.text ? info.text : '',
    textLike: info.textLike,
  };
}
