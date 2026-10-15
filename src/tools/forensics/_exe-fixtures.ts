/**
 * Writers for tiny executables, so that the Executable analyzer's samples and tests need no
 * compiler: ELF (32/64-bit, either byte order), PE / PE32+ and Mach-O. The files are structurally
 * valid (readelf, pefile and llvm-readobj read them) but their code is a few bytes that is never
 * meant to run. Everything is deterministic; the texts are self-made ("FTF{...}").
 *
 * Used by scripts/gen-samples-exe.mjs (the committed samples) and by the tests.
 */

// ---------- byte writer ----------

class W {
  private a: number[] = [];
  constructor(readonly le = true) {}
  get length(): number {
    return this.a.length;
  }
  u8(v: number): this {
    this.a.push(v & 0xff);
    return this;
  }
  u16(v: number): this {
    return this.le ? this.u8(v).u8(v >> 8) : this.u8(v >> 8).u8(v);
  }
  u32(v: number): this {
    return this.le ? this.u16(v & 0xffff).u16(v >>> 16) : this.u16(v >>> 16).u16(v & 0xffff);
  }
  u64(v: bigint | number): this {
    const b = BigInt(v);
    const lo = Number(b & 0xffffffffn);
    const hi = Number((b >> 32n) & 0xffffffffn);
    return this.le ? this.u32(lo).u32(hi) : this.u32(hi).u32(lo);
  }
  /** A 4- or 8-byte word. */
  word(v: bigint | number, wide: boolean): this {
    return wide ? this.u64(v) : this.u32(Number(BigInt(v) & 0xffffffffn));
  }
  bytes(b: ArrayLike<number>): this {
    for (let i = 0; i < b.length; i++) this.a.push(b[i]! & 0xff);
    return this;
  }
  ascii(s: string, nul = true): this {
    for (let i = 0; i < s.length; i++) this.a.push(s.charCodeAt(i) & 0xff);
    return nul ? this.u8(0) : this;
  }
  utf16(s: string, nul = true): this {
    for (let i = 0; i < s.length; i++) this.u16(s.charCodeAt(i));
    return nul ? this.u16(0) : this;
  }
  zeros(n: number): this {
    for (let i = 0; i < n; i++) this.a.push(0);
    return this;
  }
  align(n: number): this {
    while (this.a.length % n) this.a.push(0);
    return this;
  }
  patch32(off: number, v: number): void {
    const w = new W(this.le).u32(v).toBytes();
    for (let i = 0; i < 4; i++) this.a[off + i] = w[i]!;
  }
  patchWord(off: number, v: bigint | number, wide: boolean): void {
    const w = new W(this.le).word(v, wide).toBytes();
    for (let i = 0; i < w.length; i++) this.a[off + i] = w[i]!;
  }
  toBytes(): Uint8Array {
    return Uint8Array.from(this.a);
  }
}

const enc = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
const alignUp = (n: number, a: number) => Math.ceil(n / a) * a;

/** NUL-separated string table with the offsets of what was added. */
class StrTab {
  readonly bytes: number[] = [0];
  private readonly seen = new Map<string, number>();
  add(s: string): number {
    if (s === '') return 0;
    const hit = this.seen.get(s);
    if (hit !== undefined) return hit;
    const off = this.bytes.length;
    for (const c of s) this.bytes.push(c.charCodeAt(0) & 0xff);
    this.bytes.push(0);
    this.seen.set(s, off);
    return off;
  }
}

// ======================================================================================
// ELF
// ======================================================================================

export interface ElfSpec {
  bits?: 32 | 64;
  big?: boolean;
  machine?: number;
  osabi?: number;
  /** DYN (default, a PIE when it has an interpreter) or EXEC. */
  type?: 'DYN' | 'EXEC';
  /** Interpreter path; null for none (a static or shared object). */
  interp?: string | null;
  needed?: string[];
  rpath?: string;
  runpath?: string;
  soname?: string;
  bindNow?: boolean;
  relro?: boolean;
  /** PT_GNU_STACK: 'rw' (default), 'rwx', or 'none' for no such header. */
  stack?: 'rw' | 'rwx' | 'none';
  imports?: string[];
  exports?: string[];
  /** A dynamic section and dynamic symbols (default: when there is an interpreter). */
  dynamic?: boolean;
  /** Keep the .symtab (default true). */
  symtab?: boolean;
  /** Write section headers (default true). */
  sections?: boolean;
  rodata?: string;
  data?: string;
  comment?: string;
  buildId?: boolean;
  abiTag?: boolean;
  /** x86 CET property note. */
  cet?: boolean;
  /** Entries in .rela.plt. */
  relocs?: number;
  /** Extra bytes in .text (to give it some size or entropy). */
  text?: Uint8Array;
  /** Bytes after the end of the file. */
  trailing?: Uint8Array;
  /** Add a section with this name holding 'UPX!' data. */
  upx?: boolean;
}

interface ElfPart {
  name: string;
  type: number;
  flags: number;
  align: number;
  entsize: number;
  data: Uint8Array;
  /** Allocated: has an address (= its file offset in these files). */
  alloc: boolean;
  link?: string;
  info?: number;
}

