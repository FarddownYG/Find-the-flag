/**
 * PE / PE32+ parser (exe, dll, sys): DOS header and stub, Rich header, COFF and optional headers,
 * sections, imports (also delay-load), exports, the resource tree, debug directory, TLS, the CLR
 * header of .NET assemblies, the Authenticode slot and the overlay. Reads a LazyFile on demand and
 * keeps going on truncated or hostile files: a table that cannot be read becomes a note.
 */
import {
  Buf,
  ENTROPY_BUDGET,
  Reader,
  Truncated,
  hex,
  inFile,
  latin1,
  regionEntropy,
  type Budget,
} from './_exe-bin';
import { trailingInfo, upxMarker } from './_exe-common';
import type { Note, SecItem, SectionRow, Trailing } from './_exe-types';

export const MACHINES: Record<number, string> = {
  0x0: 'Unknown',
  0x1d3: 'Matsushita AM33',
  0x8664: 'x86-64 (AMD64)',
  0x1c0: 'ARM little-endian',
  0xaa64: 'ARM64',
  0x1c4: 'ARM Thumb-2',
  0xebc: 'EFI byte code',
  0x14c: 'x86 (Intel 386)',
  0x200: 'Intel IA-64',
  0x6232: 'LoongArch 32-bit',
  0x6264: 'LoongArch 64-bit',
  0x9041: 'Mitsubishi M32R',
  0x266: 'MIPS16',
  0x366: 'MIPS with FPU',
  0x466: 'MIPS16 with FPU',
  0x1f0: 'PowerPC',
  0x1f1: 'PowerPC with FPU',
  0x166: 'MIPS little-endian',
  0x5032: 'RISC-V 32-bit',
  0x5064: 'RISC-V 64-bit',
  0x5128: 'RISC-V 128-bit',
  0x1a2: 'Hitachi SH3',
  0x1a6: 'Hitachi SH4',
  0x1c2: 'ARM Thumb',
  0x169: 'MIPS WCE v2',
};

export const SUBSYSTEMS: Record<number, string> = {
  0: 'Unknown',
  1: 'Native (driver)',
  2: 'Windows GUI',
  3: 'Windows console',
  5: 'OS/2 console',
  7: 'POSIX console',
  9: 'Windows CE GUI',
  10: 'EFI application',
  11: 'EFI boot service driver',
  12: 'EFI runtime driver',
  13: 'EFI ROM',
  14: 'Xbox',
  16: 'Windows boot application',
};

const DIR_NAMES = [
  'Export',
  'Import',
  'Resource',
  'Exception',
  'Security (certificate)',
  'Base relocation',
  'Debug',
  'Architecture',
  'Global pointer',
  'TLS',
  'Load config',
  'Bound import',
  'IAT',
  'Delay import',
  'CLR runtime header',
  'Reserved',
];

const CHARACTERISTICS: [number, string][] = [
  [0x0001, 'RELOCS_STRIPPED'],
  [0x0002, 'EXECUTABLE_IMAGE'],
  [0x0004, 'LINE_NUMS_STRIPPED'],
  [0x0008, 'LOCAL_SYMS_STRIPPED'],
  [0x0010, 'AGGRESSIVE_WS_TRIM'],
  [0x0020, 'LARGE_ADDRESS_AWARE'],
  [0x0080, 'BYTES_REVERSED_LO'],
  [0x0100, '32BIT_MACHINE'],
  [0x0200, 'DEBUG_STRIPPED'],
  [0x0400, 'REMOVABLE_RUN_FROM_SWAP'],
  [0x0800, 'NET_RUN_FROM_SWAP'],
  [0x1000, 'SYSTEM'],
  [0x2000, 'DLL'],
  [0x4000, 'UP_SYSTEM_ONLY'],
  [0x8000, 'BYTES_REVERSED_HI'],
];

export const DLL_CHARACTERISTICS: [number, string, string][] = [
  [0x0020, 'HIGH_ENTROPY_VA', '64-bit ASLR'],
  [0x0040, 'DYNAMIC_BASE', 'ASLR'],
  [0x0080, 'FORCE_INTEGRITY', 'signature checked at load'],
  [0x0100, 'NX_COMPAT', 'DEP'],
  [0x0200, 'NO_ISOLATION', ''],
  [0x0400, 'NO_SEH', ''],
  [0x0800, 'NO_BIND', ''],
  [0x1000, 'APPCONTAINER', ''],
  [0x2000, 'WDM_DRIVER', ''],
  [0x4000, 'GUARD_CF', 'CFG'],
  [0x8000, 'TERMINAL_SERVER_AWARE', ''],
];

const RESOURCE_TYPES: Record<number, string> = {
  1: 'RT_CURSOR',
  2: 'RT_BITMAP',
  3: 'RT_ICON',
  4: 'RT_MENU',
  5: 'RT_DIALOG',
  6: 'RT_STRING',
  7: 'RT_FONTDIR',
  8: 'RT_FONT',
  9: 'RT_ACCELERATOR',
  10: 'RT_RCDATA',
  11: 'RT_MESSAGETABLE',
  12: 'RT_GROUP_CURSOR',
  14: 'RT_GROUP_ICON',
  16: 'RT_VERSION',
  17: 'RT_DLGINCLUDE',
  19: 'RT_PLUGPLAY',
  20: 'RT_VXD',
  21: 'RT_ANICURSOR',
  22: 'RT_ANIICON',
  23: 'RT_HTML',
  24: 'RT_MANIFEST',
};

const DEBUG_TYPES: Record<number, string> = {
  1: 'COFF',
  2: 'CODEVIEW',
  3: 'FPO',
  4: 'MISC',
  5: 'EXCEPTION',
  6: 'FIXUP',
  7: 'OMAP_TO_SRC',
  8: 'OMAP_FROM_SRC',
  9: 'BORLAND',
  10: 'RESERVED10',
  11: 'CLSID',
  12: 'VC_FEATURE',
  13: 'POGO',
  14: 'ILTCG',
  15: 'MPX',
  16: 'REPRO',
  20: 'EX_DLLCHARACTERISTICS',
};

