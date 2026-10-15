/**
 * The PDF analyzer's output: reads the file with the document model (_pdf-doc), the findings
 * (_pdf-find), the streams and revisions (_pdf-streams) and the text (_pdf-text), and arranges the
 * result as the blocks the app shows. Every sentence goes through toolT('pdf-analyzer').
 */
import { ToolError } from '../../core/errors';
import type { Output } from '../../core/types';
import { signatureName, toolT } from '../../i18n/tool-text';
import { formatSize, toHex } from '../../lib/bytes';
import { identify, SIGNATURES } from '../../lib/signatures';
import { DECODE_BUDGET, PdfDoc, type ObjRecord, type XEntry } from './_pdf-doc';
import { permissionsAllowed, PERMISSION_BITS, encryptionLabel } from './_pdf-crypt';
import {
  computeReach,
  type Reach,
  findActions,
  findAnnotations,
  findEmbedded,
  findFields,
  findScripts,
  findXfa,
  keywordCounts,
  pathOf,
  readInfo,
  readXmp,
  textOfBytes,
  typeLabel,
  unusualEntries,
  xmpFields,
} from './_pdf-find';
import { formatPretty, formatValue, isDict, isName, nameOf } from './_pdf-lex';
import {
  makeMatcher,
  objectRows,
  revisionRows,
  sniffKind,
  streamRows,
  type Note,
  type ObjectRow,
  type StreamRow,
} from './_pdf-streams';
import {
  extractPageText,
  layoutText,
  looksLikeContent,
  pageTextCache,
  rawContentText,
  type HiddenReason,
  type PageText,
} from './_pdf-text';

const T = toolT('pdf-analyzer');

export interface Settings {
  object: number;
  revision: number;
  password: string;
  search: string;
  rebuild: boolean;
  all: boolean;
}

type Row = (string | number)[];
const MAX_ROWS = 5000;
const MAX_FILE_BYTES = 192 * 1024 * 1024;

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const clean = (s: string) =>
  s
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** A copy that owns its buffer: a view of the input would drag the whole file across the worker. */
const own = (b: Uint8Array): Uint8Array => (b.byteLength === b.buffer.byteLength ? b : b.slice());

function note(level: 'info' | 'warn' | 'error' | 'success', text: string): Output {
  return { type: 'note', level, text };
}

/** The sentence of a note raised by the stream pass (keys written out so they can be checked). */
function noteText(n: Note): string {
  const p = n.params;
  switch (n.key) {
    case 'note.lengthMismatch':
      return T('note.lengthMismatch', p);
    case 'note.noLength':
      return T('note.noLength');
    case 'note.noEndstream':
      return T('note.noEndstream');
    case 'note.stillEncrypted':
      return T('note.stillEncrypted');
    case 'note.budget':
      return T('note.budget');
    case 'note.filterError':
      return T('note.filterError', p);
    case 'note.unknownFilter':
      return T('note.unknownFilter', p);
    case 'note.imageCodec':
      return T('note.imageCodec', p);
    default:
      return T('note.imageRaw', p);
  }
}

function xrefLabel(kind: 'table' | 'stream' | 'hybrid' | 'rebuilt'): string {
  switch (kind) {
    case 'table':
      return T('xref.table');
    case 'stream':
      return T('xref.stream');
    case 'hybrid':
      return T('xref.hybrid');
    default:
      return T('xref.rebuilt');
  }
}

function recoveredNote(why: string | null): string {
  switch (why) {
    case 'forced':
      return T('note.recovered.forced');
    case 'noStartxref':
      return T('note.recovered.noStartxref');
    case 'badStartxref':
      return T('note.recovered.badStartxref');
    default:
      return T('note.recovered.mismatch');
  }
}

function chainNote(why: string): string {
  return why === 'loop' ? T('note.chain.loop') : T('note.chain.badPrev');
}

function fieldFlagLabel(f: string): string {
  switch (f) {
    case 'readOnly':
      return T('fieldFlag.readOnly');
    case 'required':
      return T('fieldFlag.required');
    case 'password':
      return T('fieldFlag.password');
    default:
      return T('fieldFlag.hidden');
  }
}

function annotFlagLabel(f: string): string {
  switch (f) {
    case 'invisible':
      return T('annotFlag.invisible');
    case 'hidden':
      return T('annotFlag.hidden');
    default:
      return T('annotFlag.noView');
  }
}

function permissionLabel(p: string): string {
  switch (p) {
    case 'print':
      return T('perm.print');
    case 'modify':
      return T('perm.modify');
    case 'copy':
      return T('perm.copy');
    case 'annotate':
      return T('perm.annotate');
    case 'fillForms':
      return T('perm.fillForms');
    case 'accessibility':
      return T('perm.accessibility');
    case 'assemble':
      return T('perm.assemble');
    default:
      return T('perm.printHighQuality');
  }
}

// ---------- names and kinds ----------

const EXT: Record<string, string> = {
  jpeg: 'jpg',
  jpeg2000: 'jp2',
  jbig2: 'jb2',
  ccitt: 'ccitt',
};

function extFor(kind: string, codec: string | null): string {
  if (codec) return EXT[codec] ?? 'bin';
  if (kind.startsWith('file:')) {
    const id = kind.slice(5);
    return SIGNATURES.find((s) => s.id === id)?.ext ?? 'bin';
  }
  switch (kind) {
    case 'text':
    case 'content':
    case 'cmap':
      return 'txt';
    case 'xml':
      return 'xml';
    case 'icc':
      return 'icc';
    case 'font':
      return 'pfa';
    default:
      return 'bin';
  }
}

