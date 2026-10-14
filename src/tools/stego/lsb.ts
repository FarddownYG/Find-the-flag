import { defineTool, number, text, toggle } from '../../core/define';
import { ToolError } from '../../core/errors';
import type { Output, RgbaImage } from '../../core/types';
import { latin1Decode, printableRatio, toHex, u32be, u32le } from '../../lib/bytes';
import { identify, type Signature } from '../../lib/signatures';
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

/** zsteg -a style search space. */
const CHANNEL_ORDERS = ['r', 'g', 'b', 'a', 'rgb', 'bgr', 'rgba', 'abgr'];
const PLANE_SETS = [[0], [1], [2], [3], [0, 1], [0, 1, 2], [0, 1, 2, 3]];
const SCAN_BYTES = 8192;
const MAX_ROWS = 40;
/** Stricter than the shell's flag pattern: random noise must not look like prefix{...}. */
const FLAG_RE = /[A-Za-z][A-Za-z0-9_-]{2,24}\{[\x21-\x7a|~]{4,200}\}/;

const isPrintable = (b: number) => (b >= 0x20 && b < 0x7f) || b === 9 || b === 10 || b === 13;

function printableRun(b: Uint8Array, from = 0): number {
  let n = 0;
  while (from + n < b.length && isPrintable(b[from + n]!)) n++;
  return n;
}

const preview = (b: Uint8Array, max = 64) =>
  latin1Decode(b.subarray(0, max)).replace(/[^\x20-\x7e]/g, '·');

type HitKind = 'flag' | 'file' | 'prefixed' | 'text' | 'inner';
const TIER: Record<HitKind, number> = { flag: 5, file: 4, prefixed: 3, text: 2, inner: 1 };

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
}

const strongSignature = (b: Uint8Array): Signature | undefined =>
  identify(b).find((s) => !s.weak && s.magic.filter((m) => m !== null).length >= 3);

