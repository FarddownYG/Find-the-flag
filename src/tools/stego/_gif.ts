import { latin1Decode, u16le, concatBytes } from '../../lib/bytes';

export interface GifBlock {
  offset: number;
  /** Total bytes of the block. */
  length: number;
  kind: string;
  detail: string;
}

export interface GifApp {
  id: string;
  auth: string;
  data: Uint8Array;
}

export interface GifParse {
  version: string;
  width: number;
  height: number;
  gctSize: number;
  background: number;
  aspect: number;
  frames: number;
  blocks: GifBlock[];
  comments: string[];
  apps: GifApp[];
  /** Frame delays in 1/100 s, from graphic control extensions. */
  delays: number[];
  loops: number | null;
  transparentIndex: number | null;
  /** Offset just after the 0x3B trailer, or null if it is missing. */
  trailerEnd: number | null;
  problems: string[];
}

function readSubBlocks(
  b: Uint8Array,
  start: number,
): { data: Uint8Array; next: number; ok: boolean; count: number } {
  const parts: Uint8Array[] = [];
  let pos = start;
  let count = 0;
  for (;;) {
    if (pos >= b.length) return { data: concatBytes(...parts), next: b.length, ok: false, count };
    const size = b[pos]!;
    pos++;
    if (size === 0) return { data: concatBytes(...parts), next: pos, ok: true, count };
    if (pos + size > b.length) {
      parts.push(b.subarray(pos));
      return { data: concatBytes(...parts), next: b.length, ok: false, count };
    }
    parts.push(b.subarray(pos, pos + size));
    count++;
    pos += size;
  }
}

export function parseGif(b: Uint8Array): GifParse | null {
  if (b.length < 13 || b[0] !== 0x47 || b[1] !== 0x49 || b[2] !== 0x46) return null;
  const version = latin1Decode(b.subarray(0, 6));
  const packed = b[10]!;
  const gctSize = packed & 0x80 ? 3 * (1 << ((packed & 7) + 1)) : 0;
  const out: GifParse = {
    version,
    width: u16le(b, 6),
    height: u16le(b, 8),
    gctSize: gctSize / 3,
    background: b[11]!,
    aspect: b[12]!,
    frames: 0,
    blocks: [
      { offset: 0, length: 6, kind: 'Header', detail: version },
      {
        offset: 6,
        length: 7,
        kind: 'Logical screen',
        detail: `${u16le(b, 6)}x${u16le(b, 8)}, ${gctSize / 3 || 'no'} global colours, background index ${b[11]}`,
      },
    ],
    comments: [],
    apps: [],
    delays: [],
    loops: null,
    transparentIndex: null,
    trailerEnd: null,
    problems: [],
  };
  let pos = 13;
  if (gctSize) {
    out.blocks.push({
      offset: pos,
      length: gctSize,
      kind: 'Global colour table',
      detail: `${gctSize / 3} colours`,
    });
    pos += gctSize;
  }
  while (pos < b.length) {
    const start = pos;
    const introducer = b[pos]!;
    if (introducer === 0x3b) {
      out.blocks.push({ offset: pos, length: 1, kind: 'Trailer', detail: 'end of GIF' });
      out.trailerEnd = pos + 1;
      return out;
    }
    if (introducer === 0x21) {
      const label = b[pos + 1];
      if (label === undefined) break;
      pos += 2;
      const sub = readSubBlocks(b, pos);
      pos = sub.next;
      const len = pos - start;
      if (!sub.ok) out.problems.push(`Extension at offset ${start} is cut off.`);
      if (label === 0xf9 && sub.data.length >= 4) {
        const delay = u16le(sub.data, 1);
        out.delays.push(delay);
        const disposal = (sub.data[0]! >> 2) & 7;
        const transparent = sub.data[0]! & 1 ? sub.data[3]! : null;
        if (transparent !== null) out.transparentIndex = transparent;
        out.blocks.push({
          offset: start,
          length: len,
          kind: 'Graphic control',
          detail: `delay ${delay / 100}s, disposal ${disposal}${transparent !== null ? `, transparent index ${transparent}` : ''}`,
        });
      } else if (label === 0xfe) {
        const text = latin1Decode(sub.data);
        out.comments.push(text);
        out.blocks.push({
          offset: start,
          length: len,
          kind: 'Comment',
          detail: `${sub.data.length} bytes: ${text.slice(0, 60).replace(/[^\x20-\x7e]/g, '·')}`,
        });
      } else if (label === 0xff) {
        const id = latin1Decode(sub.data.subarray(0, 8));
        const auth = latin1Decode(sub.data.subarray(8, 11));
        const data = sub.data.subarray(11);
        out.apps.push({ id, auth, data });
        if (id === 'NETSCAPE' && data[0] === 1 && data.length >= 3) out.loops = u16le(data, 1);
        out.blocks.push({
          offset: start,
          length: len,
          kind: 'Application',
          detail: `${id}${auth} (${data.length} bytes)`,
        });
      } else if (label === 0x01) {
        out.blocks.push({
          offset: start,
          length: len,
          kind: 'Plain text',
          detail: latin1Decode(sub.data.subarray(12))
            .slice(0, 60)
            .replace(/[^\x20-\x7e]/g, '·'),
        });
        out.comments.push(latin1Decode(sub.data.subarray(12)));
      } else {
        out.blocks.push({
          offset: start,
          length: len,
          kind: `Extension 0x${label.toString(16)}`,
          detail: `${sub.data.length} bytes`,
        });
      }
      if (!sub.ok) break;
      continue;
    }
    if (introducer === 0x2c) {
      if (pos + 10 > b.length) break;
      const w = u16le(b, pos + 5);
      const h = u16le(b, pos + 7);
      const flags = b[pos + 9]!;
      pos += 10;
      if (flags & 0x80) pos += 3 * (1 << ((flags & 7) + 1));
      pos++; // LZW minimum code size
      const sub = readSubBlocks(b, pos);
      pos = sub.next;
      out.frames++;
      out.blocks.push({
        offset: start,
        length: pos - start,
        kind: `Image ${out.frames}`,
        detail: `${w}x${h} at (${u16le(b, start + 1)},${u16le(b, start + 3)})${flags & 0x40 ? ', interlaced' : ''}${flags & 0x80 ? ', local colours' : ''}, ${sub.data.length} bytes of LZW data`,
      });
      if (!sub.ok) {
        out.problems.push(`Image data at offset ${start} is cut off.`);
        break;
      }
      continue;
    }
    if (introducer === 0x00) {
      // Padding between blocks: harmless, but worth a row.
      let n = 0;
      while (b[pos] === 0) {
        pos++;
        n++;
      }
      out.blocks.push({ offset: start, length: n, kind: 'Padding', detail: `${n} zero byte(s)` });
      continue;
    }
    out.problems.push(
      `Unknown block 0x${introducer.toString(16)} at offset ${pos}: the rest is not parsed.`,
    );
    break;
  }
  if (out.trailerEnd === null)
    out.problems.push('No GIF trailer (0x3B): the file is truncated or has unparsed data.');
  return out;
}
