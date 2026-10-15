import { describe, expect, it } from 'vitest';
import { buildFat, buildMacho } from './_exe-fixtures';
import { machoMagic, parseMacho } from './_exe-macho';
import { readerOf } from './_exe-test-kit';

/**
 * Expected values come from llvm-readobj 18 (`--file-headers --macho-segment --symbols`) and
 * `llvm-objdump --macho --private-headers` run on the very bytes the builder writes.
 */
const macho = async (bytes: Uint8Array) => parseMacho(readerOf(bytes));

describe('Mach-O 64-bit sample (llvm-readobj)', () => {
  it('reads the header and the load commands', async () => {
    const i = await macho(buildMacho());
    expect(i.header).toMatchObject({
      bits: 64,
      le: true,
      cpu: 0x01000007,
      cpuName: 'x86-64',
      fileType: 2,
      fileTypeName: 'EXECUTE',
      ncmds: 10,
      sizeofcmds: 712,
      flags: 0x200085,
    });
    expect(i.header!.flagNames).toEqual(['NOUNDEFS', 'DYLDLINK', 'TWOLEVEL', 'PIE']);
    expect(i.commands.map((c) => c.name)).toEqual([
      'LC_SEGMENT_64',
      'LC_SEGMENT_64',
      'LC_SEGMENT_64',
      'LC_SEGMENT_64',
      'LC_SYMTAB',
      'LC_LOAD_DYLINKER',
      'LC_UUID',
      'LC_BUILD_VERSION',
      'LC_MAIN',
      'LC_LOAD_DYLIB',
    ]);
    expect(i.uuid).toBe('A0A1A2A3-A4A5-A6A7-A8A9-AAABACADAEAF');
    expect(i.entryOffset).toBe(0x2f0n);
    expect(i.dylinker).toBe('/usr/lib/dyld');
    expect(i.dylibs).toEqual([
      { kind: 'load', name: '/usr/lib/libSystem.B.dylib', version: '1.0.0' },
    ]);
    expect(i.build).toBe('macOS 11.0.0 (SDK 12.0.0)');
  });

  it('reads segments and sections', async () => {
    const i = await macho(buildMacho());
    expect(i.segments.map((s) => [s.name, s.vmaddr, s.initprot, s.sections])).toEqual([
      ['__PAGEZERO', 0n, '---', 0],
      ['__TEXT', 0x100000000n, 'r-x', 2],
      ['__DATA', 0x100001000n, 'rw-', 1],
      ['__LINKEDIT', 0x100002000n, 'r--', 0],
    ]);
    expect(i.sections.map((s) => [s.name, s.type, s.addr, s.offset, s.size])).toEqual([
      ['__text', '__TEXT', 0x1000002f0n, 752, 3],
      ['__cstring', '__TEXT', 0x1000002f3n, 755, 19],
      ['__data', '__DATA', 0x100001000n, 784, 9],
    ]);
  });

  it('reads the symbol table', async () => {
    const i = await macho(buildMacho());
    expect(i.symbols.map((s) => [s.name, s.kind, s.bind, s.section, s.undefined])).toEqual([
      ['_main', 'SECT', 'EXT', '__text', false],
      ['_puts', 'UNDF', 'EXT', 'UND', true],
      ['___stack_chk_fail', 'UNDF', 'EXT', 'UND', true],
    ]);
    expect(i.symbols[0]!.value).toBe(0x1000002f0n);
  });

  it('computes PIE, stack and signature properties', async () => {
    const plain = await macho(buildMacho());
    expect(plain.security.map((s) => `${s.id}=${s.state}`)).toEqual([
      'pie=enabled',
      'nx=enabled',
      'nxHeap=disabled',
      'canary=enabled',
      'codeSignature=disabled',
    ]);
    const weak = await macho(
      buildMacho({ pie: false, stackExec: true, signature: true, imports: ['_puts'] }),
    );
    expect(weak.security.map((s) => `${s.id}=${s.state}`)).toEqual([
      'pie=disabled',
      'nx=disabled',
      'nxHeap=disabled',
      'canary=disabled',
      'codeSignature=enabled',
    ]);
    expect(weak.codeSignature!.size).toBe(16);
  });

  it('an encrypted segment is flagged', async () => {
    const i = await macho(buildMacho({ encrypted: true }));
    expect(i.encrypted).toBe(true);
    expect(i.hints.map((h) => h.key)).toContain('encrypted');
  });
});

describe('Mach-O universal binary and damage', () => {
  it('lists the slices and reads the first', async () => {
    const fat = buildFat([
      { cpu: 0x01000007, data: buildMacho() },
      { cpu: 0x0100000c, data: buildMacho({ cpu: 0x0100000c }) },
    ]);
    expect(machoMagic(fat)).toBe('fat');
    const i = await macho(fat);
    expect(i.fat!.map((a) => [a.cpu, a.offset])).toEqual([
      ['x86-64', 0x1000],
      ['ARM64', 0x2000],
    ]);
    expect(i.header!.cpuName).toBe('x86-64');
    expect(i.sliceOffset).toBe(0x1000);
    expect(i.sections[0]!.offset).toBe(0x1000 + 752);
    expect(i.hints.map((h) => h.key)).toContain('fatBinary');
  });

  it('a Java class file is not a fat binary', () => {
    // CAFEBABE 0000 0034: minor 0, major 52 -> "number of architectures" 0x340000
    expect(machoMagic(Uint8Array.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 0x34, 0, 0]))).toBeNull();
  });

  it('load commands cut short', async () => {
    const full = buildMacho();
    const i = await macho(full.subarray(0, 32 + 300));
    expect(i.hints.map((h) => h.key)).toContain('machoLoadTruncated');
    expect(i.commands.length).toBeLessThan(10);
  });

  it('absurd command sizes and counts stop quickly', async () => {
    const bytes = buildMacho().slice();
    const dv = new DataView(bytes.buffer);
    dv.setUint32(16, 0xffffffff, true); // ncmds
    dv.setUint32(32 + 4, 0xfffffff0, true); // first command size
    const i = await macho(bytes);
    expect(i.commands).toEqual([]);
    expect(i.hints.map((h) => h.key)).toContain('machoLoadTruncated');
  });

  it('a bad magic', async () => {
    const i = await macho(
      Uint8Array.from([
        0xde, 0xad, 0xbe, 0xef, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0,
      ]),
    );
    expect(i.header).toBeNull();
  });
});
