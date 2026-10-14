import { ToolError } from '../core/errors';

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: false });

export const utf8Encode = (s: string): Uint8Array => enc.encode(s);
export const utf8Decode = (b: Uint8Array): string => dec.decode(b);

/** True if the bytes are valid UTF-8. */
export function isValidUtf8(b: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(b);
    return true;
  } catch {
    return false;
  }
}

/** One char per byte (ISO-8859-1). Never fails, round-trips with latin1Encode. */
export function latin1Decode(b: Uint8Array): string {
  let out = '';
  for (let i = 0; i < b.length; i += 0x8000) {
    out += String.fromCharCode(...b.subarray(i, i + 0x8000));
  }
  return out;
}

export function latin1Encode(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

export function toHex(b: Uint8Array, sep = ''): string {
  const parts = new Array<string>(b.length);
  for (let i = 0; i < b.length; i++) parts[i] = HEX[b[i]!]!;
  return parts.join(sep);
}

/** Lenient hex parser: accepts spaces, newlines, ':', ',', '0x' and '\x' prefixes. */
export function fromHex(s: string): Uint8Array {
  const clean = s.replace(/0x|\\x|[\s:,;-]/gi, '');
  if (!/^[0-9a-f]*$/i.test(clean)) {
    const bad = clean.match(/[^0-9a-f]/i)?.[0];
    throw new ToolError(`Not hex: unexpected character "${bad}".`);
  }
  if (clean.length % 2) throw new ToolError(`Odd number of hex digits (${clean.length}).`);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function toBase64(b: Uint8Array, alphabet = B64, pad = true): string {
  let out = '';
  let i = 0;
  for (; i + 2 < b.length; i += 3) {
    const n = (b[i]! << 16) | (b[i + 1]! << 8) | b[i + 2]!;
    out +=
      alphabet[n >> 18]! + alphabet[(n >> 12) & 63]! + alphabet[(n >> 6) & 63]! + alphabet[n & 63]!;
  }
  const rest = b.length - i;
  if (rest === 1) {
    const n = b[i]! << 16;
    out += alphabet[n >> 18]! + alphabet[(n >> 12) & 63]! + (pad ? '==' : '');
  } else if (rest === 2) {
    const n = (b[i]! << 16) | (b[i + 1]! << 8);
    out +=
      alphabet[n >> 18]! + alphabet[(n >> 12) & 63]! + alphabet[(n >> 6) & 63]! + (pad ? '=' : '');
  }
  return out;
}

/**
 * Lenient base64 decoder: ignores whitespace, accepts both standard and URL-safe alphabets,
 * missing padding is fine. Throws ToolError on any other character.
 */
export function fromBase64(s: string, alphabet = B64): Uint8Array {
  const map = new Int16Array(128).fill(-1);
  for (let i = 0; i < 64; i++) map[alphabet.charCodeAt(i)] = i;
  if (alphabet === B64) {
    map['-'.charCodeAt(0)] = 62;
    map['_'.charCodeAt(0)] = 63;
  }
  const clean = s.replace(/\s+/g, '').replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < clean.length; i++) {
    const c = clean.charCodeAt(i);
    const v = c < 128 ? map[c]! : -1;
    if (v < 0) throw new ToolError(`Not base64: "${clean[i]}" at position ${i}.`);
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, o);
}

/** Share of bytes that are printable ASCII or common whitespace. */
export function printableRatio(b: Uint8Array): number {
  if (b.length === 0) return 0;
  let n = 0;
  for (const x of b) if ((x >= 0x20 && x < 0x7f) || x === 9 || x === 10 || x === 13) n++;
  return n / b.length;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function bytesEqualAt(hay: Uint8Array, needle: ArrayLike<number>, offset = 0): boolean {
  if (offset + needle.length > hay.length) return false;
  for (let i = 0; i < needle.length; i++) if (hay[offset + i] !== needle[i]) return false;
  return true;
}

export function indexOfBytes(hay: Uint8Array, needle: ArrayLike<number>, from = 0): number {
  const first = needle[0];
  if (first === undefined) return -1;
  for (let i = from; i <= hay.length - needle.length; i++) {
    if (hay[i] === first && bytesEqualAt(hay, needle, i)) return i;
  }
  return -1;
}

export const u16le = (b: Uint8Array, o: number) => (b[o]! | (b[o + 1]! << 8)) >>> 0;
export const u16be = (b: Uint8Array, o: number) => ((b[o]! << 8) | b[o + 1]!) >>> 0;
export const u32le = (b: Uint8Array, o: number) =>
  (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
export const u32be = (b: Uint8Array, o: number) =>
  ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(2)} MiB`;
}
