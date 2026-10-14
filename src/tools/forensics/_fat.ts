/**
 * Partition tables (MBR with extended partitions, GPT) and FAT12/16/32 volumes: directory
 * tree with long file names, and DELETED entries (first byte 0xE5) with a best-effort
 * recovery. Deleting a file frees its cluster chain, so the data is assumed contiguous from
 * the first cluster, which the directory entry still holds — the usual forensic heuristic.
 */
import type { LazyFile } from '../../core/types';
import { toolT } from '../../i18n/tool-text';
import { latin1Decode, u16le, u32le } from '../../lib/bytes';
import { readRange } from './_binary-stream';
import { cp437Decode, dosDateTime } from './_zip';

const T = toolT('binary-analyzer');

// ---------------------------------------------------------------- partitions

export interface Partition {
  index: number;
  scheme: 'MBR' | 'GPT';
  /** MBR type byte (0x0c) or GPT type GUID. */
  type: string;
  typeName: string;
  /** Byte offset and size in the image. */
  start: number;
  size: number;
  bootable: boolean;
  name: string;
}

/** A partition type: a technical name kept as is, or words to translate (key + parameters). */
type TypeName = string | { key: string; fs?: string };

const MBR_TYPES: Record<number, TypeName> = {
  0x01: 'FAT12',
  0x04: 'FAT16 (< 32 MiB)',
  0x05: { key: 'part.extended' },
  0x06: 'FAT16',
  0x07: 'NTFS / exFAT',
  0x0b: 'FAT32 (CHS)',
  0x0c: 'FAT32 (LBA)',
  0x0e: 'FAT16 (LBA)',
  0x0f: { key: 'part.extendedLba' },
  0x11: { key: 'part.hidden', fs: 'FAT12' },
  0x14: { key: 'part.hidden', fs: 'FAT16' },
  0x16: { key: 'part.hidden', fs: 'FAT16' },
  0x1b: { key: 'part.hidden', fs: 'FAT32' },
  0x1c: { key: 'part.hidden', fs: 'FAT32 (LBA)' },
  0x1e: { key: 'part.hidden', fs: 'FAT16 (LBA)' },
  0x82: 'Linux swap',
  0x83: 'Linux',
  0x85: { key: 'part.linuxExtended' },
  0x8e: 'Linux LVM',
  0xa5: 'FreeBSD',
  0xa6: 'OpenBSD',
  0xaf: 'Apple HFS+',
  0xee: { key: 'part.gptProtective' },
  0xef: 'EFI System',
  0xfd: 'Linux RAID',
};
const EXTENDED = new Set([0x05, 0x0f, 0x85]);

const GPT_TYPES: Record<string, TypeName> = {
  'C12A7328-F81F-11D2-BA4B-00A0C93EC93B': 'EFI System',
  'EBD0A0A2-B9E5-4433-87C0-68B6B72699C7': { key: 'part.msData' },
  'E3C9E316-0B5C-4DB8-817D-F92DF00215AE': { key: 'part.msReserved' },
  'DE94BBA4-06D1-4D40-A16A-BFD50179D6AC': { key: 'part.winRecovery' },
  '0FC63DAF-8483-4772-8E79-3D69D8477DE4': { key: 'part.linuxFs' },
  '0657FD6D-A4AB-43C4-84E5-0933C84B4F4F': 'Linux swap',
  'E6D6D379-F507-44C2-A23C-238F2A3DF928': 'Linux LVM',
  '21686148-6449-6E6F-744E-656564454649': { key: 'part.biosBoot' },
  '48465300-0000-11AA-AA11-00306543ECAC': 'Apple HFS+',
  '7C3457EF-0000-11AA-AA11-00306543ECAC': 'Apple APFS',
};

/** Display name of a partition type, in the user's language. */
function typeText(t: TypeName | undefined): string {
  if (t === undefined) return T('part.unknown');
  return typeof t === 'string' ? t : T(t.key, { fs: t.fs ?? '' });
}

export const mbrTypeName = (t: number) => typeText(MBR_TYPES[t]);

function guid(b: Uint8Array, o: number): string {
  const h = (i: number) => b[o + i]!.toString(16).padStart(2, '0');
  const g = [3, 2, 1, 0, -1, 5, 4, -1, 7, 6, -1, 8, 9, -1, 10, 11, 12, 13, 14, 15];
  return g
    .map((i) => (i < 0 ? '-' : h(i)))
    .join('')
    .toUpperCase();
}

