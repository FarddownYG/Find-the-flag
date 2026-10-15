/**
 * FLAC and Ogg (Vorbis, Opus, FLAC, Speex) container checks: FLAC metadata blocks (STREAMINFO,
 * VORBIS_COMMENT, PICTURE, APPLICATION, PADDING that is not empty), Ogg pages walked with their
 * checksums, the comment headers, pictures stored as METADATA_BLOCK_PICTURE, and data between or
 * after the pages. The audio itself is never decoded.
 */
import { toolT } from '../../i18n/tool-text';
import {
  concatBytes,
  fromBase64,
  indexOfBytes,
  latin1Decode,
  u32be,
  u32le,
  utf8Decode,
} from '../../lib/bytes';
import {
  addBlob,
  at,
  describePayload,
  emptyAnalysis,
  fourCC,
  isZero,
  merge,
  oneLine,
  safeName,
  type Analysis,
} from './_audio-stego-found';
import { hasId3v2, id3v2Size, parseId3v2 } from './_audio-stego-id3';

const T = toolT('audio-stego');

// ---------- Vorbis comments and FLAC pictures ----------

export interface VorbisComment {
  vendor: string;
  comments: string[];
  /** Offset just after the last comment. */
  end: number;
}

/** A Vorbis comment block at `o`: vendor, then "KEY=value" strings, all with 32-bit LE lengths. */
export function parseVorbisComment(b: Uint8Array, o: number): VorbisComment | null {
  if (o + 8 > b.length) return null;
  const vendorLen = u32le(b, o);
  let p = o + 4 + vendorLen;
  if (p + 4 > b.length) return null;
  const vendor = utf8Decode(b.subarray(o + 4, p));
  const count = u32le(b, p);
  p += 4;
  const comments: string[] = [];
  for (let i = 0; i < count && p + 4 <= b.length; i++) {
    const len = u32le(b, p);
    if (p + 4 + len > b.length) break;
    comments.push(utf8Decode(b.subarray(p + 4, p + 4 + len)));
    p += 4 + len;
  }
  return { vendor, comments, end: p };
}

export interface FlacPicture {
  type: number;
  mime: string;
  desc: string;
  data: Uint8Array;
}

/** A FLAC PICTURE block body (the same layout METADATA_BLOCK_PICTURE carries in Ogg). */
export function parsePictureBlock(body: Uint8Array): FlacPicture | null {
  if (body.length < 32) return null;
  const type = u32be(body, 0);
  const mimeLen = u32be(body, 4);
  let p = 8 + mimeLen;
  if (p + 4 > body.length) return null;
  const mime = latin1Decode(body.subarray(8, p));
  const descLen = u32be(body, p);
  const desc = utf8Decode(body.subarray(p + 4, p + 4 + descLen));
  p += 4 + descLen + 16; // width, height, depth, colours
  if (p + 4 > body.length) return null;
  const len = u32be(body, p);
  if (len === 0 || p + 4 + len > body.length) return null;
  return { type, mime, desc, data: body.subarray(p + 4, p + 4 + len) };
}

const COMMENT_LIMIT = 300;

/** Comments to table rows; a cover stored as METADATA_BLOCK_PICTURE comes out as a payload. */
function commentRows(vc: VorbisComment, source: string, base: number, out: Analysis): void {
  if (vc.vendor) out.meta.push({ source, name: 'vendor', value: oneLine(vc.vendor) });
  for (const c of vc.comments) {
    const eq = c.indexOf('=');
    const key = eq < 0 ? '' : c.slice(0, eq);
    const value = eq < 0 ? c : c.slice(eq + 1);
    if (key.toUpperCase() === 'METADATA_BLOCK_PICTURE') {
      const pic = pictureFromBase64(value);
      if (pic) {
        const d = describePayload(pic.data);
        out.meta.push({
          source,
          name: key,
          value: `${pic.mime} · ${pic.data.length} B · ${d.label}`,
        });
        out.payloads.push({
          where: T('where.vorbisPicture'),
          offset: base,
          data: pic.data.slice(),
          name: `cover.${d.image ? d.ext : (pic.mime.split('/')[1] ?? 'bin')}`,
        });
        continue;
      }
    }
    out.meta.push({ source, name: key || '—', value: oneLine(value, COMMENT_LIMIT) });
  }
}

