import { encode as encodePng } from 'fast-png';
import { ToolError } from '../../core/errors';
import type { Output, RgbaImage } from '../../core/types';
import { toolT } from '../../i18n/tool-text';
import { utf8Encode } from '../../lib/bytes';
import {
  capacityGroups,
  changeStats,
  type EmdChannel,
  type EmdParams,
  type EmdTraversal,
  embedDigits,
  emdBase,
  hasTransparency,
  MAX_N,
  readDigits,
  streamLength,
} from './_emd-core';
import {
  type Assessment,
  assess,
  BIG_MAX_DIGITS,
  bytesToDigits,
  charDigits,
  type Convention,
  digitsNeeded,
  digitsToBytes,
  displayText,
  printableChance,
  formatDigits,
  type Grouping,
  plainDigits,
} from './_emd-text';

const T = toolT('emd');

export interface EmdOptions {
  mode: 'extract' | 'embed';
  n: string;
  channel: EmdChannel | 'auto';
  traversal: EmdTraversal;
  offset: number;
  length: number;
  grouping: Grouping;
  order: 'msd' | 'lsd';
  message: string;
}

/** Digits shown in the page; the whole stream is always in the downloadable file. */
const SHOWN_DIGITS = 2400;
const RANK_CHARS = 128;
/** Table cells up to 24 characters stay on one line; longer ones wrap and make tall rows. */
const PREVIEW_CHARS = 24;
const PREVIEW_BYTES = 8;

const ALL_CONVENTIONS: Convention[] = [
  { grouping: 'fixed', order: 'msd' },
  { grouping: 'fixed', order: 'lsd' },
  { grouping: 'minimal', order: 'msd' },
  { grouping: 'minimal', order: 'lsd' },
  { grouping: 'bignum', order: 'msd' },
  { grouping: 'bignum', order: 'lsd' },
];

// ---------- names ----------

function channelName(c: EmdChannel): string {
  switch (c) {
    case 'r':
      return T('value.red');
    case 'g':
      return T('value.green');
    case 'b':
      return T('value.blue');
    case 'luma':
      return T('value.luma');
    case 'avg':
      return T('value.average');
  }
}

function traversalName(t: EmdTraversal): string {
  switch (t) {
    case 'horizontal':
      return T('value.horizontal');
    case 'vertical':
      return T('value.vertical');
    case 'raw':
      return T('value.raw');
  }
}

/** "Fixed digits (4), MSD first": the digits per character are part of the name. */
function conventionName(c: Convention, base: number): string {
  const k = charDigits(c.grouping, base);
  const grouping =
    c.grouping === 'fixed'
      ? `${T('conv.fixed')} (${k})`
      : c.grouping === 'minimal'
        ? `${T('conv.minimal')} (${k})`
        : T('conv.bignum');
  return `${grouping}, ${c.order === 'msd' ? T('conv.msd') : T('conv.lsd')}`;
}

function perCharText(c: Convention, base: number): string {
  const k = charDigits(c.grouping, base);
  if (k === null) return T('value.wholeNumber');
  return c.grouping === 'fixed' ? T('value.perCharFixed', { k }) : T('value.perCharMinimal', { k });
}

const offsetText = (p: EmdParams) =>
  T('value.offset', {
    offset: p.offset,
    unit: p.traversal === 'raw' ? T('unit.bytes') : T('unit.pixels'),
  });

/** One line of text for a table cell. */
const previewText = (b: Uint8Array) =>
  trim(displayText(b.subarray(0, PREVIEW_CHARS * 2)).replace(/[\t\n\r]/g, '·'), PREVIEW_CHARS);
const trim = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const hexOf = (b: Uint8Array, max: number) => {
  const shown = b.length > max ? max - 1 : b.length;
  const hex = Array.from(b.subarray(0, shown), (x) => x.toString(16).padStart(2, '0')).join(' ');
  return b.length > max ? `${hex} …` : hex;
};
const printableCell = (a: Assessment) => `${Math.round(a.printable * 100)}% (${a.run})`;

function parseOptions(o: EmdOptions): { p: Omit<EmdParams, 'channel'>; conv: Convention } {
  const n = Number(o.n);
  if (!Number.isInteger(o.length) || o.length < 0) throw new ToolError(T('error.badLength'));
  // In some bases 'minimal' needs as many digits as 'fixed': they are then the same reading.
  const base = emdBase(Math.min(Math.max(n, 1), MAX_N));
  const same =
    o.grouping === 'minimal' && charDigits('minimal', base) === charDigits('fixed', base);
  return {
    p: { n, traversal: o.traversal, offset: o.offset },
    conv: { grouping: same ? 'fixed' : o.grouping, order: o.order },
  };
}

