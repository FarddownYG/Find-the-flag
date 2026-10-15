/**
 * ID3 tags (v1, v1.1, v2.2, v2.3, v2.4): every frame is read, the cover picture (APIC) and the
 * free-form binary frames (GEOB, PRIV, non-standard ids) are kept as payloads, and padding that
 * holds data is reported. Used for MP3 files and for the ID3 chunk of WAV / AIFF files.
 */
import { toolT } from '../../i18n/tool-text';
import { latin1Decode, u16be, u32be, utf8Decode } from '../../lib/bytes';
import {
  addBlob,
  bytesToText,
  describePayload,
  emptyAnalysis,
  fourCC,
  isZero,
  oneLine,
  safeName,
  type Analysis,
} from './_audio-stego-found';

const T = toolT('audio-stego');

const synchsafe = (b: Uint8Array, o: number): number =>
  ((b[o]! & 0x7f) << 21) |
  ((b[o + 1]! & 0x7f) << 14) |
  ((b[o + 2]! & 0x7f) << 7) |
  (b[o + 3]! & 0x7f);

const isSynchsafe = (b: Uint8Array, o: number): boolean =>
  [0, 1, 2, 3].every((i) => (b[o + i] ?? 0x80) < 0x80);

/** Is there an ID3v2 header at `o`? */
export function hasId3v2(b: Uint8Array, o: number): boolean {
  return (
    o + 10 <= b.length &&
    b[o] === 0x49 &&
    b[o + 1] === 0x44 &&
    b[o + 2] === 0x33 &&
    b[o + 3]! >= 2 &&
    b[o + 3]! <= 4 &&
    b[o + 4]! < 0xff &&
    (b[o + 5]! & 0x0f) === 0 &&
    isSynchsafe(b, o + 6)
  );
}

/** Total size of the ID3v2 tag at `o`, header and footer included. */
export function id3v2Size(b: Uint8Array, o: number): number {
  return 10 + synchsafe(b, o + 6) + ((b[o + 5]! & 0x10) !== 0 && b[o + 3]! >= 4 ? 10 : 0);
}

/** Offset just after any ID3v2 tags stacked at `o`. */
export function skipId3v2(b: Uint8Array, o = 0): number {
  let p = o;
  while (hasId3v2(b, p)) p += id3v2Size(b, p);
  return Math.min(p, b.length);
}

/** Undo the unsynchronisation scheme: every 0xFF 0x00 becomes 0xFF. */
export function deunsync(b: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < b.length; i++) {
    out.push(b[i]!);
    if (b[i] === 0xff && b[i + 1] === 0) i++;
  }
  return Uint8Array.from(out);
}

// ---------- strings ----------

function decode(b: Uint8Array, enc: number): string {
  if (enc === 1 || enc === 2) {
    let le = true;
    let from = 0;
    if (b[0] === 0xff && b[1] === 0xfe) from = 2;
    else if (b[0] === 0xfe && b[1] === 0xff) {
      le = false;
      from = 2;
    } else if (enc === 2) le = false;
    let s = '';
    for (let i = from; i + 1 < b.length; i += 2) {
      s += String.fromCharCode(le ? b[i]! | (b[i + 1]! << 8) : (b[i]! << 8) | b[i + 1]!);
    }
    return s;
  }
  return enc === 3 ? utf8Decode(b) : latin1Decode(b);
}

/** A string at `p` ended by its terminator (one NUL, two for UTF-16) and the position after it. */
function readString(b: Uint8Array, p: number, enc: number): { text: string; next: number } {
  const wide = enc === 1 || enc === 2;
  let end = p;
  if (wide) while (end + 1 < b.length && !(b[end] === 0 && b[end + 1] === 0)) end += 2;
  else while (end < b.length && b[end] !== 0) end++;
  return {
    text: decode(b.subarray(p, Math.min(end, b.length)), enc),
    next: Math.min(b.length, end + (wide ? 2 : 1)),
  };
}

/** Text of a text frame (or of the value part of TXXX): its strings joined with " / ". */
function textFrame(body: Uint8Array, from = 1): string {
  const enc = body[0] ?? 0;
  const parts: string[] = [];
  let p = from;
  while (p < body.length) {
    const s = readString(body, p, enc);
    if (s.text || p === from) parts.push(s.text);
    p = s.next;
  }
  return parts.filter((x) => x !== '').join(' / ');
}

// ---------- frames ----------

/** Frames that are structured binary data by the specification: listed, never a hidden-file hint. */
const KNOWN_BINARY = new Set(
  'AENC ASPI COMR ENCR EQU2 EQUA ETCO GRID LINK MCDI MLLT OWNE PCNT POPM POSS RBUF RVA2 RVAD RVRB SEEK SIGN SYLT SYTC USER UFID CNT CRA CRM EQU ETC IPL LNK MCI MLL POP REV RVA SLT STC UFI BUF'.split(
    ' ',
  ),
);

const PICTURE_TYPES: Record<number, string> = { 0: 'other', 3: 'front cover', 4: 'back cover' };

