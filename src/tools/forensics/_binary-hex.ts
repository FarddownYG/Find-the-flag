/**
 * Hexdump (a bounded window, plus a search over the whole file) and Strings views of the
 * Binary analyzer.
 */
import { ToolError } from '../../core/errors';
import type { LazyFile, Output } from '../../core/types';
import { toolT } from '../../i18n/tool-text';
import { formatSize, fromHex, latin1Decode, toHex, utf8Encode } from '../../lib/bytes';
import { hex, parseSize, readRange } from './_binary-stream';
import { REGEX_SPAN, searchFile, stringsFile, type SearchQuery } from './_binary-scan';
import { dumpXxd } from './hexdump';

const T = toolT('binary-analyzer');

export const HEX_DEFAULT = 4096;
export const HEX_MAX = 1 << 20;
const XXD_TEXT_MAX = 64 << 10;
export const SEARCH_MAX = 10_000;
const STRINGS_MAX = 20_000;

/**
 * /regex/flags → regular expression (or a ToolError saying how to write one). The g and y
 * flags are accepted and dropped: the search walks the whole file anyway.
 */
function toRegex(raw: string): RegExp | null {
  const m = /^\/(.+)\/([dgimsuvy]*)$/s.exec(raw.trim());
  if (!m) return null;
  try {
    return new RegExp(m[1]!, m[2]!.replace(/[gy]/g, ''));
  } catch (e) {
    throw new ToolError(T('error.regex', { re: raw.trim(), why: (e as Error).message }));
  }
}

/** "de ad be ef", "de:ad:be:ef", "0xde 0xad": bytes, nothing else. */
const HEX_QUERY = /^(?:0x)?[0-9a-f]{2}(?:[\s:,]+(?:0x)?[0-9a-f]{2})+$/i;
/** "0xdeadbeef", "\xca\xfe\xba\xbe": bytes too. */
const HEX_PREFIXED = /^(?:0x(?:[0-9a-f]{2})+|(?:\\x[0-9a-f]{2})+)$/i;
/** "DEADBEEF", "89": hex digits only, looked up both as text and as bytes. */
const HEX_BARE = /^(?:[0-9a-f]{2})+$/i;

function utf16(s: string, little: boolean): Uint8Array {
  const out = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out[i * 2 + (little ? 0 : 1)] = c & 0xff;
    out[i * 2 + (little ? 1 : 0)] = c >> 8;
  }
  return out;
}

/**
 * "flag" → the text (UTF-8, and UTF-16LE/BE when it is ASCII); "de ad be ef" or "hex:deadbeef"
 * → those bytes; "/CTF\{.*?\}/" → a regular expression over the bytes read as Latin-1.
 */
export function parseQuery(raw: string): {
  query: SearchQuery;
  as: 'text' | 'hex' | 'regex' | 'both';
  shown: string;
} {
  const q = raw.trim();
  const re = toRegex(q);
  if (re) return { query: { kind: 'regex', re }, as: 'regex', shown: `/${re.source}/${re.flags}` };
  const hexText = /^hex:/i.test(q)
    ? q.slice(4)
    : HEX_QUERY.test(q)
      ? q
      : HEX_PREFIXED.test(q)
        ? q.replace(/^0x|\\x/gi, '')
        : null;
  if (hexText !== null) {
    const bytes = fromHex(hexText);
    if (!bytes.length) throw new ToolError(T('error.searchEmpty'));
    return {
      query: { kind: 'bytes', needles: [{ bytes, encoding: 'hex' }] },
      as: 'hex',
      shown: toHex(bytes, ' '),
    };
  }
  const needles = [{ bytes: utf8Encode(q), encoding: 'ascii' }];
  if (/^[\x20-\x7e]+$/.test(q) && q.length > 1) {
    needles.push(
      { bytes: utf16(q, true), encoding: 'utf16le' },
      { bytes: utf16(q, false), encoding: 'utf16be' },
    );
  }
  // Bare hex digits ("DEADBEEF") are ambiguous: look them up as text and as bytes.
  if (HEX_BARE.test(q)) {
    needles.push({ bytes: fromHex(q), encoding: 'hex' });
    return { query: { kind: 'bytes', needles }, as: 'both', shown: q };
  }
  return { query: { kind: 'bytes', needles }, as: 'text', shown: q };
}

const asciiOf = (b: Uint8Array) => latin1Decode(b).replace(/[^\x20-\x7e]/g, '.');

