import { describe, expect, it } from 'vitest';
import { buildPe, buildSamplePe, buildVersionInfo } from './_exe-fixtures';
import { parsePe } from './_exe-pe';
import { buildIco, decodeStringTable, decodeText, parseVersionInfo } from './_exe-pe-res';
import { readerOf } from './_exe-test-kit';

/**
 * Expected values come from the Python pefile package (2024.8.26, MIT) and llvm-readobj 18 run on
 * the very bytes these builders write; the same parser was also compared with pefile on real
 * executables and DLLs (0 differences) as described in the commit message.
 */
const pe = async (bytes: Uint8Array) => parsePe(readerOf(bytes));
const enc = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

describe('PE32 sample (pefile + llvm-readobj)', () => {
  it('reads the COFF and optional headers', async () => {
    const i = await pe(buildSamplePe());
    expect(i.coff).toMatchObject({
      machine: 0x14c,
      sections: 4,
      timestamp: 0x65a4f8a8,
      optionalSize: 224,
      characteristics: 0x102,
    });
    expect(i.coff!.flags).toEqual(['EXECUTABLE_IMAGE', '32BIT_MACHINE']);
    expect(i.opt).toMatchObject({
      magic: 0x10b,
      plus: false,
      entry: 0x1000,
      imageBase: 0x400000n,
      subsystem: 3,
      dllCharacteristics: 0x8140,
      sizeOfImage: 0x5000,
      sizeOfHeaders: 0x400,
      linker: '14.36',
      sectionAlignment: 0x1000,
      fileAlignment: 0x200,
    });
    expect(i.opt!.dllFlags).toEqual(['DYNAMIC_BASE', 'NX_COMPAT', 'TERMINAL_SERVER_AWARE']);
    expect(i.entrySection).toBe('.text');
    expect(i.dirs.filter((d) => d.rva).map((d) => [d.name, d.rva, d.size])).toEqual([
      ['Import', 0x2000, 0x3c],
      ['Resource', 0x3000, 0xa0c],
      ['Base relocation', 0x4000, 0xc],
      ['Debug', 0x209c, 0x1c],
    ]);
  });

  it('reads the sections', async () => {
    const i = await pe(buildSamplePe());
    expect(
      i.sections.map((s) => [
        s.name,
        s.rva,
        s.virtualSize,
        s.rawSize,
        s.offset,
        s.flags,
        s.characteristics,
      ]),
    ).toEqual([
      ['.text', 0x1000, 0x40, 0x200, 0x400, 'R-X', 0x60000020],
      ['.rdata', 0x2000, 0xf0, 0x200, 0x600, 'R--', 0x40000040],
      ['.rsrc', 0x3000, 0xa0c, 0xc00, 0x800, 'R--', 0x40000040],
      ['.reloc', 0x4000, 0xc, 0x200, 0x1400, 'R--', 0x42000040],
    ]);
    expect(i.sections.every((s) => s.entropy !== null)).toBe(true);
    expect(i.sections[0]!.detail).toBe('CODE');
  });

  it('reads the imports, by name and by ordinal', async () => {
    const i = await pe(buildSamplePe());
    expect(i.imports.map((d) => [d.dll, d.kind, d.functions])).toEqual([
      [
        'kernel32.dll',
        'import',
        [
          { name: 'ExitProcess', ordinal: null, hint: 1 },
          { name: 'GetProcAddress', ordinal: null, hint: 2 },
        ],
      ],
      ['ws2_32.dll', 'import', [{ name: null, ordinal: 115, hint: null }]],
    ]);
    expect(i.importCount).toBe(3);
  });

  it('decodes the Rich header and its checksum', async () => {
    const i = await pe(buildSamplePe());
    expect(i.rich).toMatchObject({ offset: 0x80, size: 48, key: 0x8e43eff7 });
    expect(i.rich!.computed).toBe(i.rich!.key);
    expect(i.rich!.entries).toEqual([
      { productId: 1, build: 0, count: 8 },
      { productId: 93, build: 30795, count: 3 },
      { productId: 260, build: 31935, count: 1 },
    ]);
    expect(i.hints.map((h) => h.key)).not.toContain('richBad');
  });

  it('reads the debug directory (CodeView) and the DOS stub', async () => {
    const i = await pe(buildSamplePe());
    expect(i.debug).toEqual([
      {
        type: 'CODEVIEW',
        timestamp: 0x65a4f8a8,
        size: 48,
        format: 'RSDS',
        guid: '{44332211-6655-8877-99AA-BBCCDDEEFF01}',
        age: 1,
        pdb: 'C:\\build\\ftf\\sample.pdb',
      },
    ]);
    expect(i.dos.lfanew).toBe(0xb0);
    expect(i.dos.stub).toBe('This program cannot be run in DOS mode.');
  });

  it('lists the resources and finds the overlay', async () => {
    const i = await pe(buildSamplePe());
    expect(i.resources.map((r) => `${r.type}/${r.name}/${r.lang}/${r.size}`)).toEqual([
      'RT_ICON/1/1033/1128',
      'RT_RCDATA/101/1033/16',
      'RT_GROUP_ICON/MAINICON/1033/20',
      'RT_VERSION/1/1033/676',
      'RT_MANIFEST/1/1033/334',
    ]);
    expect(i.overlay).toMatchObject({
      offset: 0x1600,
      size: 13,
      text: 'FTF{overlay}',
      magic: null,
    });
    expect(i.security.map((s) => `${s.id}=${s.state}`)).toEqual([
      'aslr=enabled',
      'dep=enabled',
      'cfg=disabled',
      'noSeh=disabled',
      'signature=disabled',
    ]);
    expect(i.packed).toEqual([]);
  });
});

