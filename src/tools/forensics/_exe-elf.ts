/**
 * ELF parser (32/64-bit, little and big endian): header, program headers, section headers,
 * symbol tables, dynamic section, notes, relocations, interpreter and the checksec-style
 * properties. Reads a LazyFile on demand, never executes or disassembles anything, and keeps
 * going on truncated or hostile files (what could not be read becomes a note).
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
import type { Note, SecItem, SectionRow, SymbolRow, Trailing } from './_exe-types';
import { trailingInfo, upxMarker } from './_exe-common';

export const PT = {
  NULL: 0,
  LOAD: 1,
  DYNAMIC: 2,
  INTERP: 3,
  NOTE: 4,
  SHLIB: 5,
  PHDR: 6,
  TLS: 7,
  GNU_EH_FRAME: 0x6474e550,
  GNU_STACK: 0x6474e551,
  GNU_RELRO: 0x6474e552,
  GNU_PROPERTY: 0x6474e553,
} as const;

const PT_NAMES: Record<number, string> = {
  0: 'NULL',
  1: 'LOAD',
  2: 'DYNAMIC',
  3: 'INTERP',
  4: 'NOTE',
  5: 'SHLIB',
  6: 'PHDR',
  7: 'TLS',
  0x6474e550: 'GNU_EH_FRAME',
  0x6474e551: 'GNU_STACK',
  0x6474e552: 'GNU_RELRO',
  0x6474e553: 'GNU_PROPERTY',
  0x6ffffffa: 'SUNWBSS',
  0x6ffffffb: 'SUNWSTACK',
  0x70000001: 'ARM_EXIDX',
  0x70000003: 'RISCV_ATTRIBUTES',
};

const SHT_NAMES: Record<number, string> = {
  0: 'NULL',
  1: 'PROGBITS',
  2: 'SYMTAB',
  3: 'STRTAB',
  4: 'RELA',
  5: 'HASH',
  6: 'DYNAMIC',
  7: 'NOTE',
  8: 'NOBITS',
  9: 'REL',
  10: 'SHLIB',
  11: 'DYNSYM',
  14: 'INIT_ARRAY',
  15: 'FINI_ARRAY',
  16: 'PREINIT_ARRAY',
  17: 'GROUP',
  18: 'SYMTAB_SHNDX',
  19: 'RELR',
  0x6ffffff5: 'GNU_ATTRIBUTES',
  0x6ffffff6: 'GNU_HASH',
  0x6ffffff7: 'GNU_LIBLIST',
  0x6ffffffd: 'VERDEF',
  0x6ffffffe: 'VERNEED',
  0x6fffffff: 'VERSYM',
  0x70000001: 'ARM_EXIDX',
  0x70000003: 'ARM_ATTRIBUTES',
};
const SHT = {
  SYMTAB: 2,
  STRTAB: 3,
  RELA: 4,
  HASH: 5,
  DYNAMIC: 6,
  NOTE: 7,
  NOBITS: 8,
  REL: 9,
  DYNSYM: 11,
  RELR: 19,
  VERDEF: 0x6ffffffd,
  VERNEED: 0x6ffffffe,
  VERSYM: 0x6fffffff,
} as const;

export const ET_NAMES: Record<number, string> = {
  0: 'NONE',
  1: 'REL',
  2: 'EXEC',
  3: 'DYN',
  4: 'CORE',
};

export const MACHINES: Record<number, string> = {
  0: 'None',
  2: 'SPARC',
  3: 'x86 (Intel 80386)',
  4: 'Motorola 68000',
  6: 'Intel MCU',
  8: 'MIPS',
  10: 'MIPS (little-endian)',
  15: 'HP PA-RISC',
  18: 'SPARC32+',
  20: 'PowerPC',
  21: 'PowerPC 64-bit',
  22: 'IBM S/390',
  40: 'ARM',
  42: 'Renesas SuperH',
  43: 'SPARC V9',
  50: 'Intel IA-64',
  62: 'x86-64 (AMD64)',
  83: 'Atmel AVR',
  92: 'OpenRISC',
  94: 'Tensilica Xtensa',
  105: 'TI MSP430',
  164: 'Qualcomm Hexagon',
  183: 'AArch64 (ARM 64-bit)',
  189: 'Xilinx MicroBlaze',
  220: 'Zilog Z80',
  243: 'RISC-V',
  247: 'Linux BPF',
  252: 'C-SKY',
  258: 'LoongArch',
};

export const OSABI: Record<number, string> = {
  0: 'UNIX System V',
  1: 'HP-UX',
  2: 'NetBSD',
  3: 'Linux (GNU)',
  4: 'GNU Hurd',
  6: 'Solaris',
  7: 'AIX',
  8: 'IRIX',
  9: 'FreeBSD',
  10: 'Tru64',
  12: 'OpenBSD',
  13: 'OpenVMS',
  64: 'ARM EABI',
  97: 'ARM',
  255: 'standalone',
};

const DT_NAMES: Record<number, string> = {
  0: 'NULL',
  1: 'NEEDED',
  2: 'PLTRELSZ',
  3: 'PLTGOT',
  4: 'HASH',
  5: 'STRTAB',
  6: 'SYMTAB',
  7: 'RELA',
  8: 'RELASZ',
  9: 'RELAENT',
  10: 'STRSZ',
  11: 'SYMENT',
  12: 'INIT',
  13: 'FINI',
  14: 'SONAME',
  15: 'RPATH',
  16: 'SYMBOLIC',
  17: 'REL',
  18: 'RELSZ',
  19: 'RELENT',
  20: 'PLTREL',
  21: 'DEBUG',
  22: 'TEXTREL',
  23: 'JMPREL',
  24: 'BIND_NOW',
  25: 'INIT_ARRAY',
  26: 'FINI_ARRAY',
  27: 'INIT_ARRAYSZ',
  28: 'FINI_ARRAYSZ',
  29: 'RUNPATH',
  30: 'FLAGS',
  32: 'PREINIT_ARRAY',
  33: 'PREINIT_ARRAYSZ',
  34: 'SYMTAB_SHNDX',
  35: 'RELRSZ',
  36: 'RELR',
  37: 'RELRENT',
  0x6ffffef5: 'GNU_HASH',
  0x6ffffef6: 'TLSDESC_PLT',
  0x6ffffef7: 'TLSDESC_GOT',
  0x6ffffff0: 'VERSYM',
  0x6ffffff9: 'RELACOUNT',
  0x6ffffffa: 'RELCOUNT',
  0x6ffffffb: 'FLAGS_1',
  0x6ffffffc: 'VERDEF',
  0x6ffffffd: 'VERDEFNUM',
  0x6ffffffe: 'VERNEED',
  0x6fffffff: 'VERNEEDNUM',
};
const DT = {
  NULL: 0,
  NEEDED: 1,
  PLTRELSZ: 2,
  HASH: 4,
  STRTAB: 5,
  SYMTAB: 6,
  RELA: 7,
  RELASZ: 8,
  STRSZ: 10,
  SONAME: 14,
  RPATH: 15,
  REL: 17,
  RELSZ: 18,
  JMPREL: 23,
  BIND_NOW: 24,
  RUNPATH: 29,
  FLAGS: 30,
  FLAGS_1: 0x6ffffffb,
} as const;

const DF_FLAGS: [number, string][] = [
  [1, 'ORIGIN'],
  [2, 'SYMBOLIC'],
  [4, 'TEXTREL'],
  [8, 'BIND_NOW'],
  [0x10, 'STATIC_TLS'],
];
const DF_1_FLAGS: [number, string][] = [
  [1, 'NOW'],
  [2, 'GLOBAL'],
  [4, 'GROUP'],
  [8, 'NODELETE'],
  [0x10, 'LOADFLTR'],
  [0x20, 'INITFIRST'],
  [0x40, 'NOOPEN'],
  [0x80, 'ORIGIN'],
  [0x100, 'DIRECT'],
  [0x400, 'INTERPOSE'],
  [0x800, 'NODEFLIB'],
  [0x1000, 'NODUMP'],
  [0x8000000, 'PIE'],
];

const SYM_KIND: Record<number, string> = {
  0: 'NOTYPE',
  1: 'OBJECT',
  2: 'FUNC',
  3: 'SECTION',
  4: 'FILE',
  5: 'COMMON',
  6: 'TLS',
  10: 'IFUNC',
};
const SYM_BIND: Record<number, string> = { 0: 'LOCAL', 1: 'GLOBAL', 2: 'WEAK', 10: 'UNIQUE' };

export interface ElfHeader {
  bits: 32 | 64;
  le: boolean;
  osabi: number;
  abiVersion: number;
  type: number;
  machine: number;
  version: number;
  entry: bigint;
  phoff: number;
  shoff: number;
  flags: number;
  ehsize: number;
  phentsize: number;
  phnum: number;
  shentsize: number;
  shnum: number;
  shstrndx: number;
}

export interface ElfSegment {
  index: number;
  type: number;
  typeName: string;
  flags: number;
  offset: number;
  vaddr: bigint;
  paddr: bigint;
  filesz: number;
  memsz: bigint;
  align: bigint;
}

export interface ElfDynamic {
  tag: number;
  tagName: string;
  value: bigint;
  /** Library name, path or flag names when the entry has them. */
  text: string;
}

