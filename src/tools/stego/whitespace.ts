import { defineTool, number, select, text, toggle } from '../../core/define';
import { ToolError } from '../../core/errors';
import type { Output } from '../../core/types';
import { utf8Decode, utf8Encode } from '../../lib/bytes';
import { readability } from './_zerowidth';

/** Table rows and map lines shown before the output is cut off. */
const MAX_SHOWN = 200;

export interface WsLine {
  /** The line without its trailing spaces and tabs. */
  text: string;
  /** The trailing run of spaces and tabs ('' if none). */
  ws: string;
}

export interface Reading {
  scheme: string;
  detail: string;
  bytes: Uint8Array;
  text: string;
  score: number;
}

/** Split into lines (CRLF or LF), separating each line's trailing run of spaces and tabs. */
export function splitLines(input: string): WsLine[] {
  const raw = input.split(/\r?\n/);
  if (raw.length > 1 && raw[raw.length - 1] === '') raw.pop();
  return raw.map((line) => {
    const m = /[ \t]+$/.exec(line);
    return m ? { text: line.slice(0, m.index), ws: m[0] } : { text: line, ws: '' };
  });
}

function bitsToBytes(bits: number[], width: 7 | 8, msb: boolean, offset: number): Uint8Array {
  const n = Math.floor((bits.length - offset) / width);
  const out = new Uint8Array(Math.max(0, n));
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let b = 0; b < width; b++) {
      const bit = bits[offset + i * width + b]!;
      v = msb ? (v << 1) | bit : v | (bit << b);
    }
    out[i] = v;
  }
  return out;
}

function reading(scheme: string, detail: string, bytes: Uint8Array): Reading | null {
  if (!bytes.length) return null;
  const text = utf8Decode(bytes);
  return { scheme, detail, bytes, text, score: readability(text) };
}

/** Every way of packing a bit stream into bytes: 8 or 7 bits, either bit order, either end. */
function framings(bits: number[], scheme: string, detail: string, preferred = false): Reading[] {
  const out: Reading[] = [];
  for (const width of [8, 7] as const) {
    const rest = bits.length % width;
    for (const offset of rest ? [0, rest] : [0]) {
      for (const msb of [true, false]) {
        const r = reading(
          scheme,
          `${detail}, ${width} bits per character, ${msb ? 'most' : 'least'} significant bit first${offset ? `, skipping the first ${offset}` : ''}`,
          bitsToBytes(bits, width, msb, offset),
        );
        if (r) {
          const bonus = preferred && width === 8 && msb && !offset ? 8 : 0;
          out.push({ ...r, score: r.score * (rest ? 0.85 : 1) + bonus });
        }
      }
    }
  }
  return out;
}

/**
 * stegsnow groups: after the first tab of a line's trailing whitespace, every "spaces then tab"
 * is one group whose value is the number of spaces (0-7), i.e. 3 bits. Null if a count exceeds 7.
 */
function snowGroups(lines: WsLine[], countTailSpaces: boolean): number[] | null {
  const groups: number[] = [];
  for (const { ws } of lines) {
    const first = ws.indexOf('\t');
    if (first < 0) continue;
    const pieces = ws.slice(first + 1).split('\t');
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i]!;
      const isLast = i === pieces.length - 1;
      if (isLast && (!piece.length || !countTailSpaces)) continue;
      if (piece.length > 7) return null;
      groups.push(piece.length);
    }
  }
  return groups;
}

