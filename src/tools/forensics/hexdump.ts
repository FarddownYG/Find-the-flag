import { bool, defineTool, number, select, text, toggle } from '../../core/define';
import { ToolError } from '../../core/errors';
import type { Output } from '../../core/types';
import { formatSize, fromHex, toHex, utf8Decode } from '../../lib/bytes';
import { identify } from '../../lib/signatures';

/** The text dump is capped; the `bytes` block next to it always holds the whole selection. */
const MAX_DUMP_BYTES = 1 << 18;

// ---------- number parsing ----------

/** Decimal, 0x… hexadecimal, optional leading minus. Empty means "not given". */
function parseNumber(raw: string, label: string): number | null {
  const s = raw.trim().replace(/_/g, '');
  if (s === '') return null;
  const m = /^(-)?(?:0x([0-9a-f]+)|(\d+))$/i.exec(s);
  if (!m) {
    throw new ToolError(
      `${label} "${raw.trim()}" is not a number. Use decimal (256) or hex (0x100).`,
    );
  }
  const value = m[2] !== undefined ? parseInt(m[2], 16) : parseInt(m[3]!, 10);
  return m[1] ? -value : value;
}

// ---------- dump ----------

const printable = (c: number) => (c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : '.');

function asciiColumn(row: Uint8Array): string {
  let s = '';
  for (const c of row) s += printable(c);
  return s;
}

export function dumpXxd(
  data: Uint8Array,
  base: number,
  cols: number,
  group: number,
  withAscii: boolean,
): string {
  const offsetWidth = Math.max(8, (base + data.length).toString(16).length);
  const groupsPerRow = Math.ceil(cols / group);
  const hexWidth = cols * 2 + groupsPerRow - 1;
  const lines: string[] = [];
  for (let i = 0; i < data.length; i += cols) {
    const row = data.subarray(i, i + cols);
    const groups: string[] = [];
    for (let g = 0; g < row.length; g += group) groups.push(toHex(row.subarray(g, g + group)));
    let line = `${(base + i).toString(16).padStart(offsetWidth, '0')}: ${groups.join(' ')}`;
    if (withAscii) line = `${line.padEnd(offsetWidth + 2 + hexWidth)}  ${asciiColumn(row)}`;
    lines.push(line);
  }
  return lines.join('\n');
}

/** `hexdump -C`: 16 per row, two groups of eight, repeated rows squeezed into "*". */
function dumpCanonical(data: Uint8Array, base: number, withAscii: boolean): string {
  const offsetWidth = Math.max(8, (base + data.length).toString(16).length);
  const lines: string[] = [];
  let previous = '';
  let squeezing = false;
  for (let i = 0; i < data.length; i += 16) {
    const row = data.subarray(i, i + 16);
    const key = toHex(row);
    if (row.length === 16 && key === previous) {
      if (!squeezing) lines.push('*');
      squeezing = true;
      continue;
    }
    squeezing = false;
    previous = key;
    const left = toHex(row.subarray(0, 8), ' ');
    const right = toHex(row.subarray(8), ' ');
    let line = `${(base + i).toString(16).padStart(offsetWidth, '0')}  ${left.padEnd(23)}  ${right.padEnd(23)}`;
    if (withAscii) line += `  |${asciiColumn(row)}|`;
    lines.push(line.trimEnd());
  }
  lines.push((base + data.length).toString(16).padStart(offsetWidth, '0'));
  return lines.join('\n');
}

function dumpPlain(data: Uint8Array, cols: number): string {
  const lines: string[] = [];
  for (let i = 0; i < data.length; i += cols) lines.push(toHex(data.subarray(i, i + cols)));
  return lines.join('\n');
}

// ---------- reverse ----------

export interface ParsedDump {
  bytes: Uint8Array;
  /** Which dump format was recognised. */
  format: string;
  /** Number of zero bytes inserted where the dump skipped offsets (like xxd -r does). */
  filled: number;
}

const RE_XXD = /^([0-9a-f]{4,16}):[ \t]?(.*)$/i;
const RE_OFFSET_BYTES = /^([0-9a-f]{6,16})[ \t]+([0-9a-f]{2})(?=[ \t]|$)(.*)$/i;
const RE_WORDS = /^([0-9a-f]{7})((?:[ \t]+[0-9a-f]{4})+)[ \t]*$/i;
const RE_OFFSET_ONLY = /^[0-9a-f]{6,16}$/i;

