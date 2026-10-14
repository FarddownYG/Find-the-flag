/**
 * What follows IEND, for the PNG chunk surgeon: split it into the files glued there (ZIP, JPEG,
 * PNG… one after the other, cut where each one's own structure ends), stray IEND chunks, and
 * whatever is left, and pull the readable strings out so that a flag in plain text shows up.
 */
import { matchesAt, type Signature, SIGNATURES } from '../../lib/signatures';

export interface TailPart {
  /** Offset within the tail. */
  offset: number;
  data: Uint8Array;
  kind: 'file' | 'iend' | 'zeros' | 'newlines' | 'text' | 'unknown';
  sig?: Signature;
}

/** An empty IEND chunk: length 0, "IEND", CRC AE 42 60 82. */
const IEND_CHUNK = [0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];
const MAX_PARTS = 16;
/** Signatures are looked for in the first 4 MiB of the tail only. */
const SCAN_LIMIT = 4 << 20;
const MAX_STRINGS = 4096;

/** Strong signatures indexed by their first magic byte (they all start at the file start). */
const BY_FIRST = (() => {
  const map = new Map<number, Signature[]>();
  for (const s of SIGNATURES) {
    const first = s.magic[0];
    if (s.weak || (s.offset ?? 0) !== 0 || first === null || first === undefined) continue;
    if (s.magic.length < 3 && !s.valid) continue;
    const list = map.get(first) ?? [];
    list.push(s);
    map.set(first, list);
  }
  for (const list of map.values()) list.sort((a, b) => b.magic.length - a.magic.length);
  return map;
})();

function signatureAt(b: Uint8Array, p: number): Signature | null {
  for (const s of BY_FIRST.get(b[p]!) ?? []) {
    if (!matchesAt(b, s, p)) continue;
    try {
      if (s.valid && !s.valid(b, p)) continue;
    } catch {
      // A structural check that reads past the end means "not this format".
      continue;
    }
    return s;
  }
  return null;
}

const iendAt = (b: Uint8Array, p: number) =>
  p + IEND_CHUNK.length <= b.length && IEND_CHUNK.every((v, i) => b[p + i] === v);

/** The next offset (from `from`) where a known file or an IEND chunk starts, or the end. */
function nextStart(b: Uint8Array, from: number): number {
  const stop = Math.min(b.length, SCAN_LIMIT);
  for (let p = from; p < stop; p++) if (iendAt(b, p) || signatureAt(b, p)) return p;
  return b.length;
}

function ownEnd(b: Uint8Array, p: number, sig: Signature): number | null {
  try {
    return sig.end ? sig.end(b, p) : null;
  } catch {
    // A structure that cannot be walked to its end: treated as an unknown end.
    return null;
  }
}

function fileEnd(b: Uint8Array, p: number, sig: Signature): number {
  const end = ownEnd(b, p, sig);
  if (end !== null && end > p) return Math.min(end, b.length);
  // Unknown end: up to the next thing that starts (or the end of the tail).
  return nextStart(b, p + 1);
}

function classify(d: Uint8Array): TailPart['kind'] {
  if (d.every((x) => x === 0)) return 'zeros';
  if (d.every((x) => x === 0 || x === 0x0a || x === 0x0d)) return 'newlines';
  let printable = 0;
  const n = Math.min(d.length, 512);
  for (let i = 0; i < n; i++) {
    const c = d[i]!;
    if ((c >= 0x20 && c < 0x7f) || c === 9 || c === 10 || c === 13 || c >= 0xc0) printable++;
  }
  return printable / n > 0.9 ? 'text' : 'unknown';
}

export function splitTail(tail: Uint8Array): TailPart[] {
  const parts: TailPart[] = [];
  let p = 0;
  while (p < tail.length) {
    if (parts.length === MAX_PARTS - 1) {
      const data = tail.subarray(p);
      parts.push({ offset: p, data, kind: classify(data) });
      break;
    }
    if (iendAt(tail, p)) {
      parts.push({ offset: p, data: tail.subarray(p, p + IEND_CHUNK.length), kind: 'iend' });
      p += IEND_CHUNK.length;
      continue;
    }
    const sig = p < SCAN_LIMIT ? signatureAt(tail, p) : null;
    if (sig) {
      const end = fileEnd(tail, p, sig);
      parts.push({ offset: p, data: tail.subarray(p, end), kind: 'file', sig });
      p = end;
      continue;
    }
    const end = p < SCAN_LIMIT ? nextStart(tail, p + 1) : tail.length;
    const data = tail.subarray(p, end);
    parts.push({ offset: p, data, kind: classify(data) });
    p = end;
  }
  return parts;
}

/** Readable runs (4+ printable characters) of the parts that are not known files. */
export function tailStrings(parts: TailPart[]): string {
  const out: string[] = [];
  let size = 0;
  for (const part of parts) {
    if (part.kind !== 'text' && part.kind !== 'unknown') continue;
    let run = '';
    const flush = () => {
      const s = run.trim();
      if (s.length >= 4 && size < MAX_STRINGS) {
        out.push(s);
        size += s.length;
      }
      run = '';
    };
    for (const c of part.data) {
      if ((c >= 0x20 && c < 0x7f) || c === 9) run += String.fromCharCode(c);
      else flush();
    }
    flush();
  }
  const text = out.join('\n');
  return text.length > MAX_STRINGS ? `${text.slice(0, MAX_STRINGS)}…` : text;
}