/** Section names that mean a packer, protector or installer stub wrote the file. */
const PACKER_SECTIONS: [RegExp, string][] = [
  [/^UPX[0-9!]/i, 'UPX'],
  [/^\.?(aspack|adata)$/i, 'ASPack'],
  [/^\.?MPRESS[12]$/i, 'MPRESS'],
  [/^\.?petite$/i, 'Petite'],
  [/^\.nsp[0-2]$/i, 'NsPack'],
  [/^\.themida$|^\.winlice$/i, 'Themida / WinLicense'],
  [/^\.vmp[0-9]$/i, 'VMProtect'],
  [/^\.enigma[12]$/i, 'Enigma Protector'],
  [/^\.pec[12]$|^PEC2/i, 'PECompact'],
  [/^\.rlpack$|^\.yp$|^\.y0da$/i, 'RLPack / Y0da'],
  [/^kkrunchy$|^\.packed$|^pebundle$|^PELOCKnt$|^\.neolit/i, 'packer'],
];

export interface PeSection extends SectionRow {
  /** Raw IMAGE_SCN_* bits. */
  characteristics: number;
  /** Virtual address (RVA) and sizes as stored. */
  rva: number;
  virtualSize: number;
  rawSize: number;
}

export interface RichEntry {
  productId: number;
  build: number;
  count: number;
}

export interface RichHeader {
  offset: number;
  size: number;
  key: number;
  /** Checksum recomputed from the DOS header and the entries. */
  computed: number;
  entries: RichEntry[];
}

export interface PeImport {
  dll: string;
  /** "import", or "delay" for the delay-load table. */
  kind: 'import' | 'delay';
  functions: { name: string | null; ordinal: number | null; hint: number | null }[];
  truncated: boolean;
}

export interface PeExportRow {
  ordinal: number;
  rva: number;
  name: string | null;
  forwarder: string | null;
}

export interface PeExports {
  dllName: string;
  timestamp: number;
  base: number;
  count: number;
  named: number;
  rows: PeExportRow[];
}

export interface PeResource {
  typeId: number | null;
  type: string;
  nameId: number | null;
  name: string;
  lang: number | null;
  size: number;
  rva: number;
  /** File offset of the data, or null when it lies outside the file. */
  offset: number | null;
  codepage: number;
}

export interface PeDebugEntry {
  type: string;
  timestamp: number;
  size: number;
  /** CodeView: PDB path, GUID and age. */
  pdb?: string;
  guid?: string;
  age?: number;
  format?: string;
}

export interface PeTls {
  startRaw: bigint;
  endRaw: bigint;
  callbacks: { rva: number; section: string }[];
}

export interface PeClr {
  runtime: string;
  version: string;
  flags: number;
  entryPointToken: number;
  streams: { name: string; offset: number; size: number }[];
  userStrings: string[];
  /** Offset of the metadata root in the file, when it could be located. */
  metadataOffset: number | null;
}

export interface PeInfo {
  dos: { lfanew: number; stub: string | null; stubSize: number };
  peOffset: number;
  coff: {
    machine: number;
    sections: number;
    timestamp: number;
    symbolTable: number;
    symbols: number;
    optionalSize: number;
    characteristics: number;
    flags: string[];
  } | null;
  opt: {
    magic: number;
    plus: boolean;
    linker: string;
    sizeOfCode: number;
    entry: number;
    baseOfCode: number;
    imageBase: bigint;
    sectionAlignment: number;
    fileAlignment: number;
    osVersion: string;
    imageVersion: string;
    subsystemVersion: string;
    sizeOfImage: number;
    sizeOfHeaders: number;
    checksum: number;
    subsystem: number;
    dllCharacteristics: number;
    dllFlags: string[];
    stackReserve: bigint;
    stackCommit: bigint;
    heapReserve: bigint;
    heapCommit: bigint;
    dirCount: number;
  } | null;
  dirs: { index: number; name: string; rva: number; size: number }[];
  sections: PeSection[];
  entrySection: string | null;
  rich: RichHeader | null;
  imports: PeImport[];
  exports: PeExports | null;
  resources: PeResource[];
  debug: PeDebugEntry[];
  tls: PeTls | null;
  clr: PeClr | null;
  certificate: { offset: number; size: number } | null;
  overlay: Trailing | null;
  loadConfig: { cookie: boolean; safeSeh: boolean | null; guardFlags: number | null } | null;
  security: SecItem[];
  /** Signals that the file may be packed (the view turns them into a verdict). */
  packed: Note[];
  hints: Note[];
  upx: boolean;
  isDll: boolean;
  isDriver: boolean;
  /** Number of imported functions (all DLLs). */
  importCount: number;
}

const MAX_SECTIONS = 512;
const MAX_IMPORT_DLLS = 1024;
const MAX_IMPORTS_PER_DLL = 16384;
const MAX_IMPORTS = 100_000;
const MAX_EXPORTS = 20_000;
const MAX_RESOURCES = 4096;

export const isPe = (b: Uint8Array): boolean => b.length >= 0x40 && b[0] === 0x4d && b[1] === 0x5a;

/** The PE signature offset if the bytes hold a DOS header that points at "PE\0\0", else null. */
export function peOffsetOf(b: Uint8Array): number | null {
  if (!isPe(b)) return null;
  const off = (b[0x3c]! | (b[0x3d]! << 8) | (b[0x3e]! << 16) | (b[0x3f]! << 24)) >>> 0;
  if (
    off + 4 <= b.length &&
    b[off] === 0x50 &&
    b[off + 1] === 0x45 &&
    b[off + 2] === 0 &&
    b[off + 3] === 0
  ) {
    return off;
  }
  return null;
}

