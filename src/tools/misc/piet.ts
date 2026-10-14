import { decodeImageExact } from '../../core/decode-image';
import { defineTool, number, text, toggle } from '../../core/define';
import { ToolError } from '../../core/errors';
import type { Output, RgbaImage } from '../../core/types';
import { toolT } from '../../i18n/tool-text';
import { u32le } from '../../lib/bytes';
import { buildGrid, paletteProfile, type BuiltGrid } from './_piet-core';
import {
  ccName,
  dpName,
  MAX_ATTEMPTS,
  OUTPUT_LIMIT,
  STACK_LIMIT,
  runPiet,
  unescapeInput,
  type PietResult,
} from './_piet-vm';

const T = toolT('piet');

const STEP_LIMIT_MAX = 50_000_000;
const TRACE_MAX = 5000;

/** Pictures bigger than this are not decoded just to guess what they are. */
const GUESS_MAX_BYTES = 3_000_000;
const GUESS_MAX_PIXELS = 4_000_000;

/** The picture, if it is a PNG or BMP of a size that is cheap to decode; otherwise null. */
function smallPicture(bytes: Uint8Array): RgbaImage | null {
  if (bytes.length < 30 || bytes.length > GUESS_MAX_BYTES) return null;
  let pixels: number;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    pixels = ((bytes[16]! << 24) | (bytes[17]! << 16) | (bytes[18]! << 8) | bytes[19]!) >>> 0;
    pixels *= ((bytes[20]! << 24) | (bytes[21]! << 16) | (bytes[22]! << 8) | bytes[23]!) >>> 0;
  } else if (bytes[0] === 0x42 && bytes[1] === 0x4d) {
    pixels = u32le(bytes, 18) * Math.abs(u32le(bytes, 22) | 0);
  } else {
    return null;
  }
  if (!(pixels > 0 && pixels <= GUESS_MAX_PIXELS)) return null;
  try {
    return decodeImageExact(bytes);
  } catch (e) {
    if (e instanceof ToolError) return null; // a damaged picture is not a Piet program
    throw e;
  }
}

const grouped = (n: number) => n.toLocaleString('en-US');
const clamp = (v: number, lo: number, hi: number, fallback: number) =>
  Number.isFinite(v) ? Math.min(Math.max(Math.floor(v), lo), hi) : fallback;

function stopText(r: PietResult, stepLimit: number): string {
  switch (r.stop) {
    case 'ended':
      return T('value.stop.ended', { attempts: MAX_ATTEMPTS });
    case 'step-limit':
      return T('value.stop.stepLimit', { limit: grouped(stepLimit) });
    case 'output-limit':
      return T('value.stop.outputLimit', { max: grouped(OUTPUT_LIMIT) });
    case 'stack-limit':
      return T('value.stop.stackLimit', { max: grouped(STACK_LIMIT) });
    case 'black-start':
      return T('value.stop.blackStart');
  }
}

function notes(b: BuiltGrid, r: PietResult, unknown: string, stepLimit: number): Output[] {
  const out: Output[] = [];
  const { grid } = b;
  if (b.cropped) {
    out.push({
      type: 'note',
      level: 'info',
      text: T('note.cropped', { codel: b.codel }),
    });
  }
  if (b.unknownCodels > 0) {
    const share = b.unknownCodels / (grid.width * grid.height);
    const what =
      unknown === 'nearest'
        ? T('value.snapped')
        : unknown === 'black'
          ? T('value.treatedBlack')
          : T('value.treatedWhite');
    const text = T('note.unknownCodels', {
      count: b.unknownCodels,
      n: grouped(b.unknownCodels),
      share: (share * 100).toFixed(share < 0.1 ? 1 : 0),
      what,
    });
    out.push({
      type: 'note',
      level: share > 0.05 ? 'warn' : 'info',
      text:
        share > 0.05 && unknown !== 'nearest'
          ? `${text} ${T('note.tryNearest', { nearest: T('options.unknown.choices.nearest') })}`
          : text,
    });
  }
  if (b.detected && b.codel === 1 && grid.blockCount > 2000) {
    out.push({
      type: 'note',
      level: 'warn',
      text: T('note.codelOne', { blocks: grouped(grid.blockCount) }),
    });
  }
  if (r.stop === 'step-limit') {
    out.push({
      type: 'note',
      level: 'warn',
      text: T('note.stepLimit', { limit: grouped(stepLimit) }),
    });
  } else if (r.stop === 'output-limit' || r.stop === 'stack-limit') {
    out.push({
      type: 'note',
      level: 'warn',
      text: T('note.runaway', { stop: stopText(r, stepLimit) }),
    });
  } else if (r.stop === 'black-start') {
    out.push({
      type: 'note',
      level: 'warn',
      text: T('note.blackStart'),
    });
  } else if (r.steps === 0) {
    out.push({
      type: 'note',
      level: 'warn',
      text: T('note.stuck'),
    });
  }
  if (r.badChars) {
    out.push({
      type: 'note',
      level: 'warn',
      text: T('note.badChars', { count: r.badChars, n: grouped(r.badChars) }),
    });
  }
  return out;
}

