import type { Params } from '../../i18n';
import { IOC_REFERENCE, type Fit, type Lang, type Stats } from './_cipher-identify-stats';

/**
 * From the numbers of _cipher-identify-stats.ts to a ranked list of cipher families, each with
 * the reasons that fired. Every family has gates (what must be true for it to be possible at
 * all, multiplied) and supports (extra evidence, added up). The scores say how well a family
 * explains the numbers, not how likely it is: a text this short or this plain cannot say more.
 */

export type FamilyId =
  | 'plain'
  | 'transposition'
  | 'caesar'
  | 'atbash'
  | 'affine'
  | 'substitution'
  | 'vigenere'
  | 'playfair'
  | 'hill'
  | 'bifid'
  | 'adfgx'
  | 'polybius'
  | 'bacon'
  | 'flat';

/** A reason is a translation key (under the tool's namespace) and its numbers. */
export interface Reason {
  key: string;
  params?: Params;
}

/** A tool to open with this text and the options that fit the family. */
export interface Link {
  tool: string;
  options: Record<string, unknown>;
}

export interface Family {
  id: FamilyId;
  /** 0..100. */
  score: number;
  reasons: Reason[];
  /** What counts against this family (shown after the reasons). */
  against: Reason[];
  links: Link[];
  /** Numbers the family name mentions (the Caesar shift, the ADFGX variant...). */
  params: Params;
}

const clamp = (x: number, lo = 0, hi = 1): number => Math.min(hi, Math.max(lo, x));
/** 0 at `lo`, 1 at `hi` (either order), linear in between. */
const ramp = (x: number, lo: number, hi: number): number => clamp((x - lo) / (hi - lo));

const fixed = (x: number, digits = 3): string => x.toFixed(digits);

/** Collects the evidence for one family. */
class Case {
  gate = 1;
  support = 0;
  reasons: Reason[] = [];
  against: Reason[] = [];
  links: Link[] = [];
  params: Params = {};

  constructor(readonly id: FamilyId) {}

  /** Evidence worth `weight` when `strength` is 1; shown as a reason once it is clear enough. */
  add(weight: number, strength: number, reason?: Reason): this {
    this.support += weight * clamp(strength);
    if (reason && strength >= 0.35) this.reasons.push(reason);
    return this;
  }

  /** A condition the family cannot do without: the score is multiplied by it. */
  need(strength: number, reason?: Reason, shown = 0.65): this {
    this.gate *= clamp(strength);
    if (reason && strength < shown) this.against.push(reason);
    return this;
  }

  to(tool: string, options: Record<string, unknown> = {}): this {
    this.links.push({ tool, options });
    return this;
  }

  done(): Family {
    return {
      id: this.id,
      score: Math.min(99, Math.round(100 * clamp(this.gate * this.support))),
      reasons: this.reasons,
      against: this.against,
      links: this.links,
      params: this.params,
    };
  }
}

/** The signals most families share. */
function signals(s: Stats) {
  const n = s.letters;
  const ref = s.lang === 'fr' ? IOC_REFERENCE.fr : IOC_REFERENCE.en;
  const excessId = s.excess[s.lang];
  return {
    n,
    ref,
    lang: s.lang,
    /** The letters follow the language's frequencies (identity). */
    fitsAsIs: ramp(excessId, 0.8, 0.2),
    /** IoC at the language's level. */
    langIoc: ramp(s.ioc, 0.053, 0.062),
    /** Mostly letters, not a text with numbers and symbols. */
    mostlyLetters: ramp(s.letterShare, 0.7, 0.9),
    /** Enough letters for the letter statistics to mean anything (a flag with braces has fewer). */
    someLetters: ramp(s.letterShare, 0.45, 0.7),
    /** Nothing but letters (and whitespace). */
    pure: s.others === 0 && s.digits === 0,
    /** Short texts: the chi-squared of a correct key is noisy, so it is trusted less. */
    shortFactor: n >= 60 ? 1 : 0.7,
    evenLetters: n % 2 === 0,
  };
}

type Sig = ReturnType<typeof signals>;

const iocReason = (g: Sig, s: Stats, key: string): Reason => ({
  key,
  params: { ioc: fixed(s.ioc), ref: fixed(g.ref), lang: g.lang },
});

