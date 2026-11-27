// Generates the sample archives of the "ZipCrypto cracker" tool in public/samples/.
// Deterministic: run it again and the bytes are identical. Everything in them is made up (the
// texts, the "flags"); nothing here comes from a real challenge.
//
//   node scripts/gen-samples-zipcrypto-crack.mjs
//
// Files (all homemade; the ZipCrypto ones are encrypted with the password shown, which the cracker
// never needs — it recovers the internal keys from known plaintext):
//   zipcrack-stored.zip         two STORED entries, ZipCrypto, password "opensesame":
//                                 note.txt (a known public blurb, the known plaintext) and
//                                 flag.txt (FTF{zipcrypto_known_plaintext})
//   zipcrack-deflate.zip        two DEFLATE entries, ZipCrypto, password "deflate-me":
//                                 article.txt (known) and secret.txt (FTF{deflate_plaintext_archive})
//   zipcrack-deflate-plain.zip  the SAME article.txt, DEFLATE, NOT encrypted — the "plaintext
//                                 archive" the user zips locally to supply the known deflate stream
//   zipcrack-aes.zip            one WinZip-AES entry (method 99 + extra 0x9901): the cracker must
//                                 detect it and refuse (the attack does not apply to AES)
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const outDir = fileURLToPath(new URL('../public/samples/', import.meta.url));
mkdirSync(outDir, { recursive: true });

// ---------- CRC-32 (ZIP flavour) ----------
const CRC_TAB = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (b) => {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TAB[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const crcStep = (c, byte) => (CRC_TAB[(c ^ byte) & 0xff] ^ (c >>> 8)) >>> 0;

// ---------- ZipCrypto encryption (traditional PKWARE) ----------
function newKeys() {
  return { k0: 0x12345678, k1: 0x23456789, k2: 0x34567890 };
}
function update(s, p) {
  s.k0 = crcStep(s.k0, p);
  s.k1 = (Math.imul((s.k1 + (s.k0 & 0xff)) >>> 0, 134775813) + 1) >>> 0;
  s.k2 = crcStep(s.k2, s.k1 >>> 24);
}
function streamByte(k2) {
  const t = (k2 | 2) & 0xffff;
  return ((t * (t ^ 1)) >>> 8) & 0xff;
}
function keysFromPassword(pw) {
  const s = newKeys();
  for (const c of Buffer.from(pw, 'utf8')) update(s, c);
  return s;
}
/** Encrypt the compressed data: 12-byte header (last byte = top of CRC) then the data. */
function zipCryptoEncrypt(base, data, crc, rnd) {
  const header = Buffer.alloc(12);
  for (let i = 0; i < 11; i++) header[i] = rnd() & 0xff;
  header[11] = (crc >>> 24) & 0xff;
  const plain = Buffer.concat([header, Buffer.from(data)]);
  const s = { ...base };
  const out = Buffer.alloc(plain.length);
  for (let i = 0; i < plain.length; i++) {
    out[i] = plain[i] ^ streamByte(s.k2);
    update(s, plain[i]);
  }
  return out;
}

// Small deterministic PRNG for the header bytes (no Math.random → reproducible).
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s >>> 24;
  };
}

// ---------- minimal ZIP writer ----------
const u16 = (n) => Buffer.from([n & 0xff, (n >> 8) & 0xff]);
const u32 = (n) => Buffer.from([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);

/**
 * Build a ZIP. `entries` is a list of { name, data, method, encrypted, base, rnd, extra } where
 * `data` is already compressed (for method 8) and `crc`/`usize` describe the ORIGINAL bytes.
 */
function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    let stored = Buffer.from(e.data);
    const flags = e.encrypted ? 1 : 0;
    if (e.encrypted) stored = zipCryptoEncrypt(e.base, e.data, e.crc, e.rnd);
    const nameBuf = Buffer.from(e.name, 'utf8');
    const extra = e.extra ?? Buffer.alloc(0);
    const csize = stored.length;
    const local = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(flags),
      u16(e.method),
      u16(0),
      u16(0x21), // dos time/date (arbitrary, fixed)
      u32(e.crc),
      u32(csize),
      u32(e.usize),
      u16(nameBuf.length),
      u16(extra.length),
      nameBuf,
      extra,
      stored,
    ]);
    locals.push(local);
    centrals.push(
      Buffer.concat([
        u32(0x02014b50),
        u16(20),
        u16(20),
        u16(flags),
        u16(e.method),
        u16(0),
        u16(0x21),
        u32(e.crc),
        u32(csize),
        u32(e.usize),
        u16(nameBuf.length),
        u16(extra.length),
        u16(0), // comment len
        u16(0), // disk
        u16(0), // internal attrs
        u32(0), // external attrs
        u32(offset),
        nameBuf,
        extra,
      ]),
    );
    offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(cd.length),
    u32(offset),
    u16(0),
  ]);
  return Buffer.concat([...locals, cd, eocd]);
}