export function buildElf(spec: ElfSpec = {}): Uint8Array {
  const bits = spec.bits ?? 64;
  const wide = bits === 64;
  const le = !spec.big;
  const machine = spec.machine ?? (wide ? 62 : 3);
  const interp = spec.interp === undefined ? '/lib64/ld-linux-x86-64.so.2' : spec.interp;
  const dynamicFile = spec.dynamic ?? interp !== null;
  const withSections = spec.sections !== false;
  const withSymtab = spec.symtab !== false;
  const imports = spec.imports ?? ['puts', '__libc_start_main'];
  const exports = spec.exports ?? [];
  const needed = spec.needed ?? ['libc.so.6'];
  const w = (): W => new W(le);
  const entSym = wide ? 24 : 16;

  // ---- .dynstr ----
  const dynstr = new StrTab();
  const neededOffs = needed.map((n) => dynstr.add(n));
  const rpathOff = spec.rpath ? dynstr.add(spec.rpath) : 0;
  const runpathOff = spec.runpath ? dynstr.add(spec.runpath) : 0;
  const sonameOff = spec.soname ? dynstr.add(spec.soname) : 0;
  const importOffs = imports.map((n) => dynstr.add(n));
  const exportOffs = exports.map((n) => dynstr.add(n));

  const text = w();
  // xor eax,eax ; ret ; then a function body: mov eax, 0x1337 ; ret
  text.bytes([0x31, 0xc0, 0xc3, 0xb8, 0x37, 0x13, 0x00, 0x00, 0xc3]);
  if (spec.text) text.bytes(spec.text);
  const rodata = w()
    .ascii(spec.rodata ?? 'FTF{elf_rodata}')
    .ascii('usage: sample [name]');
  const parts: ElfPart[] = [];
  const add = (p: ElfPart) => parts.push(p);

  const noteBuildId = w();
  noteBuildId
    .u32(4)
    .u32(20)
    .u32(3)
    .ascii('GNU')
    .bytes(Array.from({ length: 20 }, (_, i) => (i * 17 + 3) & 0xff));
  const noteAbi = w().u32(4).u32(16).u32(1).ascii('GNU').u32(0).u32(3).u32(2).u32(0);
  const noteProp = w();
  noteProp
    .u32(4)
    .u32(wide ? 16 : 12)
    .u32(5)
    .ascii('GNU')
    .u32(0xc0000002)
    .u32(4)
    .u32(3)
    .zeros(wide ? 4 : 0);

  if (interp) {
    add({
      name: '.interp',
      type: 1,
      flags: 2,
      align: 1,
      entsize: 0,
      data: w().ascii(interp).toBytes(),
      alloc: true,
    });
  }
  if (spec.buildId !== false && dynamicFile) {
    add({
      name: '.note.gnu.build-id',
      type: 7,
      flags: 2,
      align: 4,
      entsize: 0,
      data: noteBuildId.toBytes(),
      alloc: true,
    });
  }
  if (spec.abiTag !== false && dynamicFile) {
    add({
      name: '.note.ABI-tag',
      type: 7,
      flags: 2,
      align: 4,
      entsize: 0,
      data: noteAbi.toBytes(),
      alloc: true,
    });
  }
  if (spec.cet && (machine === 62 || machine === 3)) {
    add({
      name: '.note.gnu.property',
      type: 7,
      flags: 2,
      align: wide ? 8 : 4,
      entsize: 0,
      data: noteProp.toBytes(),
      alloc: true,
    });
  }
  const dynSymCount = 1 + imports.length + exports.length;
  if (dynamicFile) {
    add({
      name: '.dynsym',
      type: 11,
      flags: 2,
      align: wide ? 8 : 4,
      entsize: entSym,
      data: new Uint8Array(dynSymCount * entSym),
      alloc: true,
      link: '.dynstr',
      info: 1,
    });
    add({
      name: '.dynstr',
      type: 3,
      flags: 2,
      align: 1,
      entsize: 0,
      data: Uint8Array.from(dynstr.bytes),
      alloc: true,
    });
    const relocs = spec.relocs ?? imports.length;
    if (relocs > 0) {
      add({
        name: '.rela.plt',
        type: 4,
        flags: 0x42,
        align: wide ? 8 : 4,
        entsize: wide ? 24 : 12,
        data: new Uint8Array(relocs * (wide ? 24 : 12)),
        alloc: true,
        link: '.dynsym',
      });
    }
  }
  add({
    name: '.text',
    type: 1,
    flags: 6,
    align: 16,
    entsize: 0,
    data: text.toBytes(),
    alloc: true,
  });
  if (spec.upx) {
    add({
      name: 'UPX0',
      type: 1,
      flags: 6,
      align: 16,
      entsize: 0,
      data: enc('UPX!\r\n\x1a\n packed payload'),
      alloc: true,
    });
  }
  add({
    name: '.rodata',
    type: 1,
    flags: 2,
    align: 8,
    entsize: 0,
    data: rodata.toBytes(),
    alloc: true,
  });
  // The writable part: .dynamic then .data
  const dynEntries = 16;
  if (dynamicFile) {
    add({
      name: '.dynamic',
      type: 6,
      flags: 3,
      align: wide ? 8 : 4,
      entsize: wide ? 16 : 8,
      data: new Uint8Array(dynEntries * (wide ? 16 : 8)),
      alloc: true,
      link: '.dynstr',
    });
  }
  add({
    name: '.data',
    type: 1,
    flags: 3,
    align: 8,
    entsize: 0,
    data: w()
      .ascii(spec.data ?? 'ftf-data')
      .toBytes(),
    alloc: true,
  });

  // ---- layout ----
  const ehsize = wide ? 64 : 52;
  const phentsize = wide ? 56 : 32;
  const phCount =
    (interp ? 1 : 0) +
    2 +
    (dynamicFile ? 1 : 0) +
    (parts.some((p) => p.type === 7) ? 1 : 0) +
    (spec.stack === 'none' ? 0 : 1) +
    (spec.relro ? 1 : 0);
  let pos = ehsize + phCount * phentsize;
  const offsets = new Map<string, number>();
  const rwStart = parts.findIndex((p) => p.flags & 1 && p.alloc);
  let rxEnd = 0;
  parts.forEach((p, i) => {
    if (i === rwStart) pos = alignUp(pos, 16);
    pos = alignUp(pos, Math.max(1, p.align));
    offsets.set(p.name, pos);
    pos += p.data.length;
    if (i < rwStart || rwStart < 0) rxEnd = pos;
  });
  const lastAlloc = pos;
  const rwOff = rwStart >= 0 ? offsets.get(parts[rwStart]!.name)! : lastAlloc;
  const off = (n: string) => offsets.get(n) ?? 0;
  const size = (n: string) => parts.find((p) => p.name === n)?.data.length ?? 0;

  // ---- fill the tables that hold addresses (address = file offset) ----
  const textIdx = (): number => 1 + parts.findIndex((p) => p.name === '.text');
  const rodataIdx = (): number => 1 + parts.findIndex((p) => p.name === '.rodata');
  const sym = (
    b: W,
    name: number,
    value: number,
    symSize: number,
    info: number,
    shndx: number,
  ): void => {
    if (wide) b.u32(name).u8(info).u8(0).u16(shndx).u64(value).u64(symSize);
    else b.u32(name).u32(value).u32(symSize).u8(info).u8(0).u16(shndx);
  };
  if (dynamicFile) {
    const ds = w();
    sym(ds, 0, 0, 0, 0, 0);
    imports.forEach((_, i) => sym(ds, importOffs[i]!, 0, 0, 0x12, 0));
    exports.forEach((_, i) =>
      sym(ds, exportOffs[i]!, off('.text') + 3, 6, 0x12, withSections ? textIdx() : 0),
    );
    parts.find((p) => p.name === '.dynsym')!.data = ds.toBytes();
    if (parts.some((p) => p.name === '.rela.plt')) {
      const rp = parts.find((p) => p.name === '.rela.plt')!;
      const n = rp.data.length / (wide ? 24 : 12);
      const rb = w();
      for (let i = 0; i < n; i++) {
        const symIdx = 1 + (i % Math.max(1, imports.length));
        if (wide)
          rb.u64(off('.data') + i * 8)
            .u64((BigInt(symIdx) << 32n) | 7n)
            .u64(0);
        else
          rb.u32(off('.data') + i * 4)
            .u32((symIdx << 8) | 7)
            .u32(0);
      }
      rp.data = rb.toBytes();
    }
    const dyn = w();
    const dt = (tag: number, v: number | bigint): void => {
      dyn.word(tag, wide).word(v, wide);
    };
    neededOffs.forEach((o) => dt(1, o));
    if (spec.soname) dt(14, sonameOff);
    if (spec.rpath) dt(15, rpathOff);
    if (spec.runpath) dt(29, runpathOff);
    dt(5, off('.dynstr'));
    dt(6, off('.dynsym'));
    dt(10, size('.dynstr'));
    dt(11, entSym);
    if (spec.bindNow) {
      dt(30, 8); // DT_FLAGS: BIND_NOW
      dt(0x6ffffffb, 1 | (interp ? 0x8000000 : 0)); // DT_FLAGS_1: NOW (+ PIE)
    } else if (interp && spec.type !== 'EXEC') {
      dt(0x6ffffffb, 0x8000000); // PIE
    }
    dt(0, 0);
    const dp = parts.find((p) => p.name === '.dynamic')!;
    const body = dyn.toBytes();
    if (body.length > dp.data.length) throw new Error('too many dynamic entries');
    dp.data = new Uint8Array(dp.data.length);
    dp.data.set(body);
  }

  // ---- non-allocated sections ----
  const nonAlloc: ElfPart[] = [];
  const symStr = new StrTab();
  if (withSections) {
    nonAlloc.push({
      name: '.comment',
      type: 1,
      flags: 0x30,
      align: 1,
      entsize: 1,
      data: w()
        .ascii(spec.comment ?? 'GCC: (FTF sample) 12.2.0')
        .toBytes(),
      alloc: false,
    });
  }
  if (withSections && withSymtab) {
    const st = w();
    sym(st, 0, 0, 0, 0, 0);
    sym(st, symStr.add('sample.c'), 0, 0, 0x04, 0xfff1); // FILE, ABS
    sym(st, 0, off('.text'), 0, 0x03, textIdx()); // SECTION .text
    const firstGlobal = 3;
    sym(st, symStr.add('_start'), off('.text'), 3, 0x12, textIdx());
    sym(st, symStr.add('ftf_flag_function'), off('.text') + 3, 6, 0x12, textIdx());
    sym(st, symStr.add('ftf_flag_data'), off('.rodata'), 16, 0x11, rodataIdx());
    for (const n of imports) sym(st, symStr.add(n), 0, 0, 0x12, 0);
    nonAlloc.push({
      name: '.symtab',
      type: 2,
      flags: 0,
      align: wide ? 8 : 4,
      entsize: entSym,
      data: st.toBytes(),
      alloc: false,
      link: '.strtab',
      info: firstGlobal,
    });
    nonAlloc.push({
      name: '.strtab',
      type: 3,
      flags: 0,
      align: 1,
      entsize: 0,
      data: Uint8Array.from(symStr.bytes),
      alloc: false,
    });
  }

  // ---- program headers ----
  const ph = w();
  const phdr = (
    type: number,
    flags: number,
    offset: number,
    filesz: number,
    memsz: number,
    align: number,
  ): void => {
    if (wide)
      ph.u32(type).u32(flags).u64(offset).u64(offset).u64(offset).u64(filesz).u64(memsz).u64(align);
    else
      ph.u32(type).u32(offset).u32(offset).u32(offset).u32(filesz).u32(memsz).u32(flags).u32(align);
  };
  if (interp) phdr(3, 4, off('.interp'), size('.interp'), size('.interp'), 1);
  phdr(1, 5, 0, rxEnd, rxEnd, 0x1000);
  const rwEnd = lastAlloc;
  phdr(1, 6, rwOff, rwEnd - rwOff, rwEnd - rwOff + 8, 0x1000);
  if (dynamicFile) phdr(2, 6, off('.dynamic'), size('.dynamic'), size('.dynamic'), wide ? 8 : 4);
  const notes = parts.filter((p) => p.type === 7);
  if (notes.length > 0) {
    const start = off(notes[0]!.name);
    const last = notes[notes.length - 1]!;
    phdr(
      4,
      4,
      start,
      off(last.name) + last.data.length - start,
      off(last.name) + last.data.length - start,
      wide && spec.cet ? 8 : 4,
    );
  }
  if (spec.stack !== 'none') phdr(0x6474e551, spec.stack === 'rwx' ? 7 : 6, 0, 0, 0, wide ? 16 : 4);
  if (spec.relro) phdr(0x6474e552, 4, rwOff, size('.dynamic'), size('.dynamic'), 1);

  // ---- assemble ----
  let tail = pos;
  const placed: { part: ElfPart; offset: number }[] = [];
  for (const p of nonAlloc) {
    tail = alignUp(tail, Math.max(1, p.align));
    placed.push({ part: p, offset: tail });
    tail += p.data.length;
  }
  const shstr = new StrTab();
  const allParts = [...parts, ...nonAlloc];
  const shstrSec: ElfPart = {
    name: '.shstrtab',
    type: 3,
    flags: 0,
    align: 1,
    entsize: 0,
    data: new Uint8Array(0),
    alloc: false,
  };
  if (withSections) {
    for (const p of allParts) shstr.add(p.name);
    shstr.add('.shstrtab');
    shstrSec.data = Uint8Array.from(shstr.bytes);
    placed.push({ part: shstrSec, offset: tail });
    tail += shstrSec.data.length;
  }
  const shoff = withSections ? alignUp(tail, wide ? 8 : 4) : 0;
  const shentsize = wide ? 64 : 40;
  const shnum = withSections ? allParts.length + 2 : 0;
  const total = withSections ? shoff + shnum * shentsize : tail;
  const file = new Uint8Array(total);
  const eh = w();
  eh.bytes([0x7f, 0x45, 0x4c, 0x46, wide ? 2 : 1, le ? 1 : 2, 1, spec.osabi ?? 0]).zeros(8);
  eh.u16(spec.type === 'EXEC' ? 2 : 3)
    .u16(machine)
    .u32(1);
  eh.word(off('.text'), wide).word(ehsize, wide).word(shoff, wide).u32(0);
  eh.u16(ehsize)
    .u16(phentsize)
    .u16(phCount)
    .u16(shentsize)
    .u16(shnum)
    .u16(withSections ? shnum - 1 : 0);
  file.set(eh.toBytes(), 0);
  file.set(ph.toBytes(), ehsize);
  for (const p of parts) file.set(p.data, off(p.name));
  for (const { part, offset } of placed) file.set(part.data, offset);

  if (withSections) {
    const sh = w();
    const index = new Map<string, number>(allParts.map((p, i) => [p.name, i + 1]));
    index.set('.shstrtab', allParts.length + 1);
    const offOf = (p: ElfPart) =>
      p.alloc ? off(p.name) : (placed.find((x) => x.part === p)?.offset ?? 0);
    const row = (p: ElfPart | null): void => {
      if (!p) {
        sh.zeros(shentsize);
        return;
      }
      const link = p.link ? (index.get(p.link) ?? 0) : 0;
      const addr = p.alloc ? off(p.name) : 0;
      const nameOff = shstr.add(p.name);
      if (wide) {
        sh.u32(nameOff)
          .u32(p.type)
          .u64(p.flags)
          .u64(addr)
          .u64(offOf(p))
          .u64(p.data.length)
          .u32(link)
          .u32(p.info ?? 0)
          .u64(p.align)
          .u64(p.entsize);
      } else {
        sh.u32(nameOff)
          .u32(p.type)
          .u32(p.flags)
          .u32(addr)
          .u32(offOf(p))
          .u32(p.data.length)
          .u32(link)
          .u32(p.info ?? 0)
          .u32(p.align)
          .u32(p.entsize);
      }
    };
    row(null);
    for (const p of allParts) row(p);
    row(shstrSec);
    file.set(sh.toBytes(), shoff);
  }
  if (spec.trailing) {
    const merged = new Uint8Array(file.length + spec.trailing.length);
    merged.set(file);
    merged.set(spec.trailing, file.length);
    return merged;
  }
  return file;
}

