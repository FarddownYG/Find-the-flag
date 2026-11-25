import { defineTool } from '../../core/define';
import { ToolError } from '../../core/errors';
import { registeredTools } from '../../core/tool-list';
import type { Output, RgbaImage } from '../../core/types';
import { toolName, toolT } from '../../i18n/tool-text';
import {
  channelSamples,
  chiByBands,
  chiSquare,
  coherenceByRow,
  outlierPixels,
  rsAnalysis,
  type Outlier,
} from './_steganalysis';

const T = toolT('steganalysis');

const CHANNELS = ['R', 'G', 'B'];
const MAX_BANDS = 16;
const BAND_HOT = 0.8;
/** chi-square p above this on a channel with enough pairs: LSB replacement is near certain. */
const CHI_STRONG = 0.9;
const CHI_SUSPECT = 0.5;
/** Fewer value pairs than this and the chi-square test is noise. */
const MIN_PAIRS = 10;
const RS_STRONG = 0.15;
const RS_SUSPECT = 0.05;
/** A coherence row is anomalous when it is this far above the median row, and at least this high. */
const COHERENCE_GAP = 0.2;
const COHERENCE_FLOOR = 0.25;
const MAX_ZONE_ROWS = 12;
const MAX_OUTLIER_ROWS = 16;
/** A channel with a handful of lone pixels (not hundreds, as on a noisy photo) is worth a look. */
const OUTLIER_FEW = 8;

const pct = (p: number) => `${(p * 100).toFixed(p >= 0.995 || p < 0.005 ? 1 : 0)}%`;

interface Span {
  from: number;
  to: number;
}

const spans = (rows: number[]): Span[] => {
  const out: Span[] = [];
  for (const r of rows) {
    const last = out[out.length - 1];
    if (last && last.to === r - 1) last.to = r;
    else out.push({ from: r, to: r });
  }
  return out;
};

const spanLabel = (s: Span) => (s.from === s.to ? String(s.from) : `${s.from}-${s.to}`);

const medianOf = (v: number[]): number => {
  const s = [...v].sort((a, b) => a - b);
  return s[s.length >> 1] ?? 0;
};

/** Rows whose inter-channel break rate stands well above the image's usual level. */
function anomalousRows(coh: number[]): number[] {
  if (coh.length < 4) return [];
  const limit = Math.max(COHERENCE_FLOOR, medianOf(coh) + COHERENCE_GAP);
  const rows: number[] = [];
  coh.forEach((c, y) => {
    if (c >= limit) rows.push(y);
  });
  // Nearly every row flagged is a noisy image, not a tampered zone.
  return rows.length * 2 > coh.length ? [] : rows;
}

/** A faithful copy of the image with the given rows' red channel boosted. */
function tintRows(img: RgbaImage, rows: number[]): RgbaImage {
  const data = new Uint8ClampedArray(img.data);
  for (const y of rows) {
    for (let x = 0; x < img.width; x++) {
      const o = (y * img.width + x) * 4;
      data[o] = Math.min(255, data[o]! * 0.4 + 153);
      data[o + 1] = data[o + 1]! * 0.6;
      data[o + 2] = data[o + 2]! * 0.6;
    }
  }
  return { width: img.width, height: img.height, data };
}

/** The lone-pixel values read as one big-endian number, with the hex bytes. */
function readLength(list: Outlier[]): { hex: string; value: bigint } {
  const bytes = list.map((o) => o.value);
  return {
    hex: bytes.map((b) => b.toString(16).padStart(2, '0')).join(' '),
    value: bytes.reduce((acc, b) => (acc << 8n) | BigInt(b), 0n),
  };
}

type Level = 0 | 1 | 2;

