/**
 * Text detector for the analysis socle: when the bytes are text, try to recover a flag through the
 * encoding layers (auto-decode's beam search), through a small-vocabulary word cipher (the
 * symbol-words core), and say which classical cipher the statistics point to (cipher-identify).
 *
 * Confidence rule: 'confirmed' only for a recovered flag (a prefix{...} that appears after at least
 * one decoding step), never for a statistic and never because the text is clean. A word cipher whose
 * best reading is only readable is a 'candidate'; a cipher family is 'probable' for a strong score
 * and a 'candidate' otherwise. Plain prose yields nothing. Pure and deterministic: bytes in,
 * findings out.
 */
import { buildFlagRegex, findFlags, gluedPrefixLength } from './flags';
import { analyse as cipherStats } from '../tools/crypto/_cipher-identify-stats';
import { rankFamilies, type Family } from '../tools/crypto/_cipher-identify-rank';
import {
  baseInfo,
  blendScore,
  decodeBytes,
  latin1,
  orderingMap,
  printScore,
  solve,
  tokenize,
  type Reading,
} from '../tools/crypto/_symbol-words';
import { analyse as textInfo } from '../tools/encoding/_decoders';
import { autoDecode, recipeName, type Candidate } from '../tools/encoding/auto-decode';
import { decodeHolloway, hollowayReadable } from '../tools/stego/_holloway';
import { decodeAll } from '../tools/stego/_zerowidth';
import { decodeWhitespace } from '../tools/stego/whitespace';
import { utf8Encode } from '../lib/bytes';
import type { Finding } from './analyze';

/** The project's own flag prefix, handed to the beam search so that it scores FTF{...} as a flag. */
const OWN_PREFIX = 'FTF';
/** Symbol-words only looks at texts this long (the tool itself cuts at the same size). */
const MAX_WORDS_TEXT = 20_000;
/** A word cipher needs each symbol to repeat: at least this many tokens per distinct token. */
const MIN_REPEAT = 4;
/** Fewest tokens worth reading as a bit-stream. */
const MIN_TOKENS = 16;
/** Cipher families below this score are noise; from STRONG up the statistics are decisive enough. */
const FAMILY_MIN = 60;
const FAMILY_STRONG = 85;
/** Families that say nothing about a hidden message. */
const IGNORED_FAMILIES = new Set<Family['id']>(['plain', 'flat']);

const flagRe = buildFlagRegex();

/** The first flag-shaped token of a text, or null. */
function flagIn(text: string): string | null {
  const hit = findFlags(text, flagRe, 5)[0];
  if (!hit) return null;
  return hit.value.slice(gluedPrefixLength(hit.value));
}

/** A flag recovered by the encoding chain: the flag, and the steps that led to it. */
function chainFlag(bytes: Uint8Array): { flag: string; recipe: string } | null {
  const result = autoDecode(bytes, { flagPrefix: OWN_PREFIX });
  for (const c of result.ranked as Candidate[]) {
    // The input as it is does not count: nothing was decoded.
    if (c.recipe.length === 0 || !c.textLike || c.text === null) continue;
    const flag = flagIn(c.text);
    if (flag) return { flag, recipe: recipeName(c) };
  }
  return null;
}

interface Reading2 {
  label: string;
  bytes: Uint8Array;
}

/** The symbol-words readings of a text made of a few repeated words, or [] when it is not one. */
function wordReadings(text: string): Reading2[] {
  const vocab = tokenize(text.length > MAX_WORDS_TEXT ? text.slice(0, MAX_WORDS_TEXT) : text, {
    keepPunctuation: true,
  });
  const n = vocab.distinct.length;
  const info = baseInfo(n);
  if (info.bits === null || n < 2) return [];
  if (vocab.tokens.length < MIN_TOKENS || vocab.tokens.length < n * MIN_REPEAT) return [];
  const bits = info.bits;
  const idOf = new Map(vocab.distinct.map((t, i) => [t, i]));
  const tokenIds = vocab.tokens.map((t) => idOf.get(t)!);

  const readings: Reading2[] = [];
  const orders: Reading[] = ['cipher', 'alpha', 'frequency'];
  for (const name of orders) {
    const value = orderingMap(vocab, name);
    readings.push({ label: name, bytes: decodeBytes(tokenIds, value, bits) });
  }
  const best = readings.reduce((a, b) => (blendScore(b.bytes) > blendScore(a.bytes) ? b : a));
  // The search runs when no quick ordering reads (the tool's own rule), with the tool's seed.
  if (printScore(best.bytes) <= 0.7) {
    const r = solve({
      bits,
      tokenIds,
      nDistinct: n,
      seed: 0x5eed,
      restarts: n <= 20 ? 40 : 24,
    });
    readings.push({ label: 'search', bytes: r.bytes });
  }
  return readings;
}

