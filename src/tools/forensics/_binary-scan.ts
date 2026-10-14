/**
 * Whole-file scans for the Binary analyzer, done window by window (see _binary-stream):
 * embedded files (the signature database, its valid / end hooks and Carve's rules, with a
 * faster two-byte-anchored scanner), per-block entropy, flag-like text, readable strings
 * (Strings' findStrings on pre-selected ranges), byte search and hashes.
 */
import { createMD5, createSHA256, type IHasher } from 'hash-wasm';
import { DEFAULT_FLAG_PATTERN, KNOWN_PREFIX, gluedPrefixLength } from '../../core/flags';
import type { LazyFile } from '../../core/types';
import { latin1Decode } from '../../lib/bytes';
import { matchesAt, SIGNATURES, type Signature } from '../../lib/signatures';
import { readRange, windows, type Window } from './_binary-stream';
import { isCarvable, strength } from './carve';
import { edges, shannon, type EntropyBlock } from './entropy';
import { findStrings, type FoundString } from './strings';

// ---------------------------------------------------------------- carving

/** Look-ahead of each window: enough for every `valid` hook (ISO reads 32 KiB past the start). */
export const SCAN_OVERLAP = 64 << 10;
/** A walk that stops this close to the end of the data probably ran out of data. */
const MARGIN = 4096;
/** Bigger reads used to find the end of a file that does not fit in its window. */
const RESOLVE_STEPS = [16 << 20, 64 << 20];
const RESOLVE_BUDGET = 256 << 20;
/** Bigger reads at most per run (a crafted file can hold thousands of unfinished headers). */
const RESOLVE_READS = 64;
const MAX_HITS = 100_000;
export const MAX_FOUND = 1000;

/** Hooks that compute the end from header fields alone: the window never changes the answer. */
const SIZE_BASED = new Set([
  'bmp',
  'webp',
  'wav',
  'avi',
  '7z',
  'cab',
  'dex',
  'regf',
  'iso',
  'ntfs',
  'aiff',
  'sqlite',
  'mkv',
  'elf',
  'pe',
]);

/** A filesystem image at offset 0 holds files: carving must look inside it, not skip it. */
const TRANSPARENT = new Set(['iso', 'ntfs', 'ext', 'fat', 'vmdk', 'qcow', 'vhdx']);

export type EndKind = 'structure' | 'truncated' | 'next' | 'eof' | 'tooBig';

export interface Carved {
  start: number;
  /** Exclusive, never past the end of the file. */
  end: number;
  sig: Signature;
  kind: EndKind;
  /** The end comes from the file's own structure. */
  exact: boolean;
}

export interface CarveSettings {
  container: boolean;
  nested: boolean;
  only: Set<string>;
}

export interface CarveResult {
  found: Carved[];
  nestedSkipped: number;
  /** With nested matches on: local headers of a ZIP's own entries, not listed as archives. */
  zipEntries: number;
  container: Carved | null;
  capped: boolean;
}

/** Hits to drop before the layout, e.g. the echo of a volume descriptor in raw CD sectors. */
export type IgnoreHit = (start: number, sig: Signature) => boolean;

interface RawHit {
  start: number;
  sig: Signature;
  end: number | null;
  settled: boolean;
  tooBig?: boolean;
}

const GZIP = SIGNATURES.find((s) => s.id === 'gzip')!;

// ---- fast scanner

interface Anchor {
  sig: Signature;
  /** Index inside `magic` of the first byte of the two-byte anchor. */
  k: number;
}

/** Two consecutive fixed magic bytes, preferring ones that are not 0x00 / 0xFF. */
function pairIndex(sig: Signature): number {
  let best = -1;
  let bestScore = -1;
  for (let k = 0; k + 1 < sig.magic.length; k++) {
    const a = sig.magic[k];
    const b = sig.magic[k + 1];
    if (a === null || a === undefined || b === null || b === undefined) continue;
    const score = Number(a !== 0 && a !== 0xff) + Number(b !== 0 && b !== 0xff);
    if (score > bestScore) {
      best = k;
      bestScore = score;
    }
  }
  return best;
}

