import { decodeImageExact } from '../../core/decode-image';
import { defineTool, number, text, toggle } from '../../core/define';
import { ToolError } from '../../core/errors';
import { registeredTools } from '../../core/tool-list';
import type { Output, RgbaImage } from '../../core/types';
import { toolName, toolT } from '../../i18n/tool-text';
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
  } else if (bytes[0] === 0x50 && bytes[1]! >= 0x31 && bytes[1]! <= 0x36) {
    // Netpbm: no cheap header pixel count, so decode (it is small, gated by GUESS_MAX_BYTES).
    try {
      const img = decodeImageExact(bytes);
      return img && img.width * img.height <= GUESS_MAX_PIXELS ? img : null;
    } catch (e) {
      if (e instanceof ToolError) return null;
      throw e;
    }
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

/** The file format from its magic bytes, and whether it is lossy (which ruins Piet colours). */
function formatInfo(bytes: Uint8Array): { name: string; lossy: boolean } {
  const b = bytes;
  if (b.length >= 3 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46)
    return { name: 'GIF', lossy: false };
  if (
    b.length >= 16 &&
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  ) {
    // Only 'VP8 ' (0x20) is surely lossy; 'VP8L' is lossless and 'VP8X' may wrap either, so do
    // not raise a false "colours altered" warning for it — the palette split shows real damage.
    return { name: 'WebP', lossy: b[15] === 0x20 };
  }
  if (b.length < 2) return { name: '', lossy: false };
  if (b[0] === 0x89 && b[1] === 0x50) return { name: 'PNG', lossy: false };
  if (b[0] === 0x42 && b[1] === 0x4d) return { name: 'BMP', lossy: false };
  if (b[0] === 0xff && b[1] === 0xd8) return { name: 'JPEG', lossy: true };
  if (b[0] === 0x50 && b[1]! >= 0x31 && b[1]! <= 0x36) {
    const t = b[1]! - 0x30;
    return { name: t === 1 || t === 4 ? 'PBM' : t === 2 || t === 5 ? 'PGM' : 'PPM', lossy: false };
  }
  return { name: '', lossy: false };
}

/** Words that sit around a key in a message ("the key is X") but are not the key itself. */
const KEY_STOPWORDS = new Set([
  'key',
  'is',
  'the',
  'pass',
  'password',
  'passphrase',
  'clé',
  'cle',
  'est',
  'mot',
  'de',
  'passe',
  'le',
  'la',
  'your',
  'secret',
  'phrase',
]);
const keyScore = (t: string): number => t.length + (t.match(/[A-Z]/g)?.length ?? 0);

/** Whole-word markers that announce a key/password, so "monkey" or "oracle" do not trigger it. */
const KEY_MARKERS = new Set([
  'key',
  'keys',
  'pass',
  'password',
  'passphrase',
  'passwd',
  'secret',
  'cle',
  'cles',
  'clé',
  'clés',
]);

/**
 * When the output looks like a key or password, offer to open it in the Vigenère tool with the
 * key filled in — the usual next step after a Piet program hands you a keyword.
 */
function keyChaining(output: string): Output[] {
  if (!registeredTools().some((x) => x.id === 'vigenere')) return [];
  const tokens = output.match(/[A-Za-z0-9_-]{2,}/g) ?? [];
  const candidates = tokens.filter((t) => t.length >= 3 && !KEY_STOPWORDS.has(t.toLowerCase()));
  const words = output
    .toLowerCase()
    .split(/[^a-zà-ÿ]+/i)
    .filter(Boolean);
  const intro = words.some((w) => KEY_MARKERS.has(w)) || /mot\s+de\s+passe/i.test(output);
  let key: string | null = null;
  if (intro && candidates.length) {
    key = candidates.reduce((a, b) => (keyScore(b) > keyScore(a) ? b : a));
  } else if (tokens.length === 1 && candidates.length === 1) {
    // A lone token with no announcing word: only offer it when it actually looks like a key
    // (has an upper-case letter or a digit, or is long), not an everyday word.
    const t = candidates[0]!;
    if (/[A-Z]/.test(t) || /\d/.test(t) || t.length >= 8) key = t;
  }
  if (!key) return [];
  const vigenere = registeredTools().find((x) => x.id === 'vigenere');
  const name = vigenere ? toolName(vigenere) : 'Vigenère';
  return [
    {
      type: 'actions',
      label: T('chain.label'),
      actions: [
        {
          label: T('chain.useKey', { key, tool: name }),
          options: { mode: 'decrypt', key },
          open: { tool: 'vigenere', text: '' },
          primary: true,
        },
      ],
    },
  ];
}

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
  if (b.estimated) {
    out.push({
      type: 'note',
      level: 'warn',
      text: T('note.estimated', { codel: b.codel }),
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
        ? b.estimated
          ? T('value.codelEstimated', { codel: b.codel })
          : T('value.codelDetected', { codel: b.codel })
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
    'Run a Piet program (an image made of colour blocks): reads PNG, BMP, GIF, WebP and Netpbm (PPM/PGM/PBM) directly, detects the codel size, warns when a lossy format or a wrong codel size broke the colours, and shows the output with a step-by-step trace.',
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
    'ppm',
    'netpbm',
    'pnm',
  ],
  input: 'image',
  placeholder: 'Drop a Piet program — PNG, BMP, GIF, WebP or a .ppm, read pixel for pixel',
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
  run({ image, bytes }, opts) {
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
    const total = Math.max(1, built.grid.width * built.grid.height);
    const fmt = formatInfo(bytes);
    const out: Output[] = [];

    // Format first, with a prominent warning when it is a lossy one (the usual cause of failure).
    if (fmt.lossy) {
      out.push({ type: 'note', level: 'warn', text: T('note.lossy', { format: fmt.name }) });
    } else if (fmt.name) {
      out.push({ type: 'note', level: 'info', text: T('note.format', { format: fmt.name }) });
    }

    // Palette health: the share of codels that are exact Piet colours, near, or off-palette.
    if (built.unknownCodels > 0 || fmt.lossy) {
      const pct = (k: number) => Math.round((k / total) * 100);
      out.push({
        type: 'note',
        level: built.farCodels / total > 0.05 ? 'warn' : 'info',
        text: T('note.palette', {
          exact: pct(built.exactCodels),
          near: pct(built.nearCodels),
          off: pct(built.farCodels),
        }),
      });
    }

    out.push(...notes(built, result, opts.unknown, stepLimit));

    // A largely off-palette picture that printed nothing (or looped to the step limit) is almost
    // certainly not a Piet program, or is in the wrong format or codel size — say so plainly.
    if (built.farCodels / total > 0.5 && (result.stop === 'step-limit' || !result.output)) {
      out.push({ type: 'note', level: 'warn', text: T('note.imageProblem') });
    }

    if (result.output) out.push({ type: 'text', label: T('label.output'), value: result.output });
    else if (result.stop !== 'black-start') {
      out.push({ type: 'note', level: 'info', text: T('note.printedNothing') });
    }

    out.push(...keyChaining(result.output));
    out.push(stats(built, result, stepLimit, opts.input !== ''));
    if (result.trace.length) out.push(traceTable(result));
    return out;
  },
});
