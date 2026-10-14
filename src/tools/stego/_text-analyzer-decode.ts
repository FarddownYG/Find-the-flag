/**
 * Text analyzer passes for encodings: the whole text read as base16/32/58/64/85, binary,
 * char codes, Morse, leet, URL / HTML / Unicode escapes, Braille, Polybius and Bacon, then the
 * same decoders on encoded-looking tokens embedded in prose (a base64 blob inside a sentence),
 * plus the multi-layer auto-decoder. Every decoder is the one of the matching encoding tool.
 */
import { ToolError } from '../../core/errors';
import { fromBase64, toHex, utf8Encode } from '../../lib/bytes';
import { baconDecodeBits, extractSymbols } from '../crypto/bacon';
import { polybiusDecode } from '../crypto/polybius';
import { autoDecode, recipeName } from '../encoding/auto-decode';
import { base32Decode } from '../encoding/base32';
import { base58Decode } from '../encoding/base58';
import { base85Decode } from '../encoding/base85';
import { binaryDecode } from '../encoding/binary';
import { charcodeDecodeBytes } from '../encoding/charcode';
import { hexDecode } from '../encoding/hex';
import { htmlDecode } from '../encoding/html-entities';
import { morseDecode } from '../encoding/morse';
import { hasUnicodeEscape, unicodeUnescape } from '../encoding/unicode-escape';
import { urlDecode } from '../encoding/url';
import {
  deleet,
  foldKey,
  hasLeet,
  leetPhrases,
  oneLine,
  pickBest,
  type Pass,
  type Scorer,
} from './_text-analyzer-core';
import { printableShare } from './_text-analyzer-hidden';

/** The whole-text auto-decoder runs on inputs up to this size. */
const AUTO_MAX = 8000;
/** … and on embedded tokens up to this size (it runs once per token). */
const AUTO_TOKEN_MAX = 2000;
/** Base58 decoding is quadratic: longer texts are not Base58 in practice. */
const BASE58_MAX = 4096;
/** Leet speak is undone on this many characters of the text. */
const LEET_MAX = 20_000;
const MAX_TOKENS = 12;

const strict = new TextDecoder('utf-8', { fatal: true });

/** Bytes as text when they are readable UTF-8, else a short description. */
function asText(bytes: Uint8Array): { text: string | null; why: string } {
  if (!bytes.length) return { text: null, why: 'Decodes to nothing' };
  const binary = {
    text: null,
    why: `Decodes to ${bytes.length} bytes of binary data (${toHex(bytes.subarray(0, 8), ' ')}…): open it in Auto-decode or File type`,
  };
  let text: string;
  try {
    text = strict.decode(bytes);
  } catch {
    return binary;
  }
  return printableShare(text) < 0.9 ? binary : { text, why: '' };
}

type Decoded = Uint8Array | string;

/**
 * Run a decoder speculatively: a ToolError (or a code point out of range, a malformed escape)
 * only means "not this encoding". Anything else is a bug and is not hidden.
 */
function attempt(fn: () => Decoded): { text: string | null; why: string } {
  let out: Decoded;
  try {
    out = fn();
  } catch (e) {
    if (e instanceof ToolError) return { text: null, why: oneLine(e.message, 140) };
    if (e instanceof RangeError || e instanceof URIError) {
      return { text: null, why: 'Does not decode' };
    }
    throw e;
  }
  if (typeof out === 'string') {
    return out.trim() ? { text: out, why: '' } : { text: null, why: 'Decodes to nothing' };
  }
  return asText(out);
}

// ---------------------------------------------------------------------------------------------
// Small decoders the encoding tools do not have