export interface ElfNote {
  where: string;
  owner: string;
  type: number;
  typeName: string;
  /** Build id as hex, "Linux 3.2.0", property names, a Go build id, or a printable preview. */
  value: string;
}

export interface ElfInfo {
  header: ElfHeader | null;
  segments: ElfSegment[];
  sections: SectionRow[];
  /** Section headers as read (types are numbers), aligned with `sections`. */
  rawTypes: number[];
  interp: string | null;
  dynamic: ElfDynamic[];
  needed: string[];
  soname: string | null;
  rpath: string | null;
  runpath: string | null;
  bindNow: boolean;
  flags: string[];
  flags1: string[];
  symbols: SymbolRow[];
  symbolsTotal: number;
  hasSymtab: boolean;
  hasDynsym: boolean;
  notes: ElfNote[];
  relocs: { section: string; count: number }[];
  comment: string[];
  security: SecItem[];
  hints: Note[];
  /** Signals that the file may be packed (the view turns them into a verdict). */
  packed: Note[];
  trailing: Trailing | null;
  /** Where the file ends according to its headers. */
  declaredEnd: number;
  upx: boolean;
}

interface RawSection {
  index: number;
  nameOff: number;
  type: number;
  flags: bigint;
  addr: bigint;
  offset: number;
  size: number;
  link: number;
  info: number;
  entsize: number;
  align: bigint;
}

const MAX_PH = 4096;
const MAX_SH = 65536;
const MAX_SYMBOLS = 400_000;
const MAX_STRTAB = 48 << 20;

const utf8 = new TextDecoder('utf-8');

const strAt = (tab: Uint8Array, off: number): string => {
  if (!Number.isInteger(off) || off < 0 || off >= tab.length) return '';
  let end = off;
  while (end < tab.length && tab[end] !== 0) end++;
  return utf8.decode(tab.subarray(off, end));
};

export const isElf = (b: Uint8Array): boolean =>
  b.length >= 20 &&
  b[0] === 0x7f &&
  b[1] === 0x45 &&
  b[2] === 0x4c &&
  b[3] === 0x46 &&
  (b[4] === 1 || b[4] === 2) &&
  (b[5] === 1 || b[5] === 2);

