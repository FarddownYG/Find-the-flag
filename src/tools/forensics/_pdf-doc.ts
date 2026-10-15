/**
 * The structure of a PDF file: header, every indirect object (found by scanning the bytes, so a
 * damaged or missing cross-reference table does not hide anything), the xref tables and streams,
 * the trailers, the incremental updates (revisions), object streams and the decoding of stream
 * data (decryption first, then the filters).
 *
 * Two views of the same file are kept apart:
 *  - the bytes: `records` lists every `n g obj ... endobj` in file order, including old versions
 *    of objects, deleted ones and ones no table points at;
 *  - the document: a view maps object numbers to where the current version lives, as a reader
 *    that follows the xref chain from a given `startxref` sees it. The last revision's view is
 *    what a viewer shows; the earlier views are the document as it was after each save.
 */
import { indexOfBytes, latin1Decode, utf8Encode } from '../../lib/bytes';
import {
  readEncrypt,
  unlock,
  type Decryptor,
  type EncryptInfo,
  type UnlockResult,
} from './_pdf-crypt';
import {
  canonicalFilter,
  decodeFilters,
  type DecodeOutcome,
  type FilterSpec,
} from './_pdf-filters';
import {
  isArray,
  isDict,
  isKeyword,
  isName,
  isNum,
  isRef,
  isRegular,
  isSpace,
  isString,
  Lexer,
  PdfSyntaxError,
  type PdfDict,
  type PdfValue,
} from './_pdf-lex';

// ---------- limits ----------

/** Objects kept from the scan (a file with more is cut, and says so). */
export const MAX_OBJECTS = 600_000;
/** Largest decoded stream kept in memory. */
export const MAX_STREAM = 64 * 1024 * 1024;
/** Decoded bytes the whole analysis is willing to produce (a bomb in many small pieces). */
export const DECODE_BUDGET = 768 * 1024 * 1024;
export const MAX_REVISIONS = 200;

// ---------- types ----------

export interface XEntry {
  /** n: in use at a byte offset, c: inside an object stream, f: free. */
  kind: 'n' | 'c' | 'f';
  gen: number;
  /** n: byte offset · c: object number of the stream · f: next free object. */
  a: number;
  /** c: index in the object stream. */
  b: number;
}
export type XrefMap = Map<number, XEntry>;

export interface XrefSection {
  /** Offset of the `xref` keyword, or of the XRef stream object. */
  offset: number;
  kind: 'table' | 'stream';
  entries: XrefMap;
  trailer: PdfDict;
  prev: number | null;
  /** Hybrid files: the xref stream that completes this table. */
  xrefStm: number | null;
  hybrid: XrefMap | null;
  /** First byte after the section (after the trailer dictionary). */
  end: number;
  /** Object number of the XRef stream. */
  objNum: number | null;
  problems: string[];
}

export interface StreamLoc {
  dataStart: number;
  dataEnd: number;
  /** /Length as written (resolved when indirect), or null. */
  declared: number | null;
  lengthIndirect: boolean;
  /** /Length leads to the `endstream` keyword. */
  lengthOk: boolean;
  /** `endstream` was found after the data. */
  hasEndstream: boolean;
}

export interface ObjRecord {
  num: number;
  gen: number;
  /** Start of `n g obj`. */
  offset: number;
  bodyStart: number;
  /** After `endobj` (or after what could be parsed). */
  end: number;
  /** The object; for a stream, its dictionary. Strings are as in the file (not decrypted). */
  value: PdfValue | undefined;
  stream: StreamLoc | null;
  hasEndobj: boolean;
  problem: string | null;
  /** Cached decrypted copy of `value`. */
  decrypted?: PdfValue | undefined;
}

export interface Revision {
  /** 1 for the original file, 2 for the first update... */
  index: number;
  /** The xref sections this revision ends with (empty when the xref was rebuilt). */
  sections: XrefSection[];
  /** Bytes [start, end): from the end of the previous revision to just after this %%EOF. */
  start: number;
  end: number;
  /** Offset of the `startxref` keyword and of the %%EOF that close it. */
  startxrefAt: number | null;
  eofAt: number | null;
  /** The xref entries this revision adds or changes. */
  delta: XrefMap;
}

export interface Gap {
  offset: number;
  length: number;
  kind: 'comment' | 'data';
  text: string;
}

export interface OpenOptions {
  passwords?: string[];
  /** Ignore the xref tables and rebuild the structure from the objects found in the bytes. */
  rebuild?: boolean;
}

export type DecodeInfo = DecodeOutcome & {
  rawLength: number;
  /** Decryption was needed and could not be done: the bytes are still encrypted. */
  encrypted: boolean;
};

// ---------- reading helpers ----------

const ENDSTREAM = utf8Encode('endstream');
const ENDOBJ = utf8Encode('endobj');
const EOF_MARK = utf8Encode('%%EOF');
const STARTXREF = utf8Encode('startxref');
const PDF_MARK = utf8Encode('%PDF-');

const isDigitByte = (c: number | undefined): boolean => c !== undefined && c >= 0x30 && c <= 0x39;

interface ObjHeader {
  offset: number;
  bodyStart: number;
}

/** The next `n g obj` at or after `from`, looking for it in buf[from, to). */
function nextObjHeader(buf: Uint8Array, from: number, to: number): ObjHeader | null {
  for (let i = from + 4; i + 2 < to; i++) {
    if (buf[i] !== 0x6f || buf[i + 1] !== 0x62 || buf[i + 2] !== 0x6a) continue;
    if (i + 3 < to && isRegular(buf[i + 3])) continue; // "object", "objstm"
    let p = i - 1;
    if (!isSpace(buf[p])) continue;
    while (p >= from && isSpace(buf[p])) p--;
    let q = p;
    while (q >= from && isDigitByte(buf[q])) q--;
    if (q === p || p - q > 5 || !isSpace(buf[q])) continue;
    while (q >= from && isSpace(buf[q])) q--;
    let r = q;
    while (r >= from && isDigitByte(buf[r])) r--;
    if (r === q || q - r > 10) continue;
    if (r >= from && isRegular(buf[r])) continue; // glued to a keyword: not a header
    return { offset: r + 1, bodyStart: i + 3 };
  }
  return null;
}

