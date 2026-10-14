// Generates the small forensics sample files in public/samples/. Deterministic: run it again
// and the bytes are identical. Only depends on fflate and fast-png.
//
//   node scripts/gen-samples-forensics.mjs
//
// Files:
//   forensics-polyglot.png   a valid PNG with a ZIP (flag.txt) glued after IEND
//   forensics-nested.zip     zip > inner.tar.gz > notes/flag.txt
//   forensics-zipcrypto.zip  ZipCrypto-encrypted flag.txt, password "infected"
//   forensics-strings.bin    non-printable noise hiding ASCII and UTF-16 strings
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { deflateSync, gzipSync, strToU8 } from 'fflate';
import { encode as encodePng } from 'fast-png';

const outDir = fileURLToPath(new URL('../public/samples/', import.meta.url));

// ---------- tiny helpers ----------

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crcStep = (crc, byte) => (CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)) >>> 0;
const crc32 = (bytes) => {
  let c = 0xffffffff;
  for (const x of bytes) c = crcStep(c, x);
  return (c ^ 0xffffffff) >>> 0;
};

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const le = (value, bytes) => {
  const out = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) out[i] = Math.floor(value / 2 ** (8 * i)) & 0xff;
  return out;
};

// ---------- ZipCrypto (traditional PKWARE encryption) ----------

function zipCryptoKeys(password) {
  const keys = [0x12345678, 0x23456789, 0x34567890];
  for (const c of strToU8(password)) updateKeys(keys, c);
  return keys;
}
function updateKeys(keys, byte) {
  keys[0] = crcStep(keys[0], byte);
  keys[1] = (Math.imul((keys[1] + (keys[0] & 0xff)) >>> 0, 134775813) + 1) >>> 0;
  keys[2] = crcStep(keys[2], keys[1] >>> 24);
}
function keystreamByte(keys) {
  const t = (keys[2] | 2) & 0xffff;
  return ((t * (t ^ 1)) >>> 8) & 0xff;
}
function zipCryptoEncrypt(plain, password) {
  const keys = zipCryptoKeys(password);
  const out = new Uint8Array(plain.length);
  for (let i = 0; i < plain.length; i++) {
    out[i] = plain[i] ^ keystreamByte(keys);
    updateKeys(keys, plain[i]);
  }
  return out;
}

// ---------- ZIP writer (fixed timestamps so the output is reproducible) ----------

const DOS_DATE = ((2024 - 1980) << 9) | (1 << 5) | 15; // 2024-01-15
const DOS_TIME = (12 << 11) | (30 << 5); // 12:30:00

/** entries: { name, data, method: 0 | 8, password?, comment? } */
function buildZip(entries, archiveComment = '') {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = strToU8(e.name);
    const crc = crc32(e.data);
    let payload = e.method === 8 ? deflateSync(e.data, { level: 9 }) : e.data;
    let flags = 0x0800; // UTF-8 names
    if (e.password) {
      // 12 header bytes: 11 reproducible filler bytes + the CRC check byte.
      const header = new Uint8Array(12);
      for (let i = 0; i < 11; i++) header[i] = (i * 73 + 41) & 0xff;
      header[11] = crc >>> 24;
      payload = zipCryptoEncrypt(concat(header, payload), e.password);
      flags |= 1;
    }
    const common = concat(
      le(flags, 2),
      le(e.method, 2),
      le(DOS_TIME, 2),
      le(DOS_DATE, 2),
      le(crc, 4),
      le(payload.length, 4),
      le(e.data.length, 4),
      le(name.length, 2),
    );
    const local = concat(le(0x04034b50, 4), le(20, 2), common, le(0, 2), name, payload);
    const comment = strToU8(e.comment ?? '');
    centrals.push(
      concat(
        le(0x02014b50, 4),
        le((3 << 8) | 20, 2),
        le(20, 2),
        common,
        le(0, 2),
        le(comment.length, 2),
        le(0, 2),
        le(0, 2),
        le(0o100644 << 16, 4),
        le(offset, 4),
        name,
        comment,
      ),
    );
    locals.push(local);
    offset += local.length;
  }
  const cd = concat(...centrals);
  const zipComment = strToU8(archiveComment);
  const eocd = concat(
    le(0x06054b50, 4),
    le(0, 2),
    le(0, 2),
    le(entries.length, 2),
    le(entries.length, 2),
    le(cd.length, 4),
    le(offset, 4),
    le(zipComment.length, 2),
    zipComment,
  );
  return concat(...locals, cd, eocd);
}

