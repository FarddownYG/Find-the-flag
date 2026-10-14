/**
 * Tolerant PNG chunk walker for the PNG chunk surgeon. Unlike pngcheck (and _png.parsePng),
 * it never stops at the first problem: an impossible length or a garbled type makes it scan
 * forward for the next plausible chunk (resynchronise) and carry on, chunks after IEND are
 * still listed, and the walk only ends at the end of the file or at data that is clearly not
 * a chunk any more (an appended file after IEND).
 */
import { latin1Decode, u32be } from '../../lib/bytes';
import { crc32 } from '../../lib/signatures';
import { KNOWN_CHUNKS, PNG_SIGNATURE } from './_png';

export interface SurgeonChunk {
  /** Position in the walk (0-based). */
  index: number;
  /** Offset of the 4-byte length field. */
  offset: number;
  type: string;
  /** Data length actually used (the stored one, or the one recovered by resynchronising). */
  length: number;
  /** Length field as written in the file. */
  storedLength: number;
  dataStart: number;
  data: Uint8Array;
  /** Null when the chunk is cut off by the end of the file. */
  crcStored: number | null;
  crcComputed: number;
  crcOk: boolean;
  validType: boolean;
  afterIend: boolean;
  /**
   * ok: read as written · length-fixed: the length field was wrong, the real one was found by
   * resynchronising (and the CRC confirms it) · length-guessed: same, CRC does not confirm ·
   * type-fixed: the type was garbled, the CRC names the real one · type-guessed: garbled type
   * and CRC, taken for IHDR from its place and size · truncated: cut by EOF.
   */
  status: 'ok' | 'length-fixed' | 'length-guessed' | 'type-fixed' | 'type-guessed' | 'truncated';
  /** Type as written when it was repaired. */
  storedType?: string;
}

/** Bytes skipped while resynchronising (not a readable chunk). */
export interface Gap {
  offset: number;
  length: number;
  claimedType: string;
  claimedLength: number;
}

export interface SurgeonParse {
  signature: 'ok' | 'damaged' | 'missing';
  /** Offset of the first chunk. */
  start: number;
  chunks: SurgeonChunk[];
  gaps: Gap[];
  /** End of the first IEND chunk, or null. */
  iendEnd: number | null;
  /** Start of the data that follows the last chunk (after IEND), or null if there is none. */
  tailStart: number | null;
}

const isLetter = (c: number | undefined) =>
  c !== undefined && ((c >= 65 && c <= 90) || (c >= 97 && c <= 122));
const typeAt = (b: Uint8Array, p: number) => latin1Decode(b.subarray(p, p + 4));
const lettersAt = (b: Uint8Array, p: number) =>
  isLetter(b[p]) && isLetter(b[p + 1]) && isLetter(b[p + 2]) && isLetter(b[p + 3]);

/** CRC of a chunk: type bytes then data. */
export function chunkCrc(typeBytes: Uint8Array, data: Uint8Array): number {
  return crc32(data, crc32(typeBytes));
}

function crcOfChunkAt(b: Uint8Array, p: number, length: number): number {
  return crc32(b.subarray(p + 4, p + 8 + length));
}

const MAX_LENGTH = 0x7fffffff;

/** A chunk header at p whose length fits in the file. */
function fits(b: Uint8Array, p: number): boolean {
  if (p + 12 > b.length) return false;
  const length = u32be(b, p);
  return length <= MAX_LENGTH && p + 12 + length <= b.length;
}

/** Valid type, length that fits and a matching CRC: certainly a chunk. */
function strongChunkAt(b: Uint8Array, p: number): boolean {
  if (!lettersAt(b, p + 4) || !fits(b, p)) return false;
  const length = u32be(b, p);
  return crcOfChunkAt(b, p, length) === u32be(b, p + 8 + length);
}

/**
 * Next offset after `from` where a chunk plausibly starts: first a chunk whose CRC matches
 * (certain), otherwise the first known chunk type whose length fits (likely). IEND at the very
 * end of the file is also accepted without its CRC.
 */