function flagLetters(flags: bigint): string {
  const table: [bigint, string][] = [
    [0x1n, 'W'],
    [0x2n, 'A'],
    [0x4n, 'X'],
    [0x10n, 'M'],
    [0x20n, 'S'],
    [0x40n, 'I'],
    [0x80n, 'L'],
    [0x100n, 'O'],
    [0x200n, 'G'],
    [0x400n, 'T'],
    [0x800n, 'C'],
  ];
  return table
    .filter(([bit]) => flags & bit)
    .map(([, c]) => c)
    .join('');
}

/** `deep` also measures entropy and looks for the UPX marker (slower: reads the whole file). */
export async function parseElf(r: Reader, deep = true): Promise<ElfInfo> {
  const hints: Note[] = [];
  const info: ElfInfo = {
    header: null,
    segments: [],
    sections: [],
    rawTypes: [],
    interp: null,
    dynamic: [],
    needed: [],
    soname: null,
    rpath: null,
    runpath: null,
    bindNow: false,
    flags: [],
    flags1: [],
    symbols: [],
    symbolsTotal: 0,
    hasSymtab: false,
    hasDynsym: false,
    notes: [],
    relocs: [],
    comment: [],
    security: [],
    hints,
    packed: [],
    trailing: null,
    declaredEnd: 0,
    upx: false,
  };
  const budget: Budget = { left: deep ? ENTROPY_BUDGET : 0 };

  const head = await r.buf(0, 64);
  const bits = head.u8(4) === 2 ? 64 : 32;
  const le = head.u8(5) !== 2;
  const h = head.order(le);
  let header: ElfHeader;
  try {
    header = readHeader(h, bits, le);
  } catch (e) {
    if (!(e instanceof Truncated)) throw e;
    hints.push({ key: 'truncatedHeader', level: 'warn', params: { size: head.length } });
    info.upx = deep && (await upxMarker(r));
    return info;
  }
  info.header = header;
  info.declaredEnd = header.ehsize || (bits === 64 ? 64 : 52);
  const wide = bits === 64;

  // ---- program headers ----
  const phMin = wide ? 56 : 32;
  if (header.phnum > 0) {
    if (header.phentsize < phMin) {
      hints.push({ key: 'tableOutside', level: 'warn', params: { table: 'program headers' } });
    } else {
      const count = Math.min(header.phnum, MAX_PH);
      const tb = await r.buf(header.phoff, count * header.phentsize, le);
      const have = Math.floor(tb.length / header.phentsize);
      if (have < count) {
        hints.push({
          key: header.phoff > r.size ? 'tableOutside' : 'tableTruncated',
          level: 'warn',
          params: { table: 'program headers', have, count },
        });
      }
      for (let i = 0; i < have; i++)
        info.segments.push(readSegment(tb, i * header.phentsize, wide, i));
      info.declaredEnd = Math.max(info.declaredEnd, header.phoff + have * header.phentsize);
    }
  }

  // ---- section headers ----
  const raw: RawSection[] = [];
  const shMin = wide ? 64 : 40;
  let shnum = header.shnum;
  let shstrndx = header.shstrndx;
  if (header.shoff > 0 && header.shentsize >= shMin) {
    if (shnum === 0 || shstrndx === 0xffff) {
      // Extended numbering: the real values hide in the (otherwise empty) section 0.
      const first = await r.buf(header.shoff, header.shentsize, le);
      try {
        const s0 = readRawSection(first, 0, wide, 0);
        if (shnum === 0) shnum = Math.min(s0.size, MAX_SH);
        if (shstrndx === 0xffff) shstrndx = s0.link;
      } catch (e) {
        if (!(e instanceof Truncated)) throw e;
      }
    }
    const count = Math.min(shnum, MAX_SH);
    if (count > 0) {
      const tb = await r.buf(header.shoff, count * header.shentsize, le);
      const have = Math.floor(tb.length / header.shentsize);
      if (have < count) {
        hints.push({
          key: header.shoff > r.size ? 'tableOutside' : 'tableTruncated',
          level: 'warn',
          params: { table: 'section headers', have, count },
        });
      }
      for (let i = 0; i < have; i++) raw.push(readRawSection(tb, i * header.shentsize, wide, i));
      info.declaredEnd = Math.max(info.declaredEnd, header.shoff + have * header.shentsize);
    }
  } else if (header.shoff > 0 && header.shnum > 0) {
    hints.push({ key: 'tableOutside', level: 'warn', params: { table: 'section headers' } });
  }

  // section names
  let shstr: Uint8Array = new Uint8Array(0);
  const strSec = raw[shstrndx];
  if (strSec && strSec.type !== SHT.NOBITS && inFile(strSec.offset, strSec.size, r.size)) {
    shstr = await r.read(strSec.offset, Math.min(strSec.size, 4 << 20));
  }
  const names = raw.map((s) => strAt(shstr, s.nameOff));
  let outside = 0;
  for (const s of raw) {
    const row = await sectionRow(r, s, names[s.index] ?? '', budget);
    if (row.outside) outside++;
    info.sections.push(row);
    info.rawTypes.push(s.type);
    if (s.type !== 0 && s.type !== SHT.NOBITS && inFile(s.offset, s.size, r.size)) {
      info.declaredEnd = Math.max(info.declaredEnd, s.offset + s.size);
    }
  }
  if (outside > 0)
    hints.push({ key: 'sectionsBeyondFile', level: 'warn', params: { count: outside } });
  if (raw.length === 0 && header.type !== 1) hints.push({ key: 'noSections', level: 'info' });

  for (const s of info.segments) {
    if (s.type !== PT.NULL && inFile(s.offset, s.filesz, r.size)) {
      info.declaredEnd = Math.max(info.declaredEnd, s.offset + s.filesz);
    }
  }

  // ---- interpreter ----
  const interp = info.segments.find((s) => s.type === PT.INTERP);
  if (interp && interp.filesz > 0 && interp.filesz <= 4096) {
    const b = await r.read(interp.offset, interp.filesz);
    info.interp = utf8.decode(b.subarray(0, b.indexOf(0) < 0 ? b.length : b.indexOf(0)));
  }

  // ---- dynamic section ----
  await readDynamic(r, info, raw, names, header, wide);

  // ---- symbols ----
  await readSymbols(r, info, raw, names, header, wide);

  // ---- notes, relocations, comment ----
  await readNotes(r, info, raw, names, header);
  readRelocs(info, raw, names, header, wide);
  for (const s of raw) {
    if (names[s.index] === '.comment' && inFile(s.offset, s.size, r.size) && s.size <= 65536) {
      const b = await r.read(s.offset, s.size);
      info.comment = latin1(b)
        .split('\0')
        .filter((x) => x.length > 0)
        .slice(0, 16);
    }
  }

  // ---- trailing data ----
  if (info.declaredEnd > 0 && info.declaredEnd < r.size) {
    info.trailing = await trailingInfo(r, info.declaredEnd, r.size - info.declaredEnd, budget);
  }

  info.upx = deep && (await upxMarker(r));
  computeSecurity(info);
  computeHints(info, raw, names);
  return info;
}