/** Braille grade 1: letters, digits after the number sign, blank cell = space. */
const BRAILLE_LETTERS: Record<number, string> = {
  0x01: 'a',
  0x03: 'b',
  0x09: 'c',
  0x19: 'd',
  0x11: 'e',
  0x0b: 'f',
  0x1b: 'g',
  0x13: 'h',
  0x0a: 'i',
  0x1a: 'j',
  0x05: 'k',
  0x07: 'l',
  0x0d: 'm',
  0x1d: 'n',
  0x15: 'o',
  0x0f: 'p',
  0x1f: 'q',
  0x17: 'r',
  0x0e: 's',
  0x1e: 't',
  0x25: 'u',
  0x27: 'v',
  0x3a: 'w',
  0x2d: 'x',
  0x3d: 'y',
  0x35: 'z',
  0x02: ',',
  0x06: ';',
  0x12: ':',
  0x32: '.',
  0x16: '!',
  0x26: '?',
};
const BRAILLE_DIGITS = 'jabcdefghi';

export function brailleDecode(text: string): string {
  let out = '';
  let numbers = false;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x2800 || cp > 0x28ff) {
      out += ch;
      numbers = false;
      continue;
    }
    const cell = cp - 0x2800;
    if (cell === 0) {
      out += ' ';
      numbers = false;
    } else if (cell === 0x3c) numbers = true;
    else {
      const letter = BRAILLE_LETTERS[cell & 0x3f];
      if (numbers && letter && BRAILLE_DIGITS.includes(letter)) {
        out += String(BRAILLE_DIGITS.indexOf(letter));
      } else out += letter ?? '?';
    }
  }
  return out;
}

/** A1Z26: numbers 1-26 (separated by spaces, commas or dashes) read as the letters a-z. */
export function a1z26Decode(text: string): string {
  const out: string[] = [];
  for (const group of text.trim().split(/\s*[/|]\s*|\s{2,}/)) {
    const numbers = group.split(/[\s,;.-]+/).filter(Boolean);
    let word = '';
    for (const n of numbers) {
      const v = Number(n);
      if (!/^\d{1,2}$/.test(n) || v < 1 || v > 26) {
        throw new ToolError(`"${oneLine(n, 12)}" is not a letter number (1-26).`);
      }
      word += String.fromCharCode(96 + v);
    }
    if (word) out.push(word);
  }
  return out.join(' ');
}

/** Letters of each phone key, as printed on keypads (0 is the space). */
const KEYPAD: Record<string, string> = {
  '2': 'abc',
  '3': 'def',
  '4': 'ghi',
  '5': 'jkl',
  '6': 'mno',
  '7': 'pqrs',
  '8': 'tuv',
  '9': 'wxyz',
};

/**
 * Phone keypad multi-tap: each group of presses of one key is a letter ("44" = h, "7777" = s),
 * "0" a space. Groups are separated by spaces (or commas); "/" also separates words.
 */
export function multitapDecode(text: string): string {
  let out = '';
  for (const group of text.trim().split(/[\s,]+/)) {
    if (/^0+$/.test(group) || group === '/') {
      out += ' ';
      continue;
    }
    const key = group[0]!;
    const letters = KEYPAD[key];
    if (!letters || !/^(\d)\1*$/.test(group) || group.length > letters.length) {
      throw new ToolError(`"${oneLine(group, 12)}" is not one key pressed 1 to 4 times.`);
    }
    out += letters[group.length - 1]!;
  }
  return out.replace(/ +/g, ' ').trim();
}

/** Separator-delimited groups of 2-3 octal digits (with optional backslashes), checked linearly. */
function isOctalList(t: string): boolean {
  if (!/^[0-7\s,;\\]+$/.test(t)) return false;
  const groups = t.split(/[\s,;\\]+/).filter(Boolean);
  return groups.length >= 2 && groups.every((g) => g.length >= 2 && g.length <= 3);
}

