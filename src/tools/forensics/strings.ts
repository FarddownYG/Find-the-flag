import { bool, defineTool, number, text, toggle } from '../../core/define';
import { ToolError } from '../../core/errors';
import { DEFAULT_FLAG_PATTERN } from '../../core/flags';
import type { Output } from '../../core/types';
import { toolT } from '../../i18n/tool-text';
import { latin1Decode, printableRatio } from '../../lib/bytes';

const T = toolT('strings');

const MAX_RESULTS = 20_000;
/** Safety valve while scanning: random data can hold millions of tiny strings. */
const MAX_SCANNED = 2_000_000;

type Encoding = 'ascii' | 'utf16le' | 'utf16be';

export interface FoundString {
  /** Byte offset of the first character. */
  offset: number;
  /** Offset just after the last byte. */
  end: number;
  encoding: Encoding;
  text: string;
}

// Printable ASCII and tab, like GNU strings -a.
const isPrint = (c: number) => (c >= 0x20 && c < 0x7f) || c === 0x09;

function scanAscii(b: Uint8Array, min: number, out: FoundString[]): void {
  let start = -1;
  for (let i = 0; i <= b.length; i++) {
    if (i < b.length && isPrint(b[i]!)) {
      if (start < 0) start = i;
      continue;
    }
    if (start >= 0 && i - start >= min) {
      out.push({
        offset: start,
        end: i,
        encoding: 'ascii',
        text: latin1Decode(b.subarray(start, i)),
      });
    }
    start = -1;
    if (out.length > MAX_SCANNED) return;
  }
}

/** UTF-16 limited to ASCII characters (a printable byte next to a zero byte), both alignments. */
function scanUtf16(b: Uint8Array, min: number, little: boolean, out: FoundString[]): void {
  const encoding: Encoding = little ? 'utf16le' : 'utf16be';
  for (let parity = 0; parity < 2; parity++) {
    let start = -1;
    let chars: number[] = [];
    for (let i = parity; i + 1 <= b.length; i += 2) {
      const lo = little ? b[i] : b[i + 1];
      const hi = little ? b[i + 1] : b[i];
      if (lo !== undefined && hi === 0 && isPrint(lo)) {
        if (start < 0) start = i;
        chars.push(lo);
        continue;
      }
      if (start >= 0 && chars.length >= min) {
        out.push({
          offset: start,
          end: i,
          encoding,
          text: latin1Decode(Uint8Array.from(chars)),
        });
      }
      start = -1;
      chars = [];
      if (out.length > MAX_SCANNED) return;
    }
    if (start >= 0 && chars.length >= min) {
      out.push({
        offset: start,
        end: start + chars.length * 2,
        encoding,
        text: latin1Decode(Uint8Array.from(chars)),
      });
    }
  }
}

/** Every string of at least `min` characters, in offset order, without duplicates across encodings. */
export function findStrings(
  b: Uint8Array,
  min: number,
  encodings: Encoding[] = ['ascii', 'utf16le', 'utf16be'],
): FoundString[] {
  const all: FoundString[] = [];
  if (encodings.includes('ascii')) scanAscii(b, min, all);
  if (encodings.includes('utf16le')) scanUtf16(b, min, true, all);
  if (encodings.includes('utf16be')) scanUtf16(b, min, false, all);
  all.sort((a, c) => a.offset - c.offset || c.end - a.end);
  // The same bytes can read as UTF-16LE at one alignment and UTF-16BE at the other:
  // keep whichever reading is longer.
  const kept: FoundString[] = [];
  for (const f of all) {
    const last = kept[kept.length - 1];
    if (last && f.offset < last.end) {
      if (f.text.length > last.text.length) kept[kept.length - 1] = f;
      continue;
    }
    kept.push(f);
  }
  return kept;
}

/** "text" -> case-insensitive substring, "/regex/flags" -> regular expression. */
function makeFilter(raw: string): ((s: string) => boolean) | null {
  const t = raw.trim();
  if (t === '') return null;
  const m = /^\/(.+)\/([dimsuv]*)$/s.exec(t);
  if (m) {
    let re: RegExp;
    try {
      re = new RegExp(m[1]!, m[2]);
    } catch (e) {
      throw new ToolError(T('error.badRegex', { filter: t, message: (e as Error).message }));
    }
    return (s) => re.test(s);
  }
  const needle = t.toLowerCase();
  return (s) => s.toLowerCase().includes(needle);
}