interface Frame {
  id: string;
  body: Uint8Array;
  offset: number;
  flags: number;
}

function describeFrame(
  id: string,
  body: Uint8Array,
  offset: number,
  version: number,
  out: Analysis,
) {
  const meta = (name: string, value: string) =>
    out.meta.push({ source: 'ID3v2', name, value: oneLine(value, 300) });
  const enc = body[0] ?? 0;
  const lead = id[0];
  if (id === 'TXXX' || id === 'TXX' || id === 'WXXX' || id === 'WXX') {
    const desc = readString(body, 1, enc);
    const value =
      id[0] === 'W' ? latin1Decode(body.subarray(desc.next)) : textFrame(body, desc.next);
    meta(`${id}:${desc.text}`, value.replace(/\0+$/, ''));
  } else if (lead === 'T' && id !== 'TXXX') {
    meta(id, textFrame(body));
  } else if (lead === 'W') {
    meta(id, latin1Decode(body).replace(/\0+$/, ''));
  } else if (id === 'COMM' || id === 'COM' || id === 'USLT' || id === 'ULT') {
    const lang = latin1Decode(body.subarray(1, 4));
    const desc = readString(body, 4, enc);
    const text = decode(body.subarray(desc.next), enc);
    meta(`${id}(${lang})${desc.text ? `:${desc.text}` : ''}`, text.replace(/\0+$/, ''));
  } else if (id === 'APIC' || id === 'PIC') {
    let mime: string;
    let p: number;
    if (id === 'PIC') {
      mime = `image/${latin1Decode(body.subarray(1, 4)).toLowerCase().replace('jpg', 'jpeg')}`;
      p = 4;
    } else {
      const m = readString(body, 1, 0);
      mime = m.text;
      p = m.next;
    }
    const type = body[p] ?? 0;
    const desc = readString(body, p + 1, enc);
    const data = body.subarray(desc.next);
    const d = describePayload(data);
    const typeName = PICTURE_TYPES[type];
    meta(
      id,
      `${mime || '?'} · ${typeName ? T(`picture.type.${type}`) : T('picture.typeN', { n: type })}${desc.text ? ` · ${desc.text}` : ''} · ${data.length} B · ${d.label}`,
    );
    out.payloads.push({
      where: T('where.apic', { version }),
      offset,
      data: data.slice(),
      name: `id3-cover.${d.image ? d.ext : (mime.split('/')[1] ?? 'bin').replace('jpeg', 'jpg')}`,
    });
  } else if (id === 'GEOB' || id === 'GEO') {
    const m = readString(body, 1, 0);
    const file = readString(body, m.next, enc);
    const desc = readString(body, file.next, enc);
    const data = body.subarray(desc.next);
    meta(id, `${m.text} · ${file.text} · ${desc.text} · ${data.length} B`);
    out.payloads.push({
      where: T('where.frame', { version, id }),
      offset,
      data: data.slice(),
      name: safeName(file.text, 'id3-geob.bin'),
    });
  } else if (id === 'PRIV') {
    const owner = readString(body, 0, 0);
    const data = body.subarray(owner.next);
    meta(id, `${owner.text} · ${data.length} B`);
    out.payloads.push({
      where: T('where.frame', { version, id: `${id} ${owner.text}` }),
      offset,
      data: data.slice(),
      name: `id3-priv-${safeName(owner.text, 'owner')}.bin`,
    });
  } else if (KNOWN_BINARY.has(id)) {
    meta(id, T('frame.binary', { size: body.length }));
  } else {
    // Not a frame of the specification: someone's own frame, a good place to hide something.
    meta(id, T('frame.custom', { size: body.length, text: oneLine(bytesToText(body), 120) }));
    addBlob(out, {
      where: T('where.custom', { version, id }),
      offset,
      data: body.slice(),
      name: `id3-${safeName(id, 'frame')}.bin`,
    });
  }
}

