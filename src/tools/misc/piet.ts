import { decodeImageExact } from '../../core/decode-image';
import { defineTool, number, text, toggle } from '../../core/define';
import { ToolError } from '../../core/errors';
import type { Output, RgbaImage } from '../../core/types';
import { u32le } from '../../lib/bytes';
import { buildGrid, paletteProfile, type BuiltGrid } from './_piet-core';
import {
  CC_NAMES,
  DP_NAMES,
  MAX_ATTEMPTS,
  OUTPUT_LIMIT,
  STACK_LIMIT,
  runPiet,
  unescapeInput,
  type PietResult,
} from './_piet-vm';

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
const plural = (n: number, word: string) => `${grouped(n)} ${word}${n === 1 ? '' : 's'}`;
const clamp = (v: number, lo: number, hi: number, fallback: number) =>
  Number.isFinite(v) ? Math.min(Math.max(Math.floor(v), lo), hi) : fallback;

function stopText(r: PietResult, stepLimit: number): string {
  switch (r.stop) {
    case 'ended':
      return `Program ended (no way out after ${MAX_ATTEMPTS} attempts in a row)`;
    case 'step-limit':
      return `Step limit reached (${grouped(stepLimit)} steps)`;
    case 'output-limit':
      return `Output limit reached (${grouped(OUTPUT_LIMIT)} characters)`;
    case 'stack-limit':
      return `Stack limit reached (${grouped(STACK_LIMIT)} values)`;
    case 'black-start':
      return 'The top-left codel is black: the program can not start';
  }
}

function notes(b: BuiltGrid, r: PietResult, unknown: string, stepLimit: number): Output[] {
  const out: Output[] = [];
  const { grid } = b;
  if (b.cropped) {
    out.push({
      type: 'note',
      level: 'info',
      text: `The image size is not a multiple of the codel size (${b.codel} px): the leftover pixels on the right and bottom edges are ignored.`,
    });
  }
  if (b.unknownCodels > 0) {
    const share = b.unknownCodels / (grid.width * grid.height);
    const what =
      unknown === 'nearest' ? 'snapped to the nearest Piet colour' : `treated as ${unknown}`;
    out.push({
      type: 'note',
      level: share > 0.05 ? 'warn' : 'info',
      text: `${plural(b.unknownCodels, 'codel')} (${(share * 100).toFixed(share < 0.1 ? 1 : 0)}%) ${b.unknownCodels === 1 ? 'is' : 'are'} not one of the 20 Piet colours, ${what}.${
        share > 0.05 && unknown !== 'nearest'
          ? ' If the picture was resized, anti-aliased or compressed, try "Nearest" and set the codel size by hand.'
          : ''
      }`,
    });
  }
  if (b.detected && b.codel === 1 && grid.blockCount > 2000) {
    out.push({
      type: 'note',
      level: 'warn',
      text: `Codel size 1 was detected on a picture with ${grouped(grid.blockCount)} colour blocks. If the image was scaled or compressed, the real codel size is larger: set it by hand.`,
    });
  }
  if (r.stop === 'step-limit') {
    out.push({
      type: 'note',
      level: 'warn',
      text: `Stopped at the step limit (${grouped(stepLimit)} steps): the program probably loops forever, or needs a higher limit. Output so far is shown.`,
    });
  } else if (r.stop === 'output-limit' || r.stop === 'stack-limit') {
    out.push({
      type: 'note',
      level: 'warn',
      text: `${stopText(r, stepLimit)}: the program probably runs away. Output so far is shown.`,
    });
  } else if (r.stop === 'black-start') {
    out.push({
      type: 'note',
      level: 'warn',
      text: 'Execution starts on the top-left codel, which is black here. Is the picture cropped or padded with a border, or are other colours meant to be white?',
    });
  } else if (r.steps === 0) {
    out.push({
      type: 'note',
      level: 'warn',
      text: 'The pointer never left the first block: every way out of it is black or off the picture.',
    });
  }
  if (r.badChars) {
    out.push({
      type: 'note',
      level: 'warn',
      text: `${plural(r.badChars, 'out(char) value')} ${r.badChars === 1 ? 'was' : 'were'} not a valid Unicode code point and print as U+FFFD.`,
    });
  }
  return out;
}

function stats(b: BuiltGrid, r: PietResult, stepLimit: number, hasInput: boolean): Output {
  const { grid } = b;
  const entries: [string, string][] = [
    ['Codel size', `${b.codel} px (${b.detected ? 'detected' : 'set manually'})`],
    ['Image', `${b.imageWidth} x ${b.imageHeight} px = ${grid.width} x ${grid.height} codels`],
    ['Colour blocks', grouped(grid.blockCount)],
    ['Steps', grouped(r.steps)],
    ['Termination', stopText(r, stepLimit)],
    [
      'Final position',
      `codel (${r.x}, ${r.y})${r.inWhite ? ' in white' : ''}, DP ${DP_NAMES[r.dp]}, CC ${CC_NAMES[r.cc]}`,
    ],
  ];
  if (r.stack.length) {
    const top = r.stack
      .slice(-8)
      .reverse()
      .map((v) => v.toString());
    entries.push([
      'Stack at end (top first)',
      `${top.join(', ')}${r.stack.length > 8 ? ', ...' : ''}${r.stack.length > 1 ? ` (${grouped(r.stack.length)} values)` : ''}`,
    ]);
  } else entries.push(['Stack at end', 'empty']);
  if (hasInput) entries.push(['Input read', `${r.inputRead} of ${r.inputTotal} characters`]);
  if (r.ignored) entries.push(['Ignored commands', grouped(r.ignored)]);
  return { type: 'kv', label: 'Run', entries };
}

function traceTable(r: PietResult): Output {
  const shown = r.trace.length;
  const label =
    shown < r.steps
      ? `Trace (first ${grouped(shown)} of ${grouped(r.steps)} steps)`
      : `Trace (${plural(shown, 'step')})`;
  return {
    type: 'table',
    label,
    columns: ['Step', 'Codel (x, y)', 'DP / CC', 'Command', 'Value', 'Stack top'],
    rows: r.trace.map((t) => [
      t.step,
      `(${t.x}, ${t.y})`,
      `${DP_NAMES[t.dp]} / ${CC_NAMES[t.cc]}`,
      t.command || '-',
      t.value,
      t.depth ? `${t.top} (${grouped(t.depth)} on stack)` : 'empty',
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
          reason: named
            ? 'Made of the 20 Piet colours, and the file name mentions Piet'
            : 'Made of the 20 Piet colours (colour blocks, no shading)',
        };
      }
    }
    if (named) return { score: 0.6, reason: 'The file name mentions Piet' };
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
    if (result.output) out.push({ type: 'text', label: 'Program output', value: result.output });
    else if (result.stop !== 'black-start') {
      out.push({ type: 'note', level: 'info', text: 'The program ran but printed nothing.' });
    }
    out.push(stats(built, result, stepLimit, opts.input !== ''));
    if (result.trace.length) out.push(traceTable(result));
    return out;
  },
});
