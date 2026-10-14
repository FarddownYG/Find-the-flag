import { defineTool, toggle } from '../../core/define';
import { ToolError } from '../../core/errors';
import { printableRatio, utf8Decode } from '../../lib/bytes';
import { bytesResult, showChar } from './_common';

/**
 * Bytes as a string of 0 and 1. Each byte is padded to `width` bits (8, or 7 for plain ASCII).
 * `separator` joins the groups ('' = one long string).
 */
export function binaryEncode(bytes: Uint8Array, width: 7 | 8 = 8, separator = ' '): string {
  const groups = new Array<string>(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    if (width === 7 && b > 127) {
      throw new ToolError(
        `Byte ${i + 1} is ${b} (0x${b.toString(16)}), which does not fit in 7 bits. Use 8 bits per group, or restrict the text to ASCII.`,
      );
    }
    groups[i] = b.toString(2).padStart(width, '0');
  }
  return groups.join(separator);
}

/**
 * Accepts groups separated by whitespace / commas, or one unbroken string, with optional 0b
 * prefixes.
 *  - several groups of up to 8 digits: each group is one byte (so 7-bit groups work);
 *  - groups of equal length under 7 (nibbles, single bits): joined, then cut by `width`;
 *  - anything else: all digits joined and cut into `width` bits (the other width if that fits).
 */
export function binaryDecode(text: string, width: 7 | 8 = 8): Uint8Array {
  const cleaned = text.replace(/0b(?=[01])/gi, ' ');
  const bad = cleaned.match(/[^01\s,;|]/);
  if (bad) {
    throw new ToolError(
      `Not binary: unexpected character "${showChar(bad[0])}" at position ${bad.index! + 1}. Only 0, 1 and separators are allowed.`,
    );
  }
  const groups = cleaned.split(/[\s,;|]+/).filter(Boolean);
  if (groups.length === 0) return new Uint8Array();

  const maxLen = Math.max(...groups.map((g) => g.length));
  const head = groups.slice(0, -1);
  const uniform = head.every((g) => g.length === groups[0]!.length);
  const tiny =
    groups[0]!.length < 7 && uniform && groups[groups.length - 1]!.length <= groups[0]!.length;
  if (groups.length > 1 && maxLen <= 8 && !tiny) {
    return Uint8Array.from(groups, (g) => parseInt(g, 2));
  }

  const bits = groups.join('');
  const other = width === 8 ? 7 : 8;
  const use = bits.length % width === 0 ? width : bits.length % other === 0 ? other : 0;
  if (!use) {
    throw new ToolError(
      `${bits.length} binary digits is not a multiple of 8 (or 7). Some digits are missing or extra — check the start and end.`,
    );
  }
  const out = new Uint8Array(bits.length / use);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(bits.slice(i * use, (i + 1) * use), 2);
  return out;
}

export default defineTool({
  id: 'binary',
  name: 'Binary (0/1)',
  category: 'encoding',
  description: 'Convert text or bytes to a string of 0 and 1 and back (8-bit or 7-bit groups).',
  tags: ['bits', 'base2', 'base-2', 'ascii binary', '01', 'From Binary', 'To Binary'],
  input: 'bytes',
  placeholder: '01100110 01101100 01100001 01100111',
  live: true,
  options: {
    mode: toggle('Mode', ['decode', 'encode']),
    width: toggle('Bits per character', ['8', '7']),
    separator: toggle(
      'Groups',
      [
        { value: 'space', label: 'Separated' },
        { value: 'none', label: 'One string' },
      ],
      'space',
      { showIf: (v) => v.mode === 'encode' },
    ),
  },
  examples: [
    {
      label: 'Decode a flag',
      input:
        '01100110 01101100 01100001 01100111 01111011 01100010 01101001 01101110 01100001 01110010 01111001 01011111 01101001 01110011 01011111 01100010 01101001 01110100 01110011 01111101',
      expect: 'flag{binary_is_bits}',
    },
    {
      label: 'No spaces',
      input:
        '0110011001101100011000010110011101111011011000100110100101101110011000010111001001111001010111110110100101110011010111110110001001101001011101000111001101111101',
      expect: 'flag{binary_is_bits}',
    },
    {
      label: '7-bit groups',
      input:
        '1100110 1101100 1100001 1100111 1111011 1100010 1101001 1101110 1100001 1110010 1111001 1011111 1101001 1110011 1011111 1100010 1101001 1110100 1110011 1111101',
      options: { width: '7' },
      expect: 'flag{binary_is_bits}',
    },
    {
      label: 'Encode text',
      input: 'Hi',
      options: { mode: 'encode' },
      expect: '01001000 01101001',
    },
  ],
  detect({ text }) {
    const t = text?.trim() ?? '';
    if (!/^(?:0b)?[01](?:[\s,;|]*(?:0b)?[01])*$/.test(t)) return null;
    const digits = t.replace(/[^01]/g, '').length;
    if (digits < 8) return null;
    try {
      const out = binaryDecode(t);
      if (printableRatio(out) >= 0.9) {
        return { score: 0.9, options: { mode: 'decode' }, reason: 'Only 0 and 1, decodes to text' };
      }
      return { score: 0.55, options: { mode: 'decode' }, reason: 'Only 0 and 1' };
    } catch {
      return { score: 0.35, options: { mode: 'decode' }, reason: 'Only 0 and 1 (length odd)' };
    }
  },
  run({ bytes }, { mode, width, separator }) {
    const w = width === '7' ? 7 : 8;
    if (mode === 'encode') {
      return [{ type: 'text', value: binaryEncode(bytes, w, separator === 'space' ? ' ' : '') }];
    }
    return bytesResult(binaryDecode(utf8Decode(bytes), w));
  },
});