function wordFindings(text: string): Finding[] {
  const readings = wordReadings(text);
  for (const r of readings) {
    const flag = flagIn(latin1(r.bytes));
    if (flag) {
      return [
        {
          kind: 'decoded',
          confidence: 'confirmed',
          title: flag,
          detail: `symbol-words (${r.label})`,
          flag,
        },
      ];
    }
  }
  // No flag: a readable stream is only a hint (a random mapping often reads by chance on short text).
  const readable = readings.find((r) => r.bytes.length >= 16 && printScore(r.bytes) > 0.95);
  return readable
    ? [
        {
          kind: 'symbol-words',
          confidence: 'candidate',
          title: 'symbol-words',
          detail: `${readable.label}: ${latin1(readable.bytes)
            .slice(0, 40)
            .replace(/[^\x20-\x7e]/g, '.')}`,
        },
      ]
    : [];
}

/** A short description of a Holloway carrier count, for the finding detail. */
function hollowayDetail(d: { homoglyphs: number; specialSpaces: number }): string {
  return `holloway homoglyph stego (${d.homoglyphs} homoglyphs, ${d.specialSpaces} special spaces)`;
}

/**
 * The Holloway homoglyph scheme: lookalike letters and special spaces carry bits read six at a time.
 * A recovered flag — directly, or by decoding the recovered message one layer further (its charset
 * is lowercase, so a hidden flag is typically carried as hex or another base) — is confirmed; a
 * recovered readable sentence is probable.
 */
function hollowayFindings(text: string): Finding[] {
  const d = decodeHolloway(text);
  if (!d) return [];
  const message = d.message.replace(/\s+$/, '');
  if (message.length < 2) return [];
  const detail = hollowayDetail(d);

  const direct = flagIn(message);
  if (direct)
    return [{ kind: 'decoded', confidence: 'confirmed', title: direct, detail, flag: direct }];

  const chain = chainFlag(utf8Encode(message));
  if (chain)
    return [
      {
        kind: 'decoded',
        confidence: 'confirmed',
        title: chain.flag,
        detail: `${detail} → ${chain.recipe}`,
        flag: chain.flag,
      },
    ];

  // A readable sentence, or a clean decode (no replacement chars) over enough deliberate carriers,
  // is a hidden message worth surfacing — even when it is a token like `ftf_homoglyph_1` rather
  // than prose. Coincidental homoglyphs (a stray Greek letter) give too few carriers to pass.
  const clean = !message.includes('�');
  if (hollowayReadable(message) || (clean && message.length >= 3 && d.homoglyphs >= 6))
    return [
      {
        kind: 'stego-unicode',
        confidence: 'probable',
        title: message.slice(0, 60),
        detail,
      },
    ];
  return [];
}

/** Directional override / embedding / isolate controls — the Trojan-Source reordering set. */
const BIDI_TEST = /[‪-‮⁦-⁩]/;
const BIDI_ALL = /[‪-‮⁦-⁩]/g;

/**
 * Bidi / Trojan Source: explicit directional controls (RLO, LRO, isolates...) reverse how a run is
 * *displayed* while the bytes stay in logical order, so a secret reads one way on screen and another
 * in the file. These controls never occur in ordinary left-to-right text, so their mere presence is
 * the anomaly; we surface the control-stripped logical reading (a recovered flag confirmed, the
 * cleaned text otherwise probable) so the pipeline reveals what the eye was tricked out of.
 */
