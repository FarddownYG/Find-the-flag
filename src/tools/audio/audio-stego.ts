import { defineTool, number, text, toggle } from '../../core/define';
import { mpegFrame } from '../../core/audio-rate';
import { ToolError } from '../../core/errors';
import type { Output } from '../../core/types';
import { signatureName, toolT } from '../../i18n/tool-text';
import { formatSize, printableRatio } from '../../lib/bytes';
import type { Signature } from '../../lib/signatures';
import { imageFileEnd } from '../stego/_carve';
import { planesLabel, parsePlanes } from '../stego/_lsb-core';
import { preview, printableRun, strongSignature, type StreamHit } from '../stego/_lsb-classify';
import {
  at,
  bytesToText,
  describePayload,
  fourCC,
  oneLine,
  type Analysis,
  type Payload,
} from './_audio-stego-found';
import {
  extractLsb,
  findOnset,
  firstChange,
  isNoPcm,
  lsbCapacity,
  planeStats,
  readPcm,
  frameOf,
  walkChunks,
  type ChunkFile,
  type LsbSpec,
  type NoPcm,
  type PcmLayout,
  type PlaneStats,
} from './_audio-stego-pcm';
import {
  aroundOnset,
  extractManual,
  rankHits,
  scanLsb,
  SCAN_BYTES,
  type Extraction,
  type Finding,
  type Header,
  type HeaderMode,
  type ScanHit,
} from './_audio-stego-lsb';
import { analyzeChunks, describeFormat } from './_audio-stego-riff';
import { analyzeMp3 } from './_audio-stego-mp3';
import { hasId3v2, skipId3v2 } from './_audio-stego-id3';
import { analyzeFlac, analyzeOgg } from './_audio-stego-xiph';
import { renderPlanes, type PlotMark } from './_audio-stego-plot';

const T = toolT('audio-stego');

/** The largest file read whole (it lives in the worker once). */
export const MAX_FILE = 256 * 1024 * 1024;
const MAX_ROWS = 40;
/** Characters of a hit shown in the scan table. */
const PREVIEW = 32;
const MAX_TAGS = 200;
const MAX_PAYLOADS = 30;
const MAX_TEXTS = 5;
const MAX_PICTURES = 6;
const TEXT_BLOCK = 4096;
/** Most bytes of the best auto-scan hit that are carried to the page. */
const BEST_BYTES = 4 * 1024 * 1024;

type Kind = 'wav' | 'aiff' | 'mp3' | 'flac' | 'ogg';

interface Detected {
  kind: Kind;
  chunks: ChunkFile | null;
}

function kindOf(b: Uint8Array): Detected | null {
  const chunks = walkChunks(b);
  if (chunks) return { kind: chunks.kind, chunks };
  const p = skipId3v2(b, 0);
  const tag = fourCC(b, p);
  if (tag === 'fLaC') return { kind: 'flac', chunks: null };
  if (tag === 'OggS') return { kind: 'ogg', chunks: null };
  if (hasId3v2(b, 0)) return { kind: 'mp3', chunks: null };
  if (b[p] === 0xff && (b[p + 1]! & 0xe0) === 0xe0 && mpegFrame(b, p)) {
    return { kind: 'mp3', chunks: null };
  }
  return null;
}

// ---------- wording of a stream ----------

const endianName = (little: boolean) => (little ? 'LE' : 'BE');

function headerLabel(h: Header): string {
  return T(h.unit === 'bits' ? 'header.bits' : 'header.bytes', {
    endian: endianName(h.little),
    count: h.length,
  });
}

function channelLabel(spec: Pick<LsbSpec, 'channel' | 'unit'>, p: PcmLayout): string {
  if (spec.unit === 'byte') return T('ch.bytes');
  if (spec.channel === null || p.channels === 1)
    return p.channels === 1 ? T('ch.mono') : T('ch.all');
  if (p.channels === 2) return T(spec.channel === 0 ? 'ch.left' : 'ch.right');
  return T('ch.n', { n: spec.channel + 1 });
}