/** How well one simple key explains the letters: the chi-squared fit, or the text it gives reads. */
const keyFit = (fit: Fit, g: Sig): number =>
  Math.max(ramp(fit.excess, 0.8, 0.2) * g.shortFactor, ramp(fit.read, 25, 55));

function plain(s: Stats, g: Sig): Case {
  const c = new Case('plain');
  c.add(0.5, ramp(s.readability.score, 30, 60), {
    key: 'reason.plain.reads',
    params: { score: Math.round(s.readability.score), lang: g.lang },
  });
  c.add(0.3, g.fitsAsIs, {
    key: 'reason.letters.asIs',
    params: { chi: Math.round(s.chi[g.lang]), lang: g.lang },
  });
  c.add(0.2, g.langIoc, iocReason(g, s, 'reason.ioc.language'));
  c.need(ramp(g.n, 4, 12));
  c.need(g.someLetters);
  // Letters that follow a language but cannot be read as words are scrambled, not plain.
  c.need(ramp(s.readability.score, 10, 35));
  return c;
}

function transposition(s: Stats, g: Sig): Case {
  const c = new Case('transposition');
  c.need(g.fitsAsIs, {
    key: 'reason.transposition.lettersWrong',
    params: { lang: g.lang },
  });
  c.need(g.someLetters);
  c.need(ramp(s.readability.score, 45, 12));
  c.add(0.5, ramp(s.readability.score, 40, 12), {
    key: 'reason.transposition.unreadable',
    params: { score: Math.round(s.readability.score) },
  });
  c.add(0.5, g.langIoc, {
    key: 'reason.transposition.ioc',
    params: { ioc: fixed(s.ioc), lang: g.lang },
  });
  return c
    .to('columnar', { method: 'columnar', mode: 'solve' })
    .to('rail-fence', { mode: 'brute' });
}

type SimpleId = 'caesar' | 'atbash' | 'affine';

/** Caesar / Atbash / affine: the letters fit the language once a simple key is undone. */
function simple(s: Stats, g: Sig, id: SimpleId): Case {
  const c = new Case(id);
  const fit = s[id];
  const strength = keyFit(fit, g);
  const params: Params = {
    shift: fit.b,
    a: fit.a,
    b: fit.b,
    chi: Math.round(fit.chi),
    asIs: Math.round(s.chi[g.lang]),
    lang: g.lang,
    read: Math.round(fit.read),
  };
  c.params = params;
  c.need(strength);
  c.need(ramp(g.n, 3, 8));
  c.need(g.someLetters);
  c.add(0.45, g.langIoc, iocReason(g, s, 'reason.ioc.keepsLanguage'));
  c.add(0.35, 1 - g.fitsAsIs, { key: 'reason.simple.notAsIs', params });
  c.add(0.2, ramp(fit.read, 30, 60), { key: 'reason.simple.reads', params });
  // The chi-squared of the best key is the main reason and is shown first.
  c.reasons.unshift({ key: `reason.${id}.fit`, params });
  if (id === 'caesar') {
    c.to('caesar', { mode: 'brute', alphabet: 'letters' });
  } else if (id === 'atbash') {
    c.to('atbash', {});
  } else c.to('affine', { mode: 'brute' });
  return c;
}

function substitution(s: Stats, g: Sig): Case {
  const c = new Case('substitution');
  const simpleFit = Math.max(keyFit(s.caesar, g), keyFit(s.affine, g), keyFit(s.atbash, g));
  c.need(g.langIoc);
  c.need(g.someLetters);
  c.need(1 - g.fitsAsIs, { key: 'reason.substitution.asIs', params: { lang: g.lang } });
  c.need(ramp(g.n, 20, 60) * 0.5 + 0.5);
  c.need(ramp(s.distinctLetters, 9, 15));
  c.need(ramp(s.ioc, 0.12, 0.09));
  // A cipher that works on pairs of letters repeats pairs, a substitution does not.
  c.need(1 - 0.85 * alignment2(s).strength, { key: 'reason.substitution.pairs' });
  c.add(0.55, g.langIoc, iocReason(g, s, 'reason.ioc.keepsLanguage'));
  c.add(0.25, 1 - simpleFit, { key: 'reason.substitution.noSimpleKey' });
  c.add(0.2, ramp(s.distinctLetters, 8, 16), {
    key: 'reason.substitution.alphabet',
    params: { count: s.distinctLetters },
  });
  c.to('substitution', { mode: 'solve' });
  return c;
}

