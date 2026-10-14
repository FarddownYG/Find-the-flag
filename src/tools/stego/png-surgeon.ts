import { bool, defineTool, number, select, text } from '../../core/define';
import { ToolError } from '../../core/errors';
import type { Output } from '../../core/types';
import { signatureName, toolT } from '../../i18n/tool-text';
import { formatSize, latin1Decode, printableRatio, toHex } from '../../lib/bytes';
import { chunkKind, colorTypeName, type Ihdr, KNOWN_CHUNKS, rowSize } from './_png';
import {
  adlerOk,
  type Attempt,
  decodeText,
  DEFAULT_OPTIONS,
  isIdentity,
  operate,
  piecesWith,
  SEARCH_MAX_CHUNKS,
  type Surgery,
  type SurgeryOptions,
  type TextInfo,
} from './_png-surgeon-core';
import { findHints, otherReading, type Reading, type SequenceProblem } from './_png-surgeon-order';
import { looksLikePng, parseTolerant, type SurgeonChunk } from './_png-surgeon-parse';
import { tailStrings, type TailPart } from './_png-surgeon-tail';
import {
  exactTotal,
  headerOk,
  layoutOf,
  locateFailure,
  type StreamFailure,
  zlibHeader,
} from './_png-surgeon-zlib';

const T = toolT('png-surgeon');

const MAX_TABLE_ROWS = 400;
const MAX_REORDER_ITEMS = 200;
const hex = (n: number, width = 8) => `0x${n.toString(16).toUpperCase().padStart(width, '0')}`;
const off = (n: number) => `0x${n.toString(16).toUpperCase()}`;
const hexBytes = (b: ArrayLike<number>) => toHex(Uint8Array.from(b), ' ').toUpperCase();
/** "#3 #1 #2": what the reorder list writes into Order (always read as position→chunk). */
const listText = (order: number[]) => order.map((i) => `#${i + 1}`).join(' ');
const join = (parts: string[]) => parts.join(T('sep'));

function baseName(name: string | undefined): string {
  const base = (name ?? '').split(/[\\/]/).pop() ?? '';
  return base.replace(/\.[^.]*$/, '') || 'image';
}

function preview(b: Uint8Array): string {
  if (!b.length) return '';
  if (printableRatio(b.subarray(0, 64)) > 0.9) {
    const s = latin1Decode(b.subarray(0, 40)).replace(/[^\x20-\x7e]/g, '·');
    return `"${s}"${b.length > 40 ? '…' : ''}`;
  }
  return `${toHex(b.subarray(0, 12), ' ')}${b.length > 12 ? ' …' : ''}`;
}

const readingName = (r: Reading) => (r === 'position' ? T('reading.position') : T('reading.chunk'));

function ihdrText(h: Ihdr): string {
  const base = T('val.size', {
    width: h.width,
    height: h.height,
    depth: h.bitDepth,
    colour: colorTypeName(h.colorType) ?? `#${h.colorType}`,
  });
  return h.interlace === 1 ? T('val.interlaced', { size: base }) : base;
}

function inflateError(code: number | undefined): string {
  switch (code) {
    case 0:
      return T('zerr.eof');
    case 1:
      return T('zerr.blockType');
    case 2:
      return T('zerr.literal');
    case 3:
      return T('zerr.distance');
    case 6:
      return T('zerr.header');
    default:
      return T('zerr.other');
  }
}

/** One failure, in words, with the IDAT (file number) where it happened. */
function failureText(s: Surgery, a: Attempt, f: StreamFailure): string {
  const chunk = (a.order[f.piece] ?? 0) + 1;
  const layout = s.layout;
  switch (f.kind) {
    case 'header': {
      const d = s.idats[a.order[0] ?? 0]?.data ?? new Uint8Array(0);
      return T('detail.header', {
        chunk: (a.order[0] ?? 0) + 1,
        bytes: hexBytes(d.subarray(0, 2)),
      });
    }
    case 'inflate':
      return T('detail.inflate', { error: inflateError(f.code), chunk });
    case 'filter':
      return layout?.interlaced
        ? T('detail.filterPass', {
            pass: (f.pass ?? 0) + 1,
            row: f.row ?? 0,
            value: f.value ?? 0,
            chunk,
          })
        : T('detail.filter', { row: f.row ?? 0, value: f.value ?? 0, chunk });
    case 'overflow':
      return T('detail.overflow', { chunk });
    case 'rows':
      return T('detail.rows', { produced: a.result.produced, rowBytes: layout?.rowBytes ?? 0 });
    case 'short':
      return T('detail.short', { produced: a.result.produced, expected: layout?.total ?? 0 });
  }
}

function attemptText(s: Surgery, a: Attempt): string {
  if (a.result.failure) {
    if (a.streamOk) return T('res.misfit', { produced: a.result.produced });
    return failureText(s, a, a.result.failure);
  }
  if (!adlerOk(a.result)) return T('res.adlerBad');
  if (a.fitted) return T('res.fitted', { size: ihdrText(a.fitted) });
  return T('res.ok');
}