const rol = (v: number, n: number): number => ((v << (n & 31)) | (v >>> (32 - (n & 31)))) >>> 0;

/** Look for "Rich" in the DOS stub, XOR the entries back and recompute the checksum. */
function readRich(dos: Uint8Array, lfanew: number): RichHeader | null {
  const b = new Buf(dos, true);
  const end = Math.min(lfanew, dos.length) - 4;
  let rich = -1;
  for (let o = 0x40; o <= end; o += 4) {
    if (b.u32(o) === 0x68636952) {
      rich = o;
      break;
    }
  }
  if (rich < 0 || !b.has(rich, 8)) return null;
  const key = b.u32(rich + 4);
  let dans = -1;
  for (let o = rich - 4; o >= 0x40; o -= 4) {
    if ((b.u32(o) ^ key) >>> 0 === 0x536e6144) {
      dans = o;
      break;
    }
  }
  if (dans < 0) return null;
  const entries: RichEntry[] = [];
  for (let o = dans + 16; o + 8 <= rich; o += 8) {
    const id = (b.u32(o) ^ key) >>> 0;
    const count = (b.u32(o + 4) ^ key) >>> 0;
    entries.push({ productId: id >>> 16, build: id & 0xffff, count });
  }
  let sum = dans;
  for (let i = 0; i < dans; i++) {
    if (i >= 0x3c && i < 0x40) continue;
    sum = (sum + rol(dos[i]!, i)) >>> 0;
  }
  for (const e of entries) sum = (sum + rol(((e.productId << 16) | e.build) >>> 0, e.count)) >>> 0;
  return { offset: dans, size: rich + 8 - dans, key, computed: sum, entries };
}

function sectionFlags(c: number): string {
  return `${c & 0x40000000 ? 'R' : '-'}${c & 0x80000000 ? 'W' : '-'}${c & 0x20000000 ? 'X' : '-'}`;
}

function contentFlags(c: number): string {
  const out: string[] = [];
  if (c & 0x20) out.push('CODE');
  if (c & 0x40) out.push('INITIALIZED_DATA');
  if (c & 0x80) out.push('UNINITIALIZED_DATA');
  if (c & 0x02000000) out.push('DISCARDABLE');
  if (c & 0x10000000) out.push('SHARED');
  if (c & 0x04000000) out.push('NOT_CACHED');
  if (c & 0x08000000) out.push('NOT_PAGED');
  return out.join(' ');
}

const guid = (g: Uint8Array): string => {
  const h = (a: number, n: number) =>
    Array.from(g.subarray(a, a + n), (x) => x.toString(16).padStart(2, '0'));
  const rev = (a: number, n: number) => h(a, n).reverse().join('');
  return `{${rev(0, 4)}-${rev(4, 2)}-${rev(6, 2)}-${h(8, 2).join('')}-${h(10, 6).join('')}}`.toUpperCase();
};

