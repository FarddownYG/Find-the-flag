/**
 * Detect and extract a steganographic channel hidden in the *encoding* of x86 instructions, not in
 * the data: register-register ALU and mov instructions have two equivalent opcodes that differ only
 * in the direction bit (89 <-> 8b, 01 <-> 03, 31 <-> 33, 88 <-> 8a ...). A compiler always emits the
 * same (normal) form; a tool that flips some of them hides one bit per instruction — 0 for the
 * normal form, 1 for the reversed form, read in file order, packed most-significant bit first.
 *
 * The caller supplies the raw bytes and the byte length of every instruction (from a proven
 * decoder, see _exe-x86-decoder.ts). Everything here is pure, so it is easy to test and to extend
 * with new instruction families.
 */

/** The direction-bit families: register/register ALU ops and mov. Index of ALU = (opcode>>3)&7. */
export const ALU_MNEMONICS = ['add', 'or', 'adc', 'sbb', 'and', 'sub', 'xor', 'cmp'] as const;
export type DualMnemonic = (typeof ALU_MNEMONICS)[number] | 'mov';
export const DUAL_MNEMONICS: readonly DualMnemonic[] = [...ALU_MNEMONICS, 'mov'];

/** Legacy prefixes that can sit before the opcode (lock/rep, segment, operand- and address-size). */
const LEGACY_PREFIXES = new Set([0xf0, 0xf2, 0xf3, 0x2e, 0x36, 0x3e, 0x26, 0x64, 0x65, 0x66, 0x67]);

const REG8 = ['al', 'cl', 'dl', 'bl', 'ah', 'ch', 'dh', 'bh'];
const REG8_REX = [
  'al',
  'cl',
  'dl',
  'bl',
  'spl',
  'bpl',
  'sil',
  'dil',
  'r8b',
  'r9b',
  'r10b',
  'r11b',
  'r12b',
  'r13b',
  'r14b',
  'r15b',
];
const REG16 = [
  'ax',
  'cx',
  'dx',
  'bx',
  'sp',
  'bp',
  'si',
  'di',
  'r8w',
  'r9w',
  'r10w',
  'r11w',
  'r12w',
  'r13w',
  'r14w',
  'r15w',
];
const REG32 = [
  'eax',
  'ecx',
  'edx',
  'ebx',
  'esp',
  'ebp',
  'esi',
  'edi',
  'r8d',
  'r9d',
  'r10d',
  'r11d',
  'r12d',
  'r13d',
  'r14d',
  'r15d',
];
const REG64 = [
  'rax',
  'rcx',
  'rdx',
  'rbx',
  'rsp',
  'rbp',
  'rsi',
  'rdi',
  'r8',
  'r9',
  'r10',
  'r11',
  'r12',
  'r13',
  'r14',
  'r15',
];

function regName(index: number, size: 8 | 16 | 32 | 64, hasRex: boolean): string {
  if (size === 8) return hasRex ? REG8_REX[index]! : REG8[index & 7]!;
  return (size === 16 ? REG16 : size === 32 ? REG32 : REG64)[index]!;
}

/** The dual mnemonic and operand size of an opcode byte, or null when it is not a dual family. */
function dualInfo(op: number): { mnemonic: DualMnemonic; size8: boolean } | null {
  if (op >= 0x88 && op <= 0x8b) return { mnemonic: 'mov', size8: (op & 1) === 0 };
  if (op < 0x40 && (op & 7) <= 3)
    return { mnemonic: ALU_MNEMONICS[(op >> 3) & 7]!, size8: (op & 1) === 0 };
  return null;
}

export interface DualInstr {
  /** Offset of the instruction inside the scanned bytes. */
  offset: number;
  /** The opcode byte (e.g. 0x89 or 0x8b). */
  opcode: number;
  mnemonic: DualMnemonic;
  /** 0 = normal (store/MR form), 1 = reversed (load/RM form). */
  bit: 0 | 1;
  /** Human-readable disassembly, e.g. "mov rbx, rsi". */
  text: string;
  /** The instruction's raw bytes. */
  bytes: Uint8Array;
}

