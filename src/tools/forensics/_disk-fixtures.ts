/**
 * Writers for synthetic disk images: ISO 9660 (ECMA-119, optional Joliet and Rock Ridge),
 * the same volume as raw 2352-byte CD sectors, FAT12 with long names and deleted files, an MBR
 * around a volume, and the binary-analyzer samples built from them.
 * Used by the tests and by scripts/gen-samples-binary.mjs; nothing in the app imports it.
 */
import { strToU8 } from 'fflate';
import { concatBytes, utf8Encode } from '../../lib/bytes';
import { edc, SYNC } from './_cd';
import { sfnChecksum } from './_fat';
import { crc32 } from '../../lib/signatures';
import { buildPng, buildZip, noise } from './_fixtures';

const SECTOR = 2048;

const bothU16 = (b: Uint8Array, o: number, v: number) => {
  b[o] = v & 0xff;
  b[o + 1] = v >> 8;
  b[o + 2] = v >> 8;
  b[o + 3] = v & 0xff;
};
const bothU32 = (b: Uint8Array, o: number, v: number) => {
  const d = new DataView(b.buffer, b.byteOffset);
  d.setUint32(o, v, true);
  d.setUint32(o + 4, v, false);
};
const putText = (b: Uint8Array, o: number, n: number, s: string) => {
  for (let i = 0; i < n; i++) b[o + i] = i < s.length ? s.charCodeAt(i) : 0x20;
};
const putUcs2 = (b: Uint8Array, o: number, n: number, s: string) => {
  for (let i = 0; i + 1 < n; i += 2) {
    const c = i / 2 < s.length ? s.charCodeAt(i / 2) : 0x20;
    b[o + i] = c >> 8;
    b[o + i + 1] = c & 0xff;
  }
};
const ucs2 = (s: string) => {
  const out = new Uint8Array(s.length * 2);
  putUcs2(out, 0, out.length, s);
  return out;
};

// ---------------------------------------------------------------- ISO 9660

export interface IsoFileSpec {
  /** Path in the primary (8.3, upper case) namespace, e.g. "/DOCS/HELLO.TXT". */
  path: string;
  data: Uint8Array;
  /** Name in the Joliet / Rock Ridge trees (defaults to the primary name). */
  longName?: string;
  hidden?: boolean;
  /** Version written after ';' (default 1; null writes no version at all). */
  version?: number | null;
  /** Split the data into several extents (multi-extent file, flag 0x80 on all but the last). */
  extents?: number[];
  /** An empty file gets extent 0 and no sector, as genisoimage writes it. */
  zeroExtent?: boolean;
}

export interface IsoOptions {
  label?: string;
  joliet?: boolean;
  rockRidge?: boolean;
  /** Bytes appended after the volume (not counted in the volume size). */
  trailing?: Uint8Array;
  /** An El Torito boot record (sector 17) and BOOT.CAT / BOOT.IMG in the root. */
  elTorito?: boolean;
}

/** 2024-01-15 12:30:00 UTC, in both date formats. */
const REC_DATE = Uint8Array.of(124, 1, 15, 12, 30, 0, 0);
const DEC_DATE = utf8Encode('2024011512300000');

interface Dir {
  name: string;
  long: string;
  dirs: Dir[];
  files: { spec: IsoFileSpec; name: string; long: string; lba: number; lbas: number[] }[];
  /** Sectors of the directory extent (both trees use the same size). */
  sectors: number;
  lba: number;
  jlba: number;
  parent: Dir | null;
  num: number;
}

function record(
  name: Uint8Array,
  lba: number,
  size: number,
  flags: number,
  su: Uint8Array,
): Uint8Array {
  const pad = name.length % 2 === 0 ? 1 : 0;
  let len = 33 + name.length + pad + su.length;
  if (len % 2) len++;
  const r = new Uint8Array(len);
  r[0] = len;
  bothU32(r, 2, lba);
  bothU32(r, 10, size);
  r.set(REC_DATE, 18);
  r[25] = flags;
  bothU16(r, 28, 1);
  r[32] = name.length;
  r.set(name, 33);
  r.set(su, 33 + name.length + pad);
  return r;
}

/** Records packed into sectors; a record never crosses a sector boundary. */
export function packDir(records: Uint8Array[]): Uint8Array {
  const parts: number[][] = [[]];
  let used = 0;
  for (const r of records) {
    if (used + r.length > SECTOR) {
      parts.push([]);
      used = 0;
    }
    parts[parts.length - 1]!.push(...r);
    used += r.length;
  }
  const out = new Uint8Array(parts.length * SECTOR);
  parts.forEach((p, i) => out.set(p, i * SECTOR));
  return out;
}

/** Rock Ridge extension reference ("ER"), with short descriptor and source texts. */
const ER = (() => {
  const [id, des, src] = ['RRIP_1991A', 'ROCK RIDGE', 'FTF'].map((x) => strToU8(x, true));
  return concatBytes(
    Uint8Array.of(
      0x45,
      0x52,
      8 + id!.length + des!.length + src!.length,
      1,
      id!.length,
      des!.length,
      src!.length,
      1,
    ),
    id!,
    des!,
    src!,
  );
})();

const nm = (name: string) =>
  concatBytes(Uint8Array.of(0x4e, 0x4d, 5 + name.length, 1, 0), strToU8(name, true));

/** The El Torito boot catalog: validation entry (checksum, 55 AA) and a no-emulation entry. */
function bootCatalog(imageLba: number): Uint8Array {
  const c = new Uint8Array(SECTOR);
  c[0] = 1;
  putText(c, 4, 24, 'FIND THE FLAG');
  c[30] = 0x55;
  c[31] = 0xaa;
  let sum = 0;
  for (let i = 0; i < 32; i += 2) sum = (sum + c[i]! + (c[i + 1]! << 8)) & 0xffff;
  const check = (0x10000 - sum) & 0xffff;
  c[28] = check & 0xff;
  c[29] = check >> 8;
  c[32] = 0x88;
  c[33] = 0;
  c[38] = 4;
  new DataView(c.buffer).setUint32(40, imageLba, true);
  return c;
}

