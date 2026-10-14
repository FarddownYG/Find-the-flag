import { defineTool, number, toggle } from '../../core/define';
import { ToolError } from '../../core/errors';
import type { Output, RgbaImage } from '../../core/types';
import { formatSize } from '../../lib/bytes';
import { identify } from '../../lib/signatures';
import { Canvas, COLORS, shortSize, type Rgb } from './_chart';

const MAX_BLOCKS = 50_000;

export interface EntropyBlock {
  start: number;
  /** Exclusive. */
  end: number;
  /** Shannon entropy in bits per byte, 0..8. */
  entropy: number;
}

export interface Region {
  start: number;
  end: number;
  mean: number;
}

/** Shannon entropy (bits per byte) of a byte histogram. */
export function shannon(counts: ArrayLike<number>, total: number): number {
  if (total === 0) return 0;
  let h = 0;
  for (let i = 0; i < counts.length; i++) {
    const c = counts[i]!;
    if (c > 0) {
      const p = c / total;
      h -= p * Math.log2(p);
    }
  }
  return h;
}

/**
 * About 256 blocks, rounded up to a power of two so the boundaries are round hex offsets.
 * Never below 1 KiB: random data in shorter blocks cannot reach 8 bits (256 random bytes
 * read about 7.2), which would make every threshold lie.
 */
export function autoBlockSize(length: number): number {
  let size = 1024;
  while (size * 256 < length) size *= 2;
  return size;
}

/** Block boundaries: whole blocks, and a last short block only if it is at least half a block. */
export function edges(length: number, block: number): number[] {
  const full = Math.floor(length / block);
  const rest = length - full * block;
  const out: number[] = [];
  for (let i = 0; i < full; i++) out.push(i * block);
  if (full === 0 || rest >= block / 2) out.push(full * block);
  out.push(length);
  return out;
}

export function analyse(
  bytes: Uint8Array,
  block: number,
): { overall: number; counts: Uint32Array; blocks: EntropyBlock[] } {
  const bounds = edges(bytes.length, block);
  const total = new Uint32Array(256);
  const blocks: EntropyBlock[] = [];
  const counts = new Uint32Array(256);
  for (let b = 0; b + 1 < bounds.length; b++) {
    const start = bounds[b]!;
    const end = bounds[b + 1]!;
    counts.fill(0);
    for (let i = start; i < end; i++) counts[bytes[i]!] = counts[bytes[i]!]! + 1;
    blocks.push({ start, end, entropy: shannon(counts, end - start) });
    for (let k = 0; k < 256; k++) total[k] = total[k]! + counts[k]!;
  }
  return { overall: shannon(total, bytes.length), counts: total, blocks };
}

/** Runs of consecutive blocks at or above `threshold`. */
export function highRegions(blocks: EntropyBlock[], threshold: number): Region[] {
  const regions: Region[] = [];
  let open: { start: number; end: number; sum: number; weight: number } | null = null;
  const close = () => {
    if (open) regions.push({ start: open.start, end: open.end, mean: open.sum / open.weight });
    open = null;
  };
  for (const b of blocks) {
    if (b.entropy >= threshold) {
      const w = b.end - b.start;
      if (open) {
        open.end = b.end;
        open.sum += b.entropy * w;
        open.weight += w;
      } else {
        open = { start: b.start, end: b.end, sum: b.entropy * w, weight: w };
      }
    } else close();
  }
  close();
  return regions;
}

// ---------- charts ----------

const levelColor = (e: number, threshold: number): Rgb =>
  e >= threshold ? COLORS.alert : e >= 5 ? COLORS.amber : COLORS.sea;