function seqProblemText(p: SequenceProblem): string {
  switch (p.kind) {
    case 'empty':
      return T('seq.empty');
    case 'count':
      return T('seq.count', {
        count: p.count ?? 0,
        chunks: T('seq.chunks', { count: p.expected ?? 0 }),
      });
    case 'range':
      return T('seq.range', {
        value: p.value ?? 0,
        expected: p.expected ?? 0,
        last: (p.expected ?? 1) - 1,
      });
    case 'duplicate':
      return T('seq.duplicate', { value: p.value ?? 0 });
  }
}

const orderText = (order: number[]) => order.map((i) => i + 1).join(' ');
const hintOf = (s: Surgery, a: Attempt) => (a.hint !== undefined ? s.hints[a.hint] : undefined);

function sourceText(s: Surgery, a: Attempt): string {
  if (a.source === 'manual') return T('source.manual');
  if (a.source === 'list') return T('source.list');
  if (a.source === 'hint') return T('source.hint', { keyword: hintOf(s, a)?.keyword ?? '' });
  if (a.source === 'search') return T('source.search');
  return T('source.file');
}

/** What is known to be damaged in the image data (a wrong CRC, a cut), or null. */
function damageText(s: Surgery): string | null {
  const cut = s.idats.findIndex((c) => c.status === 'truncated');
  if (cut >= 0) {
    const c = s.idats[cut]!;
    return T('damage.truncated', { chunk: cut + 1, length: c.length, stored: c.storedLength });
  }
  const bad = s.idats.map((c, i) => (c.crcStored !== null && !c.crcOk ? i + 1 : 0)).filter(Boolean);
  // Every CRC wrong is a wiped checksum, not damaged data.
  if (bad.length && bad.length < s.idats.length) {
    return T('damage.crc', { count: bad.length, chunks: bad.map((i) => `#${i}`).join(', ') });
  }
  return null;
}

/** Readable labels of what follows IEND (files, text), not padding. */
function tailLabel(p: TailPart): string {
  if (p.kind === 'file' && p.sig) return signatureName(p.sig);
  if (p.kind === 'zeros') return T('tail.zeros');
  if (p.kind === 'newlines') return T('tail.newlines');
  if (p.kind === 'text') return T('tail.text');
  return T('tail.unknown');
}
const payloads = (s: Surgery) =>
  (s.tail?.parts ?? []).filter(
    (p) => p.kind !== 'iend' && p.kind !== 'zeros' && p.kind !== 'newlines',
  );

function withTail(s: Surgery, summary: string): string {
  const found = payloads(s);
  if (!found.length) return summary;
  // Short names in the headline ("ZIP archive", not its list of related formats).
  const labels = found.slice(0, 4).map((p) => tailLabel(p).replace(/\s*[(（].*[)）]\s*$/, ''));
  if (found.length > 4) labels.push('…');
  return T('summary.withTail', { summary, tail: T('summary.tail', { labels: labels.join(', ') }) });
}

// ---------------------------------------------------------------- summary

function successSummary(s: Surgery): string {
  const parts: string[] = [];
  const r = s.repairs;
  const c = s.chosen!;
  if (r.signature) parts.push(T('part.signature'));
  if (r.lengths) parts.push(T('part.length', { count: r.lengths }));
  if (r.types) parts.push(T('part.type', { count: r.types }));
  let hintIgnored = false;
  if (!isIdentity(c.order)) {
    const how =
      c.source === 'hint'
        ? T('how.hint', { keyword: hintOf(s, c)?.keyword ?? '', reading: readingName(c.reading!) })
        : c.source === 'manual'
          ? T('how.manual', { reading: readingName(c.reading!) })
          : c.source === 'list'
            ? T('how.list')
            : s.hints.length
              ? T('how.searchAfterHint', { keyword: s.hints[0]!.keyword })
              : T('how.search');
    parts.push(T('part.reordered', { count: s.idats.length, how }));
  } else if (s.hints.length && c.source !== 'hint') {
    hintIgnored = true;
  }
  if (c.header?.mode === 'replace') {
    parts.push(T('part.zlibHeader', { from: hexBytes(c.header.from), to: hexBytes(c.header.to) }));
  } else if (c.header?.mode === 'prepend') {
    parts.push(T('part.zlibPrepend', { to: hexBytes(c.header.to) }));
  }
  if (s.adlerFixed) parts.push(T('part.adler'));
  if (r.crc) parts.push(T('part.crc', { count: r.crc }));
  if (r.iendMoved) parts.push(T('part.iendMoved'));
  if (r.moved) parts.push(T('part.moved', { count: r.moved }));
  if (r.dropped.length) parts.push(T('part.dropped', { count: r.dropped.length }));
  const st = s.stored!;
  const fin = s.final!;
  if (fin.width !== st.width) parts.push(T('part.width', { from: st.width, to: fin.width }));
  if (fin.height !== st.height) parts.push(T('part.height', { from: st.height, to: fin.height }));
  const adlerGood = adlerOk(c.result) || s.adlerFixed;

  if (s.certainty === 'ambiguous') {
    parts.push(T('part.zlibOk'));
    const why =
      s.search?.exhausted && c.source === 'search' ? T('why.storedBudget') : T('why.ambiguous');
    return T('summary.unsure', { parts: join(parts), why });
  }
  if (s.certainty === 'unconfirmed') {
    parts.push(T('part.zlibInflates'));
    const why = s.search
      ? T('why.search', { tries: s.search.tries })
      : s.idats.length > SEARCH_MAX_CHUNKS || s.manual
        ? T('why.noSearch')
        : T('why.searchOff');
    return T('summary.unsure', { parts: join(parts), why });
  }
  if (!parts.length) {
    if (!adlerGood) return T('summary.adlerOff');
    if (hintIgnored) return T('summary.cleanHint', { keyword: s.hints[0]!.keyword });
    return T('summary.clean');
  }
  if (hintIgnored) parts.unshift(T('part.hintIgnored', { keyword: s.hints[0]!.keyword }));
  parts.push(adlerGood ? T('part.zlibOk') : T('part.adlerKept'));
  return T('summary.ok', { parts: join(parts) });
}