/** A complete ISO 9660 image (2048-byte sectors). */
export function buildIso(input: IsoFileSpec[], opts: IsoOptions = {}): Uint8Array {
  const files = opts.elTorito
    ? [
        ...input,
        { path: '/BOOT.CAT', data: new Uint8Array(SECTOR) },
        { path: '/BOOT.IMG', data: new Uint8Array(SECTOR).fill(0x90) },
      ]
    : input;
  const root: Dir = {
    name: '',
    long: '',
    dirs: [],
    files: [],
    lba: 0,
    jlba: 0,
    parent: null,
    num: 1,
    sectors: 1,
  };
  for (const spec of files) {
    const parts = spec.path.split('/').filter(Boolean);
    const longParts = (spec.longName ?? '').split('/').filter(Boolean);
    let d = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let sub = d.dirs.find((x) => x.name === parts[i]);
      if (!sub) {
        const long = longParts.length === parts.length ? longParts[i]! : parts[i]!;
        sub = {
          name: parts[i]!,
          long,
          dirs: [],
          files: [],
          lba: 0,
          jlba: 0,
          parent: d,
          num: 0,
          sectors: 1,
        };
        d.dirs.push(sub);
      }
      d = sub;
    }
    const name = parts[parts.length - 1]!;
    d.files.push({ spec, name, long: longParts[longParts.length - 1] ?? name, lba: 0, lbas: [] });
  }
  const all: Dir[] = [];
  const queue = [root];
  while (queue.length) {
    const d = queue.shift()!;
    d.num = all.length + 1;
    all.push(d);
    d.dirs.sort((a, b) => a.name.localeCompare(b.name));
    queue.push(...d.dirs);
  }
  const joliet = !!opts.joliet;
  const rr = !!opts.rockRidge;
  const extentSizes = (spec: IsoFileSpec) => spec.extents ?? [spec.data.length];

  const dirRecords = (d: Dir, jol: boolean): Uint8Array => {
    const at = jol ? d.jlba : d.lba;
    const parent = d.parent ?? d;
    const recs: Uint8Array[] = [];
    const selfSu =
      rr && !jol && d === root
        ? concatBytes(Uint8Array.of(0x53, 0x50, 7, 1, 0xbe, 0xef, 0), ER)
        : new Uint8Array(0);
    recs.push(record(Uint8Array.of(0), at, d.sectors * SECTOR, 2, selfSu));
    recs.push(
      record(
        Uint8Array.of(1),
        jol ? parent.jlba : parent.lba,
        parent.sectors * SECTOR,
        2,
        new Uint8Array(0),
      ),
    );
    const items = [
      ...d.dirs.map((x) => ({
        key: x.name,
        dir: x as Dir | null,
        file: null as Dir['files'][number] | null,
      })),
      ...d.files.map((f) => ({ key: f.name, dir: null as Dir | null, file: f })),
    ].sort((a, b) => a.key.localeCompare(b.key));
    for (const it of items) {
      const su = rr && !jol ? nm(it.dir ? it.dir.long : it.file!.long) : new Uint8Array(0);
      if (it.dir) {
        const name = jol ? ucs2(it.dir.long) : strToU8(it.dir.name, true);
        recs.push(record(name, jol ? it.dir.jlba : it.dir.lba, it.dir.sectors * SECTOR, 2, su));
      } else {
        const f = it.file!;
        const v = f.spec.version === undefined ? 1 : f.spec.version;
        const ver = v === null ? '' : `;${v}`;
        const name = jol ? ucs2(`${f.long}${ver}`) : strToU8(`${f.name}${ver}`, true);
        const sizes = extentSizes(f.spec);
        sizes.forEach((size, k) => {
          const flags = (f.spec.hidden ? 1 : 0) | (k + 1 < sizes.length ? 0x80 : 0);
          recs.push(record(name, f.lbas[k] ?? 0, size, flags, su));
        });
      }
    }
    return packDir(recs);
  };

  // Layout: system area, descriptors, path tables, directories, file data.
  let lba = 16;
  const pvdLba = lba++;
  const bootLba = opts.elTorito ? lba++ : -1;
  const svdLba = joliet ? lba++ : -1;
  const termLba = lba++;
  const pathLba = { l: lba++, m: lba++, jl: joliet ? lba++ : -1, jm: joliet ? lba++ : -1 };
  // Directory sizes do not depend on the LBAs they hold: measure, then place.
  for (const d of all) {
    d.sectors = Math.max(
      dirRecords(d, false).length / SECTOR,
      joliet ? dirRecords(d, true).length / SECTOR : 1,
    );
  }
  for (const d of all) {
    d.lba = lba;
    lba += d.sectors;
  }
  if (joliet) {
    for (const d of all) {
      d.jlba = lba;
      lba += d.sectors;
    }
  }
  for (const d of all) {
    for (const f of d.files) {
      f.lbas = [];
      for (const size of extentSizes(f.spec)) {
        if (size === 0 && f.spec.zeroExtent) {
          f.lbas.push(0);
          continue;
        }
        f.lbas.push(lba);
        lba += Math.max(1, Math.ceil(size / SECTOR));
      }
      f.lba = f.lbas[0] ?? 0;
    }
  }
  const total = lba;
  const img = new Uint8Array(total * SECTOR);

  const pathTable = (jol: boolean, little: boolean): Uint8Array => {
    const parts: number[] = [];
    for (const d of all) {
      const name = d === root ? Uint8Array.of(0) : jol ? ucs2(d.long) : strToU8(d.name, true);
      const e = new Uint8Array(8 + name.length + (name.length % 2));
      const v = new DataView(e.buffer);
      e[0] = name.length;
      v.setUint32(2, jol ? d.jlba : d.lba, little);
      v.setUint16(6, (d.parent ?? d).num, little);
      e.set(name, 8);
      parts.push(...e);
    }
    return Uint8Array.from(parts);
  };

  const descriptor = (type: number, jol: boolean): Uint8Array => {
    const d = new Uint8Array(SECTOR);
    d[0] = type;
    putText(d, 1, 5, 'CD001');
    d[6] = 1;
    const put = jol ? putUcs2 : putText;
    put(d, 8, 32, '');
    put(d, 40, 32, opts.label ?? 'FTF_TEST');
    bothU32(d, 80, total);
    if (jol) d.set([0x25, 0x2f, 0x45], 88);
    bothU16(d, 120, 1);
    bothU16(d, 124, 1);
    bothU16(d, 128, SECTOR);
    const table = pathTable(jol, true);
    bothU32(d, 132, table.length);
    const v = new DataView(d.buffer);
    v.setUint32(140, jol ? pathLba.jl : pathLba.l, true);
    v.setUint32(148, jol ? pathLba.jm : pathLba.m, false);
    d.set(
      record(
        Uint8Array.of(0),
        jol ? root.jlba : root.lba,
        root.sectors * SECTOR,
        2,
        new Uint8Array(0),
      ),
      156,
    );
    put(d, 190, 128, '');
    put(d, 318, 128, 'FIND THE FLAG');
    put(d, 446, 128, 'FIND THE FLAG TEST WRITER');
    put(d, 574, 128, 'FIND THE FLAG');
    put(d, 702, 37, '');
    put(d, 739, 37, '');
    put(d, 776, 37, '');
    d.set(DEC_DATE, 813);
    d.set(DEC_DATE, 830);
    d.set(utf8Encode('0000000000000000'), 847);
    d.set(utf8Encode('0000000000000000'), 864);
    d[881] = 1;
    return d;
  };

  img.set(descriptor(1, false), pvdLba * SECTOR);
  if (joliet) img.set(descriptor(2, true), svdLba * SECTOR);
  img.set(Uint8Array.of(255, 0x43, 0x44, 0x30, 0x30, 0x31, 1), termLba * SECTOR);
  img.set(pathTable(false, true), pathLba.l * SECTOR);
  img.set(pathTable(false, false), pathLba.m * SECTOR);
  if (joliet) {
    img.set(pathTable(true, true), pathLba.jl * SECTOR);
    img.set(pathTable(true, false), pathLba.jm * SECTOR);
  }
  for (const d of all) {
    img.set(dirRecords(d, false), d.lba * SECTOR);
    if (joliet) img.set(dirRecords(d, true), d.jlba * SECTOR);
    for (const f of d.files) {
      let at = 0;
      extentSizes(f.spec).forEach((size, k) => {
        if (size > 0) img.set(f.spec.data.subarray(at, at + size), f.lbas[k]! * SECTOR);
        at += size;
      });
    }
  }
  if (opts.elTorito) {
    const cat = root.files.find((f) => f.name === 'BOOT.CAT')!;
    const image = root.files.find((f) => f.name === 'BOOT.IMG')!;
    const b = new Uint8Array(SECTOR);
    putText(b, 1, 5, 'CD001');
    b[6] = 1;
    b.set(utf8Encode('EL TORITO SPECIFICATION'), 7);
    new DataView(b.buffer).setUint32(0x47, cat.lba, true);
    img.set(b, bootLba * SECTOR);
    img.set(bootCatalog(image.lba), cat.lba * SECTOR);
  }
  return opts.trailing ? concatBytes(img, opts.trailing) : img;
}