/** `n g obj <integer>` at an offset: the value of a small indirect integer (a /Length). */
function peekInteger(buf: Uint8Array, offset: number): number | null {
  if (offset < 0 || offset >= buf.length) return null;
  try {
    const lx = new Lexer(buf, offset, Math.min(buf.length, offset + 64));
    const num = lx.readValue();
    const gen = lx.readValue();
    const word = lx.readValue();
    const value = lx.readValue();
    if (isNum(num) && isNum(gen) && isKeyword(word, 'obj')) {
      return isNum(value) && Number.isInteger(value) && value >= 0 ? value : null;
    }
  } catch (e) {
    if (!(e instanceof PdfSyntaxError)) throw e;
  }
  return null;
}

function startsWithBytes(buf: Uint8Array, at: number, word: Uint8Array): boolean {
  if (at < 0 || at + word.length > buf.length) return false;
  for (let i = 0; i < word.length; i++) if (buf[at + i] !== word[i]) return false;
  return true;
}

/** Parse the object at `offset` (a `n g obj` header), with its stream if it has one. */
function parseRecordAt(
  buf: Uint8Array,
  offset: number,
  lengthOf: (num: number) => number | null,
): ObjRecord | null {
  const lx = new Lexer(buf, offset);
  let num: PdfValue | undefined;
  let gen: PdfValue | undefined;
  let word: PdfValue | undefined;
  try {
    num = lx.readValue();
    gen = lx.readValue();
    word = lx.readValue();
  } catch (e) {
    if (e instanceof PdfSyntaxError) return null;
    throw e;
  }
  if (!isNum(num) || !isNum(gen) || !isKeyword(word) || !word.v.startsWith('obj')) return null;
  const rec: ObjRecord = {
    num,
    gen,
    offset,
    bodyStart: lx.pos,
    end: lx.pos,
    value: undefined,
    stream: null,
    hasEndobj: false,
    problem: null,
  };
  try {
    const value = lx.readValue();
    if (isKeyword(value, 'endobj')) {
      rec.value = null;
      rec.hasEndobj = true;
      rec.end = lx.pos;
      return rec;
    }
    rec.value = value;
  } catch (e) {
    if (!(e instanceof PdfSyntaxError)) throw e;
    rec.problem = 'syntax';
    rec.end = lx.pos;
    return rec;
  }
  rec.end = lx.pos;
  lx.skip();
  if (isDict(rec.value) && lx.atWord('stream')) {
    rec.stream = locateStream(buf, lx.pos + 6, rec.value, lengthOf);
    lx.pos = rec.stream.dataEnd;
    if (rec.stream.hasEndstream) {
      lx.skip();
      if (lx.atWord('endstream')) lx.pos += 9;
    }
    rec.end = lx.pos;
    lx.skip();
  }
  if (lx.atWord('endobj')) {
    lx.pos += 6;
    rec.hasEndobj = true;
    rec.end = lx.pos;
  }
  return rec;
}

/** Where the data of a stream starts and ends, trusting /Length only when `endstream` follows. */
function locateStream(
  buf: Uint8Array,
  afterKeyword: number,
  dict: PdfDict,
  lengthOf: (num: number) => number | null,
): StreamLoc {
  let p = afterKeyword;
  if (buf[p] === 0x0d) {
    p++;
    if (buf[p] === 0x0a) p++;
  } else if (buf[p] === 0x0a) p++;
  else {
    // "stream  \n": spaces before the end of line are tolerated
    let q = p;
    while (buf[q] === 0x20 || buf[q] === 0x09) q++;
    if (q > p && (buf[q] === 0x0a || buf[q] === 0x0d)) {
      p = q + 1;
      if (buf[q] === 0x0d && buf[p] === 0x0a) p++;
    }
  }
  const dataStart = p;
  const lengthValue = dict.map.get('Length');
  let declared: number | null = null;
  let lengthIndirect = false;
  if (isNum(lengthValue)) declared = lengthValue;
  else if (isRef(lengthValue)) {
    lengthIndirect = true;
    declared = lengthOf(lengthValue.num);
  }
  if (declared !== null && (!Number.isInteger(declared) || declared < 0)) declared = null;
  if (declared !== null && dataStart + declared <= buf.length) {
    let q = dataStart + declared;
    while (q < buf.length && isSpace(buf[q])) q++;
    if (startsWithBytes(buf, q, ENDSTREAM)) {
      return {
        dataStart,
        dataEnd: dataStart + declared,
        declared,
        lengthIndirect,
        lengthOk: true,
        hasEndstream: true,
      };
    }
  }
  const idx = findKeyword(buf, ENDSTREAM, 'endstream', dataStart);
  if (idx >= 0) {
    let end = idx;
    if (end > dataStart && buf[end - 1] === 0x0a) end--;
    if (end > dataStart && buf[end - 1] === 0x0d) end--;
    return {
      dataStart,
      dataEnd: end,
      declared,
      lengthIndirect,
      lengthOk: false,
      hasEndstream: true,
    };
  }
  // No endstream: up to the endobj, or the declared length, or the end of the file
  const endobj = findKeyword(buf, ENDOBJ, 'endobj', dataStart);
  const dataEnd =
    declared !== null && dataStart + declared <= buf.length
      ? dataStart + declared
      : endobj >= 0
        ? endobj
        : buf.length;
  return { dataStart, dataEnd, declared, lengthIndirect, lengthOk: false, hasEndstream: false };
}

/**
 * Where a keyword next occurs. A search that fails once cannot succeed from a later position, so
 * a file full of "stream" keywords and no "endstream" costs one scan, not one per stream.
 */
