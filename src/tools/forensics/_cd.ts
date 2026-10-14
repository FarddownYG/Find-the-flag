/**
 * CD images: tell a cooked ISO (2048-byte sectors) from a raw BIN (2352 bytes per sector with
 * sync + header, 2336 without them, 2448 with 96 bytes of subchannel after each), find where
 * the data track ends (audio sectors carry no sync pattern), read the 2048 user-data bytes of
 * any sector, and rebuild what a lost .cue file said.
 */
import type { LazyFile } from '../../core/types';
import { readRange } from './_binary-stream';

export const SYNC = Uint8Array.of(0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0);
export const USER = 2048;

export type CdMode = 'cooked' | 'mode1' | 'mode2form1' | 'mode2form2' | 'mode2';

export interface CdLayout {
  /** Bytes per stored sector (2448 = 2352 + 96 bytes of subchannel, CloneCD .img). */
  sectorSize: 2048 | 2352 | 2336 | 2448;
  /** Where the 2048 user-data bytes start inside a stored sector (of the PVD sector). */
  dataOffset: number;
  mode: CdMode;
  /** File offset of the first sector (non-zero when something precedes the track). */
  base: number;
  /** An ISO 9660 primary volume descriptor sits at sector 16. */
  iso: boolean;
  /** Whole sectors in the file. */
  sectors: number;
  /**
   * Sectors of the data track: the first `dataSectors` sectors carry the sync pattern, the
   * rest do not (CD audio after the data track, as in a game CD's BIN). Set by measureCd;
   * equal to `sectors` for cooked and 2336-byte images.
   */
  dataSectors: number;
  /** Bytes left after the last whole sector. */
  remainder: number;
  /** Address in the header of the first raw sector (minute:second:frame), if any. */
  firstMsf?: string;
}

const isCd001 = (b: Uint8Array, p: number) =>
  p + 6 <= b.length &&
  b[p] === 0x43 &&
  b[p + 1] === 0x44 &&
  b[p + 2] === 0x30 &&
  b[p + 3] === 0x30 &&
  b[p + 4] === 0x31;

export function hasSync(b: Uint8Array, p: number): boolean {
  if (p < 0 || p + 12 > b.length) return false;
  for (let i = 0; i < 12; i++) if (b[p + i] !== SYNC[i]) return false;
  return true;
}

const bcd = (v: number) => (v >> 4) * 10 + (v & 15);
const msfText = (b: Uint8Array, p: number) =>
  [b[p + 12]!, b[p + 13]!, b[p + 14]!].map((v) => String(bcd(v)).padStart(2, '0')).join(':');

/** Data offset of a raw 2352-byte sector from its mode byte (and Mode 2 sub-header). */
function rawDataOffset(b: Uint8Array, p: number): { offset: number; mode: CdMode } | null {
  const mode = b[p + 15];
  if (mode === 1) return { offset: 16, mode: 'mode1' };
  if (mode === 2) {
    // Mode 2 (XA): sub-header twice (8 bytes), sub-mode bit 5 = Form 2.
    const form2 = ((b[p + 18] ?? 0) & 0x20) !== 0;
    return { offset: 24, mode: form2 ? 'mode2form2' : 'mode2form1' };
  }
  return null;
}

/**
 * Sector layout from the first 64 KiB (`head`) and the file size, or null when this does not
 * look like a CD image at all.
 */
export function detectCd(head: Uint8Array, size: number): CdLayout | null {
  const whole = (sectorSize: 2048 | 2352 | 2336 | 2448, base: number) => {
    const sectors = Math.floor((size - base) / sectorSize);
    return { sectors, dataSectors: sectors, remainder: (size - base) % sectorSize };
  };
  if (isCd001(head, 16 * USER + 1)) {
    return {
      sectorSize: 2048,
      dataOffset: 0,
      mode: 'cooked',
      base: 0,
      iso: true,
      ...whole(2048, 0),
    };
  }
  // Raw sectors: the sync pattern repeats every 2352 bytes (2448 with subchannel data).
  // A few leading bytes are tolerated.
  let base = -1;
  let period: 2352 | 2448 = 2352;
  for (let i = head.indexOf(0, 0); i >= 0 && i < Math.min(head.length, 2352 * 4);) {
    if (hasSync(head, i)) {
      const found = ([2352, 2448] as const).find(
        (n) => hasSync(head, i + n) || (n === 2352 && i + n >= size),
      );
      if (found) {
        base = i;
        period = found;
        break;
      }
    }
    i = head.indexOf(0, i + 1);
  }
  if (base >= 0) {
    const pvd = base + 16 * period;
    const first = rawDataOffset(head, base) ?? { offset: 16, mode: 'mode1' as CdMode };
    const at = pvd + 16 <= head.length ? (rawDataOffset(head, pvd) ?? first) : first;
    return {
      sectorSize: period,
      dataOffset: at.offset,
      mode: at.mode,
      base,
      iso: hasSync(head, pvd) && isCd001(head, pvd + at.offset + 1),
      firstMsf: msfText(head, base),
      ...whole(period, base),
    };
  }
  if (isCd001(head, 16 * 2336 + 8 + 1)) {
    return {
      sectorSize: 2336,
      dataOffset: 8,
      mode: 'mode2',
      base: 0,
      iso: true,
      ...whole(2336, 0),
    };
  }
  return null;
}

