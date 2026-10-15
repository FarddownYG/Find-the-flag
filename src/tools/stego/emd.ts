import { defineTool, number, select, text, toggle } from '../../core/define';
import { ToolError } from '../../core/errors';
import type { Output, RgbaImage } from '../../core/types';
import { toolT } from '../../i18n/tool-text';
import {
  autoSearch,
  type Candidate,
  DEFAULTS,
  decodeEmd,
  type EmdParams,
  encodeEmd,
  extractDigits,
  flatten,
} from './_emd';
import {
  type EmdChannel,
  grayPng,
  hasTransparency,
  type InputIssue,
  inputIssues,
  readBackPng,
  rgbaPng,
  rgbaToGray,
  withChannel,
} from './_emd-image';

const T = toolT('emd');

interface EmdOptions {
  mode: 'decode' | 'auto' | 'encode';
  message: string;
  n: string;
  length: number;
  k: number;
  weights: EmdParams['weights'];
  digitOrder: EmdParams['digitOrder'];
  scan: EmdParams['scan'];
  offset: number;
  channel: EmdChannel;
}

const MAX_N = 8;
const MAX_K = 12;
const MAX_LENGTH = 1_000_000;
/** Rows of the Auto table, and characters of text shown in each. */
const TOP = 5;
const PREVIEW = 160;
/** Largest k tried by Auto, and digits shown on the page (the stream is cut beyond that). */
const AUTO_KMAX = 8;
const SHOWN_DIGITS = 20_000;

// ---------- names ----------

const scanName = (s: EmdParams['scan']) => (s === 'row' ? T('value.row') : T('value.col'));
const orderName = (d: EmdParams['digitOrder']) => (d === 'msb' ? T('value.msb') : T('value.lsb'));
const weightsName = (w: EmdParams['weights']) => (w === 'asc' ? '1..n' : 'n..1');
function channelName(c: EmdChannel): string {
  switch (c) {
    case 'gray':
      return T('value.channelGray');
    case 'r':
      return T('value.channelR');
    case 'g':
      return T('value.channelG');
    case 'b':
      return T('value.channelB');
  }
}
const percent = (ratio: number) => `${(ratio * 100).toFixed(1)} %`;
const rate = (ratio: number, total: number) =>
  `${percent(ratio)} (${Math.round(ratio * total)}/${total})`;

// ---------- parameters ----------

/** The options as the core's parameters, with every value checked (the core throws French errors). */
function readParams(o: EmdOptions): EmdParams {
  const n = Number(o.n);
  if (!Number.isInteger(n) || n < 1 || n > MAX_N) throw new ToolError(T('error.n', { max: MAX_N }));
  if (o.mode !== 'encode' && (!Number.isInteger(o.length) || o.length < 1 || o.length > MAX_LENGTH))
    throw new ToolError(T('error.length', { max: MAX_LENGTH }));
  if (o.mode !== 'auto') {
    if (!Number.isInteger(o.k) || o.k < 1 || o.k > MAX_K)
      throw new ToolError(T('error.k', { max: MAX_K }));
    if (!Number.isInteger(o.offset) || o.offset < 0) throw new ToolError(T('error.offset'));
  }
  return {
    n,
    k: o.mode === 'auto' ? DEFAULTS.k : o.k,
    length: o.mode === 'encode' ? DEFAULTS.length : o.length,
    weights: o.weights,
    digitOrder: o.digitOrder,
    scan: o.scan,
    offset: o.mode === 'auto' ? DEFAULTS.offset : o.offset,
  };
}

// ---------- notes about the input file ----------

function issueNote(issue: InputIssue): Output {
  switch (issue.kind) {
    case 'jpeg':
      return { type: 'note', level: 'warn', text: T('warn.jpeg') };
    case 'lossy':
      return { type: 'note', level: 'warn', text: T('warn.lossy', { format: issue.format }) };
    case 'browser':
      return { type: 'note', level: 'info', text: T('info.browser', { format: issue.format }) };
    case 'depth16':
      return { type: 'note', level: 'warn', text: T('warn.depth16') };
    case 'depthLow':
      return { type: 'note', level: 'warn', text: T('warn.depthLow', { depth: issue.depth }) };
    case 'palette':
      return { type: 'note', level: 'warn', text: T('warn.palette') };
  }
}

/** What to know before trusting the pixels: warnings first, then the standing reminder. */
const inputNotes = (bytes: Uint8Array): Output[] => [
  ...inputIssues(bytes).map(issueNote),
  { type: 'note', level: 'info', text: T('note.lossless') },
];

// ---------- decode ----------