/** Text whose letters use exactly two symbols (A/B, 0/1…), read as Bacon's cipher. */
function baconOptions(text: string): { text: string; note: string }[] {
  const { stream, symbols } = extractSymbols(text);
  if (symbols.length !== 2 || stream.length < 10) {
    throw new ToolError('Bacon needs two different symbols and at least 10 of them.');
  }
  const out: { text: string; note: string }[] = [];
  for (const [zero, one] of [symbols, [...symbols].reverse()] as string[][]) {
    const bits = stream.map((c) => (c === zero ? '0' : '1')).join('');
    for (const variant of ['24', '26'] as const) {
      out.push({
        text: baconDecodeBits(bits, variant),
        note: `A=${zero} B=${one}, ${variant}-letter alphabet`,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Whole text

interface Whole {
  label: string;
  /** null when the decoder applies, else why it does not. */
  check: (t: string) => string | null;
  decode: (t: string) => Decoded;
}

const compact = (t: string) => t.replace(/\s+/g, '');
const not = (what: string) => `Not ${what}: the text has other characters`;

const WHOLE: Whole[] = [
  {
    label: 'Hex (base16)',
    check: (t) =>
      !/^(?:0x|\\x)?[0-9a-fA-F]{2}(?:[\s:,;-]*(?:0x|\\x)?[0-9a-fA-F]{2})*$/.test(t)
        ? not('hex')
        : compact(t).length < 8
          ? 'Too short for hex'
          : null,
    decode: hexDecode,
  },
  {
    label: 'Base32',
    check: (t) => {
      const s = compact(t);
      if (!/^(?:[A-Z2-7]+|[a-z2-7]+)={0,6}$/.test(s)) return not('Base32');
      return s.length < 8 ? 'Too short for Base32' : null;
    },
    decode: (t) => base32Decode(compact(t)),
  },
  {
    label: 'Base58',
    check: (t) => {
      const s = compact(t);
      if (!/^[1-9A-HJ-NP-Za-km-z]{6,}$/.test(s)) return not('Base58');
      return s.length > BASE58_MAX ? `Longer than ${BASE58_MAX} characters: not Base58` : null;
    },
    decode: (t) => base58Decode(compact(t)),
  },
  {
    label: 'Base64',
    check: (t) => {
      const s = compact(t);
      if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) return not('Base64');
      const n = s.replace(/=+$/, '').length;
      return n < 4 || n % 4 === 1 ? 'Wrong length for Base64' : null;
    },
    decode: (t) => fromBase64(compact(t)),
  },
  {
    label: 'Base85 (Ascii85)',
    check: (t) => {
      const s = compact(t);
      return (s.startsWith('<~') && s.endsWith('~>')) || /^[!-u]{5,}$/.test(s)
        ? null
        : not('Ascii85');
    },
    decode: (t) => base85Decode(t, 'ascii85'),
  },
  {
    label: 'Binary',
    check: (t) =>
      !/^(?:0b)?[01](?:[\s,;|]*(?:0b)?[01])*$/.test(t)
        ? not('binary')
        : t.replace(/[^01]/g, '').length < 8
          ? 'Fewer than 8 bits'
          : null,
    decode: (t) => binaryDecode(t),
  },
  {
    label: 'Decimal character codes',
    check: (t) => (/^\d{1,7}(?:[\s,;]+\d{1,7})+$/.test(t) ? null : 'Not a list of numbers'),
    decode: (t) => charcodeDecodeBytes(t, 'dec', 'codepoint'),
  },
  {
    label: 'Octal character codes',
    check: (t) => (isOctalList(t) ? null : 'Not a list of octal numbers'),
    decode: (t) => charcodeDecodeBytes(t.replace(/\\/g, ' '), 'oct', 'codepoint'),
  },
  {
    label: 'Letter numbers (A1Z26)',
    check: (t) =>
      /^\d{1,2}(?:[\s,;./|-]+\d{1,2})+$/.test(t) && t.match(/\d+/g)!.length >= 3
        ? null
        : 'Not a list of numbers 1-26',
    decode: a1z26Decode,
  },
  {
    label: 'Morse',
    check: (t) =>
      /^[.\-•·∙−–—_\s/]+$/.test(t) && /[.•·∙]/.test(t) && /[-−–—_]/.test(t)
        ? null
        : 'Not only dots, dashes and separators',
    decode: (t) => {
      const { text, unknown } = morseDecode(t);
      if (unknown > text.length / 4) throw new ToolError('Too many unknown Morse codes.');
      return text;
    },
  },
  {
    label: 'URL escapes (%xx)',
    check: (t) => (/%[0-9a-fA-F]{2}/.test(t) ? null : 'No %xx escape'),
    decode: (t) => urlDecode(t, false, true).bytes,
  },
  {
    label: 'HTML entities',
    check: (t) =>
      /&(?:#\d+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);/.test(t) ? null : 'No &…; entity',
    decode: htmlDecode,
  },
  {
    label: 'Unicode escapes (\\u, \\x, U+)',
    check: (t) => (hasUnicodeEscape(t) ? null : 'No \\uXXXX, \\xHH or U+XXXX escape'),
    decode: (t) => unicodeUnescape(t),
  },
  {
    label: 'Braille',
    check: (t) => (/[\u2801-\u28ff]/.test(t) ? null : 'No Braille cells'),
    decode: brailleDecode,
  },
  {
    label: 'Phone keypad (multi-tap: 44 = h)',
    check: (t) => {
      const groups = t.split(/[\s,]+/).filter(Boolean);
      return /^[0-9\s,/]+$/.test(t) &&
        groups.length >= 3 &&
        groups.every((g) => g === '/' || /^(\d)\1*$/.test(g))
        ? null
        : 'Not groups of one repeated key (44 33 555…)';
    },
    decode: multitapDecode,
  },
  {
    label: 'Polybius square (digit pairs 11-55)',
    check: (t) => {
      const digits = compact(t);
      return /^[1-5]+$/.test(digits) && digits.length >= 4 && digits.length % 2 === 0
        ? null
        : 'Not pairs of digits 1-5';
    },
    decode: (t) => polybiusDecode(t, 'polybius', ''),
  },
  {
    label: 'Tap code (groups of dots)',
    check: (t) =>
      /^[.•·*\s/|]+$/.test(t) && (t.match(/[.•·*]+/g)?.length ?? 0) >= 4
        ? null
        : 'Not groups of dots',
    decode: (t) => polybiusDecode(t, 'tap', ''),
  },
];

function wholeTextPasses(text: string, scorer: Scorer): Pass[] {
  const t = text.trim();
  const out: Pass[] = WHOLE.map((d) => {
    const why = t ? d.check(t) : 'Empty text';
    if (why) return encoding(d.label, null, why);
    const r = attempt(() => d.decode(t));
    return encoding(d.label, r.text, r.text ? '' : r.why);
  });

  out.push(leetPass(t, scorer));

  const baconLabel = 'Bacon (text made of two symbols)';
  const letters = t.replace(/[^\p{L}\p{N}]/gu, '');
  if (new Set(letters.toLowerCase()).size !== 2 || letters.length < 10) {
    out.push(encoding(baconLabel, null, 'Not made of exactly two symbols'));
  } else {
    let options: { text: string; note: string }[] = [];
    let why = '';
    try {
      options = baconOptions(t);
    } catch (e) {
      if (!(e instanceof ToolError)) throw e;
      why = e.message;
    }
    const best = pickBest(options, scorer)?.best;
    out.push(best ? encoding(baconLabel, best.text, best.note) : encoding(baconLabel, null, why));
  }

  out.push(layoutPass(t, scorer));

  const autoLabel = 'Auto-decode (several layers)';
  if (!t) out.push(encoding(autoLabel, null, 'Empty text'));
  else if (t.length > AUTO_MAX) {
    out.push(encoding(autoLabel, null, `Skipped above ${AUTO_MAX} characters: open Auto-decode`));
  } else {
    const best = chain(t);
    out.push(
      best
        ? encoding(autoLabel, best.text, best.note)
        : encoding(autoLabel, null, 'No layer of encoding decodes to readable text'),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Keyboard layouts

/** The same physical keys, row by row, on three layouts. */
const LAYOUTS = {
  QWERTY: "qwertyuiop[]asdfghjkl;'zxcvbnm,./",
  AZERTY: 'azertyuiop^$qsdfghjklmùwxcvbn,;:!',
  Dvorak: "',.pyfgcrl/=aoeuidhtns-;qjkxbmwvz",
} as const;
type Layout = keyof typeof LAYOUTS;

/** Text typed on the keys of `meant` while the computer was set to `typed`, put back. */
export function relayout(text: string, typed: Layout, meant: Layout): string {
  const from = Array.from(LAYOUTS[typed]);
  const to = Array.from(LAYOUTS[meant]);
  const map = new Map<string, string>();
  from.forEach((c, i) => {
    map.set(c, to[i]!);
    const upper = c.toUpperCase();
    if (upper !== c) map.set(upper, to[i]!.toUpperCase());
  });
  return Array.from(text, (c) => map.get(c) ?? c).join('');
}

const LAYOUT_PAIRS: [Layout, Layout][] = [
  ['QWERTY', 'AZERTY'],
  ['AZERTY', 'QWERTY'],
  ['QWERTY', 'Dvorak'],
  ['Dvorak', 'QWERTY'],
];

/**
 * A text typed with the wrong keyboard layout (a French AZERTY typist on a QWERTY setting
 * writes "q" for "a"; Dvorak and QWERTY swap almost every letter). The best of the four
 * swaps; like a cipher on the whole text, it must read better than the text as written.
 */
function layoutPass(text: string, scorer: Scorer): Pass {
  const label = 'Keyboard layout swapped (AZERTY, Dvorak ↔ QWERTY)';
  const sample = text.slice(0, LEET_MAX);
  if (!/[a-z]/i.test(sample)) return encoding(label, null, 'No letters');
  const options = LAYOUT_PAIRS.map(([typed, meant]) => ({
    text: relayout(sample, typed, meant),
    note: `typed on ${meant} keys with a ${typed} layout`,
  }));
  const top = pickBest(options, scorer, foldKey(sample));
  if (!top) return encoding(label, null, 'No swap changes the text');
  const before = scorer.reading(sample).r.score;
  return {
    ...encoding(label, top.best.text, top.best.note),
    mode: 'transform',
    evidence: Math.max(0, Math.min(1, (top.score - before - 10) / 30)),
  };
}

/**
 * Leet speak. When most words are leet, the whole text decoded; when a few phrases are (a
 * password scribbled in a sentence), those phrases alone: the rest is the input itself. Either
 * way it must read better than the leet as written.
 */
function leetPass(t: string, scorer: Scorer): Pass {
  const label = 'Leet speak (1337 → leet)';
  const text = t.length > LEET_MAX ? t.slice(0, LEET_MAX) : t;
  const cut = text.length < t.length ? `, first ${LEET_MAX} characters` : '';
  if (!hasLeet(text)) return encoding(label, null, 'No word mixes letters and digits');
  const options = (['i', 'l'] as const).map((one) => {
    const { phrases, share } = leetPhrases(text, one);
    const whole = share >= 0.6 || !phrases.length;
    return {
      text: whole ? deleet(text, one) : phrases.join(' … '),
      written: whole ? text : null,
      note: `digits read as letters (1 = ${one}, 3 = e, 4 = a, 7 = t…)${whole ? '' : `, ${phrases.length} leet phrase${phrases.length > 1 ? 's' : ''} in the text`}${cut}`,
    };
  });
  const best = pickBest(options, scorer)!.best;
  // Against the leet as written, without reading it as leet. One leet word alone is a handle
  // ("Author: n0b0dy"), not a message.
  const before = best.written === null ? 0 : scorer.read(best.written).score;
  const single = best.written === null && !best.text.includes(' ');
  const gain = Math.max(0, Math.min(1, (scorer.reading(best.text).r.score - before - 10) / 30));
  return {
    ...encoding(label, best.text, single ? `${best.note}; a single leet word` : best.note),
    mode: 'payload',
    evidence: single ? gain * 0.3 : gain,
  };
}

/** Best multi-layer decoding of a string, when it has at least one layer. */
function chain(t: string): { text: string; note: string } | null {
  const result = autoDecode(utf8Encode(t), { maxDepth: 5, beamWidth: 6 });
  const best = result.ranked.find((c) => c.recipe.length && c.textLike && c.text !== null);
  if (!best || best.text === null) return null;
  return { text: best.text, note: recipeName(best) };
}

/** Decoders that rewrite only part of a text (the rest is the input, inherited). */
const PARTIAL = /^(?:URL|HTML|Unicode escapes|Leet)/;

const encoding = (label: string, result: string | null, note: string): Pass => ({
  family: 'encoding',
  mode: PARTIAL.test(label) ? 'transform' : 'payload',
  label,
  result,
  note,
});

// ---------------------------------------------------------------------------------------------
// Tokens inside prose

interface TokenKind {
  name: string;
  /** Global regex of the tokens, or a test on whitespace-delimited words (see `words`). */
  re: RegExp;
  /**
   * The token is a whole word that contains `re` (escapes glued to other characters). Testing
   * word by word keeps the scan linear on long runs without spaces.
   */
  words?: true;
  ok: (token: string) => boolean;
  decode: (token: string) => Decoded;
}

const TOKEN_KINDS: TokenKind[] = [
  {
    name: 'Base64',
    re: /(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/_-]{12,}={0,2}(?![A-Za-z0-9+/=_-])/g,
    ok: (s) => {
      const n = s.replace(/=+$/, '').length;
      return (
        /[A-Z]/.test(s) && /[a-z]/.test(s) && (/[0-9+/]/.test(s) || s.endsWith('=')) && n % 4 !== 1
      );
    },
    decode: fromBase64,
  },
  {
    name: 'Hex',
    re: /(?<![0-9A-Za-z])(?:0x)?(?:[0-9a-fA-F]{2}){6,}(?![0-9A-Za-z])/g,
    ok: (s) => /[0-9]/.test(s) && /[a-fA-F]/.test(s),
    decode: hexDecode,
  },
  {
    name: 'Hex bytes',
    re: /(?<![0-9A-Za-z])(?:[0-9a-fA-F]{2}[ :]){5,}[0-9a-fA-F]{2}(?![0-9A-Za-z])/g,
    ok: (s) => /[0-9]/.test(s),
    decode: hexDecode,
  },
  {
    name: 'Binary',
    re: /(?<![01])(?:[01]{7,8}[ ,]?){3,}(?![01])/g,
    ok: () => true,
    decode: (s) => binaryDecode(s.trim()),
  },
  {
    name: 'Decimal codes',
    re: /(?<![\d.])(?:\d{2,3}[ ,]+){3,}\d{2,3}(?![\d.])/g,
    ok: (s) => (s.match(/\d+/g) ?? []).every((n) => +n >= 32 && +n <= 126),
    decode: (s) => charcodeDecodeBytes(s, 'dec', 'codepoint'),
  },
  {
    name: 'Base32',
    re: /(?<![A-Za-z2-7])[A-Z2-7]{16,}={0,6}(?![A-Za-z2-7=])/g,
    ok: (s) => /[2-7]/.test(s) && /[A-Z]/.test(s),
    decode: (s) => base32Decode(s),
  },
  {
    name: 'Morse',
    re: /(?:[.-]{1,6}(?: \/ | {1,3}|\/)){3,}[.-]{1,6}/g,
    ok: (s) => s.includes('.') && s.includes('-'),
    decode: (s) => {
      const { text, unknown } = morseDecode(s);
      if (unknown > text.length / 4) throw new ToolError('Too many unknown Morse codes.');
      return text;
    },
  },
  {
    name: 'Letter numbers',
    re: /(?<![\d.,])(?:\d{1,2}[ ,-]){3,}\d{1,2}(?![\d.,]?\d)/g,
    ok: (s) => (s.match(/\d+/g) ?? []).every((n) => +n >= 1 && +n <= 26),
    decode: a1z26Decode,
  },
  {
    name: 'URL escapes',
    re: /(?:%[0-9A-Fa-f]{2}){2}/,
    words: true,
    ok: () => true,
    decode: (s) => urlDecode(s, false, true).bytes,
  },
  {
    name: 'HTML entities',
    re: /(?:&(?:#\d{2,7}|#[xX][0-9A-Fa-f]{2,6}|[A-Za-z]{2,8});){2}/,
    words: true,
    ok: () => true,
    decode: htmlDecode,
  },
  {
    name: 'Unicode escapes',
    re: /(?:\\u\{?[0-9A-Fa-f]{2,6}\}?|\\x[0-9A-Fa-f]{2}|\\U[0-9A-Fa-f]{8}){2,}/g,
    ok: () => true,
    decode: (s) => unicodeUnescape(s),
  },
];

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function tokenPasses(text: string, scorer: Scorer): Pass[] {
  const whole = text.trim();
  const found = new Map<string, { kinds: TokenKind[]; index: number }>();
  const add = (kind: TokenKind, raw: string, index: number) => {
    const token = raw.trim();
    if (token === whole || !kind.ok(token)) return;
    const entry = found.get(token) ?? { kinds: [], index };
    entry.kinds.push(kind);
    found.set(token, entry);
  };
  const words = /[%&]/.test(text) ? [...text.matchAll(/\S+/g)] : [];
  for (const kind of TOKEN_KINDS) {
    if (kind.words) {
      // Escapes start with % or &: no need to look at the words when the text has none.
      if (!text.includes(kind.name === 'URL escapes' ? '%' : '&')) continue;
      for (const m of words) if (kind.re.test(m[0])) add(kind, m[0], m.index);
    } else {
      for (const m of text.matchAll(kind.re)) add(kind, m[0], m.index);
    }
  }
  const tokens = [...found.entries()].sort((a, b) => a[1].index - b[1].index);
  const out: Pass[] = [];
  for (const [token, { kinds, index }] of tokens.slice(0, MAX_TOKENS)) {
    const options: { text: string; note: string; kind: string }[] = [];
    for (const kind of kinds) {
      const r = attempt(() => kind.decode(token));
      if (r.text) options.push({ text: r.text, note: kind.name, kind: kind.name });
    }
    const layered = token.length <= AUTO_TOKEN_MAX ? chain(token) : null;
    if (layered && layered.note.includes('→')) {
      options.push({ ...layered, kind: kinds[0]!.name });
    }
    const best = pickBest(options, scorer)?.best;
    const label = `${best?.kind ?? kinds[0]!.name} inside the text: “${oneLine(token, 24)}”`;
    const where = `line ${lineOf(text, index)}`;
    out.push(
      best
        ? encoding(label, best.text, `${where}, ${best.note}`)
        : encoding(label, null, `${where}, does not decode to text`),
    );
  }
  if (!out.length) {
    out.push(
      encoding(
        'Encoded strings inside the text',
        null,
        'No base64, hex, binary, char-code, Morse or escape sequence found among the words',
      ),
    );
  } else if (tokens.length > MAX_TOKENS) {
    out.push(
      encoding(
        'Encoded strings inside the text',
        null,
        `${tokens.length - MAX_TOKENS} more tokens not decoded (first ${MAX_TOKENS} only)`,
      ),
    );
  }
  return out;
}

/** Every encoding pass: the whole text, then tokens embedded in it. */
export function encodingPasses(text: string, scorer: Scorer): Pass[] {
  return [...wholeTextPasses(text, scorer), ...tokenPasses(text, scorer)];
}
