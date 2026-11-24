/**
 * Core for the symbol-word decoder: a text made of a small repeated vocabulary where each distinct
 * token stands for one base-N digit. Tokenise it, read the digits as a bit-stream into bytes, and —
 * when no obvious reading works — recover the token→digit mapping with a constrained, seeded
 * simulated-annealing search scored by how much the result reads like text and code.
 *
 * Pure logic, no i18n and no Output. The tool file turns these results into the UI.
 */
import { makeRng } from './_classical';
import { quadSum, toCodes } from './_fitness';
import { BIGRAM_ALPHA, BIGRAM_SCALE, BIGRAM_SYMS, BIGRAM_B64 } from './_symbol-bigram';

// ---------------------------------------------------------------- tokenising

export interface TokenizeOptions {
  /** Split on runs of whitespace (default) or on a custom regex of separators. */
  separator?: RegExp;
  /** Keep attached punctuation as part of the token (default true: "code," ≠ "code"). */
  keepPunctuation?: boolean;
  /** Lower-case every token before counting (default false). */
  foldCase?: boolean;
}

export interface Vocab {
  tokens: string[];
  /** Distinct tokens in first-appearance order. */
  distinct: string[];
  /** token → count. */
  freq: Map<string, number>;
}

export function tokenize(text: string, opts: TokenizeOptions = {}): Vocab {
  let raw = text.trim();
  if (opts.foldCase) raw = raw.toLowerCase();
  const sep = opts.separator ?? /\s+/;
  let tokens = raw.length ? raw.split(sep).filter((t) => t.length) : [];
  if (opts.keepPunctuation === false) {
    tokens = tokens.map((t) => t.replace(/[^\p{L}\p{N}]+/gu, '')).filter((t) => t.length);
  }
  const freq = new Map<string, number>();
  const distinct: string[] = [];
  for (const t of tokens) {
    const n = freq.get(t);
    if (n === undefined) distinct.push(t);
    freq.set(t, (n ?? 0) + 1);
  }
  return { tokens, distinct, freq };
}

// ---------------------------------------------------------------- base / bits

export interface BaseInfo {
  /** Number of distinct tokens. */
  n: number;
  /** Bits per digit when N is a power of two, else null. */
  bits: number | null;
  /** 'binary' | 'hex' | 'base64' | 'other' — how to label the reading. */
  kind: 'binary' | 'quaternary' | 'octal' | 'hex' | 'base32' | 'base64' | 'other';
}

const KIND_BY_BITS: Record<number, BaseInfo['kind']> = {
  1: 'binary',
  2: 'quaternary',
  3: 'octal',
  4: 'hex',
  5: 'base32',
  6: 'base64',
};

export function baseInfo(n: number): BaseInfo {
  const bits = n >= 2 && (n & (n - 1)) === 0 ? Math.log2(n) : null;
  return { n, bits, kind: bits && KIND_BY_BITS[bits] ? KIND_BY_BITS[bits] : 'other' };
}

/**
 * Decode a digit sequence (0..N-1 per token) as a big-endian bit-stream into bytes. Needs a
 * power-of-two base; the trailing partial byte is dropped. This is the same bit-packing base2 / hex
 * / base64 use.
 */
export function bitPack(digits: number[], bits: number): Uint8Array {
  const out = new Uint8Array(Math.floor((digits.length * bits) / 8));
  let acc = 0;
  let have = 0;
  let o = 0;
  for (const d of digits) {
    acc = (acc << bits) | (d & ((1 << bits) - 1));
    have += bits;
    while (have >= 8) {
      have -= 8;
      out[o++] = (acc >> have) & 0xff;
    }
  }
  return out;
}

/** Map tokens through `value` (token id → digit) and bit-pack to bytes. */
export function decodeBytes(tokenIds: number[], value: number[], bits: number): Uint8Array {
  const digits = tokenIds.map((id) => value[id]!);
  return bitPack(digits, bits);
}

export const latin1 = (b: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
  return s;
};

// ---------------------------------------------------------------- scoring

const ALPHA_IDX = (() => {
  const idx = new Int16Array(256).fill(BIGRAM_SYMS);
  BIGRAM_ALPHA.forEach((c, i) => (idx[c] = i));
  return idx;
})();
const BIGRAM = (() => {
  const bin = atob(BIGRAM_B64);
  const a = new Int8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return a;
})();
const BIGRAM_S = BIGRAM_SYMS + 1;