function kindLabel(kind: string): string {
  if (kind.startsWith('file:')) {
    const id = kind.slice(5);
    const sig = SIGNATURES.find((s) => s.id === id);
    return sig ? signatureName(sig) : id.toUpperCase();
  }
  switch (kind) {
    case 'empty':
      return T('kind.empty');
    case 'content':
      return T('kind.content');
    case 'text':
      return T('kind.text');
    case 'xml':
      return T('kind.xml');
    case 'cmap':
      return T('kind.cmap');
    case 'icc':
      return T('kind.icc');
    case 'font':
      return T('kind.font');
    case 'encrypted':
      return T('kind.encrypted');
    default:
      return T('kind.binary');
  }
}

function stateLabel(state: ObjectRow['state']): string {
  switch (state) {
    case 'current':
      return T('state.current');
    case 'old':
      return T('state.old');
    case 'deleted':
      return T('state.deleted');
    default:
      return T('state.unlisted');
  }
}

function hiddenLabel(r: HiddenReason): string {
  switch (r) {
    case 'render':
      return T('hidden.render');
    case 'clip':
      return T('hidden.clip');
    case 'transparent':
      return T('hidden.transparent');
    case 'white':
      return T('hidden.white');
    case 'tiny':
      return T('hidden.tiny');
    case 'offpage':
      return T('hidden.offpage');
    case 'layer':
      return T('hidden.layer');
    case 'ocr':
      return T('hidden.ocr');
    default:
      return T('hidden.covered');
  }
}

/** Text nobody can see (an OCR layer is hidden too, but it is the text of its page). */
const isOcr = (r: PageText['runs'][number]): boolean =>
  r.hidden.length === 1 && r.hidden[0] === 'ocr';
const isHidden = (r: PageText['runs'][number]): boolean => r.hidden.length > 0 && !isOcr(r);

// ---------- the entry point ----------

export async function analyzePdf(bytes: Uint8Array, s: Settings): Promise<Output[]> {
  if (bytes.length === 0) throw new ToolError(T('error.empty'));
  const doc = await PdfDoc.open(bytes, {
    passwords: s.password ? [s.password] : [],
    rebuild: s.rebuild,
  });
  if (doc.headerAt < 0 && doc.records.length === 0) throw new ToolError(T('error.notPdf'));

  const out: Output[] = [];
  const reach = computeReach(doc);
  const revisions = revisionRows(doc);
  const finalPages = revisions.pages[revisions.pages.length - 1] ?? [];
  const contentOf = new Map<number, number>();
  for (const p of finalPages) for (const n of p.contents) contentOf.set(n, p.index);

  const objects = objectRows(doc, reach, contentOf);
  const matcher = (() => {
    try {
      return makeMatcher(s.search);
    } catch {
      throw new ToolError(T('error.regex', { query: s.search }));
    }
  })();
  const streams = streamRows(doc, objects, reach, contentOf, matcher);

  // text of the pages as the last revision shows it
  const cache = pageTextCache(doc, doc.view);
  const texts: PageText[] = [];
  const maxPages = Math.min(finalPages.length, 1000);
  for (let i = 0; i < maxPages; i++) {
    texts.push(extractPageText(doc, doc.view, finalPages[i]!, cache));
  }
  const hiddenRuns = texts.flatMap((t) =>
    t.runs.filter(isHidden).map((r) => ({ page: t.page.index, run: r })),
  );
  const ocrCount = texts.reduce((n, t) => n + t.runs.filter(isOcr).length, 0);

  // The strings and streams of a locked file are ciphertext: nothing read from them means anything.
  const locked = doc.encrypt !== null && doc.decryptor === null;
  const scripts = locked ? [] : findScripts(doc, reach);
  const embedded = locked ? [] : findEmbedded(doc, reach);
  const actions = locked ? [] : findActions(doc, reach);
  const fields = locked ? [] : findFields(doc);
  const xfa = locked ? [] : findXfa(doc);
  const annotations = locked ? [] : findAnnotations(doc, finalPages);
  const info = locked ? [] : readInfo(doc);
  const xmp = locked ? null : readXmp(doc);
  const unusual = locked ? [] : unusualEntries(doc, finalPages);
  const counts = keywordCounts(doc);
  const gaps = doc.gaps();
  const trailing = doc.trailingData();
  const leading = doc.leadingData();

  out.push(...summary(doc, finalPages.length, objects, streams.total, info));
  out.push(
    ...findingNotes({
      doc,
      objects,
      streams: streams.rows,
      hiddenCount: hiddenRuns.length,
      ocrCount,
      scripts: scripts.length,
      embedded: embedded.length,
      actions,
      gaps: gaps.length,
      trailing,
      leading,
      revisionsChanged: revisions.texts,
      pageCount: finalPages.length,
      texts,
      truncatedPages: finalPages.length > maxPages,
    }),
  );

  if (s.object > 0) out.push(...inspectObject(doc, s.object, s.revision, reach, contentOf));
  if (matcher) out.push(...searchResults(streams.hits, s.search));

  out.push(...revisionBlocks(doc, revisions, bytes));
  out.push(...hiddenTextBlocks(hiddenRuns));
  out.push(...textBlocks(texts));
  out.push(...orphanContentBlocks(doc, revisions.pages));
  out.push(...scriptBlocks(scripts));
  out.push(...embeddedBlocks(embedded));
  out.push(...actionBlocks(actions));
  out.push(...formBlocks(fields, xfa));
  out.push(...annotationBlocks(annotations));
  out.push(...metadataBlocks(info, xmp, unusual));
  out.push(...encryptionBlocks(doc));
  out.push(...countBlocks(counts));
  out.push(...structureBlocks(doc, gaps, trailing, leading, bytes));
  out.push(...objectBlocks(objects));
  out.push(...streamBlocks(doc, streams.rows, streams.total, s.all));
  return out;
}