function pictureFromBase64(value: string): FlacPicture | null {
  try {
    return parsePictureBlock(fromBase64(value));
  } catch {
    return null; // not base64: an ordinary comment
  }
}

// ---------- FLAC ----------

const FLAC_BLOCKS: Record<number, string> = {
  0: 'STREAMINFO',
  1: 'PADDING',
  2: 'APPLICATION',
  3: 'SEEKTABLE',
  4: 'VORBIS_COMMENT',
  5: 'CUESHEET',
  6: 'PICTURE',
};

/** A plausible FLAC frame header: sync code, no reserved values. */
function flacFrameAt(b: Uint8Array, p: number): boolean {
  if (p + 4 > b.length || b[p] !== 0xff || (b[p + 1]! & 0xfe) !== 0xf8) return false;
  const size = b[p + 2]! >> 4;
  const rate = b[p + 2]! & 15;
  const channels = b[p + 3]! >> 4;
  const bits = (b[p + 3]! >> 1) & 7;
  return size !== 0 && rate !== 15 && channels <= 10 && bits !== 3 && (b[p + 3]! & 1) === 0;
}

export function analyzeFlac(b: Uint8Array): Analysis {
  const out = emptyAnalysis('FLAC', true);
  let p = 0;
  while (hasId3v2(b, p)) {
    const tag = parseId3v2(b, p);
    if (tag) merge(out, tag);
    p += id3v2Size(b, p);
  }
  if (fourCC(b, p) !== 'fLaC') {
    out.notes.push({ level: 'warn', text: T('flac.noMarker') });
    return out;
  }
  p += 4;
  const blocks: string[] = [];
  for (;;) {
    if (p + 4 > b.length) {
      out.notes.push({ level: 'warn', text: T('flac.truncated') });
      return out;
    }
    const last = (b[p]! & 0x80) !== 0;
    const type = b[p]! & 0x7f;
    const len = (b[p + 1]! << 16) | (b[p + 2]! << 8) | b[p + 3]!;
    const start = p + 4;
    const end = Math.min(b.length, start + len);
    const body = b.subarray(start, end);
    if (start + len > b.length) {
      out.notes.push({ level: 'warn', text: T('flac.truncated') });
      return out;
    }
    const name = FLAC_BLOCKS[type] ?? T('flac.reserved', { type });
    blocks.push(name);
    let what = '';
    if (type === 0 && body.length >= 18) {
      const rate = (body[10]! << 12) | (body[11]! << 4) | (body[12]! >> 4);
      const channels = ((body[12]! >> 1) & 7) + 1;
      const bits = (((body[12]! & 1) << 4) | (body[13]! >> 4)) + 1;
      const samples = (body[13]! & 15) * 2 ** 32 + u32be(body, 14);
      what = T('flac.streaminfo', { rate, channels, bits });
      out.summary.push([
        T('kv.audio'),
        T('flac.audio', {
          rate,
          channels,
          bits,
          seconds: rate ? (samples / rate).toFixed(2) : '?',
        }),
      ]);
    } else if (type === 1) {
      what = T('flac.padding', { count: len });
      if (!isZero(body)) {
        addBlob(out, {
          where: T('where.flacPadding'),
          offset: start,
          data: body.slice(),
          name: 'flac-padding.bin',
        });
      }
    } else if (type === 2 && body.length >= 4) {
      const app = latin1Decode(body.subarray(0, 4));
      what = T('flac.application', { id: oneLine(app), size: body.length - 4 });
      out.payloads.push({
        where: T('where.flacApplication', { id: oneLine(app) }),
        offset: start + 4,
        data: body.slice(4),
        name: `flac-application-${safeName(app, 'app')}.bin`,
      });
    } else if (type === 3) {
      what = T('flac.seektable', { count: Math.floor(len / 18) });
    } else if (type === 4) {
      const vc = parseVorbisComment(body, 0);
      if (vc) {
        what = T('flac.comments', { count: vc.comments.length });
        commentRows(vc, 'Vorbis comment', start, out);
        if (vc.end < body.length) {
          addBlob(out, {
            where: T('where.afterComments'),
            offset: start + vc.end,
            data: body.slice(vc.end),
            name: 'flac-comment-extra.bin',
          });
        }
      }
    } else if (type === 6) {
      const pic = parsePictureBlock(body);
      if (pic) {
        const d = describePayload(pic.data);
        what = T('flac.picture', { mime: pic.mime || '?', size: pic.data.length });
        out.meta.push({
          source: 'FLAC PICTURE',
          name: T('picture.typeN', { n: pic.type }),
          value: `${pic.mime} · ${pic.desc ? `${pic.desc} · ` : ''}${pic.data.length} B · ${d.label}`,
        });
        out.payloads.push({
          where: T('where.flacPicture'),
          offset: start,
          data: pic.data.slice(),
          name: `flac-picture.${d.image ? d.ext : (pic.mime.split('/')[1] ?? 'bin')}`,
        });
      }
    } else if (type > 6) {
      addBlob(out, {
        where: T('where.flacBlock', { type }),
        offset: start,
        data: body.slice(),
        name: `flac-block-${type}.bin`,
      });
    }
    out.rows.push({ offset: p, name, size: 4 + len, what });
    p = start + len;
    if (last) break;
  }
  if (p >= b.length) {
    out.notes.push({ level: 'info', text: T('flac.noFrames') });
    return out;
  }
  if (!flacFrameAt(b, p)) {
    let q = p + 1;
    const limit = Math.min(b.length, p + 1024 * 1024);
    while (q < limit && !flacFrameAt(b, q)) q++;
    if (q < limit) {
      addBlob(out, {
        where: T('where.beforeFlacFrames'),
        offset: p,
        data: b.slice(p, q),
        name: 'flac-before-audio.bin',
      });
      p = q;
    } else out.notes.push({ level: 'warn', text: T('flac.noSync', { offset: at(p) }) });
  }
  out.rows.push({
    offset: p,
    name: T('flac.framesRow'),
    size: b.length - p,
    what: T('flac.framesWhat'),
  });
  out.notes.push({ level: 'info', text: T('flac.endNotChecked') });
  return out;
}

