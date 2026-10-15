/**
 * The object table, the stream table (every stream decoded for a size, a kind and a preview), the
 * search through decoded data, and the revision table (what each save added, changed or deleted,
 * and the text of every page as that revision saw it).
 */
import { latin1Decode, printableRatio, toHex } from '../../lib/bytes';
import { identify } from '../../lib/signatures';
import type { ObjRecord, PdfDoc, Revision } from './_pdf-doc';
import { typeLabel, type Reach } from './_pdf-find';
import { formatValue, isDict, isName, isNum, type PdfDict } from './_pdf-lex';
import {
  collectPages,
  extractPageText,
  layoutText,
  looksLikeContent,
  pageTextCache,
  type PageInfo,
} from './_pdf-text';

export interface Note {
  key: string;
  params?: Record<string, string | number>;
}

// ---------- the object table ----------

export interface ObjectRow {
  num: number;
  gen: number;
  /** Byte offset in the file, or the object stream that holds it. */
  offset: number | null;
  packedIn: number | null;
  packedIndex: number | null;
  label: string;
  stream: { stored: number; declared: number | null } | null;
  state: 'current' | 'old' | 'deleted' | 'unlisted';
  revision: number;
  unreferenced: boolean;
}

function revisionAt(doc: PdfDoc, offset: number): number {
  for (const r of doc.revisions) if (offset >= r.start && offset < r.end) return r.index;
  return doc.revisions[doc.revisions.length - 1]?.index ?? 1;
}

export function objectRows(
  doc: PdfDoc,
  reach: Map<number, Reach>,
  contentOf: Map<number, number>,
): ObjectRow[] {
  const view = doc.view;
  const rows: ObjectRow[] = [];
  for (const rec of doc.records) {
    const e = view.get(rec.num);
    let state: ObjectRow['state'] = 'unlisted';
    if (doc.recovered) {
      const list = doc.byNum.get(rec.num);
      state = list && list[list.length - 1] === rec ? 'current' : 'old';
    } else if (e?.kind === 'f') state = 'deleted';
    else if (e) state = e.kind === 'n' && doc.recordFor(rec.num, e) === rec ? 'current' : 'old';
    const via = reach.get(rec.num)?.via ?? null;
    let label = typeLabel(rec.value, !!rec.stream, via);
    const page = contentOf.get(rec.num);
    if (page !== undefined && label === 'stream') label = 'page content';
    rows.push({
      num: rec.num,
      gen: rec.gen,
      offset: rec.offset,
      packedIn: null,
      packedIndex: null,
      label,
      stream: rec.stream
        ? { stored: rec.stream.dataEnd - rec.stream.dataStart, declared: rec.stream.declared }
        : null,
      state,
      revision: revisionAt(doc, rec.offset),
      unreferenced: state === 'current' && !reach.has(rec.num) && !isRootLike(doc, rec),
    });
  }
  for (const [num, e] of [...view].sort((a, b) => a[0] - b[0])) {
    if (e.kind !== 'c') continue;
    const value = doc.getObject(num, view);
    const via = reach.get(num)?.via ?? null;
    rows.push({
      num,
      gen: 0,
      offset: null,
      packedIn: e.a,
      packedIndex: e.b,
      label: typeLabel(value, false, via),
      stream: null,
      state: 'current',
      revision: 0,
      unreferenced: !reach.has(num),
    });
  }
  return rows;
}

/** The catalog, the Info dictionary and the like are roots: they are never "unreferenced". */
function isRootLike(doc: PdfDoc, rec: ObjRecord): boolean {
  for (const key of ['Root', 'Info', 'Encrypt']) {
    const v = doc.trailer.map.get(key);
    if (v && typeof v === 'object' && v.k === 'ref' && v.num === rec.num) return true;
  }
  return isDict(rec.value) && isName(rec.value.map.get('Type'), 'XRef');
}

// ---------- the stream table ----------

