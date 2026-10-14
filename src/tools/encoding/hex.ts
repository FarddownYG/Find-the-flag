import { defineTool, bool, select, toggle } from '../../core/define';
import { fromHex, printableRatio, toHex, utf8Decode } from '../../lib/bytes';
import { bytesResult } from './_common';

export type HexSeparator = 'none' | 'space' | 'colon' | 'comma' | 'x' | '0x' | 'c';

/** Text written between (or before) bytes for each separator style. */
const SEPARATORS: Record<HexSeparator, { sep: string; prefix: string }> = {
  none: { sep: '', prefix: '' },
  space: { sep: ' ', prefix: '' },
  colon: { sep: ':', prefix: '' },
  comma: { sep: ',', prefix: '' },
  x: { sep: '', prefix: '\\x' }, // \x66\x6c\x61\x67
  '0x': { sep: ' ', prefix: '0x' }, // 0x66 0x6c
  c: { sep: ', ', prefix: '0x' }, // 0x66, 0x6c  (C array body)
};

export function hexEncode(
  bytes: Uint8Array,
  separator: HexSeparator = 'none',
  upper = false,
): string {
  const { sep, prefix } = SEPARATORS[separator];
  let out = toHex(bytes, '');
  if (upper) out = out.toUpperCase();
  const parts: string[] = [];
  for (let i = 0; i < out.length; i += 2) parts.push(prefix + out.slice(i, i + 2));
  return parts.join(sep);
}

/**
 * Lenient hex decoder (see fromHex): whitespace, ":" "," ";" "-", 0x and \x prefixes are ignored.
 * Quotes, braces and a Python `b` prefix around the data are tolerated too.
 * Throws ToolError on non-hex characters or an odd number of digits.
 */
export function hexDecode(text: string): Uint8Array {
  const cleaned = text.replace(/^\s*[bB](?=["'])/, '').replace(/["'{}[\]]/g, '');
  return fromHex(cleaned);
}

export default defineTool({
  id: 'hex',
  name: 'Hex',
  category: 'encoding',
  description:
    'Convert text or bytes to hexadecimal and back; separators and 0x / \\x prefixes are ignored.',
  tags: ['hexadecimal', 'base16', 'from hex', 'to hex', 'xxd', 'bytes', '0x', '\\x'],
  input: 'bytes',
  placeholder: '66 6c 61 67 7b 68 65 78 7d   (or 666c61677b6865787d, \\x66\\x6c, 0x66,0x6c ...)',
  live: true,
  options: {
    mode: toggle('Mode', ['decode', 'encode']),
    separator: select(
      'Separator',
      [
        { value: 'none', label: 'None' },
        { value: 'space', label: 'Space' },
        { value: 'colon', label: 'Colon  66:6c' },
        { value: 'comma', label: 'Comma  66,6c' },
        { value: 'x', label: '\\x prefix  \\x66\\x6c' },
        { value: '0x', label: '0x prefix  0x66 0x6c' },
        { value: 'c', label: 'C array  0x66, 0x6c' },
      ],
      'space',
      { showIf: (v) => v.mode === 'encode' },
    ),
    upper: bool('Uppercase', false, { showIf: (v) => v.mode === 'encode' }),
  },
  examples: [
    {
      label: 'Decode a flag',
      input: '666c61677b6865785f69735f6a7573745f62797465737d',
      expect: 'flag{hex_is_just_bytes}',
    },
    {
      label: '\\x escapes',
      input:
        '\\x66\\x6c\\x61\\x67\\x7b\\x68\\x65\\x78\\x5f\\x69\\x73\\x5f\\x6a\\x75\\x73\\x74\\x5f\\x62\\x79\\x74\\x65\\x73\\x7d',
      expect: 'flag{hex_is_just_bytes}',
    },
    {
      label: 'Encode with \\x',
      input: 'hi CTF',
      options: { mode: 'encode', separator: 'x' },
      expect: '\\x68\\x69\\x20\\x43\\x54\\x46',
    },
    {
      label: 'Encode, spaced uppercase',
      input: 'flag{}',
      options: { mode: 'encode', separator: 'space', upper: true },
      expect: '66 6C 61 67 7B 7D',
    },
  ],
  detect({ text }) {
    const t = text?.trim() ?? '';
    if (t.length < 8 || t.length > 200000) return null;
    if (!/^(?:0x|\\x)?[0-9a-fA-F]{2}(?:[\s:,;-]*(?:0x|\\x)?[0-9a-fA-F]{2})*$/.test(t)) return null;
    try {
      const out = hexDecode(t);
      if (out.length < 4) return null;
      if (printableRatio(out) >= 0.9) {
        return {
          score: 0.88,
          options: { mode: 'decode' },
          reason: 'Hex digits that decode to text',
        };
      }
      return { score: 0.45, options: { mode: 'decode' }, reason: 'Only hex digits' };
    } catch {
      return null;
    }
  },
  run({ bytes }, { mode, separator, upper }) {
    if (mode === 'encode') return [{ type: 'text', value: hexEncode(bytes, separator, upper) }];
    return bytesResult(hexDecode(utf8Decode(bytes)));
  },
});