/** The digits, k per group, a space between groups (dots between digits above base 10). */
function digitStream(digits: number[], k: number, base: number): string {
  const sep = base > 10 ? '.' : '';
  const groups: string[] = [];
  for (let i = 0; i < digits.length; i += k) groups.push(digits.slice(i, i + k).join(sep));
  return groups.join(' ');
}

function tooSmallToRead(image: RgbaImage, p: EmdParams): ToolError {
  return new ToolError(
    T('error.nothingToRead', {
      have: image.width * image.height,
      need: p.k * p.n,
      offset: p.offset,
    }),
  );
}

function decodeOutputs(image: RgbaImage, bytes: Uint8Array, o: EmdOptions): Output[] {
  const p = readParams(o);
  const base = 2 * p.n + 1;
  const gray = rgbaToGray(image, o.channel);
  const result = decodeEmd(gray, p);
  const chars = result.text.length;
  if (!chars) throw tooSmallToRead(image, p);
  const digits = extractDigits(flatten(gray, p.scan), p.n, p.weights, p.offset, p.length * p.k);

  const out: Output[] = inputNotes(bytes);
  if (chars < p.length)
    out.push({ type: 'note', level: 'warn', text: T('note.short', { chars, length: p.length }) });
  out.push(
    { type: 'text', label: T('label.text'), value: result.text },
    {
      type: 'kv',
      label: T('label.rates'),
      entries: [
        [T('kv.printable'), rate(result.printable, chars)],
        [T('kv.readable'), rate(result.readable, chars)],
        [T('kv.chars'), String(chars)],
        [T('kv.base'), T('value.base', { base, n: p.n, k: p.k })],
        [T('kv.channel'), channelName(o.channel)],
        [
          T('kv.pixels'),
          T('value.pixels', {
            used: chars * p.k * p.n,
            total: image.width * image.height,
            offset: p.offset,
          }),
        ],
      ],
    },
  );
  const shown = digits.slice(0, SHOWN_DIGITS);
  out.push({
    type: 'text',
    label: T('label.digits', { base, k: p.k }),
    value: digitStream(shown, p.k, base),
  });
  if (digits.length > shown.length) {
    out.push({
      type: 'note',
      level: 'info',
      text: T('note.digitsCut', { shown: shown.length, total: digits.length }),
    });
  }
  if (result.readable < 0.9) {
    out.push(
      { type: 'note', level: 'info', text: T('note.tryAuto') },
      {
        type: 'actions',
        actions: [{ label: T('action.tryAuto'), options: { mode: 'auto' } }],
      },
    );
  }
  return out;
}

// ---------- auto ----------

function autoOutputs(image: RgbaImage, bytes: Uint8Array, o: EmdOptions): Output[] {
  const p = readParams(o);
  const gray = rgbaToGray(image, o.channel);
  const ranked = autoSearch(gray, p.n, p.length, AUTO_KMAX);
  const top = ranked.slice(0, TOP);
  const best = top[0];
  if (!best?.result.text.length) throw tooSmallToRead(image, { ...p, k: 1 });

  const settings = (c: Candidate) =>
    T('value.settings', {
      scan: scanName(c.params.scan),
      weights: weightsName(c.params.weights),
      order: orderName(c.params.digitOrder),
      k: c.params.k,
    });
  const out: Output[] = inputNotes(bytes);
  out.push({
    type: 'table',
    label: T('label.auto'),
    columns: [
      '#',
      T('col.readable'),
      T('col.printable'),
      T('col.settings'),
      T('col.text', { chars: PREVIEW }),
    ],
    rows: top.map((c, i) => [
      i + 1,
      percent(c.result.readable),
      percent(c.result.printable),
      settings(c),
      c.result.text.slice(0, PREVIEW),
    ]),
    highlight: [0],
  });
  out.push({
    type: 'actions',
    label: T('label.useSettings'),
    actions: top.map((c, i) => ({
      label: `#${i + 1}: ${settings(c)}`,
      options: {
        mode: 'decode',
        n: String(c.params.n),
        length: c.params.length,
        k: c.params.k,
        weights: c.params.weights,
        digitOrder: c.params.digitOrder,
        scan: c.params.scan,
        offset: 0,
      },
      primary: i === 0,
    })),
  });
  out.push({ type: 'note', level: 'info', text: T('note.printableProves') });
  if (best.result.readable < 0.8) {
    out.push({
      type: 'note',
      level: 'warn',
      text: T('note.autoWeak', { readable: percent(best.result.readable) }),
    });
  }
  out.push({
    type: 'note',
    level: 'info',
    text: T('note.autoInfo', {
      n: p.n,
      length: p.length,
      channel: channelName(o.channel),
      kMax: AUTO_KMAX,
    }),
  });
  return out;
}

