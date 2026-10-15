/**
 * Mach-O parser, deliberately basic: header, load commands, segments and sections, linked
 * libraries, UUID, entry point, the symbol table and the properties that matter to a reverser
 * (PIE, executable stack, code signature, encrypted segments). A universal ("fat") file lists its
 * architectures and the first slice is analysed. No dyld info, rebase/bind opcodes or Objective-C.
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
import { trailingInfo } from './_exe-common';
import type { Note, SecItem, SectionRow, SymbolRow, Trailing } from './_exe-types';

const CPU: Record<number, string> = {
  1: 'VAX',
  6: 'MC680x0',
  7: 'x86',
  0x01000007: 'x86-64',
  10: 'MC98000',
  11: 'HPPA',
  12: 'ARM',
  0x0100000c: 'ARM64',
  0x0200000c: 'ARM64_32',
  13: 'MC88000',
  14: 'SPARC',
  15: 'i860',
  18: 'PowerPC',
  0x01000012: 'PowerPC 64-bit',
};

const FILE_TYPES: Record<number, string> = {
  1: 'OBJECT',
  2: 'EXECUTE',
  3: 'FVMLIB',
  4: 'CORE',
  5: 'PRELOAD',
  6: 'DYLIB',
  7: 'DYLINKER',
  8: 'BUNDLE',
  9: 'DYLIB_STUB',
  10: 'DSYM',
  11: 'KEXT_BUNDLE',
  12: 'FILESET',
};

const FLAGS: [number, string][] = [
  [0x1, 'NOUNDEFS'],
  [0x2, 'INCRLINK'],
  [0x4, 'DYLDLINK'],
  [0x8, 'BINDATLOAD'],
  [0x10, 'PREBOUND'],
  [0x20, 'SPLIT_SEGS'],
  [0x80, 'TWOLEVEL'],
  [0x100, 'FORCE_FLAT'],
  [0x200, 'NOMULTIDEFS'],
  [0x2000, 'SUBSECTIONS_VIA_SYMBOLS'],
  [0x4000, 'CANONICAL'],
  [0x8000, 'WEAK_DEFINES'],
  [0x10000, 'BINDS_TO_WEAK'],
  [0x20000, 'ALLOW_STACK_EXECUTION'],
  [0x40000, 'ROOT_SAFE'],
  [0x80000, 'SETUID_SAFE'],
  [0x100000, 'NO_REEXPORTED_DYLIBS'],
  [0x200000, 'PIE'],
  [0x400000, 'DEAD_STRIPPABLE_DYLIB'],
  [0x800000, 'HAS_TLV_DESCRIPTORS'],
  [0x1000000, 'NO_HEAP_EXECUTION'],
  [0x2000000, 'APP_EXTENSION_SAFE'],
];

const LC: Record<number, string> = {
  0x1: 'LC_SEGMENT',
  0x2: 'LC_SYMTAB',
  0x4: 'LC_THREAD',
  0x5: 'LC_UNIXTHREAD',
  0xb: 'LC_DYSYMTAB',
  0xc: 'LC_LOAD_DYLIB',
  0xd: 'LC_ID_DYLIB',
  0xe: 'LC_LOAD_DYLINKER',
  0xf: 'LC_ID_DYLINKER',
  0x11: 'LC_ROUTINES',
  0x12: 'LC_SUB_FRAMEWORK',
  0x16: 'LC_TWOLEVEL_HINTS',
  0x18: 'LC_LOAD_WEAK_DYLIB',
  0x19: 'LC_SEGMENT_64',
  0x1a: 'LC_ROUTINES_64',
  0x1b: 'LC_UUID',
  0x1c: 'LC_RPATH',
  0x1d: 'LC_CODE_SIGNATURE',
  0x1e: 'LC_SEGMENT_SPLIT_INFO',
  0x1f: 'LC_REEXPORT_DYLIB',
  0x20: 'LC_LAZY_LOAD_DYLIB',
  0x21: 'LC_ENCRYPTION_INFO',
  0x22: 'LC_DYLD_INFO',
  0x23: 'LC_LOAD_UPWARD_DYLIB',
  0x24: 'LC_VERSION_MIN_MACOSX',
  0x25: 'LC_VERSION_MIN_IPHONEOS',
  0x26: 'LC_FUNCTION_STARTS',
  0x27: 'LC_DYLD_ENVIRONMENT',
  0x28: 'LC_MAIN',
  0x29: 'LC_DATA_IN_CODE',
  0x2a: 'LC_SOURCE_VERSION',
  0x2b: 'LC_DYLIB_CODE_SIGN_DRS',
  0x2c: 'LC_ENCRYPTION_INFO_64',
  0x2d: 'LC_LINKER_OPTION',
  0x2e: 'LC_LINKER_OPTIMIZATION_HINT',
  0x2f: 'LC_VERSION_MIN_TVOS',
  0x30: 'LC_VERSION_MIN_WATCHOS',
  0x31: 'LC_NOTE',
  0x32: 'LC_BUILD_VERSION',
  0x33: 'LC_DYLD_EXPORTS_TRIE',
  0x34: 'LC_DYLD_CHAINED_FIXUPS',
  0x35: 'LC_FILESET_ENTRY',
};

const PLATFORMS: Record<number, string> = {
  1: 'macOS',
  2: 'iOS',
  3: 'tvOS',
  4: 'watchOS',
  5: 'bridgeOS',
  6: 'Mac Catalyst',
  7: 'iOS simulator',
  8: 'tvOS simulator',
  9: 'watchOS simulator',
  10: 'DriverKit',
  11: 'visionOS',
};

export interface MachoCommand {
  index: number;
  name: string;
  size: number;
  detail: string;
}

export interface MachoInfo {
  fat: { cpu: string; offset: number; size: number }[] | null;
  /** File offset of the slice being analysed. */
  sliceOffset: number;
  header: {
    bits: 32 | 64;
    le: boolean;
    cpu: number;
    cpuName: string;
    fileType: number;
    fileTypeName: string;
    ncmds: number;
    sizeofcmds: number;
    flags: number;
    flagNames: string[];
  } | null;
  commands: MachoCommand[];
  segments: {
    name: string;
    vmaddr: bigint;
    vmsize: bigint;
    fileoff: number;
    filesize: number;
    maxprot: string;
    initprot: string;
    sections: number;
    entropy: number | null;
  }[];
  sections: SectionRow[];
  dylibs: { kind: string; name: string; version: string }[];
  rpaths: string[];
  dylinker: string | null;
  uuid: string | null;
  entryOffset: bigint | null;
  build: string | null;
  encrypted: boolean;
  codeSignature: { offset: number; size: number } | null;
  symbols: SymbolRow[];
  security: SecItem[];
  hints: Note[];
  trailing: Trailing | null;
  declaredEnd: number;
}