const has55aa = (s: Uint8Array) => s.length >= 512 && s[510] === 0x55 && s[511] === 0xaa;

/** The four primary MBR entries, when they look like a real partition table. */
function mbrEntries(s: Uint8Array, sectors: number) {
  const out: { type: number; lba: number; count: number; boot: boolean }[] = [];
  for (let i = 0; i < 4; i++) {
    const p = 446 + i * 16;
    const status = s[p]!;
    const type = s[p + 4]!;
    const lba = u32le(s, p + 8);
    const count = u32le(s, p + 12);
    if (type === 0 && lba === 0 && count === 0) continue;
    if ((status !== 0 && status !== 0x80) || type === 0 || lba === 0 || count === 0) return null;
    // Allow a partition table describing a disk slightly bigger than this image (truncated dump).
    if (lba > sectors) return null;
    out.push({ type, lba, count, boot: status === 0x80 });
  }
  return out.length ? out : null;
}

/** Cheap check of sector 0 (triage): a partition table rather than a volume boot sector. */
export function hasPartitionTable(s0: Uint8Array): boolean {
  if (!has55aa(s0) || parseBpb(s0)) return false;
  if (latin1Decode(s0.subarray(512, 520)) === 'EFI PART') return true;
  return mbrEntries(s0, Number.MAX_SAFE_INTEGER) !== null;
}

/** Partitions of the image (MBR, its extended chain, or GPT), or null when there is no table. */
export async function readPartitions(file: LazyFile): Promise<Partition[] | null> {
  const s0 = await readRange(file, 0, 512);
  if (!has55aa(s0) || parseBpb(s0)) return null;
  const sectors = Math.floor(file.size / 512);
  const primary = mbrEntries(s0, sectors);
  if (!primary) return null;
  if (primary.some((e) => e.type === 0xee)) {
    const gpt = await readGpt(file);
    if (gpt) return gpt;
  }
  const parts: Partition[] = [];
  const add = (type: number, lba: number, count: number, boot: boolean) =>
    parts.push({
      index: parts.length + 1,
      scheme: 'MBR',
      type: `0x${type.toString(16).padStart(2, '0')}`,
      typeName: mbrTypeName(type),
      start: lba * 512,
      size: count * 512,
      bootable: boot,
      name: '',
    });
  for (const e of primary) {
    add(e.type, e.lba, e.count, e.boot);
    if (!EXTENDED.has(e.type)) continue;
    // Logical partitions: a chain of extended boot records, each relative to the extended start.
    let ebr = e.lba;
    for (let hops = 0; hops < 64 && ebr > 0 && ebr < sectors; hops++) {
      const s = await readRange(file, ebr * 512, 512);
      if (!has55aa(s)) break;
      const t1 = s[446 + 4]!;
      if (t1 !== 0) add(t1, ebr + u32le(s, 446 + 8), u32le(s, 446 + 12), s[446] === 0x80);
      const next = u32le(s, 462 + 8);
      if (s[462 + 4] === 0 || next === 0) break;
      ebr = e.lba + next;
    }
  }
  return parts;
}

async function readGpt(file: LazyFile): Promise<Partition[] | null> {
  const h = await readRange(file, 512, 512);
  if (latin1Decode(h.subarray(0, 8)) !== 'EFI PART') return null;
  const entriesLba = u32le(h, 72);
  const count = Math.min(u32le(h, 80), 256);
  const size = u32le(h, 84);
  if (size < 128 || size > 4096) return null;
  const t = await readRange(file, entriesLba * 512, count * size);
  const parts: Partition[] = [];
  for (let i = 0; i < count && (i + 1) * size <= t.length; i++) {
    const p = i * size;
    const type = guid(t, p);
    if (/^0+-0+-0+-0+-0+$/.test(type)) continue;
    const first = u32le(t, p + 32) + u32le(t, p + 36) * 2 ** 32;
    const last = u32le(t, p + 40) + u32le(t, p + 44) * 2 ** 32;
    let name = '';
    for (let k = 0; k < 36; k++) {
      const c = u16le(t, p + 56 + k * 2);
      if (c === 0) break;
      name += String.fromCharCode(c);
    }
    parts.push({
      index: i + 1,
      scheme: 'GPT',
      type,
      typeName: typeText(GPT_TYPES[type]),
      start: first * 512,
      size: (last - first + 1) * 512,
      bootable: false,
      name,
    });
  }
  return parts;
}

