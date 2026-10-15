/**
 * Invisible-character tables and the zero-width steganography engine (decode, encode).
 *
 * The "330k" scheme is the one of https://330k.github.io/misc_tools/unicode_steganography.html
 * (MIT, Kei Misawa): the four characters U+200C U+200D U+202C U+FEFF are the digits 0-3 of a
 * base-4 number; every UTF-16 code unit of the hidden text becomes 8 digits (every byte of hidden
 * binary data 4 digits), and the digit groups are scattered between the visible words.
 */
import { ToolError } from '../../core/errors';
import { toolT } from '../../i18n/tool-text';
import { plaintextScore } from '../../lib/english';
import { utf8Decode, utf8Encode } from '../../lib/bytes';
import { morseToText } from '../audio/_morse';

const T = toolT('zero-width');
/** The parts of a reading's detail, listed ("ZWSP=0 ZWNJ=1, 8 digits per byte"). */
const listParts = (...parts: (string | false)[]): string =>
  parts.filter((p): p is string => !!p).join(T('text.listSep'));

export type CharKind = 'invisible' | 'space' | 'control';

export interface SpecialChar {
  kind: CharKind;
  name: string;
  /** Short label used in text markers, e.g. ZWSP. */
  abbr: string;
}

const NAMED: Record<number, [string, string]> = {
  0x00ad: ['SOFT HYPHEN', 'SHY'],
  0x034f: ['COMBINING GRAPHEME JOINER', 'CGJ'],
  0x061c: ['ARABIC LETTER MARK', 'ALM'],
  0x115f: ['HANGUL CHOSEONG FILLER', 'HCF'],
  0x1160: ['HANGUL JUNGSEONG FILLER', 'HJF'],
  0x17b4: ['KHMER VOWEL INHERENT AQ', 'KVIAQ'],
  0x17b5: ['KHMER VOWEL INHERENT AA', 'KVIAA'],
  0x180b: ['MONGOLIAN FREE VARIATION SELECTOR ONE', 'FVS1'],
  0x180c: ['MONGOLIAN FREE VARIATION SELECTOR TWO', 'FVS2'],
  0x180d: ['MONGOLIAN FREE VARIATION SELECTOR THREE', 'FVS3'],
  0x180e: ['MONGOLIAN VOWEL SEPARATOR', 'MVS'],
  0x180f: ['MONGOLIAN FREE VARIATION SELECTOR FOUR', 'FVS4'],
  0x200b: ['ZERO WIDTH SPACE', 'ZWSP'],
  0x200c: ['ZERO WIDTH NON-JOINER', 'ZWNJ'],
  0x200d: ['ZERO WIDTH JOINER', 'ZWJ'],
  0x200e: ['LEFT-TO-RIGHT MARK', 'LRM'],
  0x200f: ['RIGHT-TO-LEFT MARK', 'RLM'],
  0x202a: ['LEFT-TO-RIGHT EMBEDDING', 'LRE'],
  0x202b: ['RIGHT-TO-LEFT EMBEDDING', 'RLE'],
  0x202c: ['POP DIRECTIONAL FORMATTING', 'PDF'],
  0x202d: ['LEFT-TO-RIGHT OVERRIDE', 'LRO'],
  0x202e: ['RIGHT-TO-LEFT OVERRIDE', 'RLO'],
  0x2060: ['WORD JOINER', 'WJ'],
  0x2061: ['FUNCTION APPLICATION', 'FA'],
  0x2062: ['INVISIBLE TIMES', 'IT'],
  0x2063: ['INVISIBLE SEPARATOR', 'IS'],
  0x2064: ['INVISIBLE PLUS', 'IP'],
  0x2066: ['LEFT-TO-RIGHT ISOLATE', 'LRI'],
  0x2067: ['RIGHT-TO-LEFT ISOLATE', 'RLI'],
  0x2068: ['FIRST STRONG ISOLATE', 'FSI'],
  0x2069: ['POP DIRECTIONAL ISOLATE', 'PDI'],
  0x206a: ['INHIBIT SYMMETRIC SWAPPING', 'ISS'],
  0x206b: ['ACTIVATE SYMMETRIC SWAPPING', 'ASS'],
  0x206c: ['INHIBIT ARABIC FORM SHAPING', 'IAFS'],
  0x206d: ['ACTIVATE ARABIC FORM SHAPING', 'AAFS'],
  0x206e: ['NATIONAL DIGIT SHAPES', 'NADS'],
  0x206f: ['NOMINAL DIGIT SHAPES', 'NODS'],
  0x2800: ['BRAILLE PATTERN BLANK', 'BRAILLE0'],
  0x3164: ['HANGUL FILLER', 'HF'],
  0xfeff: ['ZERO WIDTH NO-BREAK SPACE (BOM)', 'BOM'],
  0xffa0: ['HALFWIDTH HANGUL FILLER', 'HHF'],
  0xfff9: ['INTERLINEAR ANNOTATION ANCHOR', 'IAA'],
  0xfffa: ['INTERLINEAR ANNOTATION SEPARATOR', 'IAS'],
  0xfffb: ['INTERLINEAR ANNOTATION TERMINATOR', 'IAT'],
};

