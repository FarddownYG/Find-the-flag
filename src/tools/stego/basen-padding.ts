import { bool, defineTool, number, text, toggle } from '../../core/define';
import { ToolError } from '../../core/errors';
import type { Output } from '../../core/types';
import { toolT } from '../../i18n/tool-text';
import { isValidUtf8, printableRatio, toHex, utf8Decode, utf8Encode } from '../../lib/bytes';
import {
  type Analysis,
  analyze,
  type Base,
  type BaseChoice,
  followLayers,
  hide,
  type Layer,
  payloadText,
  roundTrips,
  tailString,
  trimZeros,
} from './_basen-padding';

const T = toolT('basen-padding');

interface Opts {
  mode: 'extract' | 'hide';
  base: BaseChoice;
  levels: number;
  start: number;
  message: string;
  generate: boolean;
  repeat: number;
}

const MAX_LEVELS = 8;
const MAX_START = 99;
const MAX_REPEAT = 100_000;
/** Cover lines (after repeating) and message bytes the encoder accepts. */
const MAX_COVER_LINES = 500_000;
const MAX_MESSAGE_BYTES = 100_000;
/** What the page draws of a long payload; the whole thing stays in the bytes block or the file. */
const PREVIEW_TEXT = 20_000;
const PREVIEW_HEX = 256;
const FULL_BYTES_LIMIT = 64 * 1024;

const int = (v: number, min: number, max: number, fallback: number): number =>
  Number.isFinite(v) ? Math.min(max, Math.max(min, Math.trunc(v))) : fallback;

// ---------- blocks ----------

const layerLabel = (n: number, part: string) => T('label.layer', { n, part });

/** The text of some bytes when they read as text (trailing zero bytes left out), else null. */
function textOf(bytes: Uint8Array): string | null {
  const trimmed = trimZeros(bytes);
  if (!trimmed.length || !isValidUtf8(trimmed) || printableRatio(trimmed) < 0.85) return null;
  const s = utf8Decode(trimmed);
  return s.length > PREVIEW_TEXT
    ? s.slice(0, PREVIEW_TEXT) + T('value.cut', { count: s.length })
    : s;
}

/**
 * Some bytes as text (when they read as text), hex and a bytes block, with a bounded preview. The
 * bytes block (download, "Send to...") is skipped when the text block already says it all, unless
 * `alwaysBytes`; beyond FULL_BYTES_LIMIT the whole thing is a file to download instead.
 */
function dataBlocks(
  bytes: Uint8Array,
  n: number,
  parts: { text: string; hex: string; bytes: string },
  filename: string,
  alwaysBytes: boolean,
): Output[] {
  if (!bytes.length) return [];
  const out: Output[] = [];
  const readable = textOf(bytes);
  if (readable !== null)
    out.push({ type: 'text', label: layerLabel(n, parts.text), value: readable });
  const more = bytes.length - PREVIEW_HEX;
  out.push({
    type: 'text',
    label: layerLabel(n, parts.hex),
    value:
      toHex(bytes.subarray(0, PREVIEW_HEX), ' ') +
      (more > 0 ? T('value.moreBytes', { count: more }) : ''),
  });
  if (bytes.length <= FULL_BYTES_LIMIT) {
    if (alwaysBytes || readable === null) {
      out.push({ type: 'bytes', label: layerLabel(n, parts.bytes), value: bytes, filename });
    }
  } else {
    out.push({
      type: 'files',
      label: layerLabel(n, parts.bytes),
      files: [{ name: filename, data: bytes, note: T('value.fileNote', { count: bytes.length }) }],
    });
  }
  return out;
}

const bitsFrom = (bits: number, lines: number) =>
  T('value.bitsFrom', {
    bits: T('count.bits', { count: bits }),
    lines: T('count.lines', { count: lines }),
  });

function paddingName(pad: number): string {
  return pad === 0 ? T('value.noPadding') : '='.repeat(pad);
}