function looksLossless(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return true; // pixels given directly, no file
  const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const bmp = bytes[0] === 0x42 && bytes[1] === 0x4d;
  return png || bmp;
}

// ---------- extraction ----------

interface Reading {
  conv: Convention;
  /** Digits this reading consumed. */
  used: number;
  bytes: Uint8Array;
  a: Assessment;
}

function readingOf(
  digits: Uint8Array,
  base: number,
  conv: Convention,
  chars: number,
): Reading | null {
  const bytes = digitsToBytes(digits, base, conv, chars);
  if (!bytes) return null;
  const k = charDigits(conv.grouping, base);
  const used =
    k === null
      ? chars > 0
        ? Math.min(digits.length, digitsNeeded(conv.grouping, base, chars))
        : digits.length
      : bytes.length * k;
  return { conv, used, bytes, a: assess(bytes, printableChance(conv.grouping, base)) };
}

/** Conventions worth listing: 'minimal' is dropped when it would repeat 'fixed'. */
function conventionsFor(base: number): Convention[] {
  const same = charDigits('fixed', base) === charDigits('minimal', base);
  return ALL_CONVENTIONS.filter((c) => !(same && c.grouping === 'minimal'));
}

const sameConv = (a: Convention, b: Convention) => a.grouping === b.grouping && a.order === b.order;

interface Candidate {
  channel: EmdChannel;
  traversal: EmdTraversal;
}
const CANDIDATES: Candidate[] = [
  ...(['r', 'g', 'b', 'luma', 'avg'] as const).flatMap((channel) =>
    (['horizontal', 'vertical'] as const).map((traversal) => ({ channel, traversal })),
  ),
  { channel: 'r', traversal: 'raw' },
];

function autoGuess(
  image: RgbaImage,
  base: Omit<EmdParams, 'channel' | 'traversal'>,
  conv: Convention,
  chars: number,
): { best: Candidate; table: Output; weak: boolean } {
  const judged = chars > 0 ? Math.min(chars, RANK_CHARS) : RANK_CHARS;
  const baseValue = emdBase(base.n);
  const chance = printableChance(conv.grouping, baseValue);
  const rows = CANDIDATES.map((cand) => {
    const params: EmdParams = { ...base, ...cand };
    const digits = readDigits(image, params, digitsNeeded(conv.grouping, baseValue, judged));
    const bytes = digitsToBytes(digits, baseValue, conv, judged) ?? new Uint8Array(0);
    return { cand, bytes, a: assess(bytes, chance) };
  });
  const order = rows.map((_, i) => i).sort((x, y) => rows[y]!.a.score - rows[x]!.a.score || x - y);
  const best = rows[order[0]!]!;
  return {
    best: best.cand,
    weak: best.a.evidence < 12,
    table: {
      type: 'table',
      label: T('label.auto'),
      columns: [
        T('col.channel'),
        T('col.traversal'),
        T('col.printable'),
        T('col.evidence'),
        T('col.readability'),
        T('col.text'),
      ],
      rows: order.map((i) => {
        const r = rows[i]!;
        return [
          r.cand.traversal === 'raw' ? '—' : channelName(r.cand.channel),
          traversalName(r.cand.traversal),
          printableCell(r.a),
          Math.round(r.a.evidence),
          readabilityCell(r.a),
          previewText(r.bytes),
        ];
      }),
      highlight: [0],
    },
  };
}

const readabilityCell = (a: Assessment) =>
  a.lang ? `${Math.round(a.readability)} (${a.lang})` : String(Math.round(a.readability));

/** The digit stream as a text block, with a note when only the start fits on the page. */
function digitBlocks(digits: Uint8Array, conv: Convention, base: number, label: string): Output[] {
  const group = charDigits(conv.grouping, base) ?? 10;
  const out: Output[] = [{ type: 'text', label, value: formatDigits(digits, group, SHOWN_DIGITS) }];
  if (digits.length > SHOWN_DIGITS) {
    const shown = Math.floor(SHOWN_DIGITS / group) * group;
    out.push({
      type: 'note',
      level: 'info',
      text: T('note.digitsCut', { shown, total: digits.length }),
    });
  }
  return out;
}

