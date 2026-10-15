import { bool, defineTool, number, text as textOption, toggle } from '../../core/define';
import { ToolError } from '../../core/errors';
import type { Output } from '../../core/types';
import { toolT } from '../../i18n/tool-text';
import {
  concatBytes,
  formatSize,
  fromBase64,
  printableRatio,
  toBase64,
  utf8Decode,
  utf8Encode,
} from '../../lib/bytes';
import { bytesResult, showChar } from './_common';

const T = toolT('uuencode');

// ---------------------------------------------------------------------------------------------
// Alphabets
// ---------------------------------------------------------------------------------------------

/** xxencode: "+" and "-" for 0 and 1, then digits, capitals, lower case (survives EBCDIC and mail). */
export const XX_ALPHABET = '+-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export type UuFormat = 'uu' | 'xx';

/** uuencode writes the 6-bit value v as the character 0x20 + v; 0 is a space, or a backtick. */
const uuChar = (v: number, backtick: boolean): string =>
  v === 0 && backtick ? '`' : String.fromCharCode(0x20 + v);

/** The value of a character, or -1 when it is not in the alphabet. */
function uuValue(ch: string, format: UuFormat): number {
  const c = ch.charCodeAt(0);
  if (format === 'uu') return c >= 0x20 && c <= 0x60 ? (c - 0x20) & 0x3f : -1;
  return XX_ALPHABET.indexOf(ch);
}

// ---------------------------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------------------------

export interface UuEncodeOptions {
  /** "uu" (uuencode), "xx" (xxencode) or "base64" (the body of `uuencode -m`). */
  format?: UuFormat | 'base64';
  /** Write the "begin MODE NAME" and "end" lines (and the closing zero-length line). */
  header?: boolean;
  name?: string;
  /** Unix permissions in octal, e.g. "644". */
  mode?: string;
  /** Bytes per line, 1-63: 45 is the standard (a line of 61 characters). */
  lineBytes?: number;
  /** uuencode: write the value 0 as a backtick (GNU) instead of a space (traditional). */
  backtick?: boolean;
}

/**
 * Three bytes become four characters of six bits; every line starts with a character that
 * says how many bytes it holds. With `header` the lines are framed by "begin 644 name" and a
 * zero-length line plus "end"; without it only the data lines are written.
 */
export function uuEncode(bytes: Uint8Array, opts: UuEncodeOptions = {}): string {
  const {
    format = 'uu',
    header = true,
    name = 'data.bin',
    mode = '644',
    lineBytes = 45,
    backtick = true,
  } = opts;
  const lines: string[] = [];

  if (format === 'base64') {
    if (header) lines.push(`begin-base64 ${mode} ${name}`);
    const b64 = toBase64(bytes);
    for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76));
    if (header) lines.push('====');
    return lines.join('\n');
  }

  const per = Math.max(1, Math.min(63, Math.floor(lineBytes)));
  const ch = (v: number): string => (format === 'xx' ? XX_ALPHABET[v]! : uuChar(v, backtick));
  if (header) lines.push(`begin ${mode} ${name}`);
  for (let i = 0; i < bytes.length; i += per) {
    const chunk = bytes.subarray(i, i + per);
    let line = ch(chunk.length);
    for (let j = 0; j < chunk.length; j += 3) {
      const a = chunk[j]!;
      const b = chunk[j + 1] ?? 0;
      const c = chunk[j + 2] ?? 0;
      line +=
        ch(a >> 2) + ch(((a & 3) << 4) | (b >> 4)) + ch(((b & 15) << 2) | (c >> 6)) + ch(c & 63);
    }
    lines.push(line);
  }
  if (header) lines.push(ch(0), 'end');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------------------------

export interface UuSection {
  /** From the begin line, or null for bare data lines. */
  name: string | null;
  mode: string | null;
  format: UuFormat | 'base64';
  bytes: Uint8Array;
  /** Data lines decoded. */
  lines: number;
  /** Lines that did not fit their length character (only with `lenient`). */
  warnings: { line: number; text: string }[];
}