export async function hexView(
  file: LazyFile,
  o: { offset: string; length: string; search: string },
): Promise<Output[]> {
  if (file.size === 0) throw new ToolError(T('error.empty'));
  const out: Output[] = [];
  if (o.search.trim()) {
    const { query, as, shown } = parseQuery(o.search);
    const { hits, capped } = await searchFile(file, query, SEARCH_MAX);
    const how =
      as === 'regex'
        ? T('value.asRegex')
        : as === 'hex'
          ? T('value.asHex')
          : as === 'both'
            ? T('value.asTextAndHex')
            : T('value.asText');
    if (hits.length) {
      out.push({
        type: 'table',
        label: T('label.search', { count: hits.length, query: shown, how }),
        columns: [
          T('col.offset'),
          T('col.hex'),
          T('col.encoding'),
          T('col.length'),
          T('col.context'),
        ],
        rows: hits.map((h) => [
          h.offset,
          hex(h.offset),
          h.encoding,
          h.length,
          `${toHex(h.context.subarray(0, 16), ' ')}  ${asciiOf(h.context.subarray(0, Math.max(16, Math.min(h.length, 64))))}`,
        ]),
      });
      if (capped)
        out.push({
          type: 'note',
          level: 'warn',
          text: T('note.searchCapped', { max: SEARCH_MAX }),
        });
    } else {
      out.push({ type: 'note', level: 'info', text: T('note.searchNone', { query: shown, how }) });
    }
    if (as === 'regex')
      out.push({ type: 'note', level: 'info', text: T('note.regexSpan', { span: REGEX_SPAN }) });
  }
  let start = parseSize(o.offset, T('opt.offset')) ?? 0;
  if (start < 0 && -start > file.size)
    throw new ToolError(T('error.offsetBefore', { offset: start, size: file.size }));
  if (start < 0) start = file.size + start;
  if (start >= file.size)
    throw new ToolError(T('error.offsetPast', { offset: start, size: file.size }));
  let length = parseSize(o.length, T('opt.length')) ?? HEX_DEFAULT;
  if (length <= 0) length = HEX_DEFAULT;
  if (length > HEX_MAX) {
    out.push({
      type: 'note',
      level: 'warn',
      text: T('note.hexCapped', { max: formatSize(HEX_MAX) }),
    });
    length = HEX_MAX;
  }
  const bytes = await readRange(file, start, length);
  const shownText = bytes.subarray(0, XXD_TEXT_MAX);
  out.push({
    type: 'text',
    label: T('label.xxd', { from: hex(start), to: hex(start + shownText.length) }),
    value: dumpXxd(shownText, start, 16, 2, true),
  });
  if (shownText.length < bytes.length) {
    out.push({
      type: 'note',
      level: 'info',
      text: T('note.xxdCapped', { shown: shownText.length, count: bytes.length }),
    });
  }
  out.push({
    type: 'bytes',
    label: T('label.hexBytes', {
      from: hex(start),
      to: hex(start + bytes.length),
      size: file.size,
    }),
    value: bytes,
    filename: `dump-${start.toString(16)}.bin`,
  });
  return out;
}

// ---------------------------------------------------------------- Strings

function makeFilter(raw: string): ((s: string) => boolean) | null {
  const t = raw.trim();
  if (!t) return null;
  const re = toRegex(t);
  if (re) return (s) => re.test(s);
  const needle = t.toLowerCase();
  return (s) => s.toLowerCase().includes(needle);
}

const shorten = (s: string, n = 400) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** Characters of the "one per line" text block at most: the page must stay responsive. */
export const STRINGS_TEXT_MAX = 1 << 20;

export async function stringsView(
  file: LazyFile,
  o: { min: number; filter: string },
): Promise<Output[]> {
  if (file.size === 0) throw new ToolError(T('error.empty'));
  const min = Math.max(2, Math.floor(o.min));
  const res = await stringsFile(file, min, makeFilter(o.filter), STRINGS_MAX);
  const shown = [...res.flagged, ...res.rest].slice(0, STRINGS_MAX);
  if (!shown.length) {
    return [
      {
        type: 'note',
        level: 'info',
        text: o.filter.trim()
          ? T('note.stringsNoMatch', { count: res.total })
          : T('note.stringsNone', { min }),
      },
    ];
  }
  const lines: string[] = [];
  let chars = 0;
  for (const s of [...shown].sort((a, b) => a.offset - b.offset)) {
    if (chars + s.text.length + 1 > STRINGS_TEXT_MAX) break;
    lines.push(s.text);
    chars += s.text.length + 1;
  }
  const out: Output[] = [
    {
      type: 'table',
      label: T('label.strings', { count: res.matched, flagged: res.flagged.length }),
      columns: [T('col.offset'), T('col.encoding'), T('col.text')],
      rows: shown.map((s) => [hex(s.offset), s.encoding, shorten(s.text)]),
      highlight: res.flagged.slice(0, STRINGS_MAX).map((_, i) => i),
    },
    { type: 'text', label: T('label.stringsText'), value: lines.join('\n') },
  ];
  if (lines.length < shown.length) {
    out.push({
      type: 'note',
      level: 'info',
      text: T('note.stringsTextCapped', {
        shown: lines.length,
        count: shown.length,
        max: formatSize(STRINGS_TEXT_MAX),
      }),
    });
  }
  if (res.matched > shown.length) {
    out.push({
      type: 'note',
      level: 'warn',
      text: T('note.stringsCapped', { shown: shown.length, count: res.matched }),
    });
  }
  return out;
}
