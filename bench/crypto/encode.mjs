// Independent reference encoders (public standards only): RFC 4648 base64/base32/base16, ROT13.
const A32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
export const hex = (s) => Buffer.from(s, 'utf8').toString('hex');

export function base32(s) {
  const buf = Buffer.from(s, 'utf8');
  let bits = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  while (bits.length % 5) bits += '0';
  let out = '';
  for (let i = 0; i < bits.length; i += 5) out += A32[parseInt(bits.slice(i, i + 5), 2)];
  while (out.length % 8) out += '=';
  return out;
}

export function rot13(s) {
  return s.replace(/[A-Za-z]/g, (c) => {
    const base = c <= 'Z' ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
  });
}

export const case1 = (f) => b64(f);
export const case2 = (f) => hex(f);
export const case3 = (f) => b64(b64(f));
export const case4 = (f) => base32(f);
export const case5 = (f) => hex(b64(f));
export const case6 = (f) => rot13(f);
