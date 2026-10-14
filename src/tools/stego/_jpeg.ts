import { toolT } from '../../i18n/tool-text';
import { latin1Decode, u16be, utf8Decode } from '../../lib/bytes';

/** Text shown by Image structure and Image analyzer: it lives under the image-structure keys. */
const T = toolT('image-structure');

export interface JpegSegment {
  index: number;
  /** Offset of the 0xFF that starts the marker. */
  offset: number;
  marker: number;
  name: string;
  /** Bytes from the marker up to the end of the header (and of the entropy data for SOS). */
  length: number;
  /** Payload start (after the 2-byte length field); equals offset + 2 for standalone markers. */
  dataStart: number;
  /** Payload length without the length field. */
  dataLength: number;
  /** SOS only: bytes of entropy-coded data after the scan header. */
  scanLength: number;
}

export interface JpegParse {
  segments: JpegSegment[];
  /** Offset just after the first top-level EOI (FFD9), or null if there is none. */
  end: number | null;
  problems: string[];
}

export function markerName(m: number): string {
  if (m >= 0xe0 && m <= 0xef) return `APP${m - 0xe0}`;
  if (m >= 0xd0 && m <= 0xd7) return `RST${m - 0xd0}`;
  if (m >= 0xf0 && m <= 0xfd) return `JPG${m - 0xf0}`;
  const fixed: Record<number, string> = {
    0x01: 'TEM',
    0xc4: 'DHT',
    0xc8: 'JPG',
    0xcc: 'DAC',
    0xd8: 'SOI',
    0xd9: 'EOI',
    0xda: 'SOS',
    0xdb: 'DQT',
    0xdc: 'DNL',
    0xdd: 'DRI',
    0xde: 'DHP',
    0xdf: 'EXP',
    0xfe: 'COM',
  };
  if (fixed[m]) return fixed[m];
  if (m >= 0xc0 && m <= 0xcf) return `SOF${m - 0xc0}`;
  return `0x${m.toString(16).toUpperCase()}`;
}

const SOF_DESCRIPTIONS: Record<number, () => string> = {
  0xc0: () => T('sof.c0'),
  0xc1: () => T('sof.c1'),
  0xc2: () => T('sof.c2'),
  0xc3: () => T('sof.c3'),
  0xc5: () => T('sof.c5'),
  0xc6: () => T('sof.c6'),
  0xc7: () => T('sof.c7'),
  0xc9: () => T('sof.c9'),
  0xca: () => T('sof.ca'),
  0xcb: () => T('sof.cb'),
};

/** Coding process of a start-of-frame marker ("baseline DCT"...), or undefined. */
export const sofDescription = (marker: number): string | undefined => SOF_DESCRIPTIONS[marker]?.();

export const isSof = (m: number) =>
  m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;

/** Walk the marker segments of a JPEG. Returns null if it does not start with FFD8. */
export function parseJpeg(b: Uint8Array): JpegParse | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  const segments: JpegSegment[] = [];
  const problems: string[] = [];
  let end: number | null = null;
  const push = (
    offset: number,
    marker: number,
    length: number,
    dataStart: number,
    dataLength: number,
    scanLength = 0,
  ) => {
    segments.push({
      index: segments.length,
      offset,
      marker,
      name: markerName(marker),
      length,
      dataStart,
      dataLength,
      scanLength,
    });
  };
  push(0, 0xd8, 2, 2, 0);
  let off = 2;
  while (off < b.length) {
    if (b[off] !== 0xff) {
      // Garbage between segments: resync on the next real marker.
      let next = off;
      while (
        next + 1 < b.length &&
        !(b[next] === 0xff && b[next + 1] !== 0 && b[next + 1] !== 0xff)
      ) {
        next++;
      }
      problems.push(T('problem.jpegStray', { count: next - off, offset: off }));
      if (next + 1 >= b.length) break;
      off = next;
    }
    while (b[off + 1] === 0xff) off++; // fill bytes
    const marker = b[off + 1];
    if (marker === undefined) break;
    if (marker === 0xd9) {
      push(off, marker, 2, off + 2, 0);
      end = off + 2;
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      push(off, marker, 2, off + 2, 0);
      off += 2;
      continue;
    }
    if (off + 4 > b.length) {
      problems.push(T('problem.jpegEnds', { marker: markerName(marker), offset: off }));
      break;
    }
    const length = u16be(b, off + 2);
    if (length < 2 || off + 2 + length > b.length) {
      problems.push(
        T('problem.jpegLength', { marker: markerName(marker), offset: off, count: length }),
      );
      push(off, marker, b.length - off, off + 4, Math.max(0, b.length - off - 4));
      break;
    }
    if (marker === 0xda) {
      let i = off + 2 + length;
      while (i < b.length) {
        if (b[i] !== 0xff) {
          i++;
          continue;
        }
        const n = b[i + 1];
        if (n === 0x00 || (n !== undefined && n >= 0xd0 && n <= 0xd7)) i += 2;
        else if (n === 0xff) i++;
        else break;
      }
      push(off, marker, i - off, off + 4, length - 2, i - (off + 2 + length));
      off = i;
      continue;
    }
    push(off, marker, 2 + length, off + 4, length - 2);
    off += 2 + length;
  }
  if (end === null) problems.push(T('problem.jpegNoEoi'));
  return { segments, end, problems };
}

/** Identifier string at the start of an APPn payload ("JFIF", "Exif", "ICC_PROFILE"...). */
export function appIdentifier(b: Uint8Array, seg: JpegSegment): string {
  const stop = Math.min(seg.dataStart + seg.dataLength, seg.dataStart + 40);
  let i = seg.dataStart;
  while (i < stop && b[i] !== 0) i++;
  return latin1Decode(b.subarray(seg.dataStart, i)).replace(/[^\x20-\x7e]/g, '?');
}

/** Text of a COM segment (UTF-8 when valid, else Latin-1). */
export function commentText(b: Uint8Array, seg: JpegSegment): string {
  const payload = b.subarray(seg.dataStart, seg.dataStart + seg.dataLength);
  const utf8 = utf8Decode(payload);
  return utf8.includes('�') ? latin1Decode(payload) : utf8;
}

export function jpegComments(b: Uint8Array, parsed: JpegParse): string[] {
  return parsed.segments.filter((s) => s.marker === 0xfe).map((s) => commentText(b, s));
}