export function entropyChart(
  blocks: EntropyBlock[],
  size: number,
  threshold: number,
  style: 'bars' | 'line',
): RgbaImage {
  const W = 960;
  const H = 340;
  const L = 52;
  const R = 16;
  const T = 16;
  const B = 36;
  const plotW = W - L - R;
  const plotH = H - T - B;
  const base = T + plotH;
  const yOf = (e: number) => base - (Math.min(8, Math.max(0, e)) / 8) * plotH;
  const c = new Canvas(W, H, COLORS.ground);

  for (let v = 0; v <= 8; v++) {
    const y = Math.round(yOf(v));
    c.hline(L, L + plotW, y, v === 0 ? COLORS.axis : COLORS.grid);
    c.text(L - 8, y - 7, String(v), COLORS.label, 2, 'right');
  }
  const n = blocks.length;
  const xAt = (offset: number) => L + (offset / size) * plotW;
  blocks.forEach((b, i) => {
    const x0 = L + Math.floor((i * plotW) / n);
    const x1 = L + Math.floor(((i + 1) * plotW) / n);
    const w = x1 - x0;
    if (style === 'bars') {
      c.rect(
        x0,
        yOf(b.entropy),
        w >= 3 ? w - 1 : w,
        base - yOf(b.entropy),
        levelColor(b.entropy, threshold),
      );
    } else {
      c.rect(x0, yOf(b.entropy), w, base - yOf(b.entropy), COLORS.soft);
    }
  });
  if (style === 'line') {
    let prev: [number, number, number] | null = null;
    blocks.forEach((b, i) => {
      const x = L + Math.floor(((i + 0.5) * plotW) / n);
      const y = yOf(b.entropy);
      if (prev)
        c.line(prev[0], prev[1], x, y, levelColor(Math.max(prev[2], b.entropy), threshold), 2);
      else c.rect(x - 1, y - 1, 3, 3, levelColor(b.entropy, threshold));
      prev = [x, y, b.entropy];
    });
  }
  // threshold line and label
  const ty = Math.round(yOf(threshold));
  c.hline(L, L + plotW, ty, COLORS.alert, [6, 4]);
  c.text(L - 8, ty - 7, threshold.toFixed(1), COLORS.alert, 2, 'right');
  // x axis ticks in bytes
  for (let i = 0; i <= 5; i++) {
    const x = Math.round(xAt((size * i) / 5));
    c.vline(Math.min(x, L + plotW), base, base + 5, COLORS.axis);
    c.text(
      Math.min(x, L + plotW),
      base + 10,
      shortSize((size * i) / 5),
      COLORS.label,
      2,
      i === 0 ? 'left' : i === 5 ? 'right' : 'center',
    );
  }
  c.vline(L, T, base, COLORS.axis);
  return c.image();
}

const HEX_LABELS: [number, string][] = [
  [0x00, '00'],
  [0x40, '40'],
  [0x80, '80'],
  [0xc0, 'C0'],
  [0xff, 'FF'],
];

const byteColor = (v: number): Rgb =>
  v === 0
    ? COLORS.amber
    : v >= 0x20 && v < 0x7f
      ? COLORS.sea
      : v >= 0x80
        ? COLORS.ok
        : COLORS.label;