const SPACES: Record<number, [string, string]> = {
  0x00a0: ['NO-BREAK SPACE', 'NBSP'],
  0x1680: ['OGHAM SPACE MARK', 'OSM'],
  0x2000: ['EN QUAD', 'ENQ'],
  0x2001: ['EM QUAD', 'EMQ'],
  0x2002: ['EN SPACE', 'ENSP'],
  0x2003: ['EM SPACE', 'EMSP'],
  0x2004: ['THREE-PER-EM SPACE', '3/MSP'],
  0x2005: ['FOUR-PER-EM SPACE', '4/MSP'],
  0x2006: ['SIX-PER-EM SPACE', '6/MSP'],
  0x2007: ['FIGURE SPACE', 'FSP'],
  0x2008: ['PUNCTUATION SPACE', 'PSP'],
  0x2009: ['THIN SPACE', 'THSP'],
  0x200a: ['HAIR SPACE', 'HSP'],
  0x2028: ['LINE SEPARATOR', 'LS'],
  0x2029: ['PARAGRAPH SEPARATOR', 'PS'],
  0x202f: ['NARROW NO-BREAK SPACE', 'NNBSP'],
  0x205f: ['MEDIUM MATHEMATICAL SPACE', 'MMSP'],
  0x3000: ['IDEOGRAPHIC SPACE', 'IDSP'],
};

const C0 = [
  'NULL',
  'START OF HEADING',
  'START OF TEXT',
  'END OF TEXT',
  'END OF TRANSMISSION',
  'ENQUIRY',
  'ACKNOWLEDGE',
  'BELL',
  'BACKSPACE',
  'CHARACTER TABULATION',
  'LINE FEED',
  'LINE TABULATION',
  'FORM FEED',
  'CARRIAGE RETURN',
  'SHIFT OUT',
  'SHIFT IN',
  'DATA LINK ESCAPE',
  'DEVICE CONTROL ONE',
  'DEVICE CONTROL TWO',
  'DEVICE CONTROL THREE',
  'DEVICE CONTROL FOUR',
  'NEGATIVE ACKNOWLEDGE',
  'SYNCHRONOUS IDLE',
  'END OF TRANSMISSION BLOCK',
  'CANCEL',
  'END OF MEDIUM',
  'SUBSTITUTE',
  'ESCAPE',
  'INFORMATION SEPARATOR FOUR',
  'INFORMATION SEPARATOR THREE',
  'INFORMATION SEPARATOR TWO',
  'INFORMATION SEPARATOR ONE',
];
const C0_ABBR = [
  'NUL',
  'SOH',
  'STX',
  'ETX',
  'EOT',
  'ENQ',
  'ACK',
  'BEL',
  'BS',
  'HT',
  'LF',
  'VT',
  'FF',
  'CR',
  'SO',
  'SI',
  'DLE',
  'DC1',
  'DC2',
  'DC3',
  'DC4',
  'NAK',
  'SYN',
  'ETB',
  'CAN',
  'EM',
  'SUB',
  'ESC',
  'FS',
  'GS',
  'RS',
  'US',
];