function summary(a: Analysis, n: number): Output {
  const tail = tailString(a);
  const read = (['base64', 'base32'] as const)
    .filter((b) => a.perBase[b] > 0)
    .map((b) => T('value.baseLines', { base: b, count: a.perBase[b] }));
  return {
    type: 'kv',
    label: layerLabel(n, T('part.summary')),
    entries: [
      [T('kv.hiddenBits'), bitsFrom(a.bits, a.carrying)],
      [T('kv.payload'), T('count.bytes', { count: a.payload.length })],
      [
        T('kv.leftover'),
        tail ? T('value.leftover', { bits: tail, count: tail.length }) : T('value.none'),
      ],
      [T('kv.readAs'), read.length ? read.join(', ') : T('value.none')],
      [T('kv.lines'), T('value.lines', { read: a.used, skipped: a.skipped, blank: a.blank })],
      [T('kv.nonzero'), T('value.nonzero', { nonzero: a.nonzero, total: a.carrying })],
    ],
  };
}

function paddingTable(a: Analysis, n: number): Output {
  const rows = a.types
    .filter((s) => s.lines > 0)
    .map((s) => [s.base, paddingName(s.pad), s.hidden, s.lines, s.nonzero, s.hidden * s.lines]);
  return {
    type: 'table',
    label: layerLabel(n, T('part.types')),
    columns: [
      T('col.encoding'),
      T('col.padding'),
      T('col.perLine'),
      T('col.lines'),
      T('col.nonzero'),
      T('col.bits'),
    ],
    rows,
    highlight: rows.flatMap((r, i) => (Number(r[2]) > 0 ? [i] : [])),
  };
}

function layerNotes(a: Analysis, n: number): Output[] {
  const out: Output[] = [];
  if (a.used === 0) out.push({ type: 'note', level: 'warn', text: T('note.noLines', { n }) });
  if (a.skipped > 0) {
    const examples = a.skippedSamples.map((s) => `${s.line}: ${s.text}`).join(' | ');
    out.push({
      type: 'note',
      level: 'warn',
      text: T('note.skipped', { count: a.skipped, examples }),
    });
  }
  if (a.used > 0 && a.carrying === 0) {
    out.push({ type: 'note', level: 'info', text: T('note.noPadding') });
  } else if (a.carrying > 0 && a.nonzero === 0) {
    out.push({ type: 'note', level: 'info', text: T('note.allZero', { count: a.carrying }) });
  }
  return out;
}

function layerBlocks(layer: Layer): Output[] {
  const a = layer.analysis;
  const n = layer.index;
  if (a.used === 0) return layerNotes(a, n);
  return [
    summary(a, n),
    paddingTable(a, n),
    ...dataBlocks(
      a.payload,
      n,
      { text: T('part.hiddenText'), hex: T('part.hiddenHex'), bytes: T('part.hiddenBytes') },
      `hidden-layer-${n}.bin`,
      true,
    ),
    ...dataBlocks(
      a.visible,
      n,
      { text: T('part.visibleText'), hex: T('part.visibleHex'), bytes: T('part.visibleBytes') },
      `visible-layer-${n}.bin`,
      false,
    ),
    ...layerNotes(a, n),
  ];
}

// ---------- extract ----------