// ======================================================================================
// PE
// ======================================================================================

export interface ResourceLeaf {
  lang: number;
  data: Uint8Array;
  codepage?: number;
}
export interface ResourceName {
  /** Number (an ID) or text (a named resource). */
  name: number | string;
  leaves: ResourceLeaf[];
}
export interface ResourceType {
  type: number | string;
  names: ResourceName[];
}

export interface PeImportSpec {
  dll: string;
  funcs: (string | number)[];
}

export interface PeSpec {
  plus?: boolean;
  dll?: boolean;
  machine?: number;
  timestamp?: number;
  subsystem?: number;
  dllCharacteristics?: number;
  imports?: PeImportSpec[];
  delayImports?: PeImportSpec[];
  exports?: { dllName: string; names: string[]; forwarders?: Record<string, string> };
  resources?: ResourceType[];
  /** Rich header entries, or false for none (default: three typical entries). */
  rich?: { productId: number; build: number; count: number }[] | false;
  pdb?: string;
  tls?: boolean;
  /** A CLR header and metadata root, as in a .NET assembly; the strings fill its #US heap. */
  clr?: { userStrings: string[] };
  overlay?: Uint8Array;
  /** Rename sections, e.g. { '.text': 'UPX1' }. */
  sectionNames?: Record<string, string>;
  /** Extra bytes for .text. */
  code?: Uint8Array;
  /** An empty (raw size 0) section with a large virtual size, in front of .text, like UPX0. */
  emptySection?: string;
  /** Authenticode-like blob: the security directory points at it, past the last section. */
  certificate?: Uint8Array;
  loadConfig?: boolean;
}