/** String.fromCharCode for long arrays (spreading 100k arguments overflows the stack). */
function fromUnits(values: number[]): string {
  let out = '';
  for (let i = 0; i < values.length; i += 8192)
    out += String.fromCharCode(...values.slice(i, i + 8192));
  return out;
}

function fromPoints(values: number[]): string {
  let out = '';
  for (let i = 0; i < values.length; i += 8192)
    out += String.fromCodePoint(...values.slice(i, i + 8192));
  return out;
}

const hex = (cp: number) => cp.toString(16).toUpperCase().padStart(4, '0');
export const codePointLabel = (cp: number) => `U+${hex(cp)}`;

export const isVariationSelector = (cp: number) =>
  (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef);
export const isTagChar = (cp: number) => cp >= 0xe0000 && cp <= 0xe007f;

/** Describe a code point if it is invisible or unusual, otherwise null. */
export function classify(cp: number, includeSpaces = true): SpecialChar | null {
  const named = NAMED[cp];
  if (named) return { kind: 'invisible', name: named[0], abbr: named[1] };
  if (cp >= 0xfe00 && cp <= 0xfe0f) {
    return {
      kind: 'invisible',
      name: `VARIATION SELECTOR-${cp - 0xfe00 + 1}`,
      abbr: `VS${cp - 0xfe00 + 1}`,
    };
  }
  if (cp >= 0xe0100 && cp <= 0xe01ef) {
    return {
      kind: 'invisible',
      name: `VARIATION SELECTOR-${cp - 0xe0100 + 17}`,
      abbr: `VS${cp - 0xe0100 + 17}`,
    };
  }
  if (isTagChar(cp)) {
    if (cp === 0xe0001) return { kind: 'invisible', name: 'LANGUAGE TAG', abbr: 'LANGTAG' };
    if (cp === 0xe007f) return { kind: 'invisible', name: 'CANCEL TAG', abbr: 'ENDTAG' };
    const ch = String.fromCharCode(cp - 0xe0000);
    if (cp >= 0xe0020 && cp <= 0xe007e) {
      return { kind: 'invisible', name: `TAG CHARACTER "${ch}"`, abbr: `TAG:${ch}` };
    }
    return { kind: 'invisible', name: T('value.tagUnassigned'), abbr: `TAG${hex(cp - 0xe0000)}` };
  }
  if (cp < 0x20 && cp !== 9 && cp !== 10 && cp !== 13) {
    return { kind: 'control', name: C0[cp]!, abbr: C0_ABBR[cp]! };
  }
  if (cp === 0x7f) return { kind: 'control', name: 'DELETE', abbr: 'DEL' };
  if (cp >= 0x80 && cp <= 0x9f && cp !== 0x85) {
    return { kind: 'control', name: `C1 CONTROL ${hex(cp)}`, abbr: `C1-${hex(cp)}` };
  }
  if (cp === 0x85) return { kind: 'control', name: 'NEXT LINE', abbr: 'NEL' };
  if (includeSpaces) {
    const sp = SPACES[cp];
    if (sp) return { kind: 'space', name: sp[0], abbr: sp[1] };
  }
  return null;
}

export const codePointsOf = (text: string): number[] =>
  Array.from(text, (c) => c.codePointAt(0) ?? 0);

// ---------- decoding ----------

/** Which family of readings a candidate comes from (what `scheme` names). */
export type SchemeId = '330k' | 'tags' | 'variation' | 'base-k' | 'groups' | 'morse' | 'spaces';

export interface Candidate {
  id: SchemeId;
  /** Scheme family, e.g. "330k unicode steganography". */
  scheme: string;
  /** Character-to-digit mapping and framing, e.g. "ZWSP=0 ZWNJ=1, 8 bits per byte, MSB first". */
  detail: string;
  bytes: Uint8Array;
  text: string;
  score: number;
  /**
   * How many values one decoded unit (a byte, a 7-bit or a 16-bit character) can take: the
   * higher it is, the less likely noise decodes to text. Unset for readings without such units.
   */
  unitValues?: number;
}

