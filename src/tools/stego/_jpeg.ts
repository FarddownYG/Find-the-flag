import { latin1Decode, u16be, utf8Decode } from '../../lib/bytes';

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

export const SOF_DESCRIPTIONS: Record<number, string> = {
  0xc0: 'baseline DCT',
  0xc1: 'extended sequential DCT',
  0xc2: 'progressive DCT',
  0xc3: 'lossless',
  0xc5: 'differential sequential DCT',
  0xc6: 'differential progressive DCT',
  0xc7: 'differential lossless',
  0xc9: 'arithmetic sequential DCT',
  0xca: 'arithmetic progressive DCT',
  0xcb: 'arithmetic lossless',
};

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
      problems.push(`${next - off} stray byte(s) at offset ${off} where a marker should be.`);
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
      problems.push(`File ends inside the ${markerName(marker)} marker at offset ${off}.`);
      break;
    }
    const length = u16be(b, off + 2);
    if (length < 2 || off + 2 + length > b.length) {
      problems.push(
        `${markerName(marker)} segment at offset ${off} claims ${length} bytes but the file is shorter (truncated or corrupt length).`,
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
  if (end === null)
    problems.push('No end-of-image marker (FFD9): the file is truncated or damaged.');
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
