/**
 * Text analyzer passes for marks a reader does not see: zero-width and other invisible
 * characters, trailing whitespace (stegsnow), unusual or doubled spaces, homoglyphs (Cyrillic,
 * Greek or fullwidth letters inside Latin words), abnormal letter case and stray combining marks.
 * Decoding reuses the zero-width and whitespace tools; this module only adds the homoglyph,
 * case and combining-mark readings.
 */
import { utf8Decode } from '../../lib/bytes';
import { baconDecodeBits, type BaconVariant } from '../crypto/bacon';
import { binaryDecode } from '../encoding/binary';
import { classify, codePointsOf, decodeAll } from './_zerowidth';
import { decodeWhitespace, splitLines } from './whitespace';
import { pickBest, type Pass, type Scorer } from './_text-analyzer-core';

// ---------------------------------------------------------------------------------------------
// Homoglyphs

/** Lookalikes of Latin letters: code point -> [Latin letter, Unicode name]. */
const CONFUSABLES: Record<number, [string, string]> = {
  0x0430: ['a', 'CYRILLIC SMALL LETTER A'],
  0x0435: ['e', 'CYRILLIC SMALL LETTER IE'],
  0x043e: ['o', 'CYRILLIC SMALL LETTER O'],
  0x0440: ['p', 'CYRILLIC SMALL LETTER ER'],
  0x0441: ['c', 'CYRILLIC SMALL LETTER ES'],
  0x0443: ['y', 'CYRILLIC SMALL LETTER U'],
  0x0445: ['x', 'CYRILLIC SMALL LETTER HA'],
  0x0455: ['s', 'CYRILLIC SMALL LETTER DZE'],
  0x0456: ['i', 'CYRILLIC SMALL LETTER BYELORUSSIAN-UKRAINIAN I'],
  0x0458: ['j', 'CYRILLIC SMALL LETTER JE'],
  0x04bb: ['h', 'CYRILLIC SMALL LETTER SHHA'],
  0x04cf: ['l', 'CYRILLIC SMALL LETTER PALOCHKA'],
  0x0501: ['d', 'CYRILLIC SMALL LETTER KOMI DE'],
  0x051b: ['q', 'CYRILLIC SMALL LETTER QA'],
  0x051d: ['w', 'CYRILLIC SMALL LETTER WE'],
  0x0410: ['A', 'CYRILLIC CAPITAL LETTER A'],
  0x0412: ['B', 'CYRILLIC CAPITAL LETTER VE'],
  0x0415: ['E', 'CYRILLIC CAPITAL LETTER IE'],
  0x041a: ['K', 'CYRILLIC CAPITAL LETTER KA'],
  0x041c: ['M', 'CYRILLIC CAPITAL LETTER EM'],
  0x041d: ['H', 'CYRILLIC CAPITAL LETTER EN'],
  0x041e: ['O', 'CYRILLIC CAPITAL LETTER O'],
  0x0420: ['P', 'CYRILLIC CAPITAL LETTER ER'],
  0x0421: ['C', 'CYRILLIC CAPITAL LETTER ES'],
  0x0422: ['T', 'CYRILLIC CAPITAL LETTER TE'],
  0x0423: ['Y', 'CYRILLIC CAPITAL LETTER U'],
  0x0425: ['X', 'CYRILLIC CAPITAL LETTER HA'],
  0x0405: ['S', 'CYRILLIC CAPITAL LETTER DZE'],
  0x0406: ['I', 'CYRILLIC CAPITAL LETTER BYELORUSSIAN-UKRAINIAN I'],
  0x0408: ['J', 'CYRILLIC CAPITAL LETTER JE'],
  0x04c0: ['I', 'CYRILLIC LETTER PALOCHKA'],
  0x051a: ['Q', 'CYRILLIC CAPITAL LETTER QA'],
  0x051c: ['W', 'CYRILLIC CAPITAL LETTER WE'],
  0x03b1: ['a', 'GREEK SMALL LETTER ALPHA'],
  0x03b9: ['i', 'GREEK SMALL LETTER IOTA'],
  0x03ba: ['k', 'GREEK SMALL LETTER KAPPA'],
  0x03bd: ['v', 'GREEK SMALL LETTER NU'],
  0x03bf: ['o', 'GREEK SMALL LETTER OMICRON'],
  0x03c1: ['p', 'GREEK SMALL LETTER RHO'],
  0x03c5: ['u', 'GREEK SMALL LETTER UPSILON'],
  0x03f2: ['c', 'GREEK LUNATE SIGMA SYMBOL'],
  0x03f3: ['j', 'GREEK LETTER YOT'],
  0x0391: ['A', 'GREEK CAPITAL LETTER ALPHA'],
  0x0392: ['B', 'GREEK CAPITAL LETTER BETA'],
  0x0395: ['E', 'GREEK CAPITAL LETTER EPSILON'],
  0x0396: ['Z', 'GREEK CAPITAL LETTER ZETA'],
  0x0397: ['H', 'GREEK CAPITAL LETTER ETA'],
  0x0399: ['I', 'GREEK CAPITAL LETTER IOTA'],
  0x039a: ['K', 'GREEK CAPITAL LETTER KAPPA'],
  0x039c: ['M', 'GREEK CAPITAL LETTER MU'],
  0x039d: ['N', 'GREEK CAPITAL LETTER NU'],
  0x039f: ['O', 'GREEK CAPITAL LETTER OMICRON'],
  0x03a1: ['P', 'GREEK CAPITAL LETTER RHO'],
  0x03a4: ['T', 'GREEK CAPITAL LETTER TAU'],
  0x03a5: ['Y', 'GREEK CAPITAL LETTER UPSILON'],
  0x03a7: ['X', 'GREEK CAPITAL LETTER CHI'],
  0x0131: ['i', 'LATIN SMALL LETTER DOTLESS I'],
  0x0251: ['a', 'LATIN SMALL LETTER ALPHA'],
  0x0261: ['g', 'LATIN SMALL LETTER SCRIPT G'],
  0x0585: ['o', 'ARMENIAN SMALL LETTER OH'],
  0x057d: ['u', 'ARMENIAN SMALL LETTER SEH'],
};

