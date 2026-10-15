/**
 * Builders for the audio steganography samples and tests: WAV / AIFF files written byte by byte,
 * an LSB embedder (the exact inverse of the tool's extraction), ID3 tags, MPEG audio frames, FLAC
 * metadata blocks and Ogg pages. Everything is deterministic and made up; no real challenge file.
 */
import { encode as encodePng } from 'fast-png';
import { concatBytes } from '../../lib/bytes';
import { oggCrc } from './_audio-stego-xiph';
import {
  isNoPcm,
  readPcm,
  sampleWalk,
  walkChunks,
  type LsbSpec,
  type PcmLayout,
} from './_audio-stego-pcm';

// ---------- small writers ----------

export const ascii = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

export function u16(v: number, big = false): Uint8Array {
  return big ? Uint8Array.of(v >> 8, v & 0xff) : Uint8Array.of(v & 0xff, v >> 8);
}

export function u32(v: number, big = false): Uint8Array {
  const b = [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
  return Uint8Array.from(big ? b : b.reverse());
}

/** Small seeded PRNG (mulberry32): the files are byte-identical on every run. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomBytes(n: number, seed: number): Uint8Array {
  const rand = prng(seed);
  return Uint8Array.from({ length: n }, () => Math.floor(rand() * 256));
}

// ---------- WAV ----------

export interface Chunky {
  id: string;
  body: Uint8Array;
}

/** A RIFF chunk: id, little-endian size, body, one pad byte when the size is odd. */
export function riffChunk(id: string, body: Uint8Array, pad = 0): Uint8Array {
  return concatBytes(
    ascii(id),
    u32(body.length),
    body,
    body.length & 1 ? Uint8Array.of(pad) : new Uint8Array(),
  );
}

export interface WavSpec {
  bits: 8 | 16 | 24 | 32 | 64;
  float?: boolean;
  channels: number;
  rate: number;
  /** The interleaved sample bytes. */
  data: Uint8Array;
  /** Chunks between "fmt " and "data", and after "data". */
  before?: Chunky[];
  after?: Chunky[];
  /** Bytes after the last chunk (not counted by the RIFF size). */
  trailing?: Uint8Array;
  /** What the RIFF size field covers: every chunk (default), up to the audio, or this number. */
  riffSize?: 'all' | 'audio' | number;
}

export function makeWav(s: WavSpec): Uint8Array {
  const bytes = s.bits / 8;
  const fmt = concatBytes(
    u16(s.float ? 3 : 1),
    u16(s.channels),
    u32(s.rate),
    u32(s.rate * s.channels * bytes),
    u16(s.channels * bytes),
    u16(s.bits),
  );
  const head = [riffChunk('fmt ', fmt), ...(s.before ?? []).map((c) => riffChunk(c.id, c.body))];
  const data = riffChunk('data', s.data);
  const tail = (s.after ?? []).map((c) => riffChunk(c.id, c.body));
  const upToAudio = concatBytes(ascii('WAVE'), ...head, data);
  const all = concatBytes(upToAudio, ...tail);
  const size =
    s.riffSize === 'audio'
      ? upToAudio.length
      : typeof s.riffSize === 'number'
        ? s.riffSize
        : all.length;
  return concatBytes(ascii('RIFF'), u32(size), all, s.trailing ?? new Uint8Array());
}

/** Signed integers (or unsigned for 8-bit WAV) to sample bytes. */
export function intBytes(
  values: ArrayLike<number>,
  bits: 8 | 16 | 24 | 32,
  big = false,
): Uint8Array {
  const n = bits / 8;
  const out = new Uint8Array(values.length * n);
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    for (let k = 0; k < n; k++) {
      const byte = bits === 8 ? (v + 128) & 0xff : (v >> (8 * k)) & 0xff;
      out[i * n + (big ? n - 1 - k : k)] = byte;
    }
  }
  return out;
}