// ---------- summary and notes ----------

function summary(
  doc: PdfDoc,
  pageCount: number,
  objects: ObjectRow[],
  streamCount: number,
  info: ReturnType<typeof readInfo>,
): Output[] {
  const e: [string, string][] = [];
  e.push([T('kv.size'), `${formatSize(doc.bytes.length)} (${doc.bytes.length})`]);
  const catalog = doc.dictOf(doc.trailer.map.get('Root'));
  const catalogVersion = nameOf(doc.resolve(catalog?.map.get('Version')));
  e.push([
    T('kv.version'),
    doc.version
      ? catalogVersion && catalogVersion !== doc.version
        ? T('value.versionBoth', { header: doc.version, catalog: catalogVersion })
        : doc.version
      : T('value.noHeader'),
  ]);
  e.push([T('kv.pages'), String(pageCount)]);
  const packed = objects.filter((o) => o.packedIn !== null).length;
  const older = objects.filter((o) => o.packedIn === null && o.state !== 'current').length;
  e.push([
    T('kv.objects'),
    T('value.objects', { file: doc.records.length, packed, older, streams: streamCount }),
  ]);
  e.push([T('kv.revisions'), String(doc.revisions.length)]);
  const first = doc.sections[0];
  e.push([
    T('kv.structure'),
    doc.recovered
      ? T('value.structureRebuilt')
      : first?.kind === 'stream'
        ? T('value.structureStream')
        : doc.sections.some((s) => s.hybrid)
          ? T('value.structureHybrid')
          : T('value.structureTable'),
  ]);
  if (doc.linearized) e.push([T('kv.linearized'), T('value.linearized')]);
  if (doc.encrypt) {
    e.push([
      T('kv.encryption'),
      `${encryptionLabel(doc.encrypt)} · ${
        doc.unlocked?.ok
          ? doc.unlocked.password === 'empty'
            ? T('value.openedEmpty')
            : T('value.openedGiven')
          : T('value.locked')
      }`,
    ]);
  }
  for (const key of ['Title', 'Author', 'Creator', 'Producer']) {
    const item = info.find((x) => x.key === key);
    if (item?.value) e.push([key, cut(item.value, 120)]);
  }
  return [{ type: 'kv', label: T('label.summary'), entries: e }];
}

interface NoteInput {
  doc: PdfDoc;
  objects: ObjectRow[];
  streams: StreamRow[];
  hiddenCount: number;
  ocrCount: number;
  scripts: number;
  embedded: number;
  actions: ReturnType<typeof findActions>;
  gaps: number;
  trailing: { offset: number; length: number } | null;
  leading: { offset: number; length: number } | null;
  revisionsChanged: ReturnType<typeof revisionRows>['texts'];
  pageCount: number;
  texts: PageText[];
  truncatedPages: boolean;
}

function findingNotes(n: NoteInput): Output[] {
  const { doc } = n;
  const out: Output[] = [];
  if (doc.encrypt) {
    if (doc.unlocked?.ok) {
      out.push(
        note(
          'info',
          doc.unlocked.password === 'empty'
            ? T('note.openedEmpty', { method: encryptionLabel(doc.encrypt) })
            : T('note.openedGiven', { method: encryptionLabel(doc.encrypt) }),
        ),
      );
      if (doc.unlocked.warning) out.push(note('warn', T('note.permsMismatch')));
    } else if (doc.unlocked && !doc.unlocked.ok && doc.unlocked.reason === 'unsupported') {
      out.push(note('error', T('note.encryptedUnsupported', { what: doc.unlocked.detail })));
    } else {
      out.push(note('error', T('note.encryptedLocked', { method: encryptionLabel(doc.encrypt) })));
    }
  }
  if (doc.recovered) {
    out.push(note('warn', recoveredNote(doc.chainProblem)));
  } else if (doc.chainProblem) {
    out.push(note('warn', chainNote(doc.chainProblem)));
  }
  if (doc.scanCut) out.push(note('warn', T('note.scanCut')));
  if (doc.revisions.length > 1 && !doc.linearized) {
    out.push(note('warn', T('note.revisions', { count: doc.revisions.length })));
  }
  const changed = n.revisionsChanged.length > 1 ? hasOlderText(n) : false;
  if (changed) out.push(note('warn', T('note.olderText')));
  if (n.hiddenCount > 0) out.push(note('warn', T('note.hiddenText', { count: n.hiddenCount })));
  if (n.ocrCount > 0) out.push(note('info', T('note.ocrLayer', { count: n.ocrCount })));
  if (n.scripts > 0) out.push(note('warn', T('note.javascript', { count: n.scripts })));
  if (n.embedded > 0) out.push(note('warn', T('note.embedded', { count: n.embedded })));
  const launches = n.actions.filter((a) => a.type === 'Launch' || a.type === 'SubmitForm').length;
  if (launches > 0) out.push(note('warn', T('note.launch', { count: launches })));
  if (n.trailing) {
    out.push(
      note(
        'warn',
        T('note.trailing', { size: formatSize(n.trailing.length), offset: n.trailing.offset }),
      ),
    );
  }
  if (n.leading) {
    out.push(note('warn', T('note.leading', { size: formatSize(n.leading.length) })));
  }
  if (n.gaps > 0) out.push(note('info', T('note.gaps', { count: n.gaps })));
  const orphans = n.objects.filter((o) => o.unreferenced && o.packedIn === null).length;
  if (orphans > 0) out.push(note('info', T('note.unreferenced', { count: orphans })));
  const mismatched = n.streams.filter((r) =>
    r.notes.some((x) => x.key === 'note.lengthMismatch'),
  ).length;
  if (mismatched > 0) out.push(note('warn', T('note.lengths', { count: mismatched })));
  if (doc.decodedTotal >= DECODE_BUDGET) out.push(note('warn', T('note.budget')));
  if (n.truncatedPages) out.push(note('info', T('note.pagesCut', { count: n.pageCount })));
  const noText = n.texts.filter((t) => t.runs.length === 0).length;
  const locked = doc.encrypt !== null && doc.decryptor === null;
  if (!locked && n.pageCount > 0 && noText === n.pageCount) {
    out.push(note('info', T('note.noText')));
  }
  return out;
}

