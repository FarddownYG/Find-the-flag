/** RC4 (ARCFOUR), checked against the RFC 6229 vectors. Obsolete stream cipher, kept for CTFs. */
export function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  if (key.length < 1 || key.length > 256) throw new RangeError('RC4 needs a 1 to 256 byte key');
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i]! + key[i % key.length]!) & 0xff;
    [s[i], s[j]] = [s[j]!, s[i]!];
  }
  const out = new Uint8Array(data.length);
  let a = 0;
  let b = 0;
  for (let n = 0; n < data.length; n++) {
    a = (a + 1) & 0xff;
    b = (b + s[a]!) & 0xff;
    [s[a], s[b]] = [s[b]!, s[a]!];
    out[n] = data[n]! ^ s[(s[a]! + s[b]!) & 0xff]!;
  }
  return out;
}