const toBcd = (n: number) => ((Math.floor(n / 10) << 4) | (n % 10)) & 0xff;

/**
 * The same volume as raw CD sectors. 'mode1' (2352): sync, BCD address (+150 frames of
 * pre-gap), mode byte, 2048 data bytes, a real EDC, zeroed ECC (the P/Q parity is not
 * computed: readers that check it would complain, ours only reports the EDC). 'mode2' (2352):
 * Mode 2 Form 1 with its 8-byte sub-header. '2336': Mode 2 Form 1 without sync and header.
 */
export function cookedToRaw(
  iso: Uint8Array,
  layout: 'mode1' | 'mode2' | '2336' = 'mode1',
): Uint8Array {
  const n = Math.ceil(iso.length / SECTOR);
  const size = layout === '2336' ? 2336 : 2352;
  const out = new Uint8Array(n * size);
  const v = new DataView(out.buffer);
  for (let i = 0; i < n; i++) {
    const p = i * size;
    const data = iso.subarray(i * SECTOR, (i + 1) * SECTOR);
    if (layout === 'mode1') {
      writeHeader(out, p, i, 1);
      out.set(data, p + 16);
      v.setUint32(p + 2064, edc(out, p, p + 2064), true);
      continue;
    }
    // Mode 2 Form 1: sub-header (file, channel, sub-mode = data, coding) twice, data, EDC.
    const q = layout === '2336' ? p - 16 : p;
    if (layout === 'mode2') writeHeader(out, p, i, 2);
    out.set([0, 0, 0x08, 0, 0, 0, 0x08, 0], q + 16);
    out.set(data, q + 24);
    const e = edc(out, q + 16, q + 2072);
    v.setUint32(q + 2072, e, true);
  }
  return out;
}

function writeHeader(out: Uint8Array, p: number, lba: number, mode: number): void {
  out.set(SYNC, p);
  const frames = lba + 150;
  out[p + 12] = toBcd(Math.floor(frames / 4500));
  out[p + 13] = toBcd(Math.floor(frames / 75) % 60);
  out[p + 14] = toBcd(frames % 75);
  out[p + 15] = mode;
}

// ---------------------------------------------------------------- FAT12

export interface FatFileSpec {
  /** "/NOTE.TXT", "/DOCS/A long file name.txt" (long names get LFN entries). */
  path: string;
  data?: Uint8Array;
  dir?: boolean;
  deleted?: boolean;
  /** Put the data at this cluster (to make a deleted file's clusters reused by another). */
  cluster?: number;
}

