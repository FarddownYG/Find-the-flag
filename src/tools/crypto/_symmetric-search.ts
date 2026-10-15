/**
 * "Try every mode": run the user's own ciphertext through every algorithm and mode that accepts
 * their key (or, for a passphrase, every algorithm and hash), and rank the outputs by how much
 * they look like a right answer. Local brute force over a handful of combinations of data the
 * user supplied; nothing leaves the page.
 */
import { ToolError } from '../../core/errors';
import { isValidUtf8, printableRatio, utf8Decode } from '../../lib/bytes';
import { readability } from '../../lib/readability';
import { identify } from '../../lib/signatures';
import {
  ALGOS,
  HASHES,
  MAX_DERIVED,
  MODES,
  acceptsKey,
  decryptData,
  deriveStream,
  ivLength,
  isBlockCipher,
  splitKeyIv,
  supports,
  checkIv,
  type Algo,
  type DecryptOutcome,
  type Derivation,
  type Hash,
  type Kdf,
  type Mode,
} from './_symmetric';

export interface SearchSetup {
  /** Ciphertext, without a `Salted__` header (and with the IV still in front if `ivPrefix`). */
  data: Uint8Array;
  kdf: Kdf;
  /** The raw key bytes, or the passphrase bytes for the other derivations. */
  secret: Uint8Array;
  /** The IV field. Empty = none given (an all-zero IV is tried). */
  iv: Uint8Array;
  ivPrefix: boolean;
  aad: Uint8Array;
  counter: number;
  iterations: number;
  salt: Uint8Array | null;
}

export type IvSource = 'given' | 'zero' | 'prefix' | 'derived' | 'none';

export interface Candidate {
  algo: Algo;
  mode: Mode;
  /** Digest used by the derivation (null for a raw key). */
  hash: Hash | null;
  key: Uint8Array;
  iv: Uint8Array;
  ivSource: IvSource;
  outcome: DecryptOutcome;
  score: number;
  /** Share of printable bytes in the first 4 KiB, 0..1. */
  printable: number;
  /** French / English readability of that text, 0..100. */
  readable: number;
  /** Name of the file signature the output starts with, if any. */
  signature: string | null;
}

export interface SearchResult {
  candidates: Candidate[];
  /** Combinations that could run (and are ranked). */
  tried: number;
  /** Combinations that cannot take this key / IV / data (wrong size). */
  skipped: number;
}

const SAMPLE = 4096;

/** Score an output: valid padding or tag, printable text that reads as words, a file signature. */
export function rate(
  out: DecryptOutcome,
): Pick<Candidate, 'score' | 'printable' | 'readable' | 'signature'> {
  const sample = out.output.subarray(0, SAMPLE);
  const printable = printableRatio(sample);
  const textual =
    printable > 0.85 && (isValidUtf8(sample) || isValidUtf8(sample.subarray(0, SAMPLE - 3)));
  const readable = textual ? readability(utf8Decode(sample)).score : 0;
  const sig = out.output.length ? identify(out.output).find((s) => !s.weak) : undefined;
  const score =
    (out.padding === 'valid' ? 30 : 0) +
    (out.tag === 'valid' ? 60 : 0) +
    printable * 25 +
    (textual ? 5 : 0) +
    readable * 0.4 +
    (sig ? 40 : 0);
  return { score, printable, readable, signature: sig?.name ?? null };
}

/** The modes tried for an algorithm: stream ciphers have just one pass. */
function modesOf(algo: Algo, kdf: Kdf): Mode[] {
  if (!isBlockCipher(algo)) return ['cbc'];
  // `openssl enc` has no authenticated modes, so a GCM hit on its output would only be noise.
  const derivedByOpenssl = kdf === 'openssl' || kdf === 'pbkdf2';
  return MODES.filter((m) => supports(algo, m) && !(derivedByOpenssl && m === 'gcm'));
}

export async function searchModes(s: SearchSetup): Promise<SearchResult> {
  const candidates: Candidate[] = [];
  let skipped = 0;
  const hashes: (Hash | null)[] = s.kdf === 'raw' ? [null] : [...HASHES];
  for (const hash of hashes) {
    const d: Derivation | null =
      s.kdf === 'raw' || hash === null
        ? null
        : { kdf: s.kdf, hash, iterations: s.iterations, salt: s.salt };
    const stream = d ? await deriveStream(d, s.secret, MAX_DERIVED) : null;
    for (const algo of ALGOS) {
      // The poly1305 AEAD is not something `openssl enc` can have produced.
      if (algo === 'chacha20-poly1305' && (s.kdf === 'openssl' || s.kdf === 'pbkdf2')) continue;
      for (const mode of modesOf(algo, s.kdf)) {
        try {
          const split = d && stream ? splitKeyIv(d, stream, algo, mode) : null;
          const key = split ? split.key : s.secret;
          if (!acceptsKey(algo, key.length)) {
            skipped++;
            continue;
          }
          const need = ivLength(algo, mode);
          let data = s.data;
          let iv: Uint8Array = new Uint8Array();
          let ivSource: IvSource = 'none';
          if (split?.iv) {
            iv = split.iv;
            ivSource = need > 0 ? 'derived' : 'none';
          } else if (need > 0 && s.ivPrefix) {
            if (data.length < need) {
              skipped++;
              continue;
            }
            iv = data.slice(0, need);
            data = data.subarray(need);
            ivSource = 'prefix';
          } else if (need > 0 && s.iv.length > 0) {
            checkIv(algo, mode, s.iv);
            iv = s.iv;
            ivSource = 'given';
          } else if (need > 0) {
            iv = new Uint8Array(need);
            ivSource = 'zero';
          }
          const outcome = decryptData({
            algo,
            mode,
            key,
            iv,
            aad: s.aad,
            counter: s.counter,
            data,
            padding: 'pkcs7',
          });
          candidates.push({ algo, mode, hash, key, iv, ivSource, outcome, ...rate(outcome) });
        } catch (e) {
          if (!(e instanceof ToolError)) throw e;
          skipped++;
        }
      }
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return { candidates, tried: candidates.length, skipped };
}