/** Raw images (2352 / 2448) carry a sync pattern at the start of every sector. */
export const isRawLayout = (l: CdLayout) => l.sectorSize === 2352 || l.sectorSize === 2448;

/**
 * Where the data track of a raw image ends. Data sectors start with the sync pattern, CD
 * audio sectors do not, and in a BIN the data track comes first: a binary search over ~20
 * sectors finds the edge without reading the audio. `hint` (the ISO volume size) is tried
 * first. Cooked and 2336-byte images have no sync: the whole file is the data track.
 */
export async function measureCd(file: LazyFile, l: CdLayout, hint = 0): Promise<CdLayout> {
  if (!isRawLayout(l) || l.sectors <= 1) return l;
  const syncAt = async (i: number) =>
    hasSync(await readRange(file, l.base + i * l.sectorSize, 12), 0);
  if (await syncAt(l.sectors - 1)) return { ...l, dataSectors: l.sectors };
  let lo = 0;
  if (hint > 0 && hint < l.sectors && (await syncAt(hint - 1))) lo = hint - 1;
  let hi = l.sectors - 1;
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (await syncAt(mid)) lo = mid;
    else hi = mid;
  }
  return { ...l, dataSectors: hi };
}

/** Reads the 2048-byte user data of logical sectors, whatever the stored layout. */
export class SectorReader {
  constructor(
    readonly file: LazyFile,
    readonly layout: CdLayout,
  ) {}

  /** Sectors of the data track (audio sectors after it hold no user data). */
  get blocks(): number {
    return this.layout.dataSectors;
  }

  /** `length` user-data bytes from the start of sector `lba` (clamped to the image). */
  async read(lba: number, length: number): Promise<Uint8Array> {
    const { sectorSize, base } = this.layout;
    const count = Math.max(0, Math.min(Math.ceil(length / USER), this.blocks - lba));
    if (count <= 0 || lba < 0) return new Uint8Array(0);
    if (sectorSize === USER) {
      return readRange(this.file, base + lba * USER, Math.min(length, count * USER));
    }
    const out = new Uint8Array(Math.min(length, count * USER));
    // Batches of 1024 raw sectors (2.3 MiB) keep every read small.
    for (let done = 0; done < count; done += 1024) {
      const n = Math.min(1024, count - done);
      const raw = await readRange(this.file, base + (lba + done) * sectorSize, n * sectorSize);
      for (let k = 0; k < n; k++) {
        const p = k * sectorSize;
        const off =
          sectorSize === 2352 || sectorSize === 2448
            ? (rawDataOffset(raw, p)?.offset ?? this.layout.dataOffset)
            : this.layout.dataOffset;
        const at = (done + k) * USER;
        if (at >= out.length) break;
        out.set(raw.subarray(p + off, p + off + Math.min(USER, out.length - at)), at);
      }
    }
    return out;
  }

  /**
   * The same bytes as a Blob. A cooked image is sliced without reading anything; a raw one is
   * de-interleaved in batches.
   */
  async blob(lba: number, length: number): Promise<Blob> {
    const { sectorSize, base } = this.layout;
    if (sectorSize === USER) {
      const start = base + lba * USER;
      return this.file.blob.slice(start, Math.min(this.file.size, start + length));
    }
    // Chained Blobs: each batch is handed to the Blob store as soon as it is read, so the
    // copies never pile up in memory (the browser may even keep big Blobs on disk).
    let acc = new Blob([]);
    const step = 1024 * USER;
    for (let done = 0; done < length; done += step) {
      const part = await this.read(lba + done / USER, Math.min(step, length - done));
      if (part.length === 0) break;
      acc = new Blob([acc, part as BlobPart]);
    }
    return acc;
  }
}

// ---------------------------------------------------------------- EDC

const EDC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let e = i;
    for (let j = 0; j < 8; j++) e = (e >>> 1) ^ (e & 1 ? 0xd8018001 : 0);
    t[i] = e >>> 0;
  }
  return t;
})();

/** CD-ROM error detection code (CRC-32 with polynomial 0xD8018001, LSB first). */
export function edc(b: Uint8Array, from: number, to: number): number {
  let e = 0;
  for (let i = from; i < to; i++) e = (e >>> 8) ^ EDC_TABLE[(e ^ b[i]!) & 0xff]!;
  return e >>> 0;
}

export type EdcState = 'ok' | 'zero' | 'bad' | 'none';

/** EDC check of the raw sector at `p` (Mode 1 or Mode 2 Form 1). */
export function checkEdc(raw: Uint8Array, p: number): EdcState {
  const mode = raw[p + 15];
  const form2 = ((raw[p + 18] ?? 0) & 0x20) !== 0;
  const [from, to] = mode === 1 ? [0, 2064] : mode === 2 && !form2 ? [16, 2072] : [-1, -1];
  if (from < 0 || p + to + 4 > raw.length) return 'none';
  const stored =
    (raw[p + to]! |
      (raw[p + to + 1]! << 8) |
      (raw[p + to + 2]! << 16) |
      (raw[p + to + 3]! << 24)) >>>
    0;
  if (stored === 0) return 'zero';
  return stored === edc(raw, p + from, p + to) ? 'ok' : 'bad';
}