export interface StreamRow {
  rec: ObjRecord;
  label: string;
  state: ObjectRow['state'];
  filters: string;
  stored: number;
  decoded: number;
  /** The decoded size is a lower bound: the stream was cut at the limit. */
  capped: boolean;
  kind: string;
  preview: string;
  notes: Note[];
  image: { codec: string; width: number; height: number } | null;
}

export interface SearchHit {
  num: number;
  where: 'stream' | 'object';
  offset: number;
  context: string;
}

export type Matcher = (text: string) => { index: number; length: number }[];

/** `/regex/flags` or plain text (matched ignoring case). */
export function makeMatcher(query: string): Matcher | null {
  const q = query.trim();
  if (q === '') return null;
  const m = /^\/(.+)\/([a-z]*)$/s.exec(q);
  if (m) {
    const flags = m[2]!.includes('g') ? m[2]! : `${m[2]!}g`;
    const re = new RegExp(m[1]!, flags);
    return (text) => {
      const out: { index: number; length: number }[] = [];
      re.lastIndex = 0;
      for (let hit = re.exec(text); hit && out.length < 20; hit = re.exec(text)) {
        out.push({ index: hit.index, length: hit[0].length });
        if (hit[0].length === 0) re.lastIndex++;
      }
      return out;
    };
  }
  const needle = q.toLowerCase();
  return (text) => {
    const hay = text.toLowerCase();
    const out: { index: number; length: number }[] = [];
    for (
      let i = hay.indexOf(needle);
      i >= 0 && out.length < 20;
      i = hay.indexOf(needle, i + needle.length)
    ) {
      out.push({ index: i, length: needle.length });
    }
    return out;
  };
}

const PREVIEW_LIMIT = 4 * 1024 * 1024;
const SEARCH_LIMIT = 2 * 1024 * 1024;
export const MAX_STREAM_ROWS = 4000;

const clean = (s: string) => s.replace(/\p{Cc}/gu, '·');

function textPreview(data: Uint8Array, max = 100): string {
  return clean(
    latin1Decode(data.subarray(0, max * 2))
      .replace(/\s+/g, ' ')
      .trim(),
  ).slice(0, max);
}

/** What the decoded bytes are, in a few words. */
export function sniffKind(data: Uint8Array): string {
  if (data.length === 0) return 'empty';
  const sig = identify(data.subarray(0, 64)).find((s) => !s.weak);
  if (sig) return `file:${sig.id}`;
  if (data.length > 40 && latin1Decode(data.subarray(36, 40)) === 'acsp') return 'icc';
  const head = latin1Decode(data.subarray(0, 256));
  if (/^\s*<\?xml|^\s*<x:xmpmeta|^\s*<\?xpacket/.test(head)) return 'xml';
  if (
    /begincmap|beginbfchar|beginbfrange|begincodespacerange/.test(
      latin1Decode(data.subarray(0, 2048)),
    )
  ) {
    return 'cmap';
  }
  if (looksLikeContent(data)) return 'content';
  if (/^%!PS-AdobeFont|^%!FontType1/.test(head)) return 'font';
  if (printableRatio(data.subarray(0, 4096)) > 0.92) return 'text';
  return 'binary';
}

const FILTER_LABEL = (name: string): string => name.replace(/Decode$/, '');

function imageInfo(doc: PdfDoc, dict: PdfDict): { width: number; height: number } | null {
  if (!isName(doc.resolve(dict.map.get('Subtype')), 'Image')) return null;
  const w = doc.resolve(dict.map.get('Width'));
  const h = doc.resolve(dict.map.get('Height'));
  return isNum(w) && isNum(h) ? { width: w, height: h } : null;
}