function specLabel(spec: LsbSpec, p: PcmLayout): string {
  const parts = [
    channelLabel(spec, p),
    planesLabel(spec.planes),
    T(spec.bitOrder === 'msb' ? 'bit.msb' : 'bit.lsb'),
  ];
  if (spec.offset > 0) parts.push(T('spec.offset', { n: spec.offset }));
  if (spec.step > 1) parts.push(T('spec.step', { n: spec.step }));
  return parts.join(', ');
}

/** What a recognised stream is, in words, and the beginning of it. */
function describeFinding(f: Finding): { what: string; preview: string } {
  const hit = f.hit;
  if (!hit) return { what: '', preview: '' };
  let what: string;
  let pv: string;
  switch (hit.kind) {
    case 'flag':
      what = hit.flagAt === 0 ? T('what.flag') : T('what.flagAt', { offset: hit.flagAt! });
      pv = preview(f.payload.subarray(hit.flagAt!), PREVIEW);
      break;
    case 'file':
      what = T('what.file', { name: signatureName(hit.sig!) });
      pv = '';
      break;
    case 'prefixed':
      what = T('what.prefixed', { endian: hit.little ? 'u32 LE' : 'u32 BE', count: hit.length! });
      pv = preview(f.payload.subarray(4), PREVIEW);
      break;
    case 'text':
      what = T('what.text', { count: hit.count! });
      pv = preview(f.payload, PREVIEW);
      break;
    default:
      what = T('what.inner', { offset: hit.start, count: hit.count! });
      pv = preview(f.payload.subarray(hit.start), PREVIEW);
  }
  if (f.header) what = T('what.viaHeader', { what, header: headerLabel(f.header) });
  return { what, preview: pv };
}

/** Cut a full stream down to its message: text stops at the first unreadable byte. */
function carve(
  stream: Uint8Array,
  f: Finding,
  hit: StreamHit,
): { bytes: Uint8Array; filename: string } {
  const body = f.header ? stream.subarray(4, 4 + f.header.length) : stream;
  const from = body.subarray(hit.start);
  let sig: Signature | undefined;
  if (hit.kind === 'file') sig = hit.sig;
  else if (f.header) sig = strongSignature(body);
  if (sig) {
    const end = sig.end?.(body, 0) ?? imageFileEnd(body, sig.id);
    const bytes = f.header ? body : end ? body.subarray(0, end) : body;
    return { bytes, filename: `audio-lsb.${sig.ext}` };
  }
  if (f.header) return { bytes: body.subarray(hit.start), filename: 'audio-lsb.txt' };
  if (hit.kind === 'prefixed') {
    const n = hit.length ?? from.length;
    return { bytes: from.subarray(0, Math.min(n, from.length)), filename: 'audio-lsb.txt' };
  }
  return { bytes: from.subarray(0, printableRun(from)), filename: 'audio-lsb.txt' };
}

/** The settings of a hit as option values, for the "use these settings" button. */
function optionsOf(spec: LsbSpec): Record<string, unknown> {
  const ch = spec.channel;
  return {
    mode: 'manual',
    unit: spec.unit ?? 'sample',
    planes: spec.planes.join(','),
    channels: ch === null ? 'all' : ch === 0 ? 'left' : ch === 1 ? 'right' : 'all',
    channel: ch !== null && ch >= 2 ? ch + 1 : 0,
    bitOrder: spec.bitOrder,
    step: spec.step,
    offset: spec.offset,
    header: 'auto',
    skip: 0,
    limit: 0,
  };
}

/** Frames [from, to) the first `bytes` bytes of an extraction come from. */
function markOf(p: PcmLayout, spec: LsbSpec, bytes: number): PlotMark {
  const samples = Math.max(1, Math.ceil((bytes * 8) / spec.planes.length));
  return {
    fromFrame: frameOf(p, spec, 0),
    toFrame: Math.min(p.frames, frameOf(p, spec, samples - 1) + 1),
    channels: spec.channel === null ? [] : [spec.channel],
  };
}

// ---------- the LSB part ----------

interface LsbResult {
  out: Output[];
  mark: PlotMark | null;
  found: boolean;
}

/** Where the lowest bit plane leaves its flat (silent) state, when it does. */
interface Onset {
  channel: number;
  /** The first sample frame whose bit is not the flat value. */
  frame: number;
}