export interface FamilyStat {
  mnemonic: DualMnemonic;
  normal: number;
  reversed: number;
}

export interface ScanResult {
  /** Every register-register dual instruction, in file order (checked families only). */
  instructions: DualInstr[];
  /** Per family, the normal vs reversed counts (all families, for the verdict table). */
  stats: FamilyStat[];
  /** Total instructions walked. */
  total: number;
  reversed: number;
  regReg: number;
}

/** Decode one instruction's prefixes just far enough to read a dual register-register opcode. */
function readDual(
  code: Uint8Array,
  off: number,
  len: number,
  bitness: number,
): { info: NonNullable<ReturnType<typeof dualInfo>>; opcode: number; text: string } | null {
  let p = off;
  const end = off + len;
  let p66 = false;
  while (p < end && LEGACY_PREFIXES.has(code[p]!)) {
    if (code[p] === 0x66) p66 = true;
    p++;
  }
  let rexW = false;
  let rexR = false;
  let rexB = false;
  let hasRex = false;
  if (bitness === 64 && p < end && (code[p]! & 0xf0) === 0x40) {
    const rex = code[p]!;
    hasRex = true;
    rexW = (rex & 8) !== 0;
    rexR = (rex & 4) !== 0;
    rexB = (rex & 1) !== 0;
    p++;
  }
  if (p + 1 >= end) return null;
  const opcode = code[p]!;
  const info = dualInfo(opcode);
  if (!info) return null;
  const modrm = code[p + 1]!;
  if (modrm >> 6 !== 3) return null; // not register-register

  const size: 8 | 16 | 32 | 64 = info.size8 ? 8 : rexW ? 64 : p66 ? 16 : 32;
  const reg = regName(((modrm >> 3) & 7) | (rexR ? 8 : 0), size, hasRex);
  const rm = regName((modrm & 7) | (rexB ? 8 : 0), size, hasRex);
  // MR form (bit 0): r/m <- reg, shown "mnemonic rm, reg". RM form (bit 1): reg <- r/m.
  const bit = (opcode >> 1) & 1;
  const [dst, src] = bit === 0 ? [rm, reg] : [reg, rm];
  return { info, opcode, text: `${info.mnemonic} ${dst}, ${src}` };
}

/**
 * Walk the instructions (given their byte lengths) and collect the register-register dual
 * instructions of the enabled families, with per-family normal/reversed statistics.
 */
export function scan(
  code: Uint8Array,
  lengths: Uint32Array | readonly number[],
  bitness: 16 | 32 | 64,
  enabled: ReadonlySet<DualMnemonic>,
): ScanResult {
  const stats = new Map<DualMnemonic, FamilyStat>(
    DUAL_MNEMONICS.map((m) => [m, { mnemonic: m, normal: 0, reversed: 0 }]),
  );
  const instructions: DualInstr[] = [];
  let off = 0;
  let reversed = 0;
  let regReg = 0;
  let total = 0;
  for (const len of lengths) {
    if (len <= 0 || off + len > code.length) break;
    total++;
    const d = readDual(code, off, len, bitness);
    if (d) {
      regReg++;
      const bit = ((d.opcode >> 1) & 1) as 0 | 1;
      if (bit) reversed++;
      const stat = stats.get(d.info.mnemonic)!;
      if (bit) stat.reversed++;
      else stat.normal++;
      if (enabled.has(d.info.mnemonic)) {
        instructions.push({
          offset: off,
          opcode: d.opcode,
          mnemonic: d.info.mnemonic,
          bit,
          text: d.text,
          bytes: code.subarray(off, off + len),
        });
      }
    }
    off += len;
  }
  return { instructions, stats: [...stats.values()], total, reversed, regReg };
}