interface ScanTable {
  mask: Uint8Array;
  pairs: (Anchor[] | undefined)[];
  /** Signatures without two consecutive fixed bytes, anchored on one byte. */
  singles: (Anchor[] | undefined)[];
  hasSingles: boolean;
}

function buildScanTable(sigs: Signature[]): ScanTable {
  const t: ScanTable = {
    mask: new Uint8Array(65536),
    pairs: new Array<Anchor[] | undefined>(65536).fill(undefined),
    singles: new Array<Anchor[] | undefined>(256).fill(undefined),
    hasSingles: false,
  };
  for (const sig of sigs) {
    const k = pairIndex(sig);
    if (k >= 0) {
      const key = sig.magic[k]! | (sig.magic[k + 1]! << 8);
      (t.pairs[key] ??= []).push({ sig, k });
      t.mask[key] = 1;
      continue;
    }
    const one = sig.magic.findIndex((m) => m !== null);
    if (one < 0) continue;
    (t.singles[sig.magic[one]!] ??= []).push({ sig, k: one });
    t.hasSingles = true;
  }
  return t;
}

const tables = new Map<string, ScanTable>();
function tableFor(only: Set<string>): ScanTable {
  const key = [...only].sort().join(',');
  let t = tables.get(key);
  if (!t) {
    t = buildScanTable(
      SIGNATURES.filter(
        (s) => isCarvable(s) && (only.size === 0 || only.has(s.id) || only.has(s.ext)),
      ),
    );
    tables.set(key, t);
  }
  return t;
}

type Best = Map<number, { start: number; sig: Signature }>;

function consider(
  b: Uint8Array,
  i: number,
  list: Anchor[],
  lo: number,
  hi: number,
  best: Best,
): void {
  for (const { sig, k } of list) {
    const start = i - k - (sig.offset ?? 0);
    if (start < lo || start >= hi || !matchesAt(b, sig, start)) continue;
    if (sig.valid && !sig.valid(b, start)) continue;
    const prev = best.get(start);
    if (!prev || strength(sig) > strength(prev.sig)) best.set(start, { start, sig });
  }
}

/**
 * Same answer as Carve's scan() — every start where a carvable signature matches and passes
 * its `valid` check, the strongest one per start — restricted to starts in [lo, hi), but
 * anchored on two bytes instead of one: several times faster on big files.
 */
export function fastScan(
  b: Uint8Array,
  only: Set<string> = new Set(),
  lo = 0,
  hi = b.length,
): { start: number; sig: Signature }[] {
  const t = tableFor(only);
  const best: Best = new Map();
  const mask = t.mask;
  const pairs = t.pairs;
  const n = b.length - 1;
  const from = Math.max(0, lo);
  let prev = b[from] ?? 0;
  // No closure in this loop: captured variables would make every byte load slower.
  for (let i = from; i < n; i++) {
    const cur = b[i + 1]!;
    const key = prev | (cur << 8);
    prev = cur;
    if (mask[key] !== 0) consider(b, i, pairs[key]!, lo, hi, best);
  }
  if (t.hasSingles) {
    for (let i = from; i < b.length; i++) {
      const list = t.singles[b[i]!];
      if (list !== undefined) consider(b, i, list, lo, hi, best);
    }
  }
  return [...best.values()].sort((x, y) => x.start - y.start);
}

/** The fixed part of a gzip header, as the gzip `valid` hook checks it before inflating. */
function gzipHeaderSane(b: Uint8Array, s: number): boolean {
  if (s + 18 > b.length || b[s] !== 0x1f || b[s + 1] !== 0x8b || b[s + 2] !== 8) return false;
  const flg = b[s + 3]!;
  const xfl = b[s + 8]!;
  const os = b[s + 9]!;
  return !(flg & 0xe0) && (xfl === 0 || xfl === 2 || xfl === 4) && (os <= 13 || os === 255);
}

/** Collects signature hits window by window, then works out where each file ends. */
export class CarveCollector {
  private readonly hits: RawHit[] = [];
  private readonly pendingGzip: number[] = [];
  private capped = false;
  private readonly gzipWanted: boolean;