/** Decide whether an extracted prefix looks like something: file, flag, or readable text. */
function classify(b: Uint8Array, params: LsbParams): Hit | null {
  if (b.length < 6) return null;
  let min = 255;
  let max = 0;
  for (const x of b) {
    if (x < min) min = x;
    if (x > max) max = x;
  }
  if (min === max) return null; // a constant plane carries no message

  const run = printableRun(b);
  const flagAt = latin1Decode(b).search(FLAG_RE);
  if (flagAt >= 0) {
    return {
      kind: 'flag',
      params,
      score: (flagAt === 0 ? 10000 : 0) + run,
      what: flagAt === 0 ? 'flag-like text' : `flag-like text at byte ${flagAt}`,
      preview: preview(b.subarray(flagAt)),
      start: flagAt,
    };
  }
  const sig = strongSignature(b);
  if (sig) {
    return {
      kind: 'file',
      params,
      score: sig.magic.length,
      what: `${sig.name} (magic bytes)`,
      preview: toHex(b.subarray(0, 12), ' '),
      start: 0,
      sig,
    };
  }
  for (const le of [false, true]) {
    const len = le ? u32le(b, 0) : u32be(b, 0);
    const payload = b.subarray(4);
    if (
      len >= 6 &&
      len <= 0x1000000 &&
      printableRun(payload) >= Math.min(len, 6) &&
      printableRun(payload) >= 6
    ) {
      return {
        kind: 'prefixed',
        params,
        score: Math.min(len, run),
        what: `length-prefixed text (${le ? 'u32 LE' : 'u32 BE'}, ${len} bytes)`,
        preview: preview(payload),
        start: 4,
      };
    }
  }
  const distinct = new Set(b.subarray(0, run)).size;
  if (run >= 6 && distinct >= 3) {
    return {
      kind: 'text',
      params,
      score: run,
      what: `text (${run} printable chars)`,
      preview: preview(b),
      start: 0,
    };
  }
  // A long readable stretch after a short header or padding.
  let i = 0;
  while (i < b.length) {
    const r = printableRun(b, i);
    if (r >= 24 && new Set(b.subarray(i, i + r)).size >= 6) {
      return {
        kind: 'inner',
        params,
        score: r,
        what: `text at byte ${i} (${r} chars)`,
        preview: preview(b.subarray(i)),
        start: i,
      };
    }
    i += Math.max(1, r);
  }
  return null;
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
    const len = hit.what.match(/(\d+) bytes/);
    const n = len ? Number(len[1]) : from.length;
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
    if (!image.width || !image.height) throw new ToolError('The image has no pixels.');
    const out: Output[] = [];

    if (o.mode === 'manual') {
      const params: LsbParams = {
        channels: parseChannels(o.channels),
        planes: parsePlanes(o.planes),
        order: o.order,
        bitOrder: o.bitOrder,
      };
      if (!Number.isInteger(o.skip) || o.skip < 0) {
        throw new ToolError('"Skip bytes" must be a whole number, 0 or more.');
      }
      if (!Number.isInteger(o.limit) || o.limit < 0) {
        throw new ToolError('"Max bytes" must be a whole number, 0 (everything) or more.');
      }
      const full = extractBits(image, params, o.limit ? o.skip + o.limit : Infinity);
      const bytes = full.subarray(o.skip);
      if (!bytes.length) {
        throw new ToolError(
          `Nothing left to read: the image holds ${capacityBytes(image, params)} bytes with these settings and you skipped ${o.skip}.`,
        );
      }
      out.push({
        type: 'kv',
        label: 'Extraction',
        entries: [
          ['Channels', channelsToString(params.channels)],
          ['Bit planes', fmtPlanes(params.planes)],
          ['Pixel order', o.order === 'row' ? 'row by row' : 'column by column'],
          ['Bit order', o.bitOrder === 'msb' ? 'MSB first' : 'LSB first'],
          ['Bytes extracted', `${bytes.length} (capacity ${capacityBytes(image, params)})`],
        ],
      });
      const sig = strongSignature(bytes);
      if (sig) {
        out.push({
          type: 'note',
          level: 'success',
          text: `The data starts with ${sig.name} magic bytes: download it and open it as .${sig.ext}.`,
        });
      }
      if (printableRatio(bytes.subarray(0, 512)) > 0.9) {
        out.push({ type: 'note', level: 'info', text: 'The data is mostly readable text.' });
      }
      out.push({
        type: 'bytes',
        label: 'Extracted bytes',
        value: bytes,
        filename: sig ? `lsb-extract.${sig.ext}` : 'lsb-extract.bin',
      });
      return out;
    }

    const { hits, tried } = scan(image);
    out.push({
      type: 'note',
      level: 'info',
      text: `Scanned ${tried} combinations (channel order x bit planes x pixel order x bit order), first ${SCAN_BYTES / 1024} KiB of each.`,
    });
    const best = hits[0];
    if (!best) {
      out.push({
        type: 'note',
        level: 'warn',
        text: 'No readable text, flag or file signature found. Try Manual mode (other bit planes, a start offset), look at the Bit planes tool, or check whether the image is lossy (JPEG) so the bits are gone.',
      });
      return out;
    }
    out.push({
      type: 'table',
      label: 'Hits',
      columns: ['Parameters', 'What it is', 'Preview'],
      rows: hits.slice(0, MAX_ROWS).map((h) => [paramsLabel(h.params), h.what, h.preview]),
      highlight: [0],
    });
    if (hits.length > MAX_ROWS) {
      out.push({
        type: 'note',
        level: 'info',
        text: `${hits.length - MAX_ROWS} weaker hits not shown.`,
      });
    }
    const full = extractBits(image, best.params, 1 << 26);
    const { bytes, filename } = carve(full, best);
    out.push({
      type: 'note',
      level: best.kind === 'flag' || best.kind === 'file' ? 'success' : 'info',
      text: `Best hit: ${paramsLabel(best.params)} (${best.what}).`,
    });
    out.push({ type: 'bytes', label: 'Best hit', value: bytes, filename });
    return out;
  },
});