// ---------------------------------------------------------------- FAT boot sector

export interface Bpb {
  type: 'FAT12' | 'FAT16' | 'FAT32';
  oem: string;
  label: string;
  serial: string;
  bytesPerSector: number;
  sectorsPerCluster: number;
  clusterSize: number;
  clusterCount: number;
  totalSectors: number;
  fats: number;
  fatOffset: number;
  fatBytes: number;
  rootOffset: number;
  rootBytes: number;
  rootCluster: number;
  dataOffset: number;
}

/** BIOS parameter block of a FAT volume boot sector, or null. */
export function parseBpb(b: Uint8Array): Bpb | null {
  if (b.length < 512 || (b[0] !== 0xeb && b[0] !== 0xe9)) return null;
  const bps = u16le(b, 11);
  const spc = b[13]!;
  const reserved = u16le(b, 14);
  const fats = b[16]!;
  const rootEntries = u16le(b, 17);
  const total = u16le(b, 19) || u32le(b, 32);
  const fatSectors = u16le(b, 22) || u32le(b, 36);
  if (![512, 1024, 2048, 4096].includes(bps) || !spc || spc & (spc - 1)) return null;
  if (reserved === 0 || fats < 1 || fats > 4 || total === 0 || fatSectors === 0) return null;
  const rootSectors = Math.ceil((rootEntries * 32) / bps);
  const dataStart = reserved + fats * fatSectors + rootSectors;
  if (dataStart >= total) return null;
  const clusterCount = Math.floor((total - dataStart) / spc);
  const type = clusterCount < 4085 ? 'FAT12' : clusterCount < 65525 ? 'FAT16' : 'FAT32';
  if (type === 'FAT32' && rootEntries !== 0) return null;
  const ext = type === 'FAT32' ? 64 : 36;
  const hasExt = b[ext + 2] === 0x29;
  const serial = hasExt
    ? u32le(b, ext + 3)
        .toString(16)
        .padStart(8, '0')
        .toUpperCase()
    : '';
  return {
    type,
    oem: latin1Decode(b.subarray(3, 11)).trim(),
    label: hasExt ? latin1Decode(b.subarray(ext + 7, ext + 18)).trim() : '',
    serial: serial ? `${serial.slice(0, 4)}-${serial.slice(4)}` : '',
    bytesPerSector: bps,
    sectorsPerCluster: spc,
    clusterSize: bps * spc,
    clusterCount,
    totalSectors: total,
    fats,
    fatOffset: reserved * bps,
    fatBytes: fatSectors * bps,
    rootOffset: (reserved + fats * fatSectors) * bps,
    rootBytes: rootSectors * bps,
    rootCluster: type === 'FAT32' ? u32le(b, 44) : 0,
    dataOffset: dataStart * bps,
  };
}

// ---------------------------------------------------------------- FAT volume

export type FatStatus = 'ok' | 'recoverable' | 'overwritten' | 'lost' | 'empty';

export interface FatEntry {
  path: string;
  size: number;
  date: string;
  /** First cluster. */
  cluster: number;
  attrs: number;
  dir: boolean;
  deleted: boolean;
  status: FatStatus;
  /** Clusters holding the data: the chain, or the contiguous guess for a deleted file. */
  clusters: number[];
  /** The short name's lost first letter was recovered from the long name's checksum. */
  firstLetter: 'kept' | 'recovered' | 'unknown';
}

const MAX_FAT_BYTES = 64 << 20;
const MAX_DIR_BYTES = 2 << 20;
const MAX_ENTRIES = 50_000;

/** Checksum of an 8.3 name, stored in each of its long-name entries. */
export function sfnChecksum(raw: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < 11; i++) sum = (((sum & 1) << 7) + (sum >> 1) + raw[i]!) & 0xff;
  return sum;
}