  constructor(
    private readonly file: LazyFile,
    private readonly only: Set<string> = new Set(),
    private readonly ignore: IgnoreHit = () => false,
  ) {
    this.gzipWanted = only.size === 0 || only.has('gzip') || only.has('gz');
  }

  onWindow(w: Window): void {
    if (this.hits.length >= MAX_HITS) {
      this.capped = true;
      return;
    }
    const starts = new Set<number>();
    for (const h of fastScan(w.bytes, this.only, w.ownStart, w.ownEnd)) {
      starts.add(h.start);
      this.add(w, h.start, h.sig);
    }
    // A gzip member longer than the look-ahead fails its (full-inflate) check inside the
    // window: keep the candidates whose header is sane and check them with a bigger read.
    if (this.gzipWanted && !w.atEof) {
      for (let i = w.bytes.indexOf(0x1f, w.ownStart); i >= 0 && i < w.ownEnd;) {
        if (!starts.has(i) && gzipHeaderSane(w.bytes, i)) this.pendingGzip.push(w.offset + i);
        i = w.bytes.indexOf(0x1f, i + 1);
      }
    }
  }

  private add(w: Window, rel: number, sig: Signature): void {
    if (this.ignore(w.offset + rel, sig)) return;
    const end = sig.end ? sig.end(w.bytes, rel) : null;
    const settled =
      !sig.end ||
      SIZE_BASED.has(sig.id) ||
      w.atEof ||
      (end !== null && end <= w.bytes.length - MARGIN);
    this.hits.push({
      start: w.offset + rel,
      sig,
      end: end === null ? null : w.offset + end,
      settled,
    });
  }

  /** Resolve ends that need more data than one window, then lay the files out. */
  async finish(settings: CarveSettings): Promise<CarveResult> {
    const size = this.file.size;
    let budget = RESOLVE_BUDGET;
    let reads = 0;
    // The last bigger read: hits are in file order, so the next ones often fall inside it.
    let cache: { start: number; buf: Uint8Array } | null = null;
    /** A buffer with `step` bytes from `start` (or all up to the end), and where `start` is in it. */
    const view = async (start: number, step: number) => {
      if (cache && start >= cache.start) {
        const have = cache.start + cache.buf.length;
        if (have >= size || have - start >= step)
          return { buf: cache.buf, rel: start - cache.start };
      }
      if (budget <= 0 || reads >= RESOLVE_READS) return null;
      const buf = await readRange(this.file, start, step);
      budget -= buf.length;
      reads++;
      cache = { start, buf };
      return { buf, rel: 0 };
    };
    for (const start of this.pendingGzip) {
      for (const step of RESOLVE_STEPS) {
        const v = await view(start, step);
        if (!v) break;
        if (GZIP.valid!(v.buf, v.rel)) {
          const end = GZIP.end!(v.buf, v.rel);
          this.hits.push({
            start,
            sig: GZIP,
            end: end === null ? null : start + end - v.rel,
            settled: true,
          });
          break;
        }
        if (start + v.buf.length - v.rel >= size) break;
      }
    }
    for (const h of this.hits) {
      if (h.settled) continue;
      h.settled = true;
      h.end = null;
      h.tooBig = true;
      for (const step of RESOLVE_STEPS) {
        const v = await view(h.start, step);
        if (!v) break;
        const end = h.sig.end!(v.buf, v.rel);
        const avail = v.buf.length - v.rel;
        if (h.start + avail >= size || (end !== null && end - v.rel <= avail - MARGIN)) {
          h.end = end === null ? null : h.start + end - v.rel;
          h.tooBig = false;
          break;
        }
      }
    }
    cache = null;
    return layOut(this.hits, size, settings, this.capped);
  }
}