function stats(b: BuiltGrid, r: PietResult, stepLimit: number, hasInput: boolean): Output {
  const { grid } = b;
  const position = { x: r.x, y: r.y, dp: dpName(r.dp), cc: ccName(r.cc) };
  const entries: [string, string][] = [
    [
      T('kv.codelSize'),
      b.detected
        ? T('value.codelDetected', { codel: b.codel })
        : T('value.codelManual', { codel: b.codel }),
    ],
    [
      T('kv.image'),
      T('value.image', {
        width: b.imageWidth,
        height: b.imageHeight,
        columns: grid.width,
        rows: grid.height,
      }),
    ],
    [T('kv.blocks'), grouped(grid.blockCount)],
    [T('kv.steps'), grouped(r.steps)],
    [T('kv.termination'), stopText(r, stepLimit)],
    [
      T('kv.position'),
      r.inWhite ? T('value.positionWhite', position) : T('value.position', position),
    ],
  ];
  if (r.stack.length) {
    const top = r.stack
      .slice(-8)
      .reverse()
      .map((v) => v.toString());
    const depth = T('value.stackValues', {
      count: r.stack.length,
      n: grouped(r.stack.length),
    });
    entries.push([
      T('kv.stackTop'),
      `${top.join(', ')}${r.stack.length > 8 ? ', ...' : ''}${r.stack.length > 1 ? ` (${depth})` : ''}`,
    ]);
  } else entries.push([T('kv.stackEnd'), T('value.empty')]);
  if (hasInput) {
    entries.push([
      T('kv.inputRead'),
      T('value.inputRead', { count: r.inputTotal, read: r.inputRead, total: r.inputTotal }),
    ]);
  }
  if (r.ignored) entries.push([T('kv.ignored'), grouped(r.ignored)]);
  return { type: 'kv', label: T('label.run'), entries };
}

function traceTable(r: PietResult): Output {
  const shown = r.trace.length;
  const label =
    shown < r.steps
      ? T('label.traceFirst', { count: r.steps, shown: grouped(shown), steps: grouped(r.steps) })
      : T('label.trace', { count: shown, n: grouped(shown) });
  const empty = T('value.empty');
  return {
    type: 'table',
    label,
    columns: [
      T('col.step'),
      T('col.codel'),
      T('col.pointers'),
      T('col.command'),
      T('col.value'),
      T('col.stackTop'),
    ],
    rows: r.trace.map((t) => [
      t.step,
      `(${t.x}, ${t.y})`,
      `${dpName(t.dp)} / ${ccName(t.cc)}`,
      t.command || '-',
      t.value,
      t.depth ? T('value.onStack', { top: t.top, depth: grouped(t.depth) }) : empty,
    ]),
  };
}

export default defineTool({
  id: 'piet',
  name: 'Piet',
  category: 'misc',
  description:
    'Run a Piet program (an image made of colour blocks): codel size detection, output and a step-by-step trace.',
  tags: [
    'esolang',
    'esoteric',
    'piet',
    'npiet',
    'image program',
    'codel',
    'colour blocks',
    'mondrian',
    'program image',
  ],
  input: 'image',
  placeholder: 'Drop a Piet program (PNG or BMP is read pixel for pixel)',
  options: {
    codel: number('Codel size', 0, {
      min: 0,
      max: 512,
      hint: '0 = detect: the largest size that divides every run of one colour. Set it by hand for scaled or noisy images.',
    }),
    unknown: toggle(
      'Other colours',
      [
        { value: 'white', label: 'White' },
        { value: 'black', label: 'Black' },
        { value: 'nearest', label: 'Nearest' },
      ],
      'white',
      {
        hint: 'What to do with colours that are not one of the 20 Piet colours. The standard leaves it open (white is the usual choice); Nearest snaps to the closest Piet colour.',
      },
    ),
    input: text('Input', '', {
      placeholder: '42 or hello\\n',
      hint: 'What in(number) and in(char) read. Escapes: \\n \\r \\t \\0 \\\\ \\xNN \\uNNNN.',
    }),
    steps: number('Step limit', 1_000_000, {
      min: 1,
      max: STEP_LIMIT_MAX,
      hint: 'Stops runaway loops.',
    }),
    trace: number('Trace rows', 200, {
      min: 0,
      max: TRACE_MAX,
      hint: 'How many steps to list in the trace table (0 hides it).',
    }),
  },
  examples: [
    {
      label: 'Prints FTF (codel size 4)',
      input: { sample: 'esolang-piet-ftf.png' },
      expect: 'FTF',
    },
    {
      label: 'Codel size set by hand',
      input: { sample: 'esolang-piet-ftf.png' },
      options: { codel: 4 },
      expect: 'Codel size: 4 px (set manually)',
    },
  ],
  detect({ bytes, name }) {
    const named = name !== undefined && /piet/i.test(name);
    const picture = smallPicture(bytes);
    if (picture) {
      // A program is drawn with the 20 Piet colours and nothing else (a few hues at least).
      const p = paletteProfile(picture);
      if (p.share >= 0.95 && p.hues >= 3 && p.colours >= 4) {
        return {
          score: named ? 0.85 : 0.7,
          reason: named ? T('detect.paletteNamed') : T('detect.palette'),
        };
      }
    }
    if (named) return { score: 0.6, reason: T('detect.named') };
    return null;
  },
  run({ image }, opts) {
    const stepLimit = clamp(opts.steps, 1, STEP_LIMIT_MAX, 1_000_000);
    const built = buildGrid(image, {
      codel: clamp(opts.codel, 0, 512, 0),
      unknown: opts.unknown,
    });
    const result = runPiet(built.grid, {
      input: unescapeInput(opts.input),
      stepLimit,
      traceRows: clamp(opts.trace, 0, TRACE_MAX, 200),
    });
    const out: Output[] = notes(built, result, opts.unknown, stepLimit);
    if (result.output) out.push({ type: 'text', label: T('label.output'), value: result.output });
    else if (result.stop !== 'black-start') {
      out.push({ type: 'note', level: 'info', text: T('note.printedNothing') });
    }
    out.push(stats(built, result, stepLimit, opts.input !== ''));
    if (result.trace.length) out.push(traceTable(result));
    return out;
  },
});