/** Every reading of the whitespace in the text, best first. */
export function decodeWhitespace(input: string): Reading[] {
  const lines = splitLines(input);
  const found: Reading[] = [];

  // 1. stegsnow (uncompressed, unencrypted).
  for (const tail of [false, true]) {
    const groups = snowGroups(lines, tail);
    if (!groups || groups.length < 3) continue;
    for (const groupMsb of [true, false]) {
      const bits = groups.flatMap((g) =>
        groupMsb ? [(g >> 2) & 1, (g >> 1) & 1, g & 1] : [g & 1, (g >> 1) & 1, (g >> 2) & 1],
      );
      for (const byteMsb of [true, false]) {
        const r = reading(
          'stegsnow (spaces and tabs, 3 bits per group)',
          `bits in a group ${groupMsb ? 'high' : 'low'} first, bits in a byte ${byteMsb ? 'high' : 'low'} first${tail ? ', spaces after the last tab count' : ''}`,
          bitsToBytes(bits, 8, byteMsb, 0),
        );
        if (r) {
          // Prefer the layout stegsnow itself writes when readings tie (tiny messages).
          if (groupMsb && byteMsb && !tail) r.score += 8;
          found.push(r);
        }
      }
    }
  }

  // 2. Every trailing space or tab is one bit.
  const stream = lines.flatMap((l) => [...l.ws]);
  if (stream.length >= 8) {
    for (const spaceIsZero of [true, false]) {
      const bits = stream.map((c) => (c === ' ' ? (spaceIsZero ? 0 : 1) : spaceIsZero ? 1 : 0));
      found.push(
        ...framings(
          bits,
          'Trailing whitespace as bits',
          spaceIsZero ? 'space=0 tab=1' : 'space=1 tab=0',
          spaceIsZero,
        ),
      );
    }
  }

  // 3. One bit per line: does the line end in whitespace?
  for (const skipBlank of [false, true]) {
    const used = lines.filter((l) => !skipBlank || l.text.trim() !== '');
    if (used.length < 8 || !used.some((l) => l.ws) || used.every((l) => l.ws)) continue;
    for (const marked of [1, 0]) {
      const bits = used.map((l) => (l.ws ? marked : 1 - marked));
      found.push(
        ...framings(
          bits,
          'One bit per line (trailing whitespace or not)',
          `${marked ? 'with' : 'without'} trailing whitespace = 1${skipBlank ? ', blank lines skipped' : ''}`,
        ),
      );
    }
  }

  // 4. Single or double space between words.
  const gaps = [...input.matchAll(/(?<=\S)( {1,2})(?=\S)/g)].map((m) => m[1]!.length);
  if (gaps.length >= 8 && gaps.includes(1) && gaps.includes(2)) {
    for (const doubleIsOne of [true, false]) {
      const bits = gaps.map((g) => (g === 2 ? (doubleIsOne ? 1 : 0) : doubleIsOne ? 0 : 1));
      found.push(
        ...framings(
          bits,
          'Single or double space between words',
          doubleIsOne ? 'two spaces=1' : 'two spaces=0',
        ),
      );
    }
  }

  const ranked = found.map((c, i) => ({ c, i })).sort((a, b) => b.c.score - a.c.score || a.i - b.i);
  const seen = new Set<string>();
  const unique: Reading[] = [];
  for (const { c } of ranked) {
    if (!c.text || seen.has(c.text)) continue;
    seen.add(c.text);
    unique.push(c);
  }
  return unique;
}

// ---------- encoding ----------

const tabStop = (col: number) => (Math.floor(col / 8) + 1) * 8;

/** Display width of a line, with tabs expanding to the next multiple of 8. */
function columns(line: string): number {
  let col = 0;
  for (const ch of line) col = ch === '\t' ? tabStop(col) : col + 1;
  return col;
}

/** How many 3-bit groups a cover line can carry within `lineLength` columns. */
function snowCapacity(line: string, lineLength: number): number {
  const start = tabStop(columns(line));
  if (start >= lineLength) return 0;
  return Math.max(0, Math.floor((lineLength - 1 - start) / 8));
}

/**
 * Hide `secret` the way stegsnow does without compression or a password: the bits, three at a
 * time, become "spaces then tab" groups appended after a start tab; lines stay under
 * `lineLength` columns.
 */
export function encodeSnow(cover: string, secret: string, lineLength = 80): string {
  const bytes = utf8Encode(secret);
  const bits: number[] = [];
  for (const byte of bytes) for (let b = 7; b >= 0; b--) bits.push((byte >> b) & 1);
  while (bits.length % 3) bits.push(0);
  const groups: number[] = [];
  for (let i = 0; i < bits.length; i += 3)
    groups.push(bits[i]! * 4 + bits[i + 1]! * 2 + bits[i + 2]!);

  const lines = splitLines(cover).map((l) => l.text);
  const capacity = lines.reduce((a, l) => a + snowCapacity(l, lineLength), 0);
  if (capacity < groups.length) {
    throw new ToolError(
      `The cover text is too short: its ${lines.length} lines can hold ${Math.floor((capacity * 3) / 8)} bytes at ${lineLength} columns, the secret needs ${bytes.length}. Add more lines, shorten the secret, or raise the line length.`,
    );
  }
  let next = 0;
  const out = lines.map((line) => {
    const room = snowCapacity(line, lineLength);
    const take = Math.min(room, groups.length - next);
    if (take <= 0) return line;
    let extra = '\t';
    for (let i = 0; i < take; i++) extra += ' '.repeat(groups[next + i]!) + '\t';
    next += take;
    return line + extra;
  });
  return out.join('\n') + (cover.endsWith('\n') ? '\n' : '');
}

