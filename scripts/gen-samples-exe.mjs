// Generates the Executable analyzer samples in public/samples/. Deterministic: run it again and
// the bytes are identical. No compiler and no real program: the files are written byte by byte by
// src/tools/forensics/_exe-fixtures.ts (loaded through Vite like the other TS-aware scripts), so
// they are tiny and every field is on purpose. Their code is a few bytes that never runs.
//
//   node scripts/gen-samples-exe.mjs
//
// Files:
//   exe-sample.elf    ELF64 x86-64, PIE, dynamic. .rodata holds FTF{elf_rodata}; .symtab has
//                     ftf_flag_function; PT_GNU_STACK is RW (not executable); partial RELRO,
//                     stack-protector and _FORTIFY_SOURCE imports, a GNU build id, the x86 CET note
//   exe-sample.exe    PE32 (i386) with kernel32!ExitProcess / GetProcAddress, ws2_32 by ordinal 115,
//                     RT_RCDATA "FTF{pe_resource}", a manifest, version info, an icon, a Rich
//                     header, a CodeView PDB path and the overlay "FTF{overlay}"
//   exe-sample.macho  Mach-O x86-64 with a __cstring "FTF{macho_cstring}", libSystem, a UUID
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const outDir = fileURLToPath(new URL('../public/samples/', import.meta.url));
const vite = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent',
});
try {
  const fx = await vite.ssrLoadModule('/src/tools/forensics/_exe-fixtures.ts');
  const files = {
    'exe-sample.elf': fx.buildSampleElf(),
    'exe-sample.exe': fx.buildSamplePe(),
    'exe-sample.macho': fx.buildMacho(),
  };
  for (const [name, bytes] of Object.entries(files)) {
    writeFileSync(`${outDir}${name}`, bytes);
    console.log(`${name}: ${bytes.length} bytes`);
  }
} finally {
  await vite.close();
}