function failureSummary(s: Surgery, opts: SurgeryOptions): string {
  const fail = (reason: string) => T('summary.fail', { reason });
  if (!s.ihdrChunk || !s.stored) return fail(T('fail.noIhdr'));
  if (!s.layout) return fail(T('fail.badIhdr', { detail: ihdrText(s.stored) }));
  if (!s.idats.length) return fail(T('fail.noIdat'));
  if (s.sequenceProblem)
    return fail(T('fail.sequence', { problem: seqProblemText(s.sequenceProblem) }));
  if (s.chosen && s.decodeError) {
    return fail(
      s.decodeError === 'signature'
        ? T('fail.signature')
        : T('fail.decode', { error: s.decodeError }),
    );
  }
  if (s.misfit !== null && s.work) {
    return fail(T('fail.size', { produced: s.misfit, size: ihdrText(s.work) }));
  }
  const typed = s.attempts.filter(
    (a) => a.source === 'manual' || a.source === 'list' || a.source === 'hint',
  );
  if (typed.length) {
    const sources = new Set(typed.map((a) => sourceText(s, a)));
    const details = join(
      typed.map((a) => {
        if (sources.size > 1)
          return T('detail.reading', {
            reading: a.reading
              ? `${sourceText(s, a)}, ${readingName(a.reading)}`
              : sourceText(s, a),
            detail: attemptText(s, a),
          });
        return a.reading && (typed.length > 1 || opts.reading !== 'auto' || a.bothSame)
          ? T('detail.reading', { reading: readingName(a.reading), detail: attemptText(s, a) })
          : attemptText(s, a);
      }),
    );
    if (sources.size > 1) return fail(T('fail.hints', { details }));
    return fail(T('fail.order', { source: sourceText(s, typed[0]!), details }));
  }
  const file = s.attempts.find((a) => a.source === 'file');
  if (!file) return fail(T('fail.stream', { detail: '—' }));
  return fail(fileOrderReason(s, file, opts));
}

/** Why the file order cannot be used and nothing replaced it (no hint). */
function fileOrderReason(s: Surgery, file: Attempt, opts: SurgeryOptions): string {
  const detail = attemptText(s, file);
  const n = s.idats.length;
  const damage = damageText(s);
  const reason = (() => {
    if (n === 1) return T('fail.stream', { detail });
    if (n > SEARCH_MAX_CHUNKS)
      return T('fail.tooMany', { detail, max: SEARCH_MAX_CHUNKS, count: n });
    if (!opts.search) return T('fail.noSearch', { detail });
    if (s.search?.exhausted) return T('fail.searchBudget', { detail, tries: s.search.tries });
    if (damage) return T('fail.searchDamaged', { detail, tries: s.search?.tries ?? 0, damage });
    return T('fail.searchNone', { detail, tries: s.search?.tries ?? 0 });
  })();
  return damage && (n === 1 || n > SEARCH_MAX_CHUNKS || !opts.search || s.search?.exhausted)
    ? T('fail.withDamage', { reason, damage })
    : reason;
}

// ---------------------------------------------------------------- sections

function chunkInfo(s: Surgery, c: SurgeonChunk, idatNo: Map<SurgeonChunk, number>): string {
  const bits: string[] = [];
  if (c.type === 'IHDR' && c.length >= 13 && s.stored && c === s.ihdrChunk)
    bits.push(ihdrText(s.stored));
  if (c.type === 'IDAT') {
    const k = idatNo.get(c) ?? 0;
    bits.push(
      headerOk(c.data)
        ? T('info.idatHeader', { n: k, bytes: hexBytes(c.data.subarray(0, 2)) })
        : T('info.idat', { n: k }),
    );
  } else if (c.type === 'tEXt' || c.type === 'zTXt' || c.type === 'iTXt') {
    const ti = s.texts.findIndex((x) => x.chunk === c.index);
    const t = s.texts[ti];
    if (t) {
      bits.push(
        `«${t.keyword}» ${t.text.replace(/\s+/g, ' ').slice(0, 60)}${t.text.length > 60 ? '…' : ''}`,
      );
      if (s.hints.some((h) => h.text === ti)) bits.push(T('info.hint'));
    }
  } else if (!(c.type in KNOWN_CHUNKS) || !c.validType) {
    bits.push(chunkKind({ ...c, crcStored: c.crcStored ?? 0 }).description);
  }
  if (c.afterIend) bits.push(T('info.afterIend'));
  if (c.status === 'length-fixed')
    bits.push(T('info.lengthFixed', { stored: c.storedLength, length: c.length }));
  if (c.status === 'length-guessed')
    bits.push(T('info.lengthGuessed', { stored: c.storedLength, length: c.length }));
  if (c.status === 'type-fixed')
    bits.push(T('info.typeFixed', { stored: printableType(c.storedType ?? ''), type: c.type }));
  if (c.status === 'type-guessed')
    bits.push(T('info.typeGuessed', { stored: printableType(c.storedType ?? ''), type: c.type }));
  if (c.status === 'truncated')
    bits.push(T('info.truncated', { length: c.length, stored: c.storedLength }));
  if (s.repairs.dropped.includes(c)) bits.push(T('info.dropped'));
  return bits.join(' · ');
}

