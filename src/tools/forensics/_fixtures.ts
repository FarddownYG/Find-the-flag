/**
 * Builders for real (structurally valid) files, used by the forensics tests.
 * Not a tool: files starting with "_" are ignored by the registry and nothing in the app imports it.
 */
import { encode as encodePng } from 'fast-png';
import { deflateSync, strToU8 } from 'fflate';
import { concatBytes } from '../../lib/bytes';
import { crc32 } from '../../lib/signatures';

/** Little-endian integer of `bytes` bytes. */
export function le(value: number, bytes: number): Uint8Array {
  const out = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) out[i] = Math.floor(value / 2 ** (8 * i)) & 0xff;
  return out;
}
export function be(value: number, bytes: number): Uint8Array {
  return le(value, bytes).reverse();
}

/** Deterministic noise (xorshift32). `printable: false` avoids bytes that strings would pick up. */
export function noise(length: number, seed = 0x2545f491, printable = true): Uint8Array {
  const out = new Uint8Array(length);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < length; i++) {
    for (;;) {
      x ^= x << 13;
      x >>>= 0;
      x ^= x >>> 17;
      x ^= x << 5;
      x >>>= 0;
      const v = x & 0xff;
      if (printable || !((v >= 0x20 && v < 0x7f) || v === 9 || v === 10 || v === 13)) {
        out[i] = v;
        break;
      }
    }
  }
  return out;
}

export function buildPng(width = 16, height = 8): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i++) data[i] = (i * 37) & 0xff;
  return encodePng({ width, height, data, depth: 8, channels: 4 });
}

/** The classic 1x1 GIF89a. */
export function buildGif(): Uint8Array {
  return Uint8Array.from([
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00,
    0xff, 0xff, 0xff, 0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b,
  ]);
}

const seg = (marker: number, payload: Uint8Array) =>
  concatBytes(Uint8Array.of(0xff, marker), be(payload.length + 2, 2), payload);

/**
 * A JPEG with real marker structure (JFIF, DQT, SOF0, DHT, two scans with byte stuffing and a
 * restart marker). The entropy-coded bytes are not a real image, which no parser here decodes.
 * `thumbnail` puts a complete smaller JPEG inside an APP1 segment, like EXIF does.
 */
export function buildJpeg(thumbnail?: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [
    Uint8Array.of(0xff, 0xd8),
    seg(0xe0, Uint8Array.of(0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0)),
  ];
  if (thumbnail) parts.push(seg(0xe1, concatBytes(strToU8('Exif\0\0'), thumbnail)));
  parts.push(
    seg(0xdb, concatBytes(Uint8Array.of(0), new Uint8Array(64).fill(8))),
    seg(0xc0, Uint8Array.of(8, 0, 8, 0, 8, 1, 1, 0x11, 0)),
    seg(
      0xc4,
      concatBytes(
        Uint8Array.of(0),
        Uint8Array.of(0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0),
        Uint8Array.of(0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11),
      ),
    ),
    seg(0xda, Uint8Array.of(1, 1, 0, 0, 0x3f, 0)),
    // entropy data: stuffed 0xFF00, a restart marker FFD0, then more data
    Uint8Array.of(0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0xff, 0x00, 0x78),
    seg(0xda, Uint8Array.of(1, 1, 0, 0, 0x3f, 0)),
    Uint8Array.of(0x9a, 0xbc, 0xff, 0x00, 0xde),
    Uint8Array.of(0xff, 0xd9),
  );
  return concatBytes(...parts);
}

export function buildBmp(): Uint8Array {
  const pixels = new Uint8Array(16).fill(0x7f); // 2x2, 24-bit, rows padded to 8 bytes
  const dib = concatBytes(
    le(40, 4),
    le(2, 4),
    le(2, 4),
    le(1, 2),
    le(24, 2),
    le(0, 4),
    le(16, 4),
    le(2835, 4),
    le(2835, 4),
    le(0, 4),
    le(0, 4),
  );
  const total = 14 + dib.length + pixels.length;
  return concatBytes(strToU8('BM'), le(total, 4), le(0, 4), le(14 + dib.length, 4), dib, pixels);
}