const NOT_FOUND_FROM = new WeakMap<Uint8Array, Map<string, number>>();

function findKeyword(buf: Uint8Array, word: Uint8Array, name: string, from: number): number {
  let memo = NOT_FOUND_FROM.get(buf);
  if (!memo) {
    memo = new Map();
    NOT_FOUND_FROM.set(buf, memo);
  }
  const failedFrom = memo.get(name);
  if (failedFrom !== undefined && from >= failedFrom) return -1;
  const at = indexOfBytes(buf, word, from);
  if (at < 0) memo.set(name, Math.min(failedFrom ?? Infinity, from));
  return at;
}

const noDecode = (data: Uint8Array, encrypted: boolean): DecodeInfo => ({
  data,
  truncated: false,
  applied: [],
  stoppedAt: null,
  image: null,
  error: null,
  rawLength: data.length,
  encrypted,
});

// ---------- the document ----------

export class PdfDoc {
  readonly bytes: Uint8Array;
  /** Offset of `%PDF-` (xref offsets count from there), or -1 when there is no header. */
  headerAt = -1;
  version: string | null = null;
  records: ObjRecord[] = [];
  /** More objects than MAX_OBJECTS were found. */
  scanCut = false;
  readonly byOffset = new Map<number, ObjRecord>();
  readonly byNum = new Map<number, ObjRecord[]>();
  /** Sections reached from the last startxref, newest first. */
  sections: XrefSection[] = [];
  /** Why the xref chain stopped early or was not used (a key), or null. */
  chainProblem: string | null = null;
  revisions: Revision[] = [];
  /** The structure was rebuilt from the objects (no usable xref). */
  recovered = false;
  /** The xref entries (of a sample) that did not point at the object they name. */
  xrefMismatch = 0;
  /** Every %%EOF and startxref outside stream data. */
  eofs: number[] = [];
  startxrefs: { at: number; value: number }[] = [];
  /** The final trailer (merged over the revisions, newest first). */
  trailer: PdfDict = { k: 'dict', map: new Map() };
  encrypt: EncryptInfo | null = null;
  encryptNum: number | null = null;
  /** null when the file is not encrypted. */
  unlocked: UnlockResult | null = null;
  decryptor: Decryptor | null = null;
  linearized = false;
  decodedTotal = 0;

  private readonly objStms = new Map<
    ObjRecord,
    { num: number; index: number; value: PdfValue }[]
  >();
  private readonly objStmIndex = new Map<ObjRecord, Map<number, PdfValue>>();
  private readonly views = new Map<number, XrefMap>();
  private finalView: XrefMap | null = null;
  private streamRangesList: { start: number; end: number }[] = [];

  private constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  /** The offset shift of files that do not start at `%PDF-`. */
  get shift(): number {
    return this.headerAt > 0 ? this.headerAt : 0;
  }

  /** The last revision's view: the document a viewer shows. */
  get view(): XrefMap {
    if (this.finalView) return this.finalView;
    const last = this.revisions[this.revisions.length - 1];
    if (!last) return new Map();
    this.finalView = this.viewOf(last);
    return this.finalView;
  }

  /** The document as it was when revision `rev` was saved. */
  viewOf(rev: Revision): XrefMap {
    const last = this.revisions[this.revisions.length - 1];
    if (rev === last && this.finalView) return this.finalView;
    const cached = this.views.get(rev.index);
    if (cached) return cached;
    const view: XrefMap = new Map();
    for (const r of this.revisions) {
      for (const [num, e] of r.delta) view.set(num, e);
      if (r === rev) break;
    }
    // Keep the newest few: text extraction asks for them in order.
    if (this.views.size >= 2) {
      const first = this.views.keys().next();
      if (!first.done) this.views.delete(first.value);
    }
    this.views.set(rev.index, view);
    return view;
  }

  static async open(bytes: Uint8Array, options: OpenOptions = {}): Promise<PdfDoc> {
    const doc = new PdfDoc(bytes);
    doc.openStructure(options);
    await doc.openEncryption(options.passwords ?? []);
    if (doc.recovered) doc.expandObjectStreams();
    return doc;
  }

  // ----- opening -----

  private openStructure(options: OpenOptions): void {
    this.findHeader();
    // 1. the cross-reference chain from the last startxref (indirect /Length values need it)
    let chain: XrefSection[] = [];
    if (options.rebuild) this.chainProblem = 'forced';
    else {
      const start = this.lastStartxref();
      if (start === null) this.chainProblem = 'noStartxref';
      else {
        const read = this.readChain(start);
        chain = read.sections;
        this.chainProblem = read.problem;
      }
    }
    this.sections = chain;

    // 2. every object, in file order, and the markers outside stream data
    this.scanObjects();
    this.scanMarkers();
    this.linearized = this.detectLinearized();

    // 3. the chain is only used when it leads to the objects that are really there
    if (chain.length > 0 && this.chainLooksRight(chain)) {
      this.buildRevisionsFromChain(chain);
    } else {
      if (chain.length > 0) this.chainProblem = 'mismatch';
      this.sections = [];
      this.rebuild();
    }
    this.mergeTrailer();
    if (this.revisions.length > MAX_REVISIONS) {
      this.revisions = this.revisions.slice(-MAX_REVISIONS);
    }
  }

  private findHeader(): void {
    const head = Math.min(this.bytes.length, 1024);
    const at = indexOfBytes(this.bytes.subarray(0, head + 8), PDF_MARK, 0);
    if (at >= 0) {
      this.headerAt = at;
      const m = /^%PDF-(\d+\.\d+)/.exec(latin1Decode(this.bytes.subarray(at, at + 12)));
      this.version = m ? m[1]! : null;
    }
  }

