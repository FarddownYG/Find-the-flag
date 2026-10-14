/**
 * Text analyzer passes for classical ciphers, on the whole text and on the outputs of the
 * extraction passes (an acrostic that was ROT13'd, a zero-width payload in Caesar…). Every
 * cipher is the one of the matching crypto tool; this module brute-forces the keys and lets
 * the French + English readability score pick the best one.
 */
import { toolT } from '../../i18n/tool-text';
import { indexOfCoincidence } from '../../lib/english';
import { affineDecrypt, VALID_A } from '../crypto/affine';
import { atbash } from '../crypto/atbash';
import { rotate } from '../crypto/caesar';
import {
  chiSquaredCounts,
  keyToString,
  letterCounts,
  letterIndex,
  lettersOnly,
  minimalPeriod,
  mod,
} from '../crypto/_classical';
import { railFenceDecrypt } from '../crypto/rail-fence';
import { autoSolve } from '../crypto/substitution';
import { crackVigenere, vigenereTransform } from '../crypto/vigenere';
import { letterFrequencies, type Lang } from '../../lib/readability';
import {
  cutNote,
  foldKey,
  joinNotes,
  pickBest,
  type Pass,
  type Scorer,
} from './_text-analyzer-core';

const T = toolT('text-analyzer');

/** Ciphers run on this many characters of the text (scores need no more). */
const CIPHER_SAMPLE = 4000;
/** Keys are chosen on this many characters, then applied to the whole sample. */
const PROBE = 800;
/** Extraction outputs fed to the ciphers, at most, per family of source. */
const MAX_SOURCES: Record<string, number> = { acrostic: 5, invisible: 3, encoding: 3 };
const SOURCE_CHARS = 2000;
/** A cipher on an extraction must beat the extraction's own readability by this much. */
const GAIN = 15;
/** Shorter extractions are not deciphered: a few letters read as a word under some key. */
const MIN_SOURCE_LETTERS = 6;

interface Option {
  text: string;
  note: string;
}

const cipher = (label: string, result: string | null, note: string, prior?: number): Pass => ({
  family: 'cipher',
  mode: 'transform',
  label,
  result,
  note,
  prior,
});

const shiftNote = (n: number) =>
  n === 13 ? T('note.shiftRot13') : T('note.shift', { n, key: 26 - n });

/**
 * Caesar shifts worth scoring: all 25 for short texts, else the few whose letter counts look
 * most like a language (the right shift is always among them once there are 30+ letters).
 */
function caesarShifts(text: string, keep = 5): number[] {
  const counts = letterCounts(text);
  const total = counts.reduce((a, b) => a + b, 0);
  const all = Array.from({ length: 25 }, (_, i) => i + 1);
  if (total < 30) return all;
  return all
    .map((n) => ({ n, chi: chiSquaredCounts(counts.map((_, i) => counts[mod(i - n, 26)]!)) }))
    .sort((a, b) => a.chi - b.chi)
    .slice(0, keep)
    .map((x) => x.n);
}

function caesarOptions(text: string): Option[] {
  return caesarShifts(text).map((n) => ({ text: rotate(text, n, 'letters'), note: shiftNote(n) }));
}

/** The few affine keys whose letter counts look most like a language (a = 1 is Caesar). */
function affineKeys(text: string, keep = 4): { a: number; b: number }[] {
  const counts = letterCounts(text);
  const keys: { a: number; b: number; chi: number }[] = [];
  const inverse = (a: number) => VALID_A.find((x) => mod(a * x, 26) === 1)!;
  for (const a of VALID_A) {
    if (a === 1) continue;
    const inv = inverse(a);
    for (let b = 0; b < 26; b++) {
      const plain = new Array<number>(26).fill(0);
      counts.forEach((n, c) => {
        plain[mod(inv * (c - b), 26)]! += n;
      });
      keys.push({ a, b, chi: chiSquaredCounts(plain) });
    }
  }
  keys.sort((x, y) => x.chi - y.chi);
  return keys.slice(0, keep);
}