function chunkSection(s: Surgery): Output[] {
  const out: Output[] = [];
  const p = s.parse;
  const note = (level: 'info' | 'warn', text: string) => out.push({ type: 'note', level, text });
  if (p.signature === 'damaged') note('warn', T('note.sigDamaged', { found: hexBytes(s.head) }));
  if (p.signature === 'missing') note('warn', T('note.sigMissing', { offset: p.start }));
  const resyncs =
    p.gaps.length +
    p.chunks.filter((c) => c.status === 'length-fixed' || c.status === 'length-guessed').length;
  if (resyncs) note('warn', T('note.resync', { count: resyncs }));
  const after = p.chunks.filter((c) => c.afterIend);
  if (after.length) note('warn', T('note.afterIend', { count: after.length }));
  if (p.chunks.filter((c) => c.type === 'IEND').length > 1) note('warn', T('note.multiIend'));
  if (p.iendEnd === null) note('warn', T('note.noIend'));
  const idx = p.chunks.map((c, i) => (c.type === 'IDAT' ? i : -1)).filter((i) => i >= 0);
  if (idx.length && idx[idx.length - 1]! - idx[0]! + 1 !== idx.length)
    note('info', T('note.interleaved'));
  if (s.repairs.dropped.length)
    note('warn', T('note.dropped', { count: s.repairs.dropped.length }));
  if (s.repairs.moved) note('info', T('note.moved', { count: s.repairs.moved }));

  const idatNo = new Map(s.idats.map((c, i) => [c, i + 1]));
  type Row = { at: number; cells: (string | number)[]; bad: boolean };
  const rows: Row[] = p.chunks.map((c) => ({
    at: c.offset,
    bad: !c.crcOk || c.status !== 'ok' || !c.validType || c.afterIend,
    cells: [
      c.index + 1,
      off(c.offset),
      c.type,
      c.length,
      c.crcStored === null
        ? T('crc.none')
        : c.crcOk
          ? T('crc.ok')
          : T('crc.bad', { stored: hex(c.crcStored), computed: hex(c.crcComputed) }),
      chunkInfo(s, c, idatNo),
      preview(c.data),
    ],
  }));
  for (const g of p.gaps) {
    rows.push({
      at: g.offset,
      bad: true,
      cells: [
        '—',
        off(g.offset),
        '—',
        g.length,
        '—',
        T('info.gap', {
          length: g.length,
          type: printableType(g.claimedType),
          claimed: g.claimedLength,
        }),
        '',
      ],
    });
  }
  rows.sort((a, b) => a.at - b.at);
  const shown = rows.slice(0, MAX_TABLE_ROWS);
  out.push({
    type: 'table',
    label: T('label.chunks'),
    columns: [
      T('col.index'),
      T('col.offset'),
      T('col.type'),
      T('col.length'),
      T('col.crc'),
      T('col.info'),
      T('col.data'),
    ],
    rows: shown.map((r) => r.cells),
    highlight: shown.map((r, i) => (r.bad ? i : -1)).filter((i) => i >= 0),
  });
  if (rows.length > shown.length)
    note('info', T('note.chunksCapped', { shown: shown.length, count: rows.length }));
  return out;
}

const printableType = (t: string) => t.replace(/[^\x20-\x7e]/g, '·');

function textSection(s: Surgery): Output[] {
  if (!s.texts.length && !s.hintMisses.length) return [];
  const out: Output[] = [];
  const entries: [string, string][] = s.texts.map((t, i) => {
    let key = `${t.type} «${t.keyword}»`;
    if (t.language) key += ` [${t.language}]`;
    if (t.translated) key += ` (${t.translated})`;
    const marks: string[] = [];
    if (t.compressed) marks.push(T('text.compressed'));
    if (t.broken) marks.push(T('text.broken'));
    if (t.noKeyword) marks.push(T('text.noKeyword'));
    if (s.hints.some((h) => h.text === i)) marks.push(T('text.hint'));
    if (marks.length) key += ` — ${marks.join(', ')}`;
    return [key, t.text || T('text.empty')];
  });
  if (entries.length) out.push({ type: 'kv', label: T('label.texts'), entries });
  for (const m of s.hintMisses) {
    out.push({
      type: 'note',
      level: 'warn',
      text: T('note.hintMiss', {
        keyword: s.texts[m.text]?.keyword ?? '',
        problem: seqProblemText(m.problem),
      }),
    });
  }
  return out;
}

