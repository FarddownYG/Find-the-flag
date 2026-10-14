import { ToolError } from '../../core/errors';
import { showChar } from './_common';

/**
 * Big-integer base conversion shared by Base58 and Base62: the bytes are one big-endian
 * number, each leading 0x00 byte becomes one leading "zero digit" (so binary round-trips).
 * BigInt does the heavy lifting; digits are processed in chunks that stay below 2^52.
 */

const chunkSize = (radix: number) => Math.max(1, Math.floor(52 / Math.log2(radix)));

export function bigBaseEncode(bytes: Uint8Array, alphabet: string): string {
  const radix = alphabet.length;
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const lead = alphabet[0]!.repeat(zeros);
  if (zeros === bytes.length) return lead;

  let hex = '';
  for (let i = zeros; i < bytes.length; i++) hex += bytes[i]!.toString(16).padStart(2, '0');
  let n = BigInt(`0x${hex}`);

  const k = chunkSize(radix);
  const divisor = BigInt(radix) ** BigInt(k);
  const digits: string[] = []; // least significant first
  while (n > 0n) {
    let rem = Number(n % divisor);
    n /= divisor;
    for (let i = 0; i < k; i++) {
      digits.push(alphabet[rem % radix]!);
      rem = Math.floor(rem / radix);
    }
  }
  while (digits.length && digits[digits.length - 1] === alphabet[0]) digits.pop();
  return lead + digits.reverse().join('');
}

/** `name` is only used in error messages ("Not Base58: ..."). Whitespace is ignored. */
export function bigBaseDecode(text: string, alphabet: string, name: string): Uint8Array {
  const radix = alphabet.length;
  const clean = text.replace(/\s+/g, '');
  const index = new Map<string, number>();
  for (let i = 0; i < radix; i++) index.set(alphabet[i]!, i);

  const values = new Array<number>(clean.length);
  for (let i = 0; i < clean.length; i++) {
    const v = index.get(clean[i]!);
    if (v === undefined) {
      throw new ToolError(
        `Not ${name}: "${showChar(clean[i])}" at position ${i + 1} is not in the alphabet.`,
      );
    }
    values[i] = v;
  }

  let zeros = 0;
  while (zeros < values.length && values[zeros] === 0) zeros++;
  if (zeros === values.length) return new Uint8Array(zeros);

  const k = chunkSize(radix);
  const big = BigInt(radix);
  const full = big ** BigInt(k);
  let n = 0n;
  for (let i = zeros; i < values.length; i += k) {
    const end = Math.min(i + k, values.length);
    let chunk = 0;
    for (let j = i; j < end; j++) chunk = chunk * radix + values[j]!;
    n = n * (end - i === k ? full : big ** BigInt(end - i)) + BigInt(chunk);
  }

  let hex = n.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const out = new Uint8Array(zeros + hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) out[zeros + i / 2] = parseInt(hex.slice(i, i + 2), 16);
  return out;
}
