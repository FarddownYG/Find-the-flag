/**
 * The audio LSB search: length headers (a 32-bit byte or bit count in front of the payload, as
 * common LSB tools write), what an extracted stream looks like (a flag, a file, readable text),
 * the auto-scan over the usual settings ranked by that, and the manual extraction.
 * Pure functions on bytes; the wording of the results is the caller's.
 */
import { latin1Decode, u32be, u32le } from '../../lib/bytes';
import { readability } from '../../lib/readability';
import { classifyStream, KIND_TIER, printableRun, type StreamHit } from '../stego/_lsb-classify';
import { extractLsb, lsbCapacity, type LsbSpec, type PcmLayout } from './_audio-stego-pcm';

export type HeaderMode = 'auto' | 'none' | 'be' | 'le';

export interface Header {
  little: boolean;
  /** What the 32-bit number counts. */
  unit: 'bytes' | 'bits';
  /** Payload length in bytes. */
  length: number;
}

const HEADER_MIN = 3;
const HEADER_MAX = 1 << 26;
/** How much of a payload is looked at to decide whether a header is believable. */
const JUDGE_BYTES = 4096;
/** Largest extraction handed back (the bytes block stays usable in the page). */
export const MAX_EXTRACT = 16 * 1024 * 1024;

/** Every reading of the first four bytes that gives a length which fits the stream. */
function candidates(stream: Uint8Array, available: number): Header[] {
  if (stream.length < 4) return [];
  const max = Math.min(HEADER_MAX, available - 4);
  const out: Header[] = [];
  for (const unit of ['bytes', 'bits'] as const) {
    for (const little of [false, true]) {
      const raw = little ? u32le(stream, 0) : u32be(stream, 0);
      const length = unit === 'bytes' ? raw : raw % 8 === 0 ? raw / 8 : 0;
      if (length >= HEADER_MIN && length <= max) out.push({ little, unit, length });
    }
  }
  return out;
}

/** The payload prefix, classified: also accepts a short all-printable payload. */
function judge(payload: Uint8Array): StreamHit | null {
  const hit = classifyStream(payload);
  if (hit) return hit;
  const n = payload.length;
  if (n >= HEADER_MIN && printableRun(payload) === n && new Set(payload).size >= 2) {
    return { kind: 'text', score: n, start: 0, count: n };
  }
  return null;
}

export interface HeaderChoice {
  header: Header;
  hit: StreamHit;
}

/**
 * A believable length header at the start of `stream`: the number it holds fits the room
 * `available` and the bytes it announces read as something (a flag, a file, text). Random bits
 * hold a length that fits about once in a million, and then they do not read as anything.
 */
export function pickHeader(stream: Uint8Array, available: number): HeaderChoice | null {
  let best: (HeaderChoice & { rank: number }) | null = null;
  for (const header of candidates(stream, available)) {
    const payload = stream.subarray(4, 4 + Math.min(header.length, JUDGE_BYTES));
    const hit = judge(payload);
    if (!hit) continue;
    const rank = KIND_TIER[hit.kind] * 1e6 + hit.score;
    if (!best || rank > best.rank) best = { header, hit, rank };
  }
  return best;
}

/** A length that fits but whose payload reads as nothing (encrypted? or just noise). */
export function weakHeader(stream: Uint8Array, available: number): Header | null {
  return candidates(stream, available)[0] ?? null;
}

// ---------- what a stream is ----------

export interface Finding {
  header: Header | null;
  /** Classification of the payload (after the header, if any). Null when it reads as nothing. */
  hit: StreamHit | null;
  /** Bytes after the header, or the whole stream. */
  payload: Uint8Array;
  /** Rank: kind first, then how readable. Zero when nothing was recognised. */
  tier: number;
  quality: number;
}

/**
 * A short printable run at the start of random bits is common (one start in 300 reads as six
 * characters), so plain text needs more evidence than the image scan asks for: a long run, or
 * words (readability above what random characters reach, about 1 in 100 of them past 9).
 */