function lsbAuto(b: Uint8Array, p: PcmLayout, onset: Onset | null): LsbResult {
  const out: Output[] = [];
  const first = scanLsb(b, p);
  let hits = first.hits;
  out.push({
    type: 'note',
    level: 'info',
    text: T('lsb.scanned', { count: first.tried, kib: SCAN_BYTES / 1024 }),
  });
  // Data written into digital silence starts a few bits before the first bit that is not silence.
  const strong = hits[0] !== undefined && hits[0].finding.tier >= 4;
  if (onset && !strong) {
    const more = scanLsb(b, p, aroundOnset(p, onset.frame, onset.channel));
    out.push({
      type: 'note',
      level: 'info',
      text: T('lsb.onsetScan', {
        count: more.tried,
        sample: onset.frame,
        seconds: (onset.frame / (p.rate || 1)).toFixed(2),
      }),
    });
    hits = rankHits([...hits, ...onsetBest(more.hits)]);
  }
  const best = hits[0];
  if (!best) {
    out.push({ type: 'note', level: 'warn', text: T('lsb.nothing') });
    out.push({ type: 'note', level: 'info', text: T('lsb.otherTools') });
    return { out, mark: null, found: false };
  }
  const rows = hits.slice(0, MAX_ROWS).map((h) => {
    const d = describeFinding(h.finding);
    return [specLabel(h.spec, p), d.preview ? `${d.what} · “${d.preview}”` : d.what];
  });
  out.push({
    type: 'table',
    label: T('label.hits'),
    columns: [T('col.settings'), T('col.what')],
    rows,
    highlight: [0],
  });
  if (hits.length > MAX_ROWS) {
    out.push({
      type: 'note',
      level: 'info',
      text: T('lsb.weaker', { count: hits.length - MAX_ROWS }),
    });
  }
  const hit = best.finding.hit!;
  const d = describeFinding(best.finding);
  out.push({
    type: 'note',
    level: hit.kind === 'flag' || hit.kind === 'file' ? 'success' : 'info',
    text: T('lsb.best', { settings: specLabel(best.spec, p), what: d.what }),
  });
  const header = best.finding.header;
  const want = header ? 4 + header.length : BEST_BYTES;
  const stream = extractLsb(b, p, best.spec, Math.min(want, BEST_BYTES));
  const cut = carve(stream, best.finding, hit);
  out.push({ type: 'bytes', label: T('label.best'), value: cut.bytes, filename: cut.filename });
  out.push(...pictureOf(cut.bytes, cut.filename));
  out.push(actionsFor(hits, p));
  const used = header ? 4 + header.length : hit.start + cut.bytes.length;
  return { out, mark: markOf(p, best.spec, used), found: true };
}

/** The extracted file shown as a picture, when it is one the page can show. */
function pictureOf(bytes: Uint8Array, filename: string): Output[] {
  const mime = describePayload(bytes).image;
  return mime ? [{ type: 'picture', label: T('label.picture'), data: bytes, mime, filename }] : [];
}