/** Average character-bigram log-probability of the bytes (higher = more text/code-like). */
export function bigramScore(bytes: Uint8Array): number {
  if (bytes.length < 2) return -20;
  let prev = BIGRAM_SYMS;
  let sum = 0;
  for (let i = 0; i < bytes.length; i++) {
    const cur = ALPHA_IDX[bytes[i]!]!;
    sum += BIGRAM[prev * BIGRAM_S + cur]!;
    prev = cur;
  }
  return sum / BIGRAM_SCALE / bytes.length;
}

/** Fraction readable, minus a penalty for control/non-ASCII bytes (−1 at all-garbage, 1 at clean). */
export function printScore(bytes: Uint8Array): number {
  if (!bytes.length) return -1;
  let ok = 0;
  let bad = 0;
  for (let i = 0; i < bytes.length; i++) {
    const x = bytes[i]!;
    if (x === 9 || x === 10 || x === 13 || (x >= 32 && x < 127)) ok++;
    else bad++;
  }
  return (ok - 3 * bad) / bytes.length;
}

/** English letter-quadgram fitness of the text's letters (≈ −4.3 English, ≈ −7.5 noise). */
export function englishScore(text: string): number {
  const codes = toCodes(text);
  if (codes.length < 4) return -8;
  return quadSum(codes) / 100 / (codes.length - 3);
}

/**
 * Blended objective: readable (printability), code-and-text-shaped (char bigram) and English-prose-
 * shaped (letter quadgrams). Tuned so the correct, fully-ASCII decoding wins.
 */
export function blendScore(bytes: Uint8Array): number {
  return 6 * printScore(bytes) + 1.5 * bigramScore(bytes) + 0.05 * englishScore(latin1(bytes));
}

// ---------------------------------------------------------------- mapping readings

export type Reading = 'cipher' | 'key' | 'alpha' | 'frequency';

/** A direct token→digit mapping from a simple ordering of the distinct tokens. */
export function orderingMap(vocab: Vocab, reading: Reading, keyOrder?: string[]): number[] {
  const n = vocab.distinct.length;
  let order: string[];
  if (reading === 'cipher') order = vocab.distinct;
  else if (reading === 'alpha') order = [...vocab.distinct].sort();
  else if (reading === 'frequency')
    order = [...vocab.distinct].sort(
      (a, b) => vocab.freq.get(b)! - vocab.freq.get(a)! || (a < b ? -1 : 1),
    );
  else order = keyOrder ?? vocab.distinct; // 'key': first-appearance order in a provided key text
  const value = new Array<number>(n).fill(0);
  const idOf = new Map(vocab.distinct.map((t, i) => [t, i]));
  order.forEach((t, i) => {
    const id = idOf.get(t);
    if (id !== undefined) value[id] = i % n;
  });
  return value;
}

// ---------------------------------------------------------------- solver

export interface SolveResult {
  value: number[];
  score: number;
  bytes: Uint8Array;
}

export interface SolveOptions {
  bits: number;
  tokenIds: number[];
  nDistinct: number;
  /** token id → fixed digit the user locked (others are searched). */
  locked?: Map<number, number>;
  seed?: number;
  /** Simulated-annealing restarts. */
  restarts?: number;
  score?: (bytes: Uint8Array) => number;
}

/**
 * For ASCII text every byte's most-significant bit is 0. Each token position contributes `bits` bits
 * to the byte stream; whichever of those land on a byte's MSB must be 0. This returns, per token id,
 * the OR of value-bits that must be 0 (a forbidden-bit mask) across every position it appears at.
 *
 * For hex this reduces to "a high-nibble token is < 8"; for base64 it constrains different bits at
 * positions 0/1/2 (mod 4) — the same ASCII positional sieve, derived for any base.
 */
export function forbiddenMasks(tokenIds: number[], bits: number, nDistinct: number): number[] {
  const mask = new Array<number>(nDistinct).fill(0);
  for (let i = 0; i < tokenIds.length; i++) {
    let m = 0;
    for (let l = 0; l < bits; l++) {
      // Global bit (i*bits + l); l = 0 is this symbol's most-significant bit. A byte MSB sits at
      // every global offset that is a multiple of 8.
      if ((i * bits + l) % 8 === 0) m |= 1 << (bits - 1 - l);
    }
    mask[tokenIds[i]!]! |= m;
  }
  return mask;
}

