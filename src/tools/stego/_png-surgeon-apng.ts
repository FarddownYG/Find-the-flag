/**
 * APNG (animated PNG) awareness for the PNG chunk surgeon: decode the animation control chunks,
 * rebuild each frame as a standalone PNG, and read the per-frame numeric fields as a possible
 * hidden channel.
 *
 * A whole family of stego challenges hides a message not in the pixels but in APNG metadata: one
 * ASCII byte per frame carried by `delay_num` (or an offset, a size, a dispose/blend op...), while
 * the visible frames are a decoy and every `fcTL` CRC is deliberately broken so strict viewers
 * reject the file. The surgeon already parses tolerantly and repairs the CRCs; this adds the
 * decoding that turns those numbers back into text.
 *
 * Pure data helpers — no i18n, no Output. The tool file turns the results into table/note/picture.
 */
import { crc32 } from './_crc32';
import { PNG_SIGNATURE } from './_png';
import type { SurgeonChunk } from './_png-surgeon-parse';

const u32 = (d: Uint8Array, o: number): number =>
  ((d[o]! << 24) | (d[o + 1]! << 16) | (d[o + 2]! << 8) | d[o + 3]!) >>> 0;
const u16 = (d: Uint8Array, o: number): number => (d[o]! << 8) | d[o + 1]!;

export interface Actl {
  numFrames: number;
  numPlays: number;
}

/** Decode an acTL chunk (num_frames, num_plays); null if it is too short. */
export function decodeActl(data: Uint8Array): Actl | null {
  if (data.length < 8) return null;
  return { numFrames: u32(data, 0), numPlays: u32(data, 4) };
}

export interface Fctl {
  sequence: number;
  width: number;
  height: number;
  xOffset: number;
  yOffset: number;
  delayNum: number;
  delayDen: number;
  disposeOp: number;
  blendOp: number;
}

/** Decode an fcTL chunk (frame control); null if it is too short. */
export function decodeFctl(data: Uint8Array): Fctl | null {
  if (data.length < 26) return null;
  return {
    sequence: u32(data, 0),
    width: u32(data, 4),
    height: u32(data, 8),
    xOffset: u32(data, 12),
    yOffset: u32(data, 16),
    delayNum: u16(data, 20),
    delayDen: u16(data, 22),
    disposeOp: data[24]!,
    blendOp: data[25]!,
  };
}

/** Does the file carry APNG animation control? (An acTL chunk is enough to treat it as one.) */
export const isApng = (chunks: SurgeonChunk[]): boolean => chunks.some((c) => c.type === 'acTL');

const typeBytes = (type: string): number[] => [...type].map((c) => c.charCodeAt(0));

/** Build one `length|type|data|crc` PNG chunk, with the CRC recomputed. */
function writeChunk(type: string, data: Uint8Array): Uint8Array {
  const body = new Uint8Array(4 + data.length);
  body.set(typeBytes(type), 0);
  body.set(data, 4);
  const out = new Uint8Array(8 + data.length + 4);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(body, 4);
  dv.setUint32(8 + data.length, crc32(body));
  return out;
}