function zlibSection(s: Surgery, opts: SurgeryOptions): Output[] {
  if (!s.idats.length) return [];
  const out: Output[] = [];
  const a = s.chosen ?? s.attempts[0] ?? null;
  const first = s.idats[a?.order[0] ?? 0]!.data;
  const entries: [string, string][] = [];
  if (first.length >= 2) {
    const h = zlibHeader(first[0]!, first[1]!);
    const bytes = hexBytes(first.subarray(0, 2));
    entries.push([
      T('kv.header'),
      h.valid
        ? T('val.header', {
            bytes,
            window: formatSize(1 << (h.cinfo + 8)),
            level: h.flevel,
            levelName: levelName(h.flevel),
          })
        : a?.header?.mode === 'replace'
          ? T('val.headerFixed', { from: bytes, to: hexBytes(a.header.to) })
          : a?.header?.mode === 'prepend'
            ? T('val.headerPrepended', { to: hexBytes(a.header.to) })
            : T('val.headerBad', { bytes }),
    ]);
  }
  const total = s.idats.reduce((n, c) => n + c.length, 0);
  entries.push([
    T('kv.compressed'),
    T('val.compressed', { size: formatSize(total), count: s.idats.length }),
  ]);
  if (a) {
    const r = a.result;
    const rb = s.final ? (rowSize(s.final) ?? 0) : 0;
    entries.push([
      T('kv.inflated'),
      rb && r.produced % rb === 0 && s.final?.interlace !== 1
        ? T('val.rows', {
            count: r.produced,
            rows: T('val.rowCount', { count: r.produced / rb }),
            rowBytes: rb,
          })
        : T('val.bytes', { count: r.produced }),
    ]);
    const expected = s.stored ? layoutOf(s.stored) : null;
    if (expected) entries.push([T('kv.expected'), bytesText(expected)]);
    const work = s.work ? layoutOf(s.work) : null;
    if ((opts.width > 0 || opts.height > 0) && work && s.work)
      entries.push([
        T('kv.expectedOptions', { size: `${s.work.width}×${s.work.height}` }),
        bytesText(work),
      ]);
    if (r.adlerStored !== null && r.adlerComputed !== null) {
      entries.push([
        T('kv.adler'),
        r.adlerStored === r.adlerComputed
          ? T('val.adlerOk', { value: hex(r.adlerStored) })
          : s.adlerFixed
            ? T('val.adlerFixed', { stored: hex(r.adlerStored), computed: hex(r.adlerComputed) })
            : T('val.adlerBad', { stored: hex(r.adlerStored), computed: hex(r.adlerComputed) }),
      ]);
    }
    entries.push([
      T('kv.result'),
      r.ok && adlerOk(r) && !a.fitted ? T('val.ok') : attemptText(s, a),
    ]);
    if (r.failure && (r.failure.kind === 'inflate' || r.failure.kind === 'header')) {
      const where = failurePlace(s, a);
      if (where) entries.push([T('kv.failedAt'), where]);
    } else if (r.failure?.kind === 'filter' && !a.streamOk) {
      entries.push([
        T('kv.failedAt'),
        T('val.failedRow', { offset: r.goodBytes, chunk: (a.order[r.failure.piece] ?? 0) + 1 }),
      ]);
    }
  }
  out.push({ type: 'kv', label: T('label.zlib'), entries });
  const damage = damageText(s);
  if (damage && !s.image)
    out.push({ type: 'note', level: 'warn', text: T('note.damage', { damage }) });
  if (s.attempts.length > 1 || (s.attempts[0] && s.attempts[0].source !== 'file')) {
    out.push({
      type: 'table',
      label: T('label.readings'),
      columns: [T('col.source'), T('col.reading'), T('col.order'), T('col.result')],
      rows: s.attempts.map((x) => [
        sourceText(s, x),
        x.reading ? readingName(x.reading) + (x.bothSame ? ` (${T('res.same')})` : '') : '—',
        orderText(x.order),
        attemptText(s, x),
      ]),
      highlight: s.chosen ? [s.attempts.indexOf(s.chosen)] : [],
    });
  }
  if (s.search && s.chosen?.source === 'search' && !unsureOf(s)) {
    out.push({
      type: 'note',
      level: 'info',
      text: T('note.searchFound', { tries: s.search.tries, order: orderText(s.chosen.order) }),
    });
  }
  const file = s.attempts.find((x) => x.source === 'file');
  if (!s.chosen && file && s.attempts.some((x) => x.source === 'hint')) {
    out.push({
      type: 'note',
      level: 'info',
      text: T('note.fileOrder', { reason: fileOrderReason(s, file, opts) }),
    });
  }
  if (s.proposal) {
    out.push({
      type: 'note',
      level: 'info',
      text: T('note.proposal', { order: orderText(s.proposal) }),
    });
  }
  return out;
}

const unsureOf = (s: Surgery) => s.certainty === 'unconfirmed' || s.certainty === 'ambiguous';

/** "57660 bytes", exact even beyond 2^53 (an absurd IHDR). */
function bytesText(layout: NonNullable<ReturnType<typeof layoutOf>>): string {
  return Number.isSafeInteger(layout.total)
    ? T('val.bytes', { count: layout.total })
    : T('val.bytesExact', { value: exactTotal(layout) });
}

