/**
 * Anomaly scan: what a structural parser did NOT account for. Pure and deterministic.
 *
 * The caller (the analysis socle) hands over the byte ranges its parsers explained (`covered`); this
 * module looks at the rest:
 *  - high-entropy runs that are not covered (compressed media are high-entropy too, but their
 *    parser covers them, so they never show up here);
 *  - the gap map (uncovered, non-padding stretches between covered ranges);
 *  - data after the logical end of an offset-0 container (post-EOF);
 *  - the encrypted-region verdict: a big, uncovered, uniformly random, signature-less, aligned region
 *    looks like a VeraCrypt/TrueCrypt volume (or a TCSteg payload).
 *
 * Confidence policy: nothing here is decisive proof, so nothing is ever 'confirmed'. 'probable' is
 * for strong statistics (the encrypted verdict, sizeable trailing data), 'candidate' for weak hints.
 */
import type { Finding } from '../../core/analyze';
import { identify } from '../../lib/signatures';
import { analyse, highRegions, shannon } from './entropy';

/** A byte range a parser accounted for. `end` is exclusive. */
export interface CoveredRange {
  start: number;
  end: number;
  label?: string;
}

export interface AnomalyOptions {
  /** Entropy block size in bytes (default 4 KiB). */
  blockSize?: number;
  /** A block at or above this (bits/byte) is "high entropy" (default 7.5). */
  runThreshold?: number;
  /** Mean entropy an uncovered region needs for the encrypted verdict (default 7.8). */
  encryptedEntropy?: number;
  /** Minimum size of an encrypted region (default 64 KiB). */
  encryptedMinSize?: number;
  /** Smallest uncovered, non-padding gap worth reporting (default 64 bytes). */
  minGap?: number;
}

interface Span {
  start: number;
  end: number;
}

const DEFAULTS = {
  blockSize: 4096,
  runThreshold: 7.5,
  encryptedEntropy: 7.8,
  encryptedMinSize: 64 * 1024,
  minGap: 64,
};

/** How far from a region's start a known signature is looked for (ISO 9660 sits at 0x8001). */
const SIGNATURE_WINDOW = 0x9000;
/** A signature with fewer fixed bytes than this matches random data by chance too often. */
const MIN_SIGNATURE_BYTES = 3;

const CONFIDENCE_RANK: Record<Finding['confidence'], number> = {
  confirmed: 0,
  probable: 1,
  candidate: 2,
};

/** Clamp to the buffer, drop empty ranges, sort and merge overlapping or touching ones. */
function normalise(covered: readonly CoveredRange[], length: number): Span[] {
  const spans: Span[] = [];
  for (const c of covered) {
    const start = Math.max(0, Math.floor(c.start));
    const end = Math.min(length, Math.floor(c.end));
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) spans.push({ start, end });
  }
  spans.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Span[] = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else merged.push({ ...s });
  }
  return merged;
}

/** The parts of [from, to) that no covered span touches. */
function uncoveredIn(merged: readonly Span[], from: number, to: number): Span[] {
  const gaps: Span[] = [];
  let pos = from;
  for (const s of merged) {
    if (s.end <= pos) continue;
    if (s.start >= to) break;
    if (s.start > pos) gaps.push({ start: pos, end: Math.min(s.start, to) });
    pos = Math.max(pos, s.end);
    if (pos >= to) break;
  }
  if (pos < to) gaps.push({ start: pos, end: to });
  return gaps;
}

function isConstant(bytes: Uint8Array, start: number, end: number): boolean {
  const first = bytes[start];
  for (let i = start + 1; i < end; i++) if (bytes[i] !== first) return false;
  return true;
}

function entropyOf(bytes: Uint8Array, start: number, end: number): number {
  const counts = new Uint32Array(256);
  for (let i = start; i < end; i++) counts[bytes[i]!] = counts[bytes[i]!]! + 1;
  return shannon(counts, end - start);
}

function hasKnownSignature(bytes: Uint8Array, start: number, end: number): boolean {
  const head = bytes.subarray(start, Math.min(end, start + SIGNATURE_WINDOW));
  return identify(head).some(
    (s) => !s.weak && s.magic.filter((m) => m !== null).length >= MIN_SIGNATURE_BYTES,
  );
}

const overlaps = (a: Span, b: Span) => a.start < b.end && b.start < a.end;
const bits = (e: number) => `${e.toFixed(2)} bits/byte`;

/**
 * Scan `bytes` for what the parsers left unexplained. `covered` are the ranges they did account for
 * (end exclusive); an empty list means "nothing was parsed", so the whole buffer counts as uncovered.
 */
