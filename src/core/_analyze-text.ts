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

  const findings = wordFindings(text);
  if (findings.some((f) => f.confidence === 'confirmed')) return findings;
  if (findings.length === 0) findings.push(...cipherFinding(text));
  return findings;
}