export function floatBytes(values: ArrayLike<number>, bits: 32 | 64, big = false): Uint8Array {
  const n = bits / 8;
  const out = new Uint8Array(values.length * n);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < values.length; i++) {
    if (bits === 32) dv.setFloat32(i * 4, values[i]!, !big);
    else dv.setFloat64(i * 8, values[i]!, !big);
  }
  return out;
}

export interface CoverSpec {
  frames: number;
  channels: number;
  /** Full-scale value of the format, 2^(bits-1) - 1. */
  peak: number;
  rate: number;
  seed: number;
  /** Frames of exact digital silence at the start. */
  silence?: number;
  /** Noise added to the tone, in sample units (so the low bits look like a recording's). */
  noise?: number;
}

/** A quiet tone with a little noise after a stretch of digital silence: interleaved integers. */
export function coverSamples(c: CoverSpec): Int32Array {
  const rand = prng(c.seed);
  const out = new Int32Array(c.frames * c.channels);
  for (let f = c.silence ?? 0; f < c.frames; f++) {
    for (let ch = 0; ch < c.channels; ch++) {
      const tone = Math.sin((2 * Math.PI * (330 + 110 * ch) * f) / c.rate) * 0.25 * c.peak;
      out[f * c.channels + ch] = Math.round(tone + (rand() - 0.5) * 2 * (c.noise ?? 8));
    }
  }
  return out;
}

/** A length header: the payload size in bytes (or bits) as a 32-bit number, then the payload. */
export function withLength(
  payload: Uint8Array,
  o: { little?: boolean; bits?: boolean } = {},
): Uint8Array {
  return concatBytes(u32(o.bits ? payload.length * 8 : payload.length, !o.little), payload);
}

// ---------- AIFF ----------

/** The 80-bit IEEE extended encoding of a whole number (AIFF sample rates). */
export function extendedBytes(v: number): Uint8Array {
  const exp = Math.floor(Math.log2(v));
  const mantissa = BigInt(v) << BigInt(63 - exp);
  const out = new Uint8Array(10);
  out.set(u16(16383 + exp, true), 0);
  for (let i = 0; i < 8; i++) out[2 + i] = Number((mantissa >> BigInt(56 - 8 * i)) & 0xffn);
  return out;
}

export interface AiffSpec {
  bits: 8 | 16 | 24 | 32;
  channels: number;
  rate: number;
  frames: number;
  /** Big-endian sample bytes (little-endian with `sowt`). */
  data: Uint8Array;
  /** AIFF-C with this compression type ('NONE' or 'sowt'); plain AIFF when omitted. */
  aifc?: 'NONE' | 'sowt';
  extra?: Chunky[];
  trailing?: Uint8Array;
}

const aiffChunk = (id: string, body: Uint8Array): Uint8Array =>
  concatBytes(
    ascii(id),
    u32(body.length, true),
    body,
    body.length & 1 ? Uint8Array.of(0) : new Uint8Array(),
  );

export function makeAiff(s: AiffSpec): Uint8Array {
  const comm = concatBytes(
    u16(s.channels, true),
    u32(s.frames, true),
    u16(s.bits, true),
    extendedBytes(s.rate),
    ...(s.aifc ? [ascii(s.aifc), Uint8Array.of(0, 0)] : []),
  );
  const ssnd = concatBytes(u32(0, true), u32(0, true), s.data);
  const body = concatBytes(
    ascii(s.aifc ? 'AIFC' : 'AIFF'),
    aiffChunk('COMM', comm),
    ...(s.extra ?? []).map((c) => aiffChunk(c.id, c.body)),
    aiffChunk('SSND', ssnd),
  );
  return concatBytes(ascii('FORM'), u32(body.length, true), body, s.trailing ?? new Uint8Array());
}

// ---------- embedding ----------

