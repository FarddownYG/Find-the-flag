/**
 * "What is this file?" for the Binary analyzer: magic bytes at offset 0 and at the offsets
 * disk formats use (ISO 9660 at 0x8001, raw CD sync patterns, FAT / NTFS / ext boot sectors,
 * MBR / GPT partition tables), turned into one plain-words verdict.
 */
import type { LazyFile } from '../../core/types';
import { signatureName, toolT } from '../../i18n/tool-text';
import { latin1Decode, printableRatio, u16be, u16le, u32le } from '../../lib/bytes';
import { identify, type Signature } from '../../lib/signatures';
import { readRange } from './_binary-stream';
import { detectCd, measureCd, SectorReader, zeroBytes, type CdLayout } from './_cd';
import { parseBpb, readPartitions, type Bpb, type Partition } from './_fat';
import { readIsoVolume, type IsoVolume } from './_iso9660';

const T = toolT('binary-analyzer');

export const HEAD = 64 << 10;

export interface Identity {
  head: Uint8Array;
  cd: CdLayout | null;
  iso: IsoVolume | null;
  bpb: Bpb | null;
  partitions: Partition[] | null;
  /** Filesystems recognised but not parsed. */
  fs: 'NTFS' | 'exFAT' | 'ext2/3/4' | null;
  /** Best signature at offset 0 (strong first). */
  sig: Signature | null;
  /** The signature is strong, or a weak one whose structure checks out (a PE header…). */
  sigSure: boolean;
  /** Format details of an executable (PE32, i386 · ELF64, LSB, x86-64, ET_DYN). */
  exe: string | null;
  printable: number;
  /** End of the main structure when it is known (volume size, partition table…). */
  mainEnd: number | null;
  /**
   * What follows the data track of a raw CD image when sectors without the sync pattern come
   * after it: CD audio, zeros, or a file appended to the BIN (a known signature or text).
   */
  afterData: { kind: 'audio' | 'zeros' | 'file'; start: number; sectors: number } | null;
}

export async function identifyFile(file: LazyFile): Promise<Identity> {
  const head = await readRange(file, 0, HEAD);
  let cd = detectCd(head, file.size);
  const iso = cd?.iso ? await readIsoVolume(new SectorReader(file, cd)) : null;
  if (cd) cd = await measureCd(file, cd, iso?.blocks ?? 0);
  let afterData: Identity['afterData'] = null;
  if (cd && cd.dataSectors < cd.sectors) {
    const start = cd.base + cd.dataSectors * cd.sectorSize;
    const first = await readRange(file, start, 4096);
    const appended =
      identify(first).some((x) => !x.weak) || printableRatio(first.subarray(0, 512)) > 0.9;
    const kind = appended
      ? 'file'
      : (await zeroBytes(file, start, file.size)) !== 'data'
        ? 'zeros'
        : 'audio';
    afterData = { kind, start, sectors: cd.sectors - cd.dataSectors };
  }
  const bpb = cd ? null : parseBpb(head);
  const partitions = cd || bpb ? null : await readPartitions(file);
  let fs: Identity['fs'] = null;
  if (latin1Decode(head.subarray(3, 11)) === 'NTFS    ') fs = 'NTFS';
  else if (latin1Decode(head.subarray(3, 11)) === 'EXFAT   ') fs = 'exFAT';
  else if (head.length > 1084 && u16le(head, 1080) === 0xef53 && u16le(head, 1024 + 0x18) <= 6) {
    fs = 'ext2/3/4';
  }
  const sigs = identify(head);
  // A weak magic (MZ) whose structure checks out (a PE header) is as good as a strong one.
  const sure = sigs.find((s) => !s.weak || (s.valid !== undefined && s.valid(head, 0)));
  const sig = sure ?? sigs[0] ?? null;
  let mainEnd: number | null = null;
  if (cd && iso) mainEnd = Math.min(file.size, cd.base + iso.blocks * cd.sectorSize);
  else if (bpb) mainEnd = bpb.totalSectors * bpb.bytesPerSector;
  else if (partitions?.length) mainEnd = Math.max(...partitions.map((p) => p.start + p.size));
  return {
    head,
    cd,
    iso,
    bpb,
    partitions,
    fs,
    sig,
    sigSure: sure !== undefined,
    exe: sig?.id === 'pe' ? peDetail(head) : sig?.id === 'elf' ? elfDetail(head) : null,
    printable: printableRatio(head.subarray(0, 4096)),
    mainEnd,
    afterData,
  };
}