function levelName(level: number): string {
  if (level === 0) return T('level.fastest');
  if (level === 1) return T('level.fast');
  if (level === 2) return T('level.default');
  return T('level.maximum');
}

/** "near byte X of the stream: IDAT #k, byte y of its data". */
function failurePlace(s: Surgery, a: Attempt): string | null {
  const f = a.result.failure;
  if (!f) return null;
  const pieces = piecesWith(
    s.idats.map((c) => c.data),
    a.order,
    a.header,
  );
  const inner = f.kind === 'header' ? 0 : locateFailure(pieces, f.piece);
  if (inner === null) return null;
  const before = pieces.slice(0, f.piece).reduce((n, p) => n + p.length, 0);
  return T('val.failedAt', { offset: before + inner, chunk: (a.order[f.piece] ?? 0) + 1, inner });
}

type Action = { label: string; options: Record<string, unknown>; primary?: boolean };

function ihdrSection(s: Surgery): Output[] {
  const stored = s.stored;
  if (!s.ihdrChunk || !stored) return [];
  const out: Output[] = [];
  const c = s.ihdrChunk;
  const fin = s.final;
  const raw = s.chosen?.result.produced ?? null;
  const entries: [string, string][] = [
    [T('kv.stored'), ihdrText(stored)],
    [
      T('kv.ihdrCrc'),
      c.crcStored === null
        ? T('crc.none')
        : c.crcOk
          ? T('crc.ok')
          : T('crc.bad', { stored: hex(c.crcStored), computed: hex(c.crcComputed) }),
    ],
  ];
  const rb = fin ? rowSize(fin) : null;
  if (raw !== null && fin && fin.interlace !== 1 && rb && raw % rb === 0) {
    entries.push([
      T('kv.dataSize'),
      T('val.rows', { count: raw, rows: T('val.rowCount', { count: raw / rb }), rowBytes: rb }),
    ]);
  }
  if (fin) {
    const how =
      s.sizeHow === 'override'
        ? T('how.override')
        : s.sizeHow === 'crc'
          ? s.candidates[0]?.fits
            ? T('how.crcFits')
            : T('how.crc')
          : s.sizeHow === 'data'
            ? fin.interlace === 1 || !rb
              ? T('how.dataAdam7', { produced: raw ?? 0 })
              : T('how.data', { rows: T('val.rowCount', { count: fin.height }), rowBytes: rb })
            : T('how.stored');
    entries.push([T('kv.used'), `${ihdrText(fin)} — ${how}`]);
  }
  out.push({ type: 'kv', label: T('label.ihdr'), entries });
  if (s.candidates.length) {
    const by = {
      height: T('by.height'),
      width: T('by.width'),
      both: T('by.both'),
      fields: T('by.fields'),
    };
    out.push({
      type: 'table',
      label: T('label.candidates'),
      columns: [T('col.width'), T('col.height'), T('col.foundBy'), T('col.fits')],
      rows: s.candidates
        .slice(0, 12)
        .map((x) => [x.ihdr.width, x.ihdr.height, by[x.kind], x.fits ? T('val.yes') : T('val.no')]),
      highlight: s.candidates[0]?.fits ? [0] : [],
    });
  }
  return out;
}

/** Heights worth one click: as stored, the CRC candidates, the one from the data. */
function heightActions(s: Surgery, opts: SurgeryOptions): Output[] {
  const stored = s.stored;
  if (!s.ihdrChunk || !stored) return [];
  const fin = s.final;
  const heights = new Map<number, string>();
  if (fin && fin.height !== stored.height)
    heights.set(fin.height, T('action.height', { height: fin.height }));
  for (const x of s.candidates) {
    if (x.ihdr.width === (fin?.width ?? stored.width) && !heights.has(x.ihdr.height)) {
      heights.set(x.ihdr.height, T('action.height', { height: x.ihdr.height }));
    }
  }
  if (!heights.size && opts.height <= 0 && opts.width <= 0) return [];
  if (!heights.has(stored.height))
    heights.set(stored.height, T('action.heightStored', { height: stored.height }));
  // The height in use is not offered again (clicking it would change nothing).
  const actions: Action[] = [...heights.entries()]
    .filter(([h]) => h !== (fin?.height ?? stored.height))
    .slice(0, 8)
    .map(([h, label]) => ({ label, options: { height: h } }));
  if (opts.height > 0 || opts.width > 0)
    actions.push({ label: T('action.sizeAuto'), options: { height: 0, width: 0 } });
  return actions.length ? [{ type: 'actions', label: T('label.heights'), actions }] : [];
}

function tailSection(
  s: Surgery,
  stem: string,
  files: { name: string; data: Uint8Array; note?: string }[],
): Output[] {
  if (!s.tail) return [];
  const out: Output[] = [];
  const found = payloads(s);
  let k = 0;
  for (const p of s.tail.parts) {
    const offset = off(s.tail.offset + p.offset);
    if (p.kind === 'iend') {
      out.push({ type: 'note', level: 'warn', text: T('note.tailIend', { offset }) });
      continue;
    }
    const label = tailLabel(p);
    const params = { size: formatSize(p.data.length), offset, label };
    if (p.kind === 'zeros' || p.kind === 'newlines') {
      out.push({ type: 'note', level: 'info', text: T('note.tailPadding', params) });
      continue;
    }
    const ext = p.kind === 'file' && p.sig ? p.sig.ext : p.kind === 'text' ? 'txt' : 'bin';
    const name =
      found.length > 1 ? `${stem}-after-iend-${++k}.${ext}` : `${stem}-after-iend.${ext}`;
    files.push({ name, data: p.data, note: T('file.tail', params) });
    out.push({ type: 'note', level: 'warn', text: T('note.tail', params) });
  }
  const strings = tailStrings(s.tail.parts);
  if (strings) out.push({ type: 'text', label: T('label.tailText'), value: strings });
  return out;
}