/** Compact count for an axis: 950, 12.4K, 3M (powers of 1000). */
function shortCount(n: number): string {
  const trim = (v: number) => String(Math.round(v * 10) / 10);
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${trim(n / 1000)}K`;
  if (n < 1e9) return `${trim(n / 1e6)}M`;
  return `${trim(n / 1e9)}G`;
}

export function histogramChart(counts: ArrayLike<number>, total: number): RgbaImage {
  const barW = 3;
  const L = 52;
  const R = 16;
  const T = 16;
  const B = 36;
  const plotW = 256 * barW;
  const W = L + plotW + R;
  const H = 300;
  const plotH = H - T - B;
  const base = T + plotH;
  let max = 1;
  for (let i = 0; i < 256; i++) max = Math.max(max, counts[i]!);
  const yOf = (v: number) => base - (v / max) * plotH;
  const c = new Canvas(W, H, COLORS.ground);
  for (const f of [0, 0.5, 1]) {
    const y = Math.round(yOf(max * f));
    c.hline(L, L + plotW, y, f === 0 ? COLORS.axis : COLORS.grid);
    c.text(L - 8, y - 7, shortCount(max * f), COLORS.label, 2, 'right');
  }
  for (let v = 0; v < 256; v++) {
    const count = counts[v]!;
    if (count > 0) c.rect(L + v * barW, yOf(count), barW - 1, base - yOf(count), byteColor(v));
  }
  // Where every byte value would sit if the data were uniformly random.
  c.hline(L, L + plotW, Math.round(yOf(total / 256)), COLORS.axis, [4, 6]);
  for (const [v, label] of HEX_LABELS) {
    const x = L + v * barW + 1;
    c.vline(x, base, base + 5, COLORS.axis);
    c.text(
      x,
      base + 10,
      label,
      COLORS.label,
      2,
      v === 0xff ? 'right' : v === 0 ? 'left' : 'center',
    );
  }
  c.vline(L, T, base, COLORS.axis);
  return c.image();
}

// ---------- verdict ----------

const COMPRESSED_IDS = new Set([
  'png',
  'jpeg',
  'gif',
  'webp',
  'zip',
  'gzip',
  'bzip2',
  'xz',
  '7z',
  'rar4',
  'rar5',
  'zstd',
  'lz4',
  'mp3-id3',
  'ogg',
  'flac',
  'mp4',
  'mkv',
  'heic',
  'avif',
  'cab',
  'rpm',
  'deb',
]);

function verdict(
  overall: number,
  mostCommon: { value: number; share: number },
  typeName: string | null,
  compressedType: boolean,
): Output {
  if (overall >= 7.9) {
    return {
      type: 'note',
      level: compressedType ? 'info' : 'warn',
      text: compressedType
        ? `Entropy ${overall.toFixed(3)} ≈ 8: normal for a ${typeName} (already compressed). Look at the regions near its end for appended data.`
        : `Entropy ${overall.toFixed(3)} ≈ 8: the data is encrypted, compressed or random. If it is not a known compressed format, suspect encryption: look for a key, an XOR pattern or a custom scheme.`,
    };
  }
  if (overall >= 7) {
    return {
      type: 'note',
      level: 'info',
      text: `Entropy ${overall.toFixed(3)}: compressed data, or encrypted data with some structure around it.`,
    };
  }
  if (overall >= 5) {
    return {
      type: 'note',
      level: 'info',
      text: `Entropy ${overall.toFixed(3)}: typical of executable code, mixed binary data or non-English text.`,
    };
  }
  const zeros = mostCommon.value === 0 && mostCommon.share > 0.5;
  return {
    type: 'note',
    level: 'info',
    text: zeros
      ? `Low entropy (${overall.toFixed(3)}): mostly zero bytes, so padding or a sparse image. Real content may hide in the non-zero parts.`
      : `Low entropy (${overall.toFixed(3)}): this looks like text, code or sparse data, not encrypted or compressed.`,
  };
}

export default defineTool({
  id: 'entropy',
  name: 'Entropy',
  category: 'forensics',
  description:
    'Measure how random the data is, block by block: spot encrypted or compressed parts, and plot the byte histogram.',
  tags: [
    'shannon',
    'randomness',
    'encrypted',
    'compressed',
    'histogram',
    'binwalk -E',
    'packed',
    'chart',
  ],
  input: 'bytes',
  placeholder: 'Drop any file — an image, a firmware, a suspicious blob…',
  options: {
    block: number('Block size (bytes)', 0, {
      min: 0,
      max: 1 << 26,
      hint: '0 = automatic (about 256 blocks, at least 1024 bytes). Shorter blocks read lower than 8 even for random data.',
    }),
    threshold: number('High-entropy threshold', 7.5, { min: 1, max: 8, step: 0.1 }),
    chart: toggle('Chart', [
      { value: 'bars', label: 'Bars' },
      { value: 'line', label: 'Line' },
    ]),
  },
  examples: [
    {
      label: 'Plain text',
      input:
        'The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs. How vexingly quick daft zebras jump!',
      expect: 'looks like text',
    },
    {
      label: 'An image with data glued after it',
      input: { sample: 'forensics-polyglot.png' },
      expect: 'bits/byte (',
    },
    {
      label: 'Smaller blocks',
      input: { sample: 'forensics-strings.bin' },
      options: { block: 512, chart: 'line' },
      expect: '512 bytes (6 blocks)',
    },
  ],
  run({ bytes }, { block, threshold, chart }) {
    if (bytes.length === 0) throw new ToolError('The input is empty: drop a file to measure.');
    const size = block > 0 ? Math.floor(block) : autoBlockSize(bytes.length);
    const count = Math.ceil(bytes.length / size);
    if (count > MAX_BLOCKS) {
      throw new ToolError(
        `A block size of ${size} bytes would make ${count} blocks. Use at least ${Math.ceil(bytes.length / MAX_BLOCKS)} bytes, or 0 for automatic.`,
      );
    }
    const { overall, counts, blocks } = analyse(bytes, size);
    const regions = highRegions(blocks, threshold);

    let top = 0;
    let distinct = 0;
    for (let v = 0; v < 256; v++) {
      if (counts[v]! > 0) distinct++;
      if (counts[v]! > counts[top]!) top = v;
    }
    const mostCommon = { value: top, share: counts[top]! / bytes.length };
    const type = identify(bytes).find((s) => !s.weak) ?? null;
    let lowest = 8;
    let highest = 0;
    for (const b of blocks) {
      lowest = Math.min(lowest, b.entropy);
      highest = Math.max(highest, b.entropy);
    }

    const out: Output[] = [
      verdict(
        overall,
        mostCommon,
        type?.name ?? null,
        type !== null && COMPRESSED_IDS.has(type.id),
      ),
      {
        type: 'kv',
        label: 'Summary',
        entries: [
          ['Size', `${formatSize(bytes.length)} (${bytes.length} bytes)`],
          [
            'Shannon entropy',
            `${overall.toFixed(4)} bits/byte (${((overall / 8) * 100).toFixed(1)}% of the maximum)`,
          ],
          ['Block size', `${size} bytes (${blocks.length} block${blocks.length === 1 ? '' : 's'})`],
          ['Lowest / highest block', `${lowest.toFixed(3)} / ${highest.toFixed(3)}`],
          ['Distinct byte values', `${distinct} of 256`],
          [
            'Most common byte',
            `0x${top.toString(16).padStart(2, '0')} (${(mostCommon.share * 100).toFixed(1)}%)`,
          ],
        ],
      },
      {
        type: 'image',
        label: `Entropy per block (bits per byte, dashed line = ${threshold.toFixed(1)})`,
        image: entropyChart(blocks, bytes.length, threshold, chart),
        filename: 'entropy.png',
      },
    ];
    if (size < 1024 && bytes.length >= 1024) {
      out.push({
        type: 'note',
        level: 'info',
        text: 'Blocks under 1024 bytes read lower than 8 even for random data (256 random bytes give about 7.2), so the threshold is optimistic here.',
      });
    }
    if (regions.length > 0) {
      out.push({
        type: 'table',
        label: 'High-entropy regions',
        columns: ['Start', 'End', 'Size', 'Mean entropy', 'Looks like'],
        rows: regions.map((r) => [
          `0x${r.start.toString(16)}`,
          `0x${r.end.toString(16)}`,
          r.end - r.start,
          r.mean.toFixed(3),
          r.mean >= 7.9 ? 'random: encrypted or already compressed' : 'compressed or encrypted',
        ]),
      });
      if (overall < threshold && regions.length < blocks.length) {
        out.push({
          type: 'note',
          level: 'warn',
          text: 'The file is mostly low-entropy but contains high-entropy regions: an encrypted or compressed payload may be embedded. Try Carve on those offsets.',
        });
      }
    } else {
      out.push({
        type: 'note',
        level: 'info',
        text: `No block reaches ${threshold.toFixed(1)} bits/byte, so nothing looks encrypted or compressed.`,
      });
    }
    out.push({
      type: 'image',
      label:
        'Byte histogram (blue: printable ASCII, orange: 0x00, green: 0x80-0xFF, grey: other control bytes; dashed line: height if every value were equally likely)',
      image: histogramChart(counts, bytes.length),
      filename: 'histogram.png',
    });
    return out;
  },
});