function hasOlderText(n: NoteInput): boolean {
  const last = n.revisionsChanged[n.revisionsChanged.length - 1];
  if (!last) return false;
  return n.revisionsChanged
    .slice(0, -1)
    .some((r) => r.pages.some((t, i) => t.trim() !== '' && t !== last.pages[i]));
}

// ---------- revisions ----------

function revisionBlocks(
  doc: PdfDoc,
  rev: ReturnType<typeof revisionRows>,
  bytes: Uint8Array,
): Output[] {
  if (doc.revisions.length < 2) return [];
  const out: Output[] = [];
  const list = (items: { num: number; label: string }[]) => {
    const shown = items.slice(0, 6).map((i) => `${i.num} ${i.label}`);
    return shown.join(', ') + (items.length > 6 ? ` +${items.length - 6}` : '');
  };
  const rows: Row[] = rev.rows.map((r, i) => [
    r.revision.index,
    `${r.revision.start}–${r.revision.end} · ${formatSize(r.size)}`,
    xrefLabel(r.xref),
    r.written,
    // the original file adds everything: only the later saves are worth listing
    i === 0 ? '' : list(r.added),
    list(r.changed),
    r.deleted.slice(0, 12).join(', '),
  ]);
  out.push({
    type: 'table',
    label: T('label.revisions'),
    columns: [
      T('col.revision'),
      T('col.bytes'),
      T('col.xref'),
      T('col.written'),
      T('col.added'),
      T('col.changed'),
      T('col.deleted'),
    ],
    rows,
    highlight: rows.map((_, i) => i).filter((i) => i > 0),
  });
  if (rev.limited) out.push(note('info', T('note.revisionsLimited')));

  // the text each older revision showed, where it differs from what the last one shows
  const last = rev.texts[rev.texts.length - 1];
  let blocks = 0;
  for (const r of rev.texts.slice(0, -1)) {
    r.pages.forEach((t, i) => {
      if (blocks >= 30 || t.trim() === '' || (last && last.pages[i] === t)) return;
      blocks++;
      out.push({
        type: 'text',
        label: T('label.oldPage', { revision: r.revision, page: i + 1 }),
        value: t,
      });
    });
  }
  // each older revision as a file of its own
  const files: { name: string; data: Uint8Array; note?: string }[] = [];
  let budget = 96 * 1024 * 1024;
  for (const r of doc.revisions.slice(0, -1)) {
    if (r.end > budget) break;
    budget -= r.end;
    files.push({
      name: `revision-${r.index}.pdf`,
      data: bytes.slice(0, r.end),
      note: T('note.revisionFile', { size: formatSize(r.end) }),
    });
  }
  if (files.length > 0) out.push({ type: 'files', label: T('label.revisionFiles'), files });
  return out;
}

// ---------- hidden text and page text ----------

function hiddenTextBlocks(runs: { page: number; run: PageText['runs'][number] }[]): Output[] {
  if (runs.length === 0) return [];
  const rows: Row[] = runs
    .slice(0, MAX_ROWS)
    .map(({ page, run }) => [
      page,
      run.hidden.map(hiddenLabel).join(' + '),
      cut(run.raw ? `${run.text}` : run.text, 300),
      `${Math.round(run.x)}, ${Math.round(run.y)}`,
      Math.round(run.size * 10) / 10,
    ]);
  return [
    {
      type: 'table',
      label: T('label.hiddenText'),
      columns: [
        T('col.page'),
        T('col.reason'),
        T('col.text'),
        T('col.position'),
        T('col.fontSize'),
      ],
      rows,
      highlight: rows.map((_, i) => i),
    },
  ];
}

function textBlocks(texts: PageText[]): Output[] {
  const out: Output[] = [];
  const pages = texts
    .map((t) => ({
      index: t.page.index,
      text: layoutText(t.runs.filter((r) => !isHidden(r))),
    }))
    .filter((p) => p.text.trim() !== '');
  if (pages.length === 0) return out;
  const separate = pages.slice(0, 60);
  for (const p of separate) {
    out.push({ type: 'text', label: T('label.pageText', { page: p.index }), value: p.text });
  }
  const rest = pages.slice(60);
  if (rest.length > 0) {
    const joined = rest.map((p) => `--- ${p.index} ---\n${p.text}`).join('\n\n');
    out.push({
      type: 'text',
      label: T('label.morePages', { from: rest[0]!.index, to: rest[rest.length - 1]!.index }),
      value: joined.slice(0, 400_000),
    });
  }
  if (texts.some((t) => t.runs.some((r) => r.raw))) out.push(note('info', T('note.rawText')));
  out.push(note('info', T('note.textLimits')));
  return out;
}