/** Carve's rules: nested matches are skipped, unknown ends stop at the next signature. */
function layOut(
  hits: RawHit[],
  size: number,
  settings: CarveSettings,
  capped: boolean,
): CarveResult {
  hits.sort((a, b) => a.start - b.start);
  const found: Carved[] = [];
  let covered = 0;
  // The file whose exact end set `covered`.
  let cover: { sig: Signature; end: number } | null = null;
  let nestedSkipped = 0;
  let zipEntries = 0;
  let container: Carved | null = null;
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i]!;
    if (i > 0 && hits[i - 1]!.start === h.start) continue;
    const inside = h.start < covered;
    // The local header of a later entry of the same ZIP walks to the same end of central
    // directory: it is a member of that archive, not another archive.
    if (inside && h.sig.id === 'zip' && cover?.sig.id === 'zip' && h.end === cover.end) {
      if (settings.nested) zipEntries++;
      else nestedSkipped++;
      continue;
    }
    if (inside && !settings.nested) {
      nestedSkipped++;
      continue;
    }
    let end = h.end !== null && h.end > h.start ? h.end : null;
    let kind: EndKind = 'structure';
    const exact = end !== null;
    if (end !== null && end > size) {
      end = size;
      kind = 'truncated';
    }
    if (end === null) {
      let j = i + 1;
      while (j < hits.length && hits[j]!.start <= h.start) j++;
      const next = hits[j];
      end = next ? next.start : size;
      kind = h.tooBig ? 'tooBig' : next ? 'next' : 'eof';
    }
    const item: Carved = { start: h.start, end, sig: h.sig, kind, exact };
    const covers = exact && !inside && !(h.start === 0 && TRANSPARENT.has(h.sig.id));
    if (covers && end > covered) {
      covered = end;
      cover = { sig: h.sig, end: h.end! };
    }
    if (h.start === 0 && !inside) {
      container = item;
      if (!settings.container) continue;
    }
    if (found.length >= MAX_FOUND) {
      capped = true;
      break;
    }
    found.push(item);
  }
  return { found, nestedSkipped, zipEntries, container, capped };
}

/** Stand-alone carving pass over the whole file. */
export async function carveFile(
  file: LazyFile,
  settings: CarveSettings,
  chunk?: number,
  ignore?: IgnoreHit,
): Promise<CarveResult> {
  const c = new CarveCollector(file, settings.only, ignore);
  for await (const w of windows(file, { chunk, overlap: SCAN_OVERLAP })) c.onWindow(w);
  return c.finish(settings);
}

/** Signatures the "Only these types" option accepts (id or extension). */
export const knownTypes = (): Set<string> =>
  new Set(SIGNATURES.flatMap((s) => [s.id, s.ext.toLowerCase()]));

// ---------------------------------------------------------------- entropy

export const MAX_BLOCKS = 50_000;

/** Per-block Shannon entropy and the byte histogram, fed with consecutive owned bytes. */
export class EntropyCollector {
  readonly blocks: EntropyBlock[] = [];
  readonly counts = new Uint32Array(256);
  private readonly edges: number[];
  private readonly cur = new Uint32Array(256);
  private index = 0;
  private pos = 0;

  constructor(
    readonly size: number,
    readonly block: number,
  ) {
    this.edges = size > 0 ? edges(size, block) : [0];
  }

  /** Bytes [from, to) of `bytes`, which continue the file exactly where the last call stopped. */
  add(bytes: Uint8Array, from: number, to: number): void {
    const cur = this.cur;
    let i = from;
    while (i < to && this.index + 1 < this.edges.length) {
      const blockEnd = this.edges[this.index + 1]!;
      const n = Math.min(to - i, blockEnd - this.pos);
      for (let k = i; k < i + n; k++) cur[bytes[k]!]!++;
      i += n;
      this.pos += n;
      if (this.pos === blockEnd) {
        const start = this.edges[this.index]!;
        this.blocks.push({ start, end: blockEnd, entropy: shannon(cur, blockEnd - start) });
        for (let v = 0; v < 256; v++) this.counts[v]! += cur[v]!;
        cur.fill(0);
        this.index++;
      }
    }
  }

  get overall(): number {
    return shannon(this.counts, this.size);
  }
}

// ---------------------------------------------------------------- flag-like text

export type TextEncoding = 'ascii' | 'utf16le' | 'utf16be';

export interface FlagHit {
  offset: number;
  encoding: TextEncoding;
  text: string;
}