function lineKind(line: string): 'xxd' | 'bytes' | 'words' | null {
  if (RE_XXD.test(line)) return 'xxd';
  if (RE_WORDS.test(line)) return 'words';
  if (RE_OFFSET_BYTES.test(line)) return 'bytes';
  return null;
}

/** Bytes of one dump line, with the offset printed on it (null when the line has none). */
function parseLine(
  line: string,
  kind: 'xxd' | 'bytes' | 'words',
  lineNo: number,
): { offset: string; data: Uint8Array } {
  if (kind === 'xxd') {
    const m = RE_XXD.exec(line);
    if (!m) throw new ToolError(`Line ${lineNo} is not an xxd line: "${line.slice(0, 60)}".`);
    // Hex groups end at the first run of two spaces; the ASCII column follows it.
    const hexPart = m[2]!.split(/ {2,}|\t/)[0]!.replace(/ /g, '');
    if (!/^(?:[0-9a-f]{2})*$/i.test(hexPart)) {
      throw new ToolError(
        `Line ${lineNo} has no valid hex bytes after the offset: "${line.slice(0, 60)}".`,
      );
    }
    return { offset: m[1]!, data: fromHex(hexPart) };
  }
  if (kind === 'words') {
    const m = RE_WORDS.exec(line);
    if (!m) throw new ToolError(`Line ${lineNo} is not a hexdump line: "${line.slice(0, 60)}".`);
    // Plain `hexdump` prints 16-bit words in little-endian order.
    const out: number[] = [];
    for (const w of m[2]!.trim().split(/\s+/))
      out.push(parseInt(w.slice(2), 16), parseInt(w.slice(0, 2), 16));
    return { offset: m[1]!, data: Uint8Array.from(out) };
  }
  const m = RE_OFFSET_BYTES.exec(line);
  if (!m) throw new ToolError(`Line ${lineNo} is not a hexdump line: "${line.slice(0, 60)}".`);
  const out: number[] = [];
  for (const tok of `${m[2]} ${m[3]}`.trim().split(/\s+/)) {
    // Stop at the ASCII column: |...| (hexdump -C) or >...< (od).
    if (!/^[0-9a-f]{2}$/i.test(tok)) break;
    out.push(parseInt(tok, 16));
  }
  return { offset: m[1]!, data: Uint8Array.from(out) };
}

/**
 * Parse the output of `xxd`, `xxd -p`, `xxd -i`, `hexdump -C`, `hexdump`, `od -A x -t x1z`
 * or plain hex back into bytes.
 */
export function parseHexDump(input: string): ParsedDump {
  const numbered = input
    .split(/\r?\n/)
    .map((l, i) => ({ text: l.replace(/\s+$/, ''), no: i + 1 }))
    .filter((l) => l.text.trim() !== '');
  const lines = numbered.map((l) => l.text);
  if (lines.length === 0)
    throw new ToolError('Paste a hex dump (xxd, hexdump -C, od) or plain hex.');

  const kind = lineKind(lines[0]!);
  if (!kind) {
    const whole = lines.join('\n');
    if (/\{/.test(whole) && /0x[0-9a-f]{1,2}\b/i.test(whole)) {
      // C source as written by `xxd -i`: unsigned char data[] = { 0x89, 0x50, ... };
      const body = whole.slice(whole.indexOf('{') + 1);
      const bytes = Uint8Array.from(
        [...body.matchAll(/0x([0-9a-f]{1,2})\b/gi)].map((m) => parseInt(m[1]!, 16)),
      );
      return { bytes, format: 'C array (xxd -i)', filled: 0 };
    }
    // Plain hex (xxd -p, a hex string, "de ad be ef", 0x.. lists).
    return { bytes: fromHex(lines.join('')), format: 'plain hex', filled: 0 };
  }

  // Offsets of od/hexdump may be octal; decide from the first two lines.
  const first = parseLine(lines[0]!, kind, 1);
  let radix = 16;
  const secondText = lines.slice(1).find((l) => l.trim() !== '*');
  if (secondText && lineKind(secondText) === kind && /^[0-7]+$/.test(first.offset)) {
    const second = parseLine(secondText, kind, 2);
    if (/^[0-7]+$/.test(second.offset)) {
      const step = first.data.length;
      const asHex = parseInt(second.offset, 16) - parseInt(first.offset, 16);
      const asOct = parseInt(second.offset, 8) - parseInt(first.offset, 8);
      if (asHex !== step && asOct === step) radix = 8;
    }
  }

  const chunks: Uint8Array[] = [];
  let filled = 0;
  let expected = parseInt(first.offset, radix);
  let previous: Uint8Array | null = null;
  let squeeze = false;
  numbered.forEach(({ text: line, no }) => {
    const text = line.trim();
    if (text === '*') {
      squeeze = true;
      return;
    }
    if (RE_OFFSET_ONLY.test(text) && lineKind(text) === null) {
      // Final line of hexdump -C / od: just the total length. It also ends a squeezed run.
      const end = parseInt(text, radix);
      if (squeeze && previous && end > expected) {
        fill(chunks, previous, end - expected);
        expected = end;
      }
      squeeze = false;
      return;
    }
    const parsed = parseLine(text, lineKind(text) ?? kind, no);
    const offset = parseInt(parsed.offset, radix);
    if (squeeze && previous) {
      // "*" means: the previous row repeats until this offset.
      fill(chunks, previous, offset - expected);
      expected = offset;
    } else if (offset > expected) {
      const gap = offset - expected;
      chunks.push(new Uint8Array(gap));
      filled += gap;
      expected = offset;
    }
    squeeze = false;
    chunks.push(parsed.data);
    expected += parsed.data.length;
    previous = parsed.data;
  });
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.length;
  }
  const format =
    kind === 'xxd' ? 'xxd' : kind === 'words' ? 'hexdump (16-bit words)' : 'hexdump -C / od';
  return { bytes, format, filled };
}