function readHeader(h: Buf, bits: 32 | 64, le: boolean): ElfHeader {
  const wide = bits === 64;
  return {
    bits,
    le,
    osabi: h.u8(7),
    abiVersion: h.u8(8),
    type: h.u16(16),
    machine: h.u16(18),
    version: h.u32(20),
    entry: h.word(24, wide),
    phoff: h.wordNum(wide ? 32 : 28, wide),
    shoff: h.wordNum(wide ? 40 : 32, wide),
    flags: h.u32(wide ? 48 : 36),
    ehsize: h.u16(wide ? 52 : 40),
    phentsize: h.u16(wide ? 54 : 42),
    phnum: h.u16(wide ? 56 : 44),
    shentsize: h.u16(wide ? 58 : 46),
    shnum: h.u16(wide ? 60 : 48),
    shstrndx: h.u16(wide ? 62 : 50),
  };
}

function readSegment(b: Buf, o: number, wide: boolean, index: number): ElfSegment {
  const type = b.u32(o);
  const base = {
    index,
    type,
    typeName: PT_NAMES[type] ?? hex(type),
  };
  if (wide) {
    return {
      ...base,
      flags: b.u32(o + 4),
      offset: b.num64(o + 8),
      vaddr: b.u64(o + 16),
      paddr: b.u64(o + 24),
      filesz: b.num64(o + 32),
      memsz: b.u64(o + 40),
      align: b.u64(o + 48),
    };
  }
  return {
    ...base,
    offset: b.u32(o + 4),
    vaddr: BigInt(b.u32(o + 8)),
    paddr: BigInt(b.u32(o + 12)),
    filesz: b.u32(o + 16),
    memsz: BigInt(b.u32(o + 20)),
    flags: b.u32(o + 24),
    align: BigInt(b.u32(o + 28)),
  };
}

function readRawSection(b: Buf, o: number, wide: boolean, index: number): RawSection {
  if (wide) {
    return {
      index,
      nameOff: b.u32(o),
      type: b.u32(o + 4),
      flags: b.u64(o + 8),
      addr: b.u64(o + 16),
      offset: b.num64(o + 24),
      size: b.num64(o + 32),
      link: b.u32(o + 40),
      info: b.u32(o + 44),
      align: b.u64(o + 48),
      entsize: b.num64(o + 56),
    };
  }
  return {
    index,
    nameOff: b.u32(o),
    type: b.u32(o + 4),
    flags: BigInt(b.u32(o + 8)),
    addr: BigInt(b.u32(o + 12)),
    offset: b.u32(o + 16),
    size: b.u32(o + 20),
    link: b.u32(o + 24),
    info: b.u32(o + 28),
    align: BigInt(b.u32(o + 32)),
    entsize: b.u32(o + 36),
  };
}

async function sectionRow(
  r: Reader,
  s: RawSection,
  name: string,
  budget: Budget,
): Promise<SectionRow> {
  const holds = s.type !== 0 && s.type !== SHT.NOBITS;
  const outside = holds && s.size > 0 && !inFile(s.offset, s.size, r.size);
  const entropy =
    holds && s.size > 0 && !outside ? await regionEntropy(r, s.offset, s.size, budget) : null;
  return {
    index: s.index,
    name,
    type: SHT_NAMES[s.type] ?? hex(s.type),
    addr: s.addr,
    vsize: BigInt(Number.isFinite(s.size) ? s.size : 0),
    offset: s.offset,
    size: holds ? s.size : 0,
    flags: flagLetters(s.flags),
    entropy,
    exec: (s.flags & 0x4n) !== 0n,
    write: (s.flags & 0x1n) !== 0n,
    outside,
  };
}

/** File offset of a virtual address, through the PT_LOAD segments (sections as a fallback). */
function vaddrToOffset(info: ElfInfo, raw: RawSection[], va: bigint): number | null {
  for (const s of info.segments) {
    if (s.type !== PT.LOAD) continue;
    if (va >= s.vaddr && va < s.vaddr + BigInt(Number.isFinite(s.filesz) ? s.filesz : 0)) {
      return s.offset + Number(va - s.vaddr);
    }
  }
  for (const s of raw) {
    if ((s.flags & 0x2n) === 0n || s.type === SHT.NOBITS) continue;
    if (va >= s.addr && va < s.addr + BigInt(Number.isFinite(s.size) ? s.size : 0)) {
      return s.offset + Number(va - s.addr);
    }
  }
  return null;
}

