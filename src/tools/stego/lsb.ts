import { defineTool, number, select, text, toggle } from '../../core/define';
import { ToolError } from '../../core/errors';
import { registeredTools } from '../../core/tool-list';
import type { Output, RgbaImage } from '../../core/types';
import { signatureName, toolName, toolT } from '../../i18n/tool-text';
import { latin1Decode, printableRatio, toHex, utf8Encode } from '../../lib/bytes';
import type { Signature } from '../../lib/signatures';
import { imageFileEnd } from './_carve';
import {
  capacityBytes,
  channelsToString,
  extractBits,
  type LsbParams,
  paramsLabel,
  parseChannels,
  parsePlanes,
} from './_lsb-core';
import {
  anomalyRows,
  embedBits,
  parseRows,
  rangeMask,
  rowRanges,
  rowsLabel,
  strideHint,
  type StrideHint,
  zonePixels,
} from './_lsb-zones';
import type { Traversal } from './_pvd';
import {
  classifyStream,
  FLAG_RE,
  KIND_TIER as TIER,
  preview,
  printableRun,
  strongSignature,
  type StreamKind as HitKind,
} from './_lsb-classify';

const T = toolT('lsb');

/** zsteg -a style search space. */
const CHANNEL_ORDERS = ['r', 'g', 'b', 'a', 'rgb', 'bgr', 'rgba', 'abgr'];
const PLANE_SETS = [[0], [1], [2], [3], [0, 1], [0, 1, 2], [0, 1, 2, 3]];
const SCAN_BYTES = 8192;
const MAX_ROWS = 40;
/** Zone candidates: channel orders and plane sets worth trying on a carrier row. */
const ZONE_CHANNELS = ['rgb', 'r', 'g', 'b', 'bgr'];
const ZONE_PLANES = [[0], [0, 1]];
const MAX_ZONES = 4;
const MAX_ZONE_COMBOS = 1500;
const MAX_ANOMALY_ROWS = 12;

interface Hit {
  kind: HitKind;
  params: LsbParams;
  /** Larger is better within a kind. */
  score: number;
  what: string;
  preview: string;
  /** Where the interesting data starts in the extracted stream. */
  start: number;
  sig?: Signature;
  /** Length-prefixed hits: the length the prefix announces. */
  length?: number;
  /** Zone candidates: "rows 0, step 2, offset 0". */
  zone?: string;
}

/** Decide whether an extracted prefix looks like something: file, flag, or readable text. */
function classify(b: Uint8Array, params: LsbParams): Hit | null {
  const c = classifyStream(b);
  if (!c) return null;
  const base = { kind: c.kind, params, score: c.score, start: c.start };
  switch (c.kind) {
    case 'flag':
      return {
        ...base,
        what: c.flagAt === 0 ? T('what.flag') : T('what.flagAt', { offset: c.flagAt! }),
        preview: preview(b.subarray(c.flagAt!)),
      };
    case 'file':
      return {
        ...base,
        what: T('what.file', { name: signatureName(c.sig!) }),
        preview: toHex(b.subarray(0, 12), ' '),
        sig: c.sig,
      };
    case 'prefixed':
      return {
        ...base,
        what: T('what.prefixed', { endian: c.little ? 'u32 LE' : 'u32 BE', count: c.length! }),
        preview: preview(b.subarray(4)),
        length: c.length,
      };
    case 'text':
      return { ...base, what: T('what.text', { count: c.count! }), preview: preview(b) };
    case 'inner':
      return {
        ...base,
        what: T('what.inner', { offset: c.start, count: c.count! }),
        preview: preview(b.subarray(c.start)),
      };
  }
}

function scan(img: RgbaImage): { hits: Hit[]; tried: number } {
  const opaque = (() => {
    for (let i = 3; i < img.data.length; i += 4) if (img.data[i] !== 255) return false;
    return true;
  })();
  const hits: Hit[] = [];
  let tried = 0;
  for (const chans of CHANNEL_ORDERS) {
    if (opaque && chans.includes('a')) continue;
    const channels = parseChannels(chans);
    for (const planes of PLANE_SETS) {
      for (const order of ['row', 'col'] as const) {
        for (const bitOrder of ['msb', 'lsb'] as const) {
          const params: LsbParams = { channels, planes, order, bitOrder };
          tried++;
          const hit = classify(extractBits(img, params, SCAN_BYTES), params);
          if (hit) hits.push(hit);
        }
      }
    }
  }
  hits.sort((a, b) => TIER[b.kind] - TIER[a.kind] || b.score - a.score);
  return { hits, tried };
}

