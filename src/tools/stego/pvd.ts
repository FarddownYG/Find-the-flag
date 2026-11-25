import { bool, defineTool, select, text, toggle } from '../../core/define';
import { ToolError } from '../../core/errors';
import type { Output, RgbaImage } from '../../core/types';
import { registeredTools } from '../../core/tool-list';
import { toolName, toolT } from '../../i18n/tool-text';
import { toHex } from '../../lib/bytes';
import { plaintextScore } from '../../lib/english';
import { classifyStream, FLAG_RE, KIND_TIER, preview, printableRun } from './_lsb-classify';
import {
  bitsToBytes,
  bytesToBits,
  type Channel,
  embed,
  extractBits,
  type PairTrace,
  parseTable,
  type RangeTable,
  samplesOf,
  sequence,
  TABLES,
  type TableName,
  type Traversal,
} from './_pvd';

const T = toolT('pvd');

const CHANNELS: Channel[] = ['gray', 'r', 'g', 'b', 'rgb'];
const TRAVERSALS: Traversal[] = ['row', 'serpentine', 'column', 'column-serpentine'];
const AUTO_TABLES: TableName[] = ['wu-tsai', 'equal-16', 'equal-8'];
/** Decode only this many bytes per combination when ranking, and sample this many pixels for it. */
const PREVIEW_BYTES = 96;
const PREVIEW_PIXELS = 6000;
const MAX_PIXELS = 30_000_000;

const latin1 = (b: Uint8Array) => {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return s;
};

function tableOf(name: string, custom: string): RangeTable {
  if (name === 'custom') {
    const t = parseTable(custom);
    if (!t) throw new ToolError(T('error.table'));
    return t;
  }
  return TABLES[(name in TABLES ? name : 'wu-tsai') as TableName];
}

/** The file format from magic bytes, and whether it is lossy (bad for PVD). */
function formatNote(bytes: Uint8Array): Output | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return { type: 'note', level: 'warn', text: T('note.jpeg') };
  }
  return null;
}

async function sha(bytes: Uint8Array, algo: 'SHA-1' | 'SHA-256'): Promise<string> {
  const d = await crypto.subtle.digest(algo, bytes as BufferSource);
  return toHex(new Uint8Array(d));
}

interface Settings {
  table: RangeTable;
  tableName: string;
  traversal: Traversal;
  channel: Channel;
  overflow: boolean;
  msbFirst: boolean;
}

function decode(
  image: RgbaImage,
  s: Settings,
  maxBytes = Infinity,
  trace?: PairTrace[],
): Uint8Array {
  const seq = sequence(image.width, image.height, s.traversal);
  const samples = samplesOf(image, s.channel, seq);
  const bits = extractBits(samples, { table: s.table, overflow: s.overflow }, maxBytes * 8, trace);
  return bitsToBytes(bits, s.msbFirst);
}

/** Cut the raw stream to its intended message with the chosen stop rule. */
function applyStop(bytes: Uint8Array, stop: string): { body: Uint8Array; label: string } {
  if (stop === 'null') {
    const i = bytes.indexOf(0);
    return { body: i >= 0 ? bytes.subarray(0, i) : bytes, label: T('stop.null') };
  }
  if (stop === 'readable')
    return { body: bytes.subarray(0, printableRun(bytes)), label: T('stop.readable') };
  if (stop === 'length') {
    const m = latin1(bytes.subarray(0, 12)).match(/^(\d{1,9}):/);
    if (m) {
      const n = Number(m[1]);
      const start = m[0].length;
      return { body: bytes.subarray(start, start + n), label: T('stop.lengthFound', { n }) };
    }
    return { body: bytes, label: T('stop.lengthNone') };
  }
  return { body: bytes, label: T('stop.all') };
}

function scoreStream(bytes: Uint8Array): number {
  const hit = classifyStream(bytes);
  const tier = hit ? KIND_TIER[hit.kind] : 0;
  const txt = latin1(bytes.subarray(0, 512));
  return tier * 1000 + plaintextScore(txt) + (FLAG_RE.test(txt) ? 500 : 0);
}

