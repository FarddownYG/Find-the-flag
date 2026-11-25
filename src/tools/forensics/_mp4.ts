/**
 * Pure ISO-BMFF / QuickTime parser: walks the box tree, reads the sample tables (stco/co64, stsc,
 * stsz/stz2) and computes exactly which byte ranges of the file are referenced as sample data.
 * Whatever lies inside an `mdat` payload (or after the last box) without being referenced by any
 * track is reported as `unreferenced`: the usual hiding place of appended or encrypted payloads.
 *
 * Bytes in, result out. Returns null when the input is not a movie we can account for fully
 * (no `moov`, a fragmented movie, or a track whose sample tables are missing or inconsistent),
 * because a partial accounting would flag legitimate data as unreferenced.
 */

export interface Mp4Box {
  type: string;
  start: number;
  size: number;
}
export interface Mp4Range {
  start: number;
  end: number;
}
export interface Mp4Parse {
  boxes: Mp4Box[];
  /** Payload span of the media data (first `mdat` payload start to last payload end). */
  mdat: Mp4Range | null;
  /** Merged, sorted byte ranges used as sample data by some track. */
  referencedRanges: Mp4Range[];
  /** Bytes of the mdat payloads (and of any tail after the last top-level box) no track uses. */
  unreferenced: Mp4Range[];
}

const CONTAINERS = new Set([
  'moov',
  'trak',
  'mdia',
  'minf',
  'stbl',
  'edts',
  'dinf',
  'udta',
  'mvex',
]);
const MAX_DEPTH = 16;
const MAX_BOXES = 100_000;

interface Track {
  stco: number[] | null;
  stsc: { firstChunk: number; perChunk: number }[] | null;
  sizes: number[] | null;
  constSize: number;
  count: number;
}

class Walk {
  readonly boxes: Mp4Box[] = [];
  readonly tracks: Track[] = [];
  readonly mdats: Mp4Range[] = [];
  fragmented = false;
  hasMoov = false;
  invalid = false;
  /** End of the last top-level box. */
  tail = 0;

  constructor(
    private readonly b: Uint8Array,
    private readonly dv: DataView,
  ) {}

  private byte(p: number): number {
    return this.b[p] ?? 0;
  }

  private u32(p: number): number {
    return this.dv.getUint32(p);
  }

  walk(start: number, end: number, depth: number, track: Track | null): number {
    let p = start;
    while (p + 8 <= end && this.boxes.length < MAX_BOXES) {
      let size = this.u32(p);
      const type = String.fromCharCode(
        this.byte(p + 4),
        this.byte(p + 5),
        this.byte(p + 6),
        this.byte(p + 7),
      );
      let header = 8;
      if (size === 1) {
        if (p + 16 > end) break;
        const big = this.dv.getBigUint64(p + 8);
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) break;
        size = Number(big);
        header = 16;
      } else if (size === 0) {
        size = end - p;
      }
      if (size < header) break;
      const boxEnd = Math.min(p + size, end);
      this.boxes.push({ type, start: p, size: boxEnd - p });
      const body = p + header;
      if (depth === 0 && type === 'moov') this.hasMoov = true;
      if (depth === 0 && (type === 'moof' || type === 'mfra')) this.fragmented = true;
      if (depth === 0 && type === 'mdat') this.mdats.push({ start: body, end: boxEnd });
      if (type === 'trak' && depth < MAX_DEPTH) {
        const t: Track = { stco: null, stsc: null, sizes: null, constSize: 0, count: 0 };
        this.tracks.push(t);
        this.walk(body, boxEnd, depth + 1, t);
      } else if (CONTAINERS.has(type) && depth < MAX_DEPTH) {
        this.walk(body, boxEnd, depth + 1, track);
      } else if (track) {
        this.table(type, body, boxEnd, track);
      }
      p = boxEnd;
      if (depth === 0) this.tail = boxEnd;
    }
    return p;
  }

  private table(type: string, s: number, e: number, t: Track): void {
    if (e - s < 8) return;
    const n = this.u32(s + 4);
    const p = s + 8;
    if (type === 'stco' || type === 'co64') {
      const w = type === 'stco' ? 4 : 8;
      if (n * w > e - p) {
        this.invalid = true;
        return;
      }
      const out: number[] = [];
      for (let i = 0; i < n; i++) {
        if (w === 4) out.push(this.u32(p + i * 4));
        else {
          const v = this.dv.getBigUint64(p + i * 8);
          if (v > BigInt(Number.MAX_SAFE_INTEGER)) {
            this.invalid = true;
            return;
          }
          out.push(Number(v));
        }
      }
      t.stco = out;
    } else if (type === 'stsc') {
      if (n * 12 > e - p) {
        this.invalid = true;
        return;
      }
      const out: { firstChunk: number; perChunk: number }[] = [];
      for (let i = 0; i < n; i++)
        out.push({ firstChunk: this.u32(p + i * 12), perChunk: this.u32(p + i * 12 + 4) });
      t.stsc = out;
    } else if (type === 'stsz') {
      if (e - s < 12) return;
      const constSize = this.u32(s + 4);
      const count = this.u32(s + 8);
      t.constSize = constSize;
      t.count = count;
      if (constSize === 0) {
        if (count * 4 > e - (s + 12)) {
          this.invalid = true;
          return;
        }
        const out: number[] = [];
        for (let i = 0; i < count; i++) out.push(this.u32(s + 12 + i * 4));
        t.sizes = out;
      } else t.sizes = [];
    } else if (type === 'stz2') {
      if (e - s < 12) return;
      const field = this.byte(s + 7);
      const count = this.u32(s + 8);
      const q = s + 12;
      if (![4, 8, 16].includes(field) || Math.ceil((count * field) / 8) > e - q) {
        this.invalid = true;
        return;
      }
      const out: number[] = [];
      for (let i = 0; i < count; i++) {
        if (field === 4) out.push((this.byte(q + (i >> 1)) >> (i & 1 ? 0 : 4)) & 15);
        else if (field === 8) out.push(this.byte(q + i));
        else out.push(this.dv.getUint16(q + i * 2));
      }
      t.constSize = 0;
      t.count = count;
      t.sizes = out;
    }
  }
}