interface ZoneScan {
  hits: Hit[];
  tried: number;
  /** Carrier rows found, for the summary table. */
  anomalies: { row: number; score: number }[];
  /** The zones tried, as row labels, and the stride the busiest row suggests. */
  zones: string[];
  stride: StrideHint | null;
}

const zoneLabel = (rows: string, step: number, offset: number) =>
  T('value.zone', { rows, step, offset });

/** Try the carrier rows the entropy scan found, with every-other-pixel strides and offsets. */
function scanZones(img: RgbaImage): ZoneScan {
  const anomalies = anomalyRows(img);
  const result: ZoneScan = { hits: [], tried: 0, anomalies, zones: [], stride: null };
  const ranges = rowRanges(anomalies);
  // Nearly every row flagged means a noisy image, not a carrier zone.
  if (!ranges.length || anomalies.length * 2 > img.height) return result;
  const top = anomalies.reduce((a, b) => (b.score > a.score ? b : a));
  result.stride = strideHint(img, top.row);
  const masks: Uint8Array[] = ranges
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_ZONES)
    .map((r) => rangeMask(img.height, r.from, r.to));
  const steps = [...new Set([1, 2, result.stride?.step ?? 1])];
  const offsets = [...new Set([0, 1, result.stride?.offset ?? 0])];
  for (const mask of masks) {
    const rows = rowsLabel(mask);
    result.zones.push(rows);
    const pixels = zonePixels(img.width, img.height, 'row', mask);
    for (const chans of ZONE_CHANNELS) {
      const channels = parseChannels(chans);
      for (const planes of ZONE_PLANES) {
        for (const bitOrder of ['msb', 'lsb'] as const) {
          for (const step of steps) {
            for (const offset of offsets) {
              if (result.tried >= MAX_ZONE_COMBOS) return result;
              const params: LsbParams = {
                channels,
                planes,
                order: 'row',
                bitOrder,
                pixels,
                step,
                offset,
              };
              result.tried++;
              const hit = classify(extractBits(img, params, SCAN_BYTES), params);
              if (hit) result.hits.push({ ...hit, zone: zoneLabel(rows, step, offset) });
            }
          }
        }
      }
    }
  }
  return result;
}

const hitLabel = (h: Hit) =>
  h.zone ? `${paramsLabel(h.params)}, ${h.zone}` : paramsLabel(h.params);

/** "12:hello" cut to the 12 bytes after the colon; null when the stream has no such prefix. */
function lengthPrefixed(b: Uint8Array): Uint8Array | null {
  const m = /^(\d{1,6}):/.exec(latin1Decode(b.subarray(0, 8)));
  if (!m) return null;
  const n = Number(m[1]);
  const from = m[0].length;
  return n > 0 && from + n <= b.length ? b.subarray(from, from + n) : null;
}

/** A body that is one base64/hex-like token and not already a flag: offer the chain decoder. */
function nextSteps(body: Uint8Array): Output[] {
  const target = registeredTools().find((x) => x.id === 'auto-decode');
  if (!target) return [];
  const txt = latin1Decode(body).trim();
  if (FLAG_RE.test(txt) || !/^[A-Za-z0-9+/=_-]{16,}$/.test(txt)) return [];
  return [
    {
      type: 'actions',
      actions: [
        {
          label: T('open', { tool: toolName(target) }),
          options: {},
          open: { tool: target.id, text: txt },
        },
      ],
    },
  ];
}