// ---------------------------------------------------------------- the tool

function render(s: Surgery, opts: SurgeryOptions, name: string | undefined): Output[] {
  const stem = baseName(name);
  const success = s.chosen !== null && s.image !== null;
  const unsure = success && unsureOf(s);
  const out: Output[] = [
    {
      type: 'note',
      level: success ? (unsure ? 'warn' : 'success') : 'error',
      text: withTail(s, success ? successSummary(s) : failureSummary(s, opts)),
    },
  ];
  if (s.image) {
    out.push({
      type: 'image',
      label: unsure
        ? T('label.imageUnsure', { width: s.image.width, height: s.image.height })
        : T('label.image', { width: s.image.width, height: s.image.height }),
      image: s.image,
      filename: `${stem}-repaired.png`,
    });
  } else if (s.partial) {
    out.push({
      type: 'image',
      label: T('label.partial', { count: s.partial.rows }),
      image: s.partial.image,
      filename: `${stem}-partial.png`,
    });
  } else if (s.layout?.interlaced && !success) {
    out.push({ type: 'note', level: 'info', text: T('note.noPartial') });
  }

  const files: { name: string; data: Uint8Array; note?: string }[] = [];
  if (s.rebuilt && s.final) {
    files.push(
      success
        ? {
            name: `${stem}-repaired.png`,
            data: s.rebuilt,
            note: unsure
              ? T('file.unsure', { width: s.final.width, height: s.final.height })
              : T('file.repaired', { width: s.final.width, height: s.final.height }),
          }
        : { name: `${stem}-rebuilt.png`, data: s.rebuilt, note: T('file.rebuilt') },
    );
  }
  const tail = tailSection(s, stem, files);
  if (files.length) out.push({ type: 'files', label: T('label.files'), files });
  out.push(...heightActions(s, opts));

  // Order actions.
  const actions: Action[] = [];
  const c = s.chosen;
  if (s.proposal) {
    actions.push({
      label: T('action.applyFound'),
      options: { order: listText(s.proposal), reading: 'auto' },
      primary: true,
    });
  }
  if (s.manual && s.hints.length && !success) {
    actions.push({
      label: T('action.useHint', { keyword: s.hints[0]!.keyword }),
      options: { order: '', reading: 'auto' },
      primary: true,
    });
  }
  if (c?.source === 'search') {
    actions.push({
      label: T('action.applyFound'),
      options: { order: listText(c.order), reading: 'auto' },
      primary: false,
    });
  }
  if (c?.reading && !c.bothSame && c.source !== 'list') {
    const other = otherReading(c.reading);
    actions.push({
      label: T('action.other', { reading: readingName(other) }),
      options: { reading: other },
    });
  }
  if (!c && opts.reading !== 'auto' && !s.attempts.some((a) => a.source === 'list'))
    actions.push({ label: T('action.both'), options: { reading: 'auto' }, primary: true });
  if (s.manual) actions.push({ label: T('action.clear'), options: { order: '', reading: 'auto' } });
  if (actions.length) out.push({ type: 'actions', label: T('label.actions'), actions });

  // Manual reorder over the IDATs. Its ids ("#3") are IDAT numbers in the order shown, which the
  // tool always reads as position→chunk: what is dragged is what is tried, whatever the reading.
  const n = s.idats.length;
  const inOrder = c !== null && isIdentity(c.order) && s.certainty === 'confirmed' && !s.manual;
  if (n >= 2 && n <= MAX_REORDER_ITEMS && !inOrder) {
    const literal = s.attempts.find(
      (a) => (a.source === 'manual' || a.source === 'list') && a.reading === 'position',
    );
    const furthest = s.attempts.reduce<Attempt | null>(
      (b, a) => (!b || a.result.goodBytes > b.result.goodBytes ? a : b),
      null,
    );
    const order = c?.order ?? literal?.order ?? furthest?.order ?? [...Array(n).keys()];
    out.push({
      type: 'reorder',
      label: T('label.reorder'),
      option: 'order',
      items: order.map((i) => {
        const k = s.idats[i]!;
        return {
          id: `#${i + 1}`,
          label: T('reorder.item', { n: i + 1 }),
          detail: T('reorder.detail', {
            offset: off(k.offset),
            size: formatSize(k.length),
            head: hexBytes(k.data.subarray(0, 2)),
          }),
        };
      }),
    });
  } else if (n > MAX_REORDER_ITEMS) {
    out.push({ type: 'note', level: 'info', text: T('note.tooManyToReorder', { count: n }) });
  }

  out.push(
    ...chunkSection(s),
    ...textSection(s),
    ...zlibSection(s, opts),
    ...ihdrSection(s),
    ...tail,
  );
  return out;
}