/** The four digits of the 330k tool, in order 0..3. */
export const CODE_330K = [0x200c, 0x200d, 0x202c, 0xfeff];

/** Unicode blocks that normal text uses; anything else in a decoded string looks like garbage. */
const COMMON_BLOCKS: [number, number][] = [
  [0xa0, 0x24f],
  [0x370, 0x52f],
  [0x590, 0x6ff],
  [0x2010, 0x2027],
  [0x2030, 0x205e],
  [0x2070, 0x2bff],
  [0x3000, 0x30ff],
  [0x4e00, 0x9fff],
  [0xac00, 0xd7a3],
  [0xff00, 0xffef],
  [0x1f300, 0x1faff],
];

/**
 * How much a decoded string looks like text. English scoring for ASCII, but letters of common
 * scripts count as printable too, while random code units (the usual result of a wrong reading)
 * do not.
 */
export function readability(value: string): number {
  let mapped = '';
  let foreign = 0;
  let total = 0;
  for (const ch of value) {
    const cp = ch.codePointAt(0)!;
    total++;
    if (cp < 0x80) mapped += ch;
    else if (COMMON_BLOCKS.some(([a, b]) => cp >= a && cp <= b)) {
      mapped += '.'; // printable, but not evidence of English
      foreign++;
    } else mapped += '\u0001';
  }
  // Random 16-bit values land in CJK/Hangul half of the time, so non-ASCII text is trusted less.
  return plaintextScore(mapped) * (1 - 0.6 * (foreign / Math.max(1, total)));
}

function makeCandidate(
  [id, scheme]: [SchemeId, string],
  detail: string,
  text: string,
  bytes?: Uint8Array,
  /** Symbols that did not fit the framing (a reading with loose ends is less likely right). */
  leftover = 0,
  unitValues?: number,
): Candidate {
  const b = bytes ?? utf8Encode(text);
  return {
    id,
    scheme,
    detail,
    bytes: b,
    text,
    score: readability(text) * (leftover > 0 ? 0.85 : 1),
    ...(unitValues === undefined ? {} : { unitValues }),
  };
}

/** Smallest m with k^m >= limit (digits needed per value). */
function digitsNeeded(k: number, limit: number): number {
  let m = 1;
  let reach = k;
  while (reach < limit) {
    reach *= k;
    m++;
  }
  return m;
}

/** Group digits into numbers of m digits; null when a group does not fit under `max`. */
function groupDigits(digits: number[], k: number, m: number, little: boolean, max: number) {
  const out: number[] = [];
  for (let i = 0; i + m <= digits.length; i += m) {
    let v = 0;
    for (let j = 0; j < m; j++) v = v * k + digits[little ? i + m - 1 - j : i + j]!;
    if (v >= max) return null;
    out.push(v);
  }
  return out;
}

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items.slice()];
  const out: T[][] = [];
  items.forEach((item, i) => {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const p of permutations(rest)) out.push([item, ...p]);
  });
  return out;
}

function describeMapping(chars: number[]): string {
  return chars.map((cp, i) => `${classify(cp)?.abbr ?? codePointLabel(cp)}=${i}`).join(' ');
}