const BEGIN = /^begin(-base64)?[ \t]+([0-7]{3,4})(?:[ \t]+(.*))?$/;

/** A ToolError that knows where the text stopped fitting. */
class UuError extends ToolError {
  constructor(
    message: string,
    readonly line: number,
    readonly col: number,
  ) {
    super(message);
  }
}

interface DataLine {
  /** 1-based line number in the text given. */
  no: number;
  text: string;
}

function checkLine(
  line: DataLine,
  format: UuFormat,
  lenient: boolean,
  warnings: UuSection['warnings'],
): Uint8Array {
  const raw = line.text.replace(/\r$/, '');
  const n = uuValue(raw[0]!, format);
  if (n < 0) {
    throw new UuError(
      T('error.badChar', {
        line: line.no,
        col: 1,
        char: showChar(raw[0]),
        format: formatName(format),
      }),
      line.no,
      1,
    );
  }
  const expected = Math.ceil(n / 3) * 4;
  let body = raw.slice(1);
  // blanks a mail system added after the data are not data; blanks it stripped (the character
  // for the value 0 is a space in uuencode) are only restored in lenient mode, with a warning
  if (body.length > expected && /^[ \t]*$/.test(body.slice(expected))) {
    body = body.slice(0, expected);
  }
  if (body.length !== expected) {
    const text = T('error.lineLength', {
      line: line.no,
      char: showChar(raw[0]),
      n,
      expected,
      actual: body.length,
    });
    if (!lenient) throw new UuError(text, line.no, 1);
    warnings.push({ line: line.no, text });
    body = body.slice(0, expected).padEnd(expected, format === 'uu' ? ' ' : '+');
  }
  const out = new Uint8Array(Math.ceil(n / 3) * 3);
  for (let g = 0; g < body.length; g += 4) {
    const v: number[] = [];
    for (let k = 0; k < 4; k++) {
      const val = uuValue(body[g + k]!, format);
      if (val < 0) {
        throw new UuError(
          T('error.badChar', {
            line: line.no,
            col: 2 + g + k,
            char: showChar(body[g + k]),
            format: formatName(format),
          }),
          line.no,
          2 + g + k,
        );
      }
      v.push(val);
    }
    const o = (g / 4) * 3;
    out[o] = (v[0]! << 2) | (v[1]! >> 4);
    out[o + 1] = ((v[1]! & 15) << 4) | (v[2]! >> 2);
    out[o + 2] = ((v[2]! & 3) << 6) | v[3]!;
  }
  return out.subarray(0, n);
}

const formatName = (f: UuFormat | 'base64'): string =>
  f === 'xx' ? 'xxencode' : f === 'uu' ? 'uuencode' : 'base64';

/** How many data lines fit this alphabet, and where the first one that does not goes wrong. */
function scan(lines: DataLine[], format: UuFormat): { fits: number; failAt: number } {
  let fits = 0;
  let failAt = Infinity;
  for (const l of lines) {
    try {
      checkLine(l, format, false, []);
      fits++;
    } catch (e) {
      if (!(e instanceof UuError)) throw e;
      if (failAt === Infinity) failAt = e.line * 100000 + e.col;
    }
  }
  return { fits, failAt };
}

/** Data lines of one section, up to the zero-length line ("`", " " or "+" alone) or "end". */
function dataLines(raw: DataLine[]): DataLine[] {
  const out: DataLine[] = [];
  for (const l of raw) {
    const t = l.text.replace(/\r$/, '');
    if (t === 'end') break;
    if (t.trim() === '') continue;
    if (t === '`') break;
    out.push({ no: l.no, text: t });
  }
  return out;
}

/**
 * Decode uuencode / xxencode text: "begin MODE NAME" ... "end" sections (anything before or
 * between them is ignored, so a mail with the file in it works), a "begin-base64" body, or bare
 * data lines. `format` "auto" tries uuencode first and then xxencode. A ToolError names the line
 * and column of the first thing that does not fit; with `lenient` a line whose length does not
 * match its length character is decoded as far as it goes and listed in `warnings`.
 */