interface FatNode {
  name: string;
  spec: FatFileSpec | null;
  children: FatNode[];
  cluster: number;
  clusters: number[];
}

const SFN_OK = /^[A-Z0-9_\-!#$%&'()@^`{}~]{1,8}(\.[A-Z0-9_\-!#$%&'()@^`{}~]{1,3})?$/;

function shortFor(name: string, used: Set<string>): { raw: Uint8Array; lfn: boolean } {
  const raw = new Uint8Array(11).fill(0x20);
  if (SFN_OK.test(name)) {
    const [base, ext = ''] = name.split('.');
    putText(raw, 0, 8, base!);
    putText(raw, 8, 3, ext);
    return { raw, lfn: false };
  }
  const dot = name.lastIndexOf('.');
  const clean = (s: string) => s.toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  const base = clean(dot > 0 ? name.slice(0, dot) : name);
  const ext = clean(dot > 0 ? name.slice(dot + 1) : '').slice(0, 3);
  for (let n = 1; ; n++) {
    const tail = `~${n}`;
    const b = base.slice(0, 8 - tail.length) + tail;
    const key = `${b}.${ext}`;
    if (used.has(key)) continue;
    used.add(key);
    putText(raw, 0, 8, b);
    putText(raw, 8, 3, ext);
    return { raw, lfn: true };
  }
}

function lfnEntries(name: string, checksum: number): Uint8Array[] {
  const chars = [...name].map((c) => c.charCodeAt(0));
  const count = Math.ceil((chars.length + 1) / 13);
  const padded = [...chars, 0];
  while (padded.length < count * 13) padded.push(0xffff);
  const out: Uint8Array[] = [];
  for (let seq = count; seq >= 1; seq--) {
    const e = new Uint8Array(32);
    e[0] = seq | (seq === count ? 0x40 : 0);
    e[11] = 0x0f;
    e[13] = checksum;
    const part = padded.slice((seq - 1) * 13, seq * 13);
    [1, 3, 5, 7, 9, 14, 16, 18, 20, 22, 24, 28, 30].forEach((o, i) => {
      e[o] = part[i]! & 0xff;
      e[o + 1] = part[i]! >> 8;
    });
    out.push(e);
  }
  return out;
}

const DOS_DATE = ((2024 - 1980) << 9) | (1 << 5) | 15;
const DOS_TIME = (12 << 11) | (30 << 5);

/** A small FAT12 volume: 512-byte sectors and clusters, 2 FATs, 64 root entries. */
export function buildFat12(
  files: FatFileSpec[],
  opts: { label?: string; sectors?: number } = {},
): Uint8Array {
  const bps = 512;
  const total = opts.sectors ?? 360;
  const rootEntries = 64;
  const fatSectors = Math.ceil(((total + 2) * 3) / 2 / bps);
  const rootSectors = (rootEntries * 32) / bps;
  const dataStart = 1 + 2 * fatSectors + rootSectors;
  const img = new Uint8Array(total * bps);
  const fat = new Uint8Array(fatSectors * bps);
  const setFat = (c: number, v: number) => {
    const o = c + (c >> 1);
    if (c & 1) {
      fat[o] = (fat[o]! & 0x0f) | ((v & 0x0f) << 4);
      fat[o + 1] = v >> 4;
    } else {
      fat[o] = v & 0xff;
      fat[o + 1] = (fat[o + 1]! & 0xf0) | ((v >> 8) & 0x0f);
    }
  };
  setFat(0, 0xff0);
  setFat(1, 0xfff);

  const root: FatNode = { name: '', spec: null, children: [], cluster: 0, clusters: [] };
  for (const spec of files) {
    const parts = spec.path.split('/').filter(Boolean);
    let d = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let sub = d.children.find((x) => x.name === parts[i]);
      if (!sub) {
        sub = {
          name: parts[i]!,
          spec: { path: '', dir: true },
          children: [],
          cluster: 0,
          clusters: [],
        };
        d.children.push(sub);
      }
      d = sub;
    }
    const name = parts[parts.length - 1]!;
    const existing = spec.dir ? d.children.find((x) => x.name === name) : undefined;
    if (existing) existing.spec = spec;
    else d.children.push({ name, spec, children: [], cluster: 0, clusters: [] });
  }

  let next = 2;
  const allocate = (node: FatNode) => {
    const isDir = !!node.spec?.dir;
    const size = isDir ? bps : (node.spec?.data?.length ?? 0);
    const n = Math.ceil(size / bps);
    if (n === 0) return;
    const first = node.spec?.cluster ?? next;
    node.cluster = first;
    node.clusters = Array.from({ length: n }, (_, i) => first + i);
    if (node.spec?.cluster === undefined) next += n;
    if (!node.spec?.deleted) {
      node.clusters.forEach((c, i) => setFat(c, i + 1 < n ? c + 1 : 0xfff));
    }
  };
  const walk = (d: FatNode) => {
    for (const c of d.children) {
      allocate(c);
      if (c.spec?.dir) walk(c);
    }
  };
  walk(root);
  // Clusters of live files win over deleted ones that were placed on top of them.
  const mark = (d: FatNode) => {
    for (const c of d.children) {
      if (!c.spec?.deleted)
        c.clusters.forEach((k, i) => setFat(k, i + 1 < c.clusters.length ? k + 1 : 0xfff));
      if (c.spec?.dir) mark(c);
    }
  };
  mark(root);

  const clusterAt = (c: number) => (dataStart + c - 2) * bps;
  const writeData = (d: FatNode) => {
    for (const c of d.children) {
      if (!c.spec?.dir && c.spec?.data && c.spec.deleted)
        img.set(c.spec.data, clusterAt(c.cluster));
      if (c.spec?.dir) writeData(c);
    }
    for (const c of d.children) {
      if (!c.spec?.dir && c.spec?.data && !c.spec.deleted)
        img.set(c.spec.data, clusterAt(c.cluster));
    }
  };
  writeData(root);

  const entry = (raw: Uint8Array, attr: number, cluster: number, size: number) => {
    const e = new Uint8Array(32);
    e.set(raw, 0);
    e[11] = attr;
    const v = new DataView(e.buffer);
    v.setUint16(14, DOS_TIME, true);
    v.setUint16(16, DOS_DATE, true);
    v.setUint16(18, DOS_DATE, true);
    v.setUint16(22, DOS_TIME, true);
    v.setUint16(24, DOS_DATE, true);
    v.setUint16(26, cluster, true);
    v.setUint32(28, size, true);
    return e;
  };
  const dirBytes = (d: FatNode, self: number, parent: number, isRoot: boolean): Uint8Array => {
    const entries: Uint8Array[] = [];
    if (isRoot && opts.label) {
      const raw = new Uint8Array(11).fill(0x20);
      putText(raw, 0, 11, opts.label);
      entries.push(entry(raw, 0x08, 0, 0));
    }
    if (!isRoot) {
      entries.push(entry(utf8Encode('.          '), 0x10, self, 0));
      entries.push(entry(utf8Encode('..         '), 0x10, parent, 0));
    }
    const used = new Set<string>();
    for (const c of d.children) {
      const { raw, lfn } = shortFor(c.name, used);
      const isDir = !!c.spec?.dir;
      const group = lfn ? lfnEntries(c.name, sfnChecksum(raw)) : [];
      group.push(
        entry(raw, isDir ? 0x10 : 0x20, c.cluster, isDir ? 0 : (c.spec?.data?.length ?? 0)),
      );
      if (c.spec?.deleted) for (const e of group) e[0] = 0xe5;
      entries.push(...group);
    }
    return concatBytes(...entries);
  };
  const writeDirs = (d: FatNode, self: number, parent: number, isRoot: boolean) => {
    const bytes = dirBytes(d, self, parent, isRoot);
    if (isRoot) {
      if (bytes.length > rootEntries * 32) throw new Error('too many root entries');
      img.set(bytes, (1 + 2 * fatSectors) * bps);
    } else {
      if (bytes.length > bps) throw new Error('fixture subdirectories hold 16 entries');
      img.set(bytes, clusterAt(self));
    }
    for (const c of d.children) if (c.spec?.dir) writeDirs(c, c.cluster, isRoot ? 0 : self, false);
  };
  writeDirs(root, 0, 0, true);

  // Boot sector (BPB with extended signature 0x29).
  const b = img.subarray(0, bps);
  b.set([0xeb, 0x3c, 0x90], 0);
  putText(b, 3, 8, 'FTFTEST ');
  const v = new DataView(img.buffer);
  v.setUint16(11, bps, true);
  b[13] = 1;
  v.setUint16(14, 1, true);
  b[16] = 2;
  v.setUint16(17, rootEntries, true);
  v.setUint16(19, total, true);
  b[21] = 0xf0;
  v.setUint16(22, fatSectors, true);
  v.setUint16(24, 18, true);
  v.setUint16(26, 2, true);
  b[38] = 0x29;
  v.setUint32(39, 0x46544631, true);
  putText(b, 43, 11, opts.label ?? 'NO NAME');
  putText(b, 54, 8, 'FAT12');
  b[510] = 0x55;
  b[511] = 0xaa;
  img.set(fat, bps);
  img.set(fat, bps + fatSectors * bps);
  return img;
}

