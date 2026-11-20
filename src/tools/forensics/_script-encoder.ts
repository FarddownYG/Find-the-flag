/**
 * Microsoft Script Encoder (the `#@~^…^#~@` format produced by screnc.exe) decoder, for the
 * JScript.Encode and VBScript.Encode that still turn up in old pages, HTAs and malware. The format
 * is reversible with fixed tables: a header carries the decoded length and a trailing checksum,
 * the body is a per-character substitution whose column rotates through a 64-entry pick order, and
 * `@`-escapes stand in for the characters the container would otherwise choke on (`< > @` and the
 * CR/LF). Everything runs locally on the text the user pastes.
 *
 * Tables from the public-domain reference (virtualconspiracy "breaking screnc"); verified here by a
 * round-trip test and against a real encoded script.
 */
import { fromBase64 } from '../../lib/bytes';

/** Each entry is [plain char code, encoded byte for column 0, 1, 2]. `< > @` are escape-only. */
const ENTRIES: readonly [number, number, number, number][] = [
  [9, 0x64, 0x37, 0x69],
  [32, 0x50, 0x7e, 0x2c],
  [33, 0x22, 0x5a, 0x65],
  [34, 0x4a, 0x45, 0x72],
  [35, 0x61, 0x3a, 0x5b],
  [36, 0x5e, 0x79, 0x66],
  [37, 0x5d, 0x59, 0x75],
  [38, 0x5b, 0x27, 0x4c],
  [39, 0x42, 0x76, 0x45],
  [40, 0x60, 0x63, 0x76],
  [41, 0x23, 0x62, 0x2a],
  [42, 0x65, 0x4d, 0x43],
  [43, 0x5f, 0x51, 0x33],
  [44, 0x7e, 0x53, 0x42],
  [45, 0x4f, 0x52, 0x20],
  [46, 0x52, 0x20, 0x63],
  [47, 0x7a, 0x26, 0x4a],
  [48, 0x21, 0x54, 0x5a],
  [49, 0x46, 0x71, 0x38],
  [50, 0x20, 0x2b, 0x79],
  [51, 0x26, 0x66, 0x32],
  [52, 0x63, 0x2a, 0x57],
  [53, 0x2a, 0x58, 0x6c],
  [54, 0x76, 0x7f, 0x2b],
  [55, 0x47, 0x7b, 0x46],
  [56, 0x25, 0x30, 0x52],
  [57, 0x2c, 0x31, 0x4f],
  [58, 0x29, 0x6c, 0x3d],
  [59, 0x69, 0x49, 0x70],
  [61, 0x27, 0x78, 0x7b],
  [63, 0x67, 0x5f, 0x51],
  [65, 0x62, 0x29, 0x7a],
  [66, 0x41, 0x24, 0x7e],
  [67, 0x5a, 0x2f, 0x3b],
  [68, 0x66, 0x39, 0x47],
  [69, 0x32, 0x33, 0x41],
  [70, 0x73, 0x6f, 0x77],
  [71, 0x4d, 0x21, 0x56],
  [72, 0x43, 0x75, 0x5f],
  [73, 0x71, 0x28, 0x26],
  [74, 0x39, 0x42, 0x78],
  [75, 0x7c, 0x46, 0x6e],
  [76, 0x53, 0x4a, 0x64],
  [77, 0x48, 0x5c, 0x74],
  [78, 0x31, 0x48, 0x67],
  [79, 0x72, 0x36, 0x7d],
  [80, 0x6e, 0x4b, 0x68],
  [81, 0x70, 0x7d, 0x35],
  [82, 0x49, 0x5d, 0x22],
  [83, 0x3f, 0x6a, 0x55],
  [84, 0x4b, 0x50, 0x3a],
  [85, 0x6a, 0x69, 0x60],
  [86, 0x2e, 0x23, 0x6a],
  [87, 0x7f, 0x09, 0x71],
  [88, 0x28, 0x70, 0x6f],
  [89, 0x35, 0x65, 0x49],
  [90, 0x7d, 0x74, 0x5c],
  [91, 0x24, 0x2c, 0x5d],
  [92, 0x2d, 0x77, 0x27],
  [93, 0x54, 0x44, 0x59],
  [94, 0x37, 0x3f, 0x25],
  [95, 0x7b, 0x6d, 0x7c],
  [96, 0x3d, 0x7c, 0x23],
  [97, 0x6c, 0x43, 0x6d],
  [98, 0x34, 0x38, 0x28],
  [99, 0x6d, 0x5e, 0x31],
  [100, 0x4e, 0x5b, 0x39],
  [101, 0x2b, 0x6e, 0x7f],
  [102, 0x30, 0x57, 0x36],
  [103, 0x6f, 0x4c, 0x54],
  [104, 0x74, 0x34, 0x34],
  [105, 0x6b, 0x72, 0x62],
  [106, 0x4c, 0x25, 0x4e],
  [107, 0x33, 0x56, 0x30],
  [108, 0x56, 0x73, 0x5e],
  [109, 0x3a, 0x68, 0x73],
  [110, 0x78, 0x55, 0x09],
  [111, 0x57, 0x47, 0x4b],
  [112, 0x77, 0x32, 0x61],
  [113, 0x3b, 0x35, 0x24],
  [114, 0x44, 0x2e, 0x4d],
  [115, 0x2f, 0x64, 0x6b],
  [116, 0x59, 0x4f, 0x44],
  [117, 0x45, 0x3b, 0x21],
  [118, 0x5c, 0x2d, 0x37],
  [119, 0x68, 0x41, 0x53],
  [120, 0x36, 0x61, 0x58],
  [121, 0x58, 0x7a, 0x48],
  [122, 0x79, 0x22, 0x2e],
  [123, 0x09, 0x60, 0x50],
  [124, 0x75, 0x6b, 0x2d],
  [125, 0x38, 0x4e, 0x29],
  [126, 0x55, 0x3d, 0x3f],
];