export function uuDecode(
  text: string,
  format: UuFormat | 'auto' = 'auto',
  lenient = false,
): UuSection[] {
  const lines = text.split('\n').map((t, i) => ({ no: i + 1, text: t.replace(/\r$/, '') }));
  const sections: { head: RegExpExecArray | null; body: DataLine[] }[] = [];
  let cur: { head: RegExpExecArray | null; body: DataLine[] } | null = null;
  for (const l of lines) {
    const m = BEGIN.exec(l.text);
    if (m) {
      cur = { head: m, body: [] };
      sections.push(cur);
    } else if (cur) {
      cur.body.push(l);
      if (l.text === 'end' || (cur.head![1] && l.text.startsWith('===='))) cur = null;
    }
  }
  if (!sections.length) sections.push({ head: null, body: lines });

  const out: UuSection[] = [];
  for (const s of sections) {
    const name = s.head ? (s.head[3] ?? '').trim() || null : null;
    const mode = s.head ? s.head[2]! : null;
    if (s.head?.[1]) {
      const body = s.body.filter((l) => !l.text.startsWith('====') && l.text.trim() !== '');
      const joined = body.map((l) => l.text.trim()).join('');
      out.push({
        name,
        mode,
        format: 'base64',
        bytes: fromBase64(joined),
        lines: body.length,
        warnings: [],
      });
      continue;
    }
    const data = dataLines(s.body);
    let chosen: UuFormat;
    if (format !== 'auto') chosen = format;
    else {
      // the alphabet that fits the most lines; on a tie the one that gets furthest before its
      // first bad character; then xxencode when there are lower-case letters (uuencode has
      // none), else uuencode
      const uu = scan(data, 'uu');
      const xx = scan(data, 'xx');
      const lower = data.some((l) => /[a-z]/.test(l.text));
      chosen =
        uu.fits !== xx.fits
          ? uu.fits > xx.fits
            ? 'uu'
            : 'xx'
          : uu.failAt !== xx.failAt
            ? uu.failAt > xx.failAt
              ? 'uu'
              : 'xx'
            : lower
              ? 'xx'
              : 'uu';
    }
    const warnings: UuSection['warnings'] = [];
    const parts = data.map((l) => checkLine(l, chosen, lenient, warnings));
    out.push({
      name,
      mode,
      format: chosen,
      bytes: concatBytes(...parts),
      lines: data.length,
      warnings,
    });
  }
  return out;
}

/** For Auto-decode: bytes of a framed or bare uuencoded text in the given alphabet, else null. */
export function uuDecodeStrict(text: string, format: UuFormat): Uint8Array | null {
  const framed = /^begin(?:-base64)?[ \t]+[0-7]{3,4}\b/m.test(text);
  const lines = text.split('\n').map((t, i) => ({ no: i + 1, text: t.replace(/\r$/, '') }));
  if (!framed) {
    // bare lines: all of them must fit, there must be enough of them, and a few lines at least
    const data = dataLines(lines);
    if (!data.length || scan(data, format).fits !== data.length) return null;
    const bytes = concatBytes(...data.map((l) => checkLine(l, format, false, [])));
    return bytes.length >= 12 ? bytes : null;
  }
  const sections = uuDecode(text, format);
  const first = sections.find((s) => s.bytes.length);
  return first ? first.bytes : null;
}

// ---------------------------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------------------------

/** "644" as "rw-r--r--". */
export function modeString(mode: string): string {
  const digits = mode.slice(-3);
  return [...digits]
    .map((d) => {
      const v = Number(d);
      return `${v & 4 ? 'r' : '-'}${v & 2 ? 'w' : '-'}${v & 1 ? 'x' : '-'}`;
    })
    .join('');
}