/** Decode a stream of symbols as base-k digits under every character order and framing. */
function decodeBaseK(
  stream: number[],
  chars: number[],
  family: [SchemeId, string],
  out: Candidate[],
) {
  const k = chars.length;
  const frames: { label: string; limit: number; kind: 'byte' | 'u16' | 'ascii7' }[] = [
    { label: T('detail.digitsPerByte', { n: digitsNeeded(k, 256) }), limit: 256, kind: 'byte' },
    {
      label: T('detail.digitsPerChar16', { n: digitsNeeded(k, 65536) }),
      limit: 65536,
      kind: 'u16',
    },
  ];
  if (k === 2) frames.push({ label: T('detail.ascii7'), limit: 128, kind: 'ascii7' });
  const msb = T('detail.msbFirst');
  const lsb = T('detail.lsbFirst');
  for (const order of permutations(chars)) {
    const index = new Map(order.map((cp, i) => [cp, i]));
    const digits = stream.map((cp) => index.get(cp)!);
    for (const frame of frames) {
      const m = frame.kind === 'ascii7' ? 7 : digitsNeeded(k, frame.limit);
      if (digits.length < m) continue;
      // Stray symbols at the start (a byte order mark, say) shift the framing: also try
      // aligning the groups to the end of the stream.
      const rest = digits.length % m;
      for (const offset of rest ? [0, rest] : [0]) {
        for (const little of [false, true]) {
          const values = groupDigits(digits.slice(offset), k, m, little, frame.limit);
          if (!values || !values.length) continue;
          const detail = listParts(
            describeMapping(order),
            frame.label,
            little ? lsb : msb,
            offset > 0 && T('detail.skipFirst', { n: offset }),
          );
          if (frame.kind === 'u16') {
            out.push(
              makeCandidate(family, detail, fromUnits(values), undefined, rest, frame.limit),
            );
          } else {
            const bytes = Uint8Array.from(values);
            out.push(makeCandidate(family, detail, utf8Decode(bytes), bytes, rest, frame.limit));
          }
        }
      }
    }
  }
}

/** A reading that leaves part of the hidden characters unexplained is less likely to be right. */
function weigh(list: Candidate[], from: number, used: number, all: number): void {
  const coverage = all > 0 ? Math.min(1, used / all) : 1;
  for (let i = from; i < list.length; i++) list[i]!.score *= coverage;
}

function subsetsToTry(counts: Map<number, number>): number[][] {
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([cp]) => cp);
  const seen = new Set<string>();
  const sets: number[][] = [];
  const add = (set: number[]) => {
    const key = [...set].sort((a, b) => a - b).join(',');
    if (set.length >= 2 && !seen.has(key)) {
      seen.add(key);
      sets.push(set);
    }
  };
  for (let k = 2; k <= Math.min(5, ranked.length); k++) add(ranked.slice(0, k));
  const top = ranked.slice(0, 4);
  top.forEach((a, i) => {
    top.slice(i + 1).forEach((b, j) => {
      add([a, b]);
      top.slice(i + 1 + j + 1).forEach((c) => add([a, b, c]));
    });
  });
  return sets;
}

const countOf = (stream: number[]) => {
  const m = new Map<number, number>();
  for (const cp of stream) m.set(cp, (m.get(cp) ?? 0) + 1);
  return m;
};

/**
 * Try every way of reading hidden data out of the text. Returns candidates, best first.
 * Plain text is never the input of a candidate: only invisible characters (and, for the
 * "spaces" family, unusual spaces) carry data.
 */