// ---------- Ogg ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let k = 0; k < 8; k++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    t[i] = r >>> 0;
  }
  return t;
})();

/** The Ogg page checksum (CRC-32, polynomial 0x04C11DB7, not reflected) of `page`, with its own checksum field read as zero. */
export function oggCrc(page: Uint8Array): number {
  let crc = 0;
  for (let i = 0; i < page.length; i++) {
    const v = i >= 22 && i < 26 ? 0 : page[i]!;
    crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) & 0xff) ^ v]!) >>> 0;
  }
  return crc;
}

interface OggStream {
  serial: number;
  /** Offset of the page that completed the second packet (the comment header). */
  commentPage: number;
  packets: Uint8Array[];
  open: Uint8Array[];
  openSize: number;
  pages: number;
  granule: number;
}

const MAX_PACKET = 32 * 1024 * 1024;
const WANTED_PACKETS = 3;

type Codec = 'vorbis' | 'opus' | 'flac' | 'speex' | 'theora' | null;

function codecOf(first: Uint8Array): Codec {
  const head = latin1Decode(first.subarray(0, 9));
  if (first[0] === 1 && head.slice(1, 7) === 'vorbis') return 'vorbis';
  if (head.startsWith('OpusHead')) return 'opus';
  if (first[0] === 0x7f && head.slice(1, 5) === 'FLAC') return 'flac';
  if (head.startsWith('Speex   ')) return 'speex';
  if (first[0] === 0x80 && head.slice(1, 7) === 'theora') return 'theora';
  return null;
}