function settingsLabel(s: Settings): string {
  return T('value.settings', {
    table: s.tableName,
    traversal: T(`traversal.${s.traversal}`),
    channel: T(`channel.${s.channel}`),
    overflow: s.overflow ? T('value.on') : T('value.off'),
    order: s.msbFirst ? 'MSB' : 'LSB',
  });
}

/** A short "redo it by hand" Python decoder with the real settings filled in. */
function pythonScript(s: Settings): string {
  const ranges = JSON.stringify(s.table.map((r) => [r.lo, r.hi, r.bits]));
  const chan =
    s.channel === 'gray'
      ? '0'
      : s.channel === 'r'
        ? '0'
        : s.channel === 'g'
          ? '1'
          : s.channel === 'b'
            ? '2'
            : 'rgb';
  return [
    'from PIL import Image',
    "im = Image.open('stego.png').convert('RGBA'); w, h = im.size; px = im.load()",
    `RANGES = ${ranges}  # (lo, hi, bits)`,
    'def rng(d):',
    '    return next(r for r in RANGES if r[0] <= d <= r[1])',
    '# visiting order',
    'seq = []',
    s.traversal === 'serpentine'
      ? 'for y in range(h):\n    xs = range(w) if y % 2 == 0 else range(w-1, -1, -1)\n    seq += [(x, y) for x in xs]'
      : s.traversal === 'row'
        ? 'for y in range(h):\n    seq += [(x, y) for x in range(w)]'
        : s.traversal === 'column'
          ? 'for x in range(w):\n    seq += [(x, y) for y in range(h)]'
          : 'for x in range(w):\n    ys = range(h) if x % 2 == 0 else range(h-1, -1, -1)\n    seq += [(x, y) for y in ys]',
    chan === 'rgb'
      ? 'vals = [px[x, y][c] for (x, y) in seq for c in (0, 1, 2)]'
      : `vals = [px[x, y][${chan}] for (x, y) in seq]`,
    'bits = []',
    'for i in range(0, len(vals) - 1, 2):',
    '    d = abs(vals[i+1] - vals[i]); lo, hi, n = rng(d); v = d - lo',
    '    bits += [(v >> k) & 1 for k in range(n-1, -1, -1)]',
    `by = bytes(sum(bits[i+${s.msbFirst ? 'k' : '7-k'}] << (7-k) for k in range(8)) for i in range(0, len(bits)-7, 8))`,
    'print(by[:200])',
  ].join('\n');
}

function explain(s: Settings, trace: PairTrace[]): Output[] {
  const out: Output[] = [];
  out.push({ type: 'kv', label: T('label.settings'), entries: [[T('kv.how'), settingsLabel(s)]] });
  if (trace.length) {
    out.push({
      type: 'table',
      label: T('label.pairs'),
      columns: ['p1', 'p2', 'd', T('col.range'), T('col.bits')],
      rows: trace
        .slice(0, 3)
        .map((p) => [
          p.p1,
          p.p2,
          p.d,
          `${p.range.lo}–${p.range.hi}`,
          `${p.value.toString(2).padStart(p.range.bits, '0')} (${p.value})`,
        ]),
    });
  }
  out.push({ type: 'text', label: T('label.python'), value: pythonScript(s) });
  out.push({ type: 'note', level: 'info', text: T('note.sheet') });
  return out;
}

