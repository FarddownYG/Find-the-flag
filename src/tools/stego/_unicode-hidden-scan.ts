/**
 * The scan of "Hidden Unicode text": one linear pass over a text that sorts every unusual code
 * point (invisible, control, unusual space, lookalike letter, anything else outside ASCII) and
 * finds the lookalike letters (homoglyphs) in the context of their word. The channels that hide
 * data in these marks are read in _unicode-hidden-invisible.ts and _unicode-hidden-glyph.ts.
 *
 * What counts as a homoglyph. A character imitates an ASCII letter or digit when the Unicode
 * confusables data (UTS #39, type MA) gives it that single ASCII character as its skeleton, or
 * when it is a fullwidth, mathematical, circled, squared or letterlike form of it. Filters keep
 * ordinary text clean:
 *  - only letters and digits count (typographic punctuation and spaces such as ’ « » NBSP map to
 *    ASCII too, but they are normal in French text); accented Latin letters have no entry, as
 *    the standard compares their canonical decomposition, whose base letter is the same;
 *    ligatures and digraphs (œ æ ﬁ ĳ) map to two letters, so they are not a one-letter swap;
 *  - a lookalike must sit in a Latin context: in a word that has another Latin letter, or be a
 *    whole word of lookalikes in a Latin text (half of the letters or more are Latin); fullwidth
 *    and mathematical forms count in any Latin text (they are normal in Japanese or Chinese);
 *  - a Greek letter alone is a symbol (α = 0,05), and a Turkish text writes ı itself.
 */
import { classify, codePointLabel } from './_zerowidth';
import { emojiPart } from './_text-analyzer-hidden';
import type { UnicodeData } from './_unicode-lookup';

/** Why a code point was set apart. The in-place flags are listed but never read as a payload. */
export type Flag =
  | 'invisible'
  | 'control'
  | 'space'
  | 'emoji'
  | 'bom'
  | 'joiner'
  | 'mark'
  | 'tagflag'
  | 'typographic';

export type Kind = 'invisible' | 'control' | 'space' | 'inplace' | 'homoglyph' | 'other';

export const kindOfFlag = (flag: Flag): Kind =>
  flag === 'invisible' || flag === 'control' || flag === 'space' ? flag : 'inplace';

export interface CharStat {
  count: number;
  first: number;
  /** The strongest kind any occurrence was given. */
  kind: Kind;
}

export interface Scan {
  /** The code points of the text. */
  cps: Uint32Array;
  /** Code point index at which each line starts. */
  lineStarts: number[];
  /** Positions of the invisible, control, space and in-place characters, ascending. */
  flagIndex: number[];
  flagKind: Flag[];
  /** Lookalike letters, ascending: position and the ASCII character each one imitates. */
  hitIndex: number[];
  hitLetter: string[];
  /** The first non-ASCII characters (capped), some of which may have become lookalike hits. */
  otherIndex: number[];
  stats: Map<number, CharStat>;
  counts: Record<Kind, number> & { nonAscii: number };
  /** Words mixing letters of two scripts (Latin and Cyrillic, ...). */
  mixedWords: number;
  /** Share of Latin letters among the letters of the text. */
  latinShare: number;
  turkish: boolean;
}

/** How many ordinary non-ASCII positions a scan remembers (the table shows far fewer). */
const OTHER_CAP = 1000;

const RANK: Record<Kind, number> = {
  other: 0,
  inplace: 1,
  space: 2,
  control: 3,
  homoglyph: 4,
  invisible: 5,
};

export function toCodePoints(text: string): Uint32Array {
  const out = new Uint32Array(text.length);
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.codePointAt(i)!;
    if (c > 0xffff) i++;
    out[n++] = c;
  }
  return out.subarray(0, n);
}

// ---------- per code point lookups (memoised: a text repeats a few thousand code points) ----------

export interface Special {
  kind: 'invisible' | 'control' | 'space';
  /** The marker text: ZWSP, TAG a, U+0600... */
  abbr: string;
}

/** The marker text of an invisible character: TAG:a becomes "TAG a". */
function markerAbbr(abbr: string): string {
  if (abbr.startsWith('TAG:')) return `TAG ${abbr.slice(4)}`;
  if (abbr === 'LANGTAG') return 'LANG TAG';
  if (abbr === 'ENDTAG') return 'CANCEL TAG';
  return abbr;
}

const isLatinBlock = (block: string) =>
  block === 'Basic Latin' ||
  block.startsWith('Latin') ||
  block === 'IPA Extensions' ||
  block.startsWith('Phonetic Extensions');

