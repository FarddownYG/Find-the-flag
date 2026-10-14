/**
 * ISO 9660 (ECMA-119) reader: volume descriptors, the directory tree with file versions and
 * dates, Joliet names (UCS-2 in a supplementary descriptor) and Rock Ridge NM names.
 * Works on any SectorReader, so cooked ISOs and raw 2352-byte BINs read the same.
 */
import { latin1Decode, u16le, u32le } from '../../lib/bytes';
import { USER, type SectorReader } from './_cd';

export interface IsoVolume {
  systemId: string;
  label: string;
  volumeSetId: string;
  publisher: string;
  preparer: string;
  application: string;
  /** Volume space size, in logical blocks. */
  blocks: number;
  blockSize: number;
  created: string;
  modified: string;
  root: { lba: number; size: number };
  joliet: { lba: number; size: number; level: number } | null;
  /** An El Torito boot record is present. */
  boot: boolean;
  /** Volume descriptor types in order (0 boot, 1 primary, 2 supplementary, 3 partition). */
  descriptors: number[];
}

export interface IsoEntry {
  path: string;
  size: number;
  date: string;
  lba: number;
  dir: boolean;
  hidden: boolean;
  /** Extents of a multi-extent file, in order (one for normal files). */
  extents: { lba: number; size: number }[];
}

export type NameSource = 'rockridge' | 'joliet' | 'iso';

export interface IsoListing {
  entries: IsoEntry[];
  names: NameSource;
  /** Listing stopped at the entry cap. */
  capped: boolean;
  /** Directories that pointed outside the image or back up the tree. */
  badDirs: number;
}

const trimText = (s: string) => s.replace(/[\s\0]+$/, '');
const aText = (b: Uint8Array, o: number, n: number) => trimText(latin1Decode(b.subarray(o, o + n)));

function ucs2be(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i]! << 8) | b[i + 1]!);
  return s;
}

