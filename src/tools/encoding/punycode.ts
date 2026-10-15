import { defineTool, toggle } from '../../core/define';
import { ToolError } from '../../core/errors';
import type { Output } from '../../core/types';
import { toolT } from '../../i18n/tool-text';
import { utf8Decode } from '../../lib/bytes';
import { showChar } from './_common';

const T = toolT('punycode');

// RFC 3492 section 5 (parameter values for Punycode)
const BASE = 36;
const T_MIN = 1;
const T_MAX = 26;
const SKEW = 38;
const DAMP = 700;
const INITIAL_BIAS = 72;
const INITIAL_N = 128;
const MAX_INT = 2147483647;

/** RFC 3492 section 6.1: bias adaptation. */
function adapt(delta: number, numPoints: number, first: boolean): number {
  delta = first ? Math.floor(delta / DAMP) : delta >> 1;
  delta += Math.floor(delta / numPoints);
  let k = 0;
  while (delta > ((BASE - T_MIN) * T_MAX) >> 1) {
    delta = Math.floor(delta / (BASE - T_MIN));
    k += BASE;
  }
  return k + Math.floor(((BASE - T_MIN + 1) * delta) / (delta + SKEW));
}

const threshold = (k: number, bias: number): number =>
  k <= bias ? T_MIN : k >= bias + T_MAX ? T_MAX : k - bias;

const digitChar = (d: number): string => String.fromCharCode(d < 26 ? 97 + d : 22 + d);

/** a-z / A-Z are 0-25, 0-9 are 26-35, anything else is not a digit (BASE). */
function digitValue(cp: number): number {
  if (cp >= 48 && cp <= 57) return cp - 22;
  if (cp >= 65 && cp <= 90) return cp - 65;
  if (cp >= 97 && cp <= 122) return cp - 97;
  return BASE;
}

/**
 * RFC 3492 encoder: the ASCII characters first, a "-" if there were any, then the others as
 * generalised variable-length integers. No "xn--" prefix, no case handling.
 */
export function punycodeEncode(text: string): string {
  const input = Array.from(text, (c) => c.codePointAt(0)!);
  let out = '';
  for (const cp of input) if (cp < 128) out += String.fromCharCode(cp);
  const basic = out.length;
  let h = basic;
  if (basic) out += '-';

  let n = INITIAL_N;
  let delta = 0;
  let bias = INITIAL_BIAS;
  while (h < input.length) {
    let m = MAX_INT;
    for (const cp of input) if (cp >= n && cp < m) m = cp;
    if (m - n > Math.floor((MAX_INT - delta) / (h + 1))) {
      throw new ToolError(T('error.encodeOverflow'));
    }
    delta += (m - n) * (h + 1);
    n = m;
    for (const cp of input) {
      if (cp < n && ++delta > MAX_INT) throw new ToolError(T('error.encodeOverflow'));
      if (cp === n) {
        let q = delta;
        for (let k = BASE; ; k += BASE) {
          const t = threshold(k, bias);
          if (q < t) break;
          out += digitChar(t + ((q - t) % (BASE - t)));
          q = Math.floor((q - t) / (BASE - t));
        }
        out += digitChar(q);
        bias = adapt(delta, h + 1, h === basic);
        delta = 0;
        h++;
      }
    }
    delta++;
    n++;
  }
  return out;
}

/**
 * RFC 3492 decoder. `offset` is the position (0-based) of the first character in the text the
 * user gave, so that every error can name the exact character. Throws ToolError on a non-ASCII
 * character in the basic part, on a character that is not a digit, on a number cut short, on
 * overflow and on a result that is not a character.
 */
export function punycodeDecode(input: string, offset = 0): string {
  const out: number[] = [];
  const delimiter = input.lastIndexOf('-');
  for (let j = 0; j < Math.max(delimiter, 0); j++) {
    const cp = input.charCodeAt(j);
    if (cp >= 128) {
      throw new ToolError(T('error.basic', { char: showChar(input[j]), pos: offset + j + 1 }));
    }
    out.push(cp);
  }

  let n = INITIAL_N;
  let i = 0;
  let bias = INITIAL_BIAS;
  for (let idx = delimiter > 0 ? delimiter + 1 : 0; idx < input.length;) {
    const oldi = i;
    let w = 1;
    for (let k = BASE; ; k += BASE) {
      if (idx >= input.length) throw new ToolError(T('error.incomplete', { pos: offset + idx }));
      const pos = offset + idx + 1;
      const digit = digitValue(input.charCodeAt(idx));
      if (digit >= BASE) throw new ToolError(T('error.digit', { char: showChar(input[idx]), pos }));
      idx++;
      if (digit > Math.floor((MAX_INT - i) / w)) throw new ToolError(T('error.overflow', { pos }));
      i += digit * w;
      const t = threshold(k, bias);
      if (digit < t) break;
      if (w > Math.floor(MAX_INT / (BASE - t))) throw new ToolError(T('error.overflow', { pos }));
      w *= BASE - t;
    }
    const len = out.length + 1;
    bias = adapt(i - oldi, len, oldi === 0);
    if (Math.floor(i / len) > MAX_INT - n) {
      throw new ToolError(T('error.overflow', { pos: offset + idx }));
    }
    n += Math.floor(i / len);
    i %= len;
    if (n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) {
      const hex = n.toString(16).toUpperCase().padStart(4, '0');
      throw new ToolError(T('error.range', { hex, pos: offset + idx }));
    }
    out.splice(i++, 0, n);
  }
  return String.fromCodePoint(...out);
}