/** `deep` also measures entropy and looks for the UPX marker (slower: reads the whole file). */
export async function parsePe(r: Reader, deep = true): Promise<PeInfo> {
  const hints: Note[] = [];
  const info: PeInfo = {
    dos: { lfanew: 0, stub: null, stubSize: 0 },
    peOffset: 0,
    coff: null,
    opt: null,
    dirs: [],
    sections: [],
    entrySection: null,
    rich: null,
    imports: [],
    exports: null,
    resources: [],
    debug: [],
    tls: null,
    clr: null,
    certificate: null,
    overlay: null,
    loadConfig: null,
    security: [],
    packed: [],
    hints,
    upx: false,
    isDll: false,
    isDriver: false,
    importCount: 0,
  };
  const budget: Budget = { left: deep ? ENTROPY_BUDGET : 0 };

  const head = await r.read(0, 0x400);
  const dosBuf = new Buf(head, true);
  let lfanew: number;
  try {
    lfanew = dosBuf.u32(0x3c);
  } catch (e) {
    if (!(e instanceof Truncated)) throw e;
    hints.push({ key: 'dosOnly', level: 'warn' });
    info.upx = deep && (await upxMarker(r));
    return info;
  }
  info.dos.lfanew = lfanew;
  const peBuf = await r.buf(lfanew, 24 + 240, true);
  if (lfanew < 0x40 || lfanew > r.size - 4 || peBuf.length < 24 || peBuf.u32(0) !== 0x4550) {
    hints.push({ key: lfanew > r.size ? 'peOutsideFile' : 'dosOnly', level: 'warn' });
    const stub = latin1(head.subarray(0x40, Math.min(head.length, 0x80)));
    info.dos.stub = /[A-Za-z][ -~]{9,}/.exec(stub)?.[0] ?? null;
    info.upx = deep && (await upxMarker(r));
    return info;
  }
  info.peOffset = lfanew;

  // ---- DOS stub and Rich header ----
  const dosBytes = await r.read(0, Math.min(lfanew, 1 << 16));
  const stubText = /[A-Za-z][ -~]{9,}/.exec(latin1(dosBytes.subarray(0x40)))?.[0] ?? null;
  info.dos.stub = stubText;
  info.dos.stubSize = Math.max(0, lfanew - 0x40);
  try {
    info.rich = readRich(dosBytes, lfanew);
  } catch (e) {
    if (!(e instanceof Truncated)) throw e;
  }
  if (info.rich && info.rich.computed !== info.rich.key) {
    hints.push({ key: 'richBad', level: 'warn' });
  }

  // ---- COFF + optional header ----
  const machine = peBuf.u16(4);
  const nsections = peBuf.u16(6);
  const timestamp = peBuf.u32(8);
  const symbolTable = peBuf.u32(12);
  const nsymbols = peBuf.u32(16);
  const optSize = peBuf.u16(20);
  const characteristics = peBuf.u16(22);
  info.coff = {
    machine,
    sections: nsections,
    timestamp,
    symbolTable,
    symbols: nsymbols,
    optionalSize: optSize,
    characteristics,
    flags: CHARACTERISTICS.filter(([bit]) => characteristics & bit).map(([, n]) => n),
  };
  info.isDll = (characteristics & 0x2000) !== 0;
  if (timestamp !== 0 && (timestamp < 631152000 || timestamp > Date.now() / 1000 + 86400 * 2)) {
    hints.push({ key: 'timestampOdd', level: 'info' });
  }

  const optOff = lfanew + 24;
  let sizeOfHeaders = 0;
  let imageBase = 0n;
  let plus = false;
  const optBuf = await r.buf(optOff, Math.min(optSize, 240), true);
  try {
    const magic = optBuf.u16(0);
    plus = magic === 0x20b;
    if (magic !== 0x10b && magic !== 0x20b) {
      hints.push({ key: 'badOptionalMagic', level: 'warn', params: { magic: hex(magic) } });
    } else {
      imageBase = plus ? optBuf.u64(24) : BigInt(optBuf.u32(28));
      const ver = (o: number) => `${optBuf.u16(o)}.${optBuf.u16(o + 2)}`;
      const dirCountOff = plus ? 108 : 92;
      const dirBase = plus ? 112 : 96;
      const q = (o32: number, o64: number) => (plus ? optBuf.u64(o64) : BigInt(optBuf.u32(o32)));
      const dllChars = optBuf.u16(70);
      sizeOfHeaders = optBuf.u32(60);
      const dirCount = Math.min(optBuf.u32(dirCountOff), 16);
      info.opt = {
        magic,
        plus,
        linker: `${optBuf.u8(2)}.${optBuf.u8(3)}`,
        sizeOfCode: optBuf.u32(4),
        entry: optBuf.u32(16),
        baseOfCode: optBuf.u32(20),
        imageBase,
        sectionAlignment: optBuf.u32(32),
        fileAlignment: optBuf.u32(36),
        osVersion: `${optBuf.u16(40)}.${optBuf.u16(42)}`,
        imageVersion: ver(44),
        subsystemVersion: ver(48),
        sizeOfImage: optBuf.u32(56),
        sizeOfHeaders,
        checksum: optBuf.u32(64),
        subsystem: optBuf.u16(68),
        dllCharacteristics: dllChars,
        dllFlags: DLL_CHARACTERISTICS.filter(([bit]) => dllChars & bit).map(([, n]) => n),
        stackReserve: q(72, 72),
        stackCommit: q(76, 80),
        heapReserve: q(80, 88),
        heapCommit: q(84, 96),
        dirCount,
      };
      for (let i = 0; i < dirCount; i++) {
        const o = dirBase + i * 8;
        if (!optBuf.has(o, 8)) break;
        info.dirs.push({
          index: i,
          name: DIR_NAMES[i] ?? `#${i}`,
          rva: optBuf.u32(o),
          size: optBuf.u32(o + 4),
        });
      }
      info.isDriver = info.opt.subsystem === 1;
    }
  } catch (e) {
    if (!(e instanceof Truncated)) throw e;
    hints.push({ key: 'truncatedHeader', level: 'warn', params: { size: optBuf.length } });
  }

  // ---- sections ----
  const secOff = optOff + optSize;
  const secCount = Math.min(nsections, MAX_SECTIONS);
  if (nsections > MAX_SECTIONS) {
    hints.push({ key: 'capped', level: 'info', params: { what: 'sections', count: MAX_SECTIONS } });
  }
  const secBuf = await r.buf(secOff, secCount * 40, true);
  const haveSecs = Math.floor(secBuf.length / 40);
  if (haveSecs < secCount) {
    hints.push({
      key: secOff > r.size ? 'tableOutside' : 'tableTruncated',
      level: 'warn',
      params: { table: 'section table', have: haveSecs, count: secCount },
    });
  }
  const strTabOff = symbolTable > 0 ? symbolTable + nsymbols * 18 : 0;
  let outside = 0;
  for (let i = 0; i < haveSecs; i++) {
    const o = i * 40;
    let name = latin1(secBuf.slice(o, 8)).replace(/\0.*$/s, '');
    const long = /^\/(\d+)$/.exec(name);
    if (long && strTabOff > 0) {
      const sb = await r.buf(strTabOff + Number(long[1]), 256);
      if (sb.length > 0) name = sb.cstr(0, 255);
    }
    const virtualSize = secBuf.u32(o + 8);
    const rva = secBuf.u32(o + 12);
    const rawSize = secBuf.u32(o + 16);
    const rawPtr = secBuf.u32(o + 20);
    const ch = secBuf.u32(o + 36);
    const holds = rawSize > 0 && rawPtr > 0;
    const out = holds && !inFile(rawPtr, rawSize, r.size);
    if (out) outside++;
    const entropy = holds && !out ? await regionEntropy(r, rawPtr, rawSize, budget) : null;
    info.sections.push({
      index: i,
      name,
      type: '',
      addr: BigInt(rva),
      vsize: BigInt(virtualSize),
      offset: rawPtr,
      size: holds ? rawSize : 0,
      flags: sectionFlags(ch),
      entropy,
      exec: (ch & 0x20000000) !== 0 || (ch & 0x20) !== 0,
      write: (ch & 0x80000000) !== 0,
      outside: out,
      detail: contentFlags(ch),
      characteristics: ch,
      rva,
      virtualSize,
      rawSize,
    });
  }
  if (outside > 0)
    hints.push({ key: 'sectionsBeyondFile', level: 'warn', params: { count: outside } });

  // RVA -> file offset
  const secs = info.sections;
  const rvaToOff = (rva: number): number | null => {
    if (!Number.isFinite(rva) || rva < 0) return null;
    for (const s of secs) {
      const size = Math.max(s.virtualSize, s.rawSize);
      if (rva >= s.rva && rva < s.rva + size) {
        const delta = rva - s.rva;
        if (s.rawSize === 0 || s.offset === 0 || delta >= s.rawSize) return null;
        return s.offset + delta;
      }
    }
    // Inside the headers (before the first section).
    const firstVa = secs.length ? Math.min(...secs.map((s) => s.rva)) : sizeOfHeaders;
    if (rva < Math.max(sizeOfHeaders, 1) && rva < firstVa) return rva;
    return null;
  };
  const sectionAt = (rva: number): string | null => {
    for (const s of secs) {
      if (rva >= s.rva && rva < s.rva + Math.max(s.virtualSize, s.rawSize)) return s.name;
    }
    return null;
  };
  const cstringAt = async (rva: number, max = 512): Promise<string | null> => {
    const off = rvaToOff(rva);
    if (off === null) return null;
    const b = await r.buf(off, max);
    return b.length ? b.cstr(0, max) : null;
  };

  // entry point
  if (info.opt && info.opt.entry !== 0) {
    info.entrySection = sectionAt(info.opt.entry);
    if (info.entrySection === null && !info.isDll) {
      hints.push({ key: 'epOutsideSections', level: 'warn' });
    } else if (info.entrySection !== null) {
      const es = secs.find((s) => s.name === info.entrySection);
      if (es && es.write && !info.isDriver)
        hints.push({ key: 'entryWritableSection', level: 'info', params: { section: es.name } });
    }
  }

  // ---- directories ----
  const dir = (i: number) => info.dirs[i];
  const guarded = async (fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (e) {
      if (!(e instanceof Truncated)) throw e;
      hints.push({ key: 'tableTruncated', level: 'warn', params: { table: 'directory' } });
    }
  };

  await guarded(() => readImports(r, info, dir(1), dir(13), plus, imageBase, rvaToOff, cstringAt));
  await guarded(() => readExports(r, info, dir(0), rvaToOff, cstringAt));
  await guarded(() => readResources(r, info, dir(2), rvaToOff));
  await guarded(() => readDebug(r, info, dir(6), rvaToOff));
  await guarded(() => readTls(r, info, dir(9), plus, imageBase, rvaToOff, sectionAt));
  await guarded(() => readClr(r, info, dir(14), rvaToOff));
  await guarded(() => readLoadConfig(r, info, dir(10), plus, rvaToOff));

  // ---- certificate and overlay ----
  const sec = dir(4);
  if (sec && sec.rva > 0 && sec.size > 0) {
    // For this directory "rva" is a file offset.
    info.certificate = { offset: sec.rva, size: sec.size };
    hints.push({ key: 'signed', level: 'info', params: { size: sec.size } });
  }
  let overlayStart = Math.max(sizeOfHeaders, secOff + haveSecs * 40);
  for (const s of secs) {
    if (s.size > 0 && !s.outside) overlayStart = Math.max(overlayStart, s.offset + s.size);
  }
  if (info.certificate && info.certificate.offset >= overlayStart) {
    // The certificate sits in the overlay: report what is around it separately.
    const c = info.certificate;
    if (c.offset > overlayStart) {
      info.overlay = await trailingInfo(r, overlayStart, c.offset - overlayStart, budget);
    } else if (c.offset + c.size < r.size) {
      const after = c.offset + c.size;
      info.overlay = await trailingInfo(r, after, r.size - after, budget);
    }
  } else if (overlayStart < r.size) {
    info.overlay = await trailingInfo(r, overlayStart, r.size - overlayStart, budget);
  }
  if (info.overlay) {
    hints.push({
      key: 'overlay',
      level: 'info',
      params: { offset: hex(info.overlay.offset), size: info.overlay.size },
    });
  }

  info.upx = deep && (await upxMarker(r));
  computeSecurity(info);
  computePacked(info);
  return info;
}

