/**
 * PNG chunk surgeon, analysis side (no UI text): parse every chunk tolerantly, read the text
 * chunks, decide the IDAT order (typed, hinted, file order, or searched), repair the
 * signature, CRCs, zlib header, Adler-32 and IHDR, rebuild a valid PNG and decode it.
 */
import { zlibSync } from 'fflate';
import { decodeImageExact } from '../../core/decode-image';
import type { RgbaImage } from '../../core/types';
import { concatBytes, latin1Decode, latin1Encode, utf8Decode } from '../../lib/bytes';
import {
  bruteForceIhdr,
  type Ihdr,
  ihdrCrc,
  type IhdrRepair,
  inflateCapped,
  PNG_SIGNATURE,
  readIhdr,
} from './_png';
import {
  applyReading,
  findHints,
  type HintMiss,
  type HintSource,
  isListOrder,
  isProblem,
  numbersIn,
  type Reading,
  type SearchResult,
  searchOrder,
  type SequenceProblem,
  toPermutation,
} from './_png-surgeon-order';
import {
  chunkCrc,
  parseTolerant,
  type SurgeonChunk,
  type SurgeonParse,
} from './_png-surgeon-parse';
import { splitTail, type TailPart } from './_png-surgeon-tail';
import {
  checkStream,
  fitSize,
  headerCandidates,
  headerOk,
  heightForSize,
  type Layout,
  layoutOf,
  type StreamFailure,
  type StreamResult,
} from './_png-surgeon-zlib';

export interface SurgeryOptions {
  order: string;
  reading: 'auto' | Reading;
  search: boolean;
  fixCrc: boolean;
  fixSignature: boolean;
  fixZlib: boolean;
  fixIhdr: boolean;
  width: number;
  height: number;
  singleIdat: boolean;
}

export const DEFAULT_OPTIONS: SurgeryOptions = {
  order: '',
  reading: 'auto',
  search: true,
  fixCrc: true,
  fixSignature: true,
  fixZlib: true,
  fixIhdr: true,
  width: 0,
  height: 0,
  singleIdat: false,
};

/** The automatic order search only runs up to this many IDAT chunks. */
export const SEARCH_MAX_CHUNKS = 12;
const SEARCH_TRIES = 6000;
/** Stop the search after inflating this much in total (keeps big images responsive). */
const SEARCH_BYTES = 768 << 20;

export interface TextInfo {
  /** Index of the chunk in the parse. */
  chunk: number;
  type: 'tEXt' | 'zTXt' | 'iTXt';
  keyword: string;
  text: string;
  compressed: boolean;
  language?: string;
  translated?: string;
  /** The compressed text could not be inflated completely. */
  broken: boolean;
  /** No NUL separator: the whole chunk is shown as text. */
  noKeyword: boolean;
}

export interface HeaderFix {
  mode: 'replace' | 'prepend';
  from: [number, number];
  to: [number, number];
}

export interface Attempt {
  /** manual: typed in Order · list: "#3 #1 …" (the reorder list) · hint: from a text chunk. */
  source: 'manual' | 'list' | 'hint' | 'file' | 'search';
  reading: Reading | null;
  /** Index in Surgery.hints of the hint this order comes from. */
  hint?: number;
  /** File indices (0-based, among the IDATs) in the order tried. */
  order: number[];
  result: StreamResult;
  header: HeaderFix | null;
  /** The other reading gives the very same order. */
  bothSame?: boolean;
  /**
   * The rows do not fit the IHDR size, yet the whole stream inflates and its Adler-32 matches:
   * the order is right and the size is wrong.
   */
  streamOk?: boolean;
  /** With streamOk: the size the inflated data gives (one dimension changed), if any fits. */
  fitted?: Ihdr;
}

/** The stream inflates and its stored Adler-32 matches: this order is certainly right. */
export const adlerOk = (r: StreamResult) =>
  r.ok && r.adlerStored !== null && r.adlerStored === r.adlerComputed;