/** Script of a letter, from its block (Blocks.txt); null for the blocks of the Common script. */
export function scriptOfBlock(block: string, cp: number): string | null {
  if (isLatinBlock(block)) return 'Latin';
  if ((cp >= 0xff21 && cp <= 0xff3a) || (cp >= 0xff41 && cp <= 0xff5a)) return 'Latin';
  if (block.startsWith('Cyrillic')) return 'Cyrillic';
  if (block.startsWith('Greek') || block === 'Coptic') return 'Greek';
  if (/^(CJK|Hiragana|Katakana|Hangul|Bopomofo|Kangxi|Kanbun|Halfwidth)/.test(block)) return 'CJK';
  const common =
    /^(Letterlike|Mathematical|Enclosed|Number Forms|Alphabetic Presentation|Spacing Modifier)/;
  return common.test(block) ? null : block;
}

/**
 * What an ASCII lookalike stands for. Compatibility forms (fullwidth, mathematical...) name their
 * letter exactly. For the others the skeleton is a prototype: "l" stands for I and l and 1, "O"
 * for O and 0, so the case and category of the lookalike pick the likely original (a capital
 * Cyrillic І is an I, a small ӏ an l). Null when the character is not a one-letter lookalike.
 */
export function imitates(data: UnicodeData, category: string, cp: number): string | null {
  // Letterlike symbols (the reals, the Kelvin sign) are mathematics and units, not disguises.
  if (cp >= 0x2100 && cp <= 0x214f) return null;
  const compat = data.compat.get(cp);
  if (compat) return compat;
  const skeleton = data.skeleton.get(cp);
  if (skeleton === undefined || skeleton.length !== 1) return null;
  if (!/^(Lu|Ll|Lt|Lm|Lo|Nd)$/.test(category)) return null;
  if (!/^[A-Za-z0-9]$/.test(skeleton)) return null;
  if (skeleton === 'l') return category === 'Nd' ? '1' : category === 'Lu' ? 'I' : 'l';
  if (skeleton === 'O') return category === 'Nd' ? '0' : 'O';
  return skeleton;
}

class Lookups {
  private readonly specials = new Map<number, Special | null>();
  private readonly looks = new Map<number, string | null>();
  private readonly scripts = new Map<number, string | null>();
  private readonly cats = new Map<number, string>();

  constructor(readonly data: UnicodeData) {}

  category(cp: number): string {
    let c = this.cats.get(cp);
    if (c === undefined) {
      c = this.data.category(cp);
      this.cats.set(cp, c);
    }
    return c;
  }

  special(cp: number): Special | null {
    const known = this.specials.get(cp);
    if (known !== undefined) return known;
    const c = classify(cp, true);
    let s: Special | null = c ? { kind: c.kind, abbr: markerAbbr(c.abbr) } : null;
    if (!s && cp >= 0x80) {
      // The bundled categories add what the zero-width table does not list.
      const cat = this.category(cp);
      if (cat === 'Cf') s = { kind: 'invisible', abbr: codePointLabel(cp) };
      else if (cat === 'Zs' || cat === 'Zl' || cat === 'Zp') {
        s = { kind: 'space', abbr: codePointLabel(cp) };
      }
    }
    this.specials.set(cp, s);
    return s;
  }

  script(cp: number): string | null {
    if (cp < 0x80) return 'Latin';
    let s = this.scripts.get(cp);
    if (s === undefined) {
      s = scriptOfBlock(this.data.block(cp), cp);
      this.scripts.set(cp, s);
    }
    return s;
  }

  /** The ASCII letter or digit a non-ASCII character imitates, or null. */
  imitation(cp: number): string | null {
    let r = this.looks.get(cp);
    if (r === undefined) {
      r = imitates(this.data, this.category(cp), cp);
      this.looks.set(cp, r);
    }
    return r;
  }
}

// ---------- the characters that belong where they are ----------

const PICTOGRAPH = /\p{Extended_Pictographic}/u;
const NON_LATIN_LETTER = /^[\p{L}\p{M}]$/u;
const LATIN_SCRIPT = /\p{Script=Latin}/u;
const RTL_SCRIPT = /^[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}]$/u;

const isTag = (cp: number) => cp >= 0xe0020 && cp <= 0xe007f;
const charAt = (cps: Uint32Array, i: number) => String.fromCodePoint(cps[i] || 0x20);

/**
 * Is the run of tag characters starting here an emoji subdivision flag (the black flag, then
 * "gbeng" as tag letters and a cancel tag)? A run of any other shape is a payload.
 */
