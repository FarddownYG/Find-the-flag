import { bool, defineTool, toggle } from '../../core/define';
import { ToolError } from '../../core/errors';
import type { Output } from '../../core/types';
import { toolT } from '../../i18n/tool-text';
import { printableRatio, utf8Decode } from '../../lib/bytes';
import { bytesResult, showChar } from './_common';

const T = toolT('base100');

/** Byte 0 is U+1F3F7 (🏷) and byte 255 is U+1F4F6 (📶): the base100 of AdamNiederer's Rust crate. */
export const BASE100_FIRST = 0x1f3f7;
export const BASE100_LAST = BASE100_FIRST + 255;

/** U+FE0F (emoji presentation) is added by some apps when emoji are copied: it carries no data. */
const IGNORED = new Set([0xfe0f]);

export const isBase100 = (cp: number): boolean => cp >= BASE100_FIRST && cp <= BASE100_LAST;

/** One emoji (one code point, four UTF-8 bytes) per byte. */
export function base100Encode(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += String.fromCodePoint(BASE100_FIRST + b);
  return out;
}

export interface Base100Result {
  bytes: Uint8Array;
  /** Characters that were not part of the encoding and were left out (only with `skip`). */
  skipped: number;
  /** U+FE0F selectors that were left out. */
  selectors: number;
}

/**
 * Whitespace and U+FE0F are ignored. Any other character outside U+1F3F7–U+1F4F6 throws a
 * ToolError with its position (in characters), unless `skip` is set: then it is left out
 * and counted (an emoji message inside a sentence).
 */
export function base100Decode(text: string, skip = false): Base100Result {
  const out: number[] = [];
  let skipped = 0;
  let selectors = 0;
  let pos = 0;
  for (const ch of text) {
    pos++;
    const cp = ch.codePointAt(0)!;
    if (isBase100(cp)) {
      out.push(cp - BASE100_FIRST);
    } else if (IGNORED.has(cp)) {
      selectors++;
    } else if (/\s/.test(ch)) {
      continue;
    } else if (skip) {
      skipped++;
    } else {
      const hex = cp.toString(16).toUpperCase().padStart(4, '0');
      throw new ToolError(T('error.char', { char: showChar(ch), hex, pos }));
    }
  }
  return { bytes: Uint8Array.from(out), skipped, selectors };
}

export default defineTool({
  id: 'base100',
  name: 'Base100 (emoji)',
  category: 'encoding',
  description: 'Turn bytes into emoji and back with base100: one emoji per byte.',
  tags: ['base-100', 'emoji', 'emojis', 'emoticon', 'smiley', 'pictograph', 'b100'],
  input: 'bytes',
  placeholder: '👟👜👣👣👦',
  live: true,
  options: {
    mode: toggle('Mode', ['decode', 'encode']),
    skip: bool('Skip other characters', false, {
      hint: 'Read only the base100 emoji and leave out everything else (a sentence around the message).',
      showIf: (v) => v.mode === 'decode',
    }),
  },
  examples: [
    {
      label: 'Decode a flag',
      input: '👝👣👘👞👲👜👤👦👡👠👖👙👘👪👜🐨🐧🐧👴',
      expect: 'flag{emoji_base100}',
    },
    { label: 'Encode text', input: 'hello', options: { mode: 'encode' }, expect: '👟👜👣👣👦' },
    {
      label: 'Emoji inside a sentence',
      input: 'Look what I found: 👟👜👣👣👦 !!',
      options: { skip: true },
      expect: 'hello',
    },
  ],
  detect({ text }) {
    const t = text?.trim() ?? '';
    if (!t) return null;
    const emoji = [...t].filter((c) => !/\s/.test(c) && c !== '️');
    if (emoji.length < 3 || !emoji.every((c) => isBase100(c.codePointAt(0)!))) return null;
    try {
      const { bytes } = base100Decode(t);
      const printable = printableRatio(bytes) >= 0.9;
      return {
        score: printable ? 0.95 : 0.75,
        options: { mode: 'decode' },
        reason: T(printable ? 'detect.text' : 'detect.emoji'),
      };
    } catch {
      return null;
    }
  },
  run({ bytes }, { mode, skip }) {
    if (mode === 'encode') return [{ type: 'text', value: base100Encode(bytes) }];
    const r = base100Decode(utf8Decode(bytes), skip);
    const out: Output[] = bytesResult(r.bytes);
    if (r.skipped)
      out.push({ type: 'note', level: 'info', text: T('note.skipped', { count: r.skipped }) });
    if (r.selectors) {
      out.push({ type: 'note', level: 'info', text: T('note.selectors', { count: r.selectors }) });
    }
    return out;
  },
});