/** "YYYYMMDDHHMMSScc" + offset (17 bytes) as "YYYY-MM-DD HH:MM:SS", "" when unset. */
function decDate(b: Uint8Array, o: number): string {
  const s = latin1Decode(b.subarray(o, o + 16));
  if (!/^\d{16}$/.test(s) || s.startsWith('0000')) return '';
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)} ${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}${tz(b[o + 16]!)}`;
}

/** Offset from GMT in 15-minute steps (signed byte) as " UTC+hh:mm"; nothing for UTC. */
function tz(v: number): string {
  const q = v > 127 ? v - 256 : v;
  if (q === 0) return '';
  const m = Math.abs(q) * 15;
  return ` UTC${q < 0 ? '-' : '+'}${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** 7-byte recording date of a directory record. */
function recDate(b: Uint8Array, o: number): string {
  if (b[o] === 0 && b[o + 1] === 0) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${1900 + b[o]!}-${p(b[o + 1]!)}-${p(b[o + 2]!)} ${p(b[o + 3]!)}:${p(b[o + 4]!)}:${p(b[o + 5]!)}${tz(b[o + 6]!)}`;
}

const u32be = (b: Uint8Array, o: number) =>
  ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;

/** Both-endian fields agree (or the big-endian copy is left at zero), sizes make sense. */
function plausiblePvd(d: Uint8Array): boolean {
  const blocks = u32le(d, 80);
  const blockSize = u16le(d, 128);
  const be = (le: number, v: number) => v === le || v === 0;
  return (
    blocks > 16 &&
    be(blocks, u32be(d, 84)) &&
    [512, 1024, 2048, 4096].includes(blockSize) &&
    be(blockSize, (d[130]! << 8) | d[131]!) &&
    d[156]! >= 34
  );
}

/** Volume descriptors from sector 16 up to the terminator. */
export async function readIsoVolume(r: SectorReader): Promise<IsoVolume | null> {
  let vol: IsoVolume | null = null;
  const descriptors: number[] = [];
  let joliet: IsoVolume['joliet'] = null;
  let boot = false;
  for (let lba = 16; lba < 16 + 64 && lba < r.blocks; lba++) {
    const d = await r.read(lba, USER);
    if (d.length < USER || aText(d, 1, 5) !== 'CD001') break;
    const type = d[0]!;
    descriptors.push(type);
    if (type === 255) break;
    if (type === 0 && aText(d, 7, 32).startsWith('EL TORITO')) boot = true;
    // A primary descriptor records its sizes in both byte orders: random bytes that happen to
    // read "CD001" (a fake or damaged descriptor) do not, and are not taken for a volume.
    if (type === 1 && !vol && plausiblePvd(d)) {
      vol = {
        systemId: aText(d, 8, 32),
        label: aText(d, 40, 32),
        volumeSetId: aText(d, 190, 128),
        publisher: aText(d, 318, 128),
        preparer: aText(d, 446, 128),
        application: aText(d, 574, 128),
        blocks: u32le(d, 80),
        blockSize: u16le(d, 128),
        created: decDate(d, 813),
        modified: decDate(d, 830),
        root: { lba: u32le(d, 156 + 2), size: u32le(d, 156 + 10) },
        joliet: null,
        boot: false,
        descriptors: [],
      };
    }
    if (type === 2 && d[88] === 0x25 && d[89] === 0x2f) {
      const level = d[90] === 0x40 ? 1 : d[90] === 0x43 ? 2 : d[90] === 0x45 ? 3 : 0;
      if (level) joliet = { lba: u32le(d, 156 + 2), size: u32le(d, 156 + 10), level };
    }
  }
  if (!vol) return null;
  return { ...vol, joliet, boot, descriptors };
}

interface DirRecord {
  len: number;
  lba: number;
  size: number;
  date: string;
  flags: number;
  name: Uint8Array;
  su: Uint8Array;
}

function parseRecord(b: Uint8Array, p: number): DirRecord | null {
  const len = b[p]!;
  if (len < 34 || p + len > b.length) return null;
  const nameLen = b[p + 32]!;
  if (33 + nameLen > len) return null;
  const suStart = p + 33 + nameLen + (nameLen % 2 === 0 ? 1 : 0);
  return {
    len,
    lba: u32le(b, p + 2),
    size: u32le(b, p + 10),
    date: recDate(b, p + 18),
    flags: b[p + 25]!,
    name: b.subarray(p + 33, p + 33 + nameLen),
    su: b.subarray(Math.min(suStart, p + len), p + len),
  };
}

/** Every directory record of a directory extent (records never cross a sector boundary). */
function records(b: Uint8Array): DirRecord[] {
  const out: DirRecord[] = [];
  let p = 0;
  while (p < b.length) {
    if (b[p] === 0) {
      p = (Math.floor(p / USER) + 1) * USER;
      continue;
    }
    const r = parseRecord(b, p);
    if (!r) {
      p = (Math.floor(p / USER) + 1) * USER;
      continue;
    }
    out.push(r);
    p += r.len;
  }
  return out;
}

/** "README.TXT;1" → "README.TXT"; other versions stay visible ("FLAG.TXT;2"). */
function isoName(raw: string): string {
  let n = raw.endsWith(';1') ? raw.slice(0, -2) : raw;
  n = n.replace(/\.(;\d+)?$/, '$1');
  return n;
}

/** System-use entries (SUSP), following one level of CE continuation. */
async function susp(
  r: SectorReader,
  su: Uint8Array,
  skip: number,
): Promise<[string, Uint8Array][]> {
  const out: [string, Uint8Array][] = [];
  const walk = (b: Uint8Array) => {
    let ce: { lba: number; off: number; len: number } | null = null;
    for (let p = 0; p + 4 <= b.length;) {
      const sig = String.fromCharCode(b[p]!, b[p + 1]!);
      const len = b[p + 2]!;
      if (len < 4 || p + len > b.length) break;
      const data = b.subarray(p, p + len);
      if (sig === 'CE' && len >= 28)
        ce = { lba: u32le(b, p + 4), off: u32le(b, p + 12), len: u32le(b, p + 20) };
      if (sig === 'ST') break;
      out.push([sig, data]);
      p += len;
    }
    return ce;
  };
  let ce = walk(su.subarray(skip));
  for (let hops = 0; ce && hops < 4; hops++) {
    // A continuation area lies inside one logical block (SUSP): anything else is damage, and
    // trusting the 32-bit fields would read (and allocate) the rest of the image.
    if (ce.off >= USER || ce.lba < 0 || ce.lba >= r.blocks) break;
    const len = Math.min(ce.len, USER - ce.off);
    const area: Uint8Array = await r.read(ce.lba, ce.off + len);
    ce = walk(area.subarray(ce.off, ce.off + len));
  }
  return out;
}

/** Rock Ridge alternate name (NM entries, possibly split), or null. */
function rrName(entries: [string, Uint8Array][]): string | null {
  let name = '';
  let seen = false;
  for (const [sig, d] of entries) {
    if (sig !== 'NM' || d.length < 5) continue;
    const flags = d[4]!;
    if (flags & 6) return null; // "." or ".."
    name += latin1Decode(d.subarray(5));
    seen = true;
  }
  return seen ? name : null;
}

const MAX_ENTRIES = 100_000;
const MAX_DIR_BYTES = 16 << 20;

/**
 * Walk the directory tree. Rock Ridge names win when present, then Joliet, then the plain
 * ISO 9660 names (`prefer` forces one).
 */
export async function listIso(
  r: SectorReader,
  vol: IsoVolume,
  prefer?: NameSource,
): Promise<IsoListing> {
  const rootDir = await r.read(vol.root.lba, Math.min(vol.root.size, MAX_DIR_BYTES));
  const self = records(rootDir)[0];
  // Rock Ridge: "SP" in the root's "." record, then an RR / NM / PX entry somewhere.
  let rrSkip = -1;
  if (
    self &&
    self.su.length >= 7 &&
    self.su[0] === 0x53 &&
    self.su[1] === 0x50 &&
    self.su[4] === 0xbe &&
    self.su[5] === 0xef
  ) {
    rrSkip = self.su[6]!;
    const list = await susp(r, self.su, 0);
    if (!list.some(([s]) => s === 'RR' || s === 'NM' || s === 'PX' || s === 'ER')) rrSkip = -1;
  }
  let names: NameSource = rrSkip >= 0 ? 'rockridge' : vol.joliet ? 'joliet' : 'iso';
  if (prefer === 'iso' || (prefer === 'joliet' && vol.joliet)) names = prefer;
  if (prefer === 'rockridge' && rrSkip >= 0) names = 'rockridge';
  const root = names === 'joliet' && vol.joliet ? vol.joliet : vol.root;

  const entries: IsoEntry[] = [];
  const seen = new Set<number>();
  let capped = false;
  let badDirs = 0;
  const walk = async (lba: number, size: number, prefix: string, depth: number): Promise<void> => {
    if (seen.has(lba) || depth > 64 || lba >= r.blocks) {
      badDirs++;
      return;
    }
    seen.add(lba);
    const data = await r.read(lba, Math.min(size, MAX_DIR_BYTES));
    let pending: IsoEntry | null = null;
    for (const rec of records(data)) {
      if (rec.name.length === 1 && (rec.name[0] === 0 || rec.name[0] === 1)) continue;
      if (entries.length >= MAX_ENTRIES) {
        capped = true;
        return;
      }
      let name = names === 'joliet' ? isoName(ucs2be(rec.name)) : isoName(latin1Decode(rec.name));
      if (names === 'rockridge') name = rrName(await susp(r, rec.su, rrSkip)) ?? name;
      const dir = (rec.flags & 2) !== 0;
      const extent = { lba: rec.lba, size: rec.size };
      if (pending && pending.path === `${prefix}${name}`) {
        pending.extents.push(extent);
        pending.size += rec.size;
      } else {
        pending = {
          path: `${prefix}${name}`,
          size: rec.size,
          date: rec.date,
          lba: rec.lba,
          dir,
          hidden: (rec.flags & 1) !== 0,
          extents: [extent],
        };
      }
      // Bit 7: more extents of the same file follow.
      if (rec.flags & 0x80) continue;
      entries.push(pending);
      const done: IsoEntry = pending;
      pending = null;
      if (dir) await walk(done.lba, done.size, `${done.path}/`, depth + 1);
    }
    if (pending) entries.push(pending);
  };
  await walk(root.lba, root.size, '/', 0);
  return { entries, names, capped, badDirs };
}

/** Bytes of one file, extents concatenated. */
export async function readIsoFile(r: SectorReader, e: IsoEntry): Promise<Uint8Array> {
  const parts = await Promise.all(e.extents.map((x) => r.read(x.lba, x.size)));
  if (parts.length === 1) return parts[0]!;
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export async function isoFileBlob(r: SectorReader, e: IsoEntry): Promise<Blob> {
  const parts: Blob[] = [];
  for (const x of e.extents) parts.push(await r.blob(x.lba, x.size));
  return parts.length === 1 ? parts[0]! : new Blob(parts);
}