  private lastStartxref(): number | null {
    const { bytes } = this;
    let at = -1;
    for (let i = bytes.length - STARTXREF.length; i >= 0; i--) {
      if (bytes[i] === 0x73 && startsWithBytes(bytes, i, STARTXREF)) {
        at = i;
        break;
      }
    }
    if (at < 0) return null;
    const lx = new Lexer(bytes, at + STARTXREF.length, Math.min(bytes.length, at + 64));
    const v = lx.readValue();
    return isNum(v) && Number.isInteger(v) && v >= 0 ? v : null;
  }

  /** Follow /Prev from a startxref offset. */
  private readChain(start: number): { sections: XrefSection[]; problem: string | null } {
    const sections: XrefSection[] = [];
    const seen = new Set<number>();
    let at: number | null = start;
    let problem: string | null = null;
    while (at !== null && sections.length < MAX_REVISIONS * 2) {
      if (seen.has(at)) {
        problem = 'loop';
        break;
      }
      seen.add(at);
      const sec = this.readSectionAt(at);
      if (!sec) {
        problem = sections.length === 0 ? 'badStartxref' : 'badPrev';
        break;
      }
      sections.push(sec);
      at = sec.prev;
    }
    return { sections, problem };
  }

  /** The xref table or stream at an offset (trying the header shift too). */
  private readSectionAt(offset: number): XrefSection | null {
    const tries = this.shift > 0 ? [offset + this.shift, offset] : [offset];
    for (const at of tries) {
      const sec = this.parseSectionAt(at);
      if (sec) return sec;
    }
    return null;
  }

  private parseSectionAt(at: number): XrefSection | null {
    const { bytes } = this;
    if (at < 0 || at >= bytes.length) return null;
    const lx = new Lexer(bytes, at);
    lx.skip();
    const start = lx.pos;
    if (lx.atWord('xref')) return this.parseTable(start);
    const rec = parseRecordAt(bytes, start, (n) => this.peekLength(n));
    if (rec && rec.stream && isDict(rec.value) && isName(rec.value.map.get('Type'), 'XRef')) {
      return this.parseXrefStream(rec);
    }
    return null;
  }

  private parseTable(at: number): XrefSection | null {
    const { bytes } = this;
    const lx = new Lexer(bytes, at + 4);
    const entries: XrefMap = new Map();
    const problems: string[] = [];
    try {
      for (;;) {
        lx.skip();
        if (lx.pos >= bytes.length) return null;
        if (lx.atWord('trailer')) {
          lx.pos += 7;
          break;
        }
        const first = lx.readValue();
        const count = lx.readValue();
        if (!isNum(first) || !isNum(count) || count < 0 || count > bytes.length / 10 + 1) {
          return null;
        }
        let firstNum = first;
        for (let i = 0; i < count; i++) {
          const offset = lx.readValue();
          const gen = lx.readValue();
          const flag = lx.readValue();
          if (!isNum(offset) || !isNum(gen) || !isKeyword(flag)) return null;
          if (flag.v !== 'n' && flag.v !== 'f') return null;
          // tables written one number off: the first entry is the free head (65535)
          if (i === 0 && firstNum === 1 && flag.v === 'f' && gen === 65535) firstNum = 0;
          entries.set(firstNum + i, { kind: flag.v, gen, a: offset, b: 0 });
        }
      }
      const trailer = lx.readValue();
      if (!isDict(trailer)) return null;
      const prev = trailer.map.get('Prev');
      const xrefStm = trailer.map.get('XRefStm');
      const sec: XrefSection = {
        offset: at,
        kind: 'table',
        entries,
        trailer,
        prev: isNum(prev) ? prev : null,
        xrefStm: isNum(xrefStm) ? xrefStm : null,
        hybrid: null,
        end: lx.pos,
        objNum: null,
        problems,
      };
      if (sec.xrefStm !== null) {
        const companion = this.readSectionAt(sec.xrefStm);
        if (companion && companion.kind === 'stream') sec.hybrid = companion.entries;
        else problems.push('badXRefStm');
      }
      return sec;
    } catch (e) {
      if (e instanceof PdfSyntaxError) return null;
      throw e;
    }
  }

  private parseXrefStream(rec: ObjRecord): XrefSection | null {
    const dict = rec.value as PdfDict;
    const data = this.decode(rec, MAX_STREAM).data;
    const w = dict.map.get('W');
    if (!isArray(w) || w.items.length < 3 || !w.items.every((x) => isNum(x) && x >= 0 && x <= 8)) {
      return null;
    }
    const [w0, w1, w2] = w.items as [number, number, number];
    const row = w0 + w1 + w2;
    if (row === 0) return null;
    const size = dict.map.get('Size');
    const indexValue = dict.map.get('Index');
    const index: number[] = [];
    if (isArray(indexValue)) {
      for (const x of indexValue.items) if (isNum(x)) index.push(x);
    } else index.push(0, isNum(size) ? size : Math.floor(data.length / row));
    const entries: XrefMap = new Map();
    let p = 0;
    const read = (width: number): number => {
      let v = 0;
      for (let i = 0; i < width; i++) v = v * 256 + data[p++]!;
      return v;
    };
    for (let s = 0; s + 1 < index.length; s += 2) {
      const first = index[s]!;
      const count = index[s + 1]!;
      for (let i = 0; i < count && p + row <= data.length; i++) {
        const type = w0 === 0 ? 1 : read(w0);
        const f2 = read(w1);
        const f3 = read(w2);
        const num = first + i;
        if (type === 1) entries.set(num, { kind: 'n', gen: f3, a: f2, b: 0 });
        else if (type === 2) entries.set(num, { kind: 'c', gen: 0, a: f2, b: f3 });
        else if (type === 0) entries.set(num, { kind: 'f', gen: f3, a: f2, b: 0 });
      }
    }
    const prev = dict.map.get('Prev');
    return {
      offset: rec.offset,
      kind: 'stream',
      entries,
      trailer: dict,
      prev: isNum(prev) ? prev : null,
      xrefStm: null,
      hybrid: null,
      end: rec.end,
      objNum: rec.num,
      problems: [],
    };
  }