function utf16le(s: string): Uint8Array {
  const out = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) {
    out[i * 2] = s.charCodeAt(i) & 0xff;
    out[i * 2 + 1] = s.charCodeAt(i) >> 8;
  }
  return out;
}

/** A VS_VERSIONINFO block with a StringFileInfo (language 0409, Unicode) and a Translation. */
export function buildVersionInfo(
  strings: Record<string, string>,
  fileVersion = [1, 2, 3, 4],
): Uint8Array {
  const node = (
    key: string,
    type: number,
    value: Uint8Array,
    valueLen: number,
    children: Uint8Array[],
  ): Uint8Array => {
    const b = new W(true);
    b.u16(0).u16(valueLen).u16(type).utf16(key).align(4).bytes(value).align(4);
    for (const c of children) b.bytes(c).align(4);
    const bytes = b.toBytes();
    bytes[0] = bytes.length & 0xff;
    bytes[1] = bytes.length >> 8;
    return bytes;
  };
  const [a, b, c, d] = fileVersion as [number, number, number, number];
  const fixed = new W(true)
    .u32(0xfeef04bd)
    .u32(0x10000)
    .u32((a << 16) | b)
    .u32((c << 16) | d)
    .u32((a << 16) | b)
    .u32((c << 16) | d)
    .u32(0x3f)
    .u32(0)
    .u32(0x40004)
    .u32(1)
    .u32(0)
    .u32(0)
    .u32(0)
    .toBytes();
  const entries = Object.entries(strings).map(([k, v]) =>
    node(k, 1, utf16le(`${v}\0`), v.length + 1, []),
  );
  const table = node('040904b0', 1, new Uint8Array(0), 0, entries);
  const sfi = node('StringFileInfo', 1, new Uint8Array(0), 0, [table]);
  const translation = node('Translation', 0, new W(true).u32(0x04b00409).toBytes(), 4, []);
  const vfi = node('VarFileInfo', 1, new Uint8Array(0), 0, [translation]);
  return node('VS_VERSION_INFO', 0, fixed, 52, [sfi, vfi]);
}

type Keyed<T> = { key: number | string; v: T };
/** Named entries first (sorted by name), then numeric IDs (ascending): the order PE requires. */
function ordered<T>(items: Keyed<T>[]): Keyed<T>[] {
  const named = items
    .filter((i) => typeof i.key === 'string')
    .sort((x, y) => String(x.key).toLowerCase().localeCompare(String(y.key).toLowerCase()));
  const ids = items
    .filter((i) => typeof i.key === 'number')
    .sort((x, y) => (x.key as number) - (y.key as number));
  return [...named, ...ids];
}

/** Resource directory: type level, name level, language level, data entries, names, data. */
function buildResources(types: ResourceType[], rva: number): Uint8Array {
  const typeList = ordered(types.map((t) => ({ key: t.type, v: t })));
  const dirSize = (n: number) => 16 + n * 8;
  let off = dirSize(typeList.length);
  const nameDir = new Map<ResourceType, number>();
  const langDir = new Map<ResourceName, number>();
  for (const { v: t } of typeList) {
    nameDir.set(t, off);
    off += dirSize(t.names.length);
  }
  const nameLists = new Map<ResourceType, Keyed<ResourceName>[]>();
  const langLists = new Map<ResourceName, Keyed<ResourceLeaf>[]>();
  for (const { v: t } of typeList) {
    const names = ordered(t.names.map((n) => ({ key: n.name, v: n })));
    nameLists.set(t, names);
    for (const { v: n } of names) {
      langDir.set(n, off);
      off += dirSize(n.leaves.length);
      langLists.set(n, ordered(n.leaves.map((l) => ({ key: l.lang, v: l }))));
    }
  }
  const leaves: ResourceLeaf[] = [];
  for (const { v: t } of typeList) {
    for (const { v: n } of nameLists.get(t)!)
      for (const { v: l } of langLists.get(n)!) leaves.push(l);
  }
  const entryOff = new Map<ResourceLeaf, number>();
  for (const l of leaves) {
    entryOff.set(l, off);
    off += 16;
  }
  const strings = new W(true);
  const strBase = off;
  const nameAt = new Map<string, number>();
  const nameField = (key: number | string): number => {
    if (typeof key === 'number') return key;
    let at = nameAt.get(key);
    if (at === undefined) {
      at = strBase + strings.length;
      strings.u16(key.length).utf16(key, false);
      nameAt.set(key, at);
    }
    return (0x80000000 | at) >>> 0;
  };
  const out = new W(true);
  const header = (list: Keyed<unknown>[]) => {
    const named = list.filter((i) => typeof i.key === 'string').length;
    out
      .u32(0)
      .u32(0)
      .u16(0)
      .u16(0)
      .u16(named)
      .u16(list.length - named);
  };
  header(typeList);
  for (const { key, v: t } of typeList)
    out.u32(nameField(key)).u32((0x80000000 | nameDir.get(t)!) >>> 0);
  for (const { v: t } of typeList) {
    const names = nameLists.get(t)!;
    header(names);
    for (const { key, v: n } of names)
      out.u32(nameField(key)).u32((0x80000000 | langDir.get(n)!) >>> 0);
  }
  for (const { v: t } of typeList) {
    for (const { v: n } of nameLists.get(t)!) {
      const langs = langLists.get(n)!;
      header(langs);
      for (const { key, v: l } of langs) out.u32(key as number).u32(entryOff.get(l)!);
    }
  }
  // data entries need the final position of each blob, which follows the name strings
  const stringsBytes = strings.toBytes();
  let dataAt = alignUp(strBase + stringsBytes.length, 4);
  const dataOff = new Map<ResourceLeaf, number>();
  for (const l of leaves) {
    dataOff.set(l, dataAt);
    dataAt = alignUp(dataAt + l.data.length, 4);
  }
  for (const l of leaves)
    out
      .u32(rva + dataOff.get(l)!)
      .u32(l.data.length)
      .u32(l.codepage ?? 1252)
      .u32(0);
  out.bytes(stringsBytes).align(4);
  for (const l of leaves) out.bytes(l.data).align(4);
  return out.toBytes();
}