/** Hide `secret` as one byte per line: 8 trailing characters, space = 0, tab = 1, high bit first. */
export function encodeBinary(cover: string, secret: string): string {
  const bytes = utf8Encode(secret);
  const lines = splitLines(cover).map((l) => l.text);
  if (lines.length < bytes.length) {
    throw new ToolError(
      `The cover text has ${lines.length} lines but the secret needs ${bytes.length} (one byte per line). Add lines or shorten the secret.`,
    );
  }
  const out = lines.map((line, i) => {
    const byte = bytes[i];
    if (byte === undefined) return line;
    let bits = '';
    for (let b = 7; b >= 0; b--) bits += (byte >> b) & 1 ? '\t' : ' ';
    return line + bits;
  });
  return out.join('\n') + (cover.endsWith('\n') ? '\n' : '');
}

// ---------- the tool ----------

function visibleMap(lines: WsLine[]): string {
  return lines
    .slice(0, MAX_SHOWN)
    .map((l) => l.text + [...l.ws].map((c) => (c === '\t' ? '→' : '·')).join(''))
    .join('\n');
}

function preview(value: string, max = 70): string {
  const clean = [...value].map((ch) => (ch.codePointAt(0)! < 0x20 ? '·' : ch)).join('');
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

function looksTextual(value: string): boolean {
  if (!value.length) return false;
  let ok = 0;
  let total = 0;
  for (const ch of value) {
    const cp = ch.codePointAt(0)!;
    total++;
    if (cp === 9 || cp === 10 || cp === 13 || (cp >= 0x20 && cp !== 0x7f && cp !== 0xfffd)) ok++;
  }
  return ok / total >= 0.9;
}

function decode(input: string): Output[] {
  const lines = splitLines(input);
  const withWs = lines.filter((l) => l.ws);
  const onlyWhitespace = /^[ \t\r\n]+$/.test(input) && input.length >= 20;
  if (!withWs.length) {
    throw new ToolError(
      'No line ends in spaces or tabs. If the text came through a website or chat, the trailing whitespace may have been stripped: open the original file instead.',
    );
  }
  const spaces = withWs.reduce((a, l) => a + [...l.ws].filter((c) => c === ' ').length, 0);
  const tabs = withWs.reduce((a, l) => a + [...l.ws].filter((c) => c === '\t').length, 0);
  const readings = decodeWhitespace(input);
  const out: Output[] = [];
  const best = readings[0];
  if (best) {
    const label = `Best reading · ${best.scheme}`;
    out.push(
      looksTextual(best.text)
        ? { type: 'text', label, value: best.text }
        : { type: 'bytes', label, value: best.bytes, filename: 'hidden.bin' },
    );
    if (best.score < 35 || !looksTextual(best.text)) {
      out.push({
        type: 'note',
        level: 'warn',
        text: 'No reading looks like plain text. If the message was hidden with stegsnow using -C (compression) or -p (a password), the bits are compressed or encrypted: run stegsnow itself with the same options to read them.',
      });
    }
    out.push({
      type: 'table',
      label: 'Every reading, most readable first',
      columns: ['Rank', 'Scheme', 'Detail', 'Score', 'Result'],
      rows: readings
        .slice(0, 12)
        .map((r, i) => [i + 1, r.scheme, r.detail, r.score.toFixed(1), preview(r.text)]),
      highlight: [0],
    });
  } else {
    out.push({
      type: 'note',
      level: 'warn',
      text: 'There is trailing whitespace but not enough of it to read anything (try the whitespace map below).',
    });
  }
  out.push({
    type: 'kv',
    label: 'Whitespace found',
    entries: [
      ['Lines', String(lines.length)],
      ['Lines ending in spaces or tabs', `${withWs.length} of ${lines.length}`],
      ['Trailing spaces', String(spaces)],
      ['Trailing tabs', String(tabs)],
    ],
  });
  out.push({
    type: 'text',
    label:
      lines.length > MAX_SHOWN
        ? `Trailing whitespace made visible (first ${MAX_SHOWN} lines; · = space, → = tab)`
        : 'Trailing whitespace made visible (· = space, → = tab)',
    value: visibleMap(lines),
  });
  if (onlyWhitespace) {
    out.push({
      type: 'note',
      level: 'info',
      text: 'The whole text is spaces, tabs and line feeds: that can be a program in the Whitespace esoteric language. Run it in a Whitespace interpreter; this tool does not execute programs.',
    });
  }
  return out;
}

function encode(
  cover: string,
  secret: string,
  scheme: 'snow' | 'binary',
  lineLength: number,
): Output[] {
  if (!secret) throw new ToolError('Type the message to hide in the "Secret message" option.');
  if (!cover.trim()) throw new ToolError('Type the cover text (several lines) in the input box.');
  const result =
    scheme === 'snow' ? encodeSnow(cover, secret, lineLength) : encodeBinary(cover, secret);
  const back = decodeWhitespace(result)[0];
  const ok = back?.text === secret;
  const used = splitLines(result).filter((l) => l.ws).length;
  return [
    {
      type: 'note',
      level: 'success',
      text: `Hidden ${utf8Encode(secret).length} bytes in the trailing whitespace of ${used} lines. Copy the text below with its spaces and tabs intact.`,
    },
    { type: 'text', label: 'Text with hidden whitespace (copy all of it)', value: result },
    {
      type: 'text',
      label: 'Whitespace made visible (· = space, → = tab)',
      value: visibleMap(splitLines(result)),
    },
    ok
      ? {
          type: 'note',
          level: 'success',
          text: 'Round-trip check passed: decoding returns the secret.',
        }
      : {
          type: 'note',
          level: 'warn',
          text: 'Round-trip check failed: the cover text already has odd whitespace. Remove trailing spaces and tabs from it first.',
        },
  ];
}

const DEMO_COVER = [
  'Roses are red, violets are blue,',
  'this is a poem, nothing to see,',
  'the weather is fine and the sky is wide,',
  'a quiet walk beside the sea.',
  'We counted gulls along the shore,',
  'and shells and stones and driftwood too,',
  'then wandered home as evening fell,',
  'with sand on shoes and skies of blue.',
  'The lighthouse blinked its steady light,',
  'the tide came in, the tide went out,',
  'a fisherman mended his nets,',
  'and children ran about and shout.',
  'The market closed, the lanterns glowed,',
  'a fiddler played a tune or two,',
  'and nothing much was said that night,',
  'but all of it was good and true.',
].join('\n');

export default defineTool({
  id: 'whitespace',
  name: 'Whitespace steganography',
  category: 'stego',
  description:
    'Read messages hidden in trailing spaces and tabs (stegsnow and simple bit schemes), or hide your own.',
  tags: [
    'snow',
    'stegsnow',
    'trailing spaces',
    'tabs',
    'spaces',
    'whitespace language',
    'invisible',
  ],
  input: 'text',
  placeholder: 'Paste text whose lines may end in invisible spaces and tabs (or open the file)',
  options: {
    mode: toggle('Mode', [
      { value: 'decode', label: 'Decode' },
      { value: 'encode', label: 'Encode' },
    ]),
    scheme: select(
      'Hide with',
      [
        { value: 'snow', label: 'stegsnow (3 bits per group)' },
        { value: 'binary', label: 'Binary (space=0, tab=1)' },
      ],
      'snow',
      { showIf: (v) => v.mode === 'encode' },
    ),
    secret: text('Secret message', '', {
      placeholder: 'flag{...}',
      showIf: (v) => v.mode === 'encode',
    }),
    lineLength: number('Line length', 80, {
      min: 20,
      max: 400,
      showIf: (v) => v.mode === 'encode' && v.scheme === 'snow',
      hint: 'stegsnow -l: keep lines shorter than this',
    }),
  },
  examples: [
    {
      label: 'Hidden stegsnow message',
      input: encodeSnow(DEMO_COVER, 'flag{snow_falls}'),
      expect: 'flag{snow_falls}',
    },
    {
      label: 'Space = 0, tab = 1',
      input: encodeBinary(DEMO_COVER, 'flag{ws_bits}'),
      expect: 'flag{ws_bits}',
    },
    {
      label: 'Hide a message',
      input: DEMO_COVER,
      options: { mode: 'encode', secret: 'flag{ws_hides}' },
      expect: 'Round-trip check passed',
    },
  ],
  detect({ text: t }) {
    if (!t) return null;
    if (/^[ \t\r\n]+$/.test(t) && t.length >= 20) {
      return {
        score: 0.5,
        reason: 'Only spaces, tabs and line feeds (maybe a Whitespace program)',
      };
    }
    const lines = splitLines(t).filter((l) => l.text.trim() !== '');
    if (lines.length < 3) return null;
    const marked = lines.filter((l) => l.ws);
    // Tabs at the end of lines are rare in prose and code: a couple of them are enough.
    const tabbed = marked.filter((l) => l.ws.includes('\t'));
    if (tabbed.length >= 2) {
      return {
        score: 0.85,
        options: { mode: 'decode' },
        reason: `${marked.length} of ${lines.length} lines end in spaces or tabs`,
      };
    }
    // Spaces only: needs many lines, and two trailing spaces everywhere is just Markdown.
    if (marked.length < 3 || marked.length / lines.length < 0.4) return null;
    if (marked.every((l) => l.ws === '  ')) return null;
    return {
      score: 0.6,
      options: { mode: 'decode' },
      reason: `${marked.length} of ${lines.length} lines end in spaces`,
    };
  },
  run(input, { mode, scheme, secret, lineLength }) {
    return mode === 'encode' ? encode(input, secret, scheme, lineLength) : decode(input);
  },
});