function resync(b: Uint8Array, from: number): number | null {
  let weak: number | null = null;
  for (let p = from; p + 12 <= b.length; p++) {
    if (!lettersAt(b, p + 4)) continue;
    if (strongChunkAt(b, p)) return p;
    if (weak === null && fits(b, p) && typeAt(b, p + 4) in KNOWN_CHUNKS) weak = p;
  }
  return weak;
}

/** Where the chunks start, or null when this does not look like a PNG at all. */
function findStart(b: Uint8Array): { signature: SurgeonParse['signature']; start: number } | null {
  const sigOk = PNG_SIGNATURE.every((v, i) => b[i] === v);
  if (sigOk) return { signature: 'ok', start: 8 };
  if (typeAt(b, 12) === 'IHDR' || (u32be(b, 8) === 13 && lettersAt(b, 12)))
    return { signature: 'damaged', start: 8 };
  if (typeAt(b, 4) === 'IHDR') return { signature: 'missing', start: 0 };
  // Signature partly cut or padded: look for IHDR near the start.
  const limit = Math.min(b.length - 4, 64);
  for (let p = 4; p < limit; p++) {
    if (typeAt(b, p) === 'IHDR')
      return { signature: p - 4 >= 8 ? 'damaged' : 'missing', start: p - 4 };
  }
  return null;
}

/** Try every known type name against the stored CRC: a garbled type is recovered exactly. */
function repairType(data: Uint8Array, stored: number): string | null {
  for (const name of Object.keys(KNOWN_CHUNKS)) {
    const t = new Uint8Array(4);
    for (let i = 0; i < 4; i++) t[i] = name.charCodeAt(i);
    if (chunkCrc(t, data) === stored) return name;
  }
  return null;
}