export function streamRows(
  doc: PdfDoc,
  objects: ObjectRow[],
  reach: Map<number, Reach>,
  contentOf: Map<number, number>,
  matcher: Matcher | null,
): { rows: StreamRow[]; hits: SearchHit[]; total: number } {
  const stateOf = new Map<number, ObjectRow['state']>();
  for (const o of objects) if (o.offset !== null) stateOf.set(o.offset, o.state);
  const rows: StreamRow[] = [];
  const hits: SearchHit[] = [];
  let total = 0;
  const search = (num: number, where: SearchHit['where'], text: string) => {
    if (!matcher || hits.length >= 200) return;
    for (const m of matcher(text)) {
      if (hits.length >= 200) break;
      const a = Math.max(0, m.index - 30);
      hits.push({
        num,
        where,
        offset: m.index,
        context: clean(text.slice(a, m.index + m.length + 50)),
      });
    }
  };
  for (const rec of doc.records) {
    if (!isDict(rec.value)) continue;
    if (!rec.stream) {
      if (matcher) search(rec.num, 'object', formatValue(doc.decryptedValue(rec), 20000));
      continue;
    }
    total++;
    const dict = rec.value;
    const dec = doc.decode(rec, PREVIEW_LIMIT);
    const notes: Note[] = [];
    const loc = rec.stream;
    if (loc.declared !== null && !loc.lengthOk) {
      notes.push({
        key: 'note.lengthMismatch',
        params: { declared: loc.declared, actual: loc.dataEnd - loc.dataStart },
      });
    } else if (loc.declared === null) notes.push({ key: 'note.noLength' });
    if (!loc.hasEndstream) notes.push({ key: 'note.noEndstream' });
    if (dec.encrypted) notes.push({ key: 'note.stillEncrypted' });
    if (dec.error) {
      notes.push({
        key: dec.error === 'budget' ? 'note.budget' : 'note.filterError',
        params: { message: dec.error },
      });
    }
    if (dec.stoppedAt && !dec.image) {
      notes.push({ key: 'note.unknownFilter', params: { name: dec.stoppedAt } });
    }
    const img = imageInfo(doc, dict);
    let image: StreamRow['image'] = null;
    if (dec.image) {
      image = { codec: dec.image, width: img?.width ?? 0, height: img?.height ?? 0 };
      notes.push({
        key: 'note.imageCodec',
        params: { codec: dec.image, size: img ? `${img.width}×${img.height}` : '?' },
      });
    } else if (img) {
      notes.push({ key: 'note.imageRaw', params: { size: `${img.width}×${img.height}` } });
    }
    const kind = dec.encrypted ? 'encrypted' : sniffKind(dec.data);
    const text =
      kind === 'text' || kind === 'content' || kind === 'xml' || kind === 'cmap' || kind === 'font';
    const preview = dec.encrypted
      ? toHex(doc.rawBytes(rec).subarray(0, 12), ' ')
      : text
        ? textPreview(dec.data)
        : toHex(dec.data.subarray(0, 16), ' ');
    if (matcher && !dec.encrypted) {
      search(rec.num, 'stream', latin1Decode(dec.data.subarray(0, SEARCH_LIMIT)));
      search(rec.num, 'object', formatValue(doc.decryptedValue(rec), 20000));
    }
    const via = reach.get(rec.num)?.via ?? null;
    let label = typeLabel(dict, true, via);
    if (contentOf.has(rec.num) && label === 'stream') label = 'page content';
    rows.push({
      rec,
      label,
      state: stateOf.get(rec.offset) ?? 'unlisted',
      filters: doc
        .filtersOf(dict)
        .map((f) => FILTER_LABEL(f.name))
        .join('+'),
      stored: loc.dataEnd - loc.dataStart,
      decoded: dec.data.length,
      capped: dec.truncated,
      kind,
      preview,
      notes,
      image,
    });
  }
  // streams inside nothing but object streams cannot exist; objects packed in ObjStm are searched too
  if (matcher) {
    for (const rec of doc.records) {
      if (!isDict(rec.value) || !isName(rec.value.map.get('Type'), 'ObjStm')) continue;
      for (const m of doc.objStmMembers(rec)) search(m.num, 'object', formatValue(m.value, 20000));
    }
  }
  return { rows: rows.slice(0, MAX_STREAM_ROWS), hits, total };
}

// ---------- revisions ----------