const FLAG_RE = new RegExp(DEFAULT_FLAG_PATTERN);
const isWordByte = (c: number) =>
  (c >= 0x30 && c <= 0x39) ||
  (c >= 0x41 && c <= 0x5a) ||
  (c >= 0x61 && c <= 0x7a) ||
  c === 0x5f ||
  c === 0x2d;
const isLetterByte = (c: number) => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
/** Printable, no space, no brace: what DEFAULT_FLAG_PATTERN allows inside the braces. */
const isBodyByte = (c: number) => c > 0x20 && c < 0x7f && c !== 0x7b && c !== 0x7d;
export const FLAG_LOOKBEHIND = 64;

/**
 * Random bytes match prefix{body} about once every 10 MB ("jm{*d}"), and a 3-character prefix
 * with a 4-character body still once per few hundred MB ("sQr{%=i~}" in 200 MB of noise).
 * Beyond the known prefixes (flag, CTF, HTB…), ask for a 3-character prefix and an 8-character
 * body: each extra body character is printable with odds 94/256, so that is ~50× rarer.
 */
export function plausibleFlag(text: string): boolean {
  if (KNOWN_PREFIX.test(text)) return true;
  const brace = text.indexOf('{');
  return brace >= 3 && text.length - brace - 2 >= 8;
}

/**
 * prefix{body} around each "{" of `b` (ASCII, UTF-16LE and UTF-16BE), like DEFAULT_FLAG_PATTERN.
 * Only "{" in [from, to) count; the caller provides FLAG_LOOKBEHIND bytes before and ~512 after.
 */
export function findFlagsIn(
  b: Uint8Array,
  from: number,
  to: number,
  base: number,
  out: FlagHit[],
  max: number,
): void {
  // Each character is addressed by its low byte; UTF-16 wants the other byte to be zero.
  const variants: [TextEncoding, number, (q: number) => boolean, number][] = [
    ['ascii', 1, () => true, 0],
    ['utf16le', 2, (q) => b[q + 1] === 0, 0],
    ['utf16be', 2, (q) => b[q - 1] === 0, 1],
  ];
  for (let i = b.indexOf(0x7b, from); i >= 0 && i < to; i = b.indexOf(0x7b, i + 1)) {
    // The same bytes can read as more than one encoding: keep the longest reading.
    let best: FlagHit | null = null;
    for (const [encoding, step, zero, shift] of variants) {
      if (!zero(i)) continue;
      let s = i;
      for (let n = 0; n < 25 && s - step >= 0; n++) {
        const q = s - step;
        if (!isWordByte(b[q]!) || !zero(q)) break;
        s = q;
      }
      while (s < i && !isLetterByte(b[s]!)) s += step;
      if ((i - s) / step < 2) continue;
      let e = i + step;
      let m = 0;
      while (m <= 200 && e < b.length && isBodyByte(b[e]!) && zero(e)) {
        e += step;
        m++;
      }
      if (e >= b.length || b[e] !== 0x7d || !zero(e) || m < 2 || m > 200) continue;
      let text = '';
      for (let k = s; k <= e; k += step) text += String.fromCharCode(b[k]!);
      const glued = gluedPrefixLength(text); // "Fflag{…}": a printable byte before the flag
      text = text.slice(glued);
      s += glued * step;
      if (FLAG_RE.test(text) && plausibleFlag(text) && (!best || text.length > best.text.length)) {
        best = { offset: base + s - shift, encoding, text };
      }
    }
    if (!best || out.some((f) => f.offset === best.offset)) continue;
    out.push(best);
    if (out.length >= max) return;
  }
}

// ---------------------------------------------------------------- hashes

export class Hashes {
  private constructor(private readonly hashers: [string, IHasher][]) {}

  static async create(): Promise<Hashes> {
    const list: [string, IHasher][] = [
      ['MD5', await createMD5()],
      ['SHA-256', await createSHA256()],
    ];
    for (const [, h] of list) h.init();
    return new Hashes(list);
  }

  update(b: Uint8Array): void {
    for (const [, h] of this.hashers) h.update(b);
  }

  digests(): [string, string][] {
    return this.hashers.map(([name, h]) => [name, h.digest('hex')]);
  }
}

