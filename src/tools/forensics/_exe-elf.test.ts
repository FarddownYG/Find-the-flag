import { describe, expect, it } from 'vitest';
import { parseElf } from './_exe-elf';
import { buildElf, buildSampleElf } from './_exe-fixtures';
import { readerOf } from './_exe-test-kit';

/**
 * Expected values come from GNU readelf 2.42 (`readelf -h -l -S -s -d -n -r -W`) run on the very
 * bytes these builders write; scratch comparisons of every field against readelf and llvm-readobj
 * (and, for real programs, against compiled binaries) are described in the commit message.
 */
const elf = async (bytes: Uint8Array) => parseElf(readerOf(bytes));
const sec = (i: Awaited<ReturnType<typeof elf>>, state: string) =>
  i.security.find((s) => s.id === state);
const utf8 = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

describe('ELF64 sample (readelf -a)', () => {
  it('reads the header, segments and sections', async () => {
    const i = await elf(buildSampleElf());
    const h = i.header!;
    expect([h.bits, h.le, h.type, h.machine, h.entry]).toEqual([64, true, 3, 62, 0x360n]);
    expect([h.phoff, h.phnum, h.shoff, h.shnum, h.shstrndx]).toEqual([64, 7, 1720, 16, 15]);
    expect(i.segments.map((s) => `${s.typeName}:${s.flags}`)).toEqual([
      'INTERP:4',
      'LOAD:5',
      'LOAD:6',
      'DYNAMIC:6',
      'NOTE:4',
      'GNU_STACK:6',
      'GNU_RELRO:4',
    ]);
    expect(i.sections.map((s) => s.name)).toEqual([
      '',
      '.interp',
      '.note.gnu.build-id',
      '.note.ABI-tag',
      '.note.gnu.property',
      '.dynsym',
      '.dynstr',
      '.rela.plt',
      '.text',
      '.rodata',
      '.dynamic',
      '.data',
      '.comment',
      '.symtab',
      '.strtab',
      '.shstrtab',
    ]);
    const rodata = i.sections.find((s) => s.name === '.rodata')!;
    expect([rodata.addr, rodata.offset, rodata.size, rodata.flags, rodata.type]).toEqual([
      0x370n,
      0x370,
      0x25,
      'A',
      'PROGBITS',
    ]);
    const text = i.sections.find((s) => s.name === '.text')!;
    expect([text.flags, text.exec, text.entropy! > 0]).toEqual(['AX', true, true]);
  });

  it('reads interpreter, libraries, symbols, notes and relocations', async () => {
    const i = await elf(buildSampleElf());
    expect(i.interp).toBe('/lib64/ld-linux-x86-64.so.2');
    expect(i.needed).toEqual(['libc.so.6']);
    expect(i.flags1).toEqual(['PIE']);
    const fn = i.symbols.find((s) => s.name === 'ftf_flag_function')!;
    expect([fn.table, fn.value, fn.size, fn.kind, fn.bind, fn.section]).toEqual([
      'symtab',
      0x363n,
      6,
      'FUNC',
      'GLOBAL',
      '.text',
    ]);
    const imported = i.symbols
      .filter((s) => s.table === 'dynsym' && s.undefined)
      .map((s) => s.name);
    expect(imported).toEqual(['puts', '__printf_chk', '__stack_chk_fail', '__libc_start_main']);
    expect(i.notes.map((n) => [n.typeName, n.value])).toEqual([
      ['NT_GNU_BUILD_ID', '031425364758697a8b9cadbecfe0f10213243546'],
      ['NT_GNU_ABI_TAG', 'Linux 3.2.0'],
      ['NT_GNU_PROPERTY_TYPE_0', 'x86 IBT, x86 SHSTK'],
    ]);
    expect(i.relocs).toEqual([{ section: '.rela.plt', count: 4 }]);
    expect(i.comment).toEqual(['GCC: (FTF sample) 12.2.0']);
    expect(i.trailing).toBeNull();
  });

  it('computes the checksec-style properties', async () => {
    const i = await elf(buildSampleElf());
    expect(i.security.map((s) => `${s.id}=${s.state}`)).toEqual([
      'nx=enabled',
      'pie=enabled',
      'relro=partial',
      'canary=enabled',
      'fortify=enabled',
      'ibt=enabled',
      'shstk=enabled',
    ]);
    expect(sec(i, 'fortify')!.detail).toContain('__printf_chk');
    expect(sec(i, 'nx')!.detail).toBe('PT_GNU_STACK RW-');
  });
});