/** Cut the full stream down to the message: text stops at the first unreadable byte. */
function carve(full: Uint8Array, hit: Hit): { bytes: Uint8Array; filename: string } {
  const from = full.subarray(hit.start);
  if (hit.kind === 'file' && hit.sig) {
    const end = hit.sig.end?.(full, 0) ?? imageFileEnd(full, hit.sig.id);
    return {
      bytes: end ? full.subarray(0, end) : full,
      filename: `lsb-extract.${hit.sig.ext}`,
    };
  }
  if (hit.kind === 'prefixed') {
    const n = hit.length ?? from.length;
    return { bytes: from.subarray(0, Math.min(n, from.length)), filename: 'lsb-extract.txt' };
  }
  return { bytes: from.subarray(0, printableRun(from)), filename: 'lsb-extract.txt' };
}

interface WalkOptions {
  channels: string;
  planes: string;
  order: 'row' | 'col';
  bitOrder: 'msb' | 'lsb';
  traversal: Traversal;
  rows: string;
  step: number;
  offset: number;
}

/** The manual/encode settings as extraction params: zone, traversal, step and offset included. */
function manualParams(image: RgbaImage, o: WalkOptions): LsbParams {
  if (!Number.isInteger(o.step) || o.step < 1) throw new ToolError(T('error.step'));
  if (!Number.isInteger(o.offset) || o.offset < 0) throw new ToolError(T('error.offset'));
  const params: LsbParams = {
    channels: parseChannels(o.channels),
    planes: parsePlanes(o.planes),
    order: o.order,
    bitOrder: o.bitOrder,
    step: o.step,
    offset: o.offset,
  };
  const rows = parseRows(o.rows, image.height);
  if (rows || o.traversal !== 'row') {
    const base = o.traversal === 'row' && o.order === 'col' ? 'column' : o.traversal;
    params.pixels = zonePixels(image.width, image.height, base, rows);
  }
  return params;
}

const orderLabel = (o: WalkOptions) => {
  const t = o.traversal !== 'row' ? o.traversal : o.order === 'col' ? 'column' : 'row';
  if (t === 'serpentine') return T('value.serpentineRows');
  if (t === 'column-serpentine') return T('value.serpentineCols');
  return t === 'column' ? T('value.colByCol') : T('value.rowByRow');
};

const fmtPlanes = (p: number[]) => (p.length === 1 ? `${p[0]}` : p.join(','));