const CODEC_NAMES: Record<string, string> = {
  vorbis: 'Vorbis',
  opus: 'Opus',
  flac: 'FLAC',
  speex: 'Speex',
  theora: 'Theora',
};

/** Where the comments start in the comment packet of each codec, and whether a framing byte ends them. */
function commentStart(codec: Codec, packet: Uint8Array): { at: number; framing: boolean } | null {
  switch (codec) {
    case 'vorbis':
      return packet[0] === 3 ? { at: 7, framing: true } : null;
    case 'opus':
      return latin1Decode(packet.subarray(0, 8)) === 'OpusTags' ? { at: 8, framing: false } : null;
    case 'flac':
      return (packet[0]! & 0x7f) === 4 ? { at: 4, framing: false } : null;
    case 'speex':
      return { at: 0, framing: false };
    case 'theora':
      return packet[0] === 0x81 ? { at: 7, framing: true } : null;
    default:
      return null;
  }
}

function streamInfo(codec: Codec, first: Uint8Array): { channels: number; rate: number } | null {
  if (codec === 'vorbis') return { channels: first[11]!, rate: u32le(first, 12) };
  if (codec === 'opus') return { channels: first[9]!, rate: u32le(first, 12) };
  return null;
}

export function analyzeOgg(b: Uint8Array): Analysis {
  const out = emptyAnalysis('Ogg');
  let p = 0;
  while (hasId3v2(b, p)) {
    const tag = parseId3v2(b, p);
    if (tag) merge(out, tag);
    p += id3v2Size(b, p);
  }
  const firstPage = p;
  const streams = new Map<number, OggStream>();
  let pages = 0;
  let badCrc = 0;
  let firstBad = -1;
  let end = p; // end of the last good page
  const gaps: { start: number; end: number }[] = [];
  let truncated = false;
  const isPage = (o: number) =>
    o + 27 <= b.length && fourCC(b, o) === 'OggS' && b[o + 4] === 0 && b[o + 26]! > 0;
  while (p + 27 <= b.length) {
    if (!isPage(p)) {
      const next = findPage(b, p + 1, isPage);
      gaps.push({ start: p, end: next < 0 ? b.length : next });
      p = next < 0 ? b.length : next;
      continue;
    }
    const nseg = b[p + 26]!;
    if (p + 27 + nseg > b.length) {
      truncated = true;
      break;
    }
    const lacing = b.subarray(p + 27, p + 27 + nseg);
    let bodyLen = 0;
    for (const l of lacing) bodyLen += l;
    const pageEnd = p + 27 + nseg + bodyLen;
    if (pageEnd > b.length) {
      truncated = true;
      break;
    }
    if (oggCrc(b.subarray(p, pageEnd)) !== u32le(b, p + 22)) {
      badCrc++;
      if (firstBad < 0) firstBad = p;
    }
    const serial = u32le(b, p + 14);
    let s = streams.get(serial);
    if (!s) {
      s = { serial, commentPage: p, packets: [], open: [], openSize: 0, pages: 0, granule: 0 };
      streams.set(serial, s);
    }
    s.pages++;
    const granule = u32le(b, p + 6) + u32le(b, p + 10) * 2 ** 32;
    if (granule < 2 ** 52) s.granule = Math.max(s.granule, granule);
    let o = p + 27 + nseg;
    for (const l of lacing) {
      if (s.packets.length < WANTED_PACKETS && s.openSize < MAX_PACKET) {
        s.open.push(b.subarray(o, o + l));
        s.openSize += l;
        if (l < 255) {
          if (s.packets.length === 1) s.commentPage = p;
          s.packets.push(concatBytes(...s.open));
          s.open = [];
          s.openSize = 0;
        }
      }
      o += l;
    }
    pages++;
    p = pageEnd;
    end = pageEnd;
  }
  if (!truncated && p < b.length) gaps.push({ start: p, end: b.length });
  if (!pages) {
    out.notes.push({ level: 'warn', text: T('ogg.noPages') });
    return out;
  }

  // Streams: codec, comments.
  let seconds = 0;
  let described = false;
  for (const s of streams.values()) {
    const first = s.packets[0];
    if (!first) continue;
    const codec = codecOf(first);
    const info = streamInfo(codec, first);
    if (info && info.rate)
      seconds = Math.max(seconds, s.granule / (codec === 'opus' ? 48000 : info.rate));
    if (!described) {
      if (codec) out.format = `Ogg ${CODEC_NAMES[codec]!}`;
      out.lossless = codec === 'flac';
      out.summary.push([
        T('kv.audio'),
        codec
          ? T(info ? 'ogg.audio' : 'ogg.audioNoRate', {
              codec: CODEC_NAMES[codec]!,
              channels: info?.channels ?? 0,
              rate: info?.rate ?? 0,
            })
          : T('ogg.unknownCodec'),
      ]);
      described = true;
    }
    const comment = s.packets[1];
    const start = codec && comment ? commentStart(codec, comment) : null;
    if (comment && start) {
      const vc = parseVorbisComment(comment, start.at);
      if (vc) {
        commentRows(vc, T('ogg.commentSource', { codec: CODEC_NAMES[codec!]! }), 0, out);
        const after = vc.end + (start.framing ? 1 : 0);
        if (after < comment.length && s.packets.length >= 2 && comment.length < MAX_PACKET) {
          addBlob(out, {
            where: T('where.afterComments'),
            offset: 0,
            data: comment.slice(after),
            name: 'ogg-comment-extra.bin',
          });
        }
        out.rows.push({
          offset: s.commentPage,
          name: T('ogg.commentRow'),
          size: comment.length,
          what: T('ogg.comments', { count: vc.comments.length }),
        });
      }
    }
  }
  out.summary.push([
    T('kv.pages'),
    T('ogg.pages', { count: pages, streams: streams.size, seconds: seconds.toFixed(2) }),
  ]);
  out.rows.push({
    offset: firstPage,
    name: T('ogg.pagesRow'),
    size: end - firstPage,
    what: T('ogg.pagesWhat', { count: pages }),
  });
  if (badCrc) {
    out.notes.push({
      level: 'warn',
      text: T('ogg.badCrc', { count: badCrc, offset: at(firstBad) }),
    });
  }
  if (truncated) out.notes.push({ level: 'info', text: T('ogg.truncated') });
  for (const g of gaps) {
    const between = g.end < b.length;
    const data = b.slice(g.start, g.end);
    out.rows.push({
      offset: g.start,
      name: T(between ? 'ogg.gapRow' : 'ogg.tailRow'),
      size: data.length,
      what: T(between ? 'ogg.gap' : 'ogg.tail'),
    });
    addBlob(out, {
      where: T(between ? 'where.betweenOggPages' : 'where.afterOggPages'),
      offset: g.start,
      data,
      name: between ? `ogg-between-pages-${g.start}.bin` : 'ogg-after-last-page.bin',
    });
  }
  out.rows.sort((x, y) => x.offset - y.offset);
  return out;
}

/** The next position at or after `from` where an Ogg page starts. */
function findPage(b: Uint8Array, from: number, isPage: (o: number) => boolean): number {
  const marker = [0x4f, 0x67, 0x67, 0x53];
  for (let p = indexOfBytes(b, marker, from); p >= 0; p = indexOfBytes(b, marker, p + 1)) {
    if (isPage(p)) return p;
  }
  return -1;
}