async function readDynamic(
  r: Reader,
  info: ElfInfo,
  raw: RawSection[],
  names: string[],
  header: ElfHeader,
  wide: boolean,
): Promise<void> {
  const seg = info.segments.find((s) => s.type === PT.DYNAMIC);
  const sec = raw.find((s) => s.type === SHT.DYNAMIC);
  const off = seg ? seg.offset : sec ? sec.offset : -1;
  const len = seg ? seg.filesz : sec ? sec.size : 0;
  if (off < 0 || !inFile(off, 0, r.size)) return;
  const entSize = wide ? 16 : 8;
  const b = await r.buf(off, Math.min(len, 4096 * entSize), header.le);
  const entries: { tag: number; value: bigint }[] = [];
  for (let o = 0; o + entSize <= b.length; o += entSize) {
    const tag = wide ? b.num64(o) : b.i32(o);
    const value = b.word(o + (wide ? 8 : 4), wide);
    if (tag === DT.NULL) break;
    entries.push({ tag, value });
  }
  const val = (tag: number): bigint | undefined => entries.find((e) => e.tag === tag)?.value;

  // dynstr
  let dynstr: Uint8Array = new Uint8Array(0);
  const strVa = val(DT.STRTAB);
  let strOff = strVa === undefined ? null : vaddrToOffset(info, raw, strVa);
  let strLen = Number(val(DT.STRSZ) ?? 0n);
  if (strOff === null && sec && raw[sec.link]?.type === SHT.STRTAB) {
    strOff = raw[sec.link]!.offset;
    strLen = raw[sec.link]!.size;
  }
  if (strOff !== null) {
    dynstr = await r.read(strOff, Math.min(strLen > 0 ? strLen : 1 << 20, MAX_STRTAB));
  }

  for (const e of entries) {
    const tagName = DT_NAMES[e.tag] ?? hex(e.tag);
    let text = '';
    if (e.tag === DT.NEEDED) {
      text = strAt(dynstr, Number(e.value));
      info.needed.push(text);
    } else if (e.tag === DT.SONAME) {
      text = strAt(dynstr, Number(e.value));
      info.soname = text;
    } else if (e.tag === DT.RPATH) {
      text = strAt(dynstr, Number(e.value));
      info.rpath = text;
    } else if (e.tag === DT.RUNPATH) {
      text = strAt(dynstr, Number(e.value));
      info.runpath = text;
    } else if (e.tag === DT.FLAGS) {
      info.flags = DF_FLAGS.filter(([bit]) => Number(e.value) & bit).map(([, n]) => n);
      text = info.flags.join(' ');
    } else if (e.tag === DT.FLAGS_1) {
      info.flags1 = DF_1_FLAGS.filter(([bit]) => Number(e.value) & bit).map(([, n]) => n);
      text = info.flags1.join(' ');
    } else if (e.tag === DT.BIND_NOW) {
      text = 'BIND_NOW';
    }
    info.dynamic.push({ tag: e.tag, tagName, value: e.value, text });
  }
  info.bindNow =
    entries.some((e) => e.tag === DT.BIND_NOW) ||
    info.flags.includes('BIND_NOW') ||
    info.flags1.includes('NOW');
  // Dynamic info for the symbol reader when there are no section headers.
  dynamicTables.set(info, { entries, dynstr, strOff });
}

interface DynamicTables {
  entries: { tag: number; value: bigint }[];
  dynstr: Uint8Array;
  strOff: number | null;
}
const dynamicTables = new WeakMap<ElfInfo, DynamicTables>();

async function readSymbols(
  r: Reader,
  info: ElfInfo,
  raw: RawSection[],
  names: string[],
  header: ElfHeader,
  wide: boolean,
): Promise<void> {
  const entSize = wide ? 24 : 16;
  const versions = await readVersions(r, raw, header);
  type Table = { label: string; off: number; count: number; str: Uint8Array; sectionIdx: number };
  const tables: Table[] = [];
  for (const s of raw) {
    if (s.type !== SHT.SYMTAB && s.type !== SHT.DYNSYM) continue;
    const strSection = raw[s.link];
    if (!strSection || strSection.type !== SHT.STRTAB) continue;
    if (!inFile(s.offset, 0, r.size) || !inFile(strSection.offset, 0, r.size)) continue;
    const count = Math.floor(Math.min(s.size, r.size - s.offset) / entSize);
    const str = await r.read(strSection.offset, Math.min(strSection.size, MAX_STRTAB));
    tables.push({
      label: s.type === SHT.SYMTAB ? 'symtab' : 'dynsym',
      off: s.offset,
      count,
      str,
      sectionIdx: s.index,
    });
  }
  if (!tables.some((t) => t.label === 'dynsym')) {
    // No section headers: find .dynsym through the dynamic section.
    const dyn = dynamicTables.get(info);
    const symVa = dyn?.entries.find((e) => e.tag === DT.SYMTAB)?.value;
    const symOff = symVa === undefined ? null : vaddrToOffset(info, raw, symVa);
    if (dyn && symOff !== null && dyn.dynstr.length > 0) {
      let count = 0;
      const hashVa = dyn.entries.find((e) => e.tag === DT.HASH)?.value;
      const hashOff = hashVa === undefined ? null : vaddrToOffset(info, raw, hashVa);
      if (hashOff !== null) {
        const hb = await r.buf(hashOff, 8, header.le);
        if (hb.length === 8) count = hb.u32(4);
      } else if (dyn.strOff !== null && dyn.strOff > symOff) {
        count = Math.floor((dyn.strOff - symOff) / entSize);
      }
      if (count > 0) {
        tables.push({ label: 'dynsym', off: symOff, count, str: dyn.dynstr, sectionIdx: -1 });
      }
    }
  }
  info.hasSymtab = tables.some((t) => t.label === 'symtab');
  info.hasDynsym = tables.some((t) => t.label === 'dynsym');

  for (const t of tables) {
    info.symbolsTotal += t.count;
    const keep = Math.min(t.count, MAX_SYMBOLS, Math.max(0, MAX_SYMBOLS - info.symbols.length));
    if (keep < t.count) {
      info.hints.push({ key: 'capped', level: 'info', params: { what: t.label, count: keep } });
    }
    const b = await r.buf(t.off, keep * entSize, header.le);
    const have = Math.floor(b.length / entSize);
    for (let i = 0; i < have; i++) {
      const o = i * entSize;
      const nameOff = b.u32(o);
      let info8: number;
      let shndx: number;
      let value: bigint;
      let size: number;
      if (wide) {
        info8 = b.u8(o + 4);
        shndx = b.u16(o + 6);
        value = b.u64(o + 8);
        size = b.num64(o + 16);
      } else {
        value = BigInt(b.u32(o + 4));
        size = b.u32(o + 8);
        info8 = b.u8(o + 12);
        shndx = b.u16(o + 14);
      }
      const type = info8 & 0xf;
      const bind = info8 >> 4;
      let name = strAt(t.str, nameOff);
      // A section symbol has no name of its own: it stands for its section (readelf does the same).
      if (!name && type === 3 && names[shndx]) name = names[shndx]!;
      let section: string;
      if (shndx === 0) section = 'UND';
      else if (shndx === 0xfff1) section = 'ABS';
      else if (shndx === 0xfff2) section = 'COMMON';
      else if (shndx === 0xffff) section = 'XINDEX';
      else section = names[shndx] || String(shndx);
      info.symbols.push({
        table: t.label,
        index: i,
        name,
        value,
        size,
        kind: SYM_KIND[type] ?? hex(type),
        bind: SYM_BIND[bind] ?? hex(bind),
        section,
        version: t.label === 'dynsym' ? (versions(i) ?? '') : '',
        undefined: shndx === 0 && i > 0,
      });
    }
  }
}