/** The Latin letter or digit a code point imitates, with its name; null if it is not a lookalike. */
export function lookalike(cp: number): [string, string] | null {
  const known = CONFUSABLES[cp];
  if (known) return known;
  if (cp >= 0xff21 && cp <= 0xff3a) {
    const ch = String.fromCharCode(cp - 0xfee0);
    return [ch, `FULLWIDTH LATIN CAPITAL LETTER ${ch}`];
  }
  if (cp >= 0xff41 && cp <= 0xff5a) {
    const ch = String.fromCharCode(cp - 0xfee0);
    return [ch, `FULLWIDTH LATIN SMALL LETTER ${ch.toUpperCase()}`];
  }
  if (cp >= 0xff10 && cp <= 0xff19) {
    const ch = String.fromCharCode(cp - 0xfee0);
    return [ch, `FULLWIDTH DIGIT ${ch}`];
  }
  if (cp >= 0x1d400 && cp <= 0x1d7ff) {
    const ch = String.fromCodePoint(cp).normalize('NFKC');
    if (/^[A-Za-z0-9]$/.test(ch)) return [ch, `MATHEMATICAL ALPHANUMERIC SYMBOL (${ch})`];
  }
  return null;
}

export interface Homoglyph {
  /** 0-based index in code points. */
  index: number;
  line: number;
  column: number;
  char: string;
  cp: number;
  looksLike: string;
  name: string;
}

const LATIN = /[A-Za-z\u00c0-\u024f]/;
const ANY_LETTER = /\p{L}/u;
const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u;

/** For each character: it sits in a word (run of letters, digits, marks) with a Latin letter. */
function latinWords(chars: string[]): Uint8Array {
  const flags = new Uint8Array(chars.length);
  let start = 0;
  let latin = false;
  const close = (end: number) => {
    if (latin) flags.fill(1, start, end);
  };
  chars.forEach((ch, i) => {
    if (WORD_CHAR.test(ch)) {
      if (LATIN.test(ch)) latin = true;
      return;
    }
    close(i);
    start = i + 1;
    latin = false;
  });
  close(chars.length);
  return flags;
}

/**
 * Lookalike letters that sit in Latin text: inside a word that also has Latin letters, or
 * anywhere when the text is mostly Latin (fullwidth and math letters always count). Linear in
 * the length of the text.
 */