/** `volume` as partition 1 of an MBR disk, starting at sector `start`. */
export function withMbr(volume: Uint8Array, type = 0x01, start = 63): Uint8Array {
  const disk = new Uint8Array(start * 512 + volume.length);
  disk.set(volume, start * 512);
  const v = new DataView(disk.buffer);
  disk[446] = 0x80;
  disk[446 + 4] = type;
  v.setUint32(446 + 8, start, true);
  v.setUint32(446 + 12, volume.length / 512, true);
  disk[510] = 0x55;
  disk[511] = 0xaa;
  return disk;
}

// ---------------------------------------------------------------- FAT12 / 16 / 32 (generic)

export interface FatGeometry {
  type: 'FAT12' | 'FAT16' | 'FAT32';
  totalSectors: number;
  sectorsPerCluster: number;
  reserved: number;
  fats: number;
  fatSectors: number;
  /** Root directory entries (0 for FAT32, whose root is a cluster chain). */
  rootEntries: number;
  /** Sectors before the volume on the disk (BPB HiddSec). */
  hidden?: number;
  label?: string;
  /** FAT32: clusters of the root directory chain (default: as many as needed from cluster 2). */
  rootClusters?: number[];
}

export interface FatNodeSpec {
  /** Long path ("/Sub Folder/nested file.dat"); 8.3 names get no LFN entries. */
  path: string;
  data?: Uint8Array;
  dir?: boolean;
  /** 0xE5 on the 8.3 entry and its LFN entries, FAT chain left free, data kept. */
  deleted?: boolean;
  /** Clusters holding the data (default: the next free ones). */
  clusters?: number[];
  /** Raw 11-byte 8.3 name ("LOWER   TXT"), default derived from the path. */
  short?: string;
  /** NTRes byte (0x08: base in lower case, 0x10: extension in lower case). */
  ntres?: number;
  /** XOR the checksum of its LFN entries with this (an orphaned long name). */
  lfnXor?: number;
  /** Long name to write in the LFN entries, if not the last component of the path. */
  lfnName?: string;
}

const BPS = 512;

/**
 * A FAT12/16/32 volume per the Microsoft FAT specification (FAT type by cluster count, packed
 * 12-bit FAT, BPB with extended signature 0x29 and 55 AA, FSInfo and backup boot sector for
 * FAT32), with long names, sub-directories of any size, explicit (fragmented) cluster chains,
 * deleted entries and a volume label.
 */