describe('ELF protections', () => {
  it('Full RELRO needs BIND_NOW as well', async () => {
    const i = await elf(buildElf({ relro: true, bindNow: true }));
    expect(sec(i, 'relro')!.state).toBe('full');
    expect(i.bindNow).toBe(true);
    expect(i.flags).toEqual(['BIND_NOW']);
    expect(i.flags1).toEqual(['NOW', 'PIE']);
  });

  it('no RELRO, executable stack and no canary or fortify', async () => {
    const i = await elf(buildElf({ type: 'EXEC', stack: 'rwx', imports: ['gets', 'puts'] }));
    expect(sec(i, 'relro')!.state).toBe('disabled');
    expect(sec(i, 'nx')!.state).toBe('disabled');
    expect(sec(i, 'nx')!.detail).toBe('PT_GNU_STACK RWE');
    expect(sec(i, 'pie')!.state).toBe('disabled');
    expect(sec(i, 'canary')!.state).toBe('disabled');
    expect(sec(i, 'fortify')!.state).toBe('disabled');
    expect(i.hints.map((h) => h.key)).toContain('execStack');
  });

  it('a missing PT_GNU_STACK means an executable stack on x86 only', async () => {
    const x86 = await elf(buildElf({ stack: 'none' }));
    expect(sec(x86, 'nx')).toMatchObject({ state: 'disabled', detail: 'no PT_GNU_STACK' });
    const arm = await elf(buildElf({ stack: 'none', machine: 183 }));
    expect(sec(arm, 'nx')!.state).toBe('unknown');
  });

  it('RPATH and RUNPATH are reported', async () => {
    const i = await elf(buildElf({ rpath: '/opt/ftf/lib', runpath: '$ORIGIN/../lib' }));
    expect([i.rpath, i.runpath]).toEqual(['/opt/ftf/lib', '$ORIGIN/../lib']);
    expect(sec(i, 'rpath')!.detail).toBe('/opt/ftf/lib');
    expect(sec(i, 'runpath')!.detail).toBe('$ORIGIN/../lib');
    expect(i.hints.map((h) => h.key)).toContain('rpath');
  });

  it('a shared object is not a PIE executable', async () => {
    const i = await elf(
      buildElf({
        interp: null,
        dynamic: true,
        soname: 'libftf.so.1',
        exports: ['ftf_exported'],
        needed: ['libc.so.6', 'libm.so.6'],
      }),
    );
    expect(sec(i, 'pie')).toMatchObject({ state: 'info' });
    expect(i.needed).toEqual(['libc.so.6', 'libm.so.6']);
    expect(i.soname).toBe('libftf.so.1');
    const exp = i.symbols.find((s) => s.name === 'ftf_exported')!;
    expect([exp.table, exp.value, exp.size, exp.section]).toEqual(['dynsym', 0x283n, 6, '.text']);
  });

  it('ARM64 has BTI and PAC properties, x86 has CET', async () => {
    const arm = await elf(buildElf({ machine: 183, interp: '/lib/ld-linux-aarch64.so.1' }));
    expect(arm.security.map((s) => s.id)).toContain('bti');
    expect(arm.security.map((s) => s.id)).not.toContain('ibt');
    const x86 = await elf(buildElf({ cet: true }));
    expect(sec(x86, 'ibt')!.state).toBe('enabled');
    const plain = await elf(buildElf({}));
    expect(sec(plain, 'ibt')!.state).toBe('disabled');
  });
});

