import { defineTool, select, text, toggle } from '../../core/define';
import { ToolError } from '../../core/errors';
import type { Output } from '../../core/types';
import { toolT } from '../../i18n/tool-text';
import { utf8Encode } from '../../lib/bytes';
import { emojiPart } from './_text-analyzer-hidden';
import { classify, codePointLabel, type Placement } from './_zerowidth';
import {
  glyphReadings,
  hideInGlyphs,
  letterStream,
  readReplaceable,
  type GlyphReading,
} from './_unicode-hidden-glyph';
import {
  hideInInvisibles,
  PAIRS,
  readInvisibles,
  type InvisibleAnalysis,
  type InvisibleReading,
} from './_unicode-hidden-invisible';
import { bitsPreview, hexPreview } from './_unicode-hidden-read';
import {
  imitates,
  lineColumn,
  scanText,
  type Flag,
  type Kind,
  type Scan,
} from './_unicode-hidden-scan';
import {
  charCell,
  glyphText,
  groupLabel,
  markedText,
  markerLabel,
  occurrenceRows,
  visibleText,
} from './_unicode-hidden-view';
import { loadUnicodeData, type UnicodeData } from './_unicode-lookup';

const T = toolT('unicode-hidden');

/** Rows of the per-occurrence and per-code-point tables before they are cut off. */
const MAX_ROWS = 400;
const MAX_KINDS = 300;
/** Characters of a text block (marked text, normalised text, hidden message) before the cut. */
const PREVIEW_TEXT = 20_000;
/** Bytes whose hex and bits are written out. */
const PREVIEW_BYTES = 256;
/** Symbols of the raw carrier stream written out, and carrier code points listed. */
const STREAM_SYMBOLS = 2048;
const CARRIER_LIST = 256;
/** Readings listed in a table. */
const TABLE_READINGS = 12;
const CLOSEST_READINGS = 5;
/** Longest message the encoder takes. */
const MAX_SECRET_BYTES = 100_000;
/** detect() looks at this much of a pasted text: it runs for every tool on every paste. */
const DETECT_SCAN = 5000;

// ---------- small pieces ----------

const cut = (left: number) => T('text.cut', { count: left });

const preview = (value: string, max = 70): string => {
  const clean = [...value].map((ch) => (ch.codePointAt(0)! < 0x20 ? '·' : ch)).join('');
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
};

const shown = (value: string): string => {
  const chars = [...value];
  return chars.length > PREVIEW_TEXT
    ? chars.slice(0, PREVIEW_TEXT).join('') + cut(chars.length - PREVIEW_TEXT)
    : value;
};

function nameOf(cp: number, data: UnicodeData): string {
  const name = data.name(cp);
  if (name !== null) return name;
  switch (data.category(cp)) {
    case 'Cn':
      return (cp & 0xfffe) === 0xfffe || (cp >= 0xfdd0 && cp <= 0xfdef)
        ? T('value.noncharacter')
        : T('value.unassigned');
    case 'Co':
      return T('value.privateUse');
    case 'Cs':
      return T('value.surrogate');
    default:
      return T('value.noName');
  }
}

const blockOf = (cp: number, data: UnicodeData): string => {
  const block = data.block(cp);
  return block === 'No_Block' ? T('value.noBlock') : block;
};

const FLAG_LABEL: Record<Flag, () => string> = {
  invisible: () => T('kind.invisible'),
  control: () => T('kind.control'),
  space: () => T('kind.space'),
  emoji: () => T('kind.emoji'),
  bom: () => T('kind.bom'),
  joiner: () => T('kind.joiner'),
  mark: () => T('kind.mark'),
  tagflag: () => T('kind.tagflag'),
  typographic: () => T('kind.typographic'),
};

function kindCell(kind: Kind, flag?: Flag, letter?: string): string {
  if (flag) return FLAG_LABEL[flag]();
  switch (kind) {
    case 'homoglyph':
      return T('kind.homoglyph', { letter: letter ?? '?' });
    case 'inplace':
      return T('kind.inplace');
    case 'other':
      return T('kind.other');
    default:
      return FLAG_LABEL[kind]();
  }
}