export function buildFat(g: FatGeometry, nodes: FatNodeSpec[]): Uint8Array {
  const spc = g.sectorsPerCluster;
  const csize = spc * BPS;
  const rootSectors = Math.ceil((g.rootEntries * 32) / BPS);
  const dataStart = g.reserved + g.fats * g.fatSectors + rootSectors;
  const clusters = Math.floor((g.totalSectors - dataStart) / spc);
  const kind = clusters < 4085 ? 'FAT12' : clusters < 65525 ? 'FAT16' : 'FAT32';
  if (kind !== g.type) throw new Error(`geometry gives ${kind}, not ${g.type}`);
  const img = new Uint8Array(g.totalSectors * BPS);
  const fat = new Uint8Array(g.fatSectors * BPS);
  const dv = new DataView(fat.buffer);
  const setFat = (c: number, v: number) => {
    if (g.type === 'FAT12') {
      const o = c + (c >> 1);
      if (c & 1) {
        fat[o] = (fat[o]! & 0x0f) | ((v & 0x0f) << 4);
        fat[o + 1] = (v >> 4) & 0xff;
      } else {
        fat[o] = v & 0xff;
        fat[o + 1] = (fat[o + 1]! & 0xf0) | ((v >> 8) & 0x0f);
      }
    } else if (g.type === 'FAT16') dv.setUint16(c * 2, v, true);
    else dv.setUint32(c * 4, v, true);
  };
  const eoc = g.type === 'FAT12' ? 0xfff : g.type === 'FAT16' ? 0xffff : 0x0fffffff;
  setFat(0, g.type === 'FAT12' ? 0xff8 : g.type === 'FAT16' ? 0xfff8 : 0x0ffffff8);
  setFat(1, eoc);
  const used = new Set<number>();
  let next = 2;
  const take = (n: number): number[] => {
    const out: number[] = [];
    while (out.length < n) {
      if (!used.has(next)) out.push(next);
      next++;
    }
    out.forEach((c) => used.add(c));
    return out;
  };
  const chain = (list: number[]) => list.forEach((c, i) => setFat(c, list[i + 1] ?? eoc));
  const clusterAt = (c: number) => (dataStart + (c - 2) * spc) * BPS;
  const writeChain = (list: number[], data: Uint8Array) => {
    list.forEach((c, i) => img.set(data.subarray(i * csize, (i + 1) * csize), clusterAt(c)));
  };

  interface Node {
    name: string;
    spec: FatNodeSpec | null;
    children: Node[];
    clusters: number[];
  }
  const root: Node = { name: '', spec: null, children: [], clusters: [] };
  for (const spec of nodes) {
    const parts = spec.path.split('/').filter(Boolean);
    let d = root;
    for (let k = 0; k < parts.length - 1; k++) {
      let sub = d.children.find((x) => x.name === parts[k]);
      if (!sub) {
        sub = { name: parts[k]!, spec: { path: '', dir: true }, children: [], clusters: [] };
        d.children.push(sub);
      }
      d = sub;
    }
    const name = parts[parts.length - 1]!;
    const existing = spec.dir ? d.children.find((x) => x.name === name) : undefined;
    if (existing) existing.spec = spec;
    else d.children.push({ name, spec, children: [], clusters: [] });
  }
  // Reserve the explicit clusters first, so automatic allocation goes around them.
  const reserve = (d: Node) => {
    for (const c of d.children) {
      if (c.spec?.clusters && !c.spec.deleted) c.spec.clusters.forEach((k) => used.add(k));
      reserve(c);
    }
  };
  reserve(root);
  if (g.rootClusters) g.rootClusters.forEach((k) => used.add(k));

  const entry = (raw: Uint8Array, attr: number, cluster: number, size: number, ntres = 0) => {
    const e = new Uint8Array(32);
    e.set(raw, 0);
    e[11] = attr;
    e[12] = ntres;
    const v = new DataView(e.buffer);
    v.setUint16(14, DOS_TIME, true);
    v.setUint16(16, DOS_DATE, true);
    v.setUint16(18, DOS_DATE, true);
    v.setUint16(20, cluster >>> 16, true);
    v.setUint16(22, DOS_TIME, true);
    v.setUint16(24, DOS_DATE, true);
    v.setUint16(26, cluster & 0xffff, true);
    v.setUint32(28, size, true);
    return e;
  };
  const rawName = (s83: string) => {
    const raw = new Uint8Array(11).fill(0x20);
    putText(raw, 0, 11, s83);
    return raw;
  };
  /** Entries of a directory; cluster numbers are filled in once children are placed. */
  const entriesOf = (d: Node, self: number, parent: number, isRoot: boolean): Uint8Array => {
    const list: Uint8Array[] = [];
    if (isRoot && g.label) list.push(entry(rawName(g.label), 0x08, 0, 0));
    if (!isRoot) {
      list.push(entry(utf8Encode('.          '), 0x10, self, 0));
      list.push(entry(utf8Encode('..         '), 0x10, parent, 0));
    }
    const usedShort = new Set<string>();
    for (const c of d.children) {
      const spec = c.spec!;
      let raw: Uint8Array;
      let lfn: boolean;
      if (spec.short) {
        raw = rawName(spec.short);
        lfn = spec.lfnName !== undefined;
      } else ({ raw, lfn } = shortFor(c.name, usedShort));
      const isDir = !!spec.dir;
      const group = lfn
        ? lfnEntries(spec.lfnName ?? c.name, sfnChecksum(raw) ^ (spec.lfnXor ?? 0))
        : [];
      const first = c.clusters[0] ?? 0;
      group.push(
        entry(raw, isDir ? 0x10 : 0x20, first, isDir ? 0 : (spec.data?.length ?? 0), spec.ntres),
      );
      if (spec.deleted) for (const e of group) e[0] = 0xe5;
      list.push(...group);
    }
    return concatBytes(...list);
  };
  // Directory sizes depend only on their entries: allocate depth-first, then write.
  const place = (d: Node) => {
    for (const c of d.children) {
      const spec = c.spec!;
      const bytes = spec.dir ? entriesOf(c, 0, 0, false).length : (spec.data?.length ?? 0);
      const n = Math.ceil(bytes / csize);
      c.clusters = spec.clusters ?? (n ? take(n) : []);
      if (!spec.deleted) chain(c.clusters);
      if (spec.dir) place(c);
    }
  };
  let rootChain: number[] = [];
  if (g.type === 'FAT32') {
    // The root's size depends on its entries only: measure with placeholder clusters.
    const n = Math.max(1, Math.ceil(entriesOf(root, 0, 0, true).length / csize));
    rootChain = g.rootClusters ?? take(n);
    chain(rootChain);
  }
  place(root);
  const writeData = (d: Node, self: number) => {
    // Deleted files first: live data placed over a deleted file's clusters wins.
    const order = [...d.children].sort(
      (a, b) => Number(!a.spec!.deleted) - Number(!b.spec!.deleted),
    );
    for (const c of order) {
      const spec = c.spec!;
      if (spec.dir) {
        const bytes = entriesOf(c, c.clusters[0] ?? 0, self, false);
        writeChain(c.clusters, bytes);
        writeData(c, c.clusters[0] ?? 0);
      } else if (spec.data?.length) writeChain(c.clusters, spec.data);
    }
  };
  writeData(root, 0);
  const rootBytes = entriesOf(root, 0, 0, true);
  if (g.type === 'FAT32') writeChain(rootChain, rootBytes);
  else {
    if (rootBytes.length > g.rootEntries * 32) throw new Error('too many root entries');
    img.set(rootBytes, (g.reserved + g.fats * g.fatSectors) * BPS);
  }
  for (let k = 0; k < g.fats; k++) img.set(fat, (g.reserved + k * g.fatSectors) * BPS);

  const boot = (at: number) => {
    const b = img.subarray(at * BPS, at * BPS + BPS);
    const v = new DataView(img.buffer, at * BPS, BPS);
    b.set([0xeb, 0x58, 0x90], 0);
    putText(b, 3, 8, 'FTFTEST ');
    v.setUint16(11, BPS, true);
    b[13] = spc;
    v.setUint16(14, g.reserved, true);
    b[16] = g.fats;
    v.setUint16(17, g.rootEntries, true);
    if (g.totalSectors < 65536 && g.type !== 'FAT32') v.setUint16(19, g.totalSectors, true);
    else v.setUint32(32, g.totalSectors, true);
    b[21] = g.type === 'FAT12' && g.totalSectors === 2880 ? 0xf0 : 0xf8;
    if (g.type !== 'FAT32') v.setUint16(22, g.fatSectors, true);
    v.setUint16(24, 18, true);
    v.setUint16(26, 2, true);
    v.setUint32(28, g.hidden ?? 0, true);
    const ext = g.type === 'FAT32' ? 64 : 36;
    if (g.type === 'FAT32') {
      v.setUint32(36, g.fatSectors, true);
      v.setUint32(44, rootChain[0]!, true);
      v.setUint16(48, 1, true);
      v.setUint16(50, 6, true);
    }
    b[ext + 2] = 0x29;
    v.setUint32(ext + 3, 0x46544633, true);
    putText(b, ext + 7, 11, g.label ?? 'NO NAME');
    putText(b, ext + 18, 8, g.type === 'FAT32' ? 'FAT32' : g.type);
    b[510] = 0x55;
    b[511] = 0xaa;
  };
  boot(0);
  if (g.type === 'FAT32') {
    boot(6);
    // FSInfo at sector 1 (lead, struct and trail signatures; counts unknown).
    const fs = new DataView(img.buffer, BPS, BPS);
    fs.setUint32(0, 0x41615252, true);
    fs.setUint32(484, 0x61417272, true);
    fs.setUint32(488, 0xffffffff, true);
    fs.setUint32(492, 0xffffffff, true);
    fs.setUint32(508, 0xaa550000, true);
  }
  return img;
}