/** Digraph alignment: equal pairs repeat when the text is read two by two from the start. */
function alignment2(s: Stats): { strength: number; ratio: number } {
  const { aligned, shifted } = s.align2;
  const ratio = (aligned + 1) / (shifted + 1);
  return { strength: ramp(ratio, 1.3, 2.4) * ramp(aligned, 2, 8), ratio };
}

/**
 * Blocks of three: a cipher on triples repeats its blocks from one start only, and the other two
 * starts show hardly any (chance level). A monoalphabetic text repeats THE-like trigrams from all
 * three starts, whatever the alignment of its few frequent ones.
 */
function alignment3(s: Stats): { strength: number; ratio: number; offset: number } {
  const counts = s.align3 as [number, number, number];
  const top = Math.max(...counts);
  const offset = counts.indexOf(top);
  const others = counts.filter((_, i) => i !== offset);
  const worst = Math.max(...others);
  const ratio = (top + 1) / (worst + 1);
  return { strength: ramp(top, 3, 8) * ramp(worst / Math.max(top, 1), 0.5, 0.2), ratio, offset };
}

function vigenere(s: Stats, g: Sig): Case {
  const c = new Case('vigenere');
  const ioc1 = s.period[0]?.ioc ?? s.ioc;
  c.need(ramp(s.ioc, 0.034, 0.039) * ramp(s.ioc, 0.06, 0.052), {
    key: 'reason.vigenere.iocOut',
    params: { ioc: fixed(s.ioc) },
  });
  c.need(g.mostlyLetters);
  const peak = s.peak;
  const lift = peak ? peak.harmonic - ioc1 : 0;
  const strength = peak ? ramp(lift, 0.008, 0.022) * ramp(peak.harmonic, 0.05, 0.062) : 0;
  if (peak) {
    c.params = { period: peak.period };
    c.add(0.55, strength, {
      key: 'reason.vigenere.peak',
      params: {
        period: peak.period,
        peak: fixed(peak.ioc),
        ioc: fixed(ioc1),
        lang: g.lang,
      },
    });
    const repeats = s.kasiski.repeats;
    const votes = s.kasiski.votes[peak.period] ?? 0;
    const share = repeats ? votes / repeats : 0;
    c.add(0.2, ramp(repeats, 3, 6) * ramp(share, 1 / peak.period + 0.15, 0.7), {
      key: 'reason.vigenere.kasiski',
      params: { period: peak.period, votes, repeats },
    });
  }
  c.add(0.15, 1 - g.fitsAsIs, { key: 'reason.vigenere.lettersMixed' });
  c.add(0.1, ramp(s.ioc, 0.034, 0.04), {
    key: 'reason.vigenere.iocBetween',
    params: { ioc: fixed(s.ioc) },
  });
  // No period at all: autokey or a long key remain possible.
  c.add(0.4, (1 - strength) * ramp(s.ioc, 0.034, 0.039) * ramp(s.ioc, 0.05, 0.043), {
    key: 'reason.vigenere.noPeriod',
  });
  c.to('vigenere', { mode: 'crack', variant: 'vigenere', maxLen: 20 });
  return c;
}

/** Missing J (or Q): evidence for a 25-letter square. */
function squareLetters(
  s: Stats,
  n: number,
): { strength: number; missing: string; possible: number } {
  const confidence = ramp(n, 30, 120);
  const missing = s.missing;
  // With enough letters, all 26 present rules a 25-letter square out.
  const possible = missing.length === 0 ? 1 - 0.85 * ramp(n, 60, 150) : 1;
  if (missing.includes('J') && missing.length <= 3) {
    return { strength: confidence * (missing.length === 1 ? 1 : 0.85), missing: 'J', possible };
  }
  if (missing.includes('Q') && missing.length === 1) {
    return { strength: confidence * 0.6, missing: 'Q', possible };
  }
  return { strength: 0, missing: missing.join(''), possible };
}