const place = (scan: Scan, index: number) => {
  const { line, column } = lineColumn(scan, index);
  return `${line}:${column}`;
};

/** The code points of the invisible characters of a scan, in order. */
function* invisibleCps(scan: Scan): Generator<number> {
  for (let k = 0; k < scan.flagIndex.length; k++) {
    if (scan.flagKind[k] === 'invisible') yield scan.cps[scan.flagIndex[k]!]!;
  }
}

/** "ZWSP×31 ZWNJ×33" for some characters. */
function tally(cps: Iterable<number>): string {
  const byCp = new Map<number, number>();
  for (const cp of cps) byCp.set(cp, (byCp.get(cp) ?? 0) + 1);
  const counts = new Map<string, number>();
  for (const [cp, n] of byCp) counts.set(groupLabel(cp), (counts.get(groupLabel(cp)) ?? 0) + n);
  return [...counts]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 8)
    .map(([label, n]) => `${label}×${n}`)
    .join(' ');
}

// ---------- analysis output ----------

function summary(scan: Scan, inv: InvisibleAnalysis, data: UnicodeData): Output {
  const c = scan.counts;
  const entries: [string, string][] = [
    [T('kv.characters'), T('value.characters', { count: scan.cps.length, nonAscii: c.nonAscii })],
    [T('kv.invisible'), c.invisible ? `${c.invisible} (${tally(invisibleCps(scan))})` : '0'],
  ];
  if (c.control) entries.push([T('kv.control'), String(c.control)]);
  if (c.space) entries.push([T('kv.space'), String(c.space)]);
  if (c.inplace) entries.push([T('kv.inplace'), String(c.inplace)]);
  const scripts = new Map<string, number>();
  for (const index of scan.hitIndex) {
    const block = blockOf(scan.cps[index]!, data);
    scripts.set(block, (scripts.get(block) ?? 0) + 1);
  }
  entries.push([
    T('kv.homoglyphs'),
    c.homoglyph
      ? `${c.homoglyph} (${[...scripts].map(([block, n]) => `${block}×${n}`).join(' ')})`
      : '0',
  ]);
  entries.push([T('kv.other'), String(c.other)]);
  entries.push([T('kv.mixedWords'), String(scan.mixedWords)]);
  return { type: 'kv', label: T('label.summary'), entries };
}

function readingRow(r: InvisibleReading, i: number): (string | number)[] {
  return [
    i + 1,
    r.scheme,
    r.detail,
    r.score.toFixed(1),
    r.readable ? T('value.readable') : T('value.weak'),
    preview(r.text),
  ];
}

const READING_COLUMNS = () => [
  T('col.rank'),
  T('col.scheme'),
  T('col.mapping'),
  T('col.score'),
  T('col.status'),
  T('col.result'),
];

/** The raw symbols: 0/1 for two kinds, letters A, B, C... otherwise, in blocks of 8. */
function streamBlock(scan: Scan, inv: InvisibleAnalysis): Output {
  const kinds = [...inv.distinct.keys()].sort((a, b) => a - b);
  const symbol = (cp: number) => {
    const k = kinds.indexOf(cp);
    return kinds.length === 2 ? String(k) : k < 26 ? String.fromCharCode(65 + k) : '#';
  };
  const legend = kinds
    .map(
      (cp, k) =>
        `${kinds.length === 2 ? k : k < 26 ? String.fromCharCode(65 + k) : '#'} = ${codePointLabel(cp)} ${markerLabel(cp)}`,
    )
    .join(', ');
  const used = inv.carriers.slice(0, STREAM_SYMBOLS).map((i) => symbol(scan.cps[i]!));
  const groups: string[] = [];
  for (let i = 0; i < used.length; i += 8) groups.push(used.slice(i, i + 8).join(''));
  const more = inv.carriers.length - used.length;
  return {
    type: 'text',
    label: T('label.stream', { legend }),
    value: groups.join(' ') + (more > 0 ? cut(more) : ''),
  };
}