function affineOptions(text: string, keep: number): Option[] {
  return affineKeys(text, keep).map(({ a, b }) => ({
    text: affineDecrypt(text, a, b),
    note: `a = ${a}, b = ${b}`,
  }));
}

function railOptions(text: string, maxRails: number): (Option & { rails: number })[] {
  const n = Array.from(text).length;
  const out: (Option & { rails: number })[] = [];
  for (let rails = 2; rails <= Math.min(maxRails, n - 1); rails++) {
    out.push({
      text: railFenceDecrypt(text, rails),
      note: T('note.rails', { count: rails }),
      rails,
    });
  }
  return out;
}

/** Chi-squared distance of letter counts from a language's letter frequencies. */
function chiSquaredTo(counts: number[], freq: number[]): number {
  const total = counts.reduce((a, b) => a + b, 0);
  let chi = 0;
  for (let i = 0; i < 26; i++) {
    const expected = (Math.max(0.05, freq[i]!) * total) / 100;
    chi += (counts[i]! - expected) ** 2 / expected;
  }
  return chi;
}

/**
 * The key of each length 1..`maxLen` whose columns, once shifted back, have the letter
 * frequencies of `lang`: the Vigenère tool cracks by English frequencies, which a French
 * plaintext defeats (CORBEAU comes out as CORBEAG).
 */
function keysFor(text: string, variant: 'vigenere' | 'beaufort', lang: Lang, maxLen: number) {
  const freq = letterFrequencies(lang);
  const values: number[] = [];
  for (const ch of text) {
    const v = letterIndex(ch);
    if (v >= 0) values.push(v);
  }
  const keys: number[][] = [];
  const limit = Math.max(1, Math.min(maxLen, Math.floor(values.length / 3)));
  for (let len = 1; len <= limit; len++) {
    const key: number[] = [];
    for (let col = 0; col < len; col++) {
      let best = 0;
      let bestChi = Infinity;
      for (let k = 0; k < 26; k++) {
        const counts = new Array<number>(26).fill(0);
        for (let i = col; i < values.length; i += len) {
          const c = values[i]!;
          counts[variant === 'beaufort' ? mod(k - c, 26) : mod(c - k, 26)]!++;
        }
        const chi = chiSquaredTo(counts, freq);
        if (chi < bestChi) {
          bestChi = chi;
          best = k;
        }
      }
      key.push(best);
    }
    keys.push(key.slice(0, minimalPeriod(key)));
  }
  return keys;
}

/**
 * Candidate decryptions: the Vigenère tool's English-frequency keys and French-frequency
 * keys. A key of nearly all A leaves most of the text as it is: not a decryption.
 */
function vigenereOptions(
  text: string,
  variant: 'vigenere' | 'beaufort',
): (Option & { key: number[] })[] {
  const { candidates } = crackVigenere(text, variant, 12);
  const english = candidates
    .slice(0, 3)
    .map((c) => ({ key: [...c.key].map((ch) => ch.charCodeAt(0) - 65), text: c.text }));
  const french = keysFor(text, variant, 'fr', 12)
    .map((key) => ({ key, text: vigenereTransform(text, key, variant, true) }))
    .map((o) => ({ ...o, chi: chiSquaredTo(letterCounts(o.text), letterFrequencies('fr')) }))
    .sort((a, b) => a.chi - b.chi || a.key.length - b.key.length)
    .slice(0, 3);
  const out: (Option & { key: number[] })[] = [];
  const seen = new Set<string>();
  // English and French keys in turn, so that taking the first two tries one of each.
  for (let i = 0; i < 3; i++) {
    for (const o of [english[i], french[i]]) {
      if (!o) continue;
      const name = keyToString(o.key);
      const plainA = o.key.filter((k) => k === 0).length;
      const nearlyNone =
        variant === 'vigenere' && plainA >= o.key.length - 2 && plainA * 2 >= o.key.length;
      if (seen.has(name) || nearlyNone) continue;
      seen.add(name);
      out.push({
        key: o.key,
        text: o.text,
        note: T('note.key', { key: name, length: o.key.length }),
      });
    }
  }
  return out;
}