// ---------------------------------------------------------------------------------------------
// Domain names (IDNA labels)
// ---------------------------------------------------------------------------------------------

const ACE_PREFIX = 'xn--';
/** An "xn--" label anywhere in a text: after a non-label character, up to the next one. */
const ACE_LABEL = /(?<![A-Za-z0-9-])xn--[A-Za-z0-9-]+/gi;
/** Full stops other than "." that IDNA also reads as label separators. */
const DOTS = /[.。．｡]/;

export interface LabelRow {
  from: string;
  to: string;
}

export interface DecodedLabels {
  text: string;
  rows: LabelRow[];
  /** Labels that decode to plain ASCII: never valid in IDNA. */
  asciiOnly: string[];
  /** Labels that could not be decoded (only when `lenient`: otherwise the first one throws). */
  failed: string[];
}

/**
 * Replace every "xn--" label of the text with its Unicode form. With `lenient`, a label that
 * does not decode is left as it is (and listed in `failed`); otherwise it throws with its position.
 */
export function decodeAceLabels(text: string, lenient = false): DecodedLabels {
  const rows: LabelRow[] = [];
  const asciiOnly: string[] = [];
  const failed: string[] = [];
  const result = text.replace(ACE_LABEL, (label, index: number) => {
    try {
      const decoded = punycodeDecode(label.slice(ACE_PREFIX.length), index + ACE_PREFIX.length);
      if (!/\P{ASCII}/u.test(decoded)) asciiOnly.push(label);
      rows.push({ from: label, to: decoded });
      return decoded;
    } catch (e) {
      if (!lenient || !(e instanceof ToolError)) throw e;
      failed.push(label);
      return label;
    }
  });
  return { text: result, rows, asciiOnly, failed };
}

export interface EncodedLabels {
  text: string;
  rows: LabelRow[];
  /** NFKC + lower-case changed these labels before they were encoded. */
  mapped: LabelRow[];
  /** ASCII labels longer than 63 characters (the DNS limit). */
  tooLong: string[];
}