export interface MbrEntry {
  type: number;
  /** First sector (LBA) and sector count. */
  start: number;
  count: number;
  boot?: boolean;
}

/** A disk of `sectors` 512-byte sectors with an MBR, and volumes written at their start. */
export function buildMbrDisk(
  sectors: number,
  entries: MbrEntry[],
  volumes: { at: number; bytes: Uint8Array }[],
): Uint8Array {
  const disk = new Uint8Array(sectors * 512);
  const v = new DataView(disk.buffer);
  entries.forEach((e, i) => {
    const p = 446 + i * 16;
    disk[p] = e.boot ? 0x80 : 0;
    disk[p + 4] = e.type;
    v.setUint32(p + 8, e.start, true);
    v.setUint32(p + 12, e.count, true);
  });
  disk[510] = 0x55;
  disk[511] = 0xaa;
  for (const x of volumes) disk.set(x.bytes, x.at * 512);
  return disk;
}

/** An extended boot record at sector `at` of `disk`: one logical partition and a link. */
export function writeEbr(
  disk: Uint8Array,
  at: number,
  logical: { type: number; rel: number; count: number },
  link?: { rel: number; count: number },
): void {
  const v = new DataView(disk.buffer);
  const p = at * 512;
  disk[p + 446 + 4] = logical.type;
  v.setUint32(p + 446 + 8, logical.rel, true);
  v.setUint32(p + 446 + 12, logical.count, true);
  if (link) {
    disk[p + 462 + 4] = 0x05;
    v.setUint32(p + 462 + 8, link.rel, true);
    v.setUint32(p + 462 + 12, link.count, true);
  }
  disk[p + 510] = 0x55;
  disk[p + 511] = 0xaa;
}