export default defineTool({
  id: 'steganalysis',
  name: 'Steganalysis (is something hidden?)',
  category: 'stego',
  description:
    'Detect hidden data in an image without extracting it: chi-square (Westfeld-Pfitzmann) and RS (Fridrich) tests on the low bits of R, G and B, inter-channel coherence by row to spot tampered zones, and lone outlier pixels. Verdict first, with the rows and bands that stand out.',
  tags: [
    'steganalysis',
    'chi-square',
    'westfeld',
    'RS analysis',
    'fridrich',
    'detection',
    'is there hidden data',
    'lsb detection',
    'stego detector',
  ],
  input: 'image',
  placeholder: 'Drop a lossless image (PNG, BMP, GIF, PPM): the test reads exact pixel values',
  options: {},
  examples: [
    {
      label: 'Detect LSB embedding',
      input: { sample: 'stego-lsb.png' },
      expect: 'strong signs of LSB embedding',
    },
    {
      label: 'Clean control: nothing hidden',
      input: { sample: 'stego-clean.png' },
      expect: 'no sign of hidden data',
    },
  ],
  run({ image }) {
    if (!image.width || !image.height) throw new ToolError(T('error.noPixels'));
    const { width: w, height: h } = image;
    const pixels = w * h;

    // ---- signals ----
    const chi = [0, 1, 2].map((c) => chiSquare(channelSamples(image, c)));
    const bandCount = pixels >= MAX_BANDS * 128 ? MAX_BANDS : pixels >= 8 * 128 ? 8 : 4;
    const bands = [0, 1, 2].map((c) => chiByBands(channelSamples(image, c), bandCount));
    const rs = [0, 1, 2].map((c) => rsAnalysis(image, c));
    const coh = coherenceByRow(image);
    const zoneRows = anomalousRows(coh);
    const outliers = [0, 1, 2].map((c) => outlierPixels(image, c, 48, 32));

    // ---- verdict ----
    const chiMax = Math.max(...chi.map((c) => (c.pairs >= MIN_PAIRS ? c.p : 0)));
    const rsMax = Math.max(...rs.map((r) => r.estimate));
    const fewOutliers = outliers.some((o) => o.length > 0 && o.length <= OUTLIER_FEW);
    let level: Level = 0;
    const reasons: string[] = [];
    if (chiMax > CHI_STRONG) {
      level = 2;
      reasons.push(T('reason.chi', { p: pct(chiMax) }));
    } else if (chiMax > CHI_SUSPECT) {
      level = Math.max(level, 1) as Level;
      reasons.push(T('reason.chi', { p: pct(chiMax) }));
    }
    if (rsMax > RS_STRONG) {
      level = 2;
      reasons.push(T('reason.rs', { p: pct(rsMax) }));
    } else if (rsMax > RS_SUSPECT) {
      level = Math.max(level, 1) as Level;
      reasons.push(T('reason.rs', { p: pct(rsMax) }));
    }
    if (zoneRows.length) {
      level = Math.max(level, 1) as Level;
      reasons.push(
        T('reason.zone', { rows: spans(zoneRows).slice(0, 4).map(spanLabel).join(', ') }),
      );
    }
    if (fewOutliers) {
      level = Math.max(level, 1) as Level;
      reasons.push(T('reason.outliers'));
    }

    const out: Output[] = [];
    out.push(
      level === 2
        ? {
            type: 'note',
            level: 'warn',
            text: T('verdict.strong', { reasons: reasons.join(' · ') }),
          }
        : level === 1
          ? {
              type: 'note',
              level: 'warn',
              text: T('verdict.suspicious', { reasons: reasons.join(' · ') }),
            }
          : { type: 'note', level: 'success', text: T('verdict.clean') },
    );
    out.push({ type: 'note', level: 'info', text: T('note.detectsOnly') });

    // ---- chi-square ----
    out.push({
      type: 'kv',
      label: T('label.chi'),
      entries: CHANNELS.map((name, c): [string, string] => [
        name,
        chi[c]!.pairs >= MIN_PAIRS
          ? T('value.chi', { p: pct(chi[c]!.p), pairs: chi[c]!.pairs })
          : T('value.chiFew', { p: pct(chi[c]!.p), pairs: chi[c]!.pairs }),
      ]),
    });
    const hot: number[] = [];
    const bandRows: (string | number)[][] = [];
    for (let b = 0; b < bandCount; b++) {
      const first = Math.floor((b * pixels) / bandCount / w);
      const last = Math.min(h - 1, Math.floor((((b + 1) * pixels) / bandCount - 1) / w));
      const ps = [0, 1, 2].map((c) => bands[c]![b] ?? 0);
      if (Math.max(...ps) > BAND_HOT) hot.push(b);
      bandRows.push([
        `${b + 1}/${bandCount}`,
        first === last ? String(first) : `${first}-${last}`,
        ...ps.map(pct),
      ]);
    }
    out.push({
      type: 'table',
      label: T('label.bands'),
      columns: [T('col.band'), T('col.rows'), ...CHANNELS],
      rows: bandRows,
      highlight: hot,
    });
    if (hot.length && hot.length < bandCount) {
      out.push({
        type: 'note',
        level: 'info',
        text: T('note.bandsPartial', { hot: hot.length, total: bandCount }),
      });
    }

    // ---- RS ----
    out.push({
      type: 'kv',
      label: T('label.rs'),
      entries: CHANNELS.map((name, c): [string, string] => [name, pct(rs[c]!.estimate)]),
    });
    out.push({ type: 'note', level: 'info', text: T('note.rsIndicator') });

    // ---- coherence ----
    if (zoneRows.length) {
      const zs = spans(zoneRows);
      out.push({
        type: 'table',
        label: T('label.zones'),
        columns: [T('col.rows'), T('col.breaks')],
        rows: zs.slice(0, MAX_ZONE_ROWS).map((s) => {
          let sum = 0;
          for (let y = s.from; y <= s.to; y++) sum += coh[y]!;
          return [spanLabel(s), pct(sum / (s.to - s.from + 1))];
        }),
        highlight: zs.slice(0, MAX_ZONE_ROWS).map((_, i) => i),
      });
      out.push({
        type: 'note',
        level: 'warn',
        text: T('note.zones', { median: pct(medianOf(coh)) }),
      });
      out.push({
        type: 'image',
        label: T('label.preview'),
        image: tintRows(image, zoneRows),
        filename: 'steganalysis-zones.png',
      });
    } else {
      out.push({
        type: 'note',
        level: 'info',
        text: T('note.noZones', { median: pct(medianOf(coh)) }),
      });
    }

    // ---- outliers ----
    const found = outliers.flatMap((list, c) =>
      list.map((o) => ({ ...o, channel: CHANNELS[c]!, gap: Math.abs(o.value - o.median) })),
    );
    if (found.length) {
      found.sort((a, b) => b.gap - a.gap || a.y - b.y || a.x - b.x);
      out.push({
        type: 'table',
        label: T('label.outliers'),
        columns: ['x', 'y', T('col.channel'), T('col.value'), T('col.median')],
        rows: found.slice(0, MAX_OUTLIER_ROWS).map((o) => [o.x, o.y, o.channel, o.value, o.median]),
      });
      // A few lone pixels in one channel: their values may be a planted length or message.
      const c = outliers.findIndex((o) => o.length >= 2 && o.length <= OUTLIER_FEW);
      if (c >= 0) {
        const r = readLength(outliers[c]!);
        out.push({
          type: 'note',
          level: 'info',
          text: T('note.outlierLength', {
            channel: CHANNELS[c]!,
            n: outliers[c]!.length,
            hex: r.hex,
            value: r.value.toString(),
          }),
        });
      }
    } else {
      out.push({ type: 'note', level: 'info', text: T('note.noOutliers') });
    }

    // ---- next steps ----
    const ids = ['lsb', 'pvd'];
    const known = registeredTools();
    const actions = ids
      .map((id) => known.find((x) => x.id === id))
      .filter((x): x is NonNullable<typeof x> => x !== undefined)
      .map((tool) => ({
        label: T('open', { tool: toolName(tool) }),
        options: {},
        open: { tool: tool.id, text: '' },
      }));
    if (actions.length) {
      out.push({ type: 'actions', label: T('label.next'), actions });
    }

    // ---- how it works ----
    out.push({ type: 'note', level: 'info', text: T('tech.chi') });
    out.push({ type: 'note', level: 'info', text: T('tech.rs') });
    out.push({ type: 'note', level: 'info', text: T('tech.coherence') });
    out.push({ type: 'note', level: 'info', text: T('tech.outliers') });
    return out;
  },
});