const PE_MACHINES: Record<number, string> = {
  0x14c: 'i386',
  0x8664: 'x86-64',
  0x1c0: 'ARM',
  0x1c4: 'ARMv7 Thumb-2',
  0xaa64: 'ARM64',
  0x200: 'IA-64',
  0x166: 'MIPS',
  0x5032: 'RISC-V 32',
  0x5064: 'RISC-V 64',
  0xebc: 'EFI byte code',
};

/** "PE32, i386" / "PE32+, x86-64, DLL" from the COFF and optional headers. */
export function peDetail(b: Uint8Array): string | null {
  const pe = u32le(b, 0x3c);
  if (pe < 0x40 || pe + 26 > b.length || u32le(b, pe) !== 0x4550) return null;
  const machine = u16le(b, pe + 4);
  const magic = u16le(b, pe + 24);
  const parts = [
    magic === 0x20b ? 'PE32+' : magic === 0x107 ? 'ROM' : 'PE32',
    PE_MACHINES[machine] ?? `machine 0x${machine.toString(16)}`,
  ];
  if (u16le(b, pe + 22) & 0x2000) parts.push('DLL');
  return parts.join(', ');
}

const ELF_MACHINES: Record<number, string> = {
  2: 'SPARC',
  3: 'i386',
  8: 'MIPS',
  20: 'PowerPC',
  21: 'PowerPC64',
  22: 'S/390',
  40: 'ARM',
  43: 'SPARC V9',
  50: 'IA-64',
  62: 'x86-64',
  183: 'AArch64',
  243: 'RISC-V',
  247: 'eBPF',
  258: 'LoongArch',
};
const ELF_TYPES = ['ET_NONE', 'ET_REL', 'ET_EXEC', 'ET_DYN', 'ET_CORE'];

/** "ELF64, LSB, x86-64, ET_DYN", as file(1) words it. */
export function elfDetail(b: Uint8Array): string | null {
  if (b.length < 20 || (b[4] !== 1 && b[4] !== 2) || (b[5] !== 1 && b[5] !== 2)) return null;
  const little = b[5] === 1;
  const r16 = (o: number) => (little ? u16le(b, o) : u16be(b, o));
  const machine = r16(18);
  return [
    b[4] === 2 ? 'ELF64' : 'ELF32',
    little ? 'LSB' : 'MSB',
    ELF_MACHINES[machine] ?? `machine ${machine}`,
    ELF_TYPES[r16(16)] ?? `type ${r16(16)}`,
  ].join(', ');
}

/** Human name of a CD sector mode. */
export function modeName(l: CdLayout): string {
  switch (l.mode) {
    case 'mode1':
      return 'Mode 1';
    case 'mode2form1':
      return 'Mode 2 Form 1';
    case 'mode2form2':
      return 'Mode 2 Form 2';
    case 'mode2':
      return 'Mode 2';
    default:
      return 'Mode 1';
  }
}

/** No structure at all, and a whole number of 2352-byte sectors: raw CD audio (CD-DA)? */
export const maybeCdAudio = (id: Identity, size: number) =>
  !id.cd &&
  !id.bpb &&
  !id.partitions &&
  !id.fs &&
  !id.sig &&
  size >= 2352 * 75 &&
  size % 2352 === 0;

/** One sentence: what the file is. `entropy` is the whole-file Shannon entropy. */
export function verdict(id: Identity, entropy: number, zeroShare: number): string {
  const e = entropy.toFixed(2);
  if (id.cd) {
    const l = id.cd;
    if (l.sectorSize === 2048) return T('verdict.iso');
    if (l.sectorSize === 2336) return T('verdict.raw2336');
    const v = id.iso
      ? T('verdict.raw', { size: l.sectorSize, mode: modeName(l) })
      : T('verdict.rawNoIso', { size: l.sectorSize, mode: modeName(l) });
    return id.afterData?.kind === 'audio'
      ? T('verdict.withAudio', { verdict: v, count: id.afterData.sectors })
      : v;
  }
  if (id.bpb) return T('verdict.fat', { type: id.bpb.type });
  if (id.partitions) {
    return T('verdict.partitions', {
      scheme: id.partitions[0]?.scheme ?? 'MBR',
      count: id.partitions.length,
    });
  }
  if (id.fs) return T('verdict.fs', { fs: id.fs });
  if (id.sig && id.sigSure) {
    const name = signatureName(id.sig);
    return id.exe ? T('verdict.exe', { name, detail: id.exe }) : name;
  }
  if (id.printable > 0.95) return T('verdict.text');
  if (id.sig) return T('verdict.weak', { name: signatureName(id.sig) });
  if (zeroShare > 0.9) return T('verdict.zeros', { entropy: e });
  if (entropy >= 7.5) return T('verdict.random', { entropy: e });
  return T('verdict.unknown', { entropy: e });
}