function carrierBlocks(scan: Scan, inv: InvisibleAnalysis): Output[] {
  const first = inv.carriers[0]!;
  const last = inv.carriers[inv.carriers.length - 1]!;
  const entries: [string, string][] = [
    [T('kv.carriers'), `${inv.carriers.length} (${tally(inv.carriers.map((i) => scan.cps[i]!))})`],
    [
      T('kv.positions'),
      T('value.positions', {
        first: first,
        last: last,
        from: place(scan, first),
        to: place(scan, last),
      }),
    ],
  ];
  return [{ type: 'kv', label: T('label.carriers'), entries }];
}

function invisibleBlocks(scan: Scan, inv: InvisibleAnalysis): Output[] {
  const out: Output[] = [];
  if (!inv.carriers.length) return out;
  const best = inv.best;
  if (best) {
    out.push({
      type: 'text',
      label: T('label.hidden', { scheme: best.scheme }),
      value: shown(best.text),
    });
    if ([...best.text].length > PREVIEW_TEXT) {
      out.push({
        type: 'bytes',
        label: T('label.hiddenBytes'),
        value: best.bytes,
        filename: 'hidden.bin',
      });
    }
    const hex = hexPreview(best.bytes, PREVIEW_BYTES);
    const bits = bitsPreview(best.bytes, PREVIEW_BYTES);
    out.push({
      type: 'kv',
      label: T('label.hiddenDetails'),
      entries: [
        [T('kv.mapping'), best.detail],
        [T('kv.hex'), hex.text + (hex.more ? cut(hex.more) : '')],
        [T('kv.bits'), bits.text + (bits.more ? cut(bits.more) : '')],
        [T('kv.bitCount'), String(best.bits)],
      ],
    });
    out.push(...carrierBlocks(scan, inv));
    out.push({
      type: 'table',
      label: T('label.readings'),
      columns: READING_COLUMNS(),
      rows: inv.readings.slice(0, TABLE_READINGS).map(readingRow),
      highlight: [0],
    });
    return out;
  }
  // Nothing reads as text: say so, and hand over the carriers.
  out.push(...carrierBlocks(scan, inv));
  if (inv.readings.length) {
    out.push({
      type: 'table',
      label: T('label.closest'),
      columns: READING_COLUMNS(),
      rows: inv.readings.slice(0, CLOSEST_READINGS).map(readingRow),
    });
  }
  const listed = inv.carriers.slice(0, CARRIER_LIST).map((i) => codePointLabel(scan.cps[i]!));
  out.push({
    type: 'text',
    label: T('label.carrierList'),
    value:
      listed.join(' ') +
      (inv.carriers.length > CARRIER_LIST ? cut(inv.carriers.length - CARRIER_LIST) : ''),
  });
  out.push(streamBlock(scan, inv));
  return out;
}

/** What a reading of the lookalike letters did, in words: "one bit per letter, replaced = 1...". */
function howText(r: GlyphReading): string {
  const bit = r.inverse ? '0' : '1';
  switch (r.id) {
    case 'letters':
      return T('how.letters');
    case 'replaceable':
      return T('how.replaceable', { bit });
    case 'seen':
      return T('how.seen', { bit });
    default:
      return T('how.all', { bit });
  }
}

function glyphRow(r: GlyphReading, i: number): (string | number)[] {
  return [
    i + 1,
    howText(r),
    r.carriers,
    r.score.toFixed(1),
    r.readable ? T('value.readable') : T('value.weak'),
    preview(r.text),
  ];
}