/** Symbol versions of .dynsym ("GLIBC_2.2.5") from .gnu.version, .gnu.version_r and .gnu.version_d. */
async function readVersions(
  r: Reader,
  raw: RawSection[],
  header: ElfHeader,
): Promise<(index: number) => string | undefined> {
  const versym = raw.find((s) => s.type === SHT.VERSYM);
  if (!versym || !inFile(versym.offset, 0, r.size)) return () => undefined;
  const byIndex = new Map<number, string>();
  const strOf = async (sec: RawSection): Promise<Uint8Array> => {
    const strSection = raw[sec.link];
    if (!strSection || strSection.type !== SHT.STRTAB) return new Uint8Array(0);
    return r.read(strSection.offset, Math.min(strSection.size, MAX_STRTAB));
  };
  try {
    const need = raw.find((s) => s.type === SHT.VERNEED);
    if (need && inFile(need.offset, 0, r.size)) {
      const str = await strOf(need);
      const b = await r.buf(need.offset, Math.min(need.size, 1 << 20), header.le);
      let o = 0;
      for (let n = 0; n < Math.min(need.info, 4096); n++) {
        const cnt = b.u16(o + 2);
        const aux = b.u32(o + 8);
        const next = b.u32(o + 12);
        let a = o + aux;
        for (let k = 0; k < cnt; k++) {
          byIndex.set(b.u16(a + 6) & 0x7fff, strAt(str, b.u32(a + 8)));
          const an = b.u32(a + 12);
          if (an === 0) break;
          a += an;
        }
        if (next === 0) break;
        o += next;
      }
    }
    const def = raw.find((s) => s.type === SHT.VERDEF);
    if (def && inFile(def.offset, 0, r.size)) {
      const str = await strOf(def);
      const b = await r.buf(def.offset, Math.min(def.size, 1 << 20), header.le);
      let o = 0;
      for (let n = 0; n < Math.min(def.info, 4096); n++) {
        const ndx = b.u16(o + 4) & 0x7fff;
        const aux = b.u32(o + 12);
        const next = b.u32(o + 16);
        byIndex.set(ndx, strAt(str, b.u32(o + aux)));
        if (next === 0) break;
        o += next;
      }
    }
  } catch (e) {
    if (!(e instanceof Truncated)) throw e;
  }
  const table = await r.buf(versym.offset, Math.min(versym.size, 2 * MAX_SYMBOLS), header.le);
  return (index) => {
    if (index * 2 + 2 > table.length) return undefined;
    const v = table.u16(index * 2);
    if (v <= 1) return undefined; // 0 local, 1 global (unversioned)
    const name = byIndex.get(v & 0x7fff);
    return name ? ((v & 0x8000) !== 0 ? `${name} (hidden)` : name) : undefined;
  };
}

const NT_GNU = { ABI_TAG: 1, BUILD_ID: 3, GOLD_VERSION: 4, PROPERTY: 5 } as const;
const GNU_ABI_OS = ['Linux', 'Hurd', 'Solaris', 'FreeBSD', 'NetBSD', 'Syllable', 'NaCl'];

async function readNotes(
  r: Reader,
  info: ElfInfo,
  raw: RawSection[],
  names: string[],
  header: ElfHeader,
): Promise<void> {
  const places: { where: string; off: number; size: number; align: number }[] = [];
  for (const s of raw) {
    if (s.type === SHT.NOTE && inFile(s.offset, s.size, r.size)) {
      places.push({
        where: names[s.index] || `[${s.index}]`,
        off: s.offset,
        size: s.size,
        align: s.align === 8n ? 8 : 4,
      });
    }
  }
  if (places.length === 0) {
    for (const s of info.segments) {
      if (s.type === PT.NOTE && inFile(s.offset, s.filesz, r.size)) {
        places.push({
          where: 'PT_NOTE',
          off: s.offset,
          size: s.filesz,
          align: s.align === 8n ? 8 : 4,
        });
      }
    }
  }
  for (const p of places) {
    if (p.size === 0 || p.size > 1 << 20) continue;
    const b = await r.buf(p.off, p.size, header.le);
    let o = 0;
    // The name is padded to 4 bytes; the description to the section's alignment (8 for the
    // x86-64 .note.gnu.property), which is also where the next note starts.
    const pad = (n: number, to = p.align) => Math.ceil(n / to) * to;
    for (let n = 0; n < 128; n++) {
      if (!b.has(o, 12)) break;
      const namesz = b.u32(o);
      const descsz = b.u32(o + 4);
      const type = b.u32(o + 8);
      const nameOff = o + 12;
      const descOff = nameOff + pad(namesz, 4);
      if (!b.has(nameOff, namesz) || !b.has(descOff, descsz)) break;
      const owner = latin1(b.slice(nameOff, namesz)).replace(/\0+$/, '');
      const desc = b.slice(descOff, descsz);
      info.notes.push(describeNote(p.where, owner, type, desc, header, p.align));
      o = descOff + pad(descsz);
    }
  }
}