const hexOffset = (n: number) => `0x${n.toString(16)}`;
const shorten = (s: string, n = 400) => (s.length > n ? `${s.slice(0, n)}…` : s);

export default defineTool({
  id: 'strings',
  name: 'Strings',
  category: 'forensics',
  description:
    'Pull readable text out of binary data, ASCII and UTF-16, with offsets. Flag-like strings come first.',
  tags: [
    'strings -a',
    'strings -el',
    'printable',
    'ascii',
    'utf-16',
    'wide',
    'grep',
    'binary text',
  ],
  input: 'bytes',
  placeholder: 'Drop a binary: executable, memory dump, firmware, image…',
  options: {
    min: number('Minimum length', 4, { min: 1, max: 1000 }),
    encoding: toggle(
      'Encoding',
      [
        { value: 'ascii', label: 'ASCII' },
        { value: 'utf16le', label: 'UTF-16LE' },
        { value: 'utf16be', label: 'UTF-16BE' },
        { value: 'all', label: 'All' },
      ],
      'all',
    ),
    filter: text('Filter', '', {
      placeholder: 'flag   or   /pass(word)?\\d+/i',
      hint: 'Plain text matches ignoring case; /…/ is a regular expression.',
    }),
    offsets: bool('Offsets in the text list', false, {
      hint: 'Prefix each line of the plain list with its hex offset, like strings -t x.',
    }),
  },
  examples: [
    {
      label: 'Everything in a binary (ASCII + UTF-16)',
      input: { sample: 'forensics-strings.bin' },
      expect: 'flag{wide_strings_are_sneaky}',
    },
    {
      label: 'Only UTF-16LE strings',
      input: { sample: 'forensics-strings.bin' },
      options: { encoding: 'utf16le' },
      expect: 'utf16le',
    },
    {
      label: 'Filter with a regular expression',
      input: { sample: 'forensics-strings.bin' },
      options: { encoding: 'ascii', filter: '/hunter\\d/' },
      expect: 'admin:hunter2',
    },
  ],
  run({ bytes }, { min, encoding, filter, offsets }) {
    if (bytes.length === 0) throw new ToolError(T('error.empty'));
    const encs: Encoding[] = encoding === 'all' ? ['ascii', 'utf16le', 'utf16be'] : [encoding];
    const test = makeFilter(filter);
    const flagRe = new RegExp(DEFAULT_FLAG_PATTERN);
    let strings = findStrings(bytes, min, encs);
    const scanned = strings.length;
    if (test) strings = strings.filter((s) => test(s.text));

    // Flag-like first (stable: offset order inside each group), then cut to the cap.
    const flagged = strings.filter((s) => flagRe.test(s.text));
    const rest = strings.filter((s) => !flagRe.test(s.text));
    const ordered = [...flagged, ...rest];
    const shown = ordered.slice(0, MAX_RESULTS);

    const out: Output[] = [];
    if (shown.length === 0) {
      out.push({
        type: 'note',
        level: 'info',
        text: test ? T('note.noMatch', { count: scanned }) : T('note.none', { min }),
      });
      return out;
    }
    out.push({
      type: 'table',
      label: flagged.length
        ? T('label.tableFlagged', { total: strings.length, flagged: flagged.length })
        : T('label.table', { total: strings.length }),
      columns: [T('col.offset'), T('col.encoding'), T('col.string')],
      rows: shown.map((s) => [hexOffset(s.offset), s.encoding, shorten(s.text)]),
      highlight: flagged.slice(0, MAX_RESULTS).map((_, i) => i),
    });
    // The text list is in file order: it is what you pipe into other tools.
    const inOrder = [...shown].sort((a, c) => a.offset - c.offset);
    out.push({
      type: 'text',
      label: T('label.list'),
      value: inOrder
        .map((s) => (offsets ? `${s.offset.toString(16).padStart(8, '0')} ${s.text}` : s.text))
        .join('\n'),
    });
    if (ordered.length > MAX_RESULTS) {
      out.push({
        type: 'note',
        level: 'warn',
        text: T('note.capped', { max: MAX_RESULTS, count: ordered.length }),
      });
    }
    return out;
  },
  detect({ bytes, text: sample }) {
    if (sample !== null || bytes.length < 64) return null;
    return printableRatio(bytes) < 0.9 ? { score: 0.3, reason: T('detect.binary') } : null;
  },
});