function glyphBlocks(scan: Scan, data: UnicodeData, readings: GlyphReading[]): Output[] {
  const out: Output[] = [];
  if (!scan.hitIndex.length) return out;
  out.push({
    type: 'text',
    label: T('label.glyphMarked'),
    value: glyphText(scan, { max: PREVIEW_TEXT, cut }, 'mark'),
  });
  out.push({
    type: 'text',
    label: T('label.normalized'),
    value: glyphText(scan, { max: PREVIEW_TEXT, cut }, 'normalize'),
  });
  const total = scan.hitIndex.length;
  const rows = [];
  for (let k = 0; k < Math.min(total, MAX_ROWS); k++) {
    const index = scan.hitIndex[k]!;
    const cp = scan.cps[index]!;
    rows.push([
      index,
      place(scan, index),
      String.fromCodePoint(cp),
      codePointLabel(cp),
      nameOf(cp, data),
      scan.hitLetter[k]!,
      blockOf(cp, data),
    ]);
  }
  out.push({
    type: 'table',
    label:
      total > MAX_ROWS ? T('label.glyphTableCut', { max: MAX_ROWS, total }) : T('label.glyphTable'),
    columns: [
      T('col.position'),
      T('col.lineColumn'),
      T('col.character'),
      T('col.codePoint'),
      T('col.name'),
      T('col.imitates'),
      T('col.block'),
    ],
    rows,
  });
  const best = readings.find((r) => r.readable);
  if (best) {
    out.push({
      type: 'text',
      label: T('label.glyphMessage', { how: howText(best) }),
      value: shown(best.text),
    });
    const hex = hexPreview(best.bytes, PREVIEW_BYTES);
    out.push({
      type: 'kv',
      label: T('label.hiddenDetails'),
      entries: [
        [T('kv.hex'), hex.text + (hex.more ? cut(hex.more) : '')],
        [T('kv.bitCount'), String(best.bits)],
        [T('kv.lettersRead'), String(best.carriers)],
      ],
    });
  }
  if (readings.length) {
    out.push({
      type: 'table',
      label: T('label.glyphReadings'),
      columns: [
        T('col.rank'),
        T('col.reading'),
        T('col.letters'),
        T('col.score'),
        T('col.status'),
        T('col.result'),
      ],
      rows: readings.slice(0, TABLE_READINGS).map(glyphRow),
      highlight: best ? [readings.indexOf(best)] : undefined,
    });
  }
  if (!best) {
    // The pattern itself, so the reader can finish by hand: 1 = swapped, 0 = kept.
    const stream = letterStream(scan);
    const bits: string[] = [];
    for (let i = 0; i < Math.min(stream.letter.length, STREAM_SYMBOLS); i++) {
      bits.push(String(stream.replaced[i]));
    }
    const groups: string[] = [];
    for (let i = 0; i < bits.length; i += 8) groups.push(bits.slice(i, i + 8).join(''));
    out.push({
      type: 'text',
      label: T('label.glyphPattern'),
      value:
        groups.join(' ') +
        (stream.letter.length > STREAM_SYMBOLS ? cut(stream.letter.length - STREAM_SYMBOLS) : ''),
    });
  }
  return out;
}

function tables(scan: Scan, data: UnicodeData): Output[] {
  const out: Output[] = [];
  const rank: Record<Kind, number> = {
    invisible: 5,
    homoglyph: 4,
    control: 3,
    space: 2,
    inplace: 1,
    other: 0,
  };
  const kinds = [...scan.stats]
    .sort((a, b) => rank[b[1].kind] - rank[a[1].kind] || b[1].count - a[1].count || a[0] - b[0])
    .slice(0, MAX_KINDS);
  if (kinds.length) {
    out.push({
      type: 'table',
      label:
        scan.stats.size > MAX_KINDS
          ? T('label.inventoryCut', { max: MAX_KINDS, total: scan.stats.size })
          : T('label.inventory'),
      columns: [
        T('col.codePoint'),
        T('col.character'),
        T('col.name'),
        T('col.category'),
        T('col.block'),
        T('col.kind'),
        T('col.count'),
      ],
      rows: kinds.map(([cp, s]) => [
        codePointLabel(cp),
        charCell(cp, s.kind, data),
        nameOf(cp, data),
        data.category(cp),
        blockOf(cp, data),
        kindCell(
          s.kind,
          undefined,
          s.kind === 'homoglyph' ? (imitates(data, data.category(cp), cp) ?? undefined) : undefined,
        ),
        s.count,
      ]),
    });
  }
  const { rows, total } = occurrenceRows(scan, MAX_ROWS);
  if (rows.length) {
    out.push({
      type: 'table',
      label:
        total > rows.length ? T('label.whereCut', { max: rows.length, total }) : T('label.where'),
      columns: [
        T('col.position'),
        T('col.lineColumn'),
        T('col.codePoint'),
        T('col.character'),
        T('col.name'),
        T('col.category'),
        T('col.block'),
        T('col.kind'),
      ],
      rows: rows.map((r) => [
        r.index,
        place(scan, r.index),
        codePointLabel(r.cp),
        charCell(r.cp, r.kind, data),
        nameOf(r.cp, data),
        data.category(r.cp),
        blockOf(r.cp, data),
        kindCell(r.kind, r.flag, r.imitates),
      ]),
    });
  }
  return out;
}