function describeNote(
  where: string,
  owner: string,
  type: number,
  desc: Uint8Array,
  header: ElfHeader,
  align: number,
): ElfNote {
  const d = new Buf(desc, header.le);
  const base = { where, owner, type };
  const asHex = (x: Uint8Array) => Array.from(x, (v) => v.toString(16).padStart(2, '0')).join('');
  if (owner === 'GNU') {
    if (type === NT_GNU.ABI_TAG && desc.length >= 16) {
      const os = d.u32(0);
      return {
        ...base,
        typeName: 'NT_GNU_ABI_TAG',
        value: `${GNU_ABI_OS[os] ?? `OS ${os}`} ${d.u32(4)}.${d.u32(8)}.${d.u32(12)}`,
      };
    }
    if (type === NT_GNU.BUILD_ID) {
      return { ...base, typeName: 'NT_GNU_BUILD_ID', value: asHex(desc) };
    }
    if (type === NT_GNU.GOLD_VERSION) {
      return { ...base, typeName: 'NT_GNU_GOLD_VERSION', value: latin1(desc).replace(/\0+$/, '') };
    }
    if (type === NT_GNU.PROPERTY) {
      return {
        ...base,
        typeName: 'NT_GNU_PROPERTY_TYPE_0',
        value: describeProperties(desc, header, align),
      };
    }
  }
  const printable = desc.length > 0 && desc.every((v) => (v >= 0x20 && v < 0x7f) || v === 0);
  const value = printable
    ? latin1(desc).replace(/\0+$/, '')
    : `${asHex(desc.subarray(0, 32))}${desc.length > 32 ? '…' : ''}`;
  return { ...base, typeName: hex(type), value };
}

/** x86 CET and AArch64 BTI/PAC bits of NT_GNU_PROPERTY_TYPE_0. */
function describeProperties(desc: Uint8Array, header: ElfHeader, align: number): string {
  const b = new Buf(desc, header.le);
  const out: string[] = [];
  let o = 0;
  while (b.has(o, 8)) {
    const type = b.u32(o);
    const size = b.u32(o + 4);
    if (!b.has(o + 8, size)) break;
    if (size >= 4) {
      const bits = b.u32(o + 8);
      if (type === 0xc0000002 && header.machine !== 183) {
        if (bits & 1) out.push('x86 IBT');
        if (bits & 2) out.push('x86 SHSTK');
      } else if (type === 0xc0000000 && header.machine === 183) {
        if (bits & 1) out.push('AArch64 BTI');
        if (bits & 2) out.push('AArch64 PAC');
      } else if ((type === 0xc0008002 || type === 0xc0010002) && header.machine !== 183) {
        const levels = ['baseline', 'v2', 'v3', 'v4'].filter((_, i) => bits & (1 << i));
        const what = type === 0xc0008002 ? 'needed' : 'used';
        out.push(`x86 ISA ${what}: ${levels.map((l) => `x86-64-${l}`).join(', ') || 'none'}`);
      } else if (type >= 0xc0000000 && type < 0xc0010000) {
        out.push(`property 0x${type.toString(16)}`);
      }
    }
    o += 8 + Math.ceil(size / align) * align;
  }
  return out.length ? out.join(', ') : 'none';
}

function readRelocs(
  info: ElfInfo,
  raw: RawSection[],
  names: string[],
  header: ElfHeader,
  wide: boolean,
): void {
  for (const s of raw) {
    if (s.type !== SHT.REL && s.type !== SHT.RELA && s.type !== SHT.RELR) continue;
    const dflt =
      s.type === SHT.RELA ? (wide ? 24 : 12) : s.type === SHT.REL ? (wide ? 16 : 8) : wide ? 8 : 4;
    const ent = s.entsize > 0 ? s.entsize : dflt;
    info.relocs.push({
      section: names[s.index] || `[${s.index}]`,
      count: Math.floor((Number.isFinite(s.size) ? s.size : 0) / ent),
    });
  }
  if (info.relocs.length === 0 && info.dynamic.length > 0) {
    // No section headers: sizes come from the dynamic section.
    const dyn = dynamicTables.get(info);
    const size = (tag: number) => Number(dyn?.entries.find((e) => e.tag === tag)?.value ?? 0n);
    const pairs: [string, number, number][] = [
      ['DT_RELA', size(DT.RELASZ), wide ? 24 : 12],
      ['DT_REL', size(DT.RELSZ), wide ? 16 : 8],
      ['DT_JMPREL', size(DT.PLTRELSZ), header.machine === 62 || wide ? 24 : 8],
    ];
    for (const [section, bytes, ent] of pairs) {
      if (bytes > 0) info.relocs.push({ section, count: Math.floor(bytes / ent) });
    }
  }
}