/** Whole-text ciphers. `inputScore` is the readability of the text as it is. */
export function cipherPasses(text: string, inputScore: number, scorer: Scorer): Pass[] {
  const chars = Array.from(text);
  const sample = chars.length > CIPHER_SAMPLE ? chars.slice(0, CIPHER_SAMPLE).join('') : text;
  const cut = chars.length > CIPHER_SAMPLE ? cutNote(CIPHER_SAMPLE) : '';
  const letters = lettersOnly(sample).length;
  const out: Pass[] = [];
  const caesarLabel = T('pass.caesar');
  const rot47Label = T('pass.rot47');
  const rot47Note = T('note.rot47') + cut;
  const affineLabel = T('pass.affine');
  const railLabel = T('pass.railFence');
  if (!letters) {
    const none = T('note.noLetters');
    return [
      caesarLabel,
      T('pass.rot13'),
      rot47Label,
      T('pass.atbash'),
      affineLabel,
      T('pass.vigenere'),
      T('pass.beaufort'),
      T('pass.substitution'),
      railLabel,
    ].map((label) =>
      label === rot47Label
        ? cipher(label, rotate(sample, 47, 'rot47'), rot47Note)
        : cipher(label, null, none),
    );
  }
  const probe = chars.length > PROBE ? chars.slice(0, PROBE).join('') : sample;
  const probeKey = foldKey(probe);
  const caesar = pickBest(
    caesarShifts(probe).map((n) => ({ text: rotate(probe, n, 'letters'), note: String(n) })),
    scorer,
    probeKey,
  );
  const shift = caesar ? Number(caesar.best.note) : 0;
  out.push(
    shift
      ? {
          ...cipher(caesarLabel, rotate(sample, shift, 'letters'), shiftNote(shift) + cut),
          margin: caesar!.margin,
        }
      : cipher(caesarLabel, null, T('note.noShift')),
    cipher(T('pass.rot13'), rotate(sample, 13, 'letters'), T('note.rot13') + cut),
    cipher(rot47Label, rotate(sample, 47, 'rot47'), rot47Note),
    cipher(T('pass.atbash'), atbash(sample), `A↔Z, B↔Y…${cut}`),
  );
  const affine = pickBest(
    affineKeys(probe).map((k) => ({ text: affineDecrypt(probe, k.a, k.b), note: `${k.a},${k.b}` })),
    scorer,
    probeKey,
  );
  if (affine) {
    const [a, b] = affine.best.note.split(',').map(Number) as [number, number];
    out.push({
      ...cipher(affineLabel, affineDecrypt(sample, a, b), `a = ${a}, b = ${b}${cut}`),
      margin: affine.margin,
    });
  } else out.push(cipher(affineLabel, null, T('note.noKey')));

  for (const [variant, label] of [
    ['vigenere', T('pass.vigenere')],
    ['beaufort', T('pass.beaufort')],
  ] as const) {
    if (letters < 30) {
      out.push(cipher(label, null, T('note.needsLetters', { n: 30 })));
      continue;
    }
    if (inputScore >= 50) {
      out.push(cipher(label, null, T('note.alreadyReadable')));
      continue;
    }
    // Keys are found and compared on the probe, the best one is applied to the whole sample.
    const best = pickBest(vigenereOptions(probe, variant), scorer, probeKey);
    out.push(
      best
        ? cipher(
            label,
            vigenereTransform(sample, best.best.key, variant, true),
            joinNotes(best.best.note, T('note.keyByFrequency')) + cut,
          )
        : cipher(label, null, T('note.keysUnchanged')),
    );
  }

  const subLabel = T('pass.substitution');
  const ioc = indexOfCoincidence(sample);
  if (letters < 60) out.push(cipher(subLabel, null, T('note.needsLetters', { n: 60 })));
  else if (inputScore >= 40) {
    out.push(cipher(subLabel, null, T('note.alreadyReadable')));
  } else if (ioc < 0.055) {
    out.push(cipher(subLabel, null, T('note.iocFlat', { ioc: ioc.toFixed(3) })));
  } else {
    const solved = autoSolve(sample);
    out.push(cipher(subLabel, solved.text, T('note.hillClimb', { ioc: ioc.toFixed(3) }) + cut));
  }

  const rail = pickBest(railOptions(probe, 10), scorer, probeKey);
  const rails = rail ? rail.best.rails : 0;
  out.push(
    rails
      ? {
          ...cipher(railLabel, railFenceDecrypt(sample, rails), rail!.best.note + cut),
          margin: rail!.margin,
        }
      : cipher(railLabel, null, T('note.textTooShort')),
  );
  return out;
}