// ---------------------------------------------------------------- strings

const STRINGS_OVERLAP = 64 << 10;

/** Printable ASCII and tab: the byte test of strings.ts. */
const PRINT = (() => {
  const t = new Uint8Array(256);
  for (let c = 0x20; c < 0x7f; c++) t[c] = 1;
  t[9] = 1;
  return t;
})();

function asciiRuns(b: Uint8Array, min: number, runs: [number, number][]): void {
  const n = b.length;
  const P = PRINT;
  // Any run of `min` characters contains one of every `min`-th position: test only those, then
  // grow the run both ways. Random data mostly fails the first test, cheaply.
  for (let j = min - 1; j < n;) {
    if (P[b[j]!] === 0) {
      j += min;
      continue;
    }
    let s = j;
    while (s > 0 && P[b[s - 1]!] === 1) s--;
    let e = j + 1;
    while (e < n && P[b[e]!] === 1) e++;
    if (e - s >= min) runs.push([s, e]);
    j = e + min;
  }
}

/** Is there a UTF-16 character (printable byte + zero byte) at i? `lo` = 0 for LE, 1 for BE. */
function u16At(b: Uint8Array, i: number, lo: number): boolean {
  return i >= 0 && i + 1 < b.length && PRINT[b[i + lo]!] === 1 && b[i + 1 - lo] === 0;
}

function utf16Runs(b: Uint8Array, min: number, lo: number, runs: [number, number][]): void {
  const n = b.length;
  for (let parity = 0; parity < 2; parity++) {
    for (let j = parity + 2 * (min - 1); j + 1 < n;) {
      if (!u16At(b, j, lo)) {
        j += 2 * min;
        continue;
      }
      let s = j;
      while (u16At(b, s - 2, lo)) s -= 2;
      let e = j + 2;
      while (u16At(b, e, lo)) e += 2;
      if (e - s >= 2 * min) runs.push([s, e]);
      j = e + 2 * min;
    }
  }
}

/**
 * Byte ranges that hold every run long enough to be a string (ASCII, or UTF-16 in either byte
 * order and alignment), merged when they touch. A cheap pass over the window; Strings'
 * findStrings() then runs on these ranges only, which gives exactly its whole-buffer answer.
 */
export function stringRegions(b: Uint8Array, min: number): [number, number][] {
  const runs: [number, number][] = [];
  asciiRuns(b, min, runs);
  utf16Runs(b, min, 0, runs);
  utf16Runs(b, min, 1, runs);
  runs.sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const r of runs) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

/** findStrings() of the whole buffer, computed on the candidate regions only. */
export function findStringsFast(b: Uint8Array, min: number): FoundString[] {
  const out: FoundString[] = [];
  for (const [s, e] of stringRegions(b, min)) {
    for (const f of findStrings(b.subarray(s, e), min))
      out.push({ ...f, offset: f.offset + s, end: f.end + s });
  }
  return out;
}

export interface StringsResult {
  /** Flag-like strings, all of them (up to the cap), in file order. */
  flagged: FoundString[];
  /** The other strings, in file order, up to `max`. */
  rest: FoundString[];
  total: number;
  matched: number;
}

/**
 * ASCII + UTF-16 strings of the whole file. A string that straddles two windows is reported
 * once, from the window where it starts; the next window skips its continuation.
 */
export async function stringsFile(
  file: LazyFile,
  min: number,
  filter: ((s: string) => boolean) | null,
  max: number,
  chunk?: number,
): Promise<StringsResult> {
  const res: StringsResult = { flagged: [], rest: [], total: 0, matched: 0 };
  let lastEnd = 0;
  for await (const w of windows(file, { chunk, overlap: STRINGS_OVERLAP })) {
    for (const found of findStringsFast(w.bytes, min)) {
      const f = preferLittleEndian(w.bytes, found);
      const offset = w.offset + f.offset;
      const end = w.offset + f.end;
      if (offset < lastEnd) {
        lastEnd = Math.max(lastEnd, end);
        continue;
      }
      if (f.offset >= w.ownEnd) break;
      lastEnd = end;
      res.total++;
      if (filter && !filter(f.text)) continue;
      res.matched++;
      const flag = FLAG_RE.exec(f.text);
      const item = { ...f, offset, end, text: keepText(f.text, flag) };
      if (flag) {
        if (res.flagged.length < max) res.flagged.push(item);
      } else if (res.rest.length < max) res.rest.push(item);
    }
  }
  return res;
}