/** Pack the direction bits (file order) into bytes, most- or least-significant bit first. */
export function packBits(bits: readonly (0 | 1)[], msbFirst: boolean, invert: boolean): Uint8Array {
  const out = new Uint8Array(Math.floor(bits.length / 8));
  for (let i = 0; i < out.length; i++) {
    let b = 0;
    for (let j = 0; j < 8; j++) {
      const raw = bits[i * 8 + j]!;
      const v = invert ? raw ^ 1 : raw;
      b |= v << (msbFirst ? 7 - j : j);
    }
    out[i] = b;
  }
  return out;
}

export interface LengthHeader {
  kind: 'u8' | 'u16le' | 'u16be' | 'u32le';
  /** Offset of the length field in the stream. */
  headerOffset: number;
  /** Bytes the length field occupies. */
  size: number;
  /** The declared length. */
  value: number;
  /** Where the body starts (right after the header). */
  bodyStart: number;
}

/** True when every byte is printable ASCII, tab, LF or CR (a plausible text body). */
function isReadable(bytes: Uint8Array): boolean {
  for (const b of bytes) {
    if (b === 9 || b === 10 || b === 13 || (b >= 0x20 && b <= 0x7e)) continue;
    return false;
  }
  return true;
}

/** Header offsets to probe: a few bytes of framing can precede the length field. */
const MAX_HEADER_SCAN = 8;

/**
 * Look for a length field (at a small offset) whose value frames a run of readable bytes that
 * ends exactly where the field says: the body must be readable AND be followed by a non-readable
 * byte (the normal-form padding after the message), so a value that merely reaches the end of a
 * wholly readable stream is not mistaken for a length. Candidates are returned best (longest) first.
 */
export function detectLengthHeader(bytes: Uint8Array): LengthHeader[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fields = [
    { kind: 'u8' as const, size: 1, get: (o: number) => dv.getUint8(o) },
    { kind: 'u16le' as const, size: 2, get: (o: number) => dv.getUint16(o, true) },
    { kind: 'u16be' as const, size: 2, get: (o: number) => dv.getUint16(o, false) },
    { kind: 'u32le' as const, size: 4, get: (o: number) => dv.getUint32(o, true) },
  ];
  const hits: LengthHeader[] = [];
  for (let off = 0; off <= MAX_HEADER_SCAN && off < bytes.length; off++) {
    for (const f of fields) {
      if (off + f.size > bytes.length) continue;
      const value = f.get(off);
      const bodyStart = off + f.size;
      const end = bodyStart + value;
      // The body must be readable, end before the stream end, and be followed by a non-readable
      // byte — otherwise any value reaching the end of a readable stream would frame "exactly".
      if (value < 2 || end >= bytes.length) continue;
      if (!isReadable(bytes.subarray(bodyStart, end))) continue;
      if (isReadable(bytes.subarray(end, end + 1))) continue;
      hits.push({ kind: f.kind, headerOffset: off, size: f.size, value, bodyStart });
    }
  }
  hits.sort((a, b) => b.value - a.value || a.headerOffset - b.headerOffset || a.size - b.size);
  return hits;
}

/** Shannon entropy in bits per byte (0..8) of a 256-bin byte histogram. */
export function entropyOf(histogram: Uint32Array, total: number): number {
  if (total === 0) return 0;
  let e = 0;
  for (const c of histogram) {
    if (c === 0) continue;
    const p = c / total;
    e -= p * Math.log2(p);
  }
  return e;
}

/** Latin-1 string of some bytes (each byte one character). */
export function latin1(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

/** A readable-ASCII preview: printable bytes kept, the rest shown as a dot. */
export function asciiPreview(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '·';
  return s;
}

/** Common flag shapes (FTF{...}, flag{...}, CTF{...}, name{...}) found in decoded text. */
export function findFlags(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/[A-Za-z][A-Za-z0-9_]{1,15}\{[^}\n]{1,200}\}/g)) out.add(m[0]);
  return [...out];
}