export function findHomoglyphs(text: string): Homoglyph[] {
  const chars = Array.from(text);
  let latin = 0;
  let letters = 0;
  for (const ch of chars) {
    if (!ANY_LETTER.test(ch)) continue;
    letters++;
    if (LATIN.test(ch)) latin++;
  }
  if (!latin) return [];
  const mostlyLatin = latin / letters >= 0.8;
  const inLatinWord = latinWords(chars);
  // Turkish writes the dotless ı as a letter of its own (Yarın, ığdır).
  const turkish = /[ğĞşŞİ]/.test(text);
  const found: Homoglyph[] = [];
  let line = 1;
  let column = 1;
  chars.forEach((ch, index) => {
    const cp = ch.codePointAt(0)!;
    const look = cp >= 0x80 ? lookalike(cp) : null;
    if (look && !(turkish && cp === 0x0131)) {
      const wide = cp >= 0xff00;
      // A Greek letter standing alone is a symbol (α = 0,05), not a disguised Latin one.
      const greek = cp >= 0x0370 && cp <= 0x03ff;
      const inWord = inLatinWord[index] === 1;
      if (wide || inWord || (mostlyLatin && !greek)) {
        found.push({ index, line, column, char: ch, cp, looksLike: look[0], name: look[1] });
      }
    }
    if (ch === '\n') {
      line++;
      column = 1;
    } else column++;
  });
  return found;
}

/** The text with every homoglyph replaced by the letter it imitates. */
export function replaceHomoglyphs(text: string, found: Homoglyph[]): string {
  if (!found.length) return text;
  const chars = Array.from(text);
  for (const h of found) if (h.index < chars.length) chars[h.index] = h.looksLike;
  return chars.join('');
}

// ---------------------------------------------------------------------------------------------
// Bits

/** Readable share of a decoded string (no control characters, no U+FFFD). */
export function printableShare(text: string): number {
  if (!text) return 0;
  let ok = 0;
  let n = 0;
  for (const ch of text) {
    n++;
    const cp = ch.codePointAt(0)!;
    if (cp === 0xfffd || (cp < 0x20 && cp !== 9 && cp !== 10 && cp !== 13) || cp === 0x7f) continue;
    if (cp >= 0x80 && cp < 0xa0) continue;
    ok++;
  }
  return ok / n;
}

/** Bits packed into characters of `width` bits (trailing bits dropped), with the binary tool. */
function packBits(bits: number[], width: 7 | 8): string {
  const used = bits.length - (bits.length % width);
  return utf8Decode(binaryDecode(bits.slice(0, used).join(''), width));
}

interface Option {
  text: string;
  note: string;
  /** A Bacon reading: it always gives letters, so the best of several is partly chance. */
  bacon?: boolean;
}

/** The tries a best reading stands for: the Bacon readings when it is one, else itself. */
const triesOf = (best: Option, options: Option[]) =>
  best.bacon ? Math.max(1, options.filter((o) => o.bacon).length) : 1;

/** A readable start this long is kept even when what follows is not text. */
const MIN_PREFIX = 6;

/**
 * The message part of a decoded bit stream. The carriers after the message keep their plain
 * form (lowercase, Latin letter), which reads as zero bytes or Bacon "A"s: they are dropped.
 * When the rest is not text at all, a readable start is kept.
 */
function messagePart(text: string, bacon: boolean): { text: string; cut: boolean } | null {
  const trimmed = bacon
    ? text.replace(/(?:A{2,}|\?{2,})$/, '')
    : text.replace(/[\0\x7f\ufffd]+$/u, '');
  if (!trimmed) return null;
  if (bacon || printableShare(trimmed) >= 0.9) return { text: trimmed, cut: trimmed !== text };
  let end = 0;
  for (const ch of trimmed) {
    if (printableShare(ch) < 1) break;
    end += ch.length;
  }
  return end >= MIN_PREFIX ? { text: trimmed.slice(0, end), cut: true } : null;
}