// ---------- encode ----------

function encodeOutputs(image: RgbaImage, o: EmdOptions): Output[] {
  const p = readParams(o);
  const base = 2 * p.n + 1;
  const chars = [...o.message];
  if (!chars.length) throw new ToolError(T('error.noMessage'));

  // The conditions the core would reject with a French error, checked first (same order).
  const limit = base ** p.k;
  for (const ch of chars) {
    const code = ch.charCodeAt(0);
    if (code >= limit) {
      throw new ToolError(
        T('error.charTooBig', {
          char: JSON.stringify(ch),
          code,
          n: p.n,
          base,
          k: p.k,
          max: limit - 1,
        }),
      );
    }
  }
  const total = image.width * image.height;
  const groups = chars.length * p.k;
  const need = p.offset + groups * p.n;
  if (need > total) {
    throw new ToolError(
      T('error.tooSmall', {
        chars: chars.length,
        k: p.k,
        n: p.n,
        offset: p.offset,
        need,
        have: total,
      }),
    );
  }
  const params: EmdParams = { ...p, length: chars.length };

  const plane = rgbaToGray(image, o.channel);
  const before = Uint8Array.from(plane.data);
  const overflow = encodeEmd(plane, o.message, params);
  let changed = 0;
  let maxChange = 0;
  for (let i = 0; i < before.length; i++) {
    const d = Math.abs(plane.data[i]! - before[i]!);
    if (d) changed++;
    if (d > maxChange) maxChange = d;
  }

  const transparent = hasTransparency(image);
  const stego = o.channel === 'gray' ? null : withChannel(image, plane, o.channel);
  const png = stego ? rgbaPng(stego) : grayPng(plane);

  // Round trip through the PNG that is handed out, read like any uploaded file.
  const back = decodeEmd(rgbaToGray(readBackPng(png), o.channel), params);
  const ok = back.text === o.message;

  const out: Output[] = [
    ok
      ? { type: 'note', level: 'success', text: T('note.roundTripOk', { text: back.text }) }
      : {
          type: 'note',
          level: 'error',
          text: T('note.roundTripFail', { got: back.text, want: o.message }),
        },
  ];
  if (overflow > 0) {
    out.push({ type: 'note', level: 'warn', text: T('note.overflow', { count: overflow }) });
  }
  if (o.channel === 'gray') {
    out.push({ type: 'note', level: 'info', text: T('note.grayOutput') });
    if (transparent) out.push({ type: 'note', level: 'info', text: T('note.alphaDropped') });
  }
  out.push({ type: 'note', level: 'info', text: T('note.losslessEncode') });
  out.push({
    type: 'kv',
    label: T('label.encoded'),
    entries: [
      [T('kv.message'), T('value.message', { chars: chars.length, k: p.k, groups, n: p.n })],
      [
        T('kv.groups'),
        T('value.groups', { used: groups, capacity: Math.floor((total - p.offset) / p.n) }),
      ],
      [
        T('kv.changed'),
        T('value.changed', {
          changed,
          total,
          percent: ((100 * changed) / total).toFixed(2),
        }),
      ],
      [T('kv.maxChange'), `±${maxChange}`],
      [T('kv.overflow'), String(overflow)],
      [
        T('kv.decodeWith'),
        T('value.decodeWith', {
          n: p.n,
          base,
          k: p.k,
          length: chars.length,
          weights: weightsName(p.weights),
          order: orderName(p.digitOrder),
          scan: scanName(p.scan),
          offset: p.offset,
          channel: channelName(o.channel),
        }),
      ],
    ],
  });
  out.push({
    type: 'picture',
    label: T('label.stego'),
    data: png,
    mime: 'image/png',
    filename: 'emd-stego.png',
  });
  const fileNote =
    o.channel === 'gray'
      ? T('value.fileGray')
      : transparent
        ? T('value.fileRgba')
        : T('value.fileRgb');
  out.push({
    type: 'files',
    label: T('label.files'),
    files: [{ name: 'emd-stego.png', data: png, note: fileNote }],
  });
  return out;
}