function shortName(raw: Uint8Array, nt: number): string {
  const r = Uint8Array.from(raw);
  if (r[0] === 0x05) r[0] = 0xe5;
  let base = cp437Decode(r.subarray(0, 8)).trimEnd();
  let ext = cp437Decode(r.subarray(8, 11)).trimEnd();
  if (nt & 0x08) base = base.toLowerCase();
  if (nt & 0x10) ext = ext.toLowerCase();
  return ext ? `${base}.${ext}` : base;
}

interface LfnPart {
  checksum: number;
  text: string;
}

function lfnText(b: Uint8Array, p: number): string {
  let s = '';
  for (const o of [1, 3, 5, 7, 9, 14, 16, 18, 20, 22, 24, 28, 30]) {
    const c = u16le(b, p + o);
    if (c === 0 || c === 0xffff) break;
    s += String.fromCharCode(c);
  }
  return s;
}

export class FatVolume {
  private constructor(
    readonly file: LazyFile,
    /** Byte offset of the volume (partition start). */
    readonly offset: number,
    readonly bpb: Bpb,
    private readonly fat: Uint8Array,
  ) {}

  static async open(file: LazyFile, offset = 0): Promise<FatVolume | null> {
    const bpb = parseBpb(await readRange(file, offset, 512));
    if (!bpb) return null;
    const fat = await readRange(
      file,
      offset + bpb.fatOffset,
      Math.min(bpb.fatBytes, MAX_FAT_BYTES),
    );
    return new FatVolume(file, offset, bpb, fat);
  }

  /** FAT entry of cluster `c` (0 = free). */
  next(c: number): number {
    const f = this.fat;
    if (this.bpb.type === 'FAT12') {
      const o = c + (c >> 1);
      if (o + 1 >= f.length) return 0xfff;
      const v = u16le(f, o);
      return c & 1 ? v >> 4 : v & 0xfff;
    }
    if (this.bpb.type === 'FAT16') return 2 * c + 1 < f.length ? u16le(f, 2 * c) : 0xffff;
    return 4 * c + 3 < f.length ? u32le(f, 4 * c) & 0x0fffffff : 0x0fffffff;
  }

  private valid = (c: number) => c >= 2 && c < this.bpb.clusterCount + 2;

  chain(first: number, limit = this.bpb.clusterCount): number[] {
    const out: number[] = [];
    const seen = new Set<number>();
    let c = first;
    while (this.valid(c) && !seen.has(c) && out.length < limit) {
      seen.add(c);
      out.push(c);
      c = this.next(c);
    }
    return out;
  }

  private clusterOffset = (c: number) =>
    this.offset + this.bpb.dataOffset + (c - 2) * this.bpb.clusterSize;

  /** Bytes of `clusters`, concatenated and cut to `size`. */
  async readClusters(clusters: number[], size: number): Promise<Uint8Array> {
    const out = new Uint8Array(Math.min(size, clusters.length * this.bpb.clusterSize));
    for (const [run, at] of this.runs(clusters)) {
      if (at >= out.length) break;
      const part = await readRange(
        this.file,
        this.clusterOffset(run[0]),
        Math.min(run[1] * this.bpb.clusterSize, out.length - at),
      );
      out.set(part, at);
    }
    return out;
  }

  /** Same as readClusters, as a Blob made of slices of the image (nothing is read). */
  blobOf(clusters: number[], size: number): Blob {
    const parts: Blob[] = [];
    let left = size;
    for (const [run] of this.runs(clusters)) {
      if (left <= 0) break;
      const len = Math.min(run[1] * this.bpb.clusterSize, left);
      const start = this.clusterOffset(run[0]);
      parts.push(this.file.blob.slice(start, start + len));
      left -= len;
    }
    return new Blob(parts);
  }

  /** Consecutive cluster runs as [[first, count], byte offset in the file data]. */
  private *runs(clusters: number[]): Generator<[[number, number], number]> {
    let at = 0;
    for (let i = 0; i < clusters.length;) {
      let j = i + 1;
      while (j < clusters.length && clusters[j] === clusters[j - 1]! + 1) j++;
      yield [[clusters[i]!, j - i], at];
      at += (j - i) * this.bpb.clusterSize;
      i = j;
    }
  }