type RvaToOff = (rva: number) => number | null;
type CString = (rva: number, max?: number) => Promise<string | null>;
type Dir = { index: number; name: string; rva: number; size: number } | undefined;

async function readThunks(
  r: Reader,
  info: PeInfo,
  rvaToOff: RvaToOff,
  thunkRva: number,
  plus: boolean,
): Promise<{ functions: PeImport['functions']; truncated: boolean }> {
  const functions: PeImport['functions'] = [];
  const off = rvaToOff(thunkRva);
  if (off === null) return { functions, truncated: false };
  const word = plus ? 8 : 4;
  const buf = await r.buf(off, MAX_IMPORTS_PER_DLL * word, true);
  let truncated = true;
  for (let i = 0; i + word <= buf.length; i++) {
    const o = i * word;
    const v = plus ? buf.u64(o) : BigInt(buf.u32(o));
    if (v === 0n) {
      truncated = false;
      break;
    }
    if (info.importCount >= MAX_IMPORTS) break;
    info.importCount++;
    const byOrdinal = plus ? (v & 0x8000000000000000n) !== 0n : (v & 0x80000000n) !== 0n;
    if (byOrdinal) {
      functions.push({ name: null, ordinal: Number(v & 0xffffn), hint: null });
    } else {
      const rva = Number(v & 0x7fffffffn);
      const hb = await r.buf(rvaToOff(rva) ?? r.size, 2 + 256);
      if (hb.length >= 3) {
        functions.push({ name: hb.cstr(2, 255), ordinal: null, hint: hb.u16(0) });
      } else {
        functions.push({ name: null, ordinal: null, hint: null });
      }
    }
    if (i + 1 === MAX_IMPORTS_PER_DLL) break;
  }
  return { functions, truncated };
}