describe('PE variants', () => {
  it('PE32+ DLL: exports, a forwarder, the load config cookie', async () => {
    const i = await pe(
      buildPe({
        plus: true,
        dll: true,
        exports: {
          dllName: 'ftf.dll',
          names: ['FtfInit', 'FtfRun', 'Fwd'],
          forwarders: { Fwd: 'KERNEL32.ExitProcess' },
        },
        imports: [
          { dll: 'kernel32.dll', funcs: ['ExitProcess', 'LoadLibraryA', 'GetProcAddress'] },
        ],
        pdb: 'ftf.pdb',
        loadConfig: true,
      }),
    );
    expect([i.opt!.plus, i.opt!.magic, i.isDll, i.opt!.entry]).toEqual([true, 0x20b, true, 0]);
    expect(i.opt!.imageBase).toBe(0x140000000n);
    expect(i.exports!.dllName).toBe('ftf.dll');
    expect(i.exports!.rows.map((r) => [r.ordinal, r.name, r.forwarder])).toEqual([
      [1, 'FtfInit', null],
      [2, 'FtfRun', null],
      [3, 'Fwd', 'KERNEL32.ExitProcess'],
    ]);
    expect(i.security.map((s) => s.id)).toContain('highEntropyVa');
    expect(i.security.find((s) => s.id === 'cookie')!.state).toBe('enabled');
    expect(i.debug[0]!.pdb).toBe('ftf.pdb');
  });

  it('delay-load imports (by name and by ordinal) and TLS callbacks', async () => {
    const i = await pe(
      buildPe({
        imports: [{ dll: 'kernel32.dll', funcs: ['ExitProcess'] }],
        delayImports: [
          { dll: 'user32.dll', funcs: ['MessageBoxA', 'MessageBoxW'] },
          { dll: 'gdi32.dll', funcs: [12] },
        ],
        tls: true,
      }),
    );
    expect(
      i.imports
        .filter((d) => d.kind === 'delay')
        .map((d) => [d.dll, d.functions.map((f) => f.name ?? `#${f.ordinal}`)]),
    ).toEqual([
      ['user32.dll', ['MessageBoxA', 'MessageBoxW']],
      ['gdi32.dll', ['#12']],
    ]);
    expect(i.tls!.callbacks).toHaveLength(1);
    expect(i.tls!.callbacks[0]!.section).toBe('.text');
    expect(i.hints.map((h) => h.key)).toContain('tlsCallbacks');
  });

  it('.NET assembly: CLR header, metadata streams, user strings', async () => {
    const i = await pe(
      buildPe({ clr: { userStrings: ['Hello', 'FTF{dotnet_us}', 'p\u00e4ssword'] } }),
    );
    expect(i.clr!.version).toBe('v4.0.30319');
    expect(i.clr!.runtime).toBe('2.5');
    expect(i.clr!.entryPointToken).toBe(0x06000001);
    expect(i.clr!.streams.map((s) => s.name)).toEqual(['#~', '#Strings', '#US', '#GUID', '#Blob']);
    expect(i.clr!.userStrings).toEqual(['Hello', 'FTF{dotnet_us}', 'p\u00e4ssword']);
    expect(i.hints.map((h) => h.key)).toContain('dotNet');
    expect(i.imports[0]!.dll).toBe('mscoree.dll');
    expect(i.packed).toEqual([]);
  });

  it('a UPX-style file looks packed: section names, empty raw section, entropy', async () => {
    const code = Uint8Array.from(
      { length: 6000 },
      (_, k) => (Math.imul(k, 2654435761) >>> 24) & 255,
    );
    const i = await pe(
      buildPe({
        emptySection: 'UPX0',
        sectionNames: { '.text': 'UPX1', '.rdata': 'UPX2' },
        code,
        rich: false,
      }),
    );
    expect(i.sections.map((s) => s.name)).toEqual(['UPX0', 'UPX1', 'UPX2', '.reloc']);
    expect(i.sections[0]!.rawSize).toBe(0);
    expect(i.sections[0]!.virtualSize).toBe(0x20000);
    const keys = i.packed.map((p) => p.key);
    expect(keys).toContain('packedSection');
    expect(keys).toContain('packedEmptyRaw');
    expect(keys).toContain('packedEntropy');
    expect(i.rich).toBeNull();
    expect(i.entrySection).toBe('UPX1');
  });

  it('the Authenticode slot is reported apart from the overlay', async () => {
    const plain = buildPe({});
    const i = await pe(
      buildPe({ certificate: enc('PKCS7'.padEnd(64, '.')), overlay: enc('tail!') }),
    );
    expect(i.certificate).toEqual({ offset: plain.length, size: 64 });
    expect(i.overlay).toMatchObject({ offset: plain.length + 64, size: 5, text: 'tail!' });
    expect(i.security.find((s) => s.id === 'signature')!.state).toBe('enabled');
    expect(i.hints.map((h) => h.key)).toContain('signed');
  });

  it('a Rich header whose bytes were edited fails its checksum', async () => {
    const bytes = buildSamplePe().slice();
    bytes[0x90] = bytes[0x90]! ^ 1; // one byte of an entry
    const i = await pe(bytes);
    expect(i.rich).not.toBeNull();
    expect(i.rich!.computed).not.toBe(i.rich!.key);
    expect(i.hints.map((h) => h.key)).toContain('richBad');
  });

  it('no Rich header (as with MinGW or clang)', async () => {
    expect((await pe(buildPe({ rich: false }))).rich).toBeNull();
  });

  it('an entry point in a writable section or outside every section is noted', async () => {
    const bytes = buildSamplePe().slice();
    const dv = new DataView(bytes.buffer);
    dv.setUint32(0xb0 + 24 + 16, 0x9000, true); // AddressOfEntryPoint
    const i = await pe(bytes);
    expect(i.entrySection).toBeNull();
    expect(i.hints.map((h) => h.key)).toContain('epOutsideSections');
  });
});