function analyse(input: string, data: UnicodeData): Output[] {
  const scan = scanText(input, data);
  if (!scan.cps.length) throw new ToolError(T('error.empty'));
  const inv = readInvisibles(scan);
  const readings = glyphReadings(scan, data);
  const c = scan.counts;
  const out: Output[] = [summary(scan, inv, data)];

  // The verdicts first: what is hidden, or why nothing is.
  const bestGlyph = readings.find((r) => r.readable);
  if (inv.best)
    out.push({
      type: 'note',
      level: 'success',
      text: T('note.invisibleMessage', { scheme: inv.best.scheme }),
    });
  else if (inv.carriers.length)
    out.push({ type: 'note', level: 'warn', text: T('note.invisibleUnread') });
  else if (inv.inPlace) out.push({ type: 'note', level: 'info', text: T('note.invisibleInPlace') });
  if (bestGlyph)
    out.push({
      type: 'note',
      level: 'success',
      text: T('note.glyphMessage', { how: howText(bestGlyph) }),
    });
  else if (c.homoglyph) out.push({ type: 'note', level: 'warn', text: T('note.glyphNone') });
  if (inv.read < inv.carriers.length)
    out.push({ type: 'note', level: 'info', text: T('note.truncated', { read: inv.read }) });
  if (!inv.carriers.length && !inv.inPlace && !c.homoglyph && !c.control && !c.space) {
    out.push({ type: 'note', level: 'success', text: T('note.nothing') });
  }

  // Where the payload sits comes first, then what it says.
  if (scan.flagIndex.length) {
    out.push({
      type: 'text',
      label: T('label.marked'),
      value: markedText(scan, {
        max: PREVIEW_TEXT,
        run: (count, parts) => T('text.hiddenRun', { count, parts }),
        cut,
      }),
    });
  }
  out.push(...invisibleBlocks(scan, inv));
  if (inv.carriers.length) {
    out.push({
      type: 'text',
      label: T('label.visible'),
      value: visibleText(scan, { max: PREVIEW_TEXT, cut }),
    });
  }
  out.push(...glyphBlocks(scan, data, readings));
  out.push(...tables(scan, data));
  if (c.homoglyph || scan.flagIndex.length)
    out.push({ type: 'note', level: 'info', text: T('note.seeAlso') });
  return out;
}

// ---------- hiding a message ----------

const PAIR_LABELS: Record<string, string> = {
  'zwsp-zwnj': 'ZWSP = 0, ZWNJ = 1',
  'zwnj-zwsp': 'ZWNJ = 0, ZWSP = 1',
  'zwsp-zwj': 'ZWSP = 0, ZWJ = 1',
  'zwj-zwsp': 'ZWJ = 0, ZWSP = 1',
  'zwnj-zwj': 'ZWNJ = 0, ZWJ = 1',
  'zwj-zwnj': 'ZWJ = 0, ZWNJ = 1',
  'zwsp-wj': 'ZWSP = 0, WJ = 1',
  'wj-zwsp': 'WJ = 0, ZWSP = 1',
  'zwnj-wj': 'ZWNJ = 0, WJ = 1',
  'zwj-wj': 'ZWJ = 0, WJ = 1',
  'zwsp-bom': 'ZWSP = 0, BOM = 1',
  'zwnj-bom': 'ZWNJ = 0, BOM = 1',
};
const PAIR_CHOICES = Object.keys(PAIRS).map((value) => ({ value, label: PAIR_LABELS[value]! }));

function markedResult(scan: Scan, kind: 'invisible' | 'glyph'): Output {
  return kind === 'invisible'
    ? {
        type: 'text',
        label: T('label.stegoMarked'),
        value: markedText(scan, {
          max: PREVIEW_TEXT,
          run: (count, parts) => T('text.hiddenRun', { count, parts }),
          cut,
        }),
      }
    : {
        type: 'text',
        label: T('label.glyphResultMarked'),
        value: glyphText(scan, { max: PREVIEW_TEXT, cut }, 'mark'),
      };
}