/** Every reading of a bit stream: 8 or 7 bits per character, Bacon (5 bits per letter). */
function bitReadings(bits: number[], what: string): Option[] {
  const out: Option[] = [];
  for (const flip of [false, true]) {
    const b = flip ? bits.map((x) => 1 - x) : bits;
    const polarity = flip ? `${what} = 0` : `${what} = 1`;
    for (const width of [8, 7] as const) {
      if (b.length < width * 2) continue;
      const part = messagePart(packBits(b, width), false);
      if (part) {
        const rest = part.cut ? ', the rest of the carriers unused' : '';
        out.push({ text: part.text, note: `${polarity}, ${width} bits per character${rest}` });
      }
    }
    if (b.length >= 10) {
      const s = b.join('');
      for (const variant of ['24', '26'] as BaconVariant[]) {
        const part = messagePart(baconDecodeBits(s, variant), true);
        if (!part) continue;
        out.push({
          text: part.text,
          note: `${polarity}, Bacon ${variant}-letter (5 bits per letter)`,
          bacon: true,
        });
      }
    }
  }
  return out;
}

const bestOf = (options: Option[], scorer: Scorer): Option | null =>
  pickBest(options, scorer)?.best ?? null;

// ---------------------------------------------------------------------------------------------
// Passes

const hidden = (label: string, result: string | null, note: string): Pass => ({
  family: 'invisible',
  mode: 'payload',
  label,
  result,
  note,
});

/**
 * A covert channel (invisible characters, whitespace, case, lookalikes) that decodes to
 * printable text is evidence on its own: random marks almost never do. `tries` is how many
 * readings of the marks were compared.
 */
const decoded = (label: string, result: string, note: string, tries = 1): Pass => ({
  ...hidden(label, result, note),
  prior: 1.25,
  tries,
});

