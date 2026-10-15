/**
 * Lookups in the Unicode data of the "Hidden Unicode text" tool: character names, general
 * categories, blocks, and the confusables skeleton. The data itself is generated from the Unicode
 * 16.0.0 files (scripts/gen-unicode-data.mjs writes ./_unicode-data.ts) and is loaded on first
 * use only, with a dynamic import, so it stays out of the page's first bundle.
 *
 * Formats of the generated strings (one record per line unless said otherwise):
 *   BLOCKS         FIRST;LAST;Block name                       (hex)
 *   CATEGORY_RUNS  space-separated runs "FIRSTcc": from FIRST on, up to the next run, the
 *                  general category is cc (hex, then two letters)
 *   RANGES         FIRST;LAST;label                            (UnicodeData.txt First/Last pairs)
 *   NAMES          "@HEX" sets the code point, every other line is the name of the current
 *                  code point and moves it one on
 *   CONFUSABLES    HEX:ASCII skeleton                          (confusables.txt, type MA)
 *   ASCII_SKELETON CHAR:ASCII skeleton                         (the same, for ASCII sources)
 *   COMPAT         HEX:letter or digit                         (compatibility decomposition)
 */

/** What the computed names need to know about the data. */
export interface NameContext {
  /** The bundled name of a code point, or null. */
  name(cp: number): string | null;
  /** General category ('Cn' when unassigned). */
  category(cp: number): string;
  /** Label of the First/Last range holding the code point, or null. */
  range(cp: number): string | null;
}

const hex = (cp: number) => cp.toString(16).toUpperCase();

// Hangul syllable names (Unicode standard, section 3.12): initial, vowel and final jamo.
const HANGUL_L = [
  'G',
  'GG',
  'N',
  'D',
  'DD',
  'R',
  'M',
  'B',
  'BB',
  'S',
  'SS',
  '',
  'J',
  'JJ',
  'C',
  'K',
  'T',
  'P',
  'H',
];
const HANGUL_V = [
  'A',
  'AE',
  'YA',
  'YAE',
  'EO',
  'E',
  'YEO',
  'YE',
  'O',
  'WA',
  'WAE',
  'OE',
  'YO',
  'U',
  'WEO',
  'WE',
  'WI',
  'YU',
  'EU',
  'YI',
  'I',
];
const HANGUL_T = [
  '',
  'G',
  'GG',
  'GS',
  'N',
  'NJ',
  'NH',
  'D',
  'L',
  'LG',
  'LM',
  'LB',
  'LS',
  'LT',
  'LP',
  'LH',
  'M',
  'B',
  'BS',
  'S',
  'SS',
  'NG',
  'J',
  'C',
  'K',
  'T',
  'P',
  'H',
];

/** HANGUL SYLLABLE GA ... HANGUL SYLLABLE HIH (U+AC00..U+D7A3). */
export function hangulName(cp: number): string {
  const index = cp - 0xac00;
  const initial = Math.floor(index / (21 * 28));
  const vowel = Math.floor((index % (21 * 28)) / 28);
  const final = index % 28;
  return `HANGUL SYLLABLE ${HANGUL_L[initial]}${HANGUL_V[vowel]}${HANGUL_T[final]}`;
}

/**
 * The names that follow a rule instead of being listed: CJK unified and Tangut ideographs
 * (named after their code point), Hangul syllables, the tag characters (TAG + the name of the
 * ASCII character), the variation selectors and the CJK compatibility ideographs. Null for every
 * other code point. scripts/gen-unicode-data.mjs checks this function against UnicodeData.txt
 * and leaves the names it reproduces out of the bundled list.
 */
export function algorithmicName(cp: number, ctx: NameContext): string | null {
  const range = ctx.range(cp);
  if (range !== null) {
    if (range.startsWith('CJK Ideograph')) return `CJK UNIFIED IDEOGRAPH-${hex(cp)}`;
    if (range.startsWith('Tangut Ideograph')) return `TANGUT IDEOGRAPH-${hex(cp)}`;
    if (range === 'Hangul Syllable') return hangulName(cp);
    return null;
  }
  if (cp >= 0xfe00 && cp <= 0xfe0f) return `VARIATION SELECTOR-${cp - 0xfe00 + 1}`;
  if (cp >= 0xe0100 && cp <= 0xe01ef) return `VARIATION SELECTOR-${cp - 0xe0100 + 17}`;
  if (cp === 0xe0001) return 'LANGUAGE TAG';
  if (cp === 0xe007f) return 'CANCEL TAG';
  if (cp >= 0xe0020 && cp <= 0xe007e) {
    const ascii = ctx.name(cp - 0xe0000);
    return ascii === null ? null : `TAG ${ascii}`;
  }
  if (
    ((cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0x2f800 && cp <= 0x2fa1f)) &&
    ctx.category(cp) !== 'Cn'
  ) {
    return `CJK COMPATIBILITY IDEOGRAPH-${hex(cp)}`;
  }
  return null;
}