export function buildWav(samples = 64): Uint8Array {
  const data = new Uint8Array(samples * 2).fill(3);
  const fmt = concatBytes(le(1, 2), le(1, 2), le(8000, 4), le(16000, 4), le(2, 2), le(16, 2));
  const body = concatBytes(
    strToU8('WAVE'),
    strToU8('fmt '),
    le(16, 4),
    fmt,
    strToU8('data'),
    le(data.length, 4),
    data,
  );
  return concatBytes(strToU8('RIFF'), le(body.length, 4), body);
}

/** 64-bit little-endian ELF: one PT_LOAD segment and three section headers at the end. */
export function buildElf64(): Uint8Array {
  const out = new Uint8Array(0x3c0);
  out.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]);
  out.set(le(3, 2), 16); // ET_DYN
  out.set(le(0x3e, 2), 18);
  out.set(le(1, 4), 20);
  out.set(le(64, 8), 32); // e_phoff
  out.set(le(0x300, 8), 40); // e_shoff
  out.set(le(64, 2), 52);
  out.set(le(56, 2), 54);
  out.set(le(1, 2), 56); // e_phnum
  out.set(le(64, 2), 58);
  out.set(le(3, 2), 60); // e_shnum
  // program header: PT_LOAD, offset 0, filesz 0x2f0
  out.set(le(1, 4), 64);
  out.set(le(0, 8), 64 + 8);
  out.set(le(0x2f0, 8), 64 + 32);
  // section 1: PROGBITS at 0x100 size 0x80; section 2: NOBITS (ignored)
  out.set(le(1, 4), 0x300 + 64 + 4);
  out.set(le(0x100, 8), 0x300 + 64 + 24);
  out.set(le(0x80, 8), 0x300 + 64 + 32);
  out.set(le(8, 4), 0x300 + 128 + 4);
  out.set(le(0x10000, 8), 0x300 + 128 + 32);
  return out;
}

/** PE32+ with two sections; the file ends at the end of the last one. */
export function buildPe(): Uint8Array {
  const out = new Uint8Array(0x500);
  out.set(strToU8('MZ'));
  out.set(le(0x80, 4), 0x3c);
  out.set(strToU8('PE\0\0'), 0x80);
  out.set(le(0x8664, 2), 0x84);
  out.set(le(2, 2), 0x86); // sections
  out.set(le(0xf0, 2), 0x94); // size of optional header
  const opt = 0x98;
  out.set(le(0x20b, 2), opt);
  out.set(le(0x200, 4), opt + 60); // size of headers
  out.set(le(16, 4), opt + 108);
  const table = opt + 0xf0;
  out.set(strToU8('.text'), table);
  out.set(le(0x200, 4), table + 16);
  out.set(le(0x200, 4), table + 20);
  out.set(strToU8('.data'), table + 40);
  out.set(le(0x100, 4), table + 40 + 16);
  out.set(le(0x400, 4), table + 40 + 20);
  return out;
}

export function build7z(): Uint8Array {
  const packed = new Uint8Array(16).fill(0x5a);
  const nextHeader = new Uint8Array(8).fill(0x01);
  const start = concatBytes(
    le(packed.length, 8),
    le(nextHeader.length, 8),
    le(crc32(nextHeader), 4),
  );
  return concatBytes(
    Uint8Array.of(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4),
    le(crc32(start), 4),
    start,
    packed,
    nextHeader,
  );
}

export function buildSqlite(pages = 3, pageSize = 4096): Uint8Array {
  const out = new Uint8Array(pages * pageSize);
  out.set(strToU8('SQLite format 3\0'));
  out.set(be(pageSize === 65536 ? 1 : pageSize, 2), 16);
  out.set([1, 1, 0, 64, 32, 32], 18);
  out.set(be(5, 4), 24); // file change counter
  out.set(be(pages, 4), 28); // size in pages
  out.set(be(1, 4), 56); // UTF-8
  out.set(be(5, 4), 92); // version-valid-for
  return out;
}

export function buildPdf(updates = 1): Uint8Array {
  let text = '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n';
  for (let i = 0; i < updates; i++)
    text += `2 0 obj\n<< /Update ${i} >>\nendobj\ntrailer\n<< >>\n%%EOF\n`;
  return strToU8(text);
}

// ---------- TAR ----------