const concat = (parts: Uint8Array[]): Uint8Array => {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

export interface ApngFrame {
  /** 0-based position in the file's frame list. */
  index: number;
  /** The frame's fcTL, or null for a default image that has no fcTL of its own. */
  fctl: Fctl | null;
  /** The frame rebuilt as a standalone, valid PNG. */
  png: Uint8Array;
  /** Number of IDAT/fdAT chunks that fed this frame. */
  dataChunks: number;
  /** True for the default image (IDAT data), false for an animation frame (fdAT data). */
  isDefault: boolean;
}

/**
 * Rebuild every APNG frame as its own PNG. Each frame is the base IHDR resized to the fcTL, any
 * palette chunks copied over, then the frame's image data as a single IDAT. fdAT payloads drop
 * their 4-byte sequence number; IDAT payloads are used as-is (they are the default image).
 *
 * Frames are delimited by fcTL. `maxFrames` and `maxBytes` bound the work so a crafted file cannot
 * freeze the tab. No decompression happens here — the compressed stream is copied verbatim.
 */
export function apngFrames(
  chunks: SurgeonChunk[],
  ihdrData: Uint8Array,
  opts: { maxFrames?: number; maxBytes?: number } = {},
): ApngFrame[] {
  const maxFrames = opts.maxFrames ?? 512;
  const maxBytes = opts.maxBytes ?? 64 << 20;
  if (ihdrData.length < 13) return [];

  // Palette chunks that sit before the first IDAT belong to every frame.
  const palette: Uint8Array[] = [];
  for (const c of chunks) {
    if (c.type === 'IDAT' || c.type === 'fcTL' || c.type === 'fdAT' || c.type === 'IEND') break;
    if (c.type === 'PLTE' || c.type === 'tRNS') palette.push(writeChunk(c.type, c.data));
  }

  const baseW = u32(ihdrData, 0);
  const baseH = u32(ihdrData, 4);
  const frames: ApngFrame[] = [];
  let bytes = 0;

  let curFctl: Fctl | null = null;
  let curData: Uint8Array[] = [];
  let curDefault = false;
  let seenFctl = false;

  const flush = (): void => {
    if (!curData.length) return;
    if (frames.length >= maxFrames) {
      curData = [];
      return;
    }
    const ihdr = ihdrData.slice(0, 13);
    const dv = new DataView(ihdr.buffer, ihdr.byteOffset, 13);
    dv.setUint32(0, curFctl ? curFctl.width : baseW);
    dv.setUint32(4, curFctl ? curFctl.height : baseH);
    const png = concat([
      Uint8Array.from(PNG_SIGNATURE),
      writeChunk('IHDR', ihdr),
      ...palette,
      writeChunk('IDAT', concat(curData)),
      writeChunk('IEND', new Uint8Array(0)),
    ]);
    bytes += png.length;
    if (bytes <= maxBytes) {
      frames.push({
        index: frames.length,
        fctl: curFctl,
        png,
        dataChunks: curData.length,
        isDefault: curDefault,
      });
    }
    curData = [];
  };

  for (const c of chunks) {
    if (c.afterIend) continue;
    if (c.type === 'fcTL') {
      flush();
      curFctl = decodeFctl(c.data);
      curDefault = false;
      seenFctl = true;
    } else if (c.type === 'IDAT') {
      if (!seenFctl) {
        curDefault = true;
        curFctl = null;
      }
      curData.push(c.data);
    } else if (c.type === 'fdAT') {
      // fdAT = 4-byte sequence number + frame data; keep only the frame data.
      curData.push(c.data.length >= 4 ? c.data.subarray(4) : c.data);
    } else if (c.type === 'IEND') {
      break;
    }
  }
  flush();
  return frames;
}

// ---------------------------------------------------------------- hidden channels

export type ChannelKind = 'byte' | 'lowByte' | 'bits' | 'nibbles';

export interface ChannelDecode {
  kind: ChannelKind;
  text: string;
  /** Fraction of characters in the printable ASCII range (0x20–0x7e). */
  printable: number;
}

export interface Channel {
  /** Field name key: 'sequence' | 'width' | ... matching Fctl keys. */
  field: string;
  values: number[];
  decodes: ChannelDecode[];
  /** The most readable decode, if any passed the readability bar. */
  lead: ChannelDecode | null;
}

const isPrintable = (code: number): boolean => code >= 0x20 && code <= 0x7e;

function printableRatio(text: string): number {
  if (!text.length) return 0;
  let ok = 0;
  for (let i = 0; i < text.length; i++) if (isPrintable(text.charCodeAt(i))) ok++;
  return ok / text.length;
}

const toText = (codes: number[]): string =>
  codes.map((c) => String.fromCharCode(c & 0xff)).join('');

/**
 * A decode worth surfacing: at least 3 chars, mostly printable, some letters or digits, and more
 * than one distinct character (so a constant field decoding to "DDDD…" is not mistaken for text).
 */
const readable = (d: ChannelDecode): boolean =>
  d.text.length >= 3 &&
  d.printable >= 0.85 &&
  /[A-Za-z0-9]/.test(d.text) &&
  new Set(d.text).size >= 2;

/** All the ways a per-frame numeric series might spell out text. */
function decodesFor(values: number[]): ChannelDecode[] {
  const out: ChannelDecode[] = [];
  const add = (kind: ChannelKind, text: string): void => {
    if (text.length) out.push({ kind, text, printable: printableRatio(text) });
  };
  if (values.every((v) => v >= 0 && v <= 255)) {
    add('byte', toText(values));
  } else {
    add('lowByte', toText(values.map((v) => v & 0xff)));
  }
  if (values.length >= 8 && values.every((v) => v === 0 || v === 1)) {
    const codes: number[] = [];
    for (let i = 0; i + 8 <= values.length; i += 8) {
      let b = 0;
      for (let k = 0; k < 8; k++) b = (b << 1) | values[i + k]!;
      codes.push(b);
    }
    add('bits', toText(codes));
  }
  if (values.length >= 2 && values.every((v) => v >= 0 && v <= 15)) {
    const codes: number[] = [];
    for (let i = 0; i + 2 <= values.length; i += 2) codes.push((values[i]! << 4) | values[i + 1]!);
    add('nibbles', toText(codes));
  }
  // Keep each distinct text once, best (most printable, then longest) first.
  const seen = new Set<string>();
  return out
    .sort((a, b) => b.printable - a.printable || b.text.length - a.text.length)
    .filter((d) => (seen.has(d.text) ? false : (seen.add(d.text), true)));
}

const FIELDS: (keyof Fctl)[] = [
  'delayNum',
  'delayDen',
  'xOffset',
  'yOffset',
  'width',
  'height',
  'disposeOp',
  'blendOp',
  'sequence',
];

/**
 * Read every fcTL numeric field across the frames as a series and try to decode each one. Channels
 * whose series spells readable text come back marked (lead set) and sorted to the front.
 */
export function hiddenChannels(fctls: Fctl[]): Channel[] {
  if (fctls.length < 2) return [];
  const channels: Channel[] = FIELDS.map((field) => {
    const values = fctls.map((f) => f[field]);
    const decodes = decodesFor(values);
    // A constant field carries no message; only a varying series can be a channel.
    const varies = new Set(values).size >= 2;
    const lead = varies ? (decodes.find(readable) ?? null) : null;
    return { field, values, decodes, lead };
  });
  return channels.sort((a, b) => {
    const pa = a.lead?.printable ?? -1;
    const pb = b.lead?.printable ?? -1;
    return pb - pa || (b.lead?.text.length ?? 0) - (a.lead?.text.length ?? 0);
  });
}
