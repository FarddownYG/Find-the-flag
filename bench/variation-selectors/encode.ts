// Independent reference encoder for the "variation selector" byte-smuggling scheme (public spec):
// byte 0-15 -> U+FE00 + byte, byte 16-255 -> U+E0100 + (byte - 16), appended after a visible base char.
export function byteToVs(byte: number): string {
  if (!Number.isInteger(byte) || byte < 0 || byte > 255)
    throw new RangeError(`not a byte: ${byte}`);
  return String.fromCodePoint(byte < 16 ? 0xfe00 + byte : 0xe0100 + (byte - 16));
}

export function encodeVs(base: string, payload: Uint8Array | string): string {
  const bytes = typeof payload === 'string' ? new TextEncoder().encode(payload) : payload;
  return base + Array.from(bytes, byteToVs).join('');
}

export function decodeVs(text: string): Uint8Array {
  const out: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= 0xfe00 && cp <= 0xfe0f) out.push(cp - 0xfe00);
    else if (cp >= 0xe0100 && cp <= 0xe01ef) out.push(cp - 0xe0100 + 16);
  }
  return Uint8Array.from(out);
}