function extract(input: string, o: Opts): Output[] {
  if (!input.trim()) return [{ type: 'note', level: 'info', text: T('note.empty') }];
  const levels = int(o.levels, 1, MAX_LEVELS, 3);
  const start = int(o.start, 1, MAX_START, 1);
  const chain = followLayers(input, o.base, levels, start);
  if (chain.emptyAt !== undefined) {
    throw new ToolError(T('error.noPayload', { layer: chain.emptyAt, next: chain.emptyAt + 1 }));
  }

  const out: Output[] = [];
  if (start > 1) {
    out.push({
      type: 'note',
      level: 'info',
      text: T('note.start', { layer: start, previous: start - 1 }),
    });
  }
  for (const layer of chain.layers) out.push(...layerBlocks(layer));

  const last = chain.layers[chain.layers.length - 1]!;
  const forced = o.base !== 'auto' ? T('note.forced') : '';
  const stop = chain.stop;
  if (last.analysis.lines > 0) {
    if (stop === 'limit') {
      out.push({
        type: 'note',
        level: 'warn',
        text: T('note.stopLimit', { layer: last.index, count: levels }),
      });
    } else if (stop === 'notBase') {
      out.push({
        type: 'note',
        level: 'info',
        text: [T('note.stopNotBase', { layer: last.index }), forced].filter(Boolean).join(' '),
      });
    } else if (stop === 'noBits' && chain.layers.length > 1) {
      out.push({ type: 'note', level: 'info', text: T('note.stopNoBits', { layer: last.index }) });
    }
  }
  out.push({ type: 'note', level: 'info', text: T('note.fromFile') });

  const actions: { label: string; options: Record<string, unknown>; primary?: boolean }[] = [];
  if (payloadText(last.analysis) !== null) {
    actions.push({
      label: T('action.again', { layer: last.index + 1 }),
      options: { start: last.index + 1 },
      primary: true,
    });
  }
  if (stop === 'limit' && levels < MAX_LEVELS) {
    actions.push({
      label: T('action.moreLayers', { max: MAX_LEVELS }),
      options: { levels: MAX_LEVELS },
    });
  }
  if (start > 1) actions.push({ label: T('action.back'), options: { start: 1 } });
  if (actions.length) out.push({ type: 'actions', label: T('label.chain'), actions });
  return out;
}

// ---------- hide ----------

function hideMessage(input: string, o: Opts): Output[] {
  const base: Base = o.base === 'base32' ? 'base32' : 'base64';
  const message = utf8Encode(o.message);
  if (!message.length) throw new ToolError(T('error.noMessage'));
  if (message.length > MAX_MESSAGE_BYTES) {
    throw new ToolError(T('error.messageTooBig', { max: MAX_MESSAGE_BYTES }));
  }
  const cover = o.generate
    ? []
    : input
        .split('\n')
        .map((l) => l.replace(/\r$/, ''))
        .filter((l) => l.trim().length > 0);
  const repeat = int(o.repeat, 1, MAX_REPEAT, 1);
  if (cover.length * repeat > MAX_COVER_LINES) {
    throw new ToolError(T('error.coverTooBig', { max: MAX_COVER_LINES }));
  }

  const res = hide({ base, message, cover, repeat });
  if (!res.ok) {
    const multiple = base === 'base64' ? 3 : 5;
    const text = T('error.capacity', {
      needed: res.needed,
      have: res.have,
      count: res.lines,
      multiple,
    });
    throw new ToolError(
      res.passes > 0 ? `${text} ${T('error.capacityRepeat', { times: res.passes })}` : text,
    );
  }

  const ok = roundTrips(res.text, base, message);
  const unused = res.capacity - res.used;
  const out: Output[] = [
    {
      type: 'kv',
      label: T('label.hideSummary'),
      entries: [
        [T('kv.encoding'), base],
        [
          T('kv.cover'),
          res.generated
            ? T('value.coverGenerated', { count: res.lines })
            : repeat > 1
              ? T('value.coverRepeated', { lines: cover.length, repeat, total: res.lines })
              : T('value.coverLines', { count: res.lines }),
        ],
        [T('kv.carrying'), T('value.carrying', { carrying: res.carrying, total: res.lines })],
        [
          T('kv.capacity'),
          T('value.capacity', {
            used: res.used,
            total: res.capacity,
            percent: Math.round((res.used / res.capacity) * 100),
          }),
        ],
        [T('kv.roundTrip'), ok ? T('value.roundTripOk') : T('value.roundTripFail')],
      ],
    },
    { type: 'text', label: T('label.hidden', { base }), value: res.text },
  ];
  if (!ok) out.push({ type: 'note', level: 'error', text: T('note.roundTripFail') });
  if (unused > 0)
    out.push({ type: 'note', level: 'info', text: T('note.unused', { count: unused }) });
  return out;
}