/** The byte ranges one track's chunks occupy, or null when its tables do not add up. */
function trackRanges(t: Track): Mp4Range[] | null {
  if (!t.stco || !t.stsc || !t.sizes) return null;
  if (t.stsc.length === 0) return t.stco.length === 0 ? [] : null;
  const out: Mp4Range[] = [];
  let sample = 0;
  let entry = 0;
  for (let c = 0; c < t.stco.length; c++) {
    while (entry + 1 < t.stsc.length && (t.stsc[entry + 1]?.firstChunk ?? Infinity) <= c + 1)
      entry++;
    const first = t.stsc[entry];
    const per = first && first.firstChunk <= c + 1 ? first.perChunk : 0;
    const start = t.stco[c] ?? 0;
    let bytes = 0;
    if (t.constSize !== 0) bytes = per * t.constSize;
    else {
      if (sample + per > t.sizes.length) return null;
      for (let i = 0; i < per; i++) bytes += t.sizes[sample + i] ?? 0;
    }
    sample += per;
    if (bytes > 0) out.push({ start, end: start + bytes });
  }
  return out;
}

function merge(ranges: Mp4Range[]): Mp4Range[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Mp4Range[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push({ start: r.start, end: r.end });
  }
  return out;
}

/** The parts of [start, end) not covered by the merged `covered` ranges. */
function gaps(start: number, end: number, covered: Mp4Range[]): Mp4Range[] {
  const out: Mp4Range[] = [];
  let at = start;
  for (const r of covered) {
    if (r.end <= at) continue;
    if (r.start >= end) break;
    if (r.start > at) out.push({ start: at, end: r.start });
    at = Math.max(at, r.end);
  }
  if (at < end) out.push({ start: at, end });
  return out;
}

export function parseMp4(bytes: Uint8Array): Mp4Parse | null {
  if (bytes.length < 8) return null;
  const w = new Walk(bytes, new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  w.walk(0, bytes.length, 0, null);
  if (!w.hasMoov || w.fragmented || w.invalid || w.tracks.length === 0) return null;

  const all: Mp4Range[] = [];
  for (const t of w.tracks) {
    const r = trackRanges(t);
    if (!r) return null;
    all.push(...r);
  }
  const referenced = merge(
    all
      .map((r) => ({ start: r.start, end: Math.min(r.end, bytes.length) }))
      .filter((r) => r.start < r.end),
  );

  const unreferenced: Mp4Range[] = [];
  for (const m of w.mdats) unreferenced.push(...gaps(m.start, m.end, referenced));
  if (w.tail < bytes.length) unreferenced.push({ start: w.tail, end: bytes.length });

  const firstMdat = w.mdats[0];
  const lastMdat = w.mdats[w.mdats.length - 1];
  const mdat = firstMdat && lastMdat ? { start: firstMdat.start, end: lastMdat.end } : null;
  return { boxes: w.boxes, mdat, referencedRanges: referenced, unreferenced };
}