/** host = what is between "scheme://user@" and ":port" / "/path" in one word of the text. */
const HOST =
  /^([(<[\u0027"]*(?:[A-Za-z][A-Za-z0-9+.-]*:)?(?:\/\/)?(?:[^/?#@]*@)?)([^/?#]*?)((?::\d*)?[.,;:!?)\]>\u0027"]*(?:[/?#].*)?)$/s;

/**
 * Turn every non-ASCII label of the host names in the text into "xn--" + Punycode. The text is
 * read word by word; URLs and e-mail addresses keep everything but the host. Labels with
 * capitals or compatibility characters are NFKC-normalised and lower-cased first (listed in
 * `mapped`): this is not the complete UTS 46 mapping table.
 */
export function encodeDomains(text: string): EncodedLabels {
  const rows: LabelRow[] = [];
  const mapped: LabelRow[] = [];
  const tooLong: string[] = [];
  const result = text.replace(/\S+/g, (word) => {
    const m = HOST.exec(word);
    if (!m) return word;
    const [, head, host, tail] = m;
    const parts = host!.split(/([.\u3002\uff0e\uff61])/);
    const out = parts.map((part) => {
      if (part.length === 0) return part;
      if (DOTS.test(part)) return '.';
      if (!/\P{ASCII}/u.test(part)) {
        if (part.length > 63) tooLong.push(part);
        return part;
      }
      const folded = part.normalize('NFKC').toLowerCase();
      if (folded !== part) mapped.push({ from: part, to: folded });
      const ace = ACE_PREFIX + punycodeEncode(folded);
      if (ace.length > 63) tooLong.push(ace);
      rows.push({ from: part, to: ace });
      return ace;
    });
    return head! + out.join('') + tail!;
  });
  return { text: result, rows, mapped, tooLong };
}

// ---------------------------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------------------------

const MAX_ROWS = 100;

function rawLines(text: string, fn: (line: string, offset: number) => string): string {
  let offset = 0;
  return text
    .split('\n')
    .map((line) => {
      const out = fn(line.replace(/\r$/, ''), offset);
      offset += line.length + 1;
      return out;
    })
    .join('\n');
}

export default defineTool({
  id: 'punycode',
  name: 'Punycode / IDN',
  category: 'encoding',
  description:
    'Convert internationalised domain names (xn-- labels) to Unicode and back with Punycode (RFC 3492), or work on bare Punycode.',
  tags: [
    'idn',
    'idna',
    'xn--',
    'internationalized domain name',
    'unicode domain',
    'homograph',
    'rfc3492',
    'toASCII',
    'toUnicode',
    'domain',
  ],
  input: 'bytes',
  placeholder: 'xn--bcher-kva.example',
  live: true,
  options: {
    mode: toggle('Mode', ['decode', 'encode']),
    form: toggle('Text is', [
      { value: 'domain', label: 'Domain names (xn--)' },
      { value: 'raw', label: 'Bare Punycode (RFC 3492)' },
    ]),
  },
  examples: [
    {
      label: 'Domain with xn-- labels',
      input: 'xn--bcher-kva.example',
      expect: 'bücher.example',
    },
    {
      label: 'A message in a URL',
      input: 'https://xn--found-the-flag-n-a-doman-zjci.example/login',
      expect: 'https://found-the-flag-ïn-a-domaïn.example/login',
    },
    {
      label: 'Unicode domain to xn--',
      input: 'münchen.de 日本語.jp',
      options: { mode: 'encode' },
      expect: 'xn--mnchen-3ya.de xn--wgv71a119e.jp',
    },
    {
      label: 'RFC 3492 sample (A), Arabic',
      input: 'egbpdaj6bu4bxfgehfvwxn',
      options: { form: 'raw' },
      expect: 'ليهمابتكلموشعربي؟',
    },
    {
      label: 'Bare Punycode flag',
      input: 'flag{pnycd_ok}-kkb0sud',
      options: { form: 'raw' },
      expect: 'flag{pünycödé_ok}',
    },
    {
      label: 'RFC 3492 sample (D), Czech',
      input: 'Proprostnemluvesky-uyb24dma41a',
      options: { form: 'raw' },
      expect: 'Pročprostěnemluvíčesky',
    },
  ],
  detect({ text }) {
    if (!text || !/xn--/i.test(text)) return null;
    try {
      const r = decodeAceLabels(text.slice(0, 20000));
      if (!r.rows.length) return null;
      return { score: 0.93, options: { mode: 'decode', form: 'domain' }, reason: T('detect.ace') };
    } catch {
      return {
        score: 0.5,
        options: { mode: 'decode', form: 'domain' },
        reason: T('detect.aceBad'),
      };
    }
  },
  run({ bytes }, { mode, form }) {
    const text = utf8Decode(bytes);
    const out: Output[] = [];

    if (form === 'raw') {
      if (mode === 'encode') {
        return [{ type: 'text', value: rawLines(text, (line) => punycodeEncode(line)) }];
      }
      let stripped = 0;
      const value = rawLines(text, (line, offset) => {
        const lead = line.match(/^\s*xn--/i)?.[0].length ?? 0;
        if (lead) stripped++;
        return punycodeDecode(line.slice(lead).trimEnd(), offset + lead);
      });
      out.push({ type: 'text', value });
      if (stripped) out.push({ type: 'note', level: 'info', text: T('note.prefixStripped') });
      return out;
    }

    if (mode === 'encode') {
      const r = encodeDomains(text);
      out.push({ type: 'text', value: r.text });
      if (r.rows.length) {
        out.push({
          type: 'table',
          columns: [T('col.unicode'), T('col.ascii')],
          rows: r.rows.slice(0, MAX_ROWS).map((x) => [x.from, x.to]),
        });
      }
      for (const x of r.mapped.slice(0, 5)) {
        out.push({
          type: 'note',
          level: 'info',
          text: T('note.mapped', { from: x.from, to: x.to }),
        });
      }
      for (const label of r.tooLong.slice(0, 5)) {
        out.push({
          type: 'note',
          level: 'warn',
          text: T('note.tooLong', { label: label.slice(0, 40), count: label.length }),
        });
      }
      if (!r.rows.length)
        out.push({ type: 'note', level: 'info', text: T('note.nothingToEncode') });
      return out;
    }

    const r = decodeAceLabels(text);
    out.push({ type: 'text', value: r.text });
    if (r.rows.length) {
      out.push({
        type: 'table',
        columns: [T('col.ascii'), T('col.unicode')],
        rows: r.rows.slice(0, MAX_ROWS).map((x) => [x.from, x.to]),
      });
    } else {
      out.push({ type: 'note', level: 'info', text: T('note.noLabels') });
    }
    for (const label of r.asciiOnly.slice(0, 5)) {
      out.push({ type: 'note', level: 'warn', text: T('note.asciiOnly', { label }) });
    }
    return out;
  },
});
