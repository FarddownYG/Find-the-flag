/**
 * Crypto detector for the analysis socle: is this file an AES-CBC ciphertext, in particular an
 * Angecryption construct (a file that decrypts, under some key, to another valid file)? It runs the
 * AngeCryption tool's own core (`testKey`, `windowKeys`, `looksRandom`), nothing is reimplemented.
 *
 * Confidence rule:
 *  - 'confirmed' only when a candidate key decrypts the body into at least two distinct, structurally
 *    checked signatures of a known format (the tool's own bar): the key is recovered, which is
 *    decisive. Candidate keys are the tool's public demo key plus 16/24/32-byte windows cut from the
 *    file itself (a key left in a comment or a header).
 *  - 'probable' when no key matched but the file is a whole number of 16-byte blocks, has no known
 *    signature and is statistically uniform (the shape of a raw AES-CBC output whose key is not in
 *    the file).
 *  - never anything on a clean file: a text, an image, an archive or a binary does not look uniform
 *    or carries a signature, and a key test needs two strong signatures to pass.
 * Pure and deterministic: bytes in, findings out.
 */
import { identify } from '../lib/signatures';
import { utf8Encode } from '../lib/bytes';
import {
  BLOCK,
  entropy,
  familyOf,
  looksRandom,
  testKey,
  windowKeys,
} from '../tools/crypto/_angecryption';
import type { Finding } from './analyze';

/** Public demo key of the AngeCryption sample (a made-up key, not a challenge secret). */
const DEMO_KEYS: readonly string[] = ['FTF-angecrypt-16'];

/** Cap on the keys cut from the file itself (the tool's default is 6000). */
const MAX_WINDOWS = 2000;
/** The body is checked for uniformity on this many bytes (after the first block) before any key. */
const BODY_PROBE = 8192;
/** Below this size a statistical verdict means nothing. */
const MIN_PROBABLE = 64;

const toHex = (b: Uint8Array): string =>
  [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

export async function detectCrypto(bytes: Uint8Array, name?: string): Promise<Finding[]> {
  void name;
  const findings: Finding[] = [];
  const blocks = Math.floor(bytes.length / BLOCK);
  if (blocks < 2) return findings;

  // A key test is only worth running on an AES-looking body: the blocks after the first one are
  // ciphertext, so they are uniform. This skips plain text, images and binaries at once.
  const body = bytes.subarray(BLOCK, Math.min(bytes.length, BLOCK + BODY_PROBE));
  const uniform = looksRandom(body);

  if (uniform) {
    const candidates: { key: Uint8Array; where: string }[] = DEMO_KEYS.map((k) => ({
      key: utf8Encode(k),
      where: 'demo-key',
    }));
    for (const w of windowKeys(bytes, MAX_WINDOWS)) {
      candidates.push({ key: w.key, where: `window@${w.at}` });
    }
    for (const c of candidates) {
      const t = testKey(bytes, c.key);
      if (!t.ok) continue;
      const family = familyOf(t.signatures) ?? 'unknown';
      findings.push({
        kind: 'encrypted',
        confidence: 'confirmed',
        title: `AES-CBC key recovered, body decrypts to ${family}`,
        detail: `key ${toHex(c.key)} (${c.where}); signatures: ${t.signatures.join(', ')}`,
        offset: 0,
        size: bytes.length,
      });
      return findings;
    }
  }

  if (
    uniform &&
    bytes.length % BLOCK === 0 &&
    bytes.length >= MIN_PROBABLE &&
    identify(bytes).length === 0 &&
    looksRandom(bytes)
  ) {
    findings.push({
      kind: 'encrypted',
      confidence: 'probable',
      title: 'Uniform data in whole 16-byte blocks: AES-CBC or Angecryption candidate',
      detail: `${blocks} blocks, ${entropy(bytes).toFixed(2)} bits/byte, no known signature, no key in the file`,
      offset: 0,
      size: bytes.length,
    });
  }
  return findings;
}
