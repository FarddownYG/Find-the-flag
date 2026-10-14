import { gunzipSync } from 'fflate';
import { ToolError } from '../../core/errors';
import { u16be, u16le, u32be, u32le } from '../../lib/bytes';

/** One captured frame, still undecoded. */
export interface RawPacket {
  /** 1-based position in the file, like Wireshark's "No." column. */
  no: number;
  /** Seconds since the Unix epoch. */
  time: number;
  /** libpcap LINKTYPE_* of the interface that captured it. */
  link: number;
  /** Interface index inside the pcapng section (0 for classic pcap). */
  iface: number;
  data: Uint8Array;
  /** Length on the wire (>= data.length when the capture was cut by a snap length). */
  origLen: number;
}

export interface Capture {
  /** "pcap (little-endian, microseconds)", "pcapng"... */
  format: string;
  packets: RawPacket[];
  /** Link types in order of appearance. */
  linkTypes: number[];
  /** Records or blocks that were cut off or malformed and therefore skipped. */
  truncated: number;
  /** pcapng blocks we ignore on purpose (statistics, name resolution...). */
  ignoredBlocks: number;
}

const PCAP_MAGICS: Record<number, { le: boolean; ns: boolean }> = {
  0xa1b2c3d4: { le: true, ns: false },
  0xd4c3b2a1: { le: false, ns: false },
  0xa1b23c4d: { le: true, ns: true },
  0x4d3cb2a1: { le: false, ns: true },
};

const PCAPNG_SHB = 0x0a0d0d0a;
/** Anything larger than this in a record header is a damaged length, not a packet. */
const MAX_RECORD = 0x1000000;

export function isGzip(b: Uint8Array): boolean {
  return b.length > 18 && b[0] === 0x1f && b[1] === 0x8b && b[2] === 8;
}

/** True if the first bytes are a libpcap or pcapng file header. */
export function looksLikeCapture(b: Uint8Array): boolean {
  if (b.length < 12) return false;
  return u32le(b, 0) === PCAPNG_SHB || PCAP_MAGICS[u32le(b, 0)] !== undefined;
}

/** Parse a capture file. Throws ToolError when the bytes are not a pcap/pcapng. */
export function readCapture(input: Uint8Array): Capture {
  let bytes = input;
  let gz = false;
  if (isGzip(bytes)) {
    try {
      bytes = gunzipSync(bytes);
      gz = true;
    } catch {
      throw new ToolError('The file is gzip-compressed but could not be decompressed (damaged?).');
    }
  }
  if (bytes.length < 12) {
    throw new ToolError(
      'Input is too short to be a capture. Open a .pcap or .pcapng file (not pasted text).',
    );
  }
  const magic = u32le(bytes, 0);
  const cap =
    magic === PCAPNG_SHB
      ? readPcapng(bytes)
      : PCAP_MAGICS[magic]
        ? readPcap(bytes, PCAP_MAGICS[magic]!)
        : null;
  if (!cap) {
    throw new ToolError(
      'Not a pcap or pcapng file (bad magic bytes). Use File type to check the file, or ' +
        'export the capture from Wireshark as "Wireshark/tcpdump - pcap".',
    );
  }
  if (gz) cap.format += ', gzip-compressed';
  return cap;
}

function readPcap(b: Uint8Array, kind: { le: boolean; ns: boolean }): Capture {
  const u32 = kind.le ? u32le : u32be;
  if (b.length < 24) throw new ToolError('The pcap global header is cut off (needs 24 bytes).');
  const link = u32(b, 20) & 0xffff;
  const snaplen = u32(b, 16);
  const cap: Capture = {
    format: `pcap (${kind.le ? 'little' : 'big'}-endian, ${kind.ns ? 'nanosecond' : 'microsecond'})`,
    packets: [],
    linkTypes: [link],
    truncated: 0,
    ignoredBlocks: 0,
  };
  const div = kind.ns ? 1e9 : 1e6;
  let o = 24;
  while (o + 16 <= b.length) {
    const sec = u32(b, o);
    const frac = u32(b, o + 4);
    const incl = u32(b, o + 8);
    const orig = u32(b, o + 12);
    o += 16;
    if (incl > MAX_RECORD || (snaplen > 0 && incl > Math.max(snaplen, 262144))) {
      cap.truncated++; // damaged record header: nothing after it can be trusted
      return cap;
    }
    if (o + incl > b.length) {
      cap.truncated++;
      return cap;
    }
    cap.packets.push({
      no: cap.packets.length + 1,
      time: sec + frac / div,
      link,
      iface: 0,
      data: b.subarray(o, o + incl),
      origLen: orig,
    });
    o += incl;
  }
  if (o < b.length) cap.truncated++; // a few stray bytes: cut-off record header
  return cap;
}