/** Which of the three columns to use for the Nth decoded character (index N mod 64). */
const PICK = [
  1, 2, 0, 1, 2, 0, 2, 0, 0, 2, 0, 2, 1, 0, 2, 0, 1, 0, 2, 0, 1, 1, 2, 0, 0, 2, 1, 0, 2, 0, 0, 2, 1,
  1, 0, 2, 0, 2, 0, 1, 0, 1, 1, 2, 0, 1, 0, 2, 1, 0, 2, 0, 1, 1, 2, 0, 0, 1, 1, 2, 0, 1, 0, 2,
];

/** decode[column][encodedByte] = plain char code, or -1 when that byte is not used in that column. */
const DECODE: Int16Array[] = [0, 1, 2].map((col) => {
  const t = new Int16Array(128).fill(-1);
  for (const e of ENTRIES) t[e[col + 1]!] = e[0]!;
  return t;
});

const ESCAPE: Record<string, string> = { '#': '\r', '&': '\n', '!': '<', '*': '>', $: '@' };

export type Checksum = 'ok' | 'bad' | 'unknown';
export interface ScriptBlock {
  /** The decoded script text. */
  script: string;
  /** Decoded length declared in the header. */
  length: number;
  /** Whether the trailing checksum matched the decoded bytes. */
  checksum: Checksum;
  /** The input ran out before the declared length (the block is cut off). */
  truncated: boolean;
}

/** A 32-bit little-endian integer from an 8-character base64 field; null if it will not parse. */
function u32le(b64: string): number | null {
  if (!/^[A-Za-z0-9+/]{6}==$/.test(b64)) return null;
  try {
    const b = fromBase64(b64);
    return b.length >= 4 ? (b[0]! | (b[1]! << 8) | (b[2]! << 16) | (b[3]! << 24)) >>> 0 : null;
  } catch {
    return null;
  }
}

/** Decode one `#@~^…^#~@` block that starts at `start`; null if the header is not usable. */
function decodeOne(input: string, start: number): { block: ScriptBlock; end: number } | null {
  const length = u32le(input.slice(start + 4, start + 12));
  if (length === null || length > input.length) return null;
  let i = start + 12;
  let out = '';
  let sum = 0;
  let truncated = false;
  for (let n = 0; n < length; n++) {
    if (i >= input.length) {
      truncated = true;
      break;
    }
    let ch = input[i++]!;
    if (ch === '@') {
      const next = input[i++];
      if (next === undefined) {
        truncated = true;
        break;
      }
      const e = ESCAPE[next];
      if (e === undefined) {
        // The header was valid but the body is corrupt here: keep what decoded, stop.
        truncated = true;
        break;
      }
      ch = e;
    } else {
      const code = ch.charCodeAt(0);
      const plain = code < 128 ? DECODE[PICK[n % 64]!]![code]! : -1;
      if (plain >= 0) ch = String.fromCharCode(plain);
    }
    sum = (sum + ch.charCodeAt(0)) >>> 0;
    out += ch;
  }
  const want = truncated ? null : u32le(input.slice(i, i + 8));
  const checksum: Checksum = want === null ? 'unknown' : want === sum ? 'ok' : 'bad';
  let end = i + 8;
  if (input.startsWith('^#~@', end)) end += 4;
  else if (!truncated) end = i; // trailer not where expected; resume scanning after the body
  return { block: { script: out, length, checksum, truncated }, end };
}

/** Decode every Script Encoder block found in the text (a page may hold several). */
export function decodeScriptEncoder(input: string): ScriptBlock[] {
  const blocks: ScriptBlock[] = [];
  let idx = 0;
  while (blocks.length < 64) {
    const start = input.indexOf('#@~^', idx);
    if (start < 0) break;
    const r = decodeOne(input, start);
    if (r) {
      blocks.push(r.block);
      idx = r.end;
    } else {
      idx = start + 4;
    }
  }
  return blocks;
}

/** Cheap check: does the text contain an encoded block at all? */
export const hasScriptEncoder = (s: string): boolean => s.includes('#@~^') && s.includes('^#~@');