export function extractOutputs(image: RgbaImage, fileBytes: Uint8Array, o: EmdOptions): Output[] {
  if (!image.width || !image.height) throw new ToolError(T('error.noPixels'));
  const { p: common, conv } = parseOptions(o);
  const base = emdBase(common.n);
  const out: Output[] = [];
  if (!looksLossless(fileBytes)) {
    out.push({ type: 'note', level: 'warn', text: T('note.lossy') });
  }

  let channel: EmdChannel = o.channel === 'auto' ? 'r' : o.channel;
  let traversal: EmdTraversal = o.traversal;
  if (o.channel === 'auto') {
    const guess = autoGuess(image, common, conv, o.length);
    channel = guess.best.channel;
    traversal = guess.best.traversal;
    out.push({ type: 'note', level: 'warn', text: T('note.autoGuess') });
    out.push(guess.table);
    if (guess.weak) out.push({ type: 'note', level: 'warn', text: T('note.autoWeak') });
  }
  const params: EmdParams = { ...common, channel, traversal };

  const groups = capacityGroups(image, params);
  if (groups <= 0) {
    throw new ToolError(
      T('error.noGroups', { offset: params.offset, values: streamLength(image, traversal) }),
    );
  }
  const conventions = conventionsFor(base);
  // The longest convention decides how many digits to read; each reading then takes its own share.
  const chars = o.length;
  const need =
    chars > 0
      ? Math.max(...conventions.map((c) => digitsNeeded(c.grouping, base, chars)))
      : Infinity;
  const digits = readDigits(image, params, need);

  const readings = conventions
    .map((c) => readingOf(digits, base, c, chars))
    .filter((r): r is Reading => r !== null);
  const selected = readings.find((r) => sameConv(r.conv, conv));
  if (!selected) throw new ToolError(T('error.bigSkipped', { max: BIG_MAX_DIGITS }));
  const best = [...readings].sort((a, b) => b.a.score - a.a.score)[0]!;

  // ----- summary -----
  const shownDigits = digits.subarray(0, selected.used);
  const entries: [string, string][] = [
    [T('kv.base'), T('value.base', { base, n: params.n })],
    [T('kv.channel'), traversal === 'raw' ? T('value.rawBytes') : channelName(channel)],
    [T('kv.traversal'), traversalName(traversal)],
    [T('kv.offset'), offsetText(params)],
    [T('kv.groups'), T('value.groups', { groups: selected.used })],
    [T('kv.perChar'), perCharText(conv, base)],
    [T('kv.order'), conv.order === 'msd' ? T('value.msdFirst') : T('value.lsdFirst')],
    [
      T('kv.characters'),
      chars > 0 && selected.bytes.length < chars
        ? T('value.charactersShort', { read: selected.bytes.length, wanted: chars })
        : String(selected.bytes.length),
    ],
  ];
  const a = selected.a;
  if (
    a.run >= 3 &&
    selected.bytes.length > a.run &&
    selected.bytes.subarray(0, a.run).every(isPrintableByte)
  ) {
    entries.push([
      T('kv.readable'),
      T('value.readable', { run: a.run, total: selected.bytes.length }),
    ]);
  }
  out.push({ type: 'kv', label: T('label.reading'), entries });

  // ----- main result -----
  out.push({ type: 'text', label: T('label.message'), value: displayText(selected.bytes) });
  out.push(...digitBlocks(shownDigits, conv, base, T('label.digits', { base })));
  out.push({
    type: 'files',
    label: T('label.files'),
    files: [
      {
        name: 'emd-digits.txt',
        data: utf8Encode(plainDigits(shownDigits)),
        note: T('note.digitsFile', { base }),
      },
      { name: 'emd-message.bin', data: selected.bytes, note: T('note.bytesFile') },
    ],
  });

  // ----- conventions -----
  if (!sameConv(best.conv, conv) && best.a.score - selected.a.score >= 10) {
    out.push({
      type: 'actions',
      label: T('label.better'),
      actions: [
        {
          label: T('action.use', { name: conventionName(best.conv, base) }),
          options: { grouping: best.conv.grouping, order: best.conv.order },
          primary: true,
        },
      ],
    });
  }
  const ranked = [...readings].sort((x, y) => y.a.score - x.a.score);
  out.push({
    type: 'table',
    label: T('label.conventions'),
    columns: [
      T('col.convention'),
      T('col.printable'),
      T('col.evidence'),
      T('col.readability'),
      T('col.text'),
      T('col.hex'),
    ],
    rows: ranked.map((r) => {
      return [
        conventionName(r.conv, base),
        printableCell(r.a),
        Math.round(r.a.evidence),
        readabilityCell(r.a),
        previewText(r.bytes),
        hexOf(r.bytes, PREVIEW_BYTES),
      ];
    }),
    highlight: [0],
  });
  if (readings.length < conventions.length) {
    out.push({
      type: 'note',
      level: 'info',
      text: T('note.bigSkippedRow', { max: BIG_MAX_DIGITS }),
    });
  }
  out.push({ type: 'note', level: 'info', text: T('note.conventions') });
  return out;
}