/** Write `payload` into the bit planes of the selected samples: the inverse of extractLsb. */
export function embedLsb(
  file: Uint8Array,
  spec: LsbSpec,
  payload: Uint8Array,
  layout?: PcmLayout,
): Uint8Array {
  let pcm = layout;
  if (!pcm) {
    const walked = walkChunks(file);
    const read = walked && readPcm(file, walked);
    if (!read || isNoPcm(read)) throw new Error('not a PCM file');
    pcm = read;
  }
  const out = file.slice();
  const walk = sampleWalk(pcm, spec);
  const msb = spec.bitOrder === 'msb';
  const planes = [...spec.planes].sort((x, y) => (msb ? y - x : x - y));
  const bits = payload.length * 8;
  if (Math.ceil(bits / planes.length) > walk.count) throw new Error('payload too big');
  let i = 0;
  for (let pos = walk.first; i < bits; pos += walk.stride) {
    let v = out[pos]!;
    for (const pl of planes) {
      if (i >= bits) break;
      const byte = payload[i >> 3]!;
      const bit = msb ? (byte >> (7 - (i & 7))) & 1 : (byte >> (i & 7)) & 1;
      v = (v & ~(1 << pl)) | (bit << pl);
      i++;
    }
    out[pos] = v;
  }
  return out;
}

// ---------- a tiny bitmap font and PNG pictures ----------

const GLYPHS: Record<string, readonly string[]> = {
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  N: ['#...#', '##..#', '#.#.#', '#.#.#', '#..##', '#...#', '#...#'],
  G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.###.'],
  I: ['.###.', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '##.##', '#...#'],
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  '{': ['..##.', '.#...', '.#...', '##...', '.#...', '.#...', '..##.'],
  '}': ['.##..', '...#.', '...#.', '...##', '...#.', '...#.', '.##..'],
  _: ['.....', '.....', '.....', '.....', '.....', '.....', '#####'],
};

/** A PNG showing `text` in a 5x7 font (letters F T P N G I W A V C O E R, braces, underscore). */
export function textPng(text: string, scale = 2): Uint8Array {
  const margin = 3 * scale;
  const width = text.length * 6 * scale - scale + 2 * margin;
  const height = 7 * scale + 2 * margin;
  const data = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) data.set([20, 32, 49], i * 3);
  [...text].forEach((ch, n) => {
    const glyph = GLYPHS[ch];
    if (!glyph) throw new Error(`no glyph for ${ch}`);
    glyph.forEach((row, y) => {
      for (let x = 0; x < 5; x++) {
        if (row[x] !== '#') continue;
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            const px = margin + (n * 6 + x) * scale + dx;
            const py = margin + y * scale + dy;
            data.set([229, 160, 70], (py * width + px) * 3);
          }
        }
      }
    });
  });
  return encodePng({ width, height, data, channels: 3, depth: 8 });
}

// ---------- ID3 ----------

export const synchsafe = (n: number): Uint8Array =>
  Uint8Array.of((n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f);

/** A text in one of the ID3 encodings (0 Latin-1, 1 UTF-16 with BOM, 2 UTF-16BE, 3 UTF-8). */
export function id3String(text: string, enc: number, terminate = false): Uint8Array {
  if (enc === 0) return concatBytes(ascii(text), terminate ? Uint8Array.of(0) : new Uint8Array());
  if (enc === 3) return concatBytes(utf8(text), terminate ? Uint8Array.of(0) : new Uint8Array());
  const units = [...text].map((c) => c.charCodeAt(0));
  const bytes = units.flatMap((u) => (enc === 1 ? [u & 0xff, u >> 8] : [u >> 8, u & 0xff]));
  return Uint8Array.from([
    ...(enc === 1 ? [0xff, 0xfe] : []),
    ...bytes,
    ...(terminate ? [0, 0] : []),
  ]);
}

/** A frame: 6-byte header in ID3v2.2, 10 in v2.3 / v2.4 (synchsafe size in v2.4). */
export function id3Frame(version: 2 | 3 | 4, id: string, body: Uint8Array): Uint8Array {
  if (version === 2) {
    return concatBytes(
      ascii(id),
      Uint8Array.of(body.length >> 16, (body.length >> 8) & 0xff, body.length & 0xff),
      body,
    );
  }
  const size = version === 4 ? synchsafe(body.length) : u32(body.length, true);
  return concatBytes(ascii(id), size, Uint8Array.of(0, 0), body);
}

/** The unsynchronisation scheme: a zero byte after every 0xFF that a decoder could take for a sync. */
export function unsync(b: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < b.length; i++) {
    out.push(b[i]!);
    if (b[i] === 0xff && (i === b.length - 1 || b[i + 1] === 0 || (b[i + 1]! & 0xe0) === 0xe0)) {
      out.push(0);
    }
  }
  return Uint8Array.from(out);
}