// ---------------------------------------------------------------- .cue / audio

/** Track type as a .cue file writes it; null when a .cue cannot describe the layout. */
export function cueMode(l: CdLayout): string | null {
  if (l.sectorSize === 2048) return 'MODE1/2048';
  if (l.sectorSize === 2336) return 'MODE2/2336';
  if (l.sectorSize === 2448) return null;
  return l.mode === 'mode1' ? 'MODE1/2352' : 'MODE2/2352';
}

/** mm:ss:ff (75 frames per second) of a sector count. */
export function msf(frames: number): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(Math.floor(frames / 4500))}:${p(Math.floor(frames / 75) % 60)}:${p(frames % 75)}`;
}

export interface CueTrack {
  /** MODE1/2352, AUDIO… */
  mode: string;
  /** Sector of the file where the track (its INDEX 01) starts. */
  frame: number;
}

/** A generic .cue for `fileName`: one data track, or the tracks given. */
export function buildCue(fileName: string, tracks: string | CueTrack[], startFrame = 0): string {
  const name = fileName.replace(/"/g, "'");
  const list = typeof tracks === 'string' ? [{ mode: tracks, frame: startFrame }] : tracks;
  let out = `FILE "${name}" BINARY\r\n`;
  list.forEach((t, i) => {
    out += `  TRACK ${String(i + 1).padStart(2, '0')} ${t.mode}\r\n    INDEX 01 ${msf(t.frame)}\r\n`;
  });
  return out;
}

/** 44-byte WAV header for raw CD audio (CD-DA: 44.1 kHz, 16-bit, stereo, little-endian). */
export function cdAudioWavHeader(dataSize: number): Uint8Array {
  const h = new Uint8Array(44);
  const v = new DataView(h.buffer);
  const tag = (o: number, s: string) => [...s].forEach((c, i) => (h[o + i] = c.charCodeAt(0)));
  tag(0, 'RIFF');
  v.setUint32(4, 36 + dataSize, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 2, true);
  v.setUint32(24, 44100, true);
  v.setUint32(28, 44100 * 4, true);
  v.setUint16(32, 4, true);
  v.setUint16(34, 16, true);
  tag(36, 'data');
  v.setUint32(40, dataSize, true);
  return h;
}

// ---------------------------------------------------------------- empty space

export type ZeroState = 'zero' | 'sampled' | 'data';

/** Read exactly up to this much when checking for zeros; sample the rest. */
const ZERO_EXACT = 8 << 20;
const ZERO_STEP = 2 << 20;
const ZERO_SAMPLES = 16;
const ZERO_SAMPLE = 256 << 10;

function allZero(b: Uint8Array): boolean {
  if (b.byteOffset % 4 === 0 && b.length % 4 === 0) {
    const w = new Uint32Array(b.buffer, b.byteOffset, b.length / 4);
    for (let i = 0; i < w.length; i++) if (w[i] !== 0) return false;
    return true;
  }
  for (let i = 0; i < b.length; i++) if (b[i] !== 0) return false;
  return true;
}

/**
 * Is [0, length) of a byte space all zero? `read(offset, n)` reads it (offsets are multiples
 * of 2048, so a SectorReader's user data works too). The first 8 MiB are read in full and
 * the first non-zero byte stops the check; beyond that, 16 pieces of 256 KiB spread over the
 * rest and its last 256 KiB are read ('sampled': no data seen, but not every byte checked).
 */
export async function zeroState(
  read: (offset: number, length: number) => Promise<Uint8Array>,
  length: number,
): Promise<ZeroState> {
  const exact = Math.min(length, ZERO_EXACT);
  for (let o = 0; o < exact; o += ZERO_STEP) {
    if (!allZero(await read(o, Math.min(ZERO_STEP, exact - o)))) return 'data';
  }
  if (exact === length) return 'zero';
  const rest = length - exact;
  for (let k = 0; k < ZERO_SAMPLES; k++) {
    const at = exact + Math.floor((rest * k) / ZERO_SAMPLES / USER) * USER;
    const n = Math.min(ZERO_SAMPLE, length - at);
    if (n > 0 && !allZero(await read(at, n))) return 'data';
  }
  const last = Math.max(exact, Math.floor((length - ZERO_SAMPLE) / USER) * USER);
  return allZero(await read(last, length - last)) ? 'sampled' : 'data';
}

/** zeroState of bytes [start, end) of a file. */
export const zeroBytes = (file: LazyFile, start: number, end: number) =>
  zeroState((o, n) => readRange(file, start + o, n), end - start);

/** zeroState of the user data of sectors [from, to) (the headers of raw sectors are skipped). */
export const zeroSectors = (r: SectorReader, from: number, to: number) =>
  zeroState((o, n) => r.read(from + o / USER, n), Math.max(0, to - from) * USER);