function hide(
  cover: string,
  secret: string,
  method: 'invisible' | 'homoglyph',
  pair: string,
  placement: Placement,
  data: UnicodeData,
): Output[] {
  if (!secret) throw new ToolError(T('error.noSecret'));
  if (!cover.trim()) throw new ToolError(T('error.noCover'));
  const bytes = utf8Encode(secret);
  if (bytes.length > MAX_SECRET_BYTES)
    throw new ToolError(T('error.tooBig', { max: MAX_SECRET_BYTES }));

  if (method === 'invisible') {
    const hidden = hideInInvisibles(cover, secret, PAIRS[pair]!, placement);
    const back = readInvisibles(scanText(hidden.text, data));
    const ok = back.readings[0]?.text === secret || back.best?.text === secret;
    return [
      { type: 'note', level: 'success', text: T('note.hiddenInvisible', { bits: hidden.bits }) },
      { type: 'text', label: T('label.stego'), value: hidden.text },
      markedResult(scanText(hidden.text, data), 'invisible'),
      {
        type: 'kv',
        label: T('label.summary'),
        entries: [
          [T('kv.method'), T('value.methodInvisible', { pair: PAIR_LABELS[pair]! })],
          [T('kv.written'), String(hidden.chars)],
          [T('kv.roundTrip'), ok ? T('value.roundTripOk') : T('value.roundTripFail')],
        ],
      },
      ...(ok
        ? []
        : [{ type: 'note' as const, level: 'warn' as const, text: T('note.roundTripFail') }]),
    ];
  }

  const result = hideInGlyphs(cover, bytes, data);
  if (!result.ok)
    throw new ToolError(T('error.capacity', { needed: result.needed, have: result.have }));
  const scan = scanText(result.text, data);
  const back = readReplaceable(scan, data);
  const ok = back !== null && back.length === bytes.length && back.every((b, i) => b === bytes[i]);
  const percent = Math.round((result.bits / Math.max(1, result.capacity)) * 100);
  return [
    {
      type: 'note',
      level: 'success',
      text: T('note.hiddenGlyph', { used: result.bits, capacity: result.capacity }),
    },
    { type: 'text', label: T('label.stegoGlyph'), value: result.text },
    markedResult(scan, 'glyph'),
    {
      type: 'kv',
      label: T('label.summary'),
      entries: [
        [T('kv.method'), T('value.methodGlyph')],
        [
          T('kv.capacity'),
          T('value.capacity', { used: result.bits, total: result.capacity, percent }),
        ],
        [T('kv.replaced'), String(scan.hitIndex.length)],
        [T('kv.roundTrip'), ok ? T('value.roundTripOk') : T('value.roundTripFail')],
      ],
    },
    ...(result.normalized
      ? [
          {
            type: 'note' as const,
            level: 'info' as const,
            text: T('note.coverNormalized', { count: result.normalized }),
          },
        ]
      : []),
    ...(ok
      ? []
      : [{ type: 'note' as const, level: 'warn' as const, text: T('note.roundTripFail') }]),
  ];
}

// ---------- detect ----------

/** A word that holds Latin letters and Cyrillic ones: a lookalike swap, never a real word. */
const LATIN_CYRILLIC =
  /(?=[\p{L}\p{M}]*\p{Script=Latin})(?=[\p{L}\p{M}]*\p{Script=Cyrillic})[\p{L}\p{M}]+/gu;

function quickLook(whole: string): { invisible: number; tags: boolean; mixed: number } {
  const head = whole.length > DETECT_SCAN ? whole.slice(0, DETECT_SCAN) : whole;
  const chars = Array.from(head);
  let invisible = 0;
  let tags = false;
  for (let i = 0; i < chars.length; i++) {
    const cp = chars[i]!.codePointAt(0)!;
    const c = classify(cp, false);
    if (!c || c.kind !== 'invisible') continue;
    if (i === 0 && cp === 0xfeff) continue;
    if ((cp === 0xfe0f || cp === 0xfe0e || cp === 0x200d) && emojiPart(chars, i)) continue;
    invisible++;
    if (cp >= 0xe0020 && cp <= 0xe007e) tags = true;
  }
  return { invisible, tags, mixed: head.match(LATIN_CYRILLIC)?.length ?? 0 };
}