const rol32 = (v: number, n: number): number => ((v << (n & 31)) | (v >>> (32 - (n & 31)))) >>> 0;

const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const o = new Uint8Array(a.length + b.length);
  o.set(a);
  o.set(b, a.length);
  return o;
};

interface PeSection {
  name: string;
  chars: number;
  /** Builds the bytes once the section's own RVA (and every section's RVA) is known. */
  build: (self: number, rvas: Map<string, number>) => Uint8Array;
  virtualSize?: number;
  /** Raw size 0 although it has a virtual size. */
  empty?: boolean;
}

const SEC_ALIGN = 0x1000;
const FILE_ALIGN = 0x200;

/** Metadata of a .NET assembly: CLR header, metadata root with five streams, the #US heap. */
function buildClr(rva: number, userStrings: string[]): { bytes: Uint8Array; headerSize: number } {
  const us = new W(true).u8(0);
  for (const s of userStrings) {
    const len = s.length * 2 + 1;
    if (len < 0x80) us.u8(len);
    else us.u8(0x80 | (len >> 8)).u8(len & 0xff);
    us.utf16(s, false).u8(0);
  }
  us.align(4);
  const heaps: [string, Uint8Array][] = [
    ['#~', new Uint8Array(24)],
    ['#Strings', Uint8Array.from([0, 0x3c, 0x4d, 0x6f, 0x64, 0x75, 0x6c, 0x65, 0x3e, 0, 0, 0])],
    ['#US', us.toBytes()],
    ['#GUID', new Uint8Array(16)],
    ['#Blob', new Uint8Array(4)],
  ];
  const version = 'v4.0.30319';
  const rootFixed = 16 + alignUp(version.length + 1, 4) + 4;
  const headersSize = heaps.reduce((a, [n]) => a + 8 + alignUp(n.length + 1, 4), 0);
  const md = new W(true);
  md.u32(0x424a5342)
    .u16(1)
    .u16(1)
    .u32(0)
    .u32(alignUp(version.length + 1, 4))
    .ascii(version)
    .align(4);
  md.u16(0).u16(heaps.length);
  let pos = rootFixed + headersSize;
  for (const [n, data] of heaps) {
    md.u32(pos).u32(data.length).ascii(n).align(4);
    pos += data.length;
  }
  for (const [, data] of heaps) md.bytes(data);
  const metadata = md.toBytes();
  const cor = new W(true)
    .u32(72)
    .u16(2)
    .u16(5)
    .u32(rva + 72)
    .u32(metadata.length)
    .u32(1)
    .u32(0x06000001)
    .zeros(48);
  return { bytes: concat(cor.toBytes(), metadata), headerSize: 72 };
}

