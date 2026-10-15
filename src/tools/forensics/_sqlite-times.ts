/**
 * Browser history timestamps. Chrome stores microseconds since 1601-01-01 UTC ("WebKit time",
 * the same epoch as a Windows FILETIME), Firefox microseconds since 1970-01-01 UTC ("PRTime").
 * The values are read as text and converted with BigInt: a Chrome value is about 1.3e16, which a
 * double cannot hold to the microsecond. (The Timestamp tool has the same two epochs, "Chrome /
 * WebKit" and Unix microseconds; its conversion lives inside the tool, so the few lines are kept
 * here rather than reaching into another tool's file.)
 */

/** Microseconds from 1601-01-01 to 1970-01-01. */
export const WEBKIT_TO_UNIX_US = 11_644_473_600n * 1_000_000n;

function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== 0n && a < 0n !== b < 0n ? q - 1n : q;
}

/** ISO 8601 UTC with milliseconds, or null when the date cannot be represented. */
export function unixMicrosToIso(us: bigint): string | null {
  const ms = Number(floorDiv(us, 1000n));
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return null;
  return new Date(ms).toISOString();
}

/** Chrome / WebKit microseconds (text or number) to ISO UTC; 0 and garbage give null. */
export function webkitToIso(value: string | number | bigint | null): string | null {
  const us = toBig(value);
  return us === null || us === 0n ? null : unixMicrosToIso(us - WEBKIT_TO_UNIX_US);
}

/** Firefox PRTime microseconds (text or number) to ISO UTC; 0 and garbage give null. */
export function prtimeToIso(value: string | number | bigint | null): string | null {
  const us = toBig(value);
  return us === null || us === 0n ? null : unixMicrosToIso(us);
}

function toBig(value: string | number | bigint | null): bigint | null {
  if (value === null) return null;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? BigInt(Math.trunc(value)) : null;
  return /^-?\d{1,20}$/.test(value.trim()) ? BigInt(value.trim()) : null;
}