// ---------- the tool ----------

export default defineTool({
  id: 'unicode-hidden',
  name: 'Hidden Unicode text (homoglyphs + invisibles)',
  category: 'stego',
  description:
    'Find lookalike letters and invisible characters in a text, name every unusual code point, decode the message they hide, or hide your own.',
  tags: [
    'homoglyph',
    'confusables',
    'lookalike letters',
    'cyrillic a',
    'mixed script',
    'unicode names',
    'invisible characters',
    'zero width',
    'zwsp',
    'word joiner',
    'tag characters',
    'variation selector',
    'unicode steganography',
    'skeleton',
    'holloway steg',
  ],
  input: 'text',
  placeholder:
    'Paste text that may hide something: invisible characters or lookalike letters (copy it with the hidden characters)',
  options: {
    mode: toggle('Mode', [
      { value: 'analyse', label: 'Analyse' },
      { value: 'hide', label: 'Hide a message' },
    ]),
    method: toggle(
      'Hide with',
      [
        { value: 'invisible', label: 'Invisible characters' },
        { value: 'homoglyph', label: 'Lookalike letters' },
      ],
      'invisible',
      { showIf: (v) => v.mode === 'hide' },
    ),
    pair: select('Symbols', PAIR_CHOICES, 'zwsp-zwnj', {
      hint: 'The two invisible characters that stand for the bits 0 and 1.',
      showIf: (v) => v.mode === 'hide' && v.method === 'invisible',
    }),
    placement: select(
      'Place it',
      [
        { value: 'after-first', label: 'After the first character' },
        { value: 'end', label: 'At the end' },
        { value: 'spread', label: 'Spread through the text' },
      ],
      'after-first',
      { showIf: (v) => v.mode === 'hide' && v.method === 'invisible' },
    ),
    secret: text('Secret message', '', {
      placeholder: 'SECRET42',
      showIf: (v) => v.mode === 'hide',
    }),
  },
  examples: [
    {
      label: 'Text trapped with invisible characters',
      input: { sample: 'unicode-hidden-zerowidth.txt' },
      expect: 'SECRET42',
    },
    {
      label: 'Letters swapped for lookalikes',
      input: { sample: 'unicode-hidden-homoglyph.txt' },
      expect: 'HIDDEN_OK',
    },
    {
      label: 'Message smuggled in tag characters',
      input: { sample: 'unicode-hidden-tags.txt' },
      expect: 'TAGS_OK',
    },
    {
      label: 'Ordinary French text: nothing hidden',
      input:
        'Où l’été dure, les élèves ôtent leur manteau « à la fin » de la journée : ça sent le cœur et l’œuvre !',
      expect: 'Nothing hidden',
    },
    {
      label: 'Hide a message in invisible characters',
      input: 'Meet me at the usual place at noon.',
      options: { mode: 'hide', secret: 'SECRET42' },
      expect: 'Round trip: OK',
    },
    {
      label: 'Hide a message in lookalike letters',
      input:
        'The quick brown fox jumps over the lazy dog while the sun slowly sets behind the old stone bridge near our village.',
      options: { mode: 'hide', method: 'homoglyph', secret: 'HIDDEN_OK' },
      expect: 'Round trip: OK',
    },
  ],
  detect({ text: t }) {
    if (!t) return null;
    const look = quickLook(t);
    const payload = look.invisible >= 8 || look.tags;
    if (!look.invisible && !look.mixed) return null;
    const score = Math.max(look.invisible ? (payload ? 0.88 : 0.5) : 0, look.mixed ? 0.75 : 0);
    const reasons = [
      look.invisible ? T('detect.invisible', { count: look.invisible }) : '',
      look.mixed ? T('detect.mixed', { count: look.mixed }) : '',
    ].filter(Boolean);
    return { score, options: { mode: 'analyse' }, reason: reasons.join(' · ') };
  },
  async run(input, { mode, method, pair, placement, secret }) {
    const data = await loadUnicodeData();
    if (mode === 'hide') return hide(input, secret, method, pair, placement, data);
    return analyse(input, data);
  },
});
