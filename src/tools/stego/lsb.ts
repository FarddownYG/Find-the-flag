import { defineTool, number, text, toggle } from '../../core/define';
import { ToolError } from '../../core/errors';
import type { Output, RgbaImage } from '../../core/types';
import { signatureName, toolT } from '../../i18n/tool-text';
import { printableRatio, toHex } from '../../lib/bytes';
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
  classifyStream,
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
    ]),
    channels: text('Channels', 'rgb', {
      placeholder: 'rgb',
      hint: 'Reading order of r, g, b, a within each pixel: "rgb", "bgr", "r", "rgba"...',
      showIf: (v) => v.mode === 'manual',
    }),
    planes: text('Bit planes', '0', {
      placeholder: '0',
      hint: '0 is the least significant bit. "0", "0,1" or "0-2" (several bits per channel).',
      showIf: (v) => v.mode === 'manual',
    }),
    order: toggle(
      'Pixel order',
      [
        { value: 'row', label: 'Row by row' },
        { value: 'col', label: 'Column by column' },
      ],
      'row',
      { showIf: (v) => v.mode === 'manual' },
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
        showIf: (v) => v.mode === 'manual',
      },
    ),
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
  ],
  run({ image }, o) {
    if (!image.width || !image.height) throw new ToolError(T('error.noPixels'));
    const out: Output[] = [];

    if (o.mode === 'manual') {
      const params: LsbParams = {
        channels: parseChannels(o.channels),
        planes: parsePlanes(o.planes),
        order: o.order,
        bitOrder: o.bitOrder,
      };
      if (!Number.isInteger(o.skip) || o.skip < 0) {
        throw new ToolError(T('error.skip'));
      }
      if (!Number.isInteger(o.limit) || o.limit < 0) {
        throw new ToolError(T('error.limit'));
      }
      const full = extractBits(image, params, o.limit ? o.skip + o.limit : Infinity);
      const bytes = full.subarray(o.skip);
      if (!bytes.length) {
        throw new ToolError(
          T('error.nothingLeft', { count: capacityBytes(image, params), skip: o.skip }),
        );
      }
      out.push({
        type: 'kv',
        label: T('label.extraction'),
        entries: [
          [T('kv.channels'), channelsToString(params.channels)],
          [T('kv.planes'), fmtPlanes(params.planes)],
          [T('kv.pixelOrder'), o.order === 'row' ? T('value.rowByRow') : T('value.colByCol')],
          [T('kv.bitOrder'), o.bitOrder === 'msb' ? T('value.msb') : T('value.lsb')],
          [
            T('kv.extracted'),
            T('value.extracted', { n: bytes.length, capacity: capacityBytes(image, params) }),
          ],
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
      out.push({ type: 'note', level: 'info', text: T('note.seeAlso') });
      return out;
    }

    const { hits, tried } = scan(image);
    out.push({
      type: 'note',
      level: 'info',
      text: T('note.scanned', { count: tried, kib: SCAN_BYTES / 1024 }),
    });
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
      rows: hits.slice(0, MAX_ROWS).map((h) => [paramsLabel(h.params), h.what, h.preview]),
      highlight: [0],
    });
    if (hits.length > MAX_ROWS) {
      out.push({
        type: 'note',
        level: 'info',
        text: T('note.weaker', { count: hits.length - MAX_ROWS }),
      });
    }
    const full = extractBits(image, best.params, 1 << 26);
    const { bytes, filename } = carve(full, best);
    out.push({
      type: 'note',
      level: best.kind === 'flag' || best.kind === 'file' ? 'success' : 'info',
      text: T('note.best', { params: paramsLabel(best.params), what: best.what }),
    });
    out.push({ type: 'bytes', label: T('label.best'), value: bytes, filename });
    out.push({ type: 'note', level: 'info', text: T('note.seeAlso') });
    return out;
  },
});
