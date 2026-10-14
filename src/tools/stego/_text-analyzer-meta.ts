/**
 * Text analyzer statistics: sizes, character classes, non-ASCII characters with their names,
 * repeated substrings (Kasiski-style spacing), index of coincidence and entropy.
 */
import { utf8Encode } from '../../lib/bytes';
import { indexOfCoincidence } from '../../lib/english';
import { LANG_NAMES, wordsOf, type Scorer } from './_text-analyzer-core';
import { lookalike } from './_text-analyzer-hidden';
import { classify, codePointLabel } from './_zerowidth';

const MAX_NON_ASCII_ROWS = 100;
/** Repeats are searched in this many first characters. */
const REPEAT_SCAN = 10_000;
const REPEAT_MIN = 3;
const REPEAT_MAX = 24;

/** Names of the diacritics NFD splits off Latin letters. */
const MARK_NAMES: Record<number, string> = {
  0x0300: 'GRAVE',
  0x0301: 'ACUTE',
  0x0302: 'CIRCUMFLEX',
  0x0303: 'TILDE',
  0x0304: 'MACRON',
  0x0306: 'BREVE',
  0x0307: 'DOT ABOVE',
  0x0308: 'DIAERESIS',
  0x030a: 'RING ABOVE',
  0x030b: 'DOUBLE ACUTE',
  0x030c: 'CARON',
  0x0323: 'DOT BELOW',
  0x0327: 'CEDILLA',
  0x0328: 'OGONEK',
};

const PUNCTUATION: Record<number, string> = {
  0x00ab: 'LEFT-POINTING DOUBLE ANGLE QUOTATION MARK',
  0x00bb: 'RIGHT-POINTING DOUBLE ANGLE QUOTATION MARK',
  0x00b0: 'DEGREE SIGN',
  0x00a9: 'COPYRIGHT SIGN',
  0x00ae: 'REGISTERED SIGN',
  0x00b7: 'MIDDLE DOT',
  0x00e6: 'LATIN SMALL LETTER AE',
  0x00c6: 'LATIN CAPITAL LETTER AE',
  0x0153: 'LATIN SMALL LIGATURE OE',
  0x0152: 'LATIN CAPITAL LIGATURE OE',
  0x00df: 'LATIN SMALL LETTER SHARP S',
  0x2013: 'EN DASH',
  0x2014: 'EM DASH',
  0x2018: 'LEFT SINGLE QUOTATION MARK',
  0x2019: 'RIGHT SINGLE QUOTATION MARK',
  0x201c: 'LEFT DOUBLE QUOTATION MARK',
  0x201d: 'RIGHT DOUBLE QUOTATION MARK',
  0x2022: 'BULLET',
  0x2026: 'HORIZONTAL ELLIPSIS',
  0x20ac: 'EURO SIGN',
  0x2212: 'MINUS SIGN',
};

/** Unicode name of a character when this module knows it, else a script hint or ''. */
export function charName(cp: number): string {
  const special = classify(cp);
  if (special) return special.name;
  const look = lookalike(cp);
  if (look) return look[1];
  const known = PUNCTUATION[cp];
  if (known) return known;
  const ch = String.fromCodePoint(cp);
  const parts = Array.from(ch.normalize('NFD'));
  if (parts.length >= 2 && /^[A-Za-z]$/.test(parts[0]!)) {
    const marks = parts.slice(1).map((m) => MARK_NAMES[m.codePointAt(0)!]);
    if (marks.every((m) => m !== undefined)) {
      const base = parts[0]!;
      const size = base === base.toUpperCase() ? 'CAPITAL' : 'SMALL';
      return `LATIN ${size} LETTER ${base.toUpperCase()} WITH ${marks.join(' AND ')}`;
    }
  }
  if (/\p{M}/u.test(ch)) return 'combining mark';
  if (/\p{Script=Cyrillic}/u.test(ch)) return 'Cyrillic letter';
  if (/\p{Script=Greek}/u.test(ch)) return 'Greek letter';
  if (/\p{Script=Arabic}/u.test(ch)) return 'Arabic letter';
  if (/\p{Script=Hebrew}/u.test(ch)) return 'Hebrew letter';
  if (/\p{Script=Han}/u.test(ch)) return 'CJK ideograph';
  if (/\p{Extended_Pictographic}/u.test(ch)) return 'emoji / pictograph';
  if (cp >= 0x2800 && cp <= 0x28ff) return 'Braille pattern';
  return '';
}

/** How a character is shown in a table: invisible ones by their abbreviation. */
export function showChar(cp: number): string {
  const special = classify(cp);
  if (special) return `⟦${special.abbr}⟧`;
  if (/\p{M}/u.test(String.fromCodePoint(cp))) return `◌${String.fromCodePoint(cp)}`;
  return String.fromCodePoint(cp);
}

export interface NonAscii {
  cp: number;
  count: number;
  line: number;
  column: number;
}

export function nonAscii(text: string): NonAscii[] {
  const map = new Map<number, NonAscii>();
  let line = 1;
  let column = 1;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0x80) {
      const entry = map.get(cp);
      if (entry) entry.count++;
      else map.set(cp, { cp, count: 1, line, column });
    }
    if (cp === 10) {
      line++;
      column = 1;
    } else column++;
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.cp - b.cp);
}

export interface Repeat {
  text: string;
  /** 1-based character positions. */
  positions: number[];
}

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