/** Route a decoded blob to the chain decoder only when it still looks encoded (e.g. base64). */
function nextSteps(body: Uint8Array): Output[] {
  const target = registeredTools().find((x) => x.id === 'auto-decode');
  if (!target) return [];
  const txt = latin1(body).trim();
  // A single base64/hex-ish token and not already a flag: worth a chained decode.
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

function decodedOutputs(body: Uint8Array, raw: Uint8Array, stopLabel: string): Output[] {
  const out: Output[] = [];
  out.push({ type: 'note', level: 'info', text: stopLabel });
  out.push({ type: 'text', label: T('label.decoded'), value: preview(body, 512) });
  if (body.length !== raw.length) {
    out.push({ type: 'text', label: T('label.raw'), value: preview(raw, 512) });
  }
  out.push(...nextSteps(body));
  return out;
}

export default defineTool({
  id: 'pvd',
  name: 'PVD steganography (Pixel Value Differencing)',
  category: 'stego',
  description:
    'Read or hide a message in the differences between pixel pairs (Wu & Tsai PVD and variants): pick the range table, the traversal (row, serpentine, column), the channel and the overflow test, or let auto mode try every combination and rank them by readability.',
  tags: [
    'pvd',
    'pixel value differencing',
    'wu tsai',
    'wu-tsai',
    'image steganography',
    'difference',
    'serpentine',
    'edge',
  ],
  input: 'image',
  placeholder: 'Drop a lossless image (PNG, BMP, GIF, PPM): PVD reads exact pixel values',
  options: {
    mode: toggle(
      'Mode',
      [
        { value: 'auto', label: 'Auto (try everything)' },
        { value: 'decode', label: 'Decode' },
        { value: 'encode', label: 'Encode' },
      ],
      'auto',
    ),
    table: select(
      'Range table',
      [
        { value: 'wu-tsai', label: 'Wu & Tsai (3,3,4,5,6,7 bits)' },
        { value: 'equal-16', label: 'Equal width 16 (4 bits)' },
        { value: 'equal-8', label: 'Equal width 8 (3 bits)' },
        { value: 'custom', label: 'Custom…' },
      ],
      'wu-tsai',
      { showIf: (v) => v.mode !== 'auto' },
    ),
    custom: text('Custom widths', '8 8 16 32 64 128', {
      placeholder: '8 8 16 32 64 128',
      hint: 'Range widths over 0–255, each a power of two.',
      showIf: (v) => v.mode !== 'auto' && v.table === 'custom',
    }),
    traversal: select(
      'Traversal',
      [
        { value: 'row', label: 'Row by row' },
        { value: 'serpentine', label: 'Serpentine (boustrophedon)' },
        { value: 'column', label: 'Column by column' },
        { value: 'column-serpentine', label: 'Column serpentine' },
      ],
      'row',
      { showIf: (v) => v.mode !== 'auto' },
    ),
    channel: select(
      'Channel',
      [
        { value: 'gray', label: 'Grey (R=G=B)' },
        { value: 'r', label: 'Red' },
        { value: 'g', label: 'Green' },
        { value: 'b', label: 'Blue' },
        { value: 'rgb', label: 'RGB interleaved' },
      ],
      'gray',
      { showIf: (v) => v.mode !== 'auto' },
    ),
    overflow: bool('Wu & Tsai overflow test', true, {
      hint: 'Skip a pair whose pixels would leave 0–255 (the fall-off-boundary rule).',
      showIf: (v) => v.mode !== 'auto',
    }),
    bitOrder: toggle(
      'Bit order',
      [
        { value: 'msb', label: 'MSB first' },
        { value: 'lsb', label: 'LSB first' },
      ],
      'msb',
      { showIf: (v) => v.mode !== 'auto' },
    ),
    stop: select(
      'Stop at',
      [
        { value: 'length', label: 'Length prefix (N:…)' },
        { value: 'null', label: 'Null byte' },
        { value: 'readable', label: 'End of readable text' },
        { value: 'all', label: 'Whole stream' },
      ],
      'length',
      { showIf: (v) => v.mode === 'decode' },
    ),
    message: text('Message to hide', 'FTF{pvd}', { showIf: (v) => v.mode === 'encode' }),
  },
  examples: [
    {
      label: 'Auto-find a message hidden with serpentine Wu & Tsai',
      input: { sample: 'stego-pvd.png' },
      expect: 'FTF{pvd_serpentine}',
    },
  ],
  async run({ image, bytes }, o): Promise<Output[]> {
    if (image.width * image.height > MAX_PIXELS) throw new ToolError(T('error.tooLarge'));
    const out: Output[] = [];
    const warn = formatNote(bytes);
    if (warn) out.push(warn);
    const [sha1, sha256] = await Promise.all([sha(bytes, 'SHA-1'), sha(bytes, 'SHA-256')]);
    out.push({
      type: 'kv',
      label: T('label.file'),
      entries: [
        ['SHA-1', sha1],
        ['SHA-256', sha256],
      ],
    });

    if (o.mode === 'encode') {
      const s: Settings = {
        table: tableOf(o.table, o.custom),
        tableName: o.table,
        traversal: o.traversal,
        channel: o.channel,
        overflow: o.overflow,
        msbFirst: o.bitOrder !== 'lsb',
      };
      const msg = new TextEncoder().encode(o.message);
      let stego: RgbaImage;
      try {
        stego = embed(image, bytesToBits(msg, s.msbFirst), {
          table: s.table,
          traversal: s.traversal,
          channel: s.channel,
          overflow: s.overflow,
        });
      } catch {
        throw new ToolError(T('error.fit'));
      }
      out.push({ type: 'image', label: T('label.stego'), image: stego, filename: 'pvd-stego.png' });
      out.push({ type: 'note', level: 'success', text: T('note.encoded', { n: msg.length }) });
      return out;
    }

    if (o.mode === 'decode') {
      const s: Settings = {
        table: tableOf(o.table, o.custom),
        tableName: o.table,
        traversal: o.traversal,
        channel: o.channel,
        overflow: o.overflow,
        msbFirst: o.bitOrder !== 'lsb',
      };
      const trace: PairTrace[] = [];
      const raw = decode(image, s, 4096, trace);
      const { body, label } = applyStop(raw, o.stop);
      out.push(...decodedOutputs(body, raw, label));
      out.push(...explain(s, trace));
      return out;
    }

    // --- auto ---
    const previewSeqLen = Math.min(PREVIEW_PIXELS, image.width * image.height);
    const scored: { s: Settings; score: number; prev: Uint8Array }[] = [];
    for (const tableName of AUTO_TABLES) {
      for (const traversal of TRAVERSALS) {
        for (const channel of CHANNELS) {
          for (const overflow of [false, true]) {
            for (const msbFirst of [true, false]) {
              const s: Settings = {
                table: TABLES[tableName],
                tableName,
                traversal,
                channel,
                overflow,
                msbFirst,
              };
              const seq = sequence(image.width, image.height, traversal).subarray(0, previewSeqLen);
              const samples = samplesOf(image, channel, seq);
              const prev = bitsToBytes(
                extractBits(samples, { table: s.table, overflow }, PREVIEW_BYTES * 8),
                msbFirst,
              );
              scored.push({ s, score: scoreStream(prev), prev });
            }
          }
        }
      }
    }
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, 5);
    out.push({
      type: 'table',
      label: T('label.top'),
      columns: [T('col.settings'), T('col.score'), T('col.preview')],
      rows: top.map((c) => [settingsLabel(c.s), c.score.toFixed(0), preview(c.prev, 40)]),
      highlight: [0],
    });

    const best = top[0]!;
    const trace: PairTrace[] = [];
    const raw = decode(image, best.s, 8192, trace);
    const hit = classifyStream(raw);
    const strong = hit && (hit.kind === 'flag' || hit.kind === 'file' || hit.kind === 'prefixed');
    if (strong) {
      out.push({ type: 'note', level: 'success', text: T('note.found', { kind: hit.kind }) });
    } else {
      // A readable head then noise means the method is right but the walk or overflow is not.
      const head = printableRun(raw);
      if (head >= 8 && head < raw.length * 0.5) {
        out.push({ type: 'note', level: 'warn', text: T('note.partial', { bytes: head }) });
      }
    }
    const { body, label } = applyStop(raw, 'length');
    out.push(...decodedOutputs(body, raw, label));
    out.push(...explain(best.s, trace));
    return out;
  },
});