const MIN_RUN = 14;
const MIN_READABLE = 18;

function convincing(hit: StreamHit, stream: Uint8Array): boolean {
  if (hit.kind !== 'text' && hit.kind !== 'prefixed') return true;
  const run = printableRun(stream, hit.start);
  if (run >= MIN_RUN) return true;
  return (
    readability(latin1Decode(stream.subarray(hit.start, hit.start + run))).score >= MIN_READABLE
  );
}

/** How much a recognised stream deserves to come first within its kind. */
function qualityOf(hit: StreamHit, payload: Uint8Array): number {
  if (hit.kind === 'flag' || hit.kind === 'file') return hit.score;
  // Text of any kind: real words beat a lucky printable run.
  const run = latin1Decode(
    payload.subarray(hit.start, hit.start + Math.min(400, hit.count ?? 400)),
  );
  return Math.round(readability(run).score * 100) + Math.min(hit.count ?? 0, 99);
}

/**
 * Look at an extracted stream (or its prefix). `available` is the number of bytes the whole
 * extraction holds, which a header's length has to fit.
 */
export function judgeStream(stream: Uint8Array, available: number, mode: HeaderMode): Finding {
  const finish = (header: Header | null, payload: Uint8Array, hit: StreamHit | null): Finding => ({
    header,
    hit,
    payload,
    tier: hit ? KIND_TIER[hit.kind] : 0,
    quality: hit ? qualityOf(hit, payload) + (header ? 1000 : 0) : 0,
  });
  if (mode === 'auto') {
    const chosen = pickHeader(stream, available);
    if (chosen) {
      return finish(chosen.header, stream.subarray(4, 4 + chosen.header.length), chosen.hit);
    }
  } else if (mode !== 'none') {
    const little = mode === 'le';
    const length = little ? u32le(stream, 0) : u32be(stream, 0);
    if (stream.length >= 4 && length >= 1 && length <= available - 4) {
      const payload = stream.subarray(4, 4 + length);
      return finish({ little, unit: 'bytes', length }, payload, classifyStream(payload));
    }
  }
  const hit = classifyStream(stream);
  return finish(null, stream, hit && convincing(hit, stream) ? hit : null);
}

// ---------- auto scan ----------

/** Bytes of each candidate extraction that are looked at. */
export const SCAN_BYTES = 8192;
const PLANE_SETS = [[0], [0, 1], [0, 1, 2], [0, 1, 2, 3]];
const MAX_SCAN_CHANNELS = 8;

export interface ScanHit {
  spec: LsbSpec;
  finding: Finding;
}

/** Which start positions to try for a way of reading the samples (none: skip it). */
export type OffsetPlan = (channel: number | null, unit: 'sample' | 'byte') => number[];

const FROM_START: OffsetPlan = () => [0];

/** How many samples before the first bit that differs from the silence a payload may start. */
const LEAD_ZEROS = 48;

/**
 * Start positions around the place where a silent plane starts to change: a payload written
 * into digital silence starts a few bits (the leading zeros of its first bytes) before the first
 * bit that is not silence.
 */
export function aroundOnset(p: PcmLayout, frame: number, channel: number): OffsetPlan {
  return (ch, unit) => {
    if (ch !== null && ch !== channel) return [];
    const scale = unit === 'byte' ? p.bytes * p.channels : ch === null ? p.channels : 1;
    const out: number[] = [];
    for (let d = 0; d <= LEAD_ZEROS && frame - d >= 0; d++) out.push((frame - d) * scale);
    return out;
  };
}