export function buildPe(spec: PeSpec = {}): Uint8Array {
  const plus = spec.plus ?? false;
  const word = plus ? 8 : 4;
  const machine = spec.machine ?? (plus ? 0x8664 : 0x14c);
  const imageBase = plus ? 0x140000000n : 0x400000n;
  const nm = (n: string) => spec.sectionNames?.[n] ?? n;
  const imports = spec.clr
    ? [{ dll: 'mscoree.dll', funcs: [spec.dll ? '_CorDllMain' : '_CorExeMain'] }]
    : (spec.imports ?? [{ dll: 'kernel32.dll', funcs: ['ExitProcess'] }]);
  /** Offsets inside .rdata of what the headers and the code need to point at. */
  const mark = new Map<string, number>();

  const rdata = (rva: number, rvas: Map<string, number>): Uint8Array => {
    const b = new W(true);
    const ordinalFlag = plus ? 0x8000000000000000n : 0x80000000n;
    const tables = (list: PeImportSpec[], tag: 'imp' | 'delay', descSize: number): void => {
      if (list.length === 0) return;
      b.align(4);
      const descAt = b.length;
      mark.set(`dir:${tag}`, descAt);
      mark.set(`size:${tag}`, (list.length + 1) * descSize);
      b.zeros((list.length + 1) * descSize);
      const thunks = list.map((d, di) => {
        b.align(4);
        const ilt = b.length;
        b.zeros((d.funcs.length + 1) * word);
        const iat = b.length;
        mark.set(`${tag}:iat:${di}`, iat);
        b.zeros((d.funcs.length + 1) * word);
        return { ilt, iat };
      });
      list.forEach((d, di) => {
        const { ilt, iat } = thunks[di]!;
        const nameAt = b.length;
        b.ascii(d.dll);
        d.funcs.forEach((f, fi) => {
          let v: bigint;
          if (typeof f === 'number') v = ordinalFlag | BigInt(f);
          else {
            b.align(2);
            v = BigInt(rva + b.length);
            b.u16(fi + 1).ascii(f);
          }
          b.patchWord(ilt + fi * word, v, plus);
          b.patchWord(iat + fi * word, v, plus);
        });
        const desc = descAt + di * descSize;
        if (tag === 'imp') {
          b.patch32(desc, rva + ilt);
          b.patch32(desc + 12, rva + nameAt);
          b.patch32(desc + 16, rva + iat);
        } else {
          b.patch32(desc, 1); // attributes: RVAs, not addresses
          b.patch32(desc + 4, rva + nameAt);
          b.patch32(desc + 12, rva + iat);
          b.patch32(desc + 16, rva + ilt);
        }
      });
    };
    tables(imports, 'imp', 20);
    tables(spec.delayImports ?? [], 'delay', 32);

    if (spec.exports) {
      b.align(4);
      const e = spec.exports;
      const at = b.length;
      mark.set('dir:exp', at);
      b.zeros(40);
      const funcsAt = b.length;
      b.zeros(e.names.length * 4);
      const namesAt = b.length;
      b.zeros(e.names.length * 4);
      const ordsAt = b.length;
      for (let i = 0; i < e.names.length; i++) b.u16(i);
      b.align(4);
      const dllAt = b.length;
      b.ascii(e.dllName);
      const nameRvas = e.names.map((n) => {
        const o = b.length;
        b.ascii(n);
        return o;
      });
      const forwards = new Map<string, number>();
      for (const [n, target] of Object.entries(e.forwarders ?? {})) {
        forwards.set(n, b.length);
        b.ascii(target);
      }
      mark.set('size:exp', b.length - at);
      b.patch32(at + 4, spec.timestamp ?? 0x65a4f8a8);
      b.patch32(at + 12, rva + dllAt);
      b.patch32(at + 16, 1);
      b.patch32(at + 20, e.names.length);
      b.patch32(at + 24, e.names.length);
      b.patch32(at + 28, rva + funcsAt);
      b.patch32(at + 32, rva + namesAt);
      b.patch32(at + 36, rva + ordsAt);
      e.names.forEach((n, i) => {
        const f = forwards.get(n);
        b.patch32(
          funcsAt + i * 4,
          f !== undefined ? rva + f : (rvas.get(nm('.text')) ?? 0) + 8 * i + 4,
        );
        b.patch32(namesAt + i * 4, rva + nameRvas[i]!);
      });
    }

    if (spec.pdb) {
      b.align(4);
      const at = b.length;
      mark.set('dir:dbg', at);
      mark.set('size:dbg', 28);
      const cv = new W(true)
        .ascii('RSDS', false)
        .bytes([
          0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff,
          0x01,
        ])
        .u32(1)
        .ascii(spec.pdb)
        .toBytes();
      b.u32(0)
        .u32(spec.timestamp ?? 0x65a4f8a8)
        .u16(0)
        .u16(0)
        .u32(2)
        .u32(cv.length)
        .u32(rva + at + 28)
        .u32(0);
      mark.set('debug:rawptr', at + 24);
      b.bytes(cv);
    }
    if (spec.tls) {
      b.align(8);
      const at = b.length;
      mark.set('dir:tls', at);
      mark.set('size:tls', word * 4 + 8);
      mark.set('tls:dir', at);
      for (let i = 0; i < 4; i++) b.word(0, plus);
      b.u32(0).u32(0);
      b.align(word);
      mark.set('tls:cb', b.length);
      b.word(0, plus).word(0, plus);
    }
    if (spec.loadConfig) {
      b.align(8);
      const size = plus ? 0x94 : 0x5c;
      mark.set('dir:lc', b.length);
      mark.set('size:lc', size);
      b.u32(size).zeros(size - 4);
    }
    b.align(16);
    return b.toBytes();
  };

  const sections: PeSection[] = [];
  if (spec.emptySection) {
    sections.push({
      name: nm(spec.emptySection),
      chars: 0xe0000080,
      build: () => new Uint8Array(0),
      virtualSize: 0x20000,
      empty: true,
    });
  }
  sections.push({
    name: nm('.text'),
    chars: 0x60000020,
    build: (self, rvas) => {
      const t = new W(true);
      const iat = (rvas.get(nm('.rdata')) ?? 0) + (mark.get('imp:iat:0') ?? 0);
      let clrHeader = 0;
      if (spec.clr) {
        const clr = buildClr(self, spec.clr.userStrings);
        t.bytes(clr.bytes).align(16);
        clrHeader = clr.headerSize;
      }
      void clrHeader;
      const codeAt = t.length;
      mark.set('text:code', codeAt);
      if (spec.clr) {
        t.bytes([0xff, 0x25]).u32(Number(imageBase) + iat);
      } else if (plus) {
        t.bytes([0x31, 0xc9, 0xff, 0x15]).u32((iat - (self + codeAt + 8)) >>> 0);
      } else {
        t.bytes([0x6a, 0x00, 0xff, 0x15]).u32(Number(imageBase) + iat);
      }
      t.bytes([0xcc, 0xcc, 0xcc, 0xcc]);
      if (spec.code) t.bytes(spec.code);
      while (t.length < 0x40 + codeAt) t.u8(0xcc);
      return t.toBytes();
    },
  });
  sections.push({
    name: nm('.rdata'),
    chars: 0x40000040,
    build: (self, rvas) => rdata(self, rvas),
  });
  if (spec.resources) {
    const resources = spec.resources;
    sections.push({
      name: nm('.rsrc'),
      chars: 0x40000040,
      build: (self) => buildResources(resources, self),
    });
  }
  sections.push({
    name: nm('.reloc'),
    chars: 0x42000040,
    build: (self) =>
      new W(true)
        .u32(self)
        .u32(12)
        .u16(0x3000 | 4)
        .u16(0)
        .toBytes(),
  });

  // ---- headers sizes ----
  const richEntries =
    spec.rich === false
      ? null
      : (spec.rich ?? [
          { productId: 1, build: 0, count: 8 },
          { productId: 0x5d, build: 30795, count: 3 },
          { productId: 0x104, build: 31935, count: 1 },
        ]);
  const richSize = richEntries ? 16 + richEntries.length * 8 + 8 : 0;
  const lfanew = alignUp(0x80 + richSize, 8);
  const optSize = plus ? 240 : 224;
  const sizeOfHeaders = alignUp(lfanew + 24 + optSize + sections.length * 40, FILE_ALIGN);

  // ---- layout: every section's RVA depends only on the sizes of the ones before it, and sizes
  // never depend on RVAs, so one pass measures and a second builds with the final addresses ----
  let rvas = new Map<string, number>();
  let blobs: Uint8Array[] = [];
  for (let pass = 0; pass < 3; pass++) {
    const next = new Map<string, number>();
    let rva = SEC_ALIGN;
    const built: Uint8Array[] = [];
    for (const s of sections) {
      next.set(s.name, rva);
      const data = s.build(rva, pass === 0 ? new Map() : rvas);
      built.push(data);
      rva += alignUp(Math.max(s.virtualSize ?? data.length, 1), SEC_ALIGN);
    }
    rvas = next;
    blobs = built;
  }

  const rawPtrs: number[] = [];
  let raw = sizeOfHeaders;
  sections.forEach((s, i) => {
    rawPtrs.push(s.empty ? 0 : raw);
    if (!s.empty) raw += alignUp(blobs[i]!.length, FILE_ALIGN);
  });
  const idx = (n: string) => sections.findIndex((s) => s.name === nm(n));
  const rdIdx = idx('.rdata');
  const rdRva = rvas.get(nm('.rdata'))!;
  const textRva = rvas.get(nm('.text'))!;
  const rdBytes = blobs[rdIdx]!;
  const rdView = new DataView(rdBytes.buffer, rdBytes.byteOffset, rdBytes.byteLength);
  if (spec.pdb) {
    const at = mark.get('debug:rawptr')!;
    rdView.setUint32(at, rawPtrs[rdIdx]! + at + 4, true); // the CodeView data follows the entry
  }
  const setWord = (o: number, v: bigint) =>
    plus ? rdView.setBigUint64(o, v, true) : rdView.setUint32(o, Number(v), true);
  if (spec.tls) {
    const t = mark.get('tls:dir')!;
    const cb = mark.get('tls:cb')!;
    setWord(t, imageBase + BigInt(rdRva + cb));
    setWord(t + word, imageBase + BigInt(rdRva + cb));
    setWord(t + word * 3, imageBase + BigInt(rdRva + cb));
    setWord(cb, imageBase + BigInt(textRva + (mark.get('text:code') ?? 0) + 8));
  }
  if (spec.loadConfig) {
    setWord(mark.get('dir:lc')! + (plus ? 0x58 : 0x3c), imageBase + BigInt(rdRva));
  }
  const imageSize = alignUp(
    Math.max(
      ...sections.map((s, i) => rvas.get(s.name)! + Math.max(s.virtualSize ?? blobs[i]!.length, 1)),
    ),
    SEC_ALIGN,
  );

  // ---- data directories ----
  const dir = new Map<number, [number, number]>();
  const at = (k: string) => rdRva + (mark.get(`dir:${k}`) ?? 0);
  const size = (k: string) => mark.get(`size:${k}`) ?? 0;
  if (mark.has('dir:exp')) dir.set(0, [at('exp'), size('exp')]);
  if (mark.has('dir:imp')) dir.set(1, [at('imp'), size('imp')]);
  if (idx('.rsrc') >= 0) dir.set(2, [rvas.get(nm('.rsrc'))!, blobs[idx('.rsrc')]!.length]);
  dir.set(5, [rvas.get(nm('.reloc'))!, blobs[idx('.reloc')]!.length]);
  if (mark.has('dir:dbg')) dir.set(6, [at('dbg'), 28]);
  if (mark.has('dir:tls')) dir.set(9, [at('tls'), size('tls')]);
  if (mark.has('dir:lc')) dir.set(10, [at('lc'), size('lc')]);
  if (mark.has('dir:delay')) dir.set(13, [at('delay'), size('delay')]);
  if (spec.clr) dir.set(14, [textRva, 72]);

  // ---- file ----
  const file = new W(true);
  file.ascii('MZ', false).u16(0x90).u16(3).u16(0).u16(4).u16(0).u16(0xffff).u16(0).u16(0xb8);
  file.u16(0).u16(0).u16(0).u16(0x40).u16(0);
  file.zeros(0x3c - file.length).u32(lfanew);
  file.bytes([0x0e, 0x1f, 0xba, 0x0e, 0x00, 0xb4, 0x09, 0xcd, 0x21, 0xb8, 0x01, 0x4c, 0xcd, 0x21]);
  file.ascii('This program cannot be run in DOS mode.\r\r\n$', false);
  file.zeros(0x80 - file.length);
  if (richEntries) {
    const dans = file.length;
    const head = file.toBytes();
    let sum = dans;
    for (let i = 0; i < dans; i++) {
      if (i >= 0x3c && i < 0x40) continue;
      sum = (sum + rol32(head[i]!, i)) >>> 0;
    }
    for (const e of richEntries)
      sum = (sum + rol32(((e.productId << 16) | e.build) >>> 0, e.count)) >>> 0;
    file
      .u32((0x536e6144 ^ sum) >>> 0)
      .u32(sum)
      .u32(sum)
      .u32(sum);
    for (const e of richEntries)
      file.u32((((e.productId << 16) | e.build) ^ sum) >>> 0).u32((e.count ^ sum) >>> 0);
    file.u32(0x68636952).u32(sum);
  }
  file.zeros(lfanew - file.length);
  const chars = 0x0002 | (spec.dll ? 0x2000 : 0) | (plus ? 0x0020 : 0x0100);
  file
    .ascii('PE\0\0', false)
    .u16(machine)
    .u16(sections.length)
    .u32(spec.timestamp ?? 0x65a4f8a8)
    .u32(0)
    .u32(0)
    .u16(optSize)
    .u16(chars);
  const entry = spec.dll ? 0 : textRva + (mark.get('text:code') ?? 0);
  const dllChars = spec.dllCharacteristics ?? 0x8000 | 0x0100 | 0x0040 | (plus ? 0x20 : 0);
  file
    .u16(plus ? 0x20b : 0x10b)
    .u8(14)
    .u8(36)
    .u32(0x200)
    .u32(0x200)
    .u32(0)
    .u32(entry)
    .u32(textRva);
  if (!plus) file.u32(rdRva);
  file.word(imageBase, plus).u32(SEC_ALIGN).u32(FILE_ALIGN);
  file.u16(6).u16(0).u16(0).u16(0).u16(6).u16(0).u32(0).u32(imageSize).u32(sizeOfHeaders).u32(0);
  file.u16(spec.subsystem ?? (spec.dll ? 2 : 3)).u16(dllChars);
  file
    .word(0x100000, plus)
    .word(0x1000, plus)
    .word(0x100000, plus)
    .word(0x1000, plus)
    .u32(0)
    .u32(16);
  for (let i = 0; i < 16; i++) {
    const d = dir.get(i) ?? [0, 0];
    file.u32(d[0]).u32(d[1]);
  }
  sections.forEach((s, i) => {
    const blob = blobs[i]!;
    const name = new Uint8Array(8);
    name.set(enc(s.name).subarray(0, 8));
    file
      .bytes(name)
      .u32(s.virtualSize ?? blob.length)
      .u32(rvas.get(s.name)!)
      .u32(s.empty ? 0 : alignUp(blob.length, FILE_ALIGN))
      .u32(rawPtrs[i]!)
      .u32(0)
      .u32(0)
      .u16(0)
      .u16(0)
      .u32(s.chars);
  });
  file.zeros(sizeOfHeaders - file.length);
  sections.forEach((s, i) => {
    if (!s.empty) file.bytes(blobs[i]!).align(FILE_ALIGN);
  });
  let out = file.toBytes();
  if (spec.certificate) {
    // The security directory is the one directory whose "address" is a file offset.
    const dv = new DataView(out.buffer);
    const dirsAt = lfanew + 24 + (plus ? 112 : 96);
    dv.setUint32(dirsAt + 4 * 8, out.length, true);
    dv.setUint32(dirsAt + 4 * 8 + 4, spec.certificate.length, true);
    out = concat(out, spec.certificate);
  }
  if (spec.overlay) out = concat(out, spec.overlay);
  return out;
}