function playfair(s: Stats, g: Sig): Case {
  const c = new Case('playfair');
  const { strength: align, ratio } = alignment2(s);
  const pairs = s.doubles.pairs;
  const inPairs = s.doubles.inPairs;
  c.need(g.pure ? 1 : ramp(s.letterShare, 0.85, 0.97) * 0.5);
  c.need(g.evenLetters ? 1 : 0.2, { key: 'reason.playfair.odd', params: { count: g.n } });
  c.need(ramp(g.n, 8, 30));
  // A letter doubled inside a pair rules out Playfair itself (two-square allows it).
  c.need(inPairs === 0 ? 1 : pairs < 15 ? 0.7 : 0.12, {
    key: 'reason.playfair.doubled',
    params: { count: inPairs },
  });
  const noDouble = inPairs === 0 ? 1 - Math.exp(-pairs * IOC_REFERENCE.random) : 0;
  c.add(0.25, noDouble, {
    key: 'reason.playfair.noDouble',
    params: { pairs, expected: (pairs * IOC_REFERENCE.random).toFixed(1) },
  });
  const sq = squareLetters(s, g.n);
  c.add(0.2, sq.strength, { key: 'reason.square.missing', params: { letter: sq.missing } });
  c.add(0.05, g.evenLetters ? 1 : 0, { key: 'reason.playfair.even', params: { count: g.n } });
  c.add(0.4, align, {
    key: 'reason.digraph.aligned',
    params: { aligned: s.align2.aligned, shifted: s.align2.shifted, ratio: fixed(ratio, 1) },
  });
  c.add(0.1, ramp(s.ioc, 0.036, 0.042) * ramp(s.ioc, 0.06, 0.054), {
    key: 'reason.digraph.ioc',
    params: { ioc: fixed(s.ioc) },
  });
  c.to('playfair', {
    mode: 'solve',
    variant: 'playfair',
    language: g.lang === 'fr' ? 'french' : 'english',
  });
  return c;
}

function hill(s: Stats, g: Sig): Case {
  const c = new Case('hill');
  const a2 = alignment2(s);
  const a3 = alignment3(s);
  const useThree = g.n % 3 === 0 && a3.strength > a2.strength;
  c.need(g.pure ? 1 : ramp(s.letterShare, 0.85, 0.97) * 0.5);
  c.need(g.evenLetters || g.n % 3 === 0 ? 1 : 0.2, {
    key: 'reason.hill.length',
    params: { count: g.n },
  });
  c.need(ramp(g.n, 12, 40));
  const sq = squareLetters(s, g.n);
  // Without J, the Playfair square explains the same pairs better.
  c.need(1 - 0.45 * sq.strength);
  // Blocks of letters are the only thing Hill leaves behind: no repeated blocks, no Hill.
  c.need(0.1 + 0.9 * (useThree ? a3.strength : a2.strength));
  // Any block cipher flattens the letter counts: a text that keeps a language's IoC is not Hill.
  c.need(ramp(s.ioc, 0.064, 0.056), { key: 'reason.hill.iocHigh', params: { ioc: fixed(s.ioc) } });
  if (useThree) {
    c.add(0.55, a3.strength, {
      key: 'reason.hill.aligned3',
      params: { count: Math.max(...s.align3), offset: a3.offset, ratio: fixed(a3.ratio, 1) },
    });
  } else {
    c.add(0.55, a2.strength, {
      key: 'reason.digraph.aligned',
      params: { aligned: s.align2.aligned, shifted: s.align2.shifted, ratio: fixed(a2.ratio, 1) },
    });
  }
  c.add(0.15, ramp(s.ioc, 0.034, 0.04) * ramp(s.ioc, 0.06, 0.054), {
    key: 'reason.digraph.ioc',
    params: { ioc: fixed(s.ioc) },
  });
  c.add(0.15, ramp(s.doubles.inPairs, 0, 2) * ramp(g.n, 40, 100), {
    key: 'reason.hill.doubled',
    params: { count: s.doubles.inPairs },
  });
  c.add(0.15, ramp(s.distinctLetters, 22, 26), {
    key: 'reason.hill.alphabet',
    params: { count: s.distinctLetters },
  });
  if (useThree)
    c.to('hill', { mode: 'known', size: 3, language: g.lang === 'fr' ? 'french' : 'english' });
  else c.to('hill', { mode: 'brute', language: g.lang === 'fr' ? 'french' : 'english' });
  return c;
}