/** Content streams (page drawing code) that no page of any revision uses: text left behind. */
function orphanContentBlocks(
  doc: PdfDoc,
  pagesByRevision: ReturnType<typeof revisionRows>['pages'],
): Output[] {
  const used = new Set<number>();
  for (const pages of pagesByRevision)
    for (const p of pages) for (const n of p.contents) used.add(n);
  const out: Output[] = [];
  for (const rec of doc.records) {
    if (out.length >= 20) break;
    if (!rec.stream || used.has(rec.num) || !isDict(rec.value)) continue;
    const type = nameOf(rec.value.map.get('Type'));
    const subtype = nameOf(rec.value.map.get('Subtype'));
    if (type === 'XObject' || type === 'ObjStm' || type === 'XRef' || type === 'EmbeddedFile')
      continue;
    if (subtype === 'Form' || subtype === 'Image' || rec.value.map.has('PatternType')) continue;
    const dec = doc.decode(rec, 2 * 1024 * 1024);
    if (dec.encrypted || !looksLikeContent(dec.data)) continue;
    const text = rawContentText(dec.data);
    if (text.trim() === '') continue;
    out.push({ type: 'text', label: T('label.orphanContent', { object: rec.num }), value: text });
  }
  return out;
}

// ---------- JavaScript, files, actions ----------

function scriptBlocks(scripts: ReturnType<typeof findScripts>): Output[] {
  if (scripts.length === 0) return [];
  const out: Output[] = [];
  out.push({
    type: 'table',
    label: T('label.javascript'),
    columns: [T('col.object'), T('col.action'), T('col.length'), T('col.notable'), T('col.where')],
    rows: scripts.map((s) => [
      s.num,
      s.trigger || '-',
      s.source.length,
      s.notable.join(', ') || '-',
      s.where,
    ]),
  });
  out.push(note('info', T('note.neverRun')));
  for (const s of scripts.slice(0, 12)) {
    out.push({
      type: 'text',
      label: T('label.scriptSource', { object: s.num }),
      value: s.source.length > 20000 ? `${s.source.slice(0, 20000)}\n…` : s.source,
    });
  }
  return out;
}