export function decodeAll(text: string): Candidate[] {
  const cps = codePointsOf(text);
  const hidden = cps.filter((cp) => {
    const c = classify(cp, false);
    return c !== null;
  });
  const out: Candidate[] = [];

  // 1. The exact 330k scheme (text and binary framing).
  const c330 = hidden.filter((cp) => CODE_330K.includes(cp)).map((cp) => CODE_330K.indexOf(cp));
  if (c330.length >= 4) {
    const from = out.length;
    const family: [SchemeId, string] = ['330k', T('scheme.k330')];
    const detail = describeMapping(CODE_330K);
    for (const offset of [0, c330.length % 8].filter((o, i, all) => all.indexOf(o) === i)) {
      const wide = groupDigits(c330.slice(offset), 4, 8, false, 65536);
      if (wide?.length) {
        const skip = offset > 0 && T('detail.skipFirst', { n: offset });
        out.push(
          makeCandidate(
            family,
            listParts(detail, T('detail.textMode'), skip),
            fromUnits(wide),
            undefined,
            c330.length % 8,
            65536,
          ),
        );
      }
    }
    for (const offset of [0, c330.length % 4].filter((o, i, all) => all.indexOf(o) === i)) {
      const narrow = groupDigits(c330.slice(offset), 4, 4, false, 256);
      if (narrow?.length) {
        const bytes = Uint8Array.from(narrow);
        const skip = offset > 0 && T('detail.skipFirst', { n: offset });
        out.push(
          makeCandidate(
            family,
            listParts(detail, T('detail.binaryMode'), skip),
            utf8Decode(bytes),
            bytes,
            c330.length % 4,
            256,
          ),
        );
      }
    }
    weigh(out, from, c330.length, hidden.length);
  }

  // 2. Unicode tag characters carry ASCII directly (U+E0020..E007E = space..~).
  const tags = hidden.filter(isTagChar);
  if (tags.length) {
    const ascii = tags.filter((cp) => cp >= 0xe0020 && cp <= 0xe007e).map((cp) => cp - 0xe0000);
    if (ascii.length) {
      const from = out.length;
      out.push(makeCandidate(['tags', T('scheme.tags')], T('detail.tags'), fromUnits(ascii)));
      weigh(out, from, tags.length, hidden.length);
    }
  }

  // 3. Variation selectors as bytes (VS1-16 = 0-15, VS17-256 = 16-255).
  const vs = hidden.filter(isVariationSelector);
  if (vs.length >= 2) {
    const bytes = Uint8Array.from(
      vs.map((cp) => (cp >= 0xe0100 ? cp - 0xe0100 + 16 : cp - 0xfe00)),
    );
    const from = out.length;
    out.push(
      makeCandidate(
        ['variation', T('scheme.variation')],
        'VS1..VS256 = 0..255',
        utf8Decode(bytes),
        bytes,
        0,
        256,
      ),
    );
    weigh(out, from, vs.length, hidden.length);
  }

  // 4. Generic: any 2..5 invisible characters as the digits of a number.
  const counts = countOf(hidden);
  if (counts.size >= 2) {
    for (const set of subsetsToTry(counts)) {
      const stream = hidden.filter((cp) => set.includes(cp));
      // 5 symbols mean 120 orderings: only worth it while the stream is small.
      if (set.length === 5 && stream.length > 20000) continue;
      const from = out.length;
      decodeBaseK(stream, set, ['base-k', T('scheme.baseK', { k: set.length })], out);
      weigh(out, from, stream.length, hidden.length);
    }
  }

  // 5. Three symbols: one separates letters, the other two are bits (or dot and dash).
  if (counts.size >= 3) {
    const ranked = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([cp]) => cp);
    const stream = hidden.filter((cp) => ranked.includes(cp));
    const from = out.length;
    for (const sep of ranked) {
      const bits = ranked.filter((cp) => cp !== sep);
      for (const [zero, one] of [bits, [bits[1]!, bits[0]!]] as [number, number][]) {
        const groups: number[][] = [[]];
        for (const cp of stream) {
          if (cp === sep) groups.push([]);
          else groups[groups.length - 1]!.push(cp === one ? 1 : 0);
        }
        const used = groups.filter((g) => g.length);
        if (used.length < 2) continue;
        const abbrs = {
          sep: String(classify(sep)?.abbr),
          zero: String(classify(zero)?.abbr),
          one: String(classify(one)?.abbr),
        };
        const chars = used.map((g) => g.reduce((a, b) => a * 2 + b, 0));
        if (chars.every((v) => v > 0 && v < 0x110000)) {
          out.push(
            makeCandidate(
              ['groups', T('scheme.groups')],
              T('detail.groups', abbrs),
              fromPoints(chars),
            ),
          );
        }
        const morse = used.map((g) => g.map((b) => (b ? '-' : '.')).join('')).join(' ');
        out.push(
          makeCandidate(['morse', T('scheme.morse')], T('detail.morse', abbrs), morseToText(morse)),
        );
        // Unknown codes make a Morse reading unlikely, however readable the rest looks.
        const last = out[out.length - 1]!;
        if (last.text.includes('?')) last.score *= 0.4;
      }
    }
    weigh(out, from, stream.length, hidden.length);
  }

  // 6. Two kinds of space (ordinary vs no-break / thin / em ...) as bits.
  const spaces = cps.filter((cp) => cp === 0x20 || classify(cp, true)?.kind === 'space');
  const spaceCounts = countOf(spaces);
  if (spaceCounts.size >= 2) {
    const top = [...spaceCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([cp]) => cp);
    const stream = spaces.filter((cp) => top.includes(cp));
    const before = out.length;
    decodeBaseK(stream, top, ['spaces', T('scheme.spaces')], out);
    weigh(out, before, stream.length, spaces.length);
    const space = T('detail.space');
    for (let i = before; i < out.length; i++) {
      out[i]!.detail = out[i]!.detail.replace(/U\+0020/g, space);
    }
  }

  // Best first; the same text found by several readings is listed once (the first, i.e. the
  // most specific, reading wins ties).
  const ranked = out
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.text.length > 0)
    .sort((a, b) => b.c.score - a.c.score || a.i - b.i);
  const seen = new Set<string>();
  const unique: Candidate[] = [];
  for (const { c } of ranked) {
    if (seen.has(c.text)) continue;
    seen.add(c.text);
    unique.push(c);
  }
  return unique;
}