function bifid(s: Stats, g: Sig): Case {
  const c = new Case('bifid');
  const a2 = alignment2(s);
  const sq = squareLetters(s, g.n);
  c.need(g.pure ? 1 : ramp(s.letterShare, 0.8, 0.95) * 0.6);
  c.need(sq.possible, { key: 'reason.bifid.alphabet', params: { count: s.distinctLetters } });
  c.need(ramp(s.ioc, 0.062, 0.054), { key: 'reason.bifid.iocHigh', params: { ioc: fixed(s.ioc) } });
  c.need(1 - a2.strength, { key: 'reason.bifid.pairs' });
  c.need(ramp(g.n, 20, 80));
  c.need(s.doubles.inPairs === 0 && s.doubles.pairs >= 25 ? 0.35 : 1, {
    key: 'reason.bifid.noDoubles',
  });
  c.add(0.4, sq.strength, { key: 'reason.square.missing', params: { letter: sq.missing } });
  c.add(0.25, ramp(s.ioc, 0.036, 0.04) * ramp(s.ioc, 0.056, 0.05), {
    key: 'reason.bifid.ioc',
    params: { ioc: fixed(s.ioc) },
  });
  c.add(0.15, 1 - g.fitsAsIs, { key: 'reason.vigenere.lettersMixed' });
  c.add(0.1, ramp(s.doubles.inPairs, 0, 2) * ramp(s.doubles.pairs, 20, 60), {
    key: 'reason.bifid.doubled',
    params: { count: s.doubles.inPairs },
  });
  c.add(0.1, 1 - ramp(s.peak ? s.peak.harmonic - (s.period[0]?.ioc ?? s.ioc) : 0, 0.01, 0.02), {
    key: 'reason.bifid.noPeriod',
  });
  c.to('bifid', { cipher: 'bifid', mode: 'periods' });
  return c;
}

/** ADFGX / ADFGVX: only the coordinate letters. */
function adfgx(s: Stats, g: Sig): Case {
  const c = new Case('adfgx');
  const set = s.adfgvx;
  const six = set !== null && set.includes('V');
  const size = six ? 6 : 5;
  c.params = { size };
  c.need(set ? 1 : 0);
  if (!set) return c;
  c.need(g.pure ? 1 : 0);
  c.need(ramp(set.length, size - 2, size));
  // The coordinate pairs of a plain Polybius square would have the IoC of letters.
  c.need(ramp(s.pairIoc, 0.062, 0.05), {
    key: 'reason.adfgx.plainPairs',
    params: { ioc: fixed(s.pairIoc) },
  });
  c.add(0.7, set.length === size ? 1 : 0.6, {
    key: 'reason.adfgx.letters',
    params: { size, letters: set.join(' ') },
  });
  c.add(0.15, g.evenLetters ? 1 : 0.2, { key: 'reason.adfgx.even', params: { count: g.n } });
  c.add(0.15, ramp(s.pairIoc, 0.058, 0.048), {
    key: 'reason.adfgx.pairs',
    params: { ioc: fixed(s.pairIoc) },
  });
  c.to('adfgvx', { variant: six ? 'adfgvx' : 'adfgx', mode: 'decrypt' });
  return c;
}

/** Coordinates written as letters or digits with no transposition: one pair, one letter. */
function polybius(s: Stats, g: Sig): Case {
  const c = new Case('polybius');
  const coords = s.digitsOnly && s.coordinatePairs;
  const letterPairs = s.adfgvx !== null && g.pure && g.evenLetters && s.pairIoc >= 0.05;
  c.need(coords || letterPairs ? 1 : 0);
  if (coords) {
    c.add(0.9, 1, {
      key: 'reason.polybius.digits',
      params: { digits: s.digitSet.join(' '), pairs: Math.floor(s.digits / 2) },
    });
    c.add(0.1, g.evenLetters || s.digits % 2 === 0 ? 1 : 0);
    c.to('polybius', { cipher: 'polybius', mode: 'decode' });
  } else if (letterPairs) {
    c.add(0.9, ramp(s.pairIoc, 0.05, 0.062), {
      key: 'reason.polybius.letters',
      params: { ioc: fixed(s.pairIoc) },
    });
    c.add(0.1, 1);
    c.to('polybius', { cipher: 'adfgx', mode: 'decode' });
  }
  return c;
}