/** The records whose offset is in [start, end): they are in file order, so a binary search finds them. */
function recordsBetween(doc: PdfDoc, start: number, end: number): ObjRecord[] {
  const list = doc.records;
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid]!.offset < start) lo = mid + 1;
    else hi = mid;
  }
  const out: ObjRecord[] = [];
  for (let i = lo; i < list.length && list[i]!.offset < end; i++) out.push(list[i]!);
  return out;
}

export interface RevisionRow {
  revision: Revision;
  size: number;
  xref: 'table' | 'stream' | 'hybrid' | 'rebuilt';
  written: number;
  added: { num: number; label: string }[];
  changed: { num: number; label: string }[];
  deleted: number[];
}

export interface RevisionPageText {
  revision: number;
  /** Text of each page as that revision saw it (hidden text included). */
  pages: string[];
}

export function revisionRows(doc: PdfDoc): {
  rows: RevisionRow[];
  pages: PageInfo[][];
  texts: RevisionPageText[];
  limited: boolean;
} {
  const rows: RevisionRow[] = [];
  const seen = new Set<number>();
  const pagesByRevision: PageInfo[][] = [];
  const texts: RevisionPageText[] = [];
  const MAX_TEXT_REVISIONS = 25;
  const special = new Map<number, string>();
  for (const key of ['Root', 'Info', 'Encrypt']) {
    const v = doc.trailer.map.get(key);
    if (v && typeof v === 'object' && v.k === 'ref') special.set(v.num, `/${key}`);
  }
  const textFrom = Math.max(0, doc.revisions.length - MAX_TEXT_REVISIONS);
  doc.revisions.forEach((rev, i) => {
    const view = doc.viewOf(rev);
    const pages = collectPages(doc, view);
    pagesByRevision.push(pages);
    const contentOf = new Map<number, number>();
    for (const p of pages) for (const n of p.contents) contentOf.set(n, p.index);
    const written = recordsBetween(doc, rev.start, rev.end);
    const lastOf = new Map<number, ObjRecord>();
    for (const r of written) lastOf.set(r.num, r);
    const added: RevisionRow['added'] = [];
    const changed: RevisionRow['changed'] = [];
    const done = new Set<number>();
    for (const r of written) {
      if (done.has(r.num)) continue;
      done.add(r.num);
      const latest = lastOf.get(r.num) ?? r;
      let label = typeLabel(latest.value, !!latest.stream, special.get(latest.num) ?? null);
      const page = contentOf.get(latest.num);
      if (page !== undefined && label === 'stream') label = `page ${page} content`;
      (seen.has(r.num) ? changed : added).push({ num: r.num, label });
    }
    const deleted: number[] = [];
    for (const [num, e] of rev.delta) {
      if (e.kind === 'f' && seen.has(num) && num !== 0) deleted.push(num);
    }
    // objects packed in object streams count as written by the revision that wrote the stream
    for (const [num, e] of rev.delta) {
      if (e.kind === 'c' && !done.has(num)) {
        const wasThere = seen.has(num);
        (wasThere ? changed : added).push({
          num,
          label: typeLabel(doc.getObject(num, view), false, null),
        });
        done.add(num);
      }
    }
    for (const n of done) seen.add(n);
    const first = rev.sections[0];
    rows.push({
      revision: rev,
      size: rev.end - rev.start,
      xref: !first ? 'rebuilt' : rev.sections.length > 1 || first.hybrid ? 'hybrid' : first.kind,
      written: written.length,
      added,
      changed,
      deleted,
    });
    if (i >= textFrom) {
      const cache = pageTextCache(doc, view);
      const limit = Math.min(pages.length, 200);
      const pageTexts: string[] = [];
      for (let p = 0; p < limit; p++) {
        pageTexts.push(layoutText(extractPageText(doc, view, pages[p]!, cache).runs));
      }
      texts.push({ revision: rev.index, pages: pageTexts });
    }
  });
  return {
    rows,
    pages: pagesByRevision,
    texts,
    limited: doc.revisions.length > MAX_TEXT_REVISIONS,
  };
}