export function id3Tag(
  version: 2 | 3 | 4,
  frames: Uint8Array[],
  o: { padding?: Uint8Array | number; unsync?: boolean } = {},
): Uint8Array {
  const pad =
    typeof o.padding === 'number' ? new Uint8Array(o.padding) : (o.padding ?? new Uint8Array());
  const raw = concatBytes(...frames, pad);
  const body = o.unsync ? unsync(raw) : raw;
  return concatBytes(
    ascii('ID3'),
    Uint8Array.of(version, 0, o.unsync ? 0x80 : 0),
    synchsafe(body.length),
    body,
  );
}

export const id3Text = (version: 2 | 3 | 4, id: string, text: string, enc = 3): Uint8Array =>
  id3Frame(version, id, concatBytes(Uint8Array.of(enc), id3String(text, enc)));

export function id3Comm(version: 2 | 3 | 4, text: string, desc = '', enc = 3): Uint8Array {
  return id3Frame(
    version,
    version === 2 ? 'COM' : 'COMM',
    concatBytes(Uint8Array.of(enc), ascii('eng'), id3String(desc, enc, true), id3String(text, enc)),
  );
}

export function id3Apic(
  version: 2 | 3 | 4,
  mime: string,
  pictureType: number,
  desc: string,
  data: Uint8Array,
): Uint8Array {
  const type =
    version === 2
      ? ascii(mime.includes('png') ? 'PNG' : 'JPG')
      : concatBytes(ascii(mime), Uint8Array.of(0));
  return id3Frame(
    version,
    version === 2 ? 'PIC' : 'APIC',
    concatBytes(Uint8Array.of(0), type, Uint8Array.of(pictureType), id3String(desc, 0, true), data),
  );
}

export const id3Geob = (
  version: 2 | 3 | 4,
  mime: string,
  filename: string,
  desc: string,
  data: Uint8Array,
): Uint8Array =>
  id3Frame(
    version,
    'GEOB',
    concatBytes(
      Uint8Array.of(0),
      ascii(mime),
      Uint8Array.of(0),
      ascii(filename),
      Uint8Array.of(0),
      ascii(desc),
      Uint8Array.of(0),
      data,
    ),
  );

export const id3Priv = (version: 2 | 3 | 4, owner: string, data: Uint8Array): Uint8Array =>
  id3Frame(version, 'PRIV', concatBytes(ascii(owner), Uint8Array.of(0), data));

/** A 128-byte ID3v1.1 tag. */
export function id3v1(f: {
  title?: string;
  artist?: string;
  album?: string;
  year?: string;
  comment?: string;
  track?: number;
  genre?: number;
}): Uint8Array {
  const out = new Uint8Array(128);
  out.set(ascii('TAG'), 0);
  const put = (s: string | undefined, at: number, max: number) =>
    out.set(ascii((s ?? '').slice(0, max)), at);
  put(f.title, 3, 30);
  put(f.artist, 33, 30);
  put(f.album, 63, 30);
  put(f.year, 93, 4);
  put(f.comment, 97, f.track === undefined ? 30 : 28);
  if (f.track !== undefined) out[126] = f.track;
  out[127] = f.genre ?? 255;
  return out;
}

// ---------- MPEG audio ----------

const MP3_KBPS = [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];