export interface UnicodeData {
  /** Unicode version of the data, "16.0.0". */
  version: string;
  /** Official name (bundled or computed), or null when this character's name is not bundled. */
  name(cp: number): string | null;
  /** General category: Lu, Ll, Mn, Cf, Zs, ... or Cn for an unassigned code point. */
  category(cp: number): string;
  /** Block name, or "No_Block". */
  block(cp: number): string;
  /** ASCII skeleton of a non-ASCII character (confusables.txt, type MA), e.g. U+0430 -> "a". */
  skeleton: ReadonlyMap<number, string>;
  /** Skeleton of the ASCII characters that have one: I and | and 1 -> "l", 0 -> "O", m -> "rn". */
  asciiSkeleton: ReadonlyMap<string, string>;
  /** Fullwidth, mathematical, circled, squared, letterlike forms of an ASCII letter or digit. */
  compat: ReadonlyMap<number, string>;
}

const records = (s: string) => (s ? s.split('\n') : []);

export interface RawUnicodeData {
  BLOCKS: string;
  CATEGORY_RUNS: string;
  RANGES: string;
  NAMES: string;
  CONFUSABLES: string;
  ASCII_SKELETON: string;
  COMPAT: string;
  UNICODE_VERSION?: string;
}

/** Index of the last entry <= value in a sorted array of starts, or -1. */
function floorIndex(starts: readonly number[], value: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid]! <= value) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** Turn the generated strings into lookups. */
export function buildUnicodeData(raw: RawUnicodeData): UnicodeData {
  const blockStarts: number[] = [];
  const blocks: { last: number; name: string }[] = [];
  for (const line of records(raw.BLOCKS)) {
    const [first, last, name] = line.split(';') as [string, string, string];
    blockStarts.push(parseInt(first, 16));
    blocks.push({ last: parseInt(last, 16), name });
  }
  const catStarts: number[] = [];
  const cats: string[] = [];
  for (const run of raw.CATEGORY_RUNS.split(' ')) {
    catStarts.push(parseInt(run.slice(0, -2), 16));
    cats.push(run.slice(-2));
  }
  const rangeStarts: number[] = [];
  const ranges: { last: number; label: string }[] = [];
  for (const line of records(raw.RANGES)) {
    const [first, last, label] = line.split(';') as [string, string, string];
    rangeStarts.push(parseInt(first, 16));
    ranges.push({ last: parseInt(last, 16), label });
  }
  const names = new Map<number, string>();
  let cursor = 0;
  for (const line of records(raw.NAMES)) {
    if (line.startsWith('@')) cursor = parseInt(line.slice(1), 16);
    else names.set(cursor++, line);
  }
  const pairs = (s: string): [string, string][] =>
    records(s).map((line) => {
      const colon = line.indexOf(':');
      return [line.slice(0, colon), line.slice(colon + 1)];
    });
  const skeleton = new Map(pairs(raw.CONFUSABLES).map(([k, v]) => [parseInt(k, 16), v]));
  const compat = new Map(pairs(raw.COMPAT).map(([k, v]) => [parseInt(k, 16), v]));
  const asciiSkeleton = new Map(pairs(raw.ASCII_SKELETON));

  const category = (cp: number) => {
    const i = floorIndex(catStarts, cp);
    return i < 0 ? 'Cn' : cats[i]!;
  };
  const range = (cp: number) => {
    const i = floorIndex(rangeStarts, cp);
    return i >= 0 && cp <= ranges[i]!.last ? ranges[i]!.label : null;
  };
  const ctx: NameContext = { name: (cp) => names.get(cp) ?? null, category, range };
  return {
    version: raw.UNICODE_VERSION ?? '16.0.0',
    name: (cp) => names.get(cp) ?? algorithmicName(cp, ctx),
    category,
    block(cp) {
      const i = floorIndex(blockStarts, cp);
      return i >= 0 && cp <= blocks[i]!.last ? blocks[i]!.name : 'No_Block';
    },
    skeleton,
    asciiSkeleton,
    compat,
  };
}

let cached: Promise<UnicodeData> | null = null;

/** The Unicode data, loaded once (a separate chunk, fetched the first time a tool needs it). */
export function loadUnicodeData(): Promise<UnicodeData> {
  cached ??= import('./_unicode-data')
    .then((raw) => buildUnicodeData(raw))
    .catch((e: unknown) => {
      cached = null; // a failed fetch of the chunk must not stick
      throw e;
    });
  return cached;
}