function flagTagRun(cps: Uint32Array, start: number): { end: number; ok: boolean } {
  let end = start;
  while (end < cps.length && isTag(cps[end]!)) end++;
  const body = end - start - 1;
  let ok = cps[end - 1] === 0xe007f && cps[start - 1] === 0x1f3f4 && body >= 3 && body <= 7;
  for (let i = start; ok && i < end - 1; i++) {
    const c = cps[i]! - 0xe0000;
    ok = (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39);
  }
  return { end, ok };
}

/**
 * A no-break or narrow no-break space where French typography puts one: before : ; ! ? and »,
 * after «, inside a number or between a number and its unit (8 h, 45 €, 18 400).
 */
function typographicSpace(cps: Uint32Array, i: number): boolean {
  const prev = charAt(cps, i - 1);
  const next = charAt(cps, i + 1);
  return (
    /^[:;!?»%€$]$/.test(next) || prev === '«' || (/^\d$/.test(prev) && /^[\p{L}\d€$%]$/u.test(next))
  );
}

/** The flag of an invisible character, 'invisible' unless it belongs where it is. */
function invisibleFlag(
  cps: Uint32Array,
  i: number,
  tag: { end: number; ok: boolean },
  chars: () => string[],
): Flag {
  const cp = cps[i]!;
  if (cp === 0xfeff && i === 0) return 'bom';
  if (isTag(cp)) {
    if (i >= tag.end) Object.assign(tag, flagTagRun(cps, i));
    return tag.ok ? 'tagflag' : 'invisible';
  }
  if (cp === 0xfe0f || cp === 0xfe0e) {
    // After an emoji or a keycap base only: a variation selector after another one is not normal.
    const left = charAt(cps, i - 1);
    return PICTOGRAPH.test(left) || /^[0-9#*]$/.test(left) ? 'emoji' : 'invisible';
  }
  if (cp === 0x200d && emojiPart(chars(), i)) return 'emoji';
  if (cp === 0x200d || cp === 0x200c) {
    // A joiner inside a word of a script that needs them (Persian, Hindi conjuncts).
    const needed = (c: string) => NON_LATIN_LETTER.test(c) && !LATIN_SCRIPT.test(c);
    return needed(charAt(cps, i - 1)) && needed(charAt(cps, i + 1)) ? 'joiner' : 'invisible';
  }
  if (cp === 0x200e || cp === 0x200f || cp === 0x61c) {
    const near = [charAt(cps, i - 1), charAt(cps, i + 1)];
    return near.some((c) => RTL_SCRIPT.test(c)) ? 'mark' : 'invisible';
  }
  return 'invisible';
}

// ---------- the scan ----------

export function scanText(text: string, data: UnicodeData): Scan {
  const cps = toCodePoints(text);
  const n = cps.length;
  const look = new Lookups(data);
  const lineStarts = [0];
  const flagIndex: number[] = [];
  const flagKind: Flag[] = [];
  const hitIndex: number[] = [];
  const hitLetter: string[] = [];
  const otherIndex: number[] = [];
  const stats: Scan['stats'] = new Map();
  const counts = {
    invisible: 0,
    control: 0,
    space: 0,
    inplace: 0,
    homoglyph: 0,
    other: 0,
    nonAscii: 0,
  };

  // First pass: the share of Latin letters (fullwidth and mathematical forms left out, they are
  // what is being judged) and whether the text is Turkish. Both decide what is out of place.
  let letters = 0;
  let latin = 0;
  let turkish = false;
  for (let i = 0; i < n; i++) {
    const cp = cps[i]!;
    if (cp === 10) lineStarts.push(i + 1);
    if (cp < 0x80) {
      if ((cp | 0x20) >= 97 && (cp | 0x20) <= 122) {
        letters++;
        latin++;
      }
      continue;
    }
    if (cp === 0x11e || cp === 0x11f || cp === 0x15e || cp === 0x15f || cp === 0x130)
      turkish = true;
    if (look.category(cp)[0] !== 'L' || data.compat.has(cp)) continue;
    letters++;
    if (look.script(cp) === 'Latin') latin++;
  }
  const latinShare = letters ? latin / letters : 0;
  // A text where Latin letters are at least half of the letters is a Latin text.
  const latinText = latin > 0 && latinShare >= 0.5;

  let allChars: string[] | null = null;
  const chars = () => (allChars ??= Array.from(text));
  const tag = { end: -1, ok: false };

  const addStat = (cp: number, index: number, kind: Kind) => {
    const s = stats.get(cp);
    if (!s) stats.set(cp, { count: 1, first: index, kind });
    else {
      s.count++;
      if (RANK[kind] > RANK[s.kind]) s.kind = kind;
    }
  };
  const flag = (index: number, cp: number, f: Flag) => {
    flagIndex.push(index);
    flagKind.push(f);
    const kind = kindOfFlag(f);
    counts[kind]++;
    addStat(cp, index, kind);
  };
  const other = (index: number, cp: number) => {
    counts.other++;
    addStat(cp, index, 'other');
    if (otherIndex.length < OTHER_CAP) otherIndex.push(index);
  };

  // The word being read: where its lookalike letters are and what else it holds.
  let candidates: number[] = [];
  let ascii = 0; // ASCII letters
  let latinPlain = 0; // other Latin letters that imitate nothing (é, ñ)
  let looks = 0; // lookalike letters and digits
  let foreign = 0; // letters of another script that imitate nothing (и, ж, 日)
  let greekOnly = true;
  let firstScript: string | null = null;
  let mixed = false;
  let mixedWords = 0;
  const closeWord = () => {
    if (firstScript !== null && mixed) mixedWords++;
    if (candidates.length) {
      const inLatinWord = ascii + latinPlain > 0;
      const whole = looks > 0 && ascii + latinPlain + foreign === 0 && latinText && !greekOnly;
      for (const index of candidates) {
        const cp = cps[index]!;
        if (turkish && cp === 0x131) continue;
        const wide = data.compat.has(cp);
        if (!(wide ? latinText : inLatinWord || whole)) continue;
        hitIndex.push(index);
        hitLetter.push(look.imitation(cp)!);
        counts.homoglyph++;
        counts.other--;
        const s = stats.get(cp)!;
        if (RANK.homoglyph > RANK[s.kind]) s.kind = 'homoglyph';
      }
    }
    candidates = [];
    ascii = latinPlain = looks = foreign = 0;
    greekOnly = true;
    firstScript = null;
    mixed = false;
  };
  const wordScript = (script: string | null) => {
    // Han, kana and Hangul mix with Latin letters in ordinary Japanese, Chinese and Korean text.
    if (script === null || script === 'CJK') return;
    if (firstScript === null) firstScript = script;
    else if (script !== firstScript) mixed = true;
  };

  for (let i = 0; i < n; i++) {
    const cp = cps[i]!;
    if (cp < 0x80) {
      if ((cp | 0x20) >= 97 && (cp | 0x20) <= 122) {
        ascii++;
        wordScript('Latin');
        continue;
      }
      if (cp >= 48 && cp <= 57) continue; // digits stay inside the word
      closeWord();
      if (cp === 9 || cp === 10 || (cp >= 0x20 && cp !== 0x7f)) continue;
      if (cp === 13 && cps[i + 1] === 10) continue; // a CR LF line end
      flag(i, cp, 'control');
      continue;
    }

    counts.nonAscii++;
    const sp = look.special(cp);
    if (sp) {
      // Invisible characters do not break a word: a zero-width space inside "paypal" hides.
      if (sp.kind !== 'invisible') closeWord();
      let f: Flag = sp.kind;
      if (sp.kind === 'invisible') f = invisibleFlag(cps, i, tag, chars);
      else if (sp.kind === 'space' && (cp === 0xa0 || cp === 0x202f) && typographicSpace(cps, i)) {
        f = 'typographic';
      }
      flag(i, cp, f);
      continue;
    }

    const cat = look.category(cp);
    const first = cat[0];
    if (first === 'L') {
      const script = look.script(cp);
      wordScript(script);
      if (look.imitation(cp) !== null) {
        candidates.push(i);
        looks++;
        if (script !== 'Greek') greekOnly = false;
      } else if (script === 'Latin') latinPlain++;
      else foreign++;
    } else if (first === 'N' && look.imitation(cp) !== null) {
      candidates.push(i);
      looks++;
      greekOnly = false;
    } else if (first !== 'M' && first !== 'N') closeWord();
    other(i, cp);
  }
  closeWord();

  return {
    cps,
    lineStarts,
    flagIndex,
    flagKind,
    hitIndex,
    hitLetter,
    otherIndex,
    stats,
    counts,
    mixedWords,
    latinShare,
    turkish,
  };
}

/** Line and column (both from 1, in code points) of a position. */
export function lineColumn(scan: Scan, index: number): { line: number; column: number } {
  const starts = scan.lineStarts;
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= index) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: index - starts[lo]! + 1 };
}