function abbrList(cps: number[]): string {
  const counts = new Map<string, number>();
  for (const cp of cps) {
    const abbr = classify(cp)?.abbr ?? `U+${cp.toString(16).toUpperCase()}`;
    counts.set(abbr, (counts.get(abbr) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([a, n]) => `${n} ${a}`)
    .join(', ');
}

const PICTOGRAPH = /\p{Extended_Pictographic}/u;
const SKIN_TONE = /[\u{1f3fb}-\u{1f3ff}]/u;

/**
 * Invisible characters that belong to an emoji sequence: a joiner (U+200D) between two
 * pictographs (a family emoji), a variation selector or keycap mark after one (a coloured sun,
 * a keycap digit), tag characters after the black flag (subdivision flags). Emoji keyboards
 * insert them; they are not a covert channel.
 */
export function emojiPart(chars: string[], i: number): boolean {
  const cp = chars[i]!.codePointAt(0)!;
  // A joiner may follow a skin tone or a variation selector of the pictograph before it.
  let base = i - 1;
  while (base >= 0 && (SKIN_TONE.test(chars[base]!) || chars[base] === '\ufe0f')) base--;
  if (cp === 0x200d) {
    return PICTOGRAPH.test(chars[base] ?? '') && PICTOGRAPH.test(chars[i + 1] ?? '');
  }
  if (cp === 0xfe0f || cp === 0xfe0e || cp === 0x20e3) {
    const left = chars[i - 1] ?? '';
    return PICTOGRAPH.test(left) || /^[0-9#*]$/.test(left) || left === '\ufe0f';
  }
  if (cp >= 0xe0020 && cp <= 0xe007f) {
    for (let j = i - 1; j >= 0; j--) {
      const c = chars[j]!.codePointAt(0)!;
      if (c === 0x1f3f4) return true;
      if (c < 0xe0020 || c > 0xe007f) return false;
    }
  }
  return false;
}

const NON_LATIN = /^[\p{L}\p{M}]$/u;
const LATIN_SCRIPT = /\p{Script=Latin}/u;

/**
 * An invisible character that belongs where it is: part of an emoji sequence, a joiner inside
 * a word of a script that needs them (Persian می‌خواهم, Hindi conjuncts), a byte-order mark at
 * the very start. None of them is a covert channel.
 */
function inPlace(chars: string[], i: number): boolean {
  const cp = chars[i]!.codePointAt(0)!;
  if (cp === 0xfeff && i === 0) return true;
  if (emojiPart(chars, i)) return true;
  if (cp !== 0x200c && cp !== 0x200d) return false;
  const prev = chars[i - 1] ?? '';
  const next = chars[i + 1] ?? '';
  const script = (c: string) => NON_LATIN.test(c) && !LATIN_SCRIPT.test(c);
  return script(prev) && script(next);
}

/**
 * A no-break or narrow no-break space where French typography puts one: before : ; ! ? and
 * », after «, inside a number or between a number and its unit (8 h, 45 €, 18 400).
 */
function typographic(chars: string[], i: number): boolean {
  const prev = chars[i - 1] ?? '';
  const next = chars[i + 1] ?? '';
  return (
    /^[:;!?»%€$]$/.test(next) || prev === '«' || (/^\d$/.test(prev) && /^[\p{L}\d€$%]$/u.test(next))
  );
}

const SPACE_SCHEME = 'Two kinds of space as bits';

function zeroWidthPasses(raw: string, scorer: Scorer): Pass[] {
  const chars = Array.from(raw);
  const cps = codePointsOf(raw);
  const invisible = cps.filter((cp) => classify(cp, false) !== null);
  const spaces = cps.filter((cp) => classify(cp, true)?.kind === 'space');
  const marks = (wanted: (cp: number) => boolean, ok: (i: number) => boolean) => {
    let all = 0;
    let fine = 0;
    chars.forEach((ch, i) => {
      if (!wanted(ch.codePointAt(0)!)) return;
      all++;
      if (ok(i)) fine++;
    });
    return all > 0 && fine === all;
  };
  const allInPlace = marks(
    (cp) => classify(cp, false) !== null,
    (i) => inPlace(chars, i),
  );
  const allTypographic = marks(
    (cp) => classify(cp, true)?.kind === 'space',
    (i) => typographic(chars, i),
  );
  // decodeAll() orders its readings with the zero-width tool's own quick scorer; the 40 best
  // are rescored here with the French + English readability.
  const candidates = invisible.length || spaces.length ? decodeAll(raw) : [];
  const pick = (wanted: (scheme: string) => boolean) =>
    bestOf(
      candidates
        .filter((c) => wanted(c.scheme) && printableShare(c.text) >= 0.9)
        .slice(0, 40)
        .map((c) => ({ text: c.text, note: `${c.scheme}: ${c.detail}` })),
      scorer,
    );
  const out: Pass[] = [];
  const zwLabel = 'Zero-width and invisible characters';
  if (!invisible.length) out.push(hidden(zwLabel, null, 'No invisible characters'));
  else if (allInPlace) {
    out.push(
      hidden(
        zwLabel,
        null,
        `${invisible.length} found (${abbrList(invisible)}), all where they belong: emoji sequences, joiners inside Arabic or Indic words, a byte-order mark at the start`,
      ),
    );
  } else {
    const best = pick((s) => s !== SPACE_SCHEME);
    const found = `${invisible.length} found (${abbrList(invisible)})`;
    out.push(
      best
        ? decoded(zwLabel, best.text, `${found}; ${best.note}`)
        : hidden(zwLabel, null, `${found}, but no reading decodes to text`),
    );
  }
  const spLabel = 'Unusual spaces as bits (NBSP, thin, em…)';
  if (!spaces.length) out.push(hidden(spLabel, null, 'Only ordinary spaces'));
  else if (allTypographic) {
    out.push(
      hidden(
        spLabel,
        null,
        `${spaces.length} unusual spaces (${abbrList(spaces)}), all where French typography puts them: before : ; ! ?, inside « », in numbers and units`,
      ),
    );
  } else {
    const best = pick((s) => s === SPACE_SCHEME);
    const found = `${spaces.length} unusual spaces (${abbrList(spaces)})`;
    out.push(
      best
        ? decoded(spLabel, best.text, `${found}; ${best.note.replace(`${SPACE_SCHEME}: `, '')}`)
        : hidden(spLabel, null, `${found}, too few to carry bits`),
    );
  }
  return out;
}

const WS_SCHEMES: [string, string][] = [
  ['stegsnow', 'Trailing whitespace: stegsnow'],
  ['Trailing whitespace as bits', 'Trailing spaces / tabs as bits'],
  ['One bit per line', 'Lines ending in whitespace or not, as bits'],
  ['Single or double space', 'Single / double spaces between words, as bits'],
];

function whitespacePasses(raw: string, scorer: Scorer): Pass[] {
  const lines = splitLines(raw);
  const trailing = lines.reduce((n, l) => n + l.ws.length, 0);
  const doubles = raw.match(/\S {2}(?=\S)/g)?.length ?? 0;
  const readings = trailing || doubles ? decodeWhitespace(raw) : [];
  return WS_SCHEMES.map(([prefix, label]) => {
    const mine = readings.filter(
      (r) => r.scheme.startsWith(prefix) && printableShare(r.text) >= 0.9,
    );
    const best = bestOf(
      mine.slice(0, 24).map((r) => ({ text: r.text, note: r.detail })),
      scorer,
    );
    if (best) return decoded(label, best.text, best.note);
    if (prefix === 'Single or double space') {
      return hidden(
        label,
        null,
        doubles ? `${doubles} double spaces, nothing decodes` : 'No double spaces',
      );
    }
    return hidden(
      label,
      null,
      trailing
        ? `${trailing} trailing spaces / tabs, nothing decodes`
        : 'No trailing spaces or tabs',
    );
  });
}

function homoglyphPasses(found: Homoglyph[], text: string, scorer: Scorer): Pass[] {
  const lettersLabel = 'Homoglyphs: the letters they imitate';
  const bitsLabel = 'Homoglyphs as bits (lookalike letter = 1)';
  if (!found.length) {
    return [
      hidden(lettersLabel, null, 'No Cyrillic, Greek or fullwidth lookalikes in Latin text'),
      hidden(bitsLabel, null, 'No homoglyphs'),
    ];
  }
  const at = new Set(found.map((h) => h.index));
  const chars = Array.from(text);
  const letterBits: number[] = [];
  const wordBits: number[] = [];
  let inWord = false;
  let wordBit = 0;
  chars.forEach((ch, i) => {
    const isLetter = /[\p{L}\p{N}]/u.test(ch);
    if (isLetter) {
      letterBits.push(at.has(i) ? 1 : 0);
      wordBit |= at.has(i) ? 1 : 0;
      inWord = true;
    } else if (inWord) {
      wordBits.push(wordBit);
      wordBit = 0;
      inWord = false;
    }
  });
  if (inWord) wordBits.push(wordBit);
  // The usual scheme: one bit per letter that has a lookalike (a, e, o, p, c… swapped for
  // Cyrillic when the bit is 1). The carriers are the letters imitated here, or a usual set.
  const look = new Map(found.map((h) => [h.index, h.looksLike]));
  const imitated = [...new Set(found.map((h) => h.looksLike.toLowerCase()))].sort().join('');
  const sets = [
    imitated,
    ...CARRIER_SETS.filter((set) => [...imitated].every((c) => set.includes(c))),
  ];
  const carrierOptions: Option[] = [];
  for (const set of new Set(sets)) {
    for (const upper of [false, true]) {
      const bits: number[] = [];
      chars.forEach((ch, i) => {
        const letter = look.get(i) ?? (/[A-Za-z]/.test(ch) ? ch : null);
        if (letter === null || !set.includes(letter.toLowerCase())) return;
        if (!upper && letter !== letter.toLowerCase()) return;
        bits.push(look.has(i) ? 1 : 0);
      });
      const which = `${[...set].join('/')}${upper ? ' (capitals too)' : ''}`;
      for (const o of bitReadings(bits, 'lookalike')) {
        carrierOptions.push({ ...o, note: `one bit per ${which} letter, ${o.note}` });
      }
    }
  }
  const options = [
    ...carrierOptions,
    ...bitReadings(letterBits, 'lookalike letter').map((o) => ({
      ...o,
      note: `one bit per letter, ${o.note}`,
    })),
    ...bitReadings(wordBits, 'word with a lookalike').map((o) => ({
      ...o,
      note: `one bit per word, ${o.note}`,
    })),
  ];
  const best = bestOf(options, scorer);
  const scripts = new Set(found.map((h) => h.name.split(' ')[0]));
  return [
    hidden(
      lettersLabel,
      found.map((h) => h.looksLike).join(''),
      `${found.length} lookalikes (${[...scripts].join(', ')})`,
    ),
    best
      ? decoded(bitsLabel, best.text, best.note, triesOf(best, options))
      : hidden(bitsLabel, null, 'Too few letters for bits'),
  ];
}

/** Letters that homoglyph encoders commonly swap, smallest set first. */
const CARRIER_SETS = ['aceop', 'aceopxy', 'aceijopsxy'];

const UPPER = /\p{Lu}/u;
const LOWER = /\p{Ll}/u;

function casePasses(text: string, scorer: Scorer): Pass[] {
  const oddLabel = 'Letters in unexpected case';
  const bitsLabel = 'Letter case as bits (capital = 1)';
  const odd: string[] = [];
  for (const word of text.match(/[\p{L}\p{M}]+/gu) ?? []) {
    const letters = Array.from(word).filter((c) => UPPER.test(c) || LOWER.test(c));
    if (letters.length < 2 || letters.every((c) => UPPER.test(c))) continue;
    letters.forEach((c, i) => {
      if (i > 0 && UPPER.test(c)) odd.push(c);
    });
  }
  const cased = Array.from(text).filter((c) => UPPER.test(c) || LOWER.test(c));
  const upper = cased.filter((c) => UPPER.test(c)).length;
  const share = cased.length ? upper / cased.length : 0;
  const abnormal = odd.length >= 2 || (cased.length >= 10 && share >= 0.25 && share <= 0.75);
  const out: Pass[] = [
    odd.length >= 2
      ? {
          ...hidden(oddLabel, odd.join(''), `${odd.length} capitals inside words`),
          pick: 'letters',
        }
      : hidden(oddLabel, null, 'No capitals inside words'),
  ];
  if (!abnormal) {
    out.push(hidden(bitsLabel, null, `Case looks normal (${Math.round(share * 100)}% capitals)`));
    return out;
  }
  // Every letter carries a bit, or only the unaccented ones (encoders that skip é, à…).
  const ascii = cased.filter((c) => /[A-Za-z]/.test(c));
  const options = [
    ...bitReadings(
      cased.map((c) => (UPPER.test(c) ? 1 : 0)),
      'capital',
    ).map((o) => ({ ...o, note: `${cased.length} letters, ${o.note}` })),
    ...(ascii.length < cased.length
      ? bitReadings(
          ascii.map((c) => (UPPER.test(c) ? 1 : 0)),
          'capital',
        ).map((o) => ({
          ...o,
          note: `${ascii.length} letters a-z (accented ones skipped), ${o.note}`,
        }))
      : []),
  ];
  const best = bestOf(options, scorer);
  out.push(
    best
      ? decoded(bitsLabel, best.text, best.note, triesOf(best, options))
      : hidden(bitsLabel, null, 'Too few letters for bits'),
  );
  return out;
}

function combiningPass(raw: string): Pass {
  const label = 'Letters carrying a stray combining mark';
  const nfc = raw.normalize('NFC');
  const marked: string[] = [];
  const chars = Array.from(nfc);
  // Only on Latin letters: Devanagari vowel signs, Arabic or Hebrew vowel points are marks
  // by nature.
  chars.forEach((ch, i) => {
    const base = chars[i - 1] ?? '';
    if (/\p{M}/u.test(ch) && base && !/\p{M}/u.test(base) && LATIN_SCRIPT.test(base)) {
      marked.push(base);
    }
  });
  return marked.length >= 2
    ? hidden(
        label,
        marked.join(''),
        `${marked.length} letters with a mark that does not combine into one character`,
      )
    : hidden(label, null, 'No stray combining marks');
}

/**
 * All invisible-marks passes. `visible` is the text with invisible characters removed; the
 * letter-level readings (lookalikes and case as bits, stray marks) use its first `scope`
 * characters, which is far more than any message needs.
 */
export function invisiblePasses(
  raw: string,
  visible: string,
  homoglyphs: Homoglyph[],
  scorer: Scorer,
  scope = 100_000,
): Pass[] {
  const head = visible.length > scope ? visible.slice(0, scope) : visible;
  return [
    ...zeroWidthPasses(raw, scorer),
    ...whitespacePasses(raw, scorer),
    ...homoglyphPasses(homoglyphs, head, scorer),
    ...casePasses(replaceHomoglyphs(head, homoglyphs), scorer),
    combiningPass(head),
  ];
}