describe('PE resources decoders', () => {
  it('version info', () => {
    const v = parseVersionInfo(
      buildVersionInfo({ CompanyName: 'Acme', ProductName: 'Widget' }, [3, 2, 1, 0]),
    );
    expect(v).toEqual({
      fileVersion: '3.2.1.0',
      productVersion: '3.2.1.0',
      strings: [
        ['CompanyName', 'Acme'],
        ['ProductName', 'Widget'],
      ],
      translations: ['040904b0'],
    });
    expect(parseVersionInfo(new Uint8Array(10))).toBeNull();
  });

  it('string tables: block 2 holds strings 16..31', () => {
    const w = [0, 0, 0];
    void w;
    const b: number[] = [];
    const add = (s: string) => {
      b.push(s.length & 0xff, s.length >> 8);
      for (const c of s) b.push(c.charCodeAt(0), 0);
    };
    add('');
    add('first');
    add('');
    add('second');
    expect(decodeStringTable(Uint8Array.from(b), 2)).toEqual([
      [17, 'first'],
      [19, 'second'],
    ]);
  });

  it('text with a byte order mark', () => {
    expect(decodeText(Uint8Array.from([0xff, 0xfe, 0x41, 0x00, 0x42, 0x00]))).toBe('AB');
    expect(decodeText(Uint8Array.from([0xef, 0xbb, 0xbf, 0x43]))).toBe('C');
    expect(decodeText(enc('plain'))).toBe('plain');
  });

  it('icons are rebuilt into an .ico', () => {
    const group = Uint8Array.from([0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32, 0, 4, 0, 0, 0, 7, 0]);
    const ico = buildIco(group, new Map([[7, Uint8Array.from([1, 2, 3, 4])]]))!;
    expect(Array.from(ico.subarray(0, 6))).toEqual([0, 0, 1, 0, 1, 0]);
    expect(new DataView(ico.buffer).getUint32(14, true)).toBe(4); // bytes in resource
    expect(new DataView(ico.buffer).getUint32(18, true)).toBe(22); // image offset
    expect(Array.from(ico.subarray(22))).toEqual([1, 2, 3, 4]);
    expect(buildIco(group, new Map())).toBeNull();
  });
});