function bidiFindings(text: string): Finding[] {
  if (!BIDI_TEST.test(text)) return [];
  const logical = text.replace(BIDI_ALL, '');
  const flag = flagIn(logical);
  if (flag)
    return [
      {
        kind: 'decoded',
        confidence: 'confirmed',
        title: flag,
        detail: 'bidi (Trojan Source)',
        flag,
      },
    ];
  const reading = logical.replace(/\s+/g, ' ').trim();
  if (reading.length < 2) return [];
  return [
    {
      kind: 'stego-bidi',
      confidence: 'probable',
      title: 'bidi override (Trojan Source)',
      detail: `directional controls stripped → ${reading.slice(0, 300)}`,
    },
  ];
}

function cipherFinding(text: string): Finding[] {
  const family = rankFamilies(cipherStats(text)).find(
    (f) => !IGNORED_FAMILIES.has(f.id) && f.score >= FAMILY_MIN,
  );
  if (!family) return [];
  return [
    {
      kind: 'cipher-hint',
      confidence: family.score >= FAMILY_STRONG ? 'probable' : 'candidate',
      title: family.id,
      detail: `score ${Math.round(family.score)}/100`,
    },
  ];
}

/** `name` is accepted for symmetry with the other detectors; the text itself is what is read. */
export async function detectText(bytes: Uint8Array, name?: string): Promise<Finding[]> {
  void name;
  const info = textInfo(bytes);
  if (!info.textLike || info.text === null) return [];
  const text = info.text;

  const chain = chainFlag(bytes);
  if (chain) {
    return [
      {
        kind: 'decoded',
        confidence: 'confirmed',
        title: chain.flag,
        detail: chain.recipe,
        flag: chain.flag,
      },
    ];
  }

  const bidi = bidiFindings(text);
  if (bidi.some((f) => f.confidence === 'confirmed')) return bidi;
  const holloway = hollowayFindings(text);
  if (holloway.some((f) => f.confidence === 'confirmed')) return [...holloway, ...bidi];
  const hidden = hiddenChannelFindings(text);
  if (hidden.some((f) => f.confidence === 'confirmed')) return [...hidden, ...holloway, ...bidi];

  const findings = wordFindings(text);
  if (findings.some((f) => f.confidence === 'confirmed'))
    return [...findings, ...holloway, ...hidden, ...bidi];
  if (findings.length === 0) findings.push(...cipherFinding(text));
  findings.push(...holloway, ...hidden, ...bidi);
  return findings;
}

/**
 * Invisible and whitespace channels: zero-width / Unicode-tag / variation-selector schemes (the
 * zero-width tool's decodeAll) and SNOW-style trailing whitespace (decodeWhitespace). Each decoder
 * already scores its reading; we surface a strong, textual reading as a hidden message — a flag
 * confirmed, otherwise probable — so the auto pipeline finds what the manual tools would.
 */
function hiddenChannelFindings(text: string): Finding[] {
  const readings = [...decodeAll(text), ...decodeWhitespace(text)]
    .filter((c) => c.score >= 35 && c.text.length > 0)
    .sort((a, b) => b.score - a.score);
  const out: Finding[] = [];
  const seen = new Set<string>();
  for (const c of readings) {
    const msg = c.text.replace(/\s+$/, '');
    const cps = [...msg];
    if (cps.length < 2 || seen.has(msg)) continue;
    seen.add(msg);
    const flag = flagIn(c.text) ?? chainFlag(c.bytes)?.flag;
    if (flag) {
      out.push({ kind: 'decoded', confidence: 'confirmed', title: flag, detail: c.scheme, flag });
    } else {
      // Unicode-aware readability: mostly printable code points (accents included), no replacement.
      const ok = cps.filter((ch) => ch >= ' ' && ch !== '�').length >= cps.length * 0.9;
      if (ok)
        out.push({
          kind: 'stego-unicode',
          confidence: 'probable',
          title: msg.slice(0, 48),
          detail: `${c.scheme}: ${msg.slice(0, 300)}`,
        });
    }
    if (out.length >= 4) break;
  }
  return out;
}