export default defineTool({
  id: 'basen-padding',
  name: 'Hidden bits in base64 / base32 padding',
  category: 'stego',
  description:
    'Read the bits hidden in the "=" padding of base64 / base32 lines, follow several layers, or hide a message that way.',
  tags: [
    'base-N padding',
    'padding steganography',
    'base64 steganography',
    'base32 steganography',
    'trailing bits',
    'unused bits',
    'equals sign',
    'b64 stego',
    'basencoding',
  ],
  input: 'text',
  placeholder: 'SGVsbG8gd29ybGQh\nQQ==\nQf==\nQf==',
  live: true,
  options: {
    mode: toggle('Mode', [
      { value: 'extract', label: 'Extract' },
      { value: 'hide', label: 'Hide a message' },
    ]),
    base: toggle(
      'Encoding',
      [{ value: 'auto', label: 'Auto-detect' }, 'base64', 'base32'],
      'auto',
      {
        hint: 'Auto-detect reads each line by its own alphabet and padding. Hide mode: auto means base64.',
      },
    ),
    levels: number('Auto-recurse (layers)', 3, {
      min: 1,
      max: MAX_LEVELS,
      hint: 'Keep reading while the hidden payload itself looks like base64 / base32 lines with padding. 1 = the first layer only.',
      showIf: (v) => v.mode === 'extract',
    }),
    start: number('Start at layer', 1, {
      min: 1,
      max: MAX_START,
      hint: 'From 2 on, the hidden payload of the previous layer is the input (this is what the Decode again button sets).',
      showIf: (v) => v.mode === 'extract',
    }),
    message: text('Message to hide', '', {
      placeholder: 'HIDDEN_OK',
      showIf: (v) => v.mode === 'hide',
    }),
    repeat: number('Repeat the cover (times)', 1, {
      min: 1,
      max: MAX_REPEAT,
      hint: 'The input lines are the cover (plain text, each line gets encoded). Repeat them to make room for the message.',
      showIf: (v) => v.mode === 'hide' && !v.generate,
    }),
    generate: bool('Generate the cover', false, {
      hint: 'Write as many lines as the message needs and ignore the input lines (the input only has to be non-empty).',
      showIf: (v) => v.mode === 'hide',
    }),
  },
  examples: [
    {
      label: 'Text hidden in base64 padding',
      input: { sample: 'basen-padding-base64.txt' },
      expect: 'HIDDEN_OK',
    },
    {
      label: 'Text hidden in base32 padding',
      input: { sample: 'basen-padding-base32.txt' },
      expect: 'HIDDEN_OK',
    },
    {
      label: 'Two layers: base32 lines hidden in base64 lines',
      input: { sample: 'basen-padding-layers.txt' },
      expect: 'LAYERED_OK',
    },
    {
      label: 'First layer only, then decode again',
      input: { sample: 'basen-padding-layers.txt' },
      options: { levels: 1, start: 2 },
      expect: 'LAYERED_OK',
    },
    {
      label: 'Hide a message in your own lines',
      input: 'Hello, world!',
      options: { mode: 'hide', message: 'HIDDEN_OK', repeat: 18 },
      expect: 'Round trip: OK',
    },
    {
      label: 'Hide a message in generated base32 lines',
      input: 'the cover is generated, this text is ignored',
      options: { mode: 'hide', message: 'HIDDEN_OK', base: 'base32', generate: true },
      expect: 'Cover: 18 generated lines',
    },
  ],
  detect({ text }) {
    if (!text || text.length < 40 || !text.includes('=')) return null;
    const a = analyze(text.length > 200_000 ? text.slice(0, 200_000) : text, 'auto');
    if (a.lines < 4 || a.used * 10 < a.lines * 9 || a.carrying < 4) return null;
    const score =
      a.nonzero === 0 ? 0.3 : a.carrying >= 8 && a.nonzero * 2 >= a.carrying ? 0.85 : 0.6;
    return {
      score,
      options: { mode: 'extract' },
      reason: T('detect.padded', { count: a.carrying }),
    };
  },
  run(input, o) {
    return o.mode === 'hide' ? hideMessage(input, o) : extract(input, o);
  },
});