/** Substrings of 3+ characters seen 2+ times, longest first; parts of a longer repeat are dropped. */
export function repeats(text: string, top = 10): Repeat[] {
  const s = text.slice(0, REPEAT_SCAN);
  const found = new Map<string, number[]>();
  for (let len = REPEAT_MIN; len <= REPEAT_MAX; len++) {
    const seen = new Map<string, number[]>();
    for (let i = 0; i + len <= s.length; i++) {
      const sub = s.slice(i, i + len);
      const list = seen.get(sub);
      if (list) list.push(i + 1);
      else seen.set(sub, [i + 1]);
    }
    let repeated = false;
    for (const [sub, list] of seen) {
      if (list.length < 2) continue;
      repeated = true;
      if (/[\n\r]/.test(sub) || /^\s|\s$/.test(sub) || sub.replace(/[\s\p{P}]/gu, '').length < 2)
        continue;
      found.set(sub, list);
    }
    if (!repeated) break;
  }
  // A repeat that always continues with the same character is part of a longer one.
  const extendsTo = (sub: string, positions: number[], side: 1 | -1): boolean => {
    const at = (p: number) => (side === 1 ? s[p - 1 + sub.length] : s[p - 2]);
    const first = at(positions[0]!);
    if (first === undefined || !positions.every((p) => at(p) === first)) return false;
    const longer = side === 1 ? sub + first : first + sub;
    return found.get(longer)?.length === positions.length;
  };
  const kept: Repeat[] = [];
  for (const [sub, positions] of found) {
    if (extendsTo(sub, positions, 1) || extendsTo(sub, positions, -1)) continue;
    kept.push({ text: sub, positions });
  }
  return kept
    .sort(
      (a, b) =>
        b.text.length * (b.positions.length - 1) - a.text.length * (a.positions.length - 1) ||
        a.positions[0]! - b.positions[0]!,
    )
    .slice(0, top);
}

/** Greatest common divisor of the distances between occurrences (a Vigenère key length hint). */
export function spacing(positions: number[]): number {
  let g = 0;
  for (let i = 1; i < positions.length; i++) g = gcd(g, positions[i]! - positions[0]!);
  return g;
}

function entropy(text: string): number {
  const counts = new Map<string, number>();
  let n = 0;
  for (const ch of text) {
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
    n++;
  }
  let h = 0;
  for (const c of counts.values()) h -= (c / n) * Math.log2(c / n);
  return h;
}

const pct = (part: number, total: number) =>
  total ? `${part} (${Math.round((part / total) * 100)}%)` : '0';

/** Key / value statistics of the text. */
export function metaEntries(raw: string, scorer: Scorer): [string, string][] {
  let n = 0;
  let ascii = 0;
  let latinExtra = 0;
  let digits = 0;
  let spaces = 0;
  let punctuation = 0;
  let invisible = 0;
  let unusualSpaces = 0;
  let nonAsciiCount = 0;
  const scripts = new Map<string, number>();
  for (const c of raw) {
    n++;
    const cp = c.codePointAt(0)!;
    if ((cp >= 65 && cp <= 90) || (cp >= 97 && cp <= 122)) {
      ascii++;
      continue;
    }
    if (cp >= 48 && cp <= 57) {
      digits++;
      continue;
    }
    if (cp >= 0x80) nonAsciiCount++;
    const special = classify(cp, true);
    if (special?.kind === 'space') unusualSpaces++;
    else if (special) invisible++;
    if (/\s/.test(c)) spaces++;
    else if (cp >= 0xc0 && cp <= 0x24f && /\p{L}/u.test(c)) latinExtra++;
    else if (/\p{L}/u.test(c)) {
      const name = charName(cp).split(' ')[0] || 'other';
      scripts.set(name, (scripts.get(name) ?? 0) + 1);
    } else if (/\p{N}/u.test(c)) digits++;
    else if (/[\p{P}\p{S}]/u.test(c)) punctuation++;
  }
  const otherLetters = [...scripts.values()].reduce((a, b) => a + b, 0);
  const lines = raw.split(/\r?\n/);
  const nonBlank = lines.filter((l) => l.trim()).length;
  const ioc = indexOfCoincidence(raw);
  const read = scorer.read(raw);
  return [
    ['Characters', `${n} (${utf8Encode(raw).length} bytes in UTF-8)`],
    ['Lines', `${lines.length} (${nonBlank} with text)`],
    ['Words', String(wordsOf(raw).length)],
    ['Letters A-Z', pct(ascii, n)],
    ['Accented Latin letters', pct(latinExtra, n)],
    [
      'Other letters',
      otherLetters
        ? `${otherLetters} (${[...scripts.entries()].map(([k, v]) => `${k} ${v}`).join(', ')})`
        : '0',
    ],
    ['Digits', pct(digits, n)],
    ['Spaces, tabs, line breaks', pct(spaces, n)],
    ['Punctuation and symbols', pct(punctuation, n)],
    ['Invisible characters', String(invisible)],
    ['Unusual spaces', String(unusualSpaces)],
    ['Non-ASCII characters', String(nonAsciiCount)],
    [
      'Index of coincidence',
      ioc
        ? `${ioc.toFixed(4)} (English ≈ 0.066, French ≈ 0.078, random letters ≈ 0.038)`
        : 'no letters',
    ],
    ['Entropy', `${entropy(raw).toFixed(2)} bits per character`],
    [
      'Language guess',
      read.lang ? `${LANG_NAMES[read.lang]} (readability ${read.score} / 100)` : 'none recognised',
    ],
  ];
}

/** Rows of the non-ASCII table. */
export function nonAsciiRows(raw: string): { rows: string[][]; more: number } {
  const list = nonAscii(raw);
  return {
    rows: list
      .slice(0, MAX_NON_ASCII_ROWS)
      .map((c) => [
        showChar(c.cp),
        codePointLabel(c.cp),
        charName(c.cp) || '—',
        String(c.count),
        `line ${c.line}, col ${c.column}`,
      ]),
    more: Math.max(0, list.length - MAX_NON_ASCII_ROWS),
  };
}