function fill(chunks: Uint8Array[], row: Uint8Array, count: number): void {
  if (count <= 0 || row.length === 0) return;
  const full = Math.floor(count / row.length);
  for (let i = 0; i < full; i++) chunks.push(row);
  const rest = count - full * row.length;
  if (rest > 0) chunks.push(row.subarray(0, rest));
}

// ---------- the tool ----------

export default defineTool({
  id: 'hexdump',
  name: 'Hexdump / xxd',
  category: 'forensics',
  description:
    'Show any data as a hex dump (xxd, hexdump -C), or turn a pasted dump back into bytes.',
  tags: ['xxd', 'hexdump', 'hex', 'od', 'dump', 'xxd -r', 'hex editor', 'reverse', 'bytes'],
  input: 'bytes',
  placeholder: 'Drop a file, or paste text. In Reverse mode paste an xxd / hexdump -C dump.',
  options: {
    mode: toggle('Mode', [
      { value: 'dump', label: 'Dump' },
      { value: 'reverse', label: 'Reverse (xxd -r)' },
    ]),
    style: select(
      'Style',
      [
        { value: 'xxd', label: 'xxd' },
        { value: 'canonical', label: 'hexdump -C' },
        { value: 'plain', label: 'plain hex (xxd -p)' },
      ],
      'xxd',
      { segmented: true, showIf: (v) => v.mode === 'dump' },
    ),
    cols: number('Bytes per row', 16, {
      min: 1,
      max: 256,
      showIf: (v) => v.mode === 'dump' && v.style !== 'canonical',
    }),
    group: number('Group size', 2, {
      min: 1,
      max: 64,
      hint: 'Bytes per group, as xxd -g (2 by default, 1 for one byte at a time).',
      showIf: (v) => v.mode === 'dump' && v.style === 'xxd',
    }),
    start: text('Start offset', '0', {
      placeholder: '0, 0x100 or -64 (from the end)',
      showIf: (v) => v.mode === 'dump',
    }),
    length: text('Length', '', {
      placeholder: 'all, 256 or 0x100',
      showIf: (v) => v.mode === 'dump',
    }),
    ascii: bool('ASCII column', true, {
      showIf: (v) => v.mode === 'dump' && v.style !== 'plain',
    }),
  },
  examples: [
    {
      label: 'Dump a string',
      input: 'flag{hexdump_works}',
      expect: '00000000: 666c 6167 7b68 6578',
    },
    {
      label: 'hexdump -C of a PNG header',
      input: { sample: 'forensics-polyglot.png' },
      options: { style: 'canonical', length: '32' },
      expect: '|.PNG........IHDR|',
    },
    {
      label: 'Last 22 bytes, one byte per group',
      input: { sample: 'forensics-polyglot.png' },
      options: { start: '-22', group: 1 },
      expect: ': 50 4b 05 06',
    },
    {
      label: 'Reverse an xxd dump',
      input:
        '00000000: 666c 6167 7b78 7864 5f72 6576 6572 7365  flag{xxd_reverse\n00000010: 7d                                       }',
      options: { mode: 'reverse' },
      expect: 'flag{xxd_reverse}',
    },
    {
      label: 'Reverse a hexdump -C (PNG header)',
      input:
        '00000000  89 50 4e 47 0d 0a 1a 0a  00 00 00 0d 49 48 44 52  |.PNG........IHDR|\n00000010',
      options: { mode: 'reverse' },
      expect: 'PNG image (.png)',
    },
  ],
  run({ bytes }, { mode, style, cols, group, start, length, ascii }) {
    if (mode === 'reverse') {
      const parsed = parseHexDump(utf8Decode(bytes));
      const out: Output[] = [];
      const best = identify(parsed.bytes)[0];
      const entries: [string, string][] = [
        ['Format', parsed.format],
        ['Bytes', `${parsed.bytes.length} (${formatSize(parsed.bytes.length)})`],
      ];
      if (best) entries.push(['File type', `${best.name} (.${best.ext})`]);
      out.push({ type: 'kv', label: 'Parsed', entries });
      if (parsed.filled > 0) {
        out.push({
          type: 'note',
          level: 'warn',
          text: `The dump skipped ${parsed.filled} byte${parsed.filled === 1 ? '' : 's'} (offsets jump); they were filled with zeros, as xxd -r does.`,
        });
      }
      out.push({
        type: 'bytes',
        label: 'Bytes',
        value: parsed.bytes,
        filename: `reversed.${best && !best.weak ? best.ext : 'bin'}`,
      });
      return out;
    }

    if (bytes.length === 0) throw new ToolError('Nothing to dump: drop a file or paste some text.');
    let from = parseNumber(start, 'Start offset') ?? 0;
    if (from < 0) from = Math.max(0, bytes.length + from);
    if (from > bytes.length) {
      throw new ToolError(
        `Start offset ${from} is past the end of the input (${bytes.length} bytes). Use a smaller value, or a negative one to count from the end.`,
      );
    }
    const wanted = parseNumber(length, 'Length');
    if (wanted !== null && wanted < 0) throw new ToolError('Length cannot be negative.');
    const to =
      wanted === null || wanted === 0 ? bytes.length : Math.min(bytes.length, from + wanted);
    const selection = from === 0 && to === bytes.length ? bytes : bytes.slice(from, to);
    if (selection.length === 0) throw new ToolError('The selected range is empty.');

    const shown =
      selection.length > MAX_DUMP_BYTES ? selection.subarray(0, MAX_DUMP_BYTES) : selection;
    const dump =
      style === 'canonical'
        ? dumpCanonical(shown, from, ascii)
        : style === 'plain'
          ? dumpPlain(shown, cols)
          : dumpXxd(shown, from, cols, group, ascii);
    const out: Output[] = [{ type: 'text', label: 'Hexdump', value: dump }];
    if (shown.length < selection.length) {
      out.push({
        type: 'note',
        level: 'warn',
        text: `Only the first ${shown.length} of ${selection.length} selected bytes are dumped as text. Set Start offset and Length to look at another part; the Bytes block below holds everything.`,
      });
    }
    out.push({
      type: 'bytes',
      label: `Bytes 0x${from.toString(16)}-0x${(from + selection.length).toString(16)}`,
      value: selection,
      filename:
        from === 0 && selection.length === bytes.length
          ? 'dump.bin'
          : `dump-${from.toString(16)}.bin`,
    });
    return out;
  },
  detect({ text: sample }) {
    if (sample === null) return null;
    const lines = sample.split(/\r?\n/).filter((l) => l.trim() !== '');
    if (lines.length < 2) return null;
    const kinds = lines.slice(0, 6).map((l) => lineKind(l.trim()));
    if (kinds[0] && kinds.filter((k) => k === kinds[0]).length >= Math.min(2, lines.length)) {
      return {
        score: 0.85,
        options: { mode: 'reverse' },
        reason: 'Looks like an xxd / hexdump listing',
      };
    }
    return null;
  },
});