  /** Do the xref entries lead to objects with the right numbers, and is there a catalog? */
  private chainLooksRight(chain: XrefSection[]): boolean {
    const view: XrefMap = new Map();
    for (const sec of [...chain].reverse()) applySection(view, sec);
    let checked = 0;
    let wrong = 0;
    for (const [num, e] of view) {
      if (e.kind !== 'n' || e.a === 0) continue;
      if (++checked > 2000) break;
      const rec = this.recordAt(e.a);
      if (!rec || rec.num !== num) wrong++;
    }
    this.xrefMismatch = wrong;
    if (checked > 0 && wrong / checked > 0.3) return false;
    const root = chain.map((s) => s.trailer.map.get('Root')).find((r) => r !== undefined);
    if (isRef(root)) {
      const e = view.get(root.num);
      if (!e || e.kind === 'f') return false;
      if (e.kind === 'n') {
        const rec = this.recordAt(e.a);
        if (!rec || !isDict(rec.value)) return false;
      }
    }
    return true;
  }

  /** /Length of an object that is only given by reference, read through the xref chain. */
  private peekLength(num: number): number | null {
    for (const sec of this.sections) {
      const e = sec.entries.get(num) ?? sec.hybrid?.get(num);
      if (!e) continue;
      if (e.kind !== 'n') return null;
      return peekInteger(this.bytes, e.a + this.shift) ?? peekInteger(this.bytes, e.a);
    }
    return null;
  }

  // ----- scanning -----

  private scanObjects(): void {
    const { bytes } = this;
    let pos = 0;
    while (pos < bytes.length) {
      const hit = nextObjHeader(bytes, pos, bytes.length);
      if (!hit) break;
      if (this.records.length >= MAX_OBJECTS) {
        this.scanCut = true;
        break;
      }
      const rec = parseRecordAt(bytes, hit.offset, (n) => this.peekLength(n));
      if (!rec) {
        pos = hit.bodyStart;
        continue;
      }
      this.records.push(rec);
      this.byOffset.set(rec.offset, rec);
      const list = this.byNum.get(rec.num);
      if (list) list.push(rec);
      else this.byNum.set(rec.num, [rec]);
      if (rec.stream) {
        this.streamRangesList.push({ start: rec.stream.dataStart, end: rec.stream.dataEnd });
      }
      pos = Math.max(rec.end, hit.bodyStart);
    }
  }

  /** %%EOF and startxref outside stream data. */
  private scanMarkers(): void {
    const { bytes } = this;
    let from = 0;
    const regions: [number, number][] = [];
    for (const s of this.streamRangesList) {
      if (s.start > from) regions.push([from, s.start]);
      from = Math.max(from, s.end);
    }
    regions.push([from, bytes.length]);
    for (const [a, b] of regions) {
      for (let i = a; i < b; i++) {
        const c = bytes[i];
        if (c === 0x25 && bytes[i + 1] === 0x25 && startsWithBytes(bytes, i, EOF_MARK)) {
          this.eofs.push(i);
          i += EOF_MARK.length - 1;
        } else if (c === 0x73 && bytes[i + 1] === 0x74 && startsWithBytes(bytes, i, STARTXREF)) {
          const lx = new Lexer(bytes, i + STARTXREF.length, Math.min(bytes.length, i + 64));
          const v = lx.readValue();
          if (isNum(v)) this.startxrefs.push({ at: i, value: v });
          i += STARTXREF.length - 1;
        }
      }
    }
  }

  private detectLinearized(): boolean {
    const first = this.records[0];
    return (
      !!first && isDict(first.value) && first.value.map.has('Linearized') && first.offset < 1100
    );
  }

  // ----- revisions -----

  private afterEof(eof: number): number {
    let p = eof + EOF_MARK.length;
    if (this.bytes[p] === 0x0d) p++;
    if (this.bytes[p] === 0x0a) p++;
    return p;
  }

  private buildRevisionsFromChain(chain: XrefSection[]): void {
    let groups: XrefSection[][] = [...chain].reverse().map((s) => [s]);
    // A linearized file keeps two xref sections for one save: the first-page section at the
    // start of the file and the main one at the end.
    if (this.linearized && groups.length >= 2) {
      const [main, first] = [groups[0]![0]!, groups[1]![0]!];
      if (first.offset < main.offset) groups = [[main, first], ...groups.slice(2)];
    }
    let start = 0;
    for (const group of groups) {
      const delta: XrefMap = new Map();
      for (const sec of group) applySection(delta, sec);
      const last = group[group.length - 1]!;
      const closing = group.length > 1 ? group[0]! : last;
      const sx = this.startxrefs.find(
        (s) =>
          s.at >= closing.end &&
          (s.value === closing.offset || s.value + this.shift === closing.offset),
      );
      const eof = this.eofs.find((e) => e > (sx?.at ?? closing.end - 1));
      const end = eof !== undefined ? this.afterEof(eof) : this.bytes.length;
      this.revisions.push({
        index: this.revisions.length + 1,
        sections: group,
        start,
        end,
        startxrefAt: sx?.at ?? null,
        eofAt: eof ?? null,
        delta,
      });
      start = end;
    }
  }

  /** No xref to rely on: build the views from the objects in the file. */
  private rebuild(): void {
    this.recovered = true;
    const ends = this.eofs.map((e) => this.afterEof(e));
    const lastRecord = this.records[this.records.length - 1];
    const tail = ends[ends.length - 1] ?? 0;
    if (ends.length === 0 || (lastRecord !== undefined && lastRecord.offset >= tail)) {
      ends.push(this.bytes.length);
    }
    let start = 0;
    let r = 0;
    ends.forEach((end, i) => {
      const delta: XrefMap = new Map();
      while (r < this.records.length && this.records[r]!.offset < end) {
        const rec = this.records[r++]!;
        delta.set(rec.num, { kind: 'n', gen: rec.gen, a: rec.offset - this.shift, b: 0 });
      }
      const lastRev = this.revisions[this.revisions.length - 1];
      if (delta.size === 0 && lastRev) {
        // two %%EOF with no object between them add no revision
        lastRev.end = end;
        lastRev.eofAt = this.eofs[i] ?? lastRev.eofAt;
      } else {
        this.revisions.push({
          index: this.revisions.length + 1,
          sections: [],
          start,
          end,
          startxrefAt: null,
          eofAt: this.eofs[i] ?? null,
          delta,
        });
      }
      start = end;
    });
  }