async function readImports(
  r: Reader,
  info: PeInfo,
  imp: Dir,
  delay: Dir,
  plus: boolean,
  imageBase: bigint,
  rvaToOff: RvaToOff,
  cstringAt: CString,
): Promise<void> {
  if (imp && imp.rva > 0) {
    const off = rvaToOff(imp.rva);
    if (off !== null) {
      const buf = await r.buf(off, MAX_IMPORT_DLLS * 20, true);
      for (let i = 0; (i + 1) * 20 <= buf.length; i++) {
        const o = i * 20;
        const oft = buf.u32(o);
        const nameRva = buf.u32(o + 12);
        const ft = buf.u32(o + 16);
        if (oft === 0 && nameRva === 0 && ft === 0) break;
        const dll = (await cstringAt(nameRva, 260)) ?? `?${hex(nameRva)}`;
        const t = await readThunks(r, info, rvaToOff, oft !== 0 ? oft : ft, plus);
        info.imports.push({ dll, kind: 'import', ...t });
      }
    }
  }
  if (delay && delay.rva > 0) {
    const off = rvaToOff(delay.rva);
    if (off !== null) {
      const buf = await r.buf(off, MAX_IMPORT_DLLS * 32, true);
      for (let i = 0; (i + 1) * 32 <= buf.length; i++) {
        const o = i * 32;
        const attrs = buf.u32(o);
        const nameField = buf.u32(o + 4);
        if (attrs === 0 && nameField === 0) break;
        // Old-style tables hold virtual addresses instead of RVAs.
        const fix = (v: number) => (attrs & 1 ? v : Number(BigInt(v) - imageBase));
        const dll = (await cstringAt(fix(nameField), 260)) ?? `?${hex(nameField)}`;
        const t = await readThunks(r, info, rvaToOff, fix(buf.u32(o + 16)), plus);
        info.imports.push({ dll, kind: 'delay', ...t });
      }
    }
  }
}

async function readExports(
  r: Reader,
  info: PeInfo,
  exp: Dir,
  rvaToOff: RvaToOff,
  cstringAt: CString,
): Promise<void> {
  if (!exp || exp.rva === 0 || exp.size < 40) return;
  const off = rvaToOff(exp.rva);
  if (off === null) return;
  const d = await r.buf(off, 40, true);
  const nameRva = d.u32(12);
  const base = d.u32(16);
  const nFuncs = d.u32(20);
  const nNames = d.u32(24);
  const funcs = rvaToOff(d.u32(28));
  const names = rvaToOff(d.u32(32));
  const ords = rvaToOff(d.u32(36));
  const countFuncs = Math.min(nFuncs, MAX_EXPORTS);
  const countNames = Math.min(nNames, MAX_EXPORTS);
  const exports: PeExports = {
    dllName: (await cstringAt(nameRva, 260)) ?? '',
    timestamp: d.u32(4),
    base,
    count: nFuncs,
    named: nNames,
    rows: [],
  };
  if (nFuncs > MAX_EXPORTS || nNames > MAX_EXPORTS) {
    info.hints.push({
      key: 'capped',
      level: 'info',
      params: { what: 'exports', count: MAX_EXPORTS },
    });
  }
  if (funcs === null) {
    info.exports = exports;
    return;
  }
  const fb = await r.buf(funcs, countFuncs * 4, true);
  const nb = names === null ? null : await r.buf(names, countNames * 4, true);
  const ob = ords === null ? null : await r.buf(ords, countNames * 2, true);
  const nameByIndex = new Map<number, string>();
  if (nb && ob) {
    for (let j = 0; j < countNames && (j + 1) * 4 <= nb.length && (j + 1) * 2 <= ob.length; j++) {
      const nm = await cstringAt(nb.u32(j * 4), 512);
      if (nm !== null) nameByIndex.set(ob.u16(j * 2), nm);
    }
  }
  for (let i = 0; (i + 1) * 4 <= fb.length; i++) {
    const rva = fb.u32(i * 4);
    if (rva === 0) continue;
    const forwarded = rva >= exp.rva && rva < exp.rva + exp.size;
    exports.rows.push({
      ordinal: base + i,
      rva,
      name: nameByIndex.get(i) ?? null,
      forwarder: forwarded ? await cstringAt(rva, 512) : null,
    });
  }
  info.exports = exports;
}

async function readResources(r: Reader, info: PeInfo, res: Dir, rvaToOff: RvaToOff): Promise<void> {
  if (!res || res.rva === 0 || res.size < 16) return;
  const root = rvaToOff(res.rva);
  if (root === null) return;
  const span = Math.min(res.size, 64 << 20);
  const buf = await r.buf(root, Math.min(span, 8 << 20), true);
  const seen = new Set<number>();
  const nameAt = (off: number): string => {
    const len = buf.u16(off);
    return buf.utf16(off + 2, Math.min(len, 256));
  };
  const walk = (
    dirOff: number,
    depth: number,
    path: { id: number | null; name: string }[],
  ): void => {
    if (depth > 3 || seen.has(dirOff) || info.resources.length >= MAX_RESOURCES) return;
    seen.add(dirOff);
    const named = buf.u16(dirOff + 12);
    const ids = buf.u16(dirOff + 14);
    const total = Math.min(named + ids, 1024);
    for (let i = 0; i < total && info.resources.length < MAX_RESOURCES; i++) {
      const e = dirOff + 16 + i * 8;
      const nameField = buf.u32(e);
      const target = buf.u32(e + 4);
      const label =
        nameField & 0x80000000
          ? { id: null, name: nameAt(nameField & 0x7fffffff) }
          : { id: nameField, name: String(nameField) };
      if (target & 0x80000000) {
        walk(target & 0x7fffffff, depth + 1, [...path, label]);
        continue;
      }
      const d = target;
      const rva = buf.u32(d);
      const size = buf.u32(d + 4);
      const type = path[0] ?? label;
      const name = path.length >= 2 ? path[1]! : label;
      const lang = path.length >= 2 ? label : null;
      const off = rvaToOff(rva);
      info.resources.push({
        typeId: type.id,
        type: type.id !== null ? (RESOURCE_TYPES[type.id] ?? `#${type.id}`) : type.name,
        nameId: name.id,
        name: name.name,
        lang: lang?.id ?? null,
        size,
        rva,
        offset: off !== null && inFile(off, size, r.size) ? off : null,
        codepage: buf.u32(d + 8),
      });
    }
  };
  try {
    walk(0, 1, []);
  } catch (e) {
    if (!(e instanceof Truncated)) throw e;
    info.hints.push({
      key: 'tableTruncated',
      level: 'warn',
      params: { table: 'resource directory' },
    });
  }
}