/** The committed PE sample: PE32 with imports, resources, a Rich header, a PDB path and an overlay. */
export function buildSamplePe(): Uint8Array {
  const pixels = Array.from({ length: 16 * 16 }, (_, i) => [
    0x30 + (i % 16) * 8,
    0x90,
    0x20,
    0xff,
  ]).flat();
  const icon = new W(true)
    .u32(40)
    .u32(16)
    .u32(32)
    .u16(1)
    .u16(32)
    .u32(0)
    .u32(16 * 16 * 4)
    .u32(0)
    .u32(0)
    .u32(0)
    .u32(0)
    .bytes(pixels)
    .bytes(new Uint8Array(16 * 4))
    .toBytes();
  const groupIcon = new W(true)
    .u16(0)
    .u16(1)
    .u16(1)
    .u8(16)
    .u8(16)
    .u8(0)
    .u8(0)
    .u16(1)
    .u16(32)
    .u32(icon.length)
    .u16(1)
    .toBytes();
  const manifest = enc(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">\n' +
      '  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3"><security><requestedPrivileges>' +
      '<requestedExecutionLevel level="asInvoker" uiAccess="false"/></requestedPrivileges></security></trustInfo>\n' +
      '</assembly>\n',
  );
  const version = buildVersionInfo({
    CompanyName: 'Find The Flag samples',
    FileDescription: 'Sample executable for the analyzer',
    FileVersion: '1.2.3.4',
    InternalName: 'sample',
    OriginalFilename: 'sample.exe',
    ProductName: 'FTF sample',
    ProductVersion: '1.2.3.4',
  });
  return buildPe({
    imports: [
      { dll: 'kernel32.dll', funcs: ['ExitProcess', 'GetProcAddress'] },
      { dll: 'ws2_32.dll', funcs: [115] },
    ],
    resources: [
      {
        type: 10,
        names: [{ name: 101, leaves: [{ lang: 0x409, data: enc('FTF{pe_resource}') }] }],
      },
      { type: 24, names: [{ name: 1, leaves: [{ lang: 0x409, data: manifest }] }] },
      { type: 16, names: [{ name: 1, leaves: [{ lang: 0x409, data: version }] }] },
      { type: 3, names: [{ name: 1, leaves: [{ lang: 0x409, data: icon }] }] },
      { type: 14, names: [{ name: 'MAINICON', leaves: [{ lang: 0x409, data: groupIcon }] }] },
    ],
    pdb: 'C:\\build\\ftf\\sample.pdb',
    overlay: enc('FTF{overlay}\n'),
  });
}