  /** Rebuilt views: add the members of the object streams (their data needs the key first). */
  private expandObjectStreams(): void {
    this.views.clear();
    this.finalView = null;
    const seen = new Map<number, ObjRecord>();
    for (const rev of this.revisions) {
      const extra: XrefMap = new Map();
      for (const [num, e] of rev.delta) {
        if (e.kind !== 'n') continue;
        const rec = this.recordAt(e.a);
        if (rec && rec.stream && isDict(rec.value) && isName(rec.value.map.get('Type'), 'ObjStm')) {
          seen.set(num, rec);
        }
      }
      for (const [num, stm] of seen) {
        for (const m of this.objStmMembers(stm)) {
          const own = rev.delta.get(m.num);
          if (!own) extra.set(m.num, { kind: 'c', gen: 0, a: num, b: m.index });
        }
      }
      for (const [k, v] of extra) rev.delta.set(k, v);
    }
    // views built while the deltas were incomplete are stale
    this.views.clear();
    this.finalView = null;
  }

  private mergeTrailer(): void {
    const merged = new Map<string, PdfValue>();
    const sources: PdfDict[] = [];
    if (this.sections.length > 0) for (const s of this.sections) sources.push(s.trailer);
    else {
      // rebuilt: the trailers written in the text, newest first, then the XRef stream dictionaries
      sources.push(...this.findTrailerDicts().reverse());
      for (const rec of [...this.records].reverse()) {
        if (isDict(rec.value) && isName(rec.value.map.get('Type'), 'XRef')) sources.push(rec.value);
      }
    }
    for (const src of sources) {
      for (const [k, v] of src.map) if (!merged.has(k)) merged.set(k, v);
    }
    if (!merged.has('Root')) {
      for (const rec of [...this.records].reverse()) {
        if (isDict(rec.value) && isName(rec.value.map.get('Type'), 'Catalog')) {
          merged.set('Root', { k: 'ref', num: rec.num, gen: rec.gen });
          break;
        }
      }
    }
    this.trailer = { k: 'dict', map: merged };
  }

  /** `trailer << ... >>` dictionaries found in the text, in file order. */
  private findTrailerDicts(): PdfDict[] {
    const out: PdfDict[] = [];
    const word = utf8Encode('trailer');
    const { bytes } = this;
    let at = indexOfBytes(bytes, word, 0);
    while (at >= 0 && out.length < 50) {
      if (!this.inStream(at)) {
        try {
          const v = new Lexer(bytes, at + 7).readValue();
          if (isDict(v)) out.push(v);
        } catch (e) {
          if (!(e instanceof PdfSyntaxError)) throw e;
        }
      }
      at = indexOfBytes(bytes, word, at + 7);
    }
    return out;
  }

  // ----- encryption -----

  private async openEncryption(passwords: string[]): Promise<void> {
    const enc = this.trailer.map.get('Encrypt');
    if (enc === undefined || enc === null) return;
    let dict: PdfValue | undefined = enc;
    if (isRef(enc)) {
      this.encryptNum = enc.num;
      dict = this.getObject(enc.num);
    }
    if (!isDict(dict)) return;
    const idValue = this.resolve(this.trailer.map.get('ID'));
    let id0: Uint8Array = new Uint8Array(0);
    if (isArray(idValue)) {
      const first = this.resolve(idValue.items[0]);
      if (isString(first)) id0 = first.b;
    }
    this.encrypt = readEncrypt(dict, id0, (v) => this.resolve(v));
    this.unlocked = await unlock(this.encrypt, passwords);
    if (this.unlocked.ok) {
      this.decryptor = this.unlocked.decryptor;
      // what was read before the key existed is dropped
      for (const rec of this.records) rec.decrypted = undefined;
      this.objStms.clear();
      this.objStmIndex.clear();
    }
  }

  // ----- objects -----