/** A silent MPEG-1 Layer III frame, 44100 Hz, 128 kbit/s unless said otherwise: a header and zeros. */
export function mp3Frame(
  o: { mono?: boolean; padding?: boolean; body?: Uint8Array; kbps?: number } = {},
): Uint8Array {
  const kbps = o.kbps ?? 128;
  const index = MP3_KBPS.indexOf(kbps) + 1;
  if (index === 0) throw new Error(`no such bitrate: ${kbps}`);
  const length = Math.floor((144000 * kbps) / 44100) + (o.padding ? 1 : 0);
  const out = new Uint8Array(length);
  out.set([0xff, 0xfb, (index << 4) | (o.padding ? 2 : 0), o.mono ? 0xc0 : 0x00], 0);
  if (o.body) out.set(o.body.subarray(0, length - 4), 4);
  return out;
}

/** The first frame of a LAME file: a silent frame holding a Xing / Info header. */
export function xingFrame(o: {
  frames: number;
  bytes: number;
  vbr?: boolean;
  mono?: boolean;
  encoder?: string;
}): Uint8Array {
  const frame = mp3Frame({ mono: o.mono });
  const at = 4 + (o.mono ? 17 : 32);
  const toc = Uint8Array.from({ length: 100 }, (_, i) => Math.floor((i * 255) / 100));
  const tag = concatBytes(
    ascii(o.vbr ? 'Xing' : 'Info'),
    u32(0x0f, true),
    u32(o.frames, true),
    u32(o.bytes, true),
    toc,
    u32(60, true),
    ascii((o.encoder ?? 'LAME3.100').padEnd(9, ' ').slice(0, 9)),
  );
  frame.set(tag, at);
  return frame;
}

// ---------- FLAC ----------

export function flacStreamInfo(rate: number, channels: number, bits: number, samples: number) {
  const out = new Uint8Array(34);
  out.set(u16(4096, true), 0);
  out.set(u16(4096, true), 2);
  // sample rate (20 bits), channels - 1 (3), bits - 1 (5), total samples (36)
  const hi =
    (rate << 12) | ((channels - 1) << 9) | ((bits - 1) << 4) | Math.floor(samples / 2 ** 32);
  out.set(u32(hi >>> 0, true), 10);
  out.set(u32(samples >>> 0, true), 14);
  return out;
}

export function vorbisComment(vendor: string, comments: string[], framing = false): Uint8Array {
  const parts = [u32(utf8(vendor).length), utf8(vendor), u32(comments.length)];
  for (const c of comments) parts.push(u32(utf8(c).length), utf8(c));
  if (framing) parts.push(Uint8Array.of(1));
  return concatBytes(...parts);
}

/** A FLAC PICTURE block body (also what METADATA_BLOCK_PICTURE holds, base64-encoded). */
export function flacPicture(mime: string, desc: string, data: Uint8Array, type = 3): Uint8Array {
  return concatBytes(
    u32(type, true),
    u32(mime.length, true),
    ascii(mime),
    u32(utf8(desc).length, true),
    utf8(desc),
    u32(0, true),
    u32(0, true),
    u32(24, true),
    u32(0, true),
    u32(data.length, true),
    data,
  );
}

export function flacFile(
  blocks: { type: number; body: Uint8Array }[],
  frames: Uint8Array = new Uint8Array(),
): Uint8Array {
  const parts: Uint8Array[] = [ascii('fLaC')];
  blocks.forEach((b, i) => {
    const last = i === blocks.length - 1 ? 0x80 : 0;
    parts.push(
      Uint8Array.of(
        last | b.type,
        (b.body.length >> 16) & 0xff,
        (b.body.length >> 8) & 0xff,
        b.body.length & 0xff,
      ),
      b.body,
    );
  });
  parts.push(frames);
  return concatBytes(...parts);
}

// ---------- Ogg ----------

/**
 * Ogg pages holding these packets, split across as many pages as it takes (a packet may continue
 * on the next page). Returns the pages and the next page sequence number.
 */