// ======================================================================================
// Mach-O
// ======================================================================================

export interface MachoSpec {
  cpu?: number;
  pie?: boolean;
  stackExec?: boolean;
  cstring?: string;
  imports?: string[];
  signature?: boolean;
  encrypted?: boolean;
}

export function buildMacho(spec: MachoSpec = {}): Uint8Array {
  const cpu = spec.cpu ?? 0x01000007;
  const imports = spec.imports ?? ['_puts', '___stack_chk_fail'];
  const str = new StrTab();
  const names = ['_main', ...imports];
  const nameOffs = names.map((n) => str.add(n));
  const strBytes = Uint8Array.from(str.bytes);
  const cstring = enc(`${spec.cstring ?? 'FTF{macho_cstring}'}\0`);
  const textCode = Uint8Array.from([0x31, 0xc0, 0xc3]);
  const data = enc('ftf-data\0');
  const base = 0x100000000n;
  const pad = (name: string) => enc(name.padEnd(16, '\0'));

  interface Sect {
    name: string;
    addr: bigint;
    size: number;
    off: number;
  }
  const segment = (
    name: string,
    vmaddr: bigint,
    vmsize: bigint,
    fileoff: number,
    filesize: number,
    prot: number,
    sects: Sect[],
  ): Uint8Array => {
    const c = new W(true);
    c.u32(0x19)
      .u32(72 + sects.length * 80)
      .bytes(pad(name))
      .u64(vmaddr)
      .u64(vmsize)
      .u64(fileoff)
      .u64(filesize);
    c.u32(prot).u32(prot).u32(sects.length).u32(0);
    for (const s of sects) {
      c.bytes(pad(s.name))
        .bytes(pad(name))
        .u64(s.addr)
        .u64(s.size)
        .u32(s.off)
        .u32(0)
        .u32(0)
        .u32(0)
        .u32(0)
        .u32(0)
        .u32(0)
        .u32(0);
    }
    return c.toBytes();
  };
  const libName = '/usr/lib/libSystem.B.dylib';
  const dylibCmd = new W(true)
    .u32(0xc)
    .u32(alignUp(24 + libName.length + 1, 8))
    .u32(24)
    .u32(2)
    .u32(0x10000)
    .u32(0x10000)
    .ascii(libName)
    .align(8)
    .toBytes();
  const linker = '/usr/lib/dyld';
  const dyldCmd = new W(true)
    .u32(0xe)
    .u32(alignUp(12 + linker.length + 1, 8))
    .u32(12)
    .ascii(linker)
    .align(8)
    .toBytes();
  const uuidCmd = new W(true)
    .u32(0x1b)
    .u32(24)
    .bytes(Array.from({ length: 16 }, (_, i) => 0xa0 + i))
    .toBytes();
  const buildCmd = new W(true).u32(0x32).u32(24).u32(1).u32(0xb0000).u32(0xc0000).u32(0).toBytes();

  /** All load commands for the given file offsets (their sizes never depend on the offsets). */
  const commands = (
    textOff: number,
    cstrOff: number,
    textEnd: number,
    dataOff: number,
    symOff: number,
    strOff: number,
    end: number,
  ): Uint8Array[] => {
    const cmds = [
      segment('__PAGEZERO', 0n, base, 0, 0, 0, []),
      segment('__TEXT', base, 0x1000n, 0, textEnd, 5, [
        { name: '__text', addr: base + BigInt(textOff), size: textCode.length, off: textOff },
        { name: '__cstring', addr: base + BigInt(cstrOff), size: cstring.length, off: cstrOff },
      ]),
      segment('__DATA', base + 0x1000n, 0x1000n, dataOff, data.length, 3, [
        { name: '__data', addr: base + 0x1000n, size: data.length, off: dataOff },
      ]),
      segment('__LINKEDIT', base + 0x2000n, 0x1000n, symOff, end - symOff, 1, []),
      new W(true)
        .u32(0x2)
        .u32(24)
        .u32(symOff)
        .u32(names.length)
        .u32(strOff)
        .u32(strBytes.length)
        .toBytes(),
      dyldCmd,
      uuidCmd,
      buildCmd,
      new W(true).u32(0x80000028).u32(24).u64(textOff).u64(0).toBytes(),
      dylibCmd,
    ];
    if (spec.signature) cmds.push(new W(true).u32(0x1d).u32(16).u32(end).u32(16).toBytes());
    if (spec.encrypted)
      cmds.push(new W(true).u32(0x2c).u32(24).u32(textOff).u32(16).u32(1).u32(0).toBytes());
    return cmds;
  };
  const sizeOfCmds = commands(0, 0, 0, 0, 0, 0, 0).reduce((a, c) => a + c.length, 0);
  const textOff = alignUp(32 + sizeOfCmds, 16);
  const cstrOff = textOff + textCode.length;
  const textEnd = cstrOff + cstring.length;
  const dataOff = alignUp(textEnd, 16);
  const symOff = alignUp(dataOff + data.length, 8);
  const nl = new W(true);
  names.forEach((_, i) => {
    const undef = i > 0;
    nl.u32(nameOffs[i]!)
      .u8(undef ? 0x01 : 0x0f)
      .u8(undef ? 0 : 1)
      .u16(0)
      .u64(undef ? 0n : base + BigInt(textOff));
  });
  const strOff = symOff + nl.length;
  const end = strOff + strBytes.length;
  const cmds = commands(textOff, cstrOff, textEnd, dataOff, symOff, strOff, end);
  const flags =
    0x1 | 0x4 | 0x80 | (spec.pie === false ? 0 : 0x200000) | (spec.stackExec ? 0x20000 : 0);
  const head = new W(true)
    .u32(0xfeedfacf)
    .u32(cpu)
    .u32(3)
    .u32(2)
    .u32(cmds.length)
    .u32(sizeOfCmds)
    .u32(flags)
    .u32(0);
  const out = new Uint8Array(end + (spec.signature ? 16 : 0));
  out.set(head.toBytes());
  let o = 32;
  for (const c of cmds) {
    out.set(c, o);
    o += c.length;
  }
  out.set(textCode, textOff);
  out.set(cstring, cstrOff);
  out.set(data, dataOff);
  out.set(nl.toBytes(), symOff);
  out.set(strBytes, strOff);
  return out;
}

/** A universal binary holding the given slices (big-endian fat header). */
export function buildFat(slices: { cpu: number; data: Uint8Array }[]): Uint8Array {
  const f = new W(false);
  f.u32(0xcafebabe).u32(slices.length);
  let off = alignUp(8 + slices.length * 20, 0x1000);
  const offs: number[] = [];
  for (const s of slices) {
    f.u32(s.cpu).u32(3).u32(off).u32(s.data.length).u32(12);
    offs.push(off);
    off = alignUp(off + s.data.length, 0x1000);
  }
  const out = new Uint8Array(off);
  out.set(f.toBytes());
  slices.forEach((s, i) => out.set(s.data, offs[i]!));
  return out;
}

/** The committed ELF sample: PIE x86-64 with an interpreter, symbols, notes and the usual hardening. */
export function buildSampleElf(): Uint8Array {
  return buildElf({
    imports: ['puts', '__printf_chk', '__stack_chk_fail', '__libc_start_main'],
    needed: ['libc.so.6'],
    cet: true,
    relro: true,
  });
}