export function solve(opts: SolveOptions): SolveResult {
  const { bits, tokenIds, nDistinct } = opts;
  const n = 1 << bits;
  const score = opts.score ?? blendScore;
  const locked = opts.locked ?? new Map<number, number>();
  const rng = makeRng(opts.seed ?? 0x5eed);
  const restarts = opts.restarts ?? 40;

  const mask = forbiddenMasks(tokenIds, bits, nDistinct);
  const free = [...Array(nDistinct).keys()].filter((id) => !locked.has(id));
  const usedValues = new Set(locked.values());
  const pool: number[] = [];
  for (let v = 0; v < n; v++) if (!usedValues.has(v)) pool.push(v);

  const fits = (id: number, v: number): boolean => (v & mask[id]!) === 0;
  const canSwap = (a: number, b: number, val: number[]): boolean =>
    fits(a, val[b]!) && fits(b, val[a]!);

  const decode = (val: number[]): Uint8Array => decodeBytes(tokenIds, val, bits);
  const shuffle = (a: number[]): void => {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j]!, a[i]!];
    }
  };

  const initial = (): number[] | null => {
    const val = new Array<number>(nDistinct).fill(0);
    for (const [id, v] of locked) val[id] = v;
    // Assign the most-constrained tokens (fewest legal values) first, each a random legal value.
    const remaining = [...pool];
    shuffle(remaining);
    const order = [...free].sort(
      (a, b) =>
        remaining.filter((v) => fits(a, v)).length - remaining.filter((v) => fits(b, v)).length,
    );
    for (const id of order) {
      const k = remaining.findIndex((v) => fits(id, v));
      if (k < 0) return null; // infeasible under the locks + constraints
      val[id] = remaining.splice(k, 1)[0]!;
    }
    return val;
  };

  let best: number[] | null = null;
  let bestScore = -Infinity;
  for (let r = 0; r < restarts; r++) {
    const val = initial();
    if (!val) break;
    let cur = score(decode(val));
    for (const [steps, t0] of [
      [Math.max(1500, free.length * 400), 1.0],
      [Math.max(800, free.length * 200), 0.3],
    ] as const) {
      for (let s = 0; s < steps; s++) {
        const temp = t0 * (1 - s / steps) + 0.02;
        if (free.length < 2) break;
        const a = free[Math.floor(rng() * free.length)]!;
        const b = free[Math.floor(rng() * free.length)]!;
        if (a === b) continue;
        if (!canSwap(a, b, val)) continue;
        [val[a], val[b]] = [val[b]!, val[a]!];
        const cand = score(decode(val));
        if (cand >= cur || rng() < Math.exp((cand - cur) / temp)) cur = cand;
        else [val[a], val[b]] = [val[b]!, val[a]!];
      }
    }
    if (cur > bestScore) {
      bestScore = cur;
      best = val.slice();
    }
  }
  // Greedy polish: keep applying the single legal swap that helps most until none does. It closes
  // the endgame annealing leaves. O(free²) per pass, so only for modest alphabets (hex and below);
  // large alphabets (base32/64) stay best-effort and lean on a key or the editable mapping.
  if (best && free.length <= 32) {
    const val = best;
    for (let pass = 0; pass < 40; pass++) {
      let bestGain = 0;
      let bi = -1;
      let bj = -1;
      const cur = score(decode(val));
      for (let x = 0; x < free.length; x++) {
        for (let y = x + 1; y < free.length; y++) {
          const a = free[x]!;
          const b = free[y]!;
          if (!canSwap(a, b, val)) continue;
          [val[a], val[b]] = [val[b]!, val[a]!];
          const gain = score(decode(val)) - cur;
          [val[a], val[b]] = [val[b]!, val[a]!];
          if (gain > bestGain) {
            bestGain = gain;
            bi = a;
            bj = b;
          }
        }
      }
      if (bi < 0) break;
      [val[bi], val[bj]] = [val[bj]!, val[bi]!];
    }
    bestScore = score(decode(val));
  }
  const value = best ?? new Array<number>(nDistinct).fill(0);
  return { value, score: bestScore, bytes: decode(value) };
}
