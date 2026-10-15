import { bool, defineTool, number, select, text } from '../../core/define';
import { ToolError } from '../../core/errors';
import type { Output } from '../../core/types';
import { toolT } from '../../i18n/tool-text';
import { formatSize } from '../../lib/bytes';
import { Reader } from './_exe-bin';
import { isElf, parseElf } from './_exe-elf';
import { machoMagic, parseMacho } from './_exe-macho';
import { isPe, parsePe, peOffsetOf } from './_exe-pe';
import { kvOutput, noteOutputs, toolLabel, type Opts } from './_exe-view';
import {
  elfDetails,
  elfImports,
  elfOverview,
  elfSections,
  elfStrings,
  elfSymbols,
} from './_exe-view-elf';
import {
  machoDetails,
  machoImports,
  machoOverview,
  machoSections,
  machoStrings,
  machoSymbols,
} from './_exe-view-macho';
import {
  peDetails,
  peImports,
  peOverview,
  peResources,
  peSections,
  peStrings,
  peSymbols,
} from './_exe-view-pe';

const T = toolT('exe-analyzer');

const isView = (v: Record<string, unknown>, ...views: string[]) => views.includes(String(v.view));

type Kind = 'elf' | 'pe' | 'macho';

function kindOf(head: Uint8Array): Kind | null {
  if (isElf(head)) return 'elf';
  if (isPe(head)) return 'pe';
  if (machoMagic(head)) return 'macho';
  return null;
}