export function scanAnomalies(
  bytes: Uint8Array,
  covered: readonly CoveredRange[],
  opts: AnomalyOptions = {},
): Finding[] {
  const o = { ...DEFAULTS, ...opts };
  const length = bytes.length;
  if (length === 0) return [];

  const merged = normalise(covered, length);
  const labelAt = (offset: number) =>
    covered.find((c) => Math.floor(c.start) === 0 && Math.floor(c.end) === offset)?.label;
  const findings: Finding[] = [];

  // (3) Post-EOF: the logical end of the container that starts at offset 0.
  let eofEnd = length;
  const container = covered.filter((c) => Math.floor(c.start) === 0 && c.end > 0);
  if (container.length > 0) {
    eofEnd = Math.min(
      length,
      container.reduce((m, c) => Math.max(m, Math.floor(c.end)), 0),
    );
  }
  const postEof: Span[] = [];
  const gaps = uncoveredIn(merged, 0, length).filter((g) => !isConstant(bytes, g.start, g.end));
  // Post-EOF is the terminal gap only: if parsed content follows, the gap is just a gap.
  const tail = gaps[gaps.length - 1];
  if (container.length > 0 && tail && tail.end === length && tail.start >= eofEnd) {
    postEof.push(tail);
    const size = tail.end - tail.start;
    const label = labelAt(eofEnd);
    findings.push({
      kind: 'post-eof',
      confidence: size >= 32 ? 'probable' : 'candidate',
      title: `Data after the end of the container${label ? ` (${label})` : ''}`,
      detail: `${size} bytes after the logical end at ${eofEnd}, ${bits(entropyOf(bytes, tail.start, tail.end))}`,
      offset: tail.start,
      size,
    });
  }

  // (2) Gap map: uncovered stretches, padding (one repeated byte) aside.

  // (4) Encrypted-region verdict, inside the uncovered gaps only.
  const encrypted: Span[] = [];
  for (const gap of gaps) {
    if (gap.end - gap.start < o.encryptedMinSize) continue;
    const { blocks } = analyse(bytes.subarray(gap.start, gap.end), o.blockSize);
    for (const run of highRegions(blocks, o.runThreshold)) {
      const start = gap.start + run.start;
      const end = gap.start + run.end;
      const size = end - start;
      if (size < o.encryptedMinSize || run.mean < o.encryptedEntropy) continue;
      if (start % 512 !== 0 && size % 512 !== 0) continue;
      if (hasKnownSignature(bytes, start, end)) continue;
      encrypted.push({ start, end });
      findings.push({
        kind: 'encrypted',
        confidence: 'probable',
        title: 'Probable encrypted container (VeraCrypt/TrueCrypt/TCSteg)',
        detail: `${size} uncovered bytes at ${start}, ${bits(run.mean)}, no known signature`,
        offset: start,
        size,
      });
    }
  }

  // Gaps that are not just the post-EOF tail and not just an encrypted region already reported.
  for (const gap of gaps) {
    const size = gap.end - gap.start;
    if (size < o.minGap) continue;
    if (merged.length === 0) continue; // nothing parsed: the whole file as one gap says nothing
    if (postEof.includes(gap)) continue;
    const covers = encrypted.some(
      (e) => e.start <= gap.start + size * 0.1 && e.end >= gap.end - size * 0.1,
    );
    if (covers) continue;
    findings.push({
      kind: 'gap',
      confidence: 'candidate',
      title: 'Bytes no parser accounted for',
      detail: `${size} bytes, ${bits(entropyOf(bytes, gap.start, gap.end))}`,
      offset: gap.start,
      size,
    });
  }

  // (1) Entropy map: high-entropy runs that are (mostly) uncovered.
  const { blocks } = analyse(bytes, o.blockSize);
  for (const run of highRegions(blocks, o.runThreshold)) {
    const span = { start: run.start, end: run.end };
    if (encrypted.some((e) => overlaps(e, span))) continue;
    if (postEof.some((p) => overlaps(p, span))) continue;
    const open = uncoveredIn(merged, run.start, run.end).reduce((n, g) => n + g.end - g.start, 0);
    if (open < 2 * o.blockSize) continue;
    findings.push({
      kind: 'high-entropy',
      confidence: 'candidate',
      title: 'High-entropy run no parser accounted for',
      detail: `${run.end - run.start} bytes, ${bits(run.mean)}, ${open} uncovered`,
      offset: run.start,
      size: run.end - run.start,
    });
  }

  return findings.sort(
    (a, b) =>
      CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence] ||
      (a.offset ?? 0) - (b.offset ?? 0),
  );
}