async function readDebug(r: Reader, info: PeInfo, dbg: Dir, rvaToOff: RvaToOff): Promise<void> {
  if (!dbg || dbg.rva === 0 || dbg.size < 28) return;
  const off = rvaToOff(dbg.rva);
  if (off === null) return;
  const b = await r.buf(off, Math.min(dbg.size, 28 * 32), true);
  for (let i = 0; (i + 1) * 28 <= b.length; i++) {
    const o = i * 28;
    const type = b.u32(o + 12);
    const size = b.u32(o + 16);
    const ptr = b.u32(o + 24);
    const entry: PeDebugEntry = {
      type: DEBUG_TYPES[type] ?? String(type),
      timestamp: b.u32(o + 4),
      size,
    };
    if (type === 2 && ptr > 0 && size >= 8 && inFile(ptr, size, r.size)) {
      const cv = await r.buf(ptr, Math.min(size, 1024), true);
      const sig = latin1(cv.slice(0, 4));
      if (sig === 'RSDS' && cv.length >= 24) {
        entry.format = 'RSDS';
        entry.guid = guid(cv.slice(4, 16));
        entry.age = cv.u32(20);
        entry.pdb = cv.cstr(24, 512);
      } else if (sig === 'NB10' && cv.length >= 16) {
        entry.format = 'NB10';
        entry.age = cv.u32(12);
        entry.pdb = cv.cstr(16, 512);
      }
    }
    info.debug.push(entry);
  }
}

async function readTls(
  r: Reader,
  info: PeInfo,
  tls: Dir,
  plus: boolean,
  imageBase: bigint,
  rvaToOff: RvaToOff,
  sectionAt: (rva: number) => string | null,
): Promise<void> {
  if (!tls || tls.rva === 0) return;
  const off = rvaToOff(tls.rva);
  if (off === null) return;
  const word = plus ? 8 : 4;
  const b = await r.buf(off, word * 4, true);
  const rd = (i: number) => (plus ? b.u64(i * 8) : BigInt(b.u32(i * 4)));
  const cbVa = rd(3);
  const result: PeTls = { startRaw: rd(0), endRaw: rd(1), callbacks: [] };
  if (cbVa !== 0n) {
    const cbOff = rvaToOff(Number(cbVa - imageBase));
    if (cbOff !== null) {
      const cb = await r.buf(cbOff, word * 33, true);
      for (let i = 0; (i + 1) * word <= cb.length && i < 32; i++) {
        const v = plus ? cb.u64(i * 8) : BigInt(cb.u32(i * 4));
        if (v === 0n) break;
        const rva = Number(v - imageBase);
        result.callbacks.push({ rva, section: sectionAt(rva) ?? '' });
      }
    }
  }
  info.tls = result;
  if (result.callbacks.length > 0) {
    info.hints.push({
      key: 'tlsCallbacks',
      level: 'info',
      params: { count: result.callbacks.length },
    });
  }
}

/** Decode the compressed length of a #US heap entry. */
function heapLength(b: Buf, o: number): { len: number; skip: number } | null {
  const first = b.u8(o);
  if ((first & 0x80) === 0) return { len: first, skip: 1 };
  if ((first & 0xc0) === 0x80) return { len: ((first & 0x3f) << 8) | b.u8(o + 1), skip: 2 };
  if ((first & 0xe0) === 0xc0) {
    return {
      len: ((first & 0x1f) << 24) | (b.u8(o + 1) << 16) | (b.u8(o + 2) << 8) | b.u8(o + 3),
      skip: 4,
    };
  }
  return null;
}

async function readClr(r: Reader, info: PeInfo, clr: Dir, rvaToOff: RvaToOff): Promise<void> {
  if (!clr || clr.rva === 0 || clr.size < 72) return;
  const off = rvaToOff(clr.rva);
  if (off === null) return;
  const c = await r.buf(off, 72, true);
  const mdRva = c.u32(8);
  const result: PeClr = {
    runtime: `${c.u16(4)}.${c.u16(6)}`,
    version: '',
    flags: c.u32(16),
    entryPointToken: c.u32(20),
    streams: [],
    userStrings: [],
    metadataOffset: null,
  };
  info.clr = result;
  info.hints.push({ key: 'dotNet', level: 'info' });
  const mdOff = rvaToOff(mdRva);
  if (mdOff === null) return;
  try {
    const m = await r.buf(mdOff, Math.min(c.u32(12) || 65536, 1 << 16), true);
    if (m.u32(0) !== 0x424a5342) return;
    result.metadataOffset = mdOff;
    const vlen = m.u32(12);
    result.version = latin1(m.slice(16, Math.min(vlen, 255))).replace(/\0.*$/s, '');
    let o = 16 + vlen;
    const n = m.u16(o + 2);
    o += 4;
    for (let i = 0; i < Math.min(n, 32); i++) {
      const so = m.u32(o);
      const ss = m.u32(o + 4);
      const name = m.cstr(o + 8, 32);
      result.streams.push({ name, offset: so, size: ss });
      o += 8 + Math.ceil((name.length + 1) / 4) * 4;
    }
    const us = result.streams.find((s) => s.name === '#US');
    if (us && us.size > 0 && us.size < 16 << 20) {
      const heap = await r.buf(mdOff + us.offset, Math.min(us.size, 4 << 20), true);
      let p = 1;
      while (p < heap.length && result.userStrings.length < 2000) {
        const l = heapLength(heap, p);
        if (!l) break;
        p += l.skip;
        if (l.len === 0) continue;
        if (!heap.has(p, l.len)) break;
        const chars = Math.floor((l.len - 1) / 2);
        if (chars > 0) result.userStrings.push(heap.utf16(p, Math.min(chars, 400)));
        p += l.len;
      }
    }
  } catch (e) {
    if (!(e instanceof Truncated)) throw e;
  }
}