describe('ELF layouts', () => {
  it('ELF32 big-endian MIPS (readelf: ELF32, big endian, MIPS R3000, entry 0x1a0)', async () => {
    const i = await elf(
      buildElf({
        bits: 32,
        big: true,
        machine: 8,
        interp: '/lib/ld.so.1',
        imports: ['printf'],
        runpath: '$ORIGIN/lib',
        soname: 'libftf.so',
      }),
    );
    const h = i.header!;
    expect([h.bits, h.le, h.machine, h.entry, h.phnum, h.shnum]).toEqual([
      32,
      false,
      8,
      0x1a0n,
      6,
      15,
    ]);
    expect(i.needed).toEqual(['libc.so.6']);
    expect(i.soname).toBe('libftf.so');
    expect(i.runpath).toBe('$ORIGIN/lib');
    const names = i.symbols
      .filter((s) => s.table === 'symtab')
      .map((s) => `${s.index}:${s.name}:${s.value}`);
    expect(names).toContain('4:ftf_flag_function:419');
    expect(i.symbols.find((s) => s.name === 'ftf_flag_data')).toMatchObject({
      value: 0x1b0n,
      size: 16,
      kind: 'OBJECT',
      section: '.rodata',
    });
  });

  it('ELF32 little-endian x86 and a 64-bit big-endian PowerPC', async () => {
    const a = await elf(buildElf({ bits: 32, imports: ['puts'] }));
    expect([a.header!.bits, a.header!.le, a.header!.machine]).toEqual([32, true, 3]);
    expect(a.symbols.some((s) => s.name === 'puts' && s.undefined)).toBe(true);
    const b = await elf(buildElf({ bits: 64, big: true, machine: 21, imports: ['puts'] }));
    expect([b.header!.bits, b.header!.le, b.header!.machine]).toEqual([64, false, 21]);
    const text = b.sections.find((s) => s.name === '.text')!;
    expect(b.symbols.find((s) => s.name === 'ftf_flag_function')!.value).toBe(text.addr + 3n);
  });

  it('a statically linked binary has no interpreter and no dynamic section', async () => {
    const i = await elf(buildElf({ interp: null, dynamic: false, type: 'EXEC', stack: 'none' }));
    expect(i.interp).toBeNull();
    expect(i.dynamic).toEqual([]);
    expect(i.hints.map((h) => h.key)).toContain('staticLinked');
    expect(i.sections.map((s) => s.name)).toEqual([
      '',
      '.text',
      '.rodata',
      '.data',
      '.comment',
      '.symtab',
      '.strtab',
      '.shstrtab',
    ]);
  });

  it('a stripped binary keeps only dynamic symbols', async () => {
    const i = await elf(buildElf({ symtab: false }));
    expect(i.hasSymtab).toBe(false);
    expect(i.hasDynsym).toBe(true);
    expect(i.symbols.every((s) => s.table === 'dynsym')).toBe(true);
    expect(i.hints.map((h) => h.key)).toContain('stripped');
  });

  it('without section headers the dynamic section still gives libraries and symbols', async () => {
    const i = await elf(buildElf({ sections: false }));
    expect(i.sections).toEqual([]);
    expect(i.needed).toEqual(['libc.so.6']);
    expect(i.symbols.map((s) => s.name).filter(Boolean)).toEqual(['puts', '__libc_start_main']);
    expect(i.hints.map((h) => h.key)).toContain('noSections');
    expect(i.relocs.map((r) => r.section)).toEqual([]);
  });

  it('reports data appended after the end of the ELF structure', async () => {
    const plain = buildElf({});
    const i = await elf(buildElf({ trailing: utf8('FTF{appended}\n') }));
    expect(i.trailing).toMatchObject({ offset: plain.length, size: 14, text: 'FTF{appended}' });
    expect((await elf(plain)).trailing).toBeNull();
  });

  it('flags the UPX marker and the packed-binary signs', async () => {
    const i = await elf(buildElf({ upx: true }));
    expect(i.upx).toBe(true);
    expect(i.packed.map((p) => p.key)).toContain('packedUpx');
    expect((await elf(buildElf({}))).packed).toEqual([]);
  });
});

describe('ELF robustness', () => {
  it('survives a header cut short', async () => {
    const i = await elf(buildSampleElf().subarray(0, 20));
    expect(i.header).toBeNull();
    expect(i.hints.map((h) => h.key)).toEqual(['truncatedHeader']);
  });

  it('lists the program headers that are there when the table is cut', async () => {
    const full = buildSampleElf();
    const i = await elf(full.subarray(0, 64 + 56 * 3 + 10));
    expect(i.segments).toHaveLength(3);
    expect(i.hints.map((h) => h.key)).toContain('tableTruncated');
  });

  it('survives absurd counts and offsets', async () => {
    const bytes = buildSampleElf().slice();
    const dv = new DataView(bytes.buffer);
    dv.setUint16(56, 0xffff, true); // e_phnum
    dv.setUint16(60, 0xffff, true); // e_shnum
    dv.setBigUint64(40, 0xffffffffffffn, true); // e_shoff far outside the file
    const i = await elf(bytes);
    expect(i.header).not.toBeNull();
    expect(i.sections).toEqual([]);
    expect(i.segments.length).toBeLessThanOrEqual(0xffff);
    expect(i.hints.map((h) => h.key)).toContain('tableOutside');
  });

  it('copes with a section that points past the end of the file', async () => {
    const bytes = buildSampleElf().slice();
    const dv = new DataView(bytes.buffer);
    const shoff = Number(dv.getBigUint64(40, true));
    // .rodata is section 9: set sh_size (offset 32 in the 64-byte header) to 1 GiB
    dv.setBigUint64(shoff + 9 * 64 + 32, 1n << 30n, true);
    const i = await elf(bytes);
    const rodata = i.sections.find((s) => s.name === '.rodata')!;
    expect(rodata.outside).toBe(true);
    expect(rodata.entropy).toBeNull();
    expect(i.hints.map((h) => h.key)).toContain('sectionsBeyondFile');
  });

  it('survives a program header table that loops through the dynamic section', async () => {
    const bytes = buildSampleElf().slice();
    const dv = new DataView(bytes.buffer);
    // DT_NEEDED with a string offset beyond .dynstr, and a huge DT_STRSZ
    const dynOff = 0x3a0;
    dv.setBigUint64(dynOff + 8, 0xfffffn, true);
    const i = await elf(bytes);
    expect(i.needed).toEqual(['']);
  });
});