export function machoMagic(b: Uint8Array): 'macho' | 'fat' | null {
  if (b.length < 8) return null;
  const be = ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0;
  if (be === 0xfeedface || be === 0xfeedfacf || be === 0xcefaedfe || be === 0xcffaedfe)
    return 'macho';
  if (be === 0xcafebabe || be === 0xcafebabf) {
    // Java class files share 0xcafebabe: a fat file has a small architecture count and offsets
    // that point into the file.
    const n = (b[4]! << 24) | (b[5]! << 16) | (b[6]! << 8) | b[7]!;
    return n > 0 && n < 20 ? 'fat' : null;
  }
  return null;
}

const prot = (p: number): string => `${p & 1 ? 'r' : '-'}${p & 2 ? 'w' : '-'}${p & 4 ? 'x' : '-'}`;
const version = (v: number): string => `${v >>> 16}.${(v >>> 8) & 0xff}.${v & 0xff}`;
const name16 = (b: Buf, o: number): string => latin1(b.slice(o, 16)).replace(/\0.*$/s, '');

/** `deep` also measures the entropy of segments and sections (reads the whole file). */
export async function parseMacho(r: Reader, deep = true): Promise<MachoInfo> {
  const hints: Note[] = [];
  const info: MachoInfo = {
    fat: null,
    sliceOffset: 0,
    header: null,
    commands: [],
    segments: [],
    sections: [],
    dylibs: [],
    rpaths: [],
    dylinker: null,
    uuid: null,
    entryOffset: null,
    build: null,
    encrypted: false,
    codeSignature: null,
    symbols: [],
    security: [],
    hints,
    trailing: null,
    declaredEnd: 0,
  };
  const budget: Budget = { left: deep ? ENTROPY_BUDGET : 0 };
  let base = 0;
  let sliceSize = r.size;

  const first = await r.buf(0, 4096, false);
  if (machoMagic(first.bytes) === 'fat') {
    const wide = first.u32(0) === 0xcafebabf;
    const n = Math.min(first.u32(4), 19);
    const stride = wide ? 32 : 20;
    info.fat = [];
    for (let i = 0; i < n && first.has(8 + i * stride, stride); i++) {
      const o = 8 + i * stride;
      const cpu = first.u32(o);
      info.fat.push({
        cpu: CPU[cpu] ?? hex(cpu),
        offset: wide ? first.num64(o + 8) : first.u32(o + 8),
        size: wide ? first.num64(o + 16) : first.u32(o + 12),
      });
    }
    hints.push({
      key: 'fatBinary',
      level: 'info',
      params: { count: info.fat.length, archs: info.fat.map((a) => a.cpu).join(', ') },
    });
    const pick = info.fat[0];
    if (!pick || !inFile(pick.offset, 28, r.size)) return info;
    base = pick.offset;
    sliceSize = Math.min(pick.size, r.size - base);
  }
  info.sliceOffset = base;

  const head = await r.buf(base, 32, false);
  const magic = head.length >= 4 ? head.u32(0) : 0;
  const le = magic === 0xcefaedfe || magic === 0xcffaedfe; // read big-endian: swapped magic = little-endian file
  const bits: 32 | 64 = magic === 0xfeedfacf || magic === 0xcffaedfe ? 64 : 32;
  if (![0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(magic)) {
    hints.push({ key: 'badIdent', level: 'warn', params: { what: hex(magic, 8) } });
    return info;
  }
  const h = head.order(le);
  try {
    const cpu = h.u32(4);
    const fileType = h.u32(12);
    const flags = h.u32(24);
    info.header = {
      bits,
      le,
      cpu,
      cpuName: CPU[cpu] ?? hex(cpu),
      fileType,
      fileTypeName: FILE_TYPES[fileType] ?? hex(fileType),
      ncmds: h.u32(16),
      sizeofcmds: h.u32(20),
      flags,
      flagNames: FLAGS.filter(([bit]) => flags & bit).map(([, n]) => n),
    };
  } catch (e) {
    if (!(e instanceof Truncated)) throw e;
    hints.push({ key: 'truncatedHeader', level: 'warn', params: { size: head.length } });
    return info;
  }
  const hdr = info.header;
  const hdrSize = bits === 64 ? 32 : 28;
  const cmdBytes = Math.min(hdr.sizeofcmds, 4 << 20);
  const lc = await r.buf(base + hdrSize, cmdBytes, le);
  if (lc.length < hdr.sizeofcmds) hints.push({ key: 'machoLoadTruncated', level: 'warn' });

  let strtab: { off: number; size: number } | null = null;
  let symtab: { off: number; n: number } | null = null;
  let o = 0;
  try {
    for (let i = 0; i < Math.min(hdr.ncmds, 4096); i++) {
      const cmd = lc.u32(o);
      const size = lc.u32(o + 4);
      if (size < 8 || o + size > lc.length) {
        hints.push({ key: 'machoLoadTruncated', level: 'warn' });
        break;
      }
      const name = LC[cmd & 0x7fffffff] ?? hex(cmd);
      let detail = '';
      const str = (at: number) => lc.cstr(o + at, size - at);
      switch (cmd & 0x7fffffff) {
        case 0x1:
        case 0x19: {
          const wide = cmd === 0x19;
          const segName = name16(lc, o + 8);
          const vmaddr = lc.word(o + 24, wide);
          const vmsize = lc.word(o + (wide ? 32 : 28), wide);
          const fileoff = lc.wordNum(o + (wide ? 40 : 32), wide);
          const filesize = lc.wordNum(o + (wide ? 48 : 36), wide);
          const at = o + (wide ? 56 : 40);
          const maxprot = lc.u32(at);
          const initprot = lc.u32(at + 4);
          const nsects = lc.u32(at + 8);
          const entropy =
            filesize > 0 && inFile(base + fileoff, filesize, r.size)
              ? await regionEntropy(r, base + fileoff, filesize, budget)
              : null;
          info.segments.push({
            name: segName,
            vmaddr,
            vmsize,
            fileoff,
            filesize,
            maxprot: prot(maxprot),
            initprot: prot(initprot),
            sections: nsects,
            entropy,
          });
          const sstride = wide ? 80 : 68;
          for (let s = 0; s < Math.min(nsects, 256); s++) {
            const so = at + 16 + s * sstride;
            if (so + sstride > o + size) break;
            const addr = lc.word(so + 32, wide);
            const ssize = lc.wordNum(so + (wide ? 40 : 36), wide);
            const soff = lc.u32(so + (wide ? 48 : 40));
            const sflags = lc.u32(so + (wide ? 64 : 56));
            const holds = soff > 0 && ssize > 0 && (sflags & 0xff) !== 1; // S_ZEROFILL = 1
            const outside = holds && !inFile(base + soff, ssize, r.size);
            info.sections.push({
              index: info.sections.length,
              name: name16(lc, so),
              type: name16(lc, so + 16),
              addr,
              vsize: BigInt(Number.isFinite(ssize) ? ssize : 0),
              offset: base + soff,
              size: holds ? ssize : 0,
              flags: prot(initprot),
              entropy:
                holds && !outside ? await regionEntropy(r, base + soff, ssize, budget) : null,
              // S_ATTR_PURE_INSTRUCTIONS | S_ATTR_SOME_INSTRUCTIONS: the section holds code
              exec: (sflags & 0x80000400) !== 0,
              write: (initprot & 2) !== 0,
              outside,
            });
          }
          detail = `${segName} ${hex(vmaddr)} ${nsects}`;
          if (filesize > 0 && inFile(base + fileoff, filesize, r.size)) {
            info.declaredEnd = Math.max(info.declaredEnd, base + fileoff + filesize);
          }
          break;
        }
        case 0x2: {
          symtab = { off: lc.u32(o + 8), n: lc.u32(o + 12) };
          strtab = { off: lc.u32(o + 16), size: lc.u32(o + 20) };
          detail = `${symtab.n} symbols`;
          info.declaredEnd = Math.max(info.declaredEnd, base + strtab.off + strtab.size);
          break;
        }
        case 0xc:
        case 0xd:
        case 0x18:
        case 0x1f:
        case 0x20:
        case 0x23: {
          const libName = str(lc.u32(o + 8));
          const kind =
            {
              0xc: 'load',
              0xd: 'id',
              0x18: 'weak',
              0x1f: 'reexport',
              0x20: 'lazy',
              0x23: 'upward',
            }[cmd & 0x7fffffff] ?? 'load';
          info.dylibs.push({ kind, name: libName, version: version(lc.u32(o + 16)) });
          detail = libName;
          break;
        }
        case 0xe:
        case 0xf:
          info.dylinker = str(lc.u32(o + 8));
          detail = info.dylinker;
          break;
        case 0x1c: {
          const p = str(lc.u32(o + 8));
          info.rpaths.push(p);
          detail = p;
          break;
        }
        case 0x1b: {
          const u = Array.from(lc.slice(o + 8, 16), (x) => x.toString(16).padStart(2, '0')).join(
            '',
          );
          info.uuid =
            `${u.slice(0, 8)}-${u.slice(8, 12)}-${u.slice(12, 16)}-${u.slice(16, 20)}-${u.slice(20)}`.toUpperCase();
          detail = info.uuid;
          break;
        }
        case 0x28:
          info.entryOffset = lc.u64(o + 8);
          detail = `entryoff ${hex(info.entryOffset)}`;
          break;
        case 0x1d: {
          info.codeSignature = { offset: base + lc.u32(o + 8), size: lc.u32(o + 12) };
          detail = `${info.codeSignature.size} bytes`;
          break;
        }
        case 0x21:
        case 0x2c: {
          const cryptid = lc.u32(o + 16);
          info.encrypted ||= cryptid !== 0;
          detail = `cryptid ${cryptid}`;
          break;
        }
        case 0x32: {
          info.build = `${PLATFORMS[lc.u32(o + 8)] ?? lc.u32(o + 8)} ${version(lc.u32(o + 12))} (SDK ${version(lc.u32(o + 16))})`;
          detail = info.build;
          break;
        }
        case 0x24:
        case 0x25:
        case 0x2f:
        case 0x30: {
          const plat = { 0x24: 'macOS', 0x25: 'iOS', 0x2f: 'tvOS', 0x30: 'watchOS' }[
            cmd & 0x7fffffff
          ];
          info.build ??= `${plat} ${version(lc.u32(o + 8))} (SDK ${version(lc.u32(o + 12))})`;
          detail = `${plat} ${version(lc.u32(o + 8))}`;
          break;
        }
        default:
          break;
      }
      info.commands.push({ index: i, name, size, detail });
      o += size;
    }
  } catch (e) {
    if (!(e instanceof Truncated)) throw e;
    hints.push({ key: 'machoLoadTruncated', level: 'warn' });
  }

  // ---- symbols ----
  if (symtab && strtab && symtab.n > 0) {
    const stride = bits === 64 ? 16 : 12;
    const count = Math.min(symtab.n, 200_000);
    if (count < symtab.n) {
      hints.push({ key: 'capped', level: 'info', params: { what: 'symbols', count } });
    }
    const sb = await r.buf(base + symtab.off, count * stride, le);
    const str = await r.read(base + strtab.off, Math.min(strtab.size, 32 << 20));
    const sbuf = new Buf(str, le);
    const have = Math.floor(sb.length / stride);
    for (let i = 0; i < have; i++) {
      const so = i * stride;
      const type = sb.u8(so + 4);
      if (type & 0xe0) continue; // debugging (stab) entry
      const strx = sb.u32(so);
      const sect = sb.u8(so + 5);
      const value = bits === 64 ? sb.u64(so + 8) : BigInt(sb.u32(so + 8));
      const kind = type & 0x0e;
      const undefinedSym = kind === 0 && sect === 0;
      info.symbols.push({
        table: 'symtab',
        index: i,
        name: strx < str.length ? sbuf.cstr(strx, 1024) : '',
        value,
        size: 0,
        kind:
          kind === 0xe
            ? 'SECT'
            : kind === 2
              ? 'ABS'
              : kind === 0xa
                ? 'INDR'
                : undefinedSym
                  ? 'UNDF'
                  : hex(kind),
        bind: type & 1 ? 'EXT' : 'LOCAL',
        section:
          kind === 0xe
            ? (info.sections[sect - 1]?.name ?? String(sect))
            : undefinedSym
              ? 'UND'
              : '',
        version: '',
        undefined: undefinedSym,
      });
    }
  }

  if (info.declaredEnd > 0 && info.declaredEnd < base + sliceSize && !info.fat) {
    info.trailing = await trailingInfo(
      r,
      info.declaredEnd,
      base + sliceSize - info.declaredEnd,
      budget,
    );
  }
  computeSecurity(info);
  if (info.encrypted) hints.push({ key: 'encrypted', level: 'warn' });
  return info;
}

function computeSecurity(info: MachoInfo): void {
  const h = info.header;
  if (!h) return;
  const sec = info.security;
  const flag = (n: string) => h.flagNames.includes(n);
  if (h.fileType === 2 || h.fileType === 6 || h.fileType === 8) {
    sec.push({
      id: 'pie',
      state: flag('PIE') ? 'enabled' : 'disabled',
      detail: flag('PIE') ? 'MH_PIE' : 'no MH_PIE',
    });
  }
  sec.push({
    id: 'nx',
    state: flag('ALLOW_STACK_EXECUTION') ? 'disabled' : 'enabled',
    detail: flag('ALLOW_STACK_EXECUTION') ? 'MH_ALLOW_STACK_EXECUTION' : undefined,
  });
  sec.push({
    id: 'nxHeap',
    state: flag('NO_HEAP_EXECUTION') ? 'enabled' : 'disabled',
    detail: flag('NO_HEAP_EXECUTION') ? 'MH_NO_HEAP_EXECUTION' : undefined,
  });
  const canary = info.symbols.find((s) => /^_*stack_chk_(fail|guard)$/.test(s.name));
  if (canary) sec.push({ id: 'canary', state: 'enabled', detail: canary.name });
  else if (info.symbols.length > 0)
    sec.push({ id: 'canary', state: 'disabled', detail: 'no ___stack_chk_fail' });
  sec.push({
    id: 'codeSignature',
    state: info.codeSignature ? 'enabled' : 'disabled',
    detail: info.codeSignature ? `${info.codeSignature.size} bytes (not verified)` : undefined,
  });
  if (info.encrypted) sec.push({ id: 'encryption', state: 'info', detail: 'cryptid 1' });
}