/** A GPT disk (protective MBR, header and entries with their CRC32, backup at the end). */
export function buildGptDisk(
  sectors: number,
  parts: { type: string; first: number; last: number; name: string }[],
  volumes: { at: number; bytes: Uint8Array }[],
): Uint8Array {
  const disk = new Uint8Array(sectors * 512);
  const v = new DataView(disk.buffer);
  disk[446 + 4] = 0xee;
  v.setUint32(446 + 8, 1, true);
  v.setUint32(446 + 12, Math.min(0xffffffff, sectors - 1), true);
  disk[510] = 0x55;
  disk[511] = 0xaa;
  const entries = new Uint8Array(128 * 128);
  const ev = new DataView(entries.buffer);
  const guidBytes = (g: string) => {
    const h = g.replace(/-/g, '');
    const b = Array.from({ length: 16 }, (_, i) => parseInt(h.slice(i * 2, i * 2 + 2), 16));
    return [b[3], b[2], b[1], b[0], b[5], b[4], b[7], b[6], ...b.slice(8)] as number[];
  };
  parts.forEach((p, i) => {
    const o = i * 128;
    entries.set(guidBytes(p.type), o);
    entries.set(guidBytes(`00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`), o + 16);
    ev.setUint32(o + 32, p.first, true);
    ev.setUint32(o + 40, p.last, true);
    [...p.name].forEach((c, k) => ev.setUint16(o + 56 + k * 2, c.charCodeAt(0), true));
  });
  const header = (self: number, other: number, entriesLba: number) => {
    const h = new Uint8Array(512);
    const hv = new DataView(h.buffer);
    h.set(utf8Encode('EFI PART'), 0);
    hv.setUint32(8, 0x00010000, true);
    hv.setUint32(12, 92, true);
    hv.setUint32(24, self, true);
    hv.setUint32(32, other, true);
    hv.setUint32(40, 34, true);
    hv.setUint32(48, sectors - 34, true);
    hv.setUint32(72, entriesLba, true);
    hv.setUint32(80, 128, true);
    hv.setUint32(84, 128, true);
    hv.setUint32(88, crc32(entries), true);
    hv.setUint32(16, crc32(h.subarray(0, 92)), true);
    return h;
  };
  disk.set(header(1, sectors - 1, 2), 512);
  disk.set(entries, 2 * 512);
  disk.set(entries, (sectors - 33) * 512);
  disk.set(header(sectors - 1, 1, sectors - 33), (sectors - 1) * 512);
  for (const x of volumes) disk.set(x.bytes, x.at * 512);
  return disk;
}

// ---------------------------------------------------------------- the samples

export const HIDDEN = {
  pngAt: 0x3000,
  textAt: 0x6000,
  wideAt: 0x6800,
  zipAt: 0x9000,
  size: 0x18000,
  text: 'Find The Flag binary analyzer sample\nflag{carved_from_the_noise}\n',
  wide: 'wide text hides here',
  note: 'carved from the middle',
};

export function hiddenPng(): Uint8Array {
  return buildPng(24, 16);
}

export function hiddenZip(): Uint8Array {
  return buildZip([{ name: 'note.txt', data: utf8Encode(HIDDEN.note) }]);
}

/** Pseudo-random bytes with a PNG, some text and a ZIP inside, at fixed offsets. */
export function buildHiddenBin(): Uint8Array {
  const out = noise(HIDDEN.size, 0x46544621);
  out.set(hiddenPng(), HIDDEN.pngAt);
  out.set(utf8Encode(HIDDEN.text), HIDDEN.textAt);
  const wide = new Uint8Array(HIDDEN.wide.length * 2);
  [...HIDDEN.wide].forEach((c, i) => (wide[i * 2] = c.charCodeAt(0)));
  out.set(wide, HIDDEN.wideAt);
  out.set(hiddenZip(), HIDDEN.zipAt);
  return out;
}

export const ISO_FILES: IsoFileSpec[] = [
  { path: '/README.TXT', data: utf8Encode('Find The Flag ISO test\n') },
  { path: '/DOCS/HELLO.TXT', data: utf8Encode('hello from the disk image\n') },
  {
    path: '/DOCS/NOTES_AB.TXT',
    longName: '/DOCS/notes about the disk.txt',
    data: utf8Encode('Joliet keeps the long name of this file.\n'),
  },
  {
    path: '/HIDDEN.TXT',
    data: utf8Encode('this file has the hidden flag bit set\n'),
    hidden: true,
  },
];

export const buildSampleIso = () => buildIso(ISO_FILES, { label: 'FTF_DISK', joliet: true });

export const FAT_FILES: FatFileSpec[] = [
  { path: '/NOTE.TXT', data: utf8Encode('A note on a FAT12 volume.\n') },
  { path: '/DOCS', dir: true },
  { path: '/DOCS/README.TXT', data: utf8Encode('Inside a subdirectory.\n'.repeat(40)) },
  {
    path: '/DOCS/A long file name.txt',
    data: utf8Encode('This name needs VFAT long file name entries.\n'),
  },
  {
    path: '/old-secret.txt',
    data: utf8Encode('Deleted, but the clusters are still there: recover me.\n'.repeat(12)),
    deleted: true,
  },
];

export const buildSampleFat = () => buildFat12(FAT_FILES, { label: 'FTF_FAT12' });

export const RASTER = { samples: 64, lines: 48, nanAt: [10, 20] as [number, number] };

/** 64 × 48 float32 little-endian ramp with a ring, one NaN, and its ENVI header. */
export function buildRaster(): { data: Uint8Array; hdr: string } {
  const { samples, lines } = RASTER;
  const data = new Uint8Array(samples * lines * 4);
  const v = new DataView(data.buffer);
  for (let l = 0; l < lines; l++) {
    for (let s = 0; s < samples; s++) {
      const r = Math.hypot(s - samples / 2, l - lines / 2);
      let x = Math.fround(s / samples + (Math.abs(r - 14) < 2 ? 1 : 0));
      if (l === RASTER.nanAt[0] && s === RASTER.nanAt[1]) x = NaN;
      v.setFloat32((l * samples + s) * 4, x, true);
    }
  }
  const hdr = [
    'ENVI',
    'description = {Find The Flag synthetic raster}',
    `samples = ${samples}`,
    `lines = ${lines}`,
    'bands = 1',
    'header offset = 0',
    'file type = ENVI Standard',
    'data type = 4',
    'interleave = bsq',
    'byte order = 0',
    'band names = { ramp with a ring }',
    '',
  ].join('\n');
  return { data, hdr };
}