export interface Candidate extends IhdrRepair {
  fits: boolean;
}

export interface Surgery {
  /** The first 8 bytes of the file (where the signature should be). */
  head: Uint8Array;
  parse: SurgeonParse;
  ihdrChunk: SurgeonChunk | null;
  stored: Ihdr | null;
  /** IHDR used to check the stream (overrides and CRC brute force applied). */
  work: Ihdr | null;
  layout: Layout | null;
  /** IHDR written to the rebuilt PNG. */
  final: Ihdr | null;
  sizeHow: 'stored' | 'override' | 'crc' | 'data';
  candidates: Candidate[];
  idats: SurgeonChunk[];
  texts: TextInfo[];
  /** Every order hint found in the text chunks, best first. */
  hints: HintSource[];
  /** The hint the chosen order comes from, else the first one. */
  hint: HintSource | null;
  hintMisses: HintMiss[];
  sequenceProblem: SequenceProblem | null;
  manual: boolean;
  attempts: Attempt[];
  chosen: Attempt | null;
  /**
   * confirmed: the Adler-32 matches · only: it does not, but no other order inflates (the
   * checksum itself is damaged) · unconfirmed: it does not and the order may be wrong ·
   * ambiguous: stored (uncompressed) data where several orders match the Adler-32, or where
   * the search could not try them all (Adler-32 collides easily on reordered stored data).
   */
  certainty: 'confirmed' | 'only' | 'unconfirmed' | 'ambiguous' | null;
  /** The order is right (Adler-32) but no width or height makes the data fit: its size. */
  misfit: number | null;
  search: (SearchResult & { inflating: number }) | null;
  /** An order the search found while a typed order fails (offered, not applied). */
  proposal: number[] | null;
  adlerFixed: boolean;
  repairs: {
    signature: boolean;
    crc: number;
    lengths: number;
    types: number;
    dropped: SurgeonChunk[];
    moved: number;
    /** IDAT chunks found after IEND were put back before it. */
    iendMoved: boolean;
  };
  rebuilt: Uint8Array | null;
  image: RgbaImage | null;
  decodeError: string | null;
  partial: { image: RgbaImage; rows: number } | null;
  tail: { offset: number; data: Uint8Array; parts: TailPart[] } | null;
}

// ---------------------------------------------------------------- text chunks

function zeroAt(b: Uint8Array, from: number): number {
  for (let i = from; i < b.length; i++) if (b[i] === 0) return i;
  return -1;
}

export function decodeText(c: SurgeonChunk): TextInfo | null {
  const type = c.type;
  if (type !== 'tEXt' && type !== 'zTXt' && type !== 'iTXt') return null;
  const d = c.data;
  const base: Pick<TextInfo, 'chunk' | 'type' | 'broken' | 'noKeyword' | 'compressed'> = {
    chunk: c.index,
    type,
    broken: false,
    noKeyword: false,
    compressed: false,
  };
  const z = zeroAt(d, 0);
  if (z < 0) return { ...base, keyword: '', text: latin1Decode(d), noKeyword: true };
  if (type === 'tEXt') {
    return {
      ...base,
      keyword: latin1Decode(d.subarray(0, z)),
      text: latin1Decode(d.subarray(z + 1)),
    };
  }
  if (type === 'zTXt') {
    const inflated = inflateCapped(d.subarray(z + 2), 1 << 20);
    return {
      ...base,
      keyword: latin1Decode(d.subarray(0, z)),
      text: latin1Decode(inflated.data),
      compressed: true,
      broken: inflated.truncated,
    };
  }
  const compressed = d[z + 1] === 1;
  const langEnd = zeroAt(d, z + 3);
  const transEnd = langEnd < 0 ? -1 : zeroAt(d, langEnd + 1);
  if (transEnd < 0) {
    return {
      ...base,
      keyword: latin1Decode(d.subarray(0, z)),
      text: utf8Decode(d.subarray(z + 1)),
      broken: true,
    };
  }
  const body = d.subarray(transEnd + 1);
  const inflated = compressed ? inflateCapped(body, 1 << 20) : null;
  return {
    ...base,
    keyword: latin1Decode(d.subarray(0, z)),
    text: utf8Decode(inflated ? inflated.data : body),
    compressed,
    language: latin1Decode(d.subarray(z + 3, langEnd)) || undefined,
    translated: utf8Decode(d.subarray(langEnd + 1, transEnd)) || undefined,
    broken: inflated?.truncated ?? false,
  };
}