export function oggPackets(o: {
  serial: number;
  seq: number;
  packets: Uint8Array[];
  flags?: number;
  perPage?: number;
}): { bytes: Uint8Array; next: number } {
  const lacing: number[] = [];
  for (const p of o.packets) {
    for (let n = p.length; n >= 255; n -= 255) lacing.push(255);
    lacing.push(p.length % 255);
  }
  const data = concatBytes(...o.packets);
  const pages: Uint8Array[] = [];
  const per = o.perPage ?? 200;
  let at = 0;
  let seq = o.seq;
  for (let i = 0; i < lacing.length; i += per) {
    const group = lacing.slice(i, i + per);
    const size = group.reduce((a, b) => a + b, 0);
    const continued = i > 0 && lacing[i - 1] === 255;
    const head = concatBytes(
      ascii('OggS'),
      Uint8Array.of(0, (continued ? 1 : 0) | (i === 0 ? (o.flags ?? 0) : 0)),
      u32(0),
      u32(0),
      u32(o.serial),
      u32(seq++),
      u32(0),
      Uint8Array.of(group.length),
      Uint8Array.from(group),
    );
    const page = concatBytes(head, data.subarray(at, at + size));
    at += size;
    page.set(u32(oggCrc(page)), 22);
    pages.push(page);
  }
  return { bytes: concatBytes(...pages), next: seq };
}

/** An Ogg page holding whole packets. */
export function oggPage(o: {
  serial: number;
  seq: number;
  packets: Uint8Array[];
  granule?: number;
  flags?: number;
}): Uint8Array {
  const lacing: number[] = [];
  for (const p of o.packets) {
    for (let n = p.length; n >= 255; n -= 255) lacing.push(255);
    lacing.push(p.length % 255);
  }
  const body = concatBytes(...o.packets);
  const head = concatBytes(
    ascii('OggS'),
    Uint8Array.of(0, o.flags ?? 0),
    u32(o.granule ?? 0),
    u32(0),
    u32(o.serial),
    u32(o.seq),
    u32(0),
    Uint8Array.of(lacing.length),
    Uint8Array.from(lacing),
  );
  const page = concatBytes(head, body);
  page.set(u32(oggCrc(page)), 22);
  return page;
}

/** An Ogg Opus file: the head, the tags and one audio page. */
export function oggOpus(
  vendor: string,
  comments: string[],
  extra: Uint8Array = new Uint8Array(),
): Uint8Array {
  const head = concatBytes(
    ascii('OpusHead'),
    Uint8Array.of(1, 2),
    u16(312),
    u32(44100),
    u16(0),
    Uint8Array.of(0),
  );
  const tags = concatBytes(ascii('OpusTags'), vorbisComment(vendor, comments));
  const pages = oggPackets({ serial: 9, seq: 1, packets: [tags] });
  return concatBytes(
    oggPage({ serial: 9, seq: 0, packets: [head], flags: 2 }),
    pages.bytes,
    oggPage({
      serial: 9,
      seq: pages.next,
      packets: [new Uint8Array(40)],
      granule: 48000,
      flags: 4,
    }),
    extra,
  );
}

/** An Ogg Vorbis file with a comment header, a (fake) setup header and one audio page. */
export function oggVorbis(
  vendor: string,
  comments: string[],
  extra: Uint8Array = new Uint8Array(),
): Uint8Array {
  const id = concatBytes(
    Uint8Array.of(1),
    ascii('vorbis'),
    u32(0),
    Uint8Array.of(2),
    u32(44100),
    u32(0),
    u32(128000),
    u32(0),
    Uint8Array.of(0xb8, 1),
  );
  const comment = concatBytes(
    Uint8Array.of(3),
    ascii('vorbis'),
    vorbisComment(vendor, comments, true),
  );
  const setup = concatBytes(Uint8Array.of(5), ascii('vorbis'), new Uint8Array(40));
  const headers = oggPackets({ serial: 7, seq: 1, packets: [comment, setup] });
  return concatBytes(
    oggPage({ serial: 7, seq: 0, packets: [id], flags: 2 }),
    headers.bytes,
    oggPage({
      serial: 7,
      seq: headers.next,
      packets: [new Uint8Array(60)],
      granule: 4096,
      flags: 4,
    }),
    extra,
  );
}