export function parseTolerant(b: Uint8Array): SurgeonParse | null {
  const head = findStart(b);
  if (!head) return null;
  const chunks: SurgeonChunk[] = [];
  const gaps: Gap[] = [];
  let iendEnd: number | null = null;
  let tailStart: number | null = null;
  let afterIend = false;
  let pos = head.start;

  const push = (c: Omit<SurgeonChunk, 'index' | 'afterIend' | 'crcOk' | 'data'>) => {
    const data = b.subarray(c.dataStart, c.dataStart + c.length);
    chunks.push({
      ...c,
      index: chunks.length,
      data,
      afterIend,
      crcOk: c.crcStored !== null && c.crcStored === c.crcComputed,
    });
  };

  while (pos < b.length) {
    if (afterIend) {
      // After IEND only certain chunks count; anything else is appended data.
      if (!strongChunkAt(b, pos)) {
        tailStart = pos;
        break;
      }
    }
    if (pos + 12 > b.length) {
      // Fewer than 12 bytes left: not even an empty chunk.
      gaps.push({
        offset: pos,
        length: b.length - pos,
        claimedType: typeAt(b, pos + 4),
        claimedLength: pos + 4 <= b.length ? u32be(b, pos) : 0,
      });
      break;
    }
    const storedLength = u32be(b, pos);
    const type = typeAt(b, pos + 4);
    const validType = lettersAt(b, pos + 4);
    const lengthFits = fits(b, pos);

    if (validType && lengthFits) {
      const end = pos + 12 + storedLength;
      const crcStored = u32be(b, pos + 8 + storedLength);
      const crcComputed = crcOfChunkAt(b, pos, storedLength);
      // A renamed type ("IDTA", "IHDr") whose CRC is still that of the real one.
      const real =
        crcStored !== crcComputed && !(type in KNOWN_CHUNKS)
          ? repairType(b.subarray(pos + 8, pos + 8 + storedLength), crcStored)
          : null;
      if (real) {
        push({
          offset: pos,
          type: real,
          length: storedLength,
          storedLength,
          dataStart: pos + 8,
          crcStored,
          crcComputed: crcStored,
          validType: true,
          status: 'type-fixed',
          storedType: type,
        });
        pos = end;
        if (real === 'IEND' && !afterIend) {
          afterIend = true;
          iendEnd = pos;
        }
        continue;
      }
      if (crcStored !== crcComputed && end < b.length && !lettersAt(b, end + 4)) {
        // Bad CRC and garbage right after: the length is probably too small. A later chunk
        // whose preceding 4 bytes are the CRC of everything up to it gives the real length.
        const next = resync(b, pos + 12);
        if (next !== null && next > end) {
          const length = next - pos - 12;
          if (crcOfChunkAt(b, pos, length) === u32be(b, next - 4)) {
            push({
              offset: pos,
              type,
              length,
              storedLength,
              dataStart: pos + 8,
              crcStored: u32be(b, next - 4),
              crcComputed: crcOfChunkAt(b, pos, length),
              validType: true,
              status: 'length-fixed',
            });
            pos = next;
            continue;
          }
        }
      }
      push({
        offset: pos,
        type,
        length: storedLength,
        storedLength,
        dataStart: pos + 8,
        crcStored,
        crcComputed,
        validType: true,
        status: 'ok',
      });
      pos = end;
      if (type === 'IEND' && !afterIend) {
        afterIend = true;
        iendEnd = pos;
      }
      continue;
    }

    if (!validType && lengthFits) {
      // Garbled type, sane length: accept it when a chunk (or the end) follows.
      const end = pos + 12 + storedLength;
      if (end === b.length || strongChunkAt(b, end) || lettersAt(b, end + 4)) {
        const data = b.subarray(pos + 8, pos + 8 + storedLength);
        const crcStored = u32be(b, pos + 8 + storedLength);
        const real = repairType(data, crcStored);
        push({
          offset: pos,
          type: real ?? type,
          length: storedLength,
          storedLength,
          dataStart: pos + 8,
          crcStored,
          crcComputed: real ? crcStored : crcOfChunkAt(b, pos, storedLength),
          validType: real !== null,
          status: real ? 'type-fixed' : 'ok',
          storedType: real ? type : undefined,
        });
        pos = end;
        continue;
      }
    }

    // Impossible length or garbage: find where the chunks start again.
    const next = resync(b, pos + 1);
    if (validType && next !== null && next >= pos + 12) {
      // The chunk itself is probably fine and only its length field is wrong.
      const length = next - pos - 12;
      const crcStored = u32be(b, next - 4);
      const crcComputed = crcOfChunkAt(b, pos, length);
      push({
        offset: pos,
        type,
        length,
        storedLength,
        dataStart: pos + 8,
        crcStored,
        crcComputed,
        validType: true,
        status: crcStored === crcComputed ? 'length-fixed' : 'length-guessed',
      });
      pos = next;
      continue;
    }
    if (validType && next === null) {
      // Nothing plausible follows: the chunk runs into the end of the file.
      const length = Math.max(0, b.length - pos - 8);
      push({
        offset: pos,
        type,
        length,
        storedLength,
        dataStart: pos + 8,
        crcStored: null,
        crcComputed: crcOfChunkAt(b, pos, length),
        validType: true,
        status: 'truncated',
      });
      break;
    }
    const to = next ?? b.length;
    gaps.push({ offset: pos, length: to - pos, claimedType: type, claimedLength: storedLength });
    pos = to;
  }
  // No IHDR, but the first chunk has its place and size: a renamed IHDR with a wrong CRC too.
  const first = chunks[0];
  if (
    first &&
    first.offset === head.start &&
    first.length === 13 &&
    first.status === 'ok' &&
    !first.crcOk &&
    !(first.type in KNOWN_CHUNKS) &&
    !chunks.some((c) => c.type === 'IHDR')
  ) {
    chunks[0] = {
      ...first,
      type: 'IHDR',
      validType: true,
      status: 'type-guessed',
      storedType: first.type,
    };
  }
  return { signature: head.signature, start: head.start, chunks, gaps, iendEnd, tailStart };
}

/** Cheap structural sniff for detect(): signature or IHDR in place. */
export function looksLikePng(b: Uint8Array): boolean {
  return findStart(b) !== null && b.length >= 20;
}