  /** The whole tree, deleted entries included (also inside deleted directories, best effort). */
  async list(): Promise<{ entries: FatEntry[]; label: string; capped: boolean }> {
    const entries: FatEntry[] = [];
    const seen = new Set<number>();
    let label = '';
    let capped = false;
    const walk = async (data: Uint8Array, prefix: string, depth: number, inDeleted: boolean) => {
      let lfn: LfnPart[] = [];
      for (let p = 0; p + 32 <= data.length; p += 32) {
        const first = data[p]!;
        if (first === 0) break;
        const attr = data[p + 11]!;
        if (attr === 0x0f) {
          if (first !== 0xe5 && first & 0x40) lfn = [];
          lfn.push({ checksum: data[p + 13]!, text: lfnText(data, p) });
          continue;
        }
        const raw = data.subarray(p, p + 11);
        const parts = lfn;
        lfn = [];
        const deleted = first === 0xe5 || inDeleted;
        if (raw[0] === 0x2e && (raw[1] === 0x20 || (raw[1] === 0x2e && raw[2] === 0x20))) continue;
        if (attr & 0x08 && !(attr & 0x10)) {
          if (!deleted && !label) label = latin1Decode(raw).trim();
          continue;
        }
        if (entries.length >= MAX_ENTRIES) {
          capped = true;
          return;
        }
        // Long name: the parts stored right before, in reverse order, with this checksum.
        let firstLetter: FatEntry['firstLetter'] = 'kept';
        const name83 = Uint8Array.from(raw);
        let target = sfnChecksum(raw);
        if (first === 0xe5) {
          firstLetter = 'unknown';
          const last = parts[parts.length - 1];
          for (let c = 0x21; last && c < 0x7f; c++) {
            name83[0] = c;
            if (sfnChecksum(name83) === last.checksum) {
              firstLetter = 'recovered';
              target = last.checksum;
              break;
            }
          }
          if (firstLetter === 'unknown') name83[0] = 0x5f; // "_"
        }
        let k = parts.length;
        while (k > 0 && parts[k - 1]!.checksum === target) k--;
        const long = parts
          .slice(k)
          .reverse()
          .map((x) => x.text)
          .join('');
        const name = long || shortName(name83, data[p + 12]!);
        const dir = (attr & 0x10) !== 0;
        const hi = this.bpb.type === 'FAT32' ? u16le(data, p + 20) : 0;
        const cluster = hi * 65536 + u16le(data, p + 26);
        const size = dir ? 0 : u32le(data, p + 28);
        const entry: FatEntry = {
          path: `${prefix}${name}`,
          size,
          date: dosDateTime(u16le(data, p + 24), u16le(data, p + 22)),
          cluster,
          attrs: attr,
          dir,
          deleted,
          status: 'ok',
          clusters: [],
          firstLetter,
        };
        const need = Math.ceil((dir ? this.bpb.clusterSize : size) / this.bpb.clusterSize);
        if (!deleted) {
          entry.clusters = this.chain(cluster, dir ? MAX_DIR_BYTES / this.bpb.clusterSize : need);
          if (!dir && size === 0) entry.status = 'empty';
        } else if (!dir && size === 0) {
          entry.status = 'empty';
        } else if (!this.valid(cluster) || !this.valid(cluster + need - 1)) {
          entry.status = 'lost';
        } else {
          for (let c = cluster; c < cluster + need; c++) entry.clusters.push(c);
          entry.status = entry.clusters.every((c) => this.next(c) === 0)
            ? 'recoverable'
            : 'overwritten';
        }
        entries.push(entry);
        const readable = !deleted || entry.status === 'recoverable';
        if (dir && readable && entry.clusters.length && depth < 32 && !seen.has(cluster)) {
          seen.add(cluster);
          const sub = await this.readClusters(
            entry.clusters,
            entry.clusters.length * this.bpb.clusterSize,
          );
          await walk(sub, `${entry.path}/`, depth + 1, deleted);
        }
      }
    };
    const root =
      this.bpb.type === 'FAT32'
        ? await this.readClusters(
            this.chain(this.bpb.rootCluster, MAX_DIR_BYTES / this.bpb.clusterSize),
            MAX_DIR_BYTES,
          )
        : await readRange(this.file, this.offset + this.bpb.rootOffset, this.bpb.rootBytes);
    seen.add(this.bpb.rootCluster);
    await walk(root, '/', 0, false);
    return { entries, label, capped };
  }
}