export default defineTool({
  id: 'exe-analyzer',
  name: 'Executable analyzer (ELF, PE, Mach-O)',
  category: 'forensics',
  description:
    'Inspect an ELF, Windows PE (exe, dll, sys) or Mach-O file without running it: headers, sections with entropy, symbols, imports, resources, checksec-style protections, packer hints and strings per section.',
  tags: [
    'readelf',
    'objdump',
    'rabin2',
    'pe-bear',
    'pefile',
    'checksec',
    'elf',
    'pe',
    'exe',
    'dll',
    'mach-o',
    'macho',
    'executable',
    'binary',
    'sections',
    'imports',
    'symbols',
    'rich header',
    'overlay',
    'resources',
    'upx',
    'packer',
    'dotnet',
    'static analysis',
  ],
  input: 'file',
  // Switching views re-runs at once; a run still in progress is cancelled (the worker is
  // replaced), so typing in Filter never queues whole-file scans.
  live: true,
  placeholder:
    'Drop an executable (.exe, .dll, .so, ELF, Mach-O): it is read in pieces, never run and never uploaded.',
  options: {
    view: select(
      'View',
      [
        { value: 'overview', label: 'Overview' },
        { value: 'sections', label: 'Segments and sections' },
        { value: 'details', label: 'Headers and tables' },
        { value: 'symbols', label: 'Symbols and exports' },
        { value: 'imports', label: 'Imports and libraries' },
        { value: 'resources', label: 'Resources (PE)' },
        { value: 'strings', label: 'Strings per section' },
      ],
      'overview',
    ),
    filter: text('Filter', '', {
      placeholder: 'ExitProcess   ·   /^__.*_chk$/',
      hint: 'Plain text matches ignoring case; /…/ is a regular expression. Applies to symbols, imports and strings.',
      showIf: (v) => isView(v, 'symbols', 'imports', 'strings'),
    }),
    section: text('Section', '', {
      placeholder: '.rodata   ·   .text   ·   #5',
      hint: 'Strings: look only in this section. Segments and sections: also download its bytes as a file. A name or #index.',
      showIf: (v) => isView(v, 'sections', 'strings'),
    }),
    min: number('Minimum length', 6, { min: 2, max: 200, showIf: (v) => isView(v, 'strings') }),
    code: bool('Include code sections', false, {
      hint: 'Strings of executable sections (.text) are skipped by default: they are mostly noise.',
      showIf: (v) => isView(v, 'strings'),
    }),
    demangle: bool('Demangle C++ names', true, {
      hint: 'Itanium (GCC, Clang) and legacy Rust names. A name that cannot be demangled is shown as it is.',
      showIf: (v) => isView(v, 'symbols', 'imports'),
    }),
  },
  examples: [
    {
      label: 'ELF: header and checksec-style protections',
      input: { sample: 'exe-sample.elf' },
      expect: 'PT_GNU_STACK RW-',
    },
    {
      label: 'ELF: strings of .rodata',
      input: { sample: 'exe-sample.elf' },
      options: { view: 'strings', section: '.rodata' },
      expect: 'FTF{elf_rodata}',
    },
    {
      label: 'ELF: symbol table',
      input: { sample: 'exe-sample.elf' },
      options: { view: 'symbols' },
      expect: 'ftf_flag_function',
    },
    {
      label: 'ELF: libraries and imported functions',
      input: { sample: 'exe-sample.elf' },
      options: { view: 'imports' },
      expect: '__stack_chk_fail',
    },
    {
      label: 'ELF: segments and sections',
      input: { sample: 'exe-sample.elf' },
      options: { view: 'sections' },
      expect: 'GNU_RELRO',
    },
    {
      label: 'PE: overview and protections',
      input: { sample: 'exe-sample.exe' },
      expect: 'DYNAMIC_BASE',
    },
    {
      label: 'PE: imports by DLL and by ordinal',
      input: { sample: 'exe-sample.exe' },
      options: { view: 'imports' },
      expect: 'ExitProcess',
    },
    {
      label: 'PE: the RCDATA resource',
      input: { sample: 'exe-sample.exe' },
      options: { view: 'resources' },
      expect: 'FTF{pe_resource}',
    },
    {
      label: 'PE: version info',
      input: { sample: 'exe-sample.exe' },
      options: { view: 'resources' },
      expect: 'Find The Flag samples',
    },
    {
      label: 'PE: data after the last section (overlay)',
      input: { sample: 'exe-sample.exe' },
      expect: 'FTF{overlay}',
    },
    {
      label: 'PE: Rich header, debug directory',
      input: { sample: 'exe-sample.exe' },
      options: { view: 'details' },
      expect: 'checksum OK',
    },
    {
      label: 'Mach-O: header and strings',
      input: { sample: 'exe-sample.macho' },
      options: { view: 'strings' },
      expect: 'FTF{macho_cstring}',
    },
  ],
  async run(file, o: Opts): Promise<Output[]> {
    if (file.size === 0) throw new ToolError(T('error.empty'));
    const r = new Reader(file);
    const head = await r.read(0, 4096);
    const kind = kindOf(head);
    if (!kind) {
      throw new ToolError(
        T('error.unknown', {
          fileType: toolLabel('file-type'),
          binary: toolLabel('binary-analyzer'),
        }),
      );
    }
    const ctx = { file, r };
    // Entropy and the UPX scan read the whole file: only the views that show them pay for it.
    const deep = o.view === 'overview' || o.view === 'sections';
    const view = o.view;

    if (kind === 'elf') {
      const info = await parseElf(r, deep);
      if (!info.header) {
        return [
          kvOutput(T('label.identification'), [
            [T('kv.format'), 'ELF'],
            [T('kv.fileSize'), formatSize(file.size)],
          ]),
          ...noteOutputs(info.hints),
        ];
      }
      switch (view) {
        case 'sections':
          return elfSections(ctx, info, o);
        case 'details':
          return elfDetails(info);
        case 'symbols':
          return elfSymbols(info, o);
        case 'imports':
          return elfImports(info, o);
        case 'resources':
          return [{ type: 'note', level: 'info', text: T('note.noResourcesElf') }];
        case 'strings':
          return elfStrings(ctx, info, o);
        default:
          return elfOverview(ctx, info);
      }
    }

    if (kind === 'pe') {
      const info = await parsePe(r, deep);
      switch (view) {
        case 'sections':
          return peSections(ctx, info, o);
        case 'details':
          return info.coff ? peDetails(info) : noteOutputs(info.hints);
        case 'symbols':
          return peSymbols(info, o);
        case 'imports':
          return peImports(info, o);
        case 'resources':
          return peResources(ctx, info);
        case 'strings':
          return peStrings(ctx, info, o);
        default:
          return peOverview(ctx, info);
      }
    }

    const info = await parseMacho(r, deep);
    switch (view) {
      case 'sections':
        return machoSections(ctx, info, o);
      case 'details':
        return machoDetails(info);
      case 'symbols':
        return machoSymbols(info, o);
      case 'imports':
        return machoImports(info, o);
      case 'resources':
        return [{ type: 'note', level: 'info', text: T('note.noResourcesMacho') }];
      case 'strings':
        return machoStrings(ctx, info, o);
      default:
        return machoOverview(ctx, info);
    }
  },
  detect({ bytes }) {
    if (bytes.length < 20) return null;
    if (isElf(bytes)) return { score: 0.95, reason: T('detect.elf') };
    if (peOffsetOf(bytes) !== null) return { score: 0.95, reason: T('detect.pe') };
    if (isPe(bytes)) return { score: 0.6, reason: T('detect.dos') };
    if (machoMagic(bytes)) return { score: 0.9, reason: T('detect.macho') };
    return null;
  },
});