export default defineTool({
  id: 'lsb',
  name: 'LSB extract',
  category: 'stego',
  description:
    'Pull hidden data out of the lowest bits of image pixels: auto-scan every common combination, or pick channels and bits yourself.',
  tags: [
    'zsteg',
    'steganography',
    'least significant bit',
    'bit plane',
    'pixel',
    'png',
    'bmp',
    'stegsolve',
    'extract',
  ],
  input: 'image',
  placeholder: 'Drop a PNG or BMP (lossless formats keep the hidden bits)',
  options: {
    mode: toggle('Mode', [
      { value: 'auto', label: 'Auto scan' },
      { value: 'manual', label: 'Manual' },
      { value: 'encode', label: 'Encode' },
    ]),
    channels: text('Channels', 'rgb', {
      placeholder: 'rgb',
      hint: 'Reading order of r, g, b, a within each pixel: "rgb", "bgr", "r", "rgba"...',
      showIf: (v) => v.mode !== 'auto',
    }),
    planes: text('Bit planes', '0', {
      placeholder: '0',
      hint: '0 is the least significant bit. "0", "0,1" or "0-2" (several bits per channel).',
      showIf: (v) => v.mode !== 'auto',
    }),
    order: toggle(
      'Pixel order',
      [
        { value: 'row', label: 'Row by row' },
        { value: 'col', label: 'Column by column' },
      ],
      'row',
      { showIf: (v) => v.mode !== 'auto' },
    ),
    bitOrder: toggle(
      'Bit order',
      [
        { value: 'msb', label: 'MSB first' },
        { value: 'lsb', label: 'LSB first' },
      ],
      'msb',
      {
        hint: 'MSB first is what most embedders write (and zsteg b1,rgb,lsb,xy reads).',
        showIf: (v) => v.mode !== 'auto',
      },
    ),
    traversal: select(
      'Traversal',
      [
        { value: 'row', label: 'Row by row' },
        { value: 'serpentine', label: 'Serpentine rows' },
        { value: 'column', label: 'Column by column' },
        { value: 'column-serpentine', label: 'Serpentine columns' },
      ],
      'row',
      {
        hint: 'How the pixels are walked. Anything but "Row by row" overrides "Pixel order".',
        showIf: (v) => v.mode !== 'auto',
      },
    ),
    rows: text('Rows (zone)', '', {
      placeholder: 'all',
      hint: 'Only read these image rows: "0", "0-2" or "0,5-6" (counted from 0 at the top). Empty = every row.',
      showIf: (v) => v.mode !== 'auto',
    }),
    step: number('Pixel step', 1, {
      min: 1,
      hint: 'Read every Nth pixel of the walk: 2 = every other pixel.',
      showIf: (v) => v.mode !== 'auto',
    }),
    offset: number('Pixel offset', 0, {
      min: 0,
      hint: 'Skip this many pixels of the walk before reading (with a step of 2, 1 reads the odd pixels).',
      showIf: (v) => v.mode !== 'auto',
    }),
    skip: number('Skip bytes', 0, {
      min: 0,
      hint: 'Drop this many bytes from the start of the extracted data (headers, length fields).',
      showIf: (v) => v.mode === 'manual',
    }),
    limit: number('Max bytes', 0, {
      min: 0,
      hint: '0 = everything the image can hold.',
      showIf: (v) => v.mode === 'manual',
    }),
    message: text('Message to hide', 'FTF{lsb}', { showIf: (v) => v.mode === 'encode' }),
  },
  examples: [
    {
      label: 'Auto-scan an LSB flag',
      input: { sample: 'stego-lsb.png' },
      expect: 'flag{lsb_hidden_in_pixels}',
    },
    {
      label: 'Manual: red/green/blue, bit 0',
      input: { sample: 'stego-lsb.png' },
      options: { mode: 'manual', channels: 'rgb', planes: '0', limit: 40 },
      expect: 'flag{lsb_hidden_in_pixels}',
    },
    {
      label: 'Flag on one row, every other pixel',
      input: { sample: 'stego-lsb-zone.png' },
      expect: 'FTF{lsb_row0_step2}',
    },
    {
      label: 'Manual: row 0, every other pixel',
      input: { sample: 'stego-lsb-zone.png' },
      options: { mode: 'manual', rows: '0', step: 2, offset: 0, limit: 19 },
      expect: 'FTF{lsb_row0_step2}',
    },
  ],
  run({ image }, o) {
    if (!image.width || !image.height) throw new ToolError(T('error.noPixels'));
    const out: Output[] = [];

    if (o.mode === 'manual' || o.mode === 'encode') {
      const params = manualParams(image, o);
      const capacity = capacityBytes(image, params);
      const rowsText = o.rows.trim();
      const walk = [
        ...(rowsText ? ([[T('kv.zone'), rowsText]] as [string, string][]) : []),
        ...(o.step > 1 ? ([[T('kv.step'), String(o.step)]] as [string, string][]) : []),
        ...(o.offset > 0 ? ([[T('kv.offset'), String(o.offset)]] as [string, string][]) : []),
      ];
      if (o.mode === 'encode') {
        const msg = utf8Encode(o.message);
        if (!msg.length) throw new ToolError(T('error.noMessage'));
        // A closing NUL when it fits, so the auto scan knows where the message stops.
        const payload = msg.length < capacity ? Uint8Array.of(...msg, 0) : msg;
        const stego = embedBits(image, params, payload);
        if (!stego) throw new ToolError(T('error.noFit', { need: msg.length, capacity }));
        out.push({
          type: 'image',
          label: T('label.stego'),
          image: stego,
          filename: 'lsb-stego.png',
        });
        out.push({ type: 'note', level: 'success', text: T('note.encoded', { n: msg.length }) });
        return out;
      }
      if (!Number.isInteger(o.skip) || o.skip < 0) {
        throw new ToolError(T('error.skip'));
      }
      if (!Number.isInteger(o.limit) || o.limit < 0) {
        throw new ToolError(T('error.limit'));
      }
      const full = extractBits(image, params, o.limit ? o.skip + o.limit : Infinity);
      const bytes = full.subarray(o.skip);
      if (!bytes.length) {
        throw new ToolError(T('error.nothingLeft', { count: capacity, skip: o.skip }));
      }
      out.push({
        type: 'kv',
        label: T('label.extraction'),
        entries: [
          [T('kv.channels'), channelsToString(params.channels)],
          [T('kv.planes'), fmtPlanes(params.planes)],
          [T('kv.pixelOrder'), orderLabel(o)],
          [T('kv.bitOrder'), o.bitOrder === 'msb' ? T('value.msb') : T('value.lsb')],
          ...walk,
          [T('kv.extracted'), T('value.extracted', { n: bytes.length, capacity })],
        ],
      });
      const sig = strongSignature(bytes);
      if (sig) {
        out.push({
          type: 'note',
          level: 'success',
          text: T('note.magic', { name: signatureName(sig), ext: sig.ext }),
        });
      }
      if (printableRatio(bytes.subarray(0, 512)) > 0.9) {
        out.push({ type: 'note', level: 'info', text: T('note.readable') });
      }
      out.push({
        type: 'bytes',
        label: T('label.extracted'),
        value: bytes,
        filename: sig ? `lsb-extract.${sig.ext}` : 'lsb-extract.bin',
      });
      const body = lengthPrefixed(bytes);
      if (body) {
        out.push({ type: 'text', label: T('label.body'), value: preview(body, 512) });
        out.push(...nextSteps(body));
      } else if (!sig) {
        out.push(...nextSteps(bytes.subarray(0, printableRun(bytes))));
      }
      out.push({ type: 'note', level: 'info', text: T('note.seeAlso') });
      return out;
    }

    const full = scan(image);
    const zoned = scanZones(image);
    const hits = [...full.hits, ...zoned.hits].sort(
      (a, b) => TIER[b.kind] - TIER[a.kind] || b.score - a.score,
    );
    out.push({
      type: 'note',
      level: 'info',
      text: T('note.scanned', { count: full.tried, kib: SCAN_BYTES / 1024 }),
    });
    if (zoned.anomalies.length) {
      out.push({
        type: 'table',
        label: T('label.anomalies'),
        columns: [T('col.row'), T('col.score')],
        rows: zoned.anomalies
          .slice()
          .sort((a, b) => b.score - a.score || a.row - b.row)
          .slice(0, MAX_ANOMALY_ROWS)
          .map((a) => [String(a.row), a.score.toFixed(2)]),
        highlight: [0],
      });
      out.push({
        type: 'note',
        level: 'info',
        text: zoned.stride
          ? T('note.zoneStride', {
              n: zoned.tried,
              rows: zoned.zones.join(' | '),
              step: zoned.stride.step,
              offset: zoned.stride.offset,
            })
          : T('note.zones', { n: zoned.tried, rows: zoned.zones.join(' | ') }),
      });
    }
    const best = hits[0];
    if (!best) {
      out.push({
        type: 'note',
        level: 'warn',
        text: T('note.nothing'),
      });
      out.push({ type: 'note', level: 'info', text: T('note.seeAlso') });
      return out;
    }
    out.push({
      type: 'table',
      label: T('label.hits'),
      columns: [T('col.params'), T('col.what'), T('col.preview')],
      rows: hits.slice(0, MAX_ROWS).map((h) => [hitLabel(h), h.what, h.preview]),
      highlight: [0],
    });
    if (hits.length > MAX_ROWS) {
      out.push({
        type: 'note',
        level: 'info',
        text: T('note.weaker', { count: hits.length - MAX_ROWS }),
      });
    }
    const stream = extractBits(image, best.params, 1 << 26);
    const carved = carve(stream, best);
    const body = best.kind === 'file' ? null : lengthPrefixed(carved.bytes);
    const bytes = body ?? carved.bytes;
    out.push({
      type: 'note',
      level: best.kind === 'flag' || best.kind === 'file' ? 'success' : 'info',
      text: T('note.best', { params: hitLabel(best), what: best.what }),
    });
    out.push({ type: 'bytes', label: T('label.best'), value: bytes, filename: carved.filename });
    if (best.kind !== 'file') out.push(...nextSteps(bytes));
    out.push({ type: 'note', level: 'info', text: T('note.seeAlso') });
    return out;
  },
});