async function readLoadConfig(
  r: Reader,
  info: PeInfo,
  lc: Dir,
  plus: boolean,
  rvaToOff: RvaToOff,
): Promise<void> {
  if (!lc || lc.rva === 0) return;
  const off = rvaToOff(lc.rva);
  if (off === null) return;
  const b = await r.buf(off, Math.min(Math.max(lc.size, 4), 0xa0), true);
  const size = b.u32(0);
  const cookieOff = plus ? 0x58 : 0x3c;
  const cookie =
    size >= cookieOff + (plus ? 8 : 4) &&
    (plus ? b.u64(cookieOff) : BigInt(b.u32(cookieOff))) !== 0n;
  let safeSeh: boolean | null = null;
  if (!plus && size >= 0x48) safeSeh = b.u32(0x40) !== 0 && b.u32(0x44) > 0;
  const gfOff = plus ? 0x90 : 0x58;
  const guardFlags = size >= gfOff + 4 && b.has(gfOff, 4) ? b.u32(gfOff) : null;
  info.loadConfig = { cookie, safeSeh, guardFlags };
}

function computeSecurity(info: PeInfo): void {
  const opt = info.opt;
  if (!opt) return;
  const flags = opt.dllCharacteristics;
  const has = (bit: number) => (flags & bit) !== 0;
  const sec = info.security;
  sec.push({
    id: 'aslr',
    state: has(0x40) ? 'enabled' : 'disabled',
    detail: `DYNAMIC_BASE${info.coff && info.coff.characteristics & 1 ? ', but relocations stripped' : ''}`,
  });
  if (opt.plus) {
    sec.push({
      id: 'highEntropyVa',
      state: has(0x20) ? 'enabled' : 'disabled',
      detail: 'HIGH_ENTROPY_VA',
    });
  }
  sec.push({ id: 'dep', state: has(0x100) ? 'enabled' : 'disabled', detail: 'NX_COMPAT' });
  const guard = info.loadConfig?.guardFlags;
  sec.push({
    id: 'cfg',
    state: has(0x4000) ? 'enabled' : 'disabled',
    detail:
      guard !== null && guard !== undefined ? `GUARD_CF, GuardFlags ${hex(guard)}` : 'GUARD_CF',
  });
  if (!opt.plus) {
    const seh = info.loadConfig?.safeSeh;
    if (has(0x400)) sec.push({ id: 'noSeh', state: 'enabled', detail: 'NO_SEH' });
    else if (seh === true) sec.push({ id: 'noSeh', state: 'enabled', detail: 'SafeSEH table' });
    else sec.push({ id: 'noSeh', state: 'disabled', detail: 'no SafeSEH, SEH allowed' });
  }
  if (info.loadConfig) {
    sec.push({
      id: 'cookie',
      state: info.loadConfig.cookie ? 'enabled' : 'disabled',
      detail: 'SecurityCookie',
    });
  }
  if (has(0x80)) sec.push({ id: 'forceIntegrity', state: 'enabled', detail: 'FORCE_INTEGRITY' });
  if (has(0x1000)) sec.push({ id: 'appContainer', state: 'enabled', detail: 'APPCONTAINER' });
  sec.push({
    id: 'signature',
    state: info.certificate ? 'enabled' : 'disabled',
    detail: info.certificate
      ? `${info.certificate.size} bytes at ${hex(info.certificate.offset)} (not verified)`
      : undefined,
  });
}

function computePacked(info: PeInfo): void {
  const out = info.packed;
  const secs = info.sections;
  const byPacker = new Map<string, string[]>();
  for (const s of secs) {
    for (const [re, label] of PACKER_SECTIONS) {
      if (re.test(s.name)) byPacker.set(label, [...(byPacker.get(label) ?? []), s.name]);
    }
  }
  for (const [packer, names] of byPacker) {
    out.push({
      key: 'packedSection',
      level: 'warn',
      params: { section: names.join(', '), packer },
    });
  }
  if (info.upx) out.push({ key: 'packedUpx', level: 'warn' });
  const empty = secs.filter(
    (s) => s.rawSize === 0 && s.virtualSize >= 0x10000 && (s.write || s.exec),
  );
  if (empty.length > 0) {
    out.push({ key: 'packedEmptyRaw', level: 'info', params: { section: empty[0]!.name } });
  }
  const hot = secs.filter(
    (s) =>
      !/^\.?(rsrc|reloc)$/i.test(s.name) &&
      s.size >= 4096 &&
      s.entropy !== null &&
      s.entropy >= 7.2,
  );
  if (hot.length > 0) {
    out.push({
      key: 'packedEntropy',
      level: 'warn',
      params: { sections: hot.map((s) => s.name).join(', '), entropy: hot[0]!.entropy!.toFixed(2) },
    });
  }
  // A stub that resolves everything at run time imports little more than these two.
  const imported = new Set(
    info.imports.flatMap((i) => i.functions.map((f) => (f.name ?? '').toLowerCase())),
  );
  const resolvesAtRuntime =
    imported.has('getprocaddress') &&
    [...imported].some((n) => n.startsWith('loadlibrary')) &&
    info.importCount <= 12;
  if (
    !info.isDll &&
    !info.clr &&
    secs.length > 0 &&
    (resolvesAtRuntime || info.importCount === 0)
  ) {
    out.push({ key: 'packedFewImports', level: 'info', params: { count: info.importCount } });
  }
}