export default defineTool({
  id: 'emd',
  name: 'EMD steganography',
  category: 'stego',
  description:
    'Read or hide a message with EMD (Exploiting Modification Direction): every group of n pixels carries one digit in base 2n+1. Decodes with your settings, searches the usual ones, or hides a message and checks it by decoding it back.',
  tags: [
    'exploiting modification direction',
    'emd',
    'steganography',
    'pixel group',
    'base 5',
    'modulo',
    'zhang wang',
    'extract',
    'embed',
    'encoder',
  ],
  input: 'image',
  live: true,
  placeholder:
    'Drop a lossless PNG (never a JPEG or a screenshot: a change of ±1 on a pixel breaks a digit)',
  options: {
    mode: toggle('Mode', [
      { value: 'decode', label: 'Decode' },
      { value: 'auto', label: 'Auto' },
      { value: 'encode', label: 'Encode' },
    ]),
    message: text('Message to hide', 'HELLO_EMD_123', {
      placeholder: 'HELLO_EMD_123',
      hint: 'Printable ASCII. Each character becomes k digits in base 2n+1.',
      showIf: (v) => v.mode === 'encode',
    }),
    n: select(
      'Group size n',
      [
        { value: '1', label: 'n = 1 (base 3)' },
        { value: '2', label: 'n = 2 (base 5)' },
        { value: '3', label: 'n = 3 (base 7)' },
        { value: '4', label: 'n = 4 (base 9)' },
        { value: '5', label: 'n = 5 (base 11)' },
        { value: '6', label: 'n = 6 (base 13)' },
        { value: '7', label: 'n = 7 (base 15)' },
        { value: '8', label: 'n = 8 (base 17)' },
      ],
      '2', // DEFAULTS.n
      {
        hint: 'Pixels per group. A group carries one digit in base 2n+1: f = (w1·g1 + … + wn·gn) mod (2n+1), with the pixel values g and the weights w.',
      },
    ),
    length: number('Message length', DEFAULTS.length, {
      min: 1,
      max: MAX_LENGTH,
      hint: 'Characters to read. Reading stops at the end of the image.',
      showIf: (v) => v.mode !== 'encode',
    }),
    k: number('Digits per character (k)', DEFAULTS.k, {
      min: 1,
      max: MAX_K,
      hint: 'A character code is written with k digits in base 2n+1, so it must stay below (2n+1)^k. 3 digits in base 5 reach 124, enough for ASCII.',
      showIf: (v) => v.mode !== 'auto',
    }),
    weights: toggle(
      'Pixel weights',
      [
        { value: 'asc', label: 'Ascending (1..n)' },
        { value: 'desc', label: 'Descending (n..1)' },
      ],
      DEFAULTS.weights,
      {
        hint: 'Ascending: f = 1·g1 + 2·g2 + … + n·gn. Descending: f = n·g1 + … + 1·gn.',
        showIf: (v) => v.mode !== 'auto',
      },
    ),
    digitOrder: toggle(
      'Digit order',
      [
        { value: 'msb', label: 'Most significant first' },
        { value: 'lsb', label: 'Least significant first' },
      ],
      DEFAULTS.digitOrder,
      {
        hint: 'Whether the first digit of a character is its highest or its lowest.',
        showIf: (v) => v.mode !== 'auto',
      },
    ),
    scan: toggle(
      'Scan',
      [
        { value: 'row', label: 'Row by row' },
        { value: 'col', label: 'Column by column' },
      ],
      DEFAULTS.scan,
      {
        hint: 'The order the pixels are cut into groups.',
        showIf: (v) => v.mode !== 'auto',
      },
    ),
    offset: number('Start offset', DEFAULTS.offset, {
      min: 0,
      hint: 'Pixels skipped along the scan before the first group.',
      showIf: (v) => v.mode !== 'auto',
    }),
    channel: toggle(
      'Channel',
      [
        { value: 'gray', label: 'Gray (luma)' },
        { value: 'r', label: 'Red' },
        { value: 'g', label: 'Green' },
        { value: 'b', label: 'Blue' },
      ],
      'gray',
      {
        hint: 'The value of each pixel. Gray = round(0.299 R + 0.587 G + 0.114 B). Pick a colour when the message was hidden in one channel.',
      },
    ),
  },
  examples: [
    {
      label: 'Decode the hidden text',
      input: { sample: 'emd-hello.png' },
      options: { length: 13 },
      expect: 'HELLO_EMD_123',
    },
    {
      label: 'Show the raw base-5 digits',
      input: { sample: 'emd-hello.png' },
      options: { length: 13 },
      expect: '242 234 301 301 304 340',
    },
    {
      label: 'Auto: find the right settings',
      input: { sample: 'emd-hello.png' },
      options: { mode: 'auto', length: 13 },
      expect: 'HELLO_EMD_123',
    },
    {
      label: 'Hide a message in a cover image',
      input: { sample: 'emd-cover.png' },
      options: { mode: 'encode', message: 'HELLO_EMD_123' },
      expect: "Round trip: OK, 'HELLO_EMD_123'",
    },
  ],
  run({ image, bytes }, o) {
    if (o.mode === 'encode') return encodeOutputs(image, o);
    return o.mode === 'auto' ? autoOutputs(image, bytes, o) : decodeOutputs(image, bytes, o);
  },
});