// ---------- encoding ----------

export type EncodeScheme = 'binary' | '330k' | 'tags' | 'variation';
export type Placement = 'after-first' | 'end' | 'spread';

export const ZW_ZERO = 0x200b;
export const ZW_ONE = 0x200c;

/**
 * The invisible payload for `secret` (a string of invisible characters) split in units. The
 * binary scheme writes bit 0 and bit 1 with `pair` (ZWSP and ZWNJ unless told otherwise).
 */
export function encodePayload(
  secret: string,
  scheme: EncodeScheme,
  pair: readonly [number, number] = [ZW_ZERO, ZW_ONE],
): { units: string[]; chars: number } {
  const units: string[] = [];
  if (scheme === 'binary') {
    for (const byte of utf8Encode(secret)) {
      let u = '';
      for (let b = 7; b >= 0; b--) u += String.fromCodePoint(pair[(byte >> b) & 1]!);
      units.push(u);
    }
  } else if (scheme === '330k') {
    for (let i = 0; i < secret.length; i++) {
      const v = secret.charCodeAt(i);
      let u = '';
      for (let d = 7; d >= 0; d--) u += String.fromCodePoint(CODE_330K[(v >> (2 * d)) & 3]!);
      units.push(u);
    }
  } else if (scheme === 'tags') {
    for (const ch of secret) {
      const cp = ch.codePointAt(0)!;
      if (cp < 0x20 || cp > 0x7e) {
        throw new ToolError(T('error.tagsAscii', { char: ch }));
      }
      units.push(String.fromCodePoint(0xe0000 + cp));
    }
  } else {
    for (const byte of utf8Encode(secret)) {
      units.push(String.fromCodePoint(byte < 16 ? 0xfe00 + byte : 0xe0100 + byte - 16));
    }
  }
  return { units, chars: units.reduce((a, u) => a + [...u].length, 0) };
}

/** Put the payload units into the cover text. Deterministic. */
export function embedPayload(cover: string, units: string[], placement: Placement): string {
  const chars = Array.from(cover);
  if (!units.length) return cover;
  if (placement === 'end') return cover + units.join('');
  if (placement === 'after-first') {
    // After the first visible character, so the text still starts the way it looks.
    return (chars[0] ?? '') + units.join('') + chars.slice(1).join('');
  }
  const n = chars.length;
  const at = new Map<number, string>();
  units.forEach((u, i) => {
    const pos = Math.min(n, Math.floor(((i + 1) * n) / (units.length + 1)) + 1);
    at.set(pos, (at.get(pos) ?? '') + u);
  });
  let out = '';
  for (let i = 0; i <= n; i++) {
    out += at.get(i) ?? '';
    if (i < n) out += chars[i]!;
  }
  return out;
}

/** Remove everything classified as invisible or control from the text (spaces optional). */
export function stripInvisible(text: string, includeSpaces: boolean): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const c = classify(cp, includeSpaces);
    if (c === null) out += ch;
    else if (c.kind === 'space') out += ' ';
  }
  return out;
}