// ---------- TAR writer ----------

function tarEntry(name, data) {
  const header = new Uint8Array(512);
  const put = (text, at) => header.set(strToU8(text), at);
  put(name, 0);
  put('0000644\0', 100);
  put('0001750\0', 108);
  put('0001750\0', 116);
  put(data.length.toString(8).padStart(11, '0') + '\0', 124);
  put((1700000000).toString(8).padStart(11, '0') + '\0', 136);
  put('        ', 148); // checksum placeholder: eight spaces
  put('0', 156);
  put('ustar\0', 257);
  put('00', 263);
  put('ctf', 265);
  put('ctf', 297);
  let sum = 0;
  for (const x of header) sum += x;
  put(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  const padded = new Uint8Array(Math.ceil(data.length / 512) * 512);
  padded.set(data);
  return concat(header, padded);
}
const buildTar = (files) =>
  concat(...files.map(([name, data]) => tarEntry(name, data)), new Uint8Array(1024));

// ---------- samples ----------

function polyglotPng() {
  const width = 64;
  const height = 48;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      data[o] = x * 4;
      data[o + 1] = y * 5;
      data[o + 2] = 128 + ((x ^ y) & 31);
      data[o + 3] = 255;
    }
  }
  const png = encodePng({ width, height, data, depth: 8, channels: 4 });
  const zip = buildZip([{ name: 'flag.txt', data: strToU8('flag{binwalk_found_me}'), method: 8 }]);
  return concat(png, zip);
}

function nestedZip() {
  const tar = buildTar([['notes/flag.txt', strToU8('flag{matryoshka_archive}\n')]]);
  const tgz = gzipSync(tar, { level: 9, mtime: 0, filename: 'inner.tar' });
  return buildZip(
    [
      { name: 'readme.txt', data: strToU8('Keep digging.\n'), method: 8 },
      { name: 'inner.tar.gz', data: tgz, method: 0, comment: 'one more layer' },
    ],
    'layer 1 of 3',
  );
}

function zipCryptoZip() {
  return buildZip([
    {
      name: 'readme.txt',
      data: strToU8('The other file is locked. The password is what malware zips usually use.\n'),
      method: 8,
    },
    {
      name: 'flag.txt',
      data: strToU8('flag{zip_crypto}'),
      method: 8,
      password: 'infected',
    },
  ]);
}

function stringsBin() {
  const size = 3072;
  const out = new Uint8Array(size);
  // Noise made only of non-printable bytes, so every string below stands out and no
  // accidental ones appear. xorshift32 keeps it reproducible.
  let x = 0x2545f491;
  for (let i = 0; i < size; i++) {
    for (;;) {
      x ^= x << 13;
      x >>>= 0;
      x ^= x >>> 17;
      x ^= x << 5;
      x >>>= 0;
      const v = x & 0xff;
      const printable = (v >= 0x20 && v < 0x7f) || v === 0x09 || v === 0x0a || v === 0x0d;
      if (!printable) {
        out[i] = v;
        break;
      }
    }
  }
  const ascii = (text) => strToU8(text + '\0');
  const utf16le = (text) => {
    const b = new Uint8Array(text.length * 2 + 2);
    for (let i = 0; i < text.length; i++) b[i * 2] = text.charCodeAt(i);
    return b;
  };
  const utf16be = (text) => {
    const b = new Uint8Array(text.length * 2 + 2);
    for (let i = 0; i < text.length; i++) b[i * 2 + 1] = text.charCodeAt(i);
    return b;
  };
  out.set(ascii('GCC: (Ubuntu 11.4.0-1ubuntu1~22.04) 11.4.0'), 0x100);
  out.set(ascii('admin:hunter2'), 0x400);
  out.set(utf16le('flag{wide_strings_are_sneaky}'), 0x600);
  out.set(ascii('Usage: %s <password>'), 0x900);
  out.set(utf16be('Nothing to see here (big-endian)'), 0xb00);
  return out;
}

mkdirSync(outDir, { recursive: true });
const files = {
  'forensics-polyglot.png': polyglotPng(),
  'forensics-nested.zip': nestedZip(),
  'forensics-zipcrypto.zip': zipCryptoZip(),
  'forensics-strings.bin': stringsBin(),
};
for (const [name, bytes] of Object.entries(files)) {
  writeFileSync(outDir + name, bytes);
  console.log(`${name}  ${bytes.length} bytes`);
}
