import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors';
import { defaultOptions } from '../../core/registry';
import type { AnyTool, ToolResult } from '../../core/types';
import {
  buildElf,
  buildFat,
  buildMacho,
  buildPe,
  buildSampleElf,
  buildSamplePe,
} from './_exe-fixtures';
import {
  fileBytes,
  fileOf,
  filesOf,
  flat,
  kvs,
  notes,
  run,
  table,
  tables,
  tool,
} from './_exe-test-kit';
import fileType from './file-type';

const sample = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../../../public/samples/${name}`, import.meta.url)));
const enc = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const rowsOf = (r: ToolResult, label: string) => table(r, label).rows;

/** The names of the {placeholders} in the translations: none may be left in a result. */
const PLACEHOLDER =
  /\{(size|count|bits|offset|shown|total|imports|exports|dlls|functions|key|check|name|section|packer|reasons?|entropy|sections|path|what|table|archs|tool|carve|binary|strings|hexdump|min|names|regions|flagged|filter|message|fileType|magic)\}/;

const VIEWS = ['overview', 'sections', 'details', 'symbols', 'imports', 'resources', 'strings'];

describe('the samples are reproducible', () => {
  it('scripts/gen-samples-exe.mjs writes exactly the committed bytes', () => {
    expect(Buffer.from(sample('exe-sample.elf')).equals(Buffer.from(buildSampleElf()))).toBe(true);
    expect(Buffer.from(sample('exe-sample.exe')).equals(Buffer.from(buildSamplePe()))).toBe(true);
    expect(Buffer.from(sample('exe-sample.macho')).equals(Buffer.from(buildMacho()))).toBe(true);
  });

  it('are small', () => {
    for (const n of ['exe-sample.elf', 'exe-sample.exe', 'exe-sample.macho']) {
      expect(sample(n).length).toBeLessThan(8192);
    }
  });
});

describe('ELF views', () => {
  it('overview: identification, protections, sections', async () => {
    const r = await run(sample('exe-sample.elf'));
    const k = kvs(r);
    expect(k.get('Format')).toBe('ELF');
    expect(k.get('Class')).toBe('64-bit');
    expect(k.get('Byte order')).toBe('Little-endian');
    expect(k.get('Machine')).toBe('x86-64 (AMD64) (0x3e)');
    expect(k.get('Type')).toBe('DYN - shared object or PIE executable');
    expect(k.get('Entry point')).toBe('0x360 (.text)');
    expect(k.get('Interpreter')).toBe('/lib64/ld-linux-x86-64.so.2');
    expect(k.get('Symbols')).toBe('Not stripped (symbols: 9)');
    expect(k.get('Build ID')).toBe('031425364758697a8b9cadbecfe0f10213243546');
    const prot = new Map(rowsOf(r, 'Protections').map((x) => [x[0], `${x[1]} ${x[2]}`.trim()]));
    expect(prot.get('NX stack (non-executable)')).toBe('Yes PT_GNU_STACK RW-');
    expect(prot.get('PIE (position-independent)')).toBe('Yes ET_DYN');
    expect(prot.get('RELRO')).toBe('Partial PT_GNU_RELRO');
    expect(prot.get('Stack canary')).toContain('Yes __stack_chk_fail');
    expect(prot.get('FORTIFY_SOURCE')).toContain('__printf_chk');
    const sections = rowsOf(r, 'Sections');
    expect(sections.map((x) => x[0])).toContain('.rodata');
    expect(sections.find((x) => x[0] === '.text')![5]).toMatch(/^\d\.\d\d$/);
  });

  it('segments and sections with entropy, and a section as a file', async () => {
    const r = await run(sample('exe-sample.elf'), { view: 'sections', section: '.rodata' });
    const segs = rowsOf(r, 'Segments');
    expect(segs.map((x) => `${x[0]} ${x[1]}`)).toContain('GNU_STACK RW-');
    expect(segs.map((x) => `${x[0]} ${x[1]}`)).toContain('GNU_RELRO R--');
    const secs = rowsOf(r, 'Sections');
    expect(secs.every((x) => x[1] === '' || x[7] !== '-')).toBe(true);
    const files = filesOf(r);
    expect(files).toHaveLength(1);
    expect(files[0]!.name).toBe('rodata.bin');
    const dump = await fileBytes(files[0]!);
    expect(new TextDecoder().decode(dump)).toBe('FTF{elf_rodata}\0usage: sample [name]\0');
  });

  it('a section that does not exist is said so', async () => {
    const r = await run(sample('exe-sample.elf'), { view: 'sections', section: '.nope' });
    expect(notes(r).join(' ')).toContain('No section named .nope');
    expect(filesOf(r)).toEqual([]);
    const byIndex = await run(sample('exe-sample.elf'), { view: 'sections', section: '#9' });
    expect(filesOf(byIndex)[0]!.name).toBe('rodata.bin');
  });

  it('symbols: filter by text and by regex, with the table each symbol comes from', async () => {
    const all = await run(sample('exe-sample.elf'), { view: 'symbols' });
    expect(rowsOf(all, 'Symbols').length).toBe(13);
    const one = await run(sample('exe-sample.elf'), { view: 'symbols', filter: 'FTF_FLAG' });
    expect(rowsOf(one, 'Symbols').map((x) => x[0])).toEqual(['ftf_flag_function', 'ftf_flag_data']);
    const re = await run(sample('exe-sample.elf'), { view: 'symbols', filter: '/^__\\w+_chk$/' });
    expect(rowsOf(re, 'Symbols').map((x) => [x[7], x[0]])).toEqual([
      ['.dynsym', '__printf_chk'],
      ['.symtab', '__printf_chk'],
    ]);
    const function_ = rowsOf(one, 'Symbols')[0]!;
    expect(function_.slice(0, 9)).toEqual([
      'ftf_flag_function',
      '0x363',
      6,
      'FUNC',
      'GLOBAL',
      '.text',
      '',
      '.symtab',
      4,
    ]);
  });

  it('symbols: C++ names are demangled, and the mangled name stays searchable', async () => {
    const elf = buildElf({
      exports: ['_ZN3Foo3barEi', '_ZNSt6vectorIiSaIiEE9push_backERKi', 'plain_c'],
    });
    const on = await run(elf, { view: 'symbols', filter: 'Foo::bar' });
    expect(rowsOf(on, 'Symbols').map((x) => [x[7], x[0], x[9]])).toEqual([
      ['.dynsym', 'Foo::bar(int)', '_ZN3Foo3barEi'],
    ]);
    const byMangled = await run(elf, { view: 'symbols', filter: '_ZN3Foo' });
    expect(rowsOf(byMangled, 'Symbols')).toHaveLength(1);
    const off = await run(elf, { view: 'symbols', filter: 'push_back', demangle: false });
    expect(rowsOf(off, 'Symbols').map((x) => x[0])).toEqual(['_ZNSt6vectorIiSaIiEE9push_backERKi']);
    const vec = await run(elf, { view: 'symbols', filter: 'push_back' });
    expect(rowsOf(vec, 'Symbols')[0]![0]).toBe(
      'std::vector<int, std::allocator<int> >::push_back(int const&)',
    );
  });

  it('imports: libraries and the functions the loader must find', async () => {
    const r = await run(sample('exe-sample.elf'), { view: 'imports' });
    expect(kvs(r).get('1')).toBe('libc.so.6');
    expect(rowsOf(r, 'Imported symbols').map((x) => x[0])).toEqual([
      'puts',
      '__printf_chk',
      '__stack_chk_fail',
      '__libc_start_main',
    ]);
  });

  it('details: header fields, dynamic section, notes, relocations', async () => {
    const r = await run(sample('exe-sample.elf'), { view: 'details' });
    expect(kvs(r).get('Section headers')).toBe('1720 (16 x 64 bytes, strings at 15)');
    expect(rowsOf(r, 'Dynamic section').map((x) => x[0])).toEqual([
      'NEEDED',
      'STRTAB',
      'SYMTAB',
      'STRSZ',
      'SYMENT',
      'FLAGS_1',
    ]);
    expect(rowsOf(r, 'Notes').map((x) => x[2])).toEqual([
      'NT_GNU_BUILD_ID',
      'NT_GNU_ABI_TAG',
      'NT_GNU_PROPERTY_TYPE_0',
    ]);
    expect(rowsOf(r, 'Relocations')).toEqual([['.rela.plt', 4]]);
  });

  it('strings: by section, flag-like first, filter, and the code option', async () => {
    const r = await run(sample('exe-sample.elf'), { view: 'strings' });
    const t = tables(r)[0]!;
    expect(t.rows[0]).toEqual(['.rodata', '0x370', 'ascii', 'FTF{elf_rodata}']);
    expect(t.highlight).toEqual([0]);
    const only = await run(sample('exe-sample.elf'), { view: 'strings', section: '.comment' });
    expect(tables(only)[0]!.rows.map((x) => x[3])).toEqual(['GCC: (FTF sample) 12.2.0']);
    const filtered = await run(sample('exe-sample.elf'), { view: 'strings', filter: '/^usage/' });
    expect(tables(filtered)[0]!.rows).toHaveLength(1);
    const none = await run(sample('exe-sample.elf'), { view: 'strings', filter: 'zzzz' });
    expect(notes(none)[0]).toBe('No string matches the filter.');
    // the code of .text is skipped unless asked for: 9 bytes hold no string either way
    const code = await run(sample('exe-sample.elf'), { view: 'strings', code: true, min: 2 });
    expect(code.length).toBeGreaterThan(0);
  });

  it('a bad regular expression is a ToolError', async () => {
    await expect(
      run(sample('exe-sample.elf'), { view: 'strings', filter: '/(/' }),
    ).rejects.toBeInstanceOf(ToolError);
  });

  it('data after the ELF is offered as a file', async () => {
    const r = await run(buildElf({ trailing: enc('FTF{appended}\n') }));
    expect(kvs(r).get('Text')).toBe('FTF{appended}');
    const f = filesOf(r)[0]!;
    expect(f.name).toBe('appended.bin');
    expect(new TextDecoder().decode(await fileBytes(f))).toBe('FTF{appended}\n');
  });

  it('a section-less binary says so and still lists segments and strings', async () => {
    const elf = buildElf({ sections: false });
    expect(notes(await run(elf)).join(' ')).toContain('No section headers');
    const s = await run(elf, { view: 'strings' });
    expect(flat(s)).toContain('FTF{elf_rodata}');
  });
});

describe('PE views', () => {
  it('overview: identification, protections, sections, contents', async () => {
    const r = await run(sample('exe-sample.exe'));
    const k = kvs(r);
    expect(k.get('Format')).toBe('PE32');
    expect(k.get('Type')).toBe('Executable');
    expect(k.get('Machine')).toBe('x86 (Intel 386) (0x014c)');
    expect(k.get('Subsystem')).toBe('Windows console (3)');
    expect(k.get('Entry point')).toBe('0x1000 (RVA, .text)');
    expect(k.get('Timestamp')).toBe('2024-01-15 09:19:36 UTC (0x65a4f8a8)');
    expect(k.get('PDB path')).toBe('C:\\build\\ftf\\sample.pdb');
    expect(k.get('Imports')).toBe('DLLs: 2, functions: 3');
    expect(k.get('Rich header')).toBe('present, checksum OK, entries: 3');
    const prot = new Map(rowsOf(r, 'Protections').map((x) => [x[0], `${x[1]} ${x[2]}`.trim()]));
    expect(prot.get('ASLR (random load address)')).toBe('Yes DYNAMIC_BASE');
    expect(prot.get('DEP / NX')).toBe('Yes NX_COMPAT');
    expect(prot.get('Control Flow Guard (CFG)')).toBe('No GUARD_CF');
    expect(rowsOf(r, 'Sections').map((x) => x[0])).toEqual(['.text', '.rdata', '.rsrc', '.reloc']);
  });

  it('the overlay: where, what it looks like, and the download', async () => {
    const r = await run(sample('exe-sample.exe'));
    const k = kvs(r);
    expect(k.get('Offset')).toBe('0x1600');
    expect(k.get('Looks like')).toBe('Text');
    expect(k.get('Text')).toBe('FTF{overlay}');
    const f = filesOf(r).find((x) => x.name === 'overlay.bin')!;
    expect(new TextDecoder().decode(await fileBytes(f))).toBe('FTF{overlay}\n');
    // cross-links to the other tools, by their names
    const hint = notes(r).find((n) => n.includes('Carve embedded files'))!;
    expect(hint).toContain('Entropy');
    expect(hint).toContain('Binary analyzer');
  });

  it('an overlay that is another file is named after its signature', async () => {
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52,
    ]);
    const r = await run(buildPe({ overlay: png }));
    expect(kvs(r).get('Looks like')).toBe('PNG image');
  });

  it('sections: all columns with entropy, and a section as a file', async () => {
    const r = await run(sample('exe-sample.exe'), { view: 'sections', section: '.rdata' });
    const rows = rowsOf(r, 'Sections');
    expect(rows[1]!.slice(0, 8)).toEqual([
      1,
      '.rdata',
      '0x2000',
      '0xf0',
      '0x600',
      '0x200',
      'R--',
      '2.15',
    ]);
    expect(rows[1]![8]).toBe('INITIALIZED_DATA');
    expect(rows.every((x) => x[7] !== '-')).toBe(true);
    const f = filesOf(r)[0]!;
    expect(f.name).toBe('rdata.bin');
    expect((await fileBytes(f)).length).toBe(0x200);
  });

  it('imports: DLLs, functions, ordinals, filter', async () => {
    const r = await run(sample('exe-sample.exe'), { view: 'imports' });
    expect(rowsOf(r, 'Imported DLLs')).toEqual([
      ['kernel32.dll', 2, 'normal'],
      ['ws2_32.dll', 1, 'normal'],
    ]);
    expect(rowsOf(r, 'Imported functions').map((x) => x.slice(0, 4))).toEqual([
      ['kernel32.dll', 'ExitProcess', '', 1],
      ['kernel32.dll', 'GetProcAddress', '', 2],
      ['ws2_32.dll', '#115', 115, ''],
    ]);
    const f = await run(sample('exe-sample.exe'), { view: 'imports', filter: 'proc' });
    expect(rowsOf(f, 'Imported functions').map((x) => x[1])).toEqual([
      'ExitProcess',
      'GetProcAddress',
    ]);
  });

  it('exports of a DLL, with a forwarder', async () => {
    const dll = buildPe({
      plus: true,
      dll: true,
      exports: {
        dllName: 'ftf.dll',
        names: ['FtfInit', 'Fwd'],
        forwarders: { Fwd: 'KERNEL32.ExitProcess' },
      },
    });
    const r = await run(dll, { view: 'symbols' });
    expect(kvs(r).get('Name')).toBe('ftf.dll');
    expect(rowsOf(r, 'Exports').map((x) => [x[0], x[2], x[3]])).toEqual([
      [1, 'FtfInit', ''],
      [2, 'Fwd', 'KERNEL32.ExitProcess'],
    ]);
    const filtered = await run(dll, { view: 'symbols', filter: 'init' });
    expect(rowsOf(filtered, 'Exports')).toHaveLength(1);
  });

  it('resources: tree with previews, manifest, version info, string tables, files', async () => {
    const r = await run(sample('exe-sample.exe'), { view: 'resources' });
    const rows = rowsOf(r, 'Resources');
    expect(rows.map((x) => `${x[0]}/${x[1]}`)).toEqual([
      'RT_ICON/1',
      'RT_RCDATA/101',
      'RT_GROUP_ICON/MAINICON',
      'RT_VERSION/1',
      'RT_MANIFEST/1',
    ]);
    expect(rows[1]).toEqual(['RT_RCDATA', '101', '1033 (en-US)', 16, '0xdf4', 'FTF{pe_resource}']);
    expect(flat(r)).toContain('requestedExecutionLevel level="asInvoker"');
    const v = kvs(r);
    expect(v.get('File version')).toBe('1.2.3.4');
    expect(v.get('CompanyName')).toBe('Find The Flag samples');
    expect(v.get('OriginalFilename')).toBe('sample.exe');
    expect(v.get('Translation')).toBe('040904b0');
    const files = filesOf(r);
    expect(files.map((f) => f.name)).toEqual(['icon_MAINICON.ico', 'RT_RCDATA_101_1033.txt']);
    expect(new TextDecoder().decode(await fileBytes(files[1]!))).toBe('FTF{pe_resource}');
    const ico = await fileBytes(files[0]!);
    expect(Array.from(ico.subarray(0, 6))).toEqual([0, 0, 1, 0, 1, 0]);
    expect(ico.length).toBe(6 + 16 + 1128);
  });

  it('resources: a named custom type and an unknown payload are extracted by signature', async () => {
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 20, 0, 0, 0, 0, 0]);
    const r = await run(
      buildPe({
        resources: [
          { type: 'PAYLOAD', names: [{ name: 'STAGE2', leaves: [{ lang: 0, data: zip }] }] },
          {
            type: 10,
            names: [{ name: 7, leaves: [{ lang: 0x40c, data: enc('mot de passe: SECRET42') }] }],
          },
          {
            type: 6,
            names: [
              {
                name: 1,
                leaves: [
                  {
                    lang: 0x409,
                    data: Uint8Array.from([0, 0, 5, 0, 104, 0, 101, 0, 108, 0, 108, 0, 111, 0]),
                  },
                ],
              },
            ],
          },
        ],
      }),
      { view: 'resources' },
    );
    const files = filesOf(r);
    expect(files.map((f) => f.name)).toContain('PAYLOAD_STAGE2.zip');
    expect(files.map((f) => f.name)).toContain('RT_RCDATA_7_1036.txt');
    expect(rowsOf(r, 'Resources').find((x) => x[0] === 'RT_RCDATA')![2]).toBe('1036 (fr-FR)');
    expect(flat(r)).toContain('1: hello');
  });

  it('details: Rich header, debug directory, data directories', async () => {
    const r = await run(sample('exe-sample.exe'), { view: 'details' });
    const rich = table(r, 'Rich header');
    expect(rich.label).toBe('Rich header (key 0x8e43eff7, checksum OK)');
    expect(rich.rows[1]).toEqual(['93 (0x005d)', 30795, 3]);
    expect(rowsOf(r, 'Debug directory')[0]!.slice(0, 1)).toEqual(['CODEVIEW']);
    expect(kvs(r).get('GUID')).toBe('{44332211-6655-8877-99AA-BBCCDDEEFF01}');
    expect(kvs(r).get('Age')).toBe('1');
    expect(rowsOf(r, 'Data directories').map((x) => x[1])).toEqual([
      'Import',
      'Resource',
      'Base relocation',
      'Debug',
    ]);
    expect(kvs(r).get('DLL characteristics')).toBe(
      '0x8140: DYNAMIC_BASE (ASLR), NX_COMPAT (DEP), TERMINAL_SERVER_AWARE',
    );
  });

  it('a forged Rich header is reported', async () => {
    const bytes = buildSamplePe().slice();
    bytes[0x90] = bytes[0x90]! ^ 1;
    const r = await run(bytes);
    expect(notes(r).join(' ')).toContain('Rich header checksum does not match');
    expect(kvs(r).get('Rich header')).toBe('present, checksum does not match');
  });

  it('.NET: a note and the user strings', async () => {
    const r = await run(buildPe({ clr: { userStrings: ['Hello', 'FTF{dotnet_us}'] } }), {
      view: 'details',
    });
    expect(rowsOf(r, '.NET user strings').map((x) => x[1])).toEqual(['Hello', 'FTF{dotnet_us}']);
    const o = await run(buildPe({ clr: { userStrings: ['x'] } }));
    expect(notes(o).join(' ')).toContain('.NET assembly');
    expect(kvs(o).get('Format')).toBe('PE32 (.NET)');
    expect(kvs(o).get('Runtime')).toBe('v4.0.30319 (CLR 2.5)');
  });

  it('packer hints say "looks packed", with the signs', async () => {
    const code = Uint8Array.from(
      { length: 6000 },
      (_, k) => (Math.imul(k, 2654435761) >>> 24) & 255,
    );
    const r = await run(
      buildPe({
        emptySection: 'UPX0',
        sectionNames: { '.text': 'UPX1', '.rdata': 'UPX2' },
        code,
        rich: false,
      }),
    );
    const warn = r.find((o) => o.type === 'note' && o.level === 'warn');
    expect(warn && 'text' in warn ? warn.text : '').toContain('Looks packed or protected');
    const signs = r.find((o) => o.type === 'text' && o.label === 'Signs of packing');
    expect(signs && 'value' in signs ? signs.value : '').toContain('known packer (UPX)');
    expect(flat(r)).toContain('no data on disk but a large size in memory');
    // a normal file raises nothing
    expect(flat(await run(sample('exe-sample.exe')))).not.toContain('packed');
    expect(flat(await run(sample('exe-sample.elf')))).not.toContain('packed');
  });

  it('strings: UTF-16 text and the overlay are searched, flags first', async () => {
    const r = await run(sample('exe-sample.exe'), { view: 'strings' });
    const t = tables(r)[0]!;
    expect(t.rows.slice(0, 2)).toEqual([
      ['.rsrc', '0xdf4', 'ascii', 'FTF{pe_resource}'],
      ['(overlay)', '0x1600', 'ascii', 'FTF{overlay}'],
    ]);
    expect(t.highlight).toEqual([0, 1]);
    expect(t.rows.some((x) => x[2] === 'utf16le' && x[3] === 'VS_VERSION_INFO')).toBe(true);
  });

  it('the Authenticode slot is a note, not the overlay', async () => {
    const r = await run(
      buildPe({ certificate: enc('PKCS7'.padEnd(64, '.')), overlay: enc('tail!') }),
    );
    expect(notes(r).join(' ')).not.toContain('bytes of overlay');
    expect(kvs(r).get('Text')).toBe('tail!');
    expect(flat(r)).toContain('Authenticode signature');
  });
});

describe('Mach-O views', () => {
  it('overview, strings, symbols, imports', async () => {
    const m = sample('exe-sample.macho');
    const o = await run(m);
    expect(kvs(o).get('Format')).toBe('Mach-O 64-bit');
    expect(kvs(o).get('UUID')).toBe('A0A1A2A3-A4A5-A6A7-A8A9-AAABACADAEAF');
    expect(rowsOf(o, 'Sections').map((x) => x[0])).toEqual(['__text', '__cstring', '__data']);
    const full = await run(m, { view: 'sections' });
    expect(rowsOf(full, 'Sections').map((x) => x[1])).toEqual(['__text', '__cstring', '__data']);
    const s = await run(m, { view: 'strings' });
    expect(tables(s)[0]!.rows[0]).toEqual([
      '__TEXT,__cstring',
      '0x2f3',
      'ascii',
      'FTF{macho_cstring}',
    ]);
    const sym = await run(m, { view: 'symbols', filter: 'puts' });
    expect(rowsOf(sym, 'Symbols').map((x) => x[5])).toEqual(['_puts']);
    const imp = await run(m, { view: 'imports' });
    expect(rowsOf(imp, 'Libraries')).toEqual([['load', '/usr/lib/libSystem.B.dylib', '1.0.0']]);
    expect(rowsOf(imp, 'Imported symbols').map((x) => x[0])).toEqual([
      '_puts',
      '___stack_chk_fail',
    ]);
  });

  it('a universal binary names its architectures', async () => {
    const fat = buildFat([
      { cpu: 0x01000007, data: buildMacho() },
      { cpu: 0x0100000c, data: buildMacho({ cpu: 0x0100000c }) },
    ]);
    const r = await run(fat);
    expect(notes(r).join(' ')).toContain('Universal binary (architectures: x86-64, ARM64)');
    const d = await run(fat, { view: 'details' });
    expect(rowsOf(d, 'Architectures').map((x) => [x[1], x[2]])).toEqual([
      ['x86-64', '0x1000'],
      ['ARM64', '0x2000'],
    ]);
  });
});

describe('errors', () => {
  it('an empty file', async () => {
    await expect(run(new Uint8Array(0))).rejects.toThrow('The file is empty.');
  });

  it('something that is not an executable points at the other tools', async () => {
    const err = await run(enc('just some text, nothing to see')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect((err as Error).message).toContain('File type');
    expect((err as Error).message).toContain('Binary analyzer');
  });

  it('resources of an ELF', async () => {
    const r = await run(sample('exe-sample.elf'), { view: 'resources' });
    expect(notes(r)[0]).toContain('ELF files have no resource section');
  });
});

describe('triage', () => {
  const detect = tool.detect!;
  it('recognises the three formats', () => {
    for (const [name, text] of [
      ['exe-sample.elf', 'ELF executable'],
      ['exe-sample.exe', 'Windows PE executable'],
      ['exe-sample.macho', 'Mach-O executable'],
    ] as const) {
      const d = detect({ text: null, bytes: sample(name) });
      expect(d?.reason).toBe(text);
      expect(d!.score).toBeGreaterThanOrEqual(0.9);
    }
  });
  it('ignores the rest, and a Java class file', () => {
    expect(
      detect({ text: 'hello world, this is text', bytes: enc('hello world, this is text') }),
    ).toBeNull();
    const cls = new Uint8Array(64);
    cls.set([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 0x34]);
    expect(detect({ text: null, bytes: cls })).toBeNull();
  });
  it('a bare MZ header scores lower than a real PE', () => {
    const mz = new Uint8Array(64);
    mz.set([0x4d, 0x5a]);
    expect(detect({ text: null, bytes: mz })!.score).toBeLessThan(0.7);
  });
});

describe('File type points at this tool', () => {
  const identify = async (bytes: Uint8Array, name: string) =>
    notes(
      (await fileType.run(
        { bytes, name },
        defaultOptions(fileType as unknown as AnyTool) as never,
      )) as ToolResult,
    );

  it('for an ELF, a PE and a Mach-O file', async () => {
    for (const [name, bytes] of [
      ['exe-sample.elf', sample('exe-sample.elf')],
      ['exe-sample.exe', sample('exe-sample.exe')],
      ['exe-sample.macho', sample('exe-sample.macho')],
    ] as const) {
      const text = (await identify(bytes, name)).join(' ');
      expect(text).toContain('Executable analyzer');
      expect(text).not.toMatch(/\{tool\}/);
    }
  });

  it('and for nothing else', async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
    expect((await identify(png, 'a.png')).join(' ')).not.toContain('Executable analyzer');
  });
});

describe('every view on every sample', () => {
  const files = ['exe-sample.elf', 'exe-sample.exe', 'exe-sample.macho'];
  it('runs and shows no raw translation key or unresolved placeholder', async () => {
    for (const name of files) {
      for (const view of VIEWS) {
        const r = await run(sample(name), { view });
        const text = flat(r);
        expect(text.length).toBeGreaterThan(0);
        expect(text).not.toMatch(/tool\.exe-analyzer\./);
        expect(text).not.toMatch(PLACEHOLDER);
      }
    }
  });
});

/** Seeded pseudo-random numbers: the same damage on every run. */
function rng(seed: number): (n: number) => number {
  let s = seed >>> 0;
  return (n) => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s % n;
  };
}

async function survives(bytes: Uint8Array, views: string[]): Promise<void> {
  for (const view of views) {
    try {
      await run(bytes, { view, filter: '' });
    } catch (e) {
      if (!(e instanceof ToolError)) throw e;
    }
  }
}

describe('robustness: cut and damaged files', () => {
  const named = [
    ['elf', buildSampleElf()],
    [
      'elf32 big-endian',
      buildElf({ bits: 32, big: true, machine: 8, interp: '/lib/ld.so.1', runpath: '/x' }),
    ],
    ['pe', buildSamplePe()],
    [
      'pe64 dll',
      buildPe({
        plus: true,
        dll: true,
        exports: { dllName: 'a.dll', names: ['A', 'B'] },
        tls: true,
        loadConfig: true,
        delayImports: [{ dll: 'u.dll', funcs: ['F'] }],
      }),
    ],
    ['.net', buildPe({ clr: { userStrings: ['abc'] } })],
    ['macho', buildMacho({ signature: true })],
    ['fat', buildFat([{ cpu: 7, data: buildMacho() }])],
  ] as const;

  it('every prefix of every file gives a result or a ToolError', async () => {
    for (const [, bytes] of named) {
      const step = Math.max(1, Math.floor(bytes.length / 300));
      for (let n = 1; n < bytes.length; n += step) {
        await survives(bytes.subarray(0, n), ['overview', 'details', 'strings']);
      }
    }
  });

  it('flipped bytes and fields never crash a view', async () => {
    const random = rng(2024);
    for (const [, bytes] of named) {
      for (let k = 0; k < 60; k++) {
        const copy = bytes.slice();
        const edits = 1 + random(4);
        for (let e = 0; e < edits; e++) {
          const at = random(Math.min(copy.length, 1024 + random(copy.length)));
          const mode = random(3);
          if (mode === 0) copy[at] = random(256);
          else if (mode === 1) copy[at] = copy[at]! ^ (1 << random(8));
          else copy.fill(0xff, at, Math.min(copy.length, at + 1 + random(8)));
        }
        await survives(copy, VIEWS);
      }
    }
  }, 120_000);

  it('a hostile ELF does not run away', async () => {
    const bytes = buildSampleElf().slice();
    const dv = new DataView(bytes.buffer);
    dv.setUint16(56, 0xffff, true); // phnum
    dv.setUint16(60, 0xffff, true); // shnum
    dv.setBigUint64(32, 0xffffffffffffffffn, true); // phoff
    const t0 = performance.now();
    await survives(bytes, VIEWS);
    expect(performance.now() - t0).toBeLessThan(5000);
  });
});

describe('big files are read in pieces', () => {
  it('48 MiB of appended data: entropy is measured in chunks and the download is a Blob slice', async () => {
    const elf = buildSampleElf();
    const blob = new Blob([elf as BlobPart, new Uint8Array(48 << 20)]);
    const t0 = performance.now();
    const r = await run(fileOf(blob, 'big.elf'));
    expect(performance.now() - t0).toBeLessThan(10_000);
    const k = kvs(r);
    expect(k.get('Offset')).toBe(`0x${elf.length.toString(16)}`);
    expect(k.get('Size')).toBe(`48.00 MiB (${48 << 20} bytes)`);
    expect(k.get('Entropy')).toBe('0.00');
    const f = filesOf(r).find((x) => x.name === 'appended.bin')!;
    expect(f.blob!.size).toBe(48 << 20);
    expect(f.data.length).toBe(0);
  });

  it('48 MiB PE overlay and a section view that never loads the file', async () => {
    const pe = buildSamplePe();
    const blob = new Blob([pe as BlobPart, new Uint8Array(48 << 20)]);
    const r = await run(fileOf(blob, 'big.exe'), { view: 'resources' });
    expect(flat(r)).toContain('FTF{pe_resource}');
    const s = await run(fileOf(blob, 'big.exe'), { view: 'strings' });
    expect(flat(s)).toContain('FTF{pe_resource}');
    expect(notes(s).join(' ')).not.toMatch(PLACEHOLDER);
  }, 60_000);
});