const isPrintableByte = (b: number) => (b >= 0x20 && b < 0x7f) || b === 9 || b === 10 || b === 13;

// ---------- embedding ----------

/** The stego image as a PNG file (RGB, or RGBA when the cover has transparency). */
export function stegoPng(img: RgbaImage): Uint8Array {
  const alpha = hasTransparency(img.data);
  const channels = alpha ? 4 : 3;
  const pixels = img.width * img.height;
  const data = new Uint8Array(pixels * channels);
  for (let i = 0; i < pixels; i++) {
    for (let c = 0; c < channels; c++) data[i * channels + c] = img.data[i * 4 + c]!;
  }
  return encodePng({ width: img.width, height: img.height, data, depth: 8, channels });
}

const same = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** Message bytes to digits in the chosen convention, written into a copy of the image. */
export function embedMessage(
  image: RgbaImage,
  params: EmdParams,
  conv: Convention,
  message: Uint8Array,
): { digits: Uint8Array; stego: RgbaImage } {
  const digits = bytesToDigits(message, emdBase(params.n), conv);
  return { digits, stego: embedDigits(image, params, digits) };
}

export function embedOutputs(image: RgbaImage, o: EmdOptions): Output[] {
  if (!image.width || !image.height) throw new ToolError(T('error.noPixels'));
  if (o.channel === 'auto') throw new ToolError(T('error.autoEmbed'));
  const { p: common, conv } = parseOptions(o);
  const params: EmdParams = { ...common, channel: o.channel };
  const base = emdBase(params.n);
  const message = utf8Encode(o.message);
  if (!message.length) throw new ToolError(T('error.noMessage'));

  const { digits, stego } = embedMessage(image, params, conv, message);
  const stats = changeStats(image, stego);

  // Read it back the way the extractor would.
  const back = digitsToBytes(readDigits(stego, params, digits.length), base, conv, message.length);
  const ok = back !== null && same(back, message);
  const backText = back ? displayText(back) : '';

  const capacity = capacityGroups(image, params);
  const out: Output[] = [
    ok
      ? {
          type: 'note',
          level: 'success',
          text: T('note.roundTripOk', { text: trim(backText, 80) }),
        }
      : {
          type: 'note',
          level: 'error',
          text: T('note.roundTripFail', { text: trim(backText, 80) }),
        },
    {
      type: 'kv',
      label: T('label.embedded'),
      entries: [
        [T('kv.base'), T('value.base', { base, n: params.n })],
        [
          T('kv.channel'),
          params.traversal === 'raw' ? T('value.rawBytes') : channelName(params.channel),
        ],
        [T('kv.traversal'), traversalName(params.traversal)],
        [T('kv.offset'), offsetText(params)],
        [T('kv.perChar'), perCharText(conv, base)],
        [T('kv.order'), conv.order === 'msd' ? T('value.msdFirst') : T('value.lsdFirst')],
        [
          T('kv.digitsWritten'),
          T('value.digitsWritten', { digits: digits.length, bytes: message.length }),
        ],
        [T('kv.groupsUsed'), T('value.groupsUsed', { used: digits.length, total: capacity })],
        [
          T('kv.pixelsChanged'),
          T('value.pixelsChanged', {
            changed: stats.pixels,
            total: image.width * image.height,
            percent: ((100 * stats.pixels) / (image.width * image.height)).toFixed(2),
          }),
        ],
        [T('kv.maxChange'), `±${stats.maxChange}`],
        [T('kv.psnr'), Number.isFinite(stats.psnr) ? `${stats.psnr.toFixed(2)} dB` : '∞'],
      ],
    },
  ];
  if (stats.maxChange > 1) {
    out.push({ type: 'note', level: 'info', text: T('note.saturated') });
  }
  out.push({ type: 'image', label: T('label.stego'), image: stego, filename: 'emd-stego.png' });
  const png = stegoPng(stego);
  out.push({
    type: 'files',
    label: T('label.files'),
    files: [{ name: 'emd-stego.png', data: png, note: T('note.stegoFile') }],
  });
  out.push(...digitBlocks(digits, conv, base, T('label.written', { base })));
  return out;
}