/** Cheap structural triage: shuffled IDATs with a hint, a damaged structure, or a broken start. */
function triage(bytes: Uint8Array): { score: number; reason: string } | null {
  const capped = bytes.length > 1 << 20;
  const p = parseTolerant(capped ? bytes.subarray(0, 1 << 20) : bytes);
  if (!p) return null;
  const idats = p.chunks.filter((c) => c.type === 'IDAT');
  const texts = p.chunks
    .filter((c) => c.length <= 4096)
    .map(decodeText)
    .filter((t): t is TextInfo => t !== null);
  const { hints } = findHints(texts, idats.length);
  if (idats.length > 1 && hints.some((h) => !isIdentity(h.perm)))
    return { score: 0.9, reason: T('detect.hint') };
  const damaged =
    p.signature !== 'ok' ||
    p.gaps.length > 0 ||
    !p.chunks.some((c) => c.type === 'IHDR') ||
    (!capped && p.iendEnd === null) ||
    p.chunks.some(
      (c) =>
        !c.afterIend &&
        ((c.crcStored !== null && !c.crcOk) ||
          (c.status !== 'ok' && (c.status !== 'truncated' || !capped))),
    );
  if (damaged) return { score: 0.85, reason: T('detect.damaged') };
  const firstData = idats.find((c) => c.length > 0);
  if (idats.length > 1 && firstData && !headerOk(firstData.data))
    return { score: 0.85, reason: T('detect.shuffled') };
  return null;
}

export default defineTool({
  id: 'png-surgeon',
  name: 'PNG chunk surgeon (inspect, repair, reorder)',
  category: 'stego',
  description:
    'Black or broken PNG? Lists every chunk without stopping at the first error, shows the text chunks, puts shuffled IDAT chunks back in order (from a hint, by hand, or by search), repairs CRCs, signature, zlib header and IHDR size, and shows the rebuilt image. PNG only.',
  tags: [
    'pngcheck',
    'idat',
    'idat order',
    'shuffled chunks',
    'reorder',
    'chunk',
    'crc',
    'zlib',
    'ihdr',
    'height',
    'fix png',
    'repair',
    'broken png',
    'black image',
    'iend',
    'tEXt',
  ],
  input: 'bytes',
  placeholder: 'Drop a PNG file (or paste its bytes as hex / base64)',
  live: true,
  options: {
    order: text('Order', '', {
      placeholder: '3 1 2 4 …',
      hint: 'IDAT sequence, 1- or 0-based, any separator. Empty: read from a text chunk (order, sequence…) or searched. Written with # (#3 #1 …, as the list below writes it): IDAT #3 first, then IDAT #1…',
    }),
    reading: select(
      'Read the order as',
      [
        { value: 'auto', label: 'Both' },
        { value: 'position', label: 'position→chunk' },
        { value: 'chunk', label: 'chunk→position' },
      ],
      'auto',
      {
        hint: 'position→chunk: number i is the chunk at position i. chunk→position: chunk i goes to position number i. Both: try both, keep the one that inflates. A # list is always position→chunk.',
      },
    ),
    search: bool('Search the order when there is no hint', true, { hint: 'Up to 12 IDAT chunks' }),
    fixCrc: bool('Recompute CRCs', true),
    fixSignature: bool('Fix the PNG signature', true),
    fixZlib: bool('Repair the zlib header and Adler-32', true),
    fixIhdr: bool('Repair the IHDR size', true, {
      hint: 'CRC brute force and decompressed size',
    }),
    width: number('Width', 0, { min: 0, max: 65535, hint: '0 = from IHDR or the data' }),
    height: number('Height', 0, { min: 0, max: 65535, hint: '0 = from IHDR or the data' }),
    singleIdat: bool('Rebuild with a single IDAT', false),
  },
  examples: [
    {
      label: 'Shuffled IDAT chunks + order hint',
      input: { sample: 'png-shuffled-idat.png' },
      expect:
        "Restored: 11 IDAT chunks reordered (hint 'order', chunk→position); zlib stream OK; image below.",
    },
    {
      label: 'Shuffled, no hint (searched)',
      input: { sample: 'png-no-hint.png' },
      expect: 'order found without a hint',
    },
    {
      label: 'Everything broken + cropped height',
      input: { sample: 'png-broken.png' },
      expect: 'height 60 → 120',
    },
    {
      label: 'Order typed by hand',
      input: { sample: 'png-shuffled-idat.png' },
      options: { order: '3 6 9 1 11 5 10 7 2 8 4', reading: 'position' },
      expect: 'typed order, position→chunk',
    },
  ],
  run({ bytes, name }, o) {
    if (!bytes.length) throw new ToolError(T('error.empty'));
    const opts: SurgeryOptions = { ...DEFAULT_OPTIONS, ...o };
    const s = operate(bytes, opts);
    if (!s) throw new ToolError(T('error.notPng'));
    if (!s.parse.chunks.length && !s.parse.gaps.length) throw new ToolError(T('error.noChunks'));
    return render(s, opts, name);
  },
  detect({ bytes }) {
    if (!looksLikePng(bytes)) return null;
    return triage(bytes);
  },
});