function bacon(s: Stats, g: Sig): Case {
  const c = new Case('bacon');
  const two = s.twoSymbols;
  // Case-coded: letters that flip between upper and lower case far more than any prose does.
  const flips = s.letters > 1 ? s.caseSwitches / (s.letters - 1) : 0;
  // Only letters: an encoding such as Base64 flips case just as often, with digits among them.
  const caseCoded =
    g.pure &&
    s.letters >= 15 &&
    s.upper >= s.letters * 0.25 &&
    s.lower >= s.letters * 0.25 &&
    flips >= 0.3;
  if (two && s.symbols >= 10) {
    const multiple = s.symbols % 5 === 0;
    c.add(0.6, 1, { key: 'reason.bacon.two', params: { a: two[0]!, b: two[1]! } });
    c.add(0.3, multiple ? 1 : 0.35, {
      key: multiple ? 'reason.bacon.multiple' : 'reason.bacon.leftover',
      params: { count: s.symbols, rest: s.symbols % 5 },
    });
    c.add(0.1, two.join('').toUpperCase() === 'AB' ? 1 : 0, { key: 'reason.bacon.ab' });
    c.to('bacon', { mode: 'decode' });
  } else if (caseCoded) {
    c.add(0.55, ramp(flips, 0.3, 0.45), {
      key: 'reason.bacon.case',
      params: { flips: Math.round(flips * 100) },
    });
    c.add(0.3, s.letters % 5 === 0 ? 1 : 0.35, {
      key: s.letters % 5 === 0 ? 'reason.bacon.multiple' : 'reason.bacon.leftover',
      params: { count: s.letters, rest: s.letters % 5 },
    });
    c.add(0.15, ramp(Math.min(s.upper, s.lower) / s.letters, 0.25, 0.4));
    c.to('bacon', { mode: 'case' });
  } else c.need(0);
  return c;
}

/** Letters with no structure at all: rotor machine, one-time pad, a long Vigenère key... */
function flat(s: Stats, g: Sig): Case {
  const c = new Case('flat');
  const a2 = alignment2(s);
  c.need(g.pure ? 1 : ramp(s.letterShare, 0.85, 0.97) * 0.5);
  c.need(ramp(s.ioc, 0.03, 0.035) * ramp(s.ioc, 0.047, 0.042));
  c.need(1 - a2.strength);
  c.need(ramp(g.n, 30, 120));
  // The catch-all for letters with no structure: it never claims more than a guess.
  c.need(0.7);
  const closeness = ramp(Math.abs(s.ioc - IOC_REFERENCE.random), 0.006, 0.002);
  c.add(0.4, closeness, { key: 'reason.flat.ioc', params: { ioc: fixed(s.ioc) } });
  c.add(0.2, ramp(s.distinctLetters, 24, 26), { key: 'reason.flat.alphabet' });
  c.add(0.15, 1 - ramp(s.peak ? s.peak.harmonic - (s.period[0]?.ioc ?? s.ioc) : 0, 0.008, 0.018), {
    key: 'reason.flat.noPeriod',
  });
  c.add(0.1, 1 - g.fitsAsIs, { key: 'reason.vigenere.lettersMixed' });
  c.add(0.15, s.groups.size === 4 || s.groups.size === 5 ? 1 : 0, {
    key: 'reason.flat.groups',
    params: { size: s.groups.size ?? 0 },
  });
  c.to('enigma', {});
  return c;
}

/** ROT47 gets its own reason inside the Caesar family when letters are too few for the letters test. */
function rot47Case(s: Stats): Case | null {
  if (!s.rot47 || s.rot47.read < 30) return null;
  const c = new Case('caesar');
  c.params = { shift: s.rot47.shift, rot47: 1 };
  c.add(1, ramp(s.rot47.read, 30, 55), {
    key: 'reason.caesar.rot47',
    params: { shift: s.rot47.shift, score: Math.round(s.rot47.read) },
  });
  c.to('caesar', { mode: 'shift', alphabet: 'rot47', shift: s.rot47.shift });
  return c;
}

/** The cipher families, best first. Families that cannot apply are left out. */
export function rankFamilies(s: Stats): Family[] {
  const g = signals(s);
  const cases: Case[] = [];
  const rot47 = rot47Case(s);
  if (rot47) cases.push(rot47);
  if (s.letters >= 4) {
    cases.push(
      plain(s, g),
      transposition(s, g),
      simple(s, g, 'caesar'),
      simple(s, g, 'atbash'),
      simple(s, g, 'affine'),
      substitution(s, g),
      vigenere(s, g),
      playfair(s, g),
      hill(s, g),
      bifid(s, g),
      adfgx(s, g),
      flat(s, g),
    );
  }
  cases.push(polybius(s, g), bacon(s, g));
  return cases
    .map((c) => c.done())
    .filter((f) => f.score >= 5)
    .sort((a, b) => b.score - a.score);
}

export type { Lang };