const enc = (s) => Buffer.from(s, 'utf8');
// Generous known plaintext (~3 KB): the attack is much faster the more contiguous known plaintext
// it has (12 bytes is the slow minimum), so the sample ships a long, obviously-public text.
const longText = (lead) => {
  let s = lead + '\n';
  for (let i = 0; i < 30; i++) {
    s +=
      `Line ${i}: this is public sample text for Find The Flag, present only to give the ` +
      `ZipCrypto cracker plenty of contiguous known plaintext. Nothing here is secret.\n`;
  }
  return enc(s);
};
const KNOWN_NOTE = longText('Public note shipped with the Find The Flag sample set.');
// For the DEFLATE sample the known plaintext is the COMPRESSED stream, so it must stay long after
// compression: use deterministic incompressible bytes (a fixed PRNG) so the deflate stream is large.
const KNOWN_ARTICLE = (() => {
  const g = rng(0xa11ce);
  const b = Buffer.alloc(3000);
  for (let i = 0; i < b.length; i++) b[i] = g() & 0xff;
  return b;
})();

// ---------- 1. STORED, ZipCrypto ----------
{
  const base = keysFromPassword('opensesame');
  const flag = enc('FTF{zipcrypto_known_plaintext}\n');
  const entries = [
    {
      name: 'note.txt',
      data: KNOWN_NOTE,
      method: 0,
      encrypted: true,
      base,
      rnd: rng(0x1111),
      crc: crc32(KNOWN_NOTE),
      usize: KNOWN_NOTE.length,
    },
    {
      name: 'flag.txt',
      data: flag,
      method: 0,
      encrypted: true,
      base,
      rnd: rng(0x2222),
      crc: crc32(flag),
      usize: flag.length,
    },
  ];
  writeFileSync(`${outDir}zipcrack-stored.zip`, buildZip(entries));
  // The known plaintext on its own, for the user to drop as the "known file".
  writeFileSync(`${outDir}zipcrack-note.txt`, KNOWN_NOTE);
}

// ---------- 2. DEFLATE, ZipCrypto ----------
{
  const base = keysFromPassword('deflate-me');
  const secret = enc('FTF{deflate_plaintext_archive}\n');
  const artComp = deflateRawSync(KNOWN_ARTICLE, { level: 6 });
  const secComp = deflateRawSync(secret, { level: 6 });
  const entries = [
    {
      name: 'article.txt',
      data: artComp,
      method: 8,
      encrypted: true,
      base,
      rnd: rng(0x3333),
      crc: crc32(KNOWN_ARTICLE),
      usize: KNOWN_ARTICLE.length,
    },
    {
      name: 'secret.txt',
      data: secComp,
      method: 8,
      encrypted: true,
      base,
      rnd: rng(0x4444),
      crc: crc32(secret),
      usize: secret.length,
    },
  ];
  writeFileSync(`${outDir}zipcrack-deflate.zip`, buildZip(entries));

  // The "plaintext archive": the SAME article.txt, DEFLATE, NOT encrypted (same compressor/level).
  const plain = [
    {
      name: 'article.txt',
      data: artComp,
      method: 8,
      encrypted: false,
      crc: crc32(KNOWN_ARTICLE),
      usize: KNOWN_ARTICLE.length,
    },
  ];
  writeFileSync(`${outDir}zipcrack-deflate-plain.zip`, buildZip(plain));
}

// ---------- 3. WinZip-AES (must be refused) ----------
{
  // method 99 + extra field 0x9901 (vendor "AE", strength 3 = AES-256, actual method 8).
  const aesExtra = Buffer.concat([
    u16(0x9901),
    u16(7), // data length
    u16(2), // AE-2
    Buffer.from('AE'),
    Buffer.from([3]), // strength: AES-256
    u16(8), // real compression method
  ]);
  const dummy = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  const entries = [
    {
      name: 'locked.txt',
      data: dummy,
      method: 99,
      encrypted: true,
      // not real AES bytes; the tool refuses before any decryption, so the data is never used.
      base: keysFromPassword('whatever'),
      rnd: rng(0x5555),
      crc: 0,
      usize: 32,
      extra: aesExtra,
    },
  ];
  writeFileSync(`${outDir}zipcrack-aes.zip`, buildZip(entries));
}

console.log(
  'wrote zipcrack-stored.zip, zipcrack-deflate.zip, zipcrack-deflate-plain.zip, zipcrack-aes.zip',
);