function embeddedBlocks(files: ReturnType<typeof findEmbedded>): Output[] {
  if (files.length === 0) return [];
  const rows: Row[] = files.map((f) => {
    const text = f.kind === null && !f.encrypted ? clean(textOfBytes(f.data.subarray(0, 120))) : '';
    return [
      f.name,
      f.encrypted ? T('value.stillEncrypted') : f.truncated ? `${f.data.length}+` : f.data.length,
      f.kind ? kindLabel(`file:${f.kind}`) : f.mime || kindLabel(sniffKind(f.data)),
      f.description,
      f.encrypted ? '' : text || toHex(f.data.subarray(0, 12), ' '),
      f.where,
    ];
  });
  const names = new Map<string, number>();
  return [
    {
      type: 'table',
      label: T('label.embedded'),
      columns: [
        T('col.name'),
        T('col.size'),
        T('col.type'),
        T('col.description'),
        T('col.preview'),
        T('col.where'),
      ],
      rows,
    },
    {
      type: 'files',
      label: T('label.embeddedFiles'),
      files: files
        .filter((f) => !f.encrypted)
        .map((f) => {
          const base = f.name.replace(/[\\/:*?"<>|\p{Cc}]/gu, '_') || 'file';
          const n = names.get(base) ?? 0;
          names.set(base, n + 1);
          return {
            name: n === 0 ? base : `${n + 1}-${base}`,
            data: own(f.data),
            note: f.truncated ? T('note.cutAtLimit') : undefined,
          };
        }),
    },
  ];
}

function actionBlocks(actions: ReturnType<typeof findActions>): Output[] {
  if (actions.length === 0) return [];
  return [
    {
      type: 'table',
      label: T('label.actions'),
      columns: [T('col.type'), T('col.target'), T('col.where')],
      rows: actions.map((a) => [a.type, a.target, a.where]),
    },
  ];
}

function formBlocks(
  fields: ReturnType<typeof findFields>,
  xfa: { name: string; data: Uint8Array }[],
): Output[] {
  const out: Output[] = [];
  if (fields.length > 0) {
    out.push({
      type: 'table',
      label: T('label.fields'),
      columns: [T('col.field'), T('col.type'), T('col.value'), T('col.default'), T('col.flags')],
      rows: fields.map((f) => [
        f.name,
        f.type,
        cut(f.value, 300),
        cut(f.defaultValue, 200),
        f.flags.map(fieldFlagLabel).join(', '),
      ]),
    });
  }
  if (xfa.length > 0) {
    out.push(note('info', T('note.xfa', { count: xfa.length })));
    out.push({
      type: 'files',
      label: T('label.xfa'),
      files: xfa.map((x) => ({
        name: `${x.name.replace(/[^\w.-]+/g, '_') || 'xfa'}.xml`,
        data: own(x.data),
      })),
    });
  }
  return out;
}

function annotationBlocks(list: ReturnType<typeof findAnnotations>): Output[] {
  if (list.length === 0) return [];
  return [
    {
      type: 'table',
      label: T('label.annotations'),
      columns: [
        T('col.page'),
        T('col.type'),
        T('col.text'),
        T('col.author'),
        T('col.flags'),
        T('col.object'),
      ],
      rows: list.map((a) => [
        a.page,
        a.type,
        cut(a.text, 300),
        a.author,
        a.flags.map(annotFlagLabel).join(', '),
        a.num ?? '',
      ]),
    },
  ];
}

// ---------- metadata, encryption, counts ----------

function metadataBlocks(
  info: ReturnType<typeof readInfo>,
  xmp: string | null,
  unusual: ReturnType<typeof unusualEntries>,
): Output[] {
  const out: Output[] = [];
  if (info.length > 0) {
    out.push({
      type: 'kv',
      label: T('label.info'),
      entries: info.map((i) => [
        i.custom ? `${i.key} (${T('value.custom')})` : i.key,
        cut(i.value, 400),
      ]),
    });
  }
  if (xmp) {
    const fields = xmpFields(xmp);
    if (fields.length > 0)
      out.push({
        type: 'kv',
        label: T('label.xmp'),
        entries: fields.map(([k, v]) => [k, cut(v, 300)]),
      });
    out.push({
      type: 'text',
      label: T('label.xmpSource'),
      value: xmp.length > 20000 ? `${xmp.slice(0, 20000)}\n…` : xmp,
    });
  }
  if (unusual.length > 0) {
    out.push({
      type: 'table',
      label: T('label.unusual'),
      columns: [T('col.where'), T('col.key'), T('col.value')],
      rows: unusual.map((u) => [u.where, u.key, cut(u.value, 300)]),
    });
  }
  return out;
}

function encryptionBlocks(doc: PdfDoc): Output[] {
  const enc = doc.encrypt;
  if (!enc) return [];
  const e: [string, string][] = [];
  e.push([T('kv.handler'), enc.filter + (enc.subFilter ? ` / ${enc.subFilter}` : '')]);
  e.push([T('kv.v'), String(enc.v)]);
  e.push([T('kv.r'), String(enc.r)]);
  e.push([T('kv.keyLength'), T('value.bits', { bits: enc.v >= 5 ? 256 : enc.bits })]);
  if (enc.v >= 4) {
    e.push([T('kv.cryptFilters'), enc.filters.map((f) => `${f.name}: ${f.cfm}`).join(', ') || '-']);
    e.push([T('kv.streamsStrings'), `${enc.stmF} / ${enc.strF}`]);
  }
  const allowed = permissionsAllowed(enc.p);
  e.push([T('kv.allowed'), allowed.map(permissionLabel).join(', ') || '-']);
  e.push([
    T('kv.denied'),
    PERMISSION_BITS.map(([, name]) => name)
      .filter((x) => !allowed.includes(x))
      .map(permissionLabel)
      .join(', ') || '-',
  ]);
  e.push([T('kv.encryptMetadata'), enc.encryptMetadata ? T('value.yes') : T('value.no')]);
  e.push([T('kv.fileId'), toHex(enc.id0)]);
  e.push([T('kv.ownerEntry'), toHex(enc.o.subarray(0, 48))]);
  e.push([T('kv.userEntry'), toHex(enc.u.subarray(0, 48))]);
  const status = doc.unlocked;
  e.push([
    T('kv.status'),
    status?.ok
      ? status.password === 'empty'
        ? T('value.openedEmpty')
        : T('value.openedGiven')
      : status && status.reason === 'unsupported'
        ? T('value.unsupported', { what: status.detail })
        : T('value.locked'),
  ]);
  return [{ type: 'kv', label: T('label.encryption'), entries: e }];
}

function countBlocks(counts: ReturnType<typeof keywordCounts>): Output[] {
  const rows: Row[] = counts.map((c) => [
    c.key,
    c.escaped > 0 ? `${c.file} (${c.escaped})` : c.file,
    c.parsed ?? '',
  ]);
  const highlight = counts
    .map((c, i) => ({ c, i }))
    .filter(
      ({ c }) =>
        c.key.startsWith('/') &&
        (c.file > 0 || (c.parsed ?? 0) > 0) &&
        [
          '/JS',
          '/JavaScript',
          '/OpenAction',
          '/AA',
          '/Launch',
          '/EmbeddedFile',
          '/XFA',
          '/RichMedia',
          '/SubmitForm',
          '/GoToR',
        ].includes(c.key),
    )
    .map(({ i }) => i);
  return [
    {
      type: 'table',
      label: T('label.counts'),
      columns: [T('col.keyword'), T('col.inFile'), T('col.parsed')],
      rows,
      highlight,
    },
    note('info', T('note.counts')),
  ];
}

// ---------- structure: xref, trailer, object streams, gaps, trailing data ----------

function structureBlocks(
  doc: PdfDoc,
  gaps: ReturnType<PdfDoc['gaps']>,
  trailing: { offset: number; length: number } | null,
  leading: { offset: number; length: number } | null,
  bytes: Uint8Array,
): Output[] {
  const out: Output[] = [];
  out.push({
    type: 'kv',
    label: T('label.trailer'),
    entries: [...doc.trailer.map].map(
      ([k, v]) => [`/${k}`, cut(formatValue(v, 300), 300)] as [string, string],
    ),
  });
  if (doc.sections.length > 0) {
    out.push({
      type: 'table',
      label: T('label.xrefSections'),
      columns: [
        T('col.offset'),
        T('col.type'),
        T('col.entries'),
        T('col.prev'),
        T('col.trailer'),
        T('col.notes'),
      ],
      rows: doc.sections.map((s) => [
        s.offset,
        s.kind === 'stream'
          ? T('value.xrefStream', { object: s.objNum ?? 0 })
          : T('value.xrefTable'),
        s.entries.size + (s.hybrid ? s.hybrid.size : 0),
        s.prev ?? '',
        cut(formatValue(s.trailer, 400), 400),
        [
          s.hybrid ? T('value.hybridNote', { offset: s.xrefStm ?? 0 }) : '',
          ...s.problems.map(() => T('note.section.badXRefStm')),
        ]
          .filter(Boolean)
          .join('; '),
      ]),
    });
  }
  const entries = [...doc.view].sort((a, b) => a[0] - b[0]);
  if (entries.length > 0) {
    out.push({
      type: 'table',
      label: T('label.xrefEntries'),
      columns: [T('col.object'), T('col.gen'), T('col.offset'), T('col.state')],
      rows: entries
        .slice(0, MAX_ROWS)
        .map(([num, e]) => [
          num,
          e.gen,
          e.kind === 'n' ? e.a : '',
          e.kind === 'n'
            ? T('value.xrefInUse')
            : e.kind === 'c'
              ? T('value.packedIn', { stream: e.a, index: e.b })
              : T('value.xrefFree', { next: e.a }),
        ]),
    });
  }
  // object streams
  const stms = doc.records.filter(
    (r) => r.stream && isDict(r.value) && isName(r.value.map.get('Type'), 'ObjStm'),
  );
  if (stms.length > 0) {
    out.push({
      type: 'table',
      label: T('label.objStms'),
      columns: [T('col.object'), T('col.count'), T('col.members')],
      rows: stms.map((r) => {
        const members = doc.objStmMembers(r);
        return [
          r.num,
          members.length,
          members
            .slice(0, 24)
            .map((m) => m.num)
            .join(' ') + (members.length > 24 ? ' …' : ''),
        ];
      }),
    });
  }
  if (gaps.length > 0) {
    out.push({
      type: 'table',
      label: T('label.gaps'),
      columns: [T('col.offset'), T('col.type'), T('col.text')],
      rows: gaps.map((g) => [
        g.offset,
        g.kind === 'comment' ? T('value.comment') : T('value.junk'),
        cut(clean(g.text), 300),
      ]),
      highlight: gaps.map((_, i) => i),
    });
  }
  if (leading) {
    out.push({
      type: 'bytes',
      label: T('label.leading'),
      value: own(
        bytes.slice(leading.offset, leading.offset + Math.min(leading.length, 4 * 1024 * 1024)),
      ),
      filename: 'before-header.bin',
    });
  }
  if (trailing) {
    const data = own(
      bytes.slice(trailing.offset, trailing.offset + Math.min(trailing.length, 16 * 1024 * 1024)),
    );
    const sig = identify(data).find((s) => !s.weak);
    out.push({
      type: 'bytes',
      label: sig ? T('label.trailingKnown', { type: signatureName(sig) }) : T('label.trailing'),
      value: data,
      filename: sig ? `after-eof.${sig.ext}` : 'after-eof.bin',
    });
    out.push(note('info', T('note.carve')));
  }
  return out;
}

// ---------- the object and stream tables ----------

function objectBlocks(objects: ObjectRow[]): Output[] {
  const rows: Row[] = objects
    .slice(0, MAX_ROWS)
    .map((o) => [
      o.num,
      o.gen,
      o.packedIn !== null
        ? T('value.packedIn', { stream: o.packedIn, index: o.packedIndex ?? 0 })
        : (o.offset ?? ''),
      o.label,
      o.stream ? `${o.stream.stored}` : '',
      [stateLabel(o.state), o.unreferenced ? T('value.unreferenced') : '']
        .filter(Boolean)
        .join(' · '),
      o.revision > 0 ? o.revision : '',
    ]);
  const out: Output[] = [
    {
      type: 'table',
      label: T('label.objects'),
      columns: [
        T('col.object'),
        T('col.gen'),
        T('col.offset'),
        T('col.type'),
        T('col.stored'),
        T('col.state'),
        T('col.revision'),
      ],
      rows,
      highlight: objects
        .slice(0, MAX_ROWS)
        .map((o, i) => ({ o, i }))
        .filter(({ o }) => o.state !== 'current' || o.unreferenced)
        .map(({ i }) => i),
    },
  ];
  if (objects.length > MAX_ROWS)
    out.push(note('info', T('note.rowsCut', { shown: MAX_ROWS, count: objects.length })));
  return out;
}

function streamBlocks(doc: PdfDoc, rows: StreamRow[], total: number, all: boolean): Output[] {
  if (rows.length === 0) return [];
  const out: Output[] = [];
  out.push({
    type: 'table',
    label: T('label.streams'),
    columns: [
      T('col.object'),
      T('col.offset'),
      T('col.type'),
      T('col.filters'),
      T('col.stored'),
      T('col.decoded'),
      T('col.kind'),
      T('col.preview'),
      T('col.notes'),
    ],
    rows: rows.map((r) => [
      r.rec.num,
      r.rec.offset,
      r.label,
      r.filters || '-',
      r.stored,
      r.capped ? `${r.decoded}+` : r.decoded,
      kindLabel(r.kind),
      r.preview,
      r.notes.map(noteText).join('; '),
    ]),
  });
  if (total > rows.length)
    out.push(note('info', T('note.rowsCut', { shown: rows.length, count: total })));
  out.push(note('info', T('note.inspectHint')));

  // files: images the browser cannot show here, and (on request) every stream
  const files: { name: string; data: Uint8Array; note?: string }[] = [];
  let used = 0;
  const pick = (r: StreamRow): boolean => {
    if (all) return true;
    return r.image !== null && r.image.codec !== undefined;
  };
  for (const r of rows) {
    if (!pick(r) || (r.state === 'old' && !all)) continue;
    const dec = doc.decode(r.rec, 32 * 1024 * 1024);
    if (dec.encrypted || dec.data.length === 0) continue;
    if (used + dec.data.length > MAX_FILE_BYTES || files.length >= 2000) break;
    used += dec.data.length;
    const ext = extFor(sniffKind(dec.data), dec.image);
    files.push({
      name: `object-${r.rec.num}${r.state === 'old' ? '-old' : ''}.${ext}`,
      data: own(dec.data),
      note: dec.image
        ? T('note.imageFile', { codec: dec.image })
        : dec.truncated
          ? T('note.cutAtLimit')
          : undefined,
    });
  }
  if (files.length > 0) {
    out.push({ type: 'files', label: all ? T('label.allStreams') : T('label.imageFiles'), files });
  }
  return out;
}

// ---------- search ----------

function searchResults(hits: ReturnType<typeof streamRows>['hits'], query: string): Output[] {
  if (hits.length === 0) return [note('info', T('note.noHits', { query }))];
  return [
    {
      type: 'table',
      label: T('label.search', { query }),
      columns: [T('col.object'), T('col.where'), T('col.offset'), T('col.context')],
      rows: hits.map((h) => [
        h.num,
        h.where === 'stream' ? T('value.inStream') : T('value.inObject'),
        h.offset,
        h.context,
      ]),
      highlight: hits.map((_, i) => i),
    },
  ];
}

// ---------- one object in full ----------

function inspectObject(
  doc: PdfDoc,
  num: number,
  revision: number,
  reach: Map<number, Reach>,
  contentOf: Map<number, number>,
): Output[] {
  const out: Output[] = [];
  const rev = revision > 0 ? doc.revisions[revision - 1] : doc.revisions[doc.revisions.length - 1];
  if (!rev) throw new ToolError(T('error.revision', { count: doc.revisions.length }));
  const view = doc.viewOf(rev);
  const entry: XEntry | undefined = view.get(num);
  const value = doc.getObject(num, view);
  const rec: ObjRecord | null = doc.getRecord(num, view);
  const e: [string, string][] = [];
  e.push([T('kv.revisionShown'), `${rev.index} / ${doc.revisions.length}`]);
  if (!entry || entry.kind === 'f' || value === undefined) {
    e.push([T('kv.state'), entry?.kind === 'f' ? T('value.freeEntry') : T('value.notDefined')]);
  } else {
    e.push([T('kv.gen'), String(entry.gen)]);
    e.push([
      T('kv.where'),
      entry.kind === 'c'
        ? T('value.packedIn', { stream: entry.a, index: entry.b })
        : String(rec?.offset ?? entry.a),
    ]);
    const path = pathOf(reach, num);
    if (path && rev === doc.revisions[doc.revisions.length - 1]) e.push([T('kv.path'), path]);
    e.push([T('kv.type'), typeLabel(value, !!rec?.stream, reach.get(num)?.via ?? null)]);
    const page = contentOf.get(num);
    if (page !== undefined) e.push([T('kv.usedBy'), T('value.pageContent', { page })]);
  }
  out.push({ type: 'kv', label: T('label.object', { object: num }), entries: e });
  if (value !== undefined) {
    out.push({
      type: 'text',
      label: T('label.objectSource', { object: num }),
      value: formatPretty(value, 600),
    });
  }
  if (rec?.stream && isDict(rec.value)) {
    const dec = doc.decode(rec, 32 * 1024 * 1024);
    const loc = rec.stream;
    const k: [string, string][] = [
      [
        T('kv.stored'),
        `${loc.dataEnd - loc.dataStart} (${T('value.declared')}: ${loc.declared ?? '-'})`,
      ],
      [
        T('kv.filters'),
        doc
          .filtersOf(rec.value)
          .map((f) => f.name)
          .join(' → ') || '-',
      ],
      [
        T('kv.decoded'),
        dec.encrypted ? T('value.stillEncrypted') : `${dec.data.length}${dec.truncated ? '+' : ''}`,
      ],
    ];
    if (dec.error) k.push([T('kv.problem'), dec.error === 'budget' ? T('note.budget') : dec.error]);
    if (dec.stoppedAt) k.push([T('kv.stoppedAt'), dec.stoppedAt]);
    out.push({ type: 'kv', label: T('label.streamInfo'), entries: k });
    if (!dec.encrypted) {
      const kind = sniffKind(dec.data);
      out.push({
        type: 'bytes',
        label: T('label.streamData', { kind: kindLabel(kind) }),
        value: own(dec.data.subarray(0, 16 * 1024 * 1024)),
        filename: `object-${num}.${extFor(kind, dec.image)}`,
      });
    } else {
      out.push(note('error', T('note.stillEncrypted')));
    }
    if (doc.filtersOf(rec.value).length > 0 || dec.encrypted) {
      const raw = own(doc.rawBytes(rec));
      out.push({
        type: 'files',
        label: T('label.rawStream'),
        files: [{ name: `object-${num}-stored.bin`, data: raw }],
      });
    }
  }
  // every version of the object in the file
  const versions = doc.byNum.get(num) ?? [];
  if (versions.length > 0) {
    out.push({
      type: 'table',
      label: T('label.versions'),
      columns: [T('col.revision'), T('col.offset'), T('col.stored'), T('col.summary')],
      rows: versions.map((v) => {
        const r = doc.revisions.find((x) => v.offset >= x.start && v.offset < x.end);
        return [
          r?.index ?? '',
          v.offset,
          v.stream ? v.stream.dataEnd - v.stream.dataStart : '',
          cut(clean(formatValue(doc.decryptedValue(v), 200)), 200),
        ];
      }),
    });
  }
  // an object that is not a stream but looks like content (an orphan content stream)
  if (rec?.stream) {
    const data = doc.decode(rec, 4 * 1024 * 1024).data;
    if (looksLikeContent(data)) {
      out.push({ type: 'text', label: T('label.contentText'), value: rawContentText(data) });
    }
  }
  return out;
}