/** The settings the scan tries for a file with this layout. */
export function scanSpecs(p: PcmLayout, plan: OffsetPlan = FROM_START): LsbSpec[] {
  const channels: (number | null)[] =
    p.channels === 1
      ? [null]
      : [null, ...Array.from({ length: Math.min(p.channels, MAX_SCAN_CHANNELS) }, (_, c) => c)];
  const out: LsbSpec[] = [];
  for (const channel of channels) {
    for (const offset of plan(channel, 'sample')) {
      for (const planes of PLANE_SETS) {
        for (const bitOrder of ['msb', 'lsb'] as const) {
          out.push({ planes, channel, bitOrder, step: 1, offset });
        }
      }
    }
  }
  // Scripts that edit the raw bytes of the audio data: every byte is a sample of its own.
  if (p.bytes > 1) {
    for (const offset of plan(null, 'byte')) {
      for (const planes of PLANE_SETS) {
        for (const bitOrder of ['msb', 'lsb'] as const) {
          out.push({ planes, unit: 'byte', channel: null, bitOrder, step: 1, offset });
        }
      }
    }
  }
  return out;
}

/** Best first: a flag, a file, then text; within a kind, the more readable. */
export function rankHits(hits: ScanHit[]): ScanHit[] {
  return [...hits].sort(
    (x, y) => y.finding.tier - x.finding.tier || y.finding.quality - x.finding.quality,
  );
}

/** Try the usual combinations, best first (flag, file, text; then how readable). */
export function scanLsb(
  b: Uint8Array,
  p: PcmLayout,
  plan: OffsetPlan = FROM_START,
): { hits: ScanHit[]; tried: number } {
  const specs = scanSpecs(p, plan);
  const hits: ScanHit[] = [];
  for (const spec of specs) {
    const available = lsbCapacity(p, spec);
    if (available < 6) continue;
    const stream = extractLsb(b, p, spec, SCAN_BYTES + 4);
    const finding = judgeStream(stream, available, 'auto');
    if (finding.hit) hits.push({ spec, finding });
  }
  return { hits: rankHits(hits), tried: specs.length };
}

// ---------- manual extraction ----------

export interface ManualOptions {
  header: HeaderMode;
  /** Bytes dropped from the start of the extracted stream. */
  skip: number;
  /** Bytes kept (0 = as many as the file holds). */
  limit: number;
}

export interface Extraction {
  /** Bytes the settings can hold in all. */
  capacity: number;
  /** Bytes left after `skip`. */
  available: number;
  header: Header | null;
  /** A length that fits was found but its payload reads as nothing, and it was not used. */
  weak: Header | null;
  bytes: Uint8Array;
  /** More bytes were wanted than a result may hold. */
  capped: boolean;
}

export function extractManual(
  b: Uint8Array,
  p: PcmLayout,
  spec: LsbSpec,
  o: ManualOptions,
): Extraction {
  const capacity = lsbCapacity(p, spec);
  const available = Math.max(0, capacity - o.skip);
  const cap = Math.min(MAX_EXTRACT, o.limit > 0 ? o.limit : Infinity);
  const head = extractLsb(b, p, spec, o.skip + 4 + JUDGE_BYTES).subarray(o.skip);
  let header: Header | null = null;
  let weak: Header | null = null;
  if (o.header === 'auto') {
    header = pickHeader(head, available)?.header ?? null;
    if (!header) weak = weakHeader(head, available);
  } else if (o.header !== 'none' && head.length >= 4) {
    const little = o.header === 'le';
    const length = little ? u32le(head, 0) : u32be(head, 0);
    header = {
      little,
      unit: 'bytes',
      length: Math.max(0, Math.min(length, available - 4)),
    };
  }
  const start = header ? 4 : 0;
  const wanted = header ? header.length : available;
  const n = Math.min(wanted, cap);
  const stream =
    start + n <= head.length ? head : extractLsb(b, p, spec, o.skip + start + n).subarray(o.skip);
  return {
    capacity,
    available,
    header,
    weak,
    bytes: stream.subarray(start, start + n),
    capped: wanted > cap && cap === MAX_EXTRACT,
  };
}