  /**
   * The record an xref offset leads to: exactly, or a few bytes late (writers whose offsets point
   * at the end of line before "n g obj"; readers skip the white space, so this one does too).
   */
  recordAt(offset: number): ObjRecord | undefined {
    for (const pos of this.shift > 0 ? [offset + this.shift, offset] : [offset]) {
      const exact = this.byOffset.get(pos);
      if (exact) return exact;
      let lo = 0;
      let hi = this.records.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (this.records[mid]!.offset < pos) lo = mid + 1;
        else hi = mid;
      }
      const next = this.records[lo];
      if (next && next.offset - pos <= 4) {
        let between = true;
        for (let i = pos; i < next.offset; i++) if (!isSpace(this.bytes[i])) between = false;
        if (between) return next;
      }
    }
    return undefined;
  }

  /** The record an xref entry points at, falling back to the scan when the offset is wrong. */
  recordFor(num: number, e: XEntry): ObjRecord | null {
    const direct = this.recordAt(e.a);
    if (direct && direct.num === num) return direct;
    const list = this.byNum.get(num);
    if (list && list.length > 0) {
      // the latest definition before the offset the table gave, else the latest one
      const before = list.filter((r) => r.offset <= e.a + this.shift);
      return before[before.length - 1] ?? list[list.length - 1]!;
    }
    return null;
  }

  /** Object `num` as the given view sees it (a stream is returned as its dictionary). */
  getObject(num: number, view: XrefMap = this.view): PdfValue | undefined {
    const e = view.get(num);
    if (!e || e.kind === 'f') return undefined;
    if (e.kind === 'c') {
      const stmEntry = view.get(e.a);
      if (!stmEntry || stmEntry.kind !== 'n') return undefined;
      const stm = this.recordFor(e.a, stmEntry);
      return stm ? this.objStmLookup(stm).get(num) : undefined;
    }
    const rec = this.recordFor(num, e);
    return rec ? this.decryptedValue(rec) : undefined;
  }

  /** The record behind a view entry (not for objects inside object streams). */
  getRecord(num: number, view: XrefMap = this.view): ObjRecord | null {
    const e = view.get(num);
    if (!e || e.kind !== 'n') return null;
    return this.recordFor(num, e);
  }

  resolve(v: PdfValue | undefined, view: XrefMap = this.view): PdfValue | undefined {
    let cur = v;
    for (let i = 0; i < 16 && isRef(cur); i++) cur = this.getObject(cur.num, view);
    return cur;
  }

  dictOf(v: PdfValue | undefined, view: XrefMap = this.view): PdfDict | null {
    const r = this.resolve(v, view);
    return isDict(r) ? r : null;
  }

  decryptedValue(rec: ObjRecord): PdfValue | undefined {
    if (rec.decrypted !== undefined) return rec.decrypted;
    const dec = this.decryptor;
    let out = rec.value;
    if (
      dec &&
      rec.value !== undefined &&
      rec.num !== this.encryptNum &&
      !(isDict(rec.value) && isName(rec.value.map.get('Type'), 'XRef'))
    ) {
      out = decryptStrings(rec.value, (b) => dec.string(rec.num, rec.gen, b), 0);
    }
    rec.decrypted = out;
    return out;
  }

  // ----- object streams -----

  private objStmLookup(stm: ObjRecord): Map<number, PdfValue> {
    let map = this.objStmIndex.get(stm);
    if (!map) {
      map = new Map();
      for (const m of this.objStmMembers(stm)) if (!map.has(m.num)) map.set(m.num, m.value);
      this.objStmIndex.set(stm, map);
    }
    return map;
  }

  /** The objects packed in an object stream, in order. */
  objStmMembers(stm: ObjRecord): { num: number; index: number; value: PdfValue }[] {
    const cached = this.objStms.get(stm);
    if (cached) return cached;
    const members: { num: number; index: number; value: PdfValue }[] = [];
    this.objStms.set(stm, members);
    const dict = this.decryptedValue(stm);
    if (!isDict(dict) || !stm.stream) return members;
    const n = this.resolve(dict.map.get('N'));
    const first = this.resolve(dict.map.get('First'));
    if (!isNum(n) || !isNum(first) || n < 0 || n > 1_000_000 || first < 0) return members;
    const data = this.decode(stm, MAX_STREAM).data;
    try {
      const lx = new Lexer(data, 0, Math.min(data.length, first || data.length));
      const pairs: [number, number][] = [];
      for (let i = 0; i < n; i++) {
        const num = lx.readValue();
        const off = lx.readValue();
        if (!isNum(num) || !isNum(off)) break;
        pairs.push([num, off]);
      }
      pairs.forEach(([num, off], index) => {
        const value = new Lexer(data, first + off).readValue();
        if (value !== undefined) members.push({ num, index, value });
      });
    } catch (e) {
      if (!(e instanceof PdfSyntaxError)) throw e;
    }
    return members;
  }

  // ----- streams -----

  /** The stream filters of a stream dictionary, in order. */
  filtersOf(dict: PdfDict, view: XrefMap = this.view): FilterSpec[] {
    const f = this.resolve(dict.map.get('Filter') ?? dict.map.get('F'), view);
    const dp = this.resolve(dict.map.get('DecodeParms') ?? dict.map.get('DP'), view);
    const names: string[] = [];
    if (isName(f)) names.push(f.v);
    else if (isArray(f)) {
      for (const x of f.items) {
        const n = this.resolve(x, view);
        if (isName(n)) names.push(n.v);
      }
    }
    return names.map((n, i) => {
      const parms = isArray(dp) ? this.resolve(dp.items[i], view) : i === 0 ? dp : undefined;
      const params: Record<string, number> = {};
      if (isDict(parms)) {
        for (const key of ['Predictor', 'Colors', 'BitsPerComponent', 'Columns', 'EarlyChange']) {
          const v = this.resolve(parms.map.get(key), view);
          if (isNum(v)) params[key] = v;
        }
      }
      return { name: canonicalFilter(n), params };
    });
  }

  /** /Name of a Crypt filter ('Identity' when it has none), or null if there is no Crypt filter. */
  private cryptFilterName(dict: PdfDict): string | null {
    const f = this.resolve(dict.map.get('Filter'));
    const list = isArray(f) ? f.items.map((x) => this.resolve(x)) : [f];
    const at = list.findIndex((x) => isName(x, 'Crypt'));
    if (at < 0) return null;
    const dp = this.resolve(dict.map.get('DecodeParms'));
    const parms = isArray(dp) ? this.resolve(dp.items[at]) : dp;
    const name = isDict(parms) ? this.resolve(parms.map.get('Name')) : undefined;
    return isName(name) ? name.v : 'Identity';
  }

  /** The stream's bytes as stored (still encrypted and filtered). */
  rawBytes(rec: ObjRecord): Uint8Array {
    return rec.stream
      ? this.bytes.subarray(rec.stream.dataStart, rec.stream.dataEnd)
      : new Uint8Array(0);
  }

  /** The bytes after decryption but before the filters. */
  decryptedBytes(rec: ObjRecord): { data: Uint8Array; encrypted: boolean } {
    const raw = this.rawBytes(rec);
    const dict = rec.value;
    if (!this.encrypt || !isDict(dict)) return { data: raw, encrypted: false };
    if (isName(dict.map.get('Type'), 'XRef')) return { data: raw, encrypted: false };
    if (!this.decryptor) return { data: raw, encrypted: true };
    const data = this.decryptor.stream(rec.num, rec.gen, raw, {
      cryptName: this.cryptFilterName(dict),
      metadata: isName(dict.map.get('Type'), 'Metadata'),
    });
    return { data, encrypted: false };
  }

  /** The decoded data of a stream, at most `limit` bytes. */
  decode(rec: ObjRecord, limit = MAX_STREAM): DecodeInfo {
    const dict = rec.value;
    if (!isDict(dict) || !rec.stream) return noDecode(new Uint8Array(0), false);
    const { data: stored, encrypted } = this.decryptedBytes(rec);
    if (encrypted) return { ...noDecode(new Uint8Array(0), true), rawLength: stored.length };
    const room = Math.max(0, Math.min(limit, DECODE_BUDGET - this.decodedTotal));
    const out = decodeFilters(stored, this.filtersOf(dict), room);
    this.decodedTotal += out.data.length;
    if (room < limit && out.truncated) out.error ??= 'budget';
    return { ...out, rawLength: stored.length, encrypted: false };
  }

  // ----- what lies between and around the objects -----

  /** Comments and unexplained data outside the objects, the xref tables and the trailers. */
  gaps(limit = 200): Gap[] {
    const out: Gap[] = [];
    const { bytes } = this;
    const lastEof = this.eofs[this.eofs.length - 1];
    const limitEnd = lastEof !== undefined ? this.afterEof(lastEof) : bytes.length;
    const intervals: [number, number][] = [];
    let from = Math.max(0, this.headerAt);
    for (const r of this.records) {
      if (r.offset > from) intervals.push([from, Math.min(r.offset, limitEnd)]);
      from = Math.max(from, r.end);
    }
    if (from < limitEnd) intervals.push([from, limitEnd]);
    for (const [a, b] of intervals) {
      let p = a;
      while (p < b && out.length < limit) {
        const c = bytes[p]!;
        if (isSpace(c)) {
          p++;
          continue;
        }
        if (c === 0x25) {
          let q = p;
          while (q < b && bytes[q] !== 10 && bytes[q] !== 13) q++;
          const text = latin1Decode(bytes.subarray(p, Math.min(q, p + 300)));
          let binaryMarker = q - p >= 5;
          for (let i = 1; i < Math.min(q - p, 12); i++)
            if (bytes[p + i]! < 0x80) binaryMarker = false;
          if (!text.startsWith('%PDF-') && !text.startsWith('%%EOF') && !binaryMarker) {
            out.push({ offset: p, length: q - p, kind: 'comment', text });
          }
          p = q;
          continue;
        }
        const word = readWord(bytes, p, b);
        if (word === 'startxref') {
          const lx = new Lexer(bytes, p + 9, b);
          lx.readValue();
          p = Math.max(lx.pos, p + 9);
          continue;
        }
        if (word === 'xref') {
          const sec = this.parseTable(p);
          if (sec) {
            p = sec.end;
            continue;
          }
        }
        if (word === 'trailer') {
          try {
            const lx = new Lexer(bytes, p + 7, b);
            lx.readValue();
            p = Math.max(lx.pos, p + 7);
            continue;
          } catch (e) {
            if (!(e instanceof PdfSyntaxError)) throw e;
          }
        }
        let q = p;
        while (q < b && bytes[q] !== 10 && bytes[q] !== 13) q++;
        out.push({
          offset: p,
          length: q - p,
          kind: 'data',
          text: latin1Decode(bytes.subarray(p, Math.min(q, p + 300))),
        });
        p = Math.max(q, p + 1);
      }
    }
    return out;
  }

  /** Bytes after the last %%EOF that are not white space. */
  trailingData(): { offset: number; length: number } | null {
    const last = this.eofs[this.eofs.length - 1];
    if (last === undefined) return null;
    const start = this.afterEof(last);
    let end = this.bytes.length;
    while (end > start && isSpace(this.bytes[end - 1])) end--;
    return end > start ? { offset: start, length: end - start } : null;
  }

  /** Bytes in front of the %PDF- header. */
  leadingData(): { offset: number; length: number } | null {
    return this.headerAt > 0 ? { offset: 0, length: this.headerAt } : null;
  }

  /** Is the byte position inside the data of a stream? */
  inStream(pos: number): boolean {
    const list = this.streamRangesList;
    let lo = 0;
    let hi = list.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const s = list[mid]!;
      if (pos < s.start) hi = mid - 1;
      else if (pos >= s.end) lo = mid + 1;
      else return true;
    }
    return false;
  }

  /** Stream data ranges in file order, for scans that must skip them. */
  get streamRanges(): readonly { start: number; end: number }[] {
    return this.streamRangesList;
  }
}

function applySection(view: XrefMap, sec: XrefSection): void {
  for (const [num, e] of sec.entries) view.set(num, e);
  if (sec.hybrid) {
    for (const [num, e] of sec.hybrid) {
      const own = sec.entries.get(num);
      if (!own || own.kind === 'f') view.set(num, e);
    }
  }
}

function readWord(buf: Uint8Array, at: number, end: number): string {
  let q = at;
  while (q < end && q < at + 16 && isRegular(buf[q])) q++;
  return latin1Decode(buf.subarray(at, q));
}

/** Copy of a value with its strings passed through `fn`. */
function decryptStrings(v: PdfValue, fn: (b: Uint8Array) => Uint8Array, depth: number): PdfValue {
  if (depth > 64 || v === null || typeof v !== 'object') return v;
  switch (v.k) {
    case 'str':
      return { k: 'str', b: fn(v.b), hex: v.hex };
    case 'arr':
      return { k: 'arr', items: v.items.map((x) => decryptStrings(x, fn, depth + 1)) };
    case 'dict': {
      const map = new Map<string, PdfValue>();
      for (const [key, value] of v.map) map.set(key, decryptStrings(value, fn, depth + 1));
      return { k: 'dict', map };
    }
    default:
      return v;
  }
}
