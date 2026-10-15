/**
 * Decoders for the resource types worth reading in a PE: version info, string tables, the
 * manifest, and the icons (rebuilt into .ico files from RT_GROUP_ICON + RT_ICON).
 */
import { printableRatio, toHex } from '../../lib/bytes';
import { Buf, Truncated, latin1, visible } from './_exe-bin';

export interface VersionInfo {
  fileVersion: string;
  productVersion: string;
  strings: [string, string][];
  translations: string[];
}

interface VsNode {
  key: string;
  type: number;
  valueLen: number;
  value: Uint8Array;
  children: VsNode[];
}

const al4 = (n: number) => (n + 3) & ~3;

/** One VS_VERSIONINFO-style node (and its children) at `o`; null when it does not fit. */
function vsNode(b: Buf, o: number, depth: number): { node: VsNode; end: number } | null {
  if (depth > 4 || !b.has(o, 6)) return null;
  const len = b.u16(o);
  const valueLen = b.u16(o + 2);
  const type = b.u16(o + 4);
  if (len < 6 || !b.has(o, len)) return null;
  let p = o + 6;
  let key = '';
  while (p + 2 <= o + len) {
    const c = b.u16(p);
    p += 2;
    if (c === 0) break;
    key += String.fromCharCode(c);
    if (key.length > 64) return null;
  }
  p = o + al4(p - o);
  const valueBytes = type === 1 ? valueLen * 2 : valueLen;
  const value =
    b.has(p, valueBytes) && p + valueBytes <= o + len ? b.slice(p, valueBytes) : new Uint8Array(0);
  p = o + al4(p + valueBytes - o);
  const children: VsNode[] = [];
  while (p + 6 <= o + len) {
    const child = vsNode(b, p, depth + 1);
    if (!child) break;
    children.push(child.node);
    p = o + al4(child.end - o);
  }
  return { node: { key, type, valueLen, value, children }, end: o + len };
}

export function parseVersionInfo(bytes: Uint8Array): VersionInfo | null {
  const b = new Buf(bytes, true);
  try {
    const root = vsNode(b, 0, 0);
    if (!root || root.node.key !== 'VS_VERSION_INFO') return null;
    const out: VersionInfo = { fileVersion: '', productVersion: '', strings: [], translations: [] };
    const v = root.node.value;
    if (v.length >= 20) {
      const f = new Buf(v, true);
      if (f.u32(0) === 0xfeef04bd) {
        const ver = (ms: number, ls: number) =>
          `${ms >>> 16}.${ms & 0xffff}.${ls >>> 16}.${ls & 0xffff}`;
        out.fileVersion = ver(f.u32(8), f.u32(12));
        out.productVersion = ver(f.u32(16), f.u32(20));
      }
    }
    for (const c of root.node.children) {
      if (c.key === 'StringFileInfo') {
        for (const table of c.children) {
          out.translations.push(table.key);
          for (const s of table.children) {
            const text = new Buf(s.value, true);
            let str = '';
            for (let i = 0; i + 2 <= s.value.length; i += 2) {
              const ch = text.u16(i);
              if (ch === 0) break;
              str += String.fromCharCode(ch);
            }
            out.strings.push([s.key, str]);
          }
        }
      }
    }
    return out;
  } catch (e) {
    if (e instanceof Truncated) return null;
    throw e;
  }
}

/** The (id, text) pairs of an RT_STRING block: block `id` holds strings (id-1)*16 .. (id-1)*16+15. */
export function decodeStringTable(bytes: Uint8Array, blockId: number): [number, string][] {
  const b = new Buf(bytes, true);
  const out: [number, string][] = [];
  let o = 0;
  try {
    for (let i = 0; i < 16 && b.has(o, 2); i++) {
      const n = b.u16(o);
      o += 2;
      if (n > 0 && b.has(o, n * 2))
        out.push([(blockId - 1) * 16 + i, visible(b.utf16(o, Math.min(n, 400)), 400)]);
      o += n * 2;
    }
  } catch (e) {
    if (!(e instanceof Truncated)) throw e;
  }
  return out;
}

/** Text of a manifest (UTF-8, or UTF-16 with a byte order mark). */
export function decodeText(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  }
  return new TextDecoder('utf-8').decode(
    bytes[0] === 0xef && bytes[1] === 0xbb ? bytes.subarray(3) : bytes,
  );
}

/** An .ico built from an RT_GROUP_ICON directory and the RT_ICON images it names. */
export function buildIco(group: Uint8Array, icons: Map<number, Uint8Array>): Uint8Array | null {
  const g = new Buf(group, true);
  try {
    if (g.u16(0) !== 0 || g.u16(2) !== 1) return null;
    const count = Math.min(g.u16(4), 64);
    const entries: { head: Uint8Array; data: Uint8Array }[] = [];
    for (let i = 0; i < count; i++) {
      const o = 6 + i * 14;
      const data = icons.get(g.u16(o + 12));
      if (!data) continue;
      entries.push({ head: g.slice(o, 12), data });
    }
    if (entries.length === 0) return null;
    const size = 6 + entries.length * 16 + entries.reduce((a, e) => a + e.data.length, 0);
    const out = new Uint8Array(size);
    const dv = new DataView(out.buffer);
    dv.setUint16(2, 1, true);
    dv.setUint16(4, entries.length, true);
    let off = 6 + entries.length * 16;
    entries.forEach((e, i) => {
      const o = 6 + i * 16;
      out.set(e.head, o);
      dv.setUint32(o + 8, e.data.length, true);
      dv.setUint32(o + 12, off, true);
      out.set(e.data, off);
      off += e.data.length;
    });
    return out;
  } catch (e) {
    if (e instanceof Truncated) return null;
    throw e;
  }
}

/** A short look at a resource: its start as text when it reads as text, else as hex. */
export function previewOf(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';
  const head = bytes.subarray(0, 96);
  if (printableRatio(head) > 0.9) return visible(latin1(head), 48);
  // UTF-16LE text: every other byte is zero
  let zeros = 0;
  for (let i = 1; i < head.length; i += 2) if (head[i] === 0) zeros++;
  if (head.length >= 8 && zeros / (head.length / 2) > 0.8) {
    const text = new TextDecoder('utf-16le').decode(head.subarray(0, head.length & ~1));
    const plain = [...text].filter((c) => c >= ' ' && c <= '~').length;
    if (plain / text.length > 0.9) return visible(text, 48);
  }
  return toHex(bytes.subarray(0, 8), ' ');
}