/** One hit per way of reading, the best: neighbouring start positions all see the same data. */
function onsetBest(hits: ScanHit[]): ScanHit[] {
  const seen = new Set<string>();
  return rankHits(hits).filter((h) => {
    const key = [h.spec.channel, h.spec.unit, h.spec.bitOrder, h.spec.planes.join()].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function actionsFor(hits: ScanHit[], p: PcmLayout): Output {
  const picks = hits.slice(0, 3);
  return {
    type: 'actions',
    label: T('label.useSettings'),
    actions: picks.map((h, i) => ({
      label: i === 0 ? T('action.useBest') : T('action.use', { settings: specLabel(h.spec, p) }),
      options: optionsOf(h.spec),
      primary: i === 0,
    })),
  };
}

interface ManualValues {
  planes: string;
  unit: 'sample' | 'byte';
  channels: 'all' | 'left' | 'right' | 'each';
  channel: number;
  bitOrder: 'msb' | 'lsb';
  step: number;
  offset: number;
  header: HeaderMode;
  skip: number;
  limit: number;
}

const whole = (n: number, min: number) => Number.isInteger(n) && n >= min;

/** The channel selection of the manual options. */
function pickChannels(o: ManualValues, p: PcmLayout): (number | null)[] {
  if (o.unit === 'byte') return [null];
  if (o.channel > 0) return [o.channel - 1];
  if (o.channels === 'all') return [null];
  if (o.channels === 'each') {
    return p.channels === 1 ? [null] : Array.from({ length: Math.min(p.channels, 8) }, (_, c) => c);
  }
  const c = o.channels === 'left' ? 0 : 1;
  if (c >= p.channels) throw new ToolError(T('error.noRight'));
  return [c];
}

function lsbManual(b: Uint8Array, p: PcmLayout, o: ManualValues): LsbResult {
  const planes = parsePlanes(o.planes);
  if (planes.length > 4) throw new ToolError(T('error.planes', { count: planes.length }));
  if (!whole(o.step, 1)) throw new ToolError(T('error.step'));
  if (!whole(o.offset, 0)) throw new ToolError(T('error.offset'));
  if (!whole(o.skip, 0)) throw new ToolError(T('error.skip'));
  if (!whole(o.limit, 0)) throw new ToolError(T('error.limit'));
  if (!whole(o.channel, 0)) throw new ToolError(T('error.channelNumber', { count: p.channels }));
  if (o.channel > p.channels) throw new ToolError(T('error.channelNumber', { count: p.channels }));
  const channels = pickChannels(o, p);
  const out: Output[] = [];
  let mark: PlotMark | null = null;
  let found = false;
  for (const channel of channels) {
    const spec: LsbSpec = {
      planes,
      unit: o.unit,
      channel,
      bitOrder: o.bitOrder,
      step: o.step,
      offset: o.offset,
    };
    const capacity = lsbCapacity(p, spec);
    if (capacity <= o.skip) {
      throw new ToolError(T('error.nothingLeft', { count: capacity, skip: o.skip }));
    }
    const x = extractManual(b, p, spec, { header: o.header, skip: o.skip, limit: o.limit });
    const block = manualBlocks(x, spec, p, channels.length > 1);
    out.push(...block.out);
    if (!mark) {
      mark = markOf(p, spec, o.skip + (x.header ? 4 : 0) + x.bytes.length);
      found = block.found;
    }
  }
  return { out, mark, found };
}

function manualBlocks(
  x: Extraction,
  spec: LsbSpec,
  p: PcmLayout,
  several: boolean,
): { out: Output[]; found: boolean } {
  const out: Output[] = [];
  const bytes = x.bytes;
  const entries: [string, string][] = [
    [T('kv.channels'), channelLabel(spec, p)],
    [T('kv.planes'), planesLabel(spec.planes)],
    [T('kv.bitOrder'), T(spec.bitOrder === 'msb' ? 'bit.msb' : 'bit.lsb')],
    [T('kv.extracted'), T('value.extracted', { n: bytes.length, capacity: x.capacity })],
  ];
  if (spec.offset > 0 || spec.step > 1) {
    entries.push([T('kv.samples'), T('value.samples', { offset: spec.offset, step: spec.step })]);
  }
  if (x.header) entries.push([T('kv.header'), headerLabel(x.header)]);
  out.push({
    type: 'kv',
    label: several
      ? T('label.extractionOf', { channel: channelLabel(spec, p) })
      : T('label.extraction'),
    entries,
  });
  if (x.header) {
    out.push({
      type: 'note',
      level: 'info',
      text: T('lsb.headerUsed', { header: headerLabel(x.header) }),
    });
  } else if (x.weak) {
    out.push({
      type: 'note',
      level: 'info',
      text: T('lsb.headerWeak', { count: x.weak.length, endian: endianName(x.weak.little) }),
    });
  }
  const sig = strongSignature(bytes);
  if (sig) {
    out.push({
      type: 'note',
      level: 'success',
      text: T('lsb.magic', { name: signatureName(sig), ext: sig.ext }),
    });
  }
  const readable = printableRatio(bytes.subarray(0, 512)) > 0.9;
  if (readable) out.push({ type: 'note', level: 'info', text: T('lsb.readable') });
  if (x.capped) out.push({ type: 'note', level: 'info', text: T('lsb.capped') });
  out.push({
    type: 'bytes',
    label: several
      ? T('label.extractedOf', { channel: channelLabel(spec, p) })
      : T('label.extracted'),
    value: bytes,
    filename: sig ? `audio-lsb.${sig.ext}` : 'audio-lsb.bin',
  });
  if (sig) out.push(...pictureOf(bytes, `audio-lsb.${sig.ext}`));
  return { out, found: !!sig || readable };
}

// ---------- assembling ----------

function payloadOutputs(payloads: Payload[]): Output[] {
  const out: Output[] = [];
  const shown = payloads.slice(0, MAX_PAYLOADS);
  const described = shown.map((p) => ({ p, d: describePayload(p.data) }));
  out.push({
    type: 'files',
    label: T('label.payloads'),
    files: described.map(({ p, d }) => ({
      name: p.name,
      data: p.data,
      note: [
        p.where,
        at(p.offset),
        d.label,
        d.text ? `“${oneLine(bytesToText(p.data.subarray(0, 200)), 120)}”` : '',
      ]
        .filter(Boolean)
        .join(' · '),
    })),
  });
  if (payloads.length > shown.length) {
    out.push({
      type: 'note',
      level: 'info',
      text: T('payloads.more', { count: payloads.length - shown.length }),
    });
  }
  let texts = 0;
  let pictures = 0;
  for (const { p, d } of described) {
    if (d.text && p.data.length <= TEXT_BLOCK && texts < MAX_TEXTS) {
      texts++;
      out.push({
        type: 'text',
        label: T('label.textIn', { where: p.where }),
        value: bytesToText(p.data),
      });
    } else if (d.image && pictures < MAX_PICTURES) {
      pictures++;
      out.push({
        type: 'picture',
        label: T('label.pictureIn', { where: p.where }),
        data: p.data,
        mime: d.image,
        filename: p.name,
      });
    }
  }
  return out;
}

function tablesOf(a: Analysis): Output[] {
  const out: Output[] = [];
  if (a.meta.length) {
    out.push({
      type: 'table',
      label: T('label.tags'),
      columns: [T('col.source'), T('col.name'), T('col.value')],
      rows: a.meta.slice(0, MAX_TAGS).map((m) => [m.source, m.name, m.value]),
    });
    if (a.meta.length > MAX_TAGS) {
      out.push({
        type: 'note',
        level: 'info',
        text: T('tags.more', { count: a.meta.length - MAX_TAGS }),
      });
    }
  }
  if (a.rows.length) {
    out.push({
      type: 'table',
      label: T('label.structure'),
      columns: [T('col.offset'), T('col.part'), T('col.details')],
      rows: a.rows.map((r) => [
        at(r.offset),
        r.name,
        r.size === null ? r.what : `${r.size} B · ${r.what}`,
      ]),
    });
  }
  return out;
}

function plotOutputs(
  stats: PlaneStats | null,
  p: PcmLayout,
  mark: PlotMark | null,
  onsetHint: Onset | null,
): Output[] {
  if (!stats) return [];
  const out: Output[] = [
    {
      type: 'image',
      label: T('label.plot'),
      image: renderPlanes(stats, p.rate || 1, mark),
      filename: 'audio-bit-planes.png',
    },
    {
      type: 'note',
      level: 'info',
      text: mark ? `${T('plot.legend')} ${T('plot.legendMark')}` : T('plot.legend'),
    },
  ];
  if (onsetHint) {
    out.push({
      type: 'note',
      level: 'info',
      text: T('plot.onset', {
        channel: channelLabel({ channel: onsetHint.channel }, p),
        seconds: (onsetHint.frame / (p.rate || 1)).toFixed(2),
        sample: onsetHint.frame,
      }),
    });
  }
  return out;
}

function summaryOf(name: string | undefined, b: Uint8Array, a: Analysis): Output {
  const entries: [string, string][] = [];
  if (name) entries.push([T('kv.file'), name]);
  entries.push([T('kv.size'), `${formatSize(b.length)} (${b.length} B)`]);
  entries.push(...a.summary);
  return { type: 'kv', label: T('label.file'), entries };
}

export default defineTool({
  id: 'audio-stego',
  name: 'Audio steganography (LSB, tags, appended data)',
  category: 'audio',
  description:
    'Find data hidden in a WAV, AIFF, MP3, FLAC or Ogg file: the low bits of the samples (auto-scan), extra chunks, tags and cover pictures, data between or after the audio, and a plot of where the low bits carry data.',
  tags: [
    'audio steganography',
    'wav lsb',
    'least significant bit',
    'hidden data in sound',
    'riff chunk',
    'id3',
    'apic',
    'cover art',
    'vorbis comment',
    'appended data',
    'trailing data',
    'deepsound',
    'silenteye',
    'steghide',
    'sox',
    'audacity',
  ],
  input: 'file',
  placeholder: 'Drop a WAV or AIFF (low bits, chunks) or an MP3, FLAC or Ogg (tags, extra data)',
  options: {
    mode: toggle('Mode', [
      { value: 'auto', label: 'Auto scan' },
      { value: 'manual', label: 'Manual LSB' },
    ]),
    unit: toggle(
      'Unit',
      [
        { value: 'sample', label: 'Samples' },
        { value: 'byte', label: 'Bytes' },
      ],
      'sample',
      {
        hint: 'Samples: the low bits of each sample (16-bit = 2 bytes). Bytes: every byte of the audio data is read as a sample of its own, as simple scripts that edit the raw bytes of the audio do.',
        showIf: (v) => v.mode === 'manual',
      },
    ),
    planes: text('Bit planes', '0', {
      placeholder: '0',
      hint: 'Bits read from every sample, 0 = lowest: "0" (one bit per sample), "0,1" or "0-3" (up to four).',
      showIf: (v) => v.mode === 'manual',
    }),
    channels: toggle(
      'Channels',
      [
        { value: 'all', label: 'All (interleaved)' },
        { value: 'left', label: 'Left' },
        { value: 'right', label: 'Right' },
        { value: 'each', label: 'Each separately' },
      ],
      'all',
      {
        hint: 'All = every sample in file order, as a plain LSB tool walks them.',
        showIf: (v) => v.mode === 'manual',
      },
    ),
    channel: number('Channel number', 0, {
      min: 0,
      hint: 'For files with more than two channels: 1 = first, 2 = second, 3 = third... 0 = use the choice above.',
      showIf: (v) => v.mode === 'manual',
    }),
    bitOrder: toggle(
      'Bit order',
      [
        { value: 'msb', label: 'MSB first' },
        { value: 'lsb', label: 'LSB first' },
      ],
      'msb',
      {
        hint: 'MSB first is what most embedders write.',
        showIf: (v) => v.mode === 'manual',
      },
    ),
    step: number('Sample step', 1, {
      min: 1,
      hint: '1 = every sample, 2 = every second sample, and so on.',
      showIf: (v) => v.mode === 'manual',
    }),
    offset: number('Start sample', 0, {
      min: 0,
      hint: 'Samples skipped before the first one that is read (counted in the selected channel).',
      showIf: (v) => v.mode === 'manual',
    }),
    header: toggle(
      'Length header',
      [
        { value: 'auto', label: 'Auto' },
        { value: 'none', label: 'None' },
        { value: 'be', label: '32-bit BE' },
        { value: 'le', label: '32-bit LE' },
      ],
      'auto',
      {
        hint: 'Many LSB tools write the payload size as a 32-bit number first. Auto uses it when the bytes it announces read as something.',
        showIf: (v) => v.mode === 'manual',
      },
    ),
    skip: number('Skip bytes', 0, {
      min: 0,
      hint: 'Drop this many bytes from the start of the extracted data (before looking for a length header).',
      showIf: (v) => v.mode === 'manual',
    }),
    limit: number('Max bytes', 0, {
      min: 0,
      hint: '0 = everything the settings can hold (or the length header says).',
      showIf: (v) => v.mode === 'manual',
    }),
  },
  examples: [
    {
      label: 'Auto-scan a flag in the low bit of a 16-bit WAV',
      input: { sample: 'audio-stego-lsb.wav' },
      expect: 'FTF{wav_lsb}',
    },
    {
      label: 'A PNG in the 2 low bits of the left channel',
      input: { sample: 'audio-stego-png.wav' },
      expect: 'File: PNG image',
    },
    {
      label: 'Extra RIFF chunk and data after the audio',
      input: { sample: 'audio-stego-chunk.wav' },
      expect: 'FTF{extra_chunk}',
    },
    {
      label: 'ID3 comment and cover picture in an MP3',
      input: { sample: 'audio-stego-id3.mp3' },
      expect: 'FTF{id3_comment}',
    },
    {
      label: 'Manual: left channel, 2 bits, no length header',
      input: { sample: 'audio-stego-png.wav' },
      options: { mode: 'manual', planes: '0,1', channels: 'left', header: 'none', limit: 16 },
      expect: 'PNG image',
    },
  ],
  detect({ bytes }) {
    const found = kindOf(bytes.subarray(0, 1 << 20));
    if (!found) return null;
    if (found.kind === 'wav' || found.kind === 'aiff') {
      const c = found.chunks!;
      const extra = bytes.length < 8 * 1024 * 1024 && c.declaredEnd < bytes.length - 1;
      return extra
        ? { score: 0.8, reason: T('detect.sizeShort') }
        : { score: 0.55, reason: T('detect.pcm') };
    }
    return { score: 0.45, reason: T('detect.tagged') };
  },
  async run(file, o) {
    if (!file.size) throw new ToolError(T('error.empty'));
    if (file.size > MAX_FILE)
      throw new ToolError(T('error.tooBig', { size: formatSize(MAX_FILE) }));
    const b = await file.read(0, file.size);
    const found = kindOf(b);
    if (!found) {
      throw new ToolError(
        T(
          b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
            ? 'error.riff'
            : 'error.format',
        ),
      );
    }
    const manual = o.mode === 'manual';
    let analysis: Analysis;
    let pcm: PcmLayout | NoPcm | null = null;
    if (found.chunks) {
      pcm = readPcm(b, found.chunks);
      analysis = analyzeChunks(b, found.chunks, pcm);
    } else if (found.kind === 'mp3') analysis = analyzeMp3(b);
    else if (found.kind === 'flac') analysis = analyzeFlac(b);
    else analysis = analyzeOgg(b);

    const out: Output[] = [summaryOf(file.name, b, analysis)];
    let lsb: LsbResult = { out: [], mark: null, found: false };
    let stats: PlaneStats | null = null;
    let onset: Onset | null = null;
    if (pcm && !isNoPcm(pcm)) {
      if (pcm.frames > 0) {
        stats = planeStats(b, pcm);
        const start = findOnset(stats);
        if (start) onset = { channel: start.channel, frame: firstChange(b, pcm, start) };
      }
      lsb = manual ? lsbManual(b, pcm, o) : lsbAuto(b, pcm, onset);
    } else if (pcm) {
      out.push({
        type: 'note',
        level: 'warn',
        text: T('lsb.notPcm', { format: describeFormat(pcm) }),
      });
    } else {
      out.push({
        type: 'note',
        level: 'warn',
        text: T(analysis.lossless ? 'lsb.flac' : 'lsb.lossy', { format: analysis.format }),
      });
    }

    if (manual && pcm && !isNoPcm(pcm)) {
      out.push(...lsb.out, ...plotOutputs(stats, pcm, lsb.mark, lsb.found ? null : onset));
      out.push({ type: 'note', level: 'info', text: T('manual.container') });
      return out;
    }
    if (analysis.payloads.length) out.push(...payloadOutputs(analysis.payloads));
    for (const n of analysis.notes) out.push({ type: 'note', ...n });
    out.push(...lsb.out);
    out.push(...tablesOf(analysis));
    if (pcm && !isNoPcm(pcm)) {
      out.push(...plotOutputs(stats, pcm, lsb.mark, lsb.found ? null : onset));
    }
    if (!analysis.payloads.length && !lsb.found) {
      out.push({ type: 'note', level: 'info', text: T('note.clean') });
    }
    out.push({ type: 'note', level: 'info', text: T('note.seeAlso') });
    return out;
  },
});