describe('PE robustness', () => {
  it('a DOS header alone', async () => {
    const bytes = buildSamplePe().slice(0, 0x80); // an old DOS program: no PE header offset
    bytes.fill(0, 0x3c, 0x40);
    const i = await pe(bytes);
    expect(i.coff).toBeNull();
    expect(i.hints.map((h) => h.key)).toEqual(['dosOnly']);
    expect(i.dos.stub).toBe('This program cannot be run in DOS mode.');
  });

  it('the PE header pointing outside the file', async () => {
    const bytes = buildSamplePe().slice();
    new DataView(bytes.buffer).setUint32(0x3c, 0x7fffffff, true);
    const i = await pe(bytes);
    expect(i.coff).toBeNull();
    expect(i.hints.map((h) => h.key)).toEqual(['peOutsideFile']);
  });

  it('a section table cut by the end of the file', async () => {
    const i = await pe(buildSamplePe().subarray(0, 0xb0 + 24 + 224 + 50));
    expect(i.sections).toHaveLength(1);
    expect(i.hints.map((h) => h.key)).toContain('tableTruncated');
  });

  it('sections whose data lies beyond the end', async () => {
    const full = buildSamplePe();
    const i = await pe(full.subarray(0, 0x900));
    expect(i.sections.some((s) => s.outside)).toBe(true);
    expect(i.hints.map((h) => h.key)).toContain('sectionsBeyondFile');
  });

  it('a hostile section count, import and export tables do not hang', async () => {
    const bytes = buildPe({ exports: { dllName: 'x.dll', names: ['a'] } }).slice();
    const dv = new DataView(bytes.buffer);
    const lfanew = dv.getUint32(0x3c, true);
    dv.setUint16(lfanew + 6, 0xffff, true); // NumberOfSections
    const t0 = performance.now();
    const i = await pe(bytes);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(i.sections.length).toBeLessThanOrEqual(512);
  });

  it('a resource directory that points at itself', async () => {
    const bytes = buildSamplePe().slice();
    const dv = new DataView(bytes.buffer);
    // first entry of the root directory (file offset 0x800 + 16): make it point to the root again
    dv.setUint32(0x800 + 16 + 4, 0x80000000, true);
    const t0 = performance.now();
    const i = await pe(bytes);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(i.resources.length).toBeLessThan(10);
  });

  it('an import descriptor chain without a terminator stops at the file end', async () => {
    const bytes = buildSamplePe().slice();
    bytes.fill(1, 0x600, 0x800);
    const t0 = performance.now();
    const i = await pe(bytes);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(i.imports.length).toBeLessThanOrEqual(1024);
  });
});