// ---------------------------------------------------------------- helpers

const be32 = (n: number) =>
  new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);

export function ihdrData(h: Ihdr): Uint8Array {
  const b = new Uint8Array(13);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, h.width);
  dv.setUint32(4, h.height);
  b[8] = h.bitDepth;
  b[9] = h.colorType;
  b[10] = h.compression;
  b[11] = h.filter;
  b[12] = h.interlace;
  return b;
}

function chunkBytes(type: string, data: Uint8Array, crc: number): Uint8Array {
  return concatBytes(be32(data.length), latin1Encode(type), data, be32(crc));
}

const IEND_CRC = 0xae426082;

/** Chunks a decoder needs before the image data. */
const BEFORE_IDAT = new Set([
  'PLTE',
  'tRNS',
  'gAMA',
  'cHRM',
  'sRGB',
  'iCCP',
  'sBIT',
  'bKGD',
  'hIST',
  'pHYs',
  'sPLT',
  'cICP',
  'mDCV',
  'cLLI',
  'acTL',
]);

/** Write the last 4 bytes of a split stream (the Adler-32), across pieces if needed. */
function patchTail(pieces: Uint8Array[], value: number): Uint8Array[] {
  const out = pieces.map((p) => p.slice());
  const bytes = [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
  let k = 3;
  for (let i = out.length - 1; i >= 0 && k >= 0; i--) {
    const p = out[i]!;
    for (let j = p.length - 1; j >= 0 && k >= 0; j--) p[j] = bytes[k--]!;
  }
  return out;
}

const sameOrder = (a: number[], b: number[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);
export const isIdentity = (order: number[]) => order.every((v, i) => v === i);

/** Failures that say the rows do not fit the IHDR (rather than that the stream is broken). */
const layoutFailure = (f: StreamFailure | null) =>
  f !== null &&
  (f.kind === 'filter' || f.kind === 'rows' || f.kind === 'overflow' || f.kind === 'short');

/** The size check of a whole stream without the IHDR stops (and captures) at 256 MiB. */
const RAW_CHECK = 256 << 20;

// ---------------------------------------------------------------- the operation

/** IDAT payloads in `order`, with the zlib header fix applied to the first one. */
export function piecesWith(
  datas: Uint8Array[],
  order: number[],
  header: HeaderFix | null,
): Uint8Array[] {
  const pieces = order.map((i) => datas[i]!);
  if (!header || !pieces.length) return pieces;
  const first = pieces[0]!;
  if (header.mode === 'prepend') pieces[0] = concatBytes(new Uint8Array(header.to), first);
  else {
    const fixed = first.slice();
    fixed[0] = header.to[0];
    fixed[1] = header.to[1];
    pieces[0] = fixed;
  }
  return pieces;
}

export function operate(bytes: Uint8Array, opts: SurgeryOptions): Surgery | null {
  const parse = parseTolerant(bytes);
  if (!parse) return null;
  const chunks = parse.chunks;
  const ihdrChunk = chunks.find((c) => c.type === 'IHDR' && c.validType && !c.afterIend) ?? null;
  const stored = ihdrChunk && ihdrChunk.length >= 13 ? readIhdr(bytes, ihdrChunk.dataStart) : null;
  const idats = chunks.filter((c) => c.type === 'IDAT');
  const datas = idats.map((c) => c.data);
  const n = idats.length;
  const texts = chunks.map(decodeText).filter((t): t is TextInfo => t !== null);

  // --- IHDR used to check the stream: overrides, else the best CRC candidate, else as stored.
  let candidates: Candidate[] = [];
  if (stored && ihdrChunk && ihdrChunk.length === 13 && !ihdrChunk.crcOk && opts.fixIhdr) {
    const rank = { height: 0, width: 1, fields: 2, both: 3 } as const;
    candidates = bruteForceIhdr(stored, ihdrChunk.crcStored ?? 0)
      .map((r) => ({ ...r, fits: false }))
      .sort((a, b) => rank[a.kind] - rank[b.kind]);
  }
  const overrides = opts.width > 0 || opts.height > 0;
  const withOverrides = (h: Ihdr): Ihdr => ({
    ...h,
    width: opts.width > 0 ? opts.width : h.width,
    height: opts.height > 0 ? opts.height : h.height,
  });
  let work = stored ? withOverrides(candidates[0]?.ihdr ?? stored) : null;
  let layout = work ? layoutOf(work) : null;
  if (!layout && stored && candidates.length) {
    // A CRC candidate with odd fields must not hide a usable stored header.
    work = withOverrides(stored);
    layout = layoutOf(work);
  }

  const tail =
    parse.tailStart !== null && parse.tailStart < bytes.length
      ? bytes.subarray(parse.tailStart)
      : null;
  const found = findHints(
    texts.map((t) => ({ keyword: t.keyword, text: t.text })),
    n,
  );
  const result: Surgery = {
    head: bytes.subarray(0, 8),
    parse,
    ihdrChunk,
    stored,
    work,
    layout,
    final: null,
    sizeHow: 'stored',
    candidates,
    idats,
    texts,
    hints: found.hints,
    hint: found.hints[0] ?? null,
    hintMisses: found.misses,
    sequenceProblem: null,
    manual: opts.order.trim() !== '',
    attempts: [],
    chosen: null,
    certainty: null,
    misfit: null,
    search: null,
    proposal: null,
    adlerFixed: false,
    repairs: {
      signature: false,
      crc: 0,
      lengths: 0,
      types: 0,
      dropped: [],
      moved: 0,
      iendMoved: false,
    },
    rebuilt: null,
    image: null,
    decodeError: null,
    partial: null,
    tail: tail ? { offset: parse.tailStart!, data: tail, parts: splitTail(tail) } : null,
  };
  if (!stored || !work || !layout || !n) return result;
  const lay = layout;
  const workIhdr = work;

  // --- checking an order (with the zlib header repaired when no IDAT has a valid one)
  const damagedHeader = !datas.some(headerOk);
  // Stored blocks (zlib level 0): every order inflates, and since the A half of the Adler-32
  // does not depend on the order, a wrong one matches it far more often than 1 in 2^32.
  const storedData = datas.some((d) => headerOk(d) && d.length > 2 && ((d[2]! >> 1) & 3) === 0);
  type Check = { capture?: number; layout?: Layout | null; maxBytes?: number; merge?: boolean };
  const tryOrder = (order: number[], final: boolean, extra: Check = {}) => {
    const first = datas[order[0]!]!;
    const check = (header: HeaderFix | null) =>
      checkStream(piecesWith(datas, order, header), {
        layout: extra.layout === undefined ? lay : extra.layout,
        final,
        capture: extra.capture,
        maxBytes: extra.maxBytes,
        merge: extra.merge,
      });
    if (!(opts.fixZlib && damagedHeader && first.length >= 2 && !headerOk(first))) {
      return { result: check(null), header: null };
    }
    const [cmf, flg] = headerCandidates(first[0]!, first[1]!)[0]!;
    const from: [number, number] = [first[0]!, first[1]!];
    const replace: HeaderFix = { mode: 'replace', from, to: [cmf, flg] };
    const a = check(replace);
    const brokeAtOnce = !a.ok && a.failure?.piece === 0 && a.failure.kind !== 'filter';
    if (!brokeAtOnce) return { result: a, header: replace };
    const prepend: HeaderFix = { mode: 'prepend', from, to: [0x78, 0x9c] };
    const b = check(prepend);
    return b.ok || b.goodBytes > a.goodBytes
      ? { result: b, header: prepend }
      : { result: a, header: replace };
  };
  const attempt = (
    source: Attempt['source'],
    reading: Reading | null,
    order: number[],
    hint?: number,
  ) => {
    const { result: r, header } = tryOrder(order, true);
    const a: Attempt = { source, reading, order, result: r, header };
    if (hint !== undefined) a.hint = hint;
    if (layoutFailure(r.failure)) {
      // The rows do not fit: if the whole stream still inflates with a matching Adler-32, the
      // order is right and the IHDR size is wrong (an edited width or height, CRC recomputed).
      const raw = tryOrder(order, true, { layout: null, capture: RAW_CHECK, maxBytes: RAW_CHECK });
      if (adlerOk(raw.result) && raw.result.data) {
        a.streamOk = true;
        const fit =
          overrides || !opts.fixIhdr
            ? null
            : (fitSize(workIhdr, raw.result.data) ??
              (workIhdr !== stored ? fitSize(stored, raw.result.data) : null));
        if (fit) {
          a.fitted = fit;
          a.result = { ...raw.result, data: null, goodBytes: raw.result.produced };
        } else {
          result.misfit = raw.result.produced;
        }
      }
    }
    result.attempts.push(a);
    return a;
  };
  const confirmed = (a: Attempt) => adlerOk(a.result);

  // --- the sequences to try: typed in Order, else every hint in the text chunks
  const tried: Attempt[] = [];
  const tryReadings = (
    source: 'manual' | 'list' | 'hint',
    perm: number[],
    readings: Reading[],
    hint?: number,
  ) => {
    for (const reading of readings) {
      const order = applyReading(perm, reading);
      const twin = tried.find((t) => sameOrder(t.order, order));
      if (twin) {
        if (twin.source === source && twin.hint === hint) twin.bothSame = true;
      } else tried.push(attempt(source, reading, order, hint));
    }
  };
  const readings: Reading[] = opts.reading === 'auto' ? ['chunk', 'position'] : [opts.reading];
  if (result.manual) {
    const seq = toPermutation(numbersIn(opts.order), n);
    if (isProblem(seq)) result.sequenceProblem = seq;
    else if (isListOrder(opts.order)) tryReadings('list', seq.perm, ['position']);
    else tryReadings('manual', seq.perm, readings);
  } else {
    for (let h = 0; h < result.hints.length; h++) {
      tryReadings('hint', result.hints[h]!.perm, readings, h);
      if (tried.some(confirmed)) break;
    }
  }
  result.chosen = tried.find(confirmed) ?? null;
  // Two different orders (the two readings, or two hints) that both match: no telling which.
  let ambiguous = tried.filter(confirmed).length > 1;

  // --- no (confirmed) order yet: the file order, then the search
  // A reading forced by the user on a hint is reported as it is, without a fallback.
  const forced = !result.manual && result.hints.length > 0 && opts.reading !== 'auto';
  let file: Attempt | null = null;
  if (!result.chosen && !result.manual && !forced) {
    file = tried.find((a) => isIdentity(a.order)) ?? attempt('file', null, [...Array(n).keys()]);
    if (confirmed(file)) result.chosen = file;
  }
  // The order is proven (Adler-32) and only the size is wrong: searching would not help.
  const sizeOnly = result.attempts.some((a) => a.streamOk && !a.fitted);
  const best: { prefix: { order: number[]; good: number } | null } = { prefix: null };
  const inflating: number[][] = [];
  if (
    !result.chosen &&
    !forced &&
    !sizeOnly &&
    !result.sequenceProblem &&
    opts.search &&
    n > 1 &&
    n <= SEARCH_MAX_CHUNKS
  ) {
    let spent = 0;
    const all = [...Array(n).keys()];
    const first = damagedHeader && opts.fixZlib ? all : all.filter((i) => headerOk(datas[i]!));
    const matching: number[][] = [];
    const run = (order: number[], final: boolean) => {
      if (spent > SEARCH_BYTES) return false;
      const r = tryOrder(order, final, { merge: true }).result;
      spent += r.produced;
      if (!best.prefix || r.goodBytes > best.prefix.good)
        best.prefix = { order: order.slice(), good: r.goodBytes };
      if (!final) return r.ok;
      // A whole order that inflates is only accepted when its Adler-32 matches; the others
      // are remembered (a damaged checksum, or stored blocks that inflate in any order).
      if (r.ok && inflating.length < 4 && !inflating.some((o) => sameOrder(o, order)))
        inflating.push(order.slice());
      if (!adlerOk(r)) return false;
      matching.push(order.slice());
      // Compressed data: a match is final. Stored data: look for a second one (a collision).
      return !storedData || matching.length > 1;
    };
    const searched = searchOrder(
      n,
      first,
      (o) => run(o, false),
      (o) => run(o, true),
      SEARCH_TRIES,
    );
    const exhausted = searched.exhausted || spent > SEARCH_BYTES;
    result.search = { ...searched, exhausted, inflating: inflating.length };
    const pick = matching[0];
    if (pick) {
      if (storedData && (matching.length > 1 || exhausted)) ambiguous = true;
      if (result.manual) result.proposal = pick;
      else result.chosen = attempt('search', null, pick);
    }
  }

  // --- still nothing confirmed: the best order that at least inflates, said to be unsure
  if (result.chosen) result.certainty = ambiguous ? 'ambiguous' : 'confirmed';
  else {
    const pool = [...tried, ...(file && !tried.includes(file) ? [file] : [])];
    let pick = pool.find((a) => a.result.ok) ?? null;
    if (!pick && !result.manual && !forced && inflating[0]) {
      pick = attempt('search', null, inflating[0]);
      if (!pick.result.ok) pick = null;
    }
    if (pick) {
      result.chosen = pick;
      const s = result.search;
      const alone =
        s !== null &&
        !s.exhausted &&
        inflating.length === 1 &&
        sameOrder(inflating[0]!, pick.order);
      result.certainty = n === 1 || alone ? 'only' : 'unconfirmed';
    }
  }
  result.hint = result.chosen?.hint !== undefined ? result.hints[result.chosen.hint]! : result.hint;

  // --- the size: the data's own (order proven), overrides, a CRC candidate, the data itself
  const chosen = result.chosen;
  let final: Ihdr = { ...work };
  if (chosen) {
    const raw = chosen.result.produced;
    for (const c of candidates) c.fits = layoutOf(c.ihdr)?.total === raw;
    candidates.sort((a, b) => Number(b.fits) - Number(a.fits));
    if (chosen.fitted) {
      const fit = candidates.find((c) => c.fits && c.ihdr.width === chosen.fitted!.width);
      final = { ...(fit?.ihdr ?? chosen.fitted) };
      result.sizeHow = fit ? 'crc' : 'data';
    } else if (overrides) {
      result.sizeHow = 'override';
      if (opts.height === 0 && !lay.interlaced)
        final.height = heightForSize(final, raw) ?? final.height;
    } else if (candidates[0]?.fits) {
      final = { ...candidates[0].ihdr };
      result.sizeHow = 'crc';
    } else if (opts.fixIhdr) {
      // No CRC candidate fits: trust the stored fields unless the stream only checked out with
      // a candidate's row size (then that width is the right one).
      const storedRows = layoutOf(stored);
      const base =
        storedRows && !lay.interlaced && storedRows.rowBytes === lay.rowBytes ? stored : work;
      const h = heightForSize(base, raw);
      final = { ...base, height: h ?? base.height };
      if (final.width !== stored.width || final.height !== stored.height) {
        result.sizeHow = h !== null && h !== base.height ? 'data' : 'crc';
      }
    }
  } else if (overrides) {
    result.sizeHow = 'override';
  }
  result.final = final;

  // --- rebuild and decode
  const used = chosen ?? result.attempts[0] ?? null;
  const order = used?.order ?? [...Array(n).keys()];
  let pieces = piecesWith(datas, order, used?.header ?? null);
  if (
    chosen &&
    opts.fixZlib &&
    chosen.result.adlerComputed !== null &&
    chosen.result.adlerStored !== null &&
    !adlerOk(chosen.result)
  ) {
    pieces = patchTail(pieces, chosen.result.adlerComputed);
    result.adlerFixed = true;
  }
  result.rebuilt = rebuild(bytes, result, order, pieces, opts);
  if (chosen) {
    try {
      const img = decodeImageExact(result.rebuilt);
      if (img) result.image = img;
      else result.decodeError = 'signature';
    } catch (e) {
      result.decodeError = e instanceof Error ? e.message : String(e);
    }
  }
  if (!result.image && !lay.interlaced) {
    // The rows that decode: from the attempt (or the search prefix) that got furthest.
    const tries: { order: number[]; good: number }[] = (chosen ? [chosen] : result.attempts).map(
      (a) => ({ order: a.order, good: a.result.goodBytes }),
    );
    let bestTry = tries.reduce<{ order: number[]; good: number } | null>(
      (b, a) => (!b || a.good > b.good ? a : b),
      null,
    );
    // A search prefix may end with a wrong chunk that passed a row or two: it only replaces
    // the attempts' rendering when it holds clearly more (half a chunk's worth). Not for an
    // order set by hand: what is shown is what was set (the search only proposes).
    const prefix = best.prefix;
    if (
      !chosen &&
      !result.manual &&
      prefix &&
      prefix.good > (bestTry?.good ?? 0) + lay.total / n / 2
    )
      bestTry = prefix;
    if (bestTry && bestTry.good > 0) {
      const { result: r } = tryOrder(bestTry.order, false, { capture: bestTry.good });
      result.partial = partialRendering(result, r.data, lay.rowBytes);
    }
  }
  return result;
}

function rebuild(
  bytes: Uint8Array,
  s: Surgery,
  order: number[],
  pieces: Uint8Array[],
  opts: SurgeryOptions,
): Uint8Array {
  const out: Uint8Array[] = [];
  const sigOk = s.parse.signature === 'ok';
  if (opts.fixSignature || sigOk) {
    out.push(new Uint8Array(PNG_SIGNATURE));
    s.repairs.signature = !sigOk;
  } else if (s.parse.signature === 'damaged') {
    out.push(bytes.subarray(0, 8));
  }
  const ihdr = s.ihdrChunk!;
  const final = s.final!;
  const ihdrNew = ihdrData(final);
  const ihdrChanged = ihdrNew.some((v, i) => v !== ihdr.data[i]) || ihdr.length !== 13;
  const keepIhdrCrc = !opts.fixCrc && !ihdrChanged && ihdr.crcStored !== null;
  out.push(chunkBytes('IHDR', ihdrNew, keepIhdrCrc ? ihdr.crcStored! : ihdrCrc(final)));
  // A rewritten IHDR is a size repair (reported as such), not a CRC repair.
  if (!keepIhdrCrc && !ihdrChanged && !ihdr.crcOk) s.repairs.crc++;
  if (ihdr.status === 'type-fixed' || ihdr.status === 'type-guessed') s.repairs.types++;

  const chunks = s.parse.chunks;
  const firstIdat = chunks.findIndex((c) => c.type === 'IDAT');
  const before: SurgeonChunk[] = [];
  const after: SurgeonChunk[] = [];
  for (const c of chunks) {
    if (c === ihdr || c.type === 'IDAT' || c.type === 'IEND' || c.type === 'IHDR') continue;
    if (c.afterIend) continue;
    if (c.status === 'length-fixed') s.repairs.lengths++;
    if (c.status === 'type-fixed') s.repairs.types++;
    const critical = (c.type.charCodeAt(0) & 0x20) === 0;
    if (!c.validType || (critical && c.type !== 'PLTE') || c.status === 'truncated') {
      s.repairs.dropped.push(c);
      continue;
    }
    if (c.index < firstIdat || firstIdat < 0) before.push(c);
    else if (BEFORE_IDAT.has(c.type)) {
      before.push(c);
      s.repairs.moved++;
    } else after.push(c);
  }
  const write = (c: SurgeonChunk) => {
    const keep = !opts.fixCrc && c.crcStored !== null;
    if (!keep && !c.crcOk) s.repairs.crc++;
    out.push(chunkBytes(c.type, c.data, keep ? c.crcStored! : c.crcComputed));
  };
  before.forEach(write);
  const idatChunks = s.idats;
  for (const c of idatChunks) {
    if (c.status === 'length-fixed') s.repairs.lengths++;
    if (c.status === 'type-fixed') s.repairs.types++;
  }
  s.repairs.iendMoved = idatChunks.some((c) => c.afterIend);
  const idatPieces = opts.singleIdat ? [concatBytes(...pieces)] : pieces;
  idatPieces.forEach((data, i) => {
    const src = opts.singleIdat ? undefined : idatChunks[order[i]!];
    if (src && src.data === data) {
      // Unchanged payload: its CRC is already known.
      const keep = !opts.fixCrc && src.crcStored !== null;
      if (!keep && !src.crcOk) s.repairs.crc++;
      out.push(chunkBytes('IDAT', data, keep ? src.crcStored! : src.crcComputed));
    } else {
      out.push(chunkBytes('IDAT', data, chunkCrc(latin1Encode('IDAT'), data)));
    }
  });
  if (opts.singleIdat && opts.fixCrc) s.repairs.crc += idatChunks.filter((c) => !c.crcOk).length;
  after.forEach(write);
  // IEND: its CRC is a constant, so a wrong one is a CRC repair like any other.
  const iend = chunks.find((c) => c.type === 'IEND' && !c.afterIend);
  const keepIend = !opts.fixCrc && iend?.crcStored !== null && iend?.crcStored !== undefined;
  if (iend && !keepIend && !iend.crcOk) s.repairs.crc++;
  if (iend?.status === 'type-fixed') s.repairs.types++;
  out.push(chunkBytes('IEND', new Uint8Array(0), keepIend ? iend.crcStored! : IEND_CRC));
  return concatBytes(...out);
}

/** The rows that inflated cleanly, as an image (non-interlaced only). */
function partialRendering(
  s: Surgery,
  data: Uint8Array | null,
  rowBytes: number,
): { image: RgbaImage; rows: number } | null {
  const rows = data ? Math.floor(data.length / rowBytes) : 0;
  if (!rows || !data) return null;
  const ihdr = { ...(s.final ?? s.work!), height: rows, interlace: 0 };
  const z = zlibSync(data.subarray(0, rows * rowBytes));
  const png = concatBytes(
    new Uint8Array(PNG_SIGNATURE),
    chunkBytes('IHDR', ihdrData(ihdr), ihdrCrc(ihdr)),
    ...plteOf(s),
    chunkBytes('IDAT', z, chunkCrc(latin1Encode('IDAT'), z)),
    chunkBytes('IEND', new Uint8Array(0), IEND_CRC),
  );
  try {
    const image = decodeImageExact(png);
    return image ? { image, rows } : null;
  } catch {
    // Best effort only: the summary already says why the full image does not decode.
    return null;
  }
}

/** PLTE and tRNS chunks (an indexed image needs them to render). */
function plteOf(s: Surgery): Uint8Array[] {
  return s.parse.chunks
    .filter((c) => (c.type === 'PLTE' || c.type === 'tRNS') && !c.afterIend)
    .map((c) => chunkBytes(c.type, c.data, c.crcComputed));
}