/**
 * The extraction outputs worth deciphering, a few per family so that a text full of encoded
 * tokens still has its acrostics tried (an acrostic may itself be ROT13'd).
 */
export function chainSources(passes: Pass[]): Pass[] {
  const used: Record<string, number> = {};
  return passes.filter((p) => {
    if (p.result === null) return false;
    const max = MAX_SOURCES[p.family] ?? 0;
    const n = used[p.family] ?? 0;
    if (n >= max) return false;
    used[p.family] = n + 1;
    return true;
  });
}

/** Classical ciphers on extraction outputs: one row per source, the best transform wins. */
export function chainedPasses(sources: Pass[], scorer: Scorer): Pass[] {
  const out: Pass[] = [];
  for (const src of sources) {
    const text = Array.from(src.result ?? '')
      .slice(0, SOURCE_CHARS)
      .join('');
    const letters = lettersOnly(text).length;
    // Letters only: digits and symbols in a short pick are layout (list numbers), not cipher.
    if (letters < MIN_SOURCE_LETTERS || letters < 0.9 * text.replace(/\s/g, '').length) continue;
    const options: Option[] = [
      ...caesarOptions(text).map((o) => ({ ...o, note: T('note.viaCaesar', { note: o.note }) })),
      { text: atbash(text), note: T('note.viaAtbash') },
      ...affineOptions(text, 3).map((o) => ({ ...o, note: T('note.viaAffine', { note: o.note }) })),
      { text: Array.from(text).reverse().join(''), note: T('note.backwards') },
      ...railOptions(text, 6).map((o) => ({ ...o, note: T('note.viaRail', { note: o.note }) })),
    ];
    if (letters >= 30) {
      options.push(
        ...vigenereOptions(text, 'vigenere')
          .slice(0, 2)
          .map((o) => ({ ...o, note: T('note.viaVigenere', { note: o.note }) })),
      );
    }
    const picked = pickBest(options, scorer, foldKey(text));
    if (!picked) continue;
    const { best } = picked;
    const label = T('pass.chained', { source: src.label });
    const before = scorer.reading(text).r.score;
    // Shuffling letters that already read well finds other words by chance: only a clear
    // improvement over the source counts.
    if (picked.score < before + GAIN) {
      out.push({
        ...cipher(label, null, T('note.noCipherBetter', { best: best.note })),
        mode: src.mode,
      });
      continue;
    }
    // Compared with the input like its source: a decoded payload shares no words with it. The
    // best of some forty keys on a short string: it must stand out of the other keys.
    out.push({
      ...cipher(label, best.text, best.note, 0.8),
      mode: src.mode,
      pick: src.pick,
      margin: picked.margin,
      tries: options.length * (src.tries ?? 1),
    });
  }
  return out;
}