interface Iface {
  link: number;
  /** Ticks per second. */
  units: number;
  snaplen: number;
}

/** pcapng option TLVs: returns [code, value] pairs until opt_endofopt or the end. */
function readOptions(
  b: Uint8Array,
  start: number,
  end: number,
  u16: (b: Uint8Array, o: number) => number,
): [number, Uint8Array][] {
  const out: [number, Uint8Array][] = [];
  let o = start;
  while (o + 4 <= end) {
    const code = u16(b, o);
    const len = u16(b, o + 2);
    o += 4;
    if (code === 0 || o + len > end) break;
    out.push([code, b.subarray(o, o + len)]);
    o += (len + 3) & ~3;
  }
  return out;
}

function readPcapng(b: Uint8Array): Capture {
  const cap: Capture = {
    format: 'pcapng',
    packets: [],
    linkTypes: [],
    truncated: 0,
    ignoredBlocks: 0,
  };
  let le = true;
  let ifaces: Iface[] = [];
  let sections = 0;
  let stopped = false;
  let o = 0;
  while (o + 12 <= b.length) {
    // The byte order is only known after the Section Header Block, which is palindromic.
    const isShb = u32le(b, o) === PCAPNG_SHB;
    if (isShb) {
      const bom = u32le(b, o + 8);
      if (bom === 0x1a2b3c4d) le = true;
      else if (bom === 0x4d3c2b1a) le = false;
      else {
        cap.truncated++;
        stopped = true;
        break;
      }
      ifaces = [];
      sections++;
    }
    const u32 = le ? u32le : u32be;
    const u16 = le ? u16le : u16be;
    const type = isShb ? PCAPNG_SHB : u32(b, o);
    const len = u32(b, o + 4);
    if (len < 12 || len % 4 !== 0 || len > MAX_RECORD * 16) {
      cap.truncated++; // damaged block length: resynchronising is not possible
      stopped = true;
      break;
    }
    if (o + len > b.length) {
      cap.truncated++;
      stopped = true;
      break;
    }
    const body = o + 8;
    const bodyEnd = o + len - 4;
    switch (type) {
      case PCAPNG_SHB:
        if (sections === 1) cap.format = `pcapng (${le ? 'little' : 'big'}-endian)`;
        break;
      case 1: {
        // Interface Description Block
        if (bodyEnd - body < 8) {
          cap.truncated++;
          break;
        }
        const link = u16(b, body);
        const snaplen = u32(b, body + 4);
        let units = 1e6;
        for (const [code, val] of readOptions(b, body + 8, bodyEnd, u16)) {
          if (code === 9 && val.length >= 1) {
            const r = val[0]!;
            units = r & 0x80 ? 2 ** (r & 0x7f) : 10 ** Math.min(r, 18);
          }
        }
        ifaces.push({ link, units, snaplen });
        if (!cap.linkTypes.includes(link)) cap.linkTypes.push(link);
        break;
      }
      case 6: {
        // Enhanced Packet Block
        if (bodyEnd - body < 20) {
          cap.truncated++;
          break;
        }
        const id = u32(b, body);
        const hi = u32(b, body + 4);
        const lo = u32(b, body + 8);
        const incl = u32(b, body + 12);
        const orig = u32(b, body + 16);
        const iface = ifaces[id];
        if (!iface || body + 20 + incl > bodyEnd) {
          cap.truncated++;
          break;
        }
        cap.packets.push({
          no: cap.packets.length + 1,
          time: (hi * 4294967296 + lo) / iface.units,
          link: iface.link,
          iface: id,
          data: b.subarray(body + 20, body + 20 + incl),
          origLen: orig,
        });
        break;
      }
      case 3: {
        // Simple Packet Block: always interface 0, no timestamp
        const iface = ifaces[0];
        if (!iface || bodyEnd - body < 4) {
          cap.truncated++;
          break;
        }
        const orig = u32(b, body);
        const incl = Math.min(orig, bodyEnd - body - 4, iface.snaplen || Infinity);
        cap.packets.push({
          no: cap.packets.length + 1,
          time: 0,
          link: iface.link,
          iface: 0,
          data: b.subarray(body + 4, body + 4 + incl),
          origLen: orig,
        });
        break;
      }
      default:
        cap.ignoredBlocks++;
    }
    o += len;
  }
  if (!stopped && o < b.length) cap.truncated++; // stray bytes after the last block
  return cap;
}