/** A download name from the begin line: no path, no control characters. */
export function safeName(name: string | null): string {
  const base = (name ?? '').split(/[\\/]/).pop() ?? '';
  const clean = base
    .replace(/\p{Cc}/gu, '')
    .trim()
    .slice(0, 120);
  return clean && clean !== '.' && clean !== '..' ? clean : 'decoded.bin';
}

const SAMPLE_TEXT =
  'The quick brown fox jumps over the lazy dog. FTF{bare_uu_lines} is hidden in plain sight.';

export default defineTool({
  id: 'uuencode',
  name: 'uuencode / xxencode',
  category: 'encoding',
  description:
    'Decode or write uuencode and xxencode (begin / end lines with file mode and name, or bare lines) and uuencode -m; the file comes out as text or a download.',
  tags: [
    'uudecode',
    'uu',
    'xx',
    'xxdecode',
    'unix-to-unix',
    'begin 644',
    'sharutils',
    'usenet',
    'email attachment',
    'From UUEncode',
    'To UUEncode',
  ],
  input: 'bytes',
  placeholder: 'begin 644 cat.txt\n#0V%T\n`\nend',
  live: true,
  options: {
    mode: toggle('Mode', ['decode', 'encode']),
    format: toggle(
      'Alphabet',
      [
        { value: 'auto', label: 'Auto' },
        { value: 'uu', label: 'uuencode' },
        { value: 'xx', label: 'xxencode' },
      ],
      'auto',
      { showIf: (v) => v.mode === 'decode' },
    ),
    lenient: bool('Keep going on bad lines', false, {
      hint: 'Decode a line whose length does not match its first character as far as it goes, and list it.',
      showIf: (v) => v.mode === 'decode',
    }),
    writeAs: toggle(
      'Write as',
      [
        { value: 'uu', label: 'uuencode' },
        { value: 'xx', label: 'xxencode' },
        { value: 'base64', label: 'uuencode -m (base64)' },
      ],
      'uu',
      { showIf: (v) => v.mode === 'encode' },
    ),
    header: bool('Begin / end lines', true, { showIf: (v) => v.mode === 'encode' }),
    name: textOption('File name', '', {
      placeholder: 'data.bin',
      hint: 'Written in the begin line. Empty: the name of the opened file, or data.bin.',
      showIf: (v) => v.mode === 'encode' && v.header === true,
    }),
    fileMode: textOption('File mode', '644', {
      placeholder: '644',
      hint: 'Unix permissions in octal, three or four digits.',
      showIf: (v) => v.mode === 'encode' && v.header === true,
    }),
    lineBytes: number('Bytes per line', 45, {
      min: 1,
      max: 63,
      hint: '45 is the standard (61 characters per line); 63 is the most one length character can say.',
      showIf: (v) => v.mode === 'encode' && v.writeAs !== 'base64',
    }),
    backtick: bool('Backtick for zero', true, {
      hint: 'GNU sharutils writes the value 0 as ` instead of a space, so that blanks survive mail.',
      showIf: (v) => v.mode === 'encode' && v.writeAs === 'uu',
    }),
  },
  examples: [
    {
      label: 'Wikipedia: "Cat"',
      input: 'begin 644 cat.txt\n#0V%T\n`\nend',
      expect: 'Cat',
    },
    {
      label: 'Decode a flag',
      input: 'begin 644 flag.txt\n31E1&>W5U96YC;V1E7W=O<FMS?0``\n`\nend',
      expect: 'FTF{uuencode_works}',
    },
    {
      label: 'Bare lines, no begin / end',
      input: uuEncode(utf8Encode(SAMPLE_TEXT), { header: false }),
      expect: 'FTF{bare_uu_lines}',
    },
    {
      label: 'xxencode',
      input: uuEncode(utf8Encode('FTF{xxencode_works}'), { format: 'xx', name: 'flag.txt' }),
      expect: 'FTF{xxencode_works}',
    },
    {
      label: 'uuencode -m (base64 body)',
      input: 'begin-base64 644 cat.txt\nQ2F0\n====',
      expect: 'Cat',
    },
    {
      label: 'A picture attached to a mail',
      input: { sample: 'uuencode-mail.txt' },
      expect: 'File name: demo.png',
    },
    {
      label: 'Encode text',
      input: 'Cat',
      options: { mode: 'encode', name: 'cat.txt' },
      expect: '#0V%T',
    },
  ],
  detect({ text }) {
    if (!text) return null;
    const head = text.slice(0, 200000);
    if (/^begin(?:-base64)?[ \t]+[0-7]{3,4}\b/m.test(head)) {
      return {
        score: 0.92,
        options: { mode: 'decode', format: 'auto' },
        reason: T('detect.begin'),
      };
    }
    if (!/\n/.test(head.trim()) && head.trim().length < 20) return null;
    for (const f of ['uu', 'xx'] as const) {
      try {
        const bytes = uuDecodeStrict(head, f);
        if (bytes) {
          const readable = printableRatio(bytes) >= 0.9;
          return {
            score: readable ? 0.7 : 0.4,
            options: { mode: 'decode', format: f },
            reason: T(readable ? 'detect.linesText' : 'detect.lines'),
          };
        }
      } catch (e) {
        if (!(e instanceof ToolError)) throw e;
      }
    }
    return null;
  },
  run(
    { bytes, name: openedName },
    { mode, format, lenient, writeAs, header, name, fileMode, lineBytes, backtick },
  ) {
    if (mode === 'encode') {
      if (!/^[0-7]{3,4}$/.test(fileMode.trim()))
        throw new ToolError(T('error.fileMode', { mode: fileMode }));
      const fileName = (name.trim() || openedName?.trim() || 'data.bin').replace(/[\r\n]+/g, ' ');
      return [
        {
          type: 'text',
          value: uuEncode(bytes, {
            format: writeAs,
            header,
            name: fileName,
            mode: fileMode.trim(),
            lineBytes,
            backtick,
          }),
        },
      ];
    }

    const text = utf8Decode(bytes);
    if (!text.trim()) throw new ToolError(T('error.empty'));
    const sections = uuDecode(text, format, lenient);
    const out: Output[] = [];
    const notes = (s: UuSection): Output[] => {
      const n: Output[] = [];
      for (const w of s.warnings.slice(0, 5)) n.push({ type: 'note', level: 'warn', text: w.text });
      if (s.warnings.length > 5) {
        n.push({
          type: 'note',
          level: 'warn',
          text: T('note.moreWarnings', { count: s.warnings.length - 5 }),
        });
      }
      if (!s.bytes.length) n.push({ type: 'note', level: 'info', text: T('note.empty') });
      return n;
    };

    if (sections.length === 1) {
      const s = sections[0]!;
      out.push(...bytesResult(s.bytes, safeName(s.name)));
      const entries: [string, string][] = [[T('kv.format'), formatName(s.format)]];
      if (s.name) entries.push([T('kv.name'), s.name]);
      if (s.mode) entries.push([T('kv.mode'), `${s.mode} (${modeString(s.mode)})`]);
      entries.push([T('kv.lines'), String(s.lines)], [T('kv.size'), formatSize(s.bytes.length)]);
      out.push({ type: 'kv', entries });
      out.push(...notes(s));
      return out;
    }

    out.push({
      type: 'table',
      label: T('label.files'),
      columns: [T('kv.name'), T('kv.mode'), T('kv.format'), T('kv.size')],
      rows: sections.map((s) => [
        s.name ?? '—',
        s.mode ?? '—',
        formatName(s.format),
        formatSize(s.bytes.length),
      ]),
    });
    out.push({
      type: 'files',
      files: sections.map((s, i) => ({
        name:
          safeName(s.name) === 'decoded.bin' && sections.length > 1
            ? `decoded-${i + 1}.bin`
            : safeName(s.name),
        data: s.bytes,
        note: formatSize(s.bytes.length),
      })),
    });
    for (const s of sections) out.push(...notes(s));
    return out;
  },
});