export function tarEntry(name: string, data: Uint8Array, type = '0'): Uint8Array {
  const header = new Uint8Array(512);
  const put = (text: string, at: number) => header.set(strToU8(text), at);
  put(name, 0);
  put('0000644\0', 100);
  put('0001750\0', 108);
  put('0001750\0', 116);
  put(data.length.toString(8).padStart(11, '0') + '\0', 124);
  put((1700000000).toString(8).padStart(11, '0') + '\0', 136);
  put('        ', 148);
  put(type, 156);
  put('ustar\0', 257);
  put('00', 263);
  put('user', 265);
  put('group', 297);
  let sum = 0;
  for (const x of header) sum += x;
  put(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  const padded = new Uint8Array(Math.ceil(data.length / 512) * 512);
  padded.set(data);
  return concatBytes(header, padded);
}

export function buildTar(files: [string, Uint8Array][]): Uint8Array {
  return concatBytes(...files.map(([n, d]) => tarEntry(n, d)), new Uint8Array(1024));
}

// ---------- ZIP ----------

export interface ZipEntrySpec {
  name: string;
  data: Uint8Array;
  method?: 0 | 8;
  comment?: string;
  /** Write the sizes after the data (general purpose flag bit 3), like streaming writers do. */
  streaming?: boolean;
  /** Extra field bytes for the local and central records. */
  extra?: Uint8Array;
  /** Pretend the entry uses WinZip AES (method 99): content is just noise. */
  aes?: boolean;
  /** Raw name bytes, instead of the UTF-8 of `name` (to test code page 437 names). */
  rawName?: Uint8Array;
  /** Set the UTF-8 name flag (default true); false writes names the legacy way. */
  utf8?: boolean;
  /** Unix file mode in the external attributes (default regular file 0644). */
  unixMode?: number;
  /** Bytes written right after this entry, before the next one: data that belongs to no entry. */
  trailer?: Uint8Array;
  /** ZipCrypto: receives the compressed data and CRC, returns header + encrypted data. */
  encrypt?: (payload: Uint8Array, crc: number) => Uint8Array;
}

export function buildZip(entries: ZipEntrySpec[], comment = ''): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  const dosTime = (12 << 11) | (30 << 5);
  const dosDate = ((2024 - 1980) << 9) | (1 << 5) | 15;
  for (const e of entries) {
    const name = e.rawName ?? strToU8(e.name);
    const crc = crc32(e.data);
    let method: number = e.method ?? 8;
    let payload = method === 8 ? deflateSync(e.data) : e.data;
    let flags = e.utf8 === false ? 0 : 0x0800;
    if (e.encrypt) {
      payload = e.encrypt(payload, crc);
      flags |= 1;
    }
    if (e.aes) {
      method = 99;
      flags |= 1;
      payload = noise(e.data.length + 18, 7);
    }
    if (e.streaming) flags |= 8;
    const extra = e.extra ?? new Uint8Array(0);
    const sizes = e.streaming
      ? concatBytes(le(0, 4), le(0, 4), le(0, 4))
      : concatBytes(le(crc, 4), le(payload.length, 4), le(e.data.length, 4));
    const local = concatBytes(
      le(0x04034b50, 4),
      le(20, 2),
      le(flags, 2),
      le(method, 2),
      le(dosTime, 2),
      le(dosDate, 2),
      sizes,
      le(name.length, 2),
      le(extra.length, 2),
      name,
      extra,
      payload,
      e.streaming
        ? concatBytes(le(0x08074b50, 4), le(crc, 4), le(payload.length, 4), le(e.data.length, 4))
        : new Uint8Array(0),
      e.trailer ?? new Uint8Array(0),
    );
    const note = strToU8(e.comment ?? '');
    centrals.push(
      concatBytes(
        le(0x02014b50, 4),
        le((3 << 8) | 20, 2),
        le(20, 2),
        le(flags, 2),
        le(method, 2),
        le(dosTime, 2),
        le(dosDate, 2),
        le(crc, 4),
        le(payload.length, 4),
        le(e.data.length, 4),
        le(name.length, 2),
        le(extra.length, 2),
        le(note.length, 2),
        le(0, 2),
        le(0, 2),
        le((e.unixMode ?? 0o100644) * 65536, 4),
        le(offset, 4),
        name,
        extra,
        note,
      ),
    );
    locals.push(local);
    offset += local.length;
  }
  const cd = concatBytes(...centrals);
  const note = strToU8(comment);
  return concatBytes(
    ...locals,
    cd,
    le(0x06054b50, 4),
    le(0, 2),
    le(0, 2),
    le(entries.length, 2),
    le(entries.length, 2),
    le(cd.length, 4),
    le(offset, 4),
    le(note.length, 2),
    note,
  );
}