/** Parse the frames of one tag. `base` is where `b` starts in the whole file. */
export function parseId3v2(b: Uint8Array, o: number, base = 0): Analysis | null {
  if (!hasId3v2(b, o)) return null;
  const version = b[o + 3]!;
  const flags = b[o + 5]!;
  const out = emptyAnalysis('ID3');
  const size = synchsafe(b, o + 6);
  const footer = flags & 0x10 && version >= 4 ? 10 : 0;
  const end = Math.min(b.length, o + 10 + size);
  let body = b.subarray(o + 10, end);
  if (flags & 0x80 && version < 4) body = deunsync(body);
  let p = 0;
  if (flags & 0x40) {
    // Extended header: v2.3 size excludes the size field itself, v2.4 includes it.
    p = version === 4 ? synchsafe(body, 0) : u32be(body, 0) + 4;
  }
  const head = version === 2 ? 6 : 10;
  const frames: Frame[] = [];
  let problem: string | null = null;
  while (p + head <= body.length) {
    if (body[p] === 0) break; // padding
    const id = latin1Decode(body.subarray(p, p + (version === 2 ? 3 : 4)));
    if (!/^[A-Z0-9]+$/.test(id)) {
      problem = T('id3.badFrame', { offset: base + o + 10 + p });
      break;
    }
    let len: number;
    let fl = 0;
    if (version === 2) len = (body[p + 3]! << 16) | (body[p + 4]! << 8) | body[p + 5]!;
    else {
      len = version === 4 && isSynchsafe(body, p + 4) ? synchsafe(body, p + 4) : u32be(body, p + 4);
      fl = u16be(body, p + 8);
    }
    if (p + head + len > body.length) {
      problem = T('id3.frameTooLong', { id, size: len });
      break;
    }
    let data = body.subarray(p + head, p + head + len);
    if (version === 4 && fl & 0x01) data = data.subarray(4); // data length indicator
    if (version === 4 && fl & 0x02) data = deunsync(data);
    frames.push({ id, body: data, offset: base + o + 10 + p, flags: fl });
    p += head + len;
  }
  for (const f of frames) {
    const packed = version === 3 ? f.flags & 0xc0 : version === 4 ? f.flags & 0x0c : 0;
    if (packed) {
      out.meta.push({
        source: 'ID3v2',
        name: f.id,
        value: T('frame.packed', { size: f.body.length }),
      });
      out.payloads.push({
        where: T('where.frame', { version, id: f.id }),
        offset: f.offset,
        data: f.body.slice(),
        name: `id3-${safeName(f.id, 'frame')}.bin`,
      });
    } else describeFrame(f.id, f.body, f.offset, version, out);
  }
  const padding = body.subarray(p);
  if (problem) out.notes.push({ level: 'warn', text: problem });
  if (padding.length && !isZero(padding)) {
    addBlob(out, {
      where: T(problem ? 'where.id3rest' : 'where.id3padding', { version }),
      offset: base + o + 10 + p,
      data: padding.slice(),
      name: 'id3-padding.bin',
    });
  }
  out.rows.push({
    offset: base + o,
    name: `ID3v2.${version}`,
    size: 10 + size + footer,
    what: T('id3.tag', { frames: frames.length, padding: padding.length }),
  });
  return out;
}

// ---------- ID3v1 ----------

const GENRES =
  'Blues,Classic Rock,Country,Dance,Disco,Funk,Grunge,Hip-Hop,Jazz,Metal,New Age,Oldies,Other,Pop,R&B,Rap,Reggae,Rock,Techno,Industrial,Alternative,Ska,Death Metal,Pranks,Soundtrack,Euro-Techno,Ambient,Trip-Hop,Vocal,Jazz+Funk,Fusion,Trance,Classical,Instrumental,Acid,House,Game,Sound Clip,Gospel,Noise,AlternRock,Bass,Soul,Punk,Space,Meditative,Instrumental Pop,Instrumental Rock,Ethnic,Gothic,Darkwave,Techno-Industrial,Electronic,Pop-Folk,Eurodance,Dream,Southern Rock,Comedy,Cult,Gangsta,Top 40,Christian Rap,Pop/Funk,Jungle,Native American,Cabaret,New Wave,Psychadelic,Rave,Showtunes,Trailer,Lo-Fi,Tribal,Acid Punk,Acid Jazz,Polka,Retro,Musical,Rock & Roll,Hard Rock'.split(
    ',',
  );

const field = (b: Uint8Array, o: number, n: number): string => {
  const raw = b.subarray(o, o + n);
  const end = raw.indexOf(0);
  return bytesToText(end < 0 ? raw : raw.subarray(0, end)).trimEnd();
};

/** The 128-byte ID3v1 / v1.1 tag at `o`, with the "TAG+" extension just before it if present. */
export function parseId3v1(b: Uint8Array, o: number): Analysis | null {
  if (o < 0 || o + 128 > b.length || fourCC(b, o).slice(0, 3) !== 'TAG') return null;
  const out = emptyAnalysis('ID3');
  const add = (name: string, value: string) => {
    if (value) out.meta.push({ source: 'ID3v1', name, value: oneLine(value, 200) });
  };
  add('title', field(b, o + 3, 30));
  add('artist', field(b, o + 33, 30));
  add('album', field(b, o + 63, 30));
  add('year', field(b, o + 93, 4));
  const v11 = b[o + 125] === 0 && b[o + 126] !== 0;
  add('comment', field(b, o + 97, v11 ? 28 : 30));
  if (v11) add('track', String(b[o + 126]));
  const genre = b[o + 127]!;
  if (genre !== 255) add('genre', GENRES[genre] ? `${GENRES[genre]} (${genre})` : String(genre));
  let start = o;
  const ext = o - 227;
  if (ext >= 0 && fourCC(b, ext) === 'TAG+') {
    start = ext;
    add('title (TAG+)', field(b, ext + 4, 60));
    add('artist (TAG+)', field(b, ext + 64, 60));
    add('album (TAG+)', field(b, ext + 124, 60));
  }
  out.rows.push({
    offset: start,
    name: start === o ? (v11 ? 'ID3v1.1' : 'ID3v1') : 'ID3v1 + TAG+',
    size: 128 + (o - start),
    what: T('id3.v1'),
  });
  return out;
}