/**
 * "00 66 00 6c … 00 67 00" reads as UTF-16BE from the first zero and as UTF-16LE from the byte
 * after, with the same text. UTF-16LE is by far the usual one (Windows, .NET, PE resources):
 * keep that reading, which is also what the search reports.
 */
export function preferLittleEndian(b: Uint8Array, f: FoundString): FoundString {
  if (f.encoding !== 'utf16be' || f.end >= b.length || b[f.end] !== 0) return f;
  return { ...f, offset: f.offset + 1, end: f.end + 1, encoding: 'utf16le' };
}

/** Text kept per string: the table shows 400 characters, the text block a bounded total. */
export const STRING_KEEP = 2000;

/** A long string cut to STRING_KEEP characters, around its flag-like part when it has one. */
function keepText(text: string, flag: RegExpExecArray | null): string {
  if (text.length <= STRING_KEEP) return text;
  if (!flag || flag.index + flag[0].length <= STRING_KEEP - 1) {
    return `${text.slice(0, STRING_KEEP - 1)}…`;
  }
  const from = Math.max(0, flag.index - 200);
  const to = Math.min(text.length, from + STRING_KEEP - 2);
  return `…${text.slice(from, to)}${to < text.length ? '…' : ''}`;
}

// ---------------------------------------------------------------- search

export interface SearchHit {
  offset: number;
  length: number;
  encoding: string;
  context: Uint8Array;
}

export type SearchQuery =
  | { kind: 'bytes'; needles: { bytes: Uint8Array; encoding: string }[] }
  | { kind: 'regex'; re: RegExp };

const CONTEXT = 24;
/** Longest regular-expression match that is guaranteed to be seen across a window edge. */
export const REGEX_SPAN = 4096;

export async function searchFile(
  file: LazyFile,
  q: SearchQuery,
  max: number,
  chunk?: number,
): Promise<{ hits: SearchHit[]; capped: boolean }> {
  const hits: SearchHit[] = [];
  const longest =
    q.kind === 'bytes' ? Math.max(1, ...q.needles.map((n) => n.bytes.length)) : REGEX_SPAN;
  const overlap = longest + CONTEXT;
  let capped = false;
  const push = (w: Window, i: number, length: number, encoding: string) => {
    if (hits.length >= max) {
      capped = true;
      return false;
    }
    hits.push({
      offset: w.offset + i,
      length,
      encoding,
      context: w.bytes.slice(i, i + Math.max(CONTEXT, Math.min(length, 64))),
    });
    return true;
  };
  for await (const w of windows(file, { chunk, overlap })) {
    const before = hits.length;
    if (q.kind === 'bytes') {
      for (const n of q.needles) {
        const first = n.bytes[0]!;
        for (let i = w.bytes.indexOf(first, w.ownStart); i >= 0 && i < w.ownEnd;) {
          let k = 1;
          while (k < n.bytes.length && w.bytes[i + k] === n.bytes[k]) k++;
          if (k === n.bytes.length && !push(w, i, n.bytes.length, n.encoding)) break;
          i = w.bytes.indexOf(first, i + 1);
        }
      }
    } else {
      const re = new RegExp(q.re.source, q.re.flags.includes('g') ? q.re.flags : `${q.re.flags}g`);
      const text = latin1Decode(w.bytes);
      re.lastIndex = w.ownStart;
      for (let m = re.exec(text); m && m.index < w.ownEnd; m = re.exec(text)) {
        if (m[0].length === 0) {
          re.lastIndex++;
          continue;
        }
        if (!push(w, m.index, m[0].length, 'regex')) break;
      }
    }
    if (hits.length > before) {
      const added = hits.splice(before).sort((a, b) => a.offset - b.offset);
      hits.push(...added);
    }
    if (capped) break;
  }
  return { hits, capped };
}