function computeSecurity(info: ElfInfo): void {
  const h = info.header;
  if (!h) return;
  const sec = info.security;
  const x86 = h.machine === 3 || h.machine === 62;
  const isRel = h.type === 1;

  const stack = info.segments.find((s) => s.type === PT.GNU_STACK);
  if (stack) {
    const exec = (stack.flags & 1) !== 0;
    sec.push({
      id: 'nx',
      state: exec ? 'disabled' : 'enabled',
      detail: `PT_GNU_STACK ${rwx(stack.flags)}`,
    });
  } else if (!isRel) {
    sec.push({
      id: 'nx',
      state: x86 ? 'disabled' : 'unknown',
      detail: 'no PT_GNU_STACK',
    });
  }

  if (h.type === 2) {
    sec.push({ id: 'pie', state: 'disabled', detail: 'ET_EXEC' });
  } else if (h.type === 3) {
    const isPie = info.interp !== null || info.flags1.includes('PIE');
    sec.push({
      id: 'pie',
      state: isPie ? 'enabled' : 'info',
      detail: isPie ? 'ET_DYN' : 'ET_DYN (shared object)',
    });
  }

  if (!isRel) {
    const relro = info.segments.some((s) => s.type === PT.GNU_RELRO);
    if (!relro) sec.push({ id: 'relro', state: 'disabled', detail: 'no PT_GNU_RELRO' });
    else if (info.bindNow)
      sec.push({ id: 'relro', state: 'full', detail: 'PT_GNU_RELRO + BIND_NOW' });
    else sec.push({ id: 'relro', state: 'partial', detail: 'PT_GNU_RELRO' });
  }

  const hasSyms = info.symbols.length > 0;
  const canary = info.symbols.find(
    (s) =>
      s.name === '__stack_chk_fail' ||
      s.name === '__stack_chk_guard' ||
      s.name === '__intel_security_cookie',
  );
  if (canary)
    sec.push({ id: 'canary', state: 'enabled', detail: `${canary.name} (${canary.table})` });
  else if (hasSyms) sec.push({ id: 'canary', state: 'disabled', detail: 'no __stack_chk_fail' });
  else if (!isRel) sec.push({ id: 'canary', state: 'unknown', detail: 'no symbols' });

  const fortified = [
    ...new Set(
      info.symbols
        .filter(
          (s) =>
            (/^__\w+_chk$/.test(s.name) && s.name !== '__stack_chk_fail') ||
            s.name === '__chk_fail' ||
            s.name === '__fortify_fail',
        )
        .map((s) => s.name),
    ),
  ];
  if (fortified.length > 0) {
    sec.push({
      id: 'fortify',
      state: 'enabled',
      detail: `${fortified.length}: ${fortified.slice(0, 4).join(', ')}${fortified.length > 4 ? ', …' : ''}`,
    });
  } else if (hasSyms) {
    sec.push({ id: 'fortify', state: 'disabled', detail: 'no *_chk symbols' });
  }

  if (info.rpath !== null) sec.push({ id: 'rpath', state: 'info', detail: info.rpath });
  if (info.runpath !== null) sec.push({ id: 'runpath', state: 'info', detail: info.runpath });

  const props = info.notes.find((n) => n.typeName === 'NT_GNU_PROPERTY_TYPE_0')?.value ?? '';
  if (x86 && !isRel) {
    sec.push({ id: 'ibt', state: props.includes('IBT') ? 'enabled' : 'disabled' });
    sec.push({ id: 'shstk', state: props.includes('SHSTK') ? 'enabled' : 'disabled' });
  }
  if (h.machine === 183 && !isRel) {
    sec.push({ id: 'bti', state: props.includes('BTI') ? 'enabled' : 'disabled' });
    sec.push({ id: 'pac', state: props.includes('PAC') ? 'enabled' : 'disabled' });
  }
}

const rwx = (f: number): string => `${f & 4 ? 'R' : '-'}${f & 2 ? 'W' : '-'}${f & 1 ? 'E' : '-'}`;
export { rwx as segmentFlags };

function computeHints(info: ElfInfo, raw: RawSection[], names: string[]): void {
  const h = info.header;
  if (!h) return;
  const hints = info.hints;
  const secNames = new Set(names);
  if (raw.length > 0 && h.type !== 1 && !info.hasSymtab)
    hints.push({ key: 'stripped', level: 'info' });
  if (
    raw.length > 0 &&
    [...secNames].some((n) => n.startsWith('.debug_') || n.startsWith('.zdebug_'))
  ) {
    hints.push({ key: 'hasDebugInfo', level: 'info' });
  }
  if (info.interp === null && info.dynamic.length === 0 && h.type !== 1 && raw.length > 0) {
    hints.push({ key: 'staticLinked', level: 'info' });
  }
  if (
    secNames.has('.go.buildinfo') ||
    secNames.has('.gopclntab') ||
    secNames.has('.note.go.buildid')
  ) {
    hints.push({ key: 'goBinary', level: 'info' });
  }
  if (info.rpath !== null || info.runpath !== null) {
    hints.push({ key: 'rpath', level: 'info', params: { path: info.rpath ?? info.runpath ?? '' } });
  }
  const stack = info.segments.find((s) => s.type === PT.GNU_STACK);
  if (stack && (stack.flags & 1) !== 0) hints.push({ key: 'execStack', level: 'warn' });

  // packers: say "looks packed", never more
  if (info.upx || [...secNames].some((n) => /^UPX\d/.test(n))) {
    info.packed.push({ key: 'packedUpx', level: 'warn' });
  }
  const loads = info.segments.filter((s) => s.type === PT.LOAD);
  if (raw.length === 0 && loads.length > 0 && h.type !== 1) {
    info.packed.push({ key: 'packedNoSections', level: 'info' });
  }
  const hot = info.sections.filter(
    (s) => s.exec && s.size >= 4096 && s.entropy !== null && s.entropy >= 7.2,
  );
  if (hot.length > 0) {
    info.packed.push({
      key: 'packedEntropy',
      level: 'warn',
      params: {
        sections: hot.map((s) => s.name || `[${s.index}]`).join(', '),
        entropy: hot[0]!.entropy!.toFixed(2),
      },
    });
  }
}
