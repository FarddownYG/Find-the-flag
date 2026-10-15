/**
 * What the Executable analyzer shows for an ELF file, one function per view.
 */
import type { LazyFile, Output } from '../../core/types';
import { toolT } from '../../i18n/tool-text';
import { formatSize } from '../../lib/bytes';
import { Reader, hex, visible } from './_exe-bin';
import { demangle } from './_exe-demangle';
import { ET_NAMES, MACHINES, OSABI, segmentFlags, type ElfInfo } from './_exe-elf';
import { collectStrings, makeFilter, type StringRegion } from './_exe-strings';
import type { SymbolRow } from './_exe-types';
import {
  MAX_TABLE,
  findSection,
  kvOutput,
  noteOutputs,
  packedOutputs,
  sectionFile,
  sectionsOutput,
  securityOutput,
  trailingOutputs,
  type Opts,
} from './_exe-view';
import { stringsOutputs } from './_exe-view-strings';

const T = toolT('exe-analyzer');

interface Ctx {
  file: LazyFile;
  r: Reader;
}

const TYPE_TEXT: Record<number, () => string> = {
  1: () => T('elfType.rel'),
  2: () => T('elfType.exec'),
  3: () => T('elfType.dyn'),
  4: () => T('elfType.core'),
};

function entryDetail(info: ElfInfo): string {
  const h = info.header!;
  const sec = info.sections.find((s) => s.exec && h.entry >= s.addr && h.entry < s.addr + s.vsize);
  return sec ? `${hex(h.entry)} (${sec.name})` : hex(h.entry);
}

function identification(info: ElfInfo, size: number): [string, string][] {
  const h = info.header!;
  const e: [string, string][] = [
    [T('kv.format'), 'ELF'],
    [T('kv.class'), T('value.bits', { bits: h.bits })],
    [T('kv.byteOrder'), h.le ? T('value.little') : T('value.big')],
    [T('kv.machine'), `${MACHINES[h.machine] ?? T('value.unknown')} (${hex(h.machine)})`],
    [
      T('kv.type'),
      `${ET_NAMES[h.type] ?? hex(h.type)}${TYPE_TEXT[h.type] ? ` - ${TYPE_TEXT[h.type]!()}` : ''}`,
    ],
    [T('kv.osabi'), OSABI[h.osabi] ?? hex(h.osabi)],
    [T('kv.entry'), entryDetail(info)],
  ];
  if (info.interp) e.push([T('kv.interpreter'), info.interp]);
  e.push([
    T('kv.linking'),
    info.interp !== null || info.dynamic.length > 0 ? T('value.dynamic') : T('value.static'),
  ]);
  if (info.sections.length > 0 && h.type !== 1) {
    e.push([
      T('kv.symbols'),
      info.hasSymtab
        ? T('value.symbolsKept', {
            count: info.symbols.filter((s) => s.table === 'symtab' && s.index > 0).length,
          })
        : T('value.stripped'),
    ]);
  }
  const id = info.notes.find((n) => n.typeName === 'NT_GNU_BUILD_ID');
  if (id) e.push([T('kv.buildId'), id.value]);
  if (info.comment[0]) e.push([T('kv.compiler'), info.comment.join(' | ')]);
  e.push([T('kv.fileSize'), T('value.size', { size: formatSize(size), count: size })]);
  return e;
}

function contents(info: ElfInfo): [string, string][] {
  const e: [string, string][] = [
    [T('kv.sections'), String(info.sections.length)],
    [T('kv.segments'), String(info.segments.length)],
  ];
  const imported = info.symbols.filter((s) => s.table === 'dynsym' && s.undefined).length;
  const exported = info.symbols.filter(
    (s) => s.table === 'dynsym' && !s.undefined && s.index > 0,
  ).length;
  if (info.hasDynsym)
    e.push([T('kv.dynsym'), T('value.importsExports', { imports: imported, exports: exported })]);
  if (info.needed.length) e.push([T('kv.needed'), info.needed.join(', ')]);
  const total = info.relocs.reduce((a, r) => a + r.count, 0);
  if (info.relocs.length) e.push([T('kv.relocations'), String(total)]);
  return e;
}

export function elfOverview(ctx: Ctx, info: ElfInfo): Output[] {
  const out: Output[] = [];
  out.push(kvOutput(T('label.identification'), identification(info, ctx.r.size)));
  out.push(...packedOutputs(info.packed));
  out.push(...noteOutputs(info.hints));
  out.push(...securityOutput(info.security));
  if (info.sections.length) {
    out.push(
      sectionsOutput(
        info.sections.filter((s) => s.type !== 'NULL'),
        'elf',
        false,
      ),
    );
  }
  out.push(kvOutput(T('label.contents'), contents(info)));
  if (info.trailing) out.push(...trailingOutputs(ctx.file, info.trailing, 'appended'));
  return out;
}

export function elfSections(ctx: Ctx, info: ElfInfo, o: Opts): Output[] {
  const out: Output[] = [];
  if (info.segments.length) {
    out.push({
      type: 'table',
      label: T('label.segments', { count: info.segments.length }),
      columns: [
        T('col.type'),
        T('col.flags'),
        T('col.offset'),
        T('col.address'),
        T('col.fileSize'),
        T('col.memSize'),
        T('col.align'),
      ],
      rows: info.segments.map((s) => [
        s.typeName,
        segmentFlags(s.flags),
        hex(s.offset),
        hex(s.vaddr),
        hex(s.filesz),
        hex(s.memsz),
        hex(s.align),
      ]),
    });
  }
  if (info.sections.length) out.push(sectionsOutput(info.sections, 'elf', true));
  else out.push(...noteOutputs(info.hints.filter((h) => h.key === 'noSections')));
  if (o.section.trim()) {
    const row = findSection(info.sections, o.section);
    if (!row || row.size === 0) {
      out.push({
        type: 'note',
        level: 'warn',
        text: T('note.sectionMissing', { name: o.section.trim() }),
      });
    } else out.push(sectionFile(ctx.file, row));
  }
  return out;
}

function nameOf(s: SymbolRow, wantDemangle: boolean): { shown: string; raw: string } {
  const d = wantDemangle ? demangle(s.name) : null;
  return { shown: d ?? s.name, raw: s.name };
}

export function elfSymbols(info: ElfInfo, o: Opts): Output[] {
  const out: Output[] = [];
  if (info.symbols.length === 0) {
    out.push({ type: 'note', level: 'info', text: T('note.noSymbols') });
    return out;
  }
  const test = makeFilter(o.filter);
  const rows = info.symbols
    .filter((s) => s.index > 0)
    .map((s) => ({ s, n: nameOf(s, o.demangle) }))
    .filter(({ n }) => !test || test(n.shown) || test(n.raw));
  const anyMangled = rows.some(({ n }) => n.shown !== n.raw);
  const shown = rows.slice(0, MAX_TABLE);
  out.push({
    type: 'table',
    label: T('label.symbolsOf', { shown: shown.length, total: info.symbols.length }),
    // The name comes first: it is what the pane is narrow for.
    columns: [
      T('col.name'),
      T('col.value'),
      T('col.size'),
      T('col.type'),
      T('col.bind'),
      T('col.section'),
      T('col.version'),
      T('col.table'),
      T('col.index'),
      ...(anyMangled ? [T('col.mangled')] : []),
    ],
    rows: shown.map(({ s, n }) => [
      visible(n.shown, 300),
      hex(s.value),
      s.size,
      s.kind,
      s.bind,
      s.section,
      s.version,
      s.table === 'symtab' ? '.symtab' : '.dynsym',
      s.index,
      ...(anyMangled ? [n.shown !== n.raw ? visible(n.raw, 300) : ''] : []),
    ]),
  });
  if (rows.length > shown.length) {
    out.push({
      type: 'note',
      level: 'info',
      text: T('note.rowsCapped', { shown: shown.length, total: rows.length }),
    });
  }
  if (!info.hasSymtab && info.sections.length > 0) {
    out.push(...noteOutputs(info.hints.filter((h) => h.key === 'stripped')));
  }
  return out;
}

export function elfImports(info: ElfInfo, o: Opts): Output[] {
  const out: Output[] = [];
  if (info.interp === null && info.dynamic.length === 0 && !info.hasDynsym) {
    out.push({ type: 'note', level: 'info', text: T('note.noDynamic') });
  }
  const libs: [string, string][] = info.needed.map((n, i) => [String(i + 1), n]);
  if (info.soname) libs.unshift([T('kv.soname'), info.soname]);
  if (info.rpath !== null) libs.push([T('kv.rpath'), info.rpath]);
  if (info.runpath !== null) libs.push([T('kv.runpath'), info.runpath]);
  if (libs.length) out.push(kvOutput(T('label.libraries'), libs));
  const test = makeFilter(o.filter);
  const rows = info.symbols
    .filter((s) => s.table === 'dynsym' && s.undefined)
    .map((s) => ({ s, n: nameOf(s, o.demangle) }))
    .filter(({ n }) => !test || test(n.shown) || test(n.raw));
  if (rows.length) {
    out.push({
      type: 'table',
      label: T('label.imported', { count: rows.length }),
      columns: [T('col.name'), T('col.version'), T('col.type'), T('col.bind')],
      rows: rows.slice(0, MAX_TABLE).map(({ s, n }) => [n.shown, s.version, s.kind, s.bind]),
    });
  }
  return out;
}

/** Sections whose bytes are worth running Strings on. */
function stringRegions(info: ElfInfo, o: Opts, size: number): StringRegion[] {
  const skipTypes = new Set([
    'NOBITS',
    'SYMTAB',
    'DYNSYM',
    'STRTAB',
    'RELA',
    'REL',
    'DYNAMIC',
    'HASH',
    'GNU_HASH',
    'NULL',
    'VERSYM',
    'VERNEED',
    'VERDEF',
  ]);
  const want = o.section.trim();
  const regions: StringRegion[] = [];
  const covered: [number, number][] = [];
  for (const s of info.sections) {
    if (s.size === 0 || s.outside) continue;
    covered.push([s.offset, s.offset + s.size]);
    if (skipTypes.has(s.type)) continue;
    if (want) {
      if (findSection([s], want) === null) continue;
    } else if (s.exec && !o.code) continue;
    regions.push({ name: s.name || `[${s.index}]`, offset: s.offset, size: s.size, wide: false });
  }
  if (!want) {
    // bytes no section covers: headers, section-less binaries, appended data
    const gaps = uncovered(covered, size);
    for (const [a, b] of gaps)
      regions.push({ name: T('value.noSection'), offset: a, size: b - a, wide: false });
  }
  return regions;
}

export function uncovered(ranges: [number, number][], size: number): [number, number][] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const gaps: [number, number][] = [];
  let pos = 0;
  for (const [a, b] of sorted) {
    if (a > pos) gaps.push([pos, a]);
    pos = Math.max(pos, b);
  }
  if (pos < size) gaps.push([pos, size]);
  // tiny gaps are alignment padding
  return gaps.filter(([a, b]) => b - a >= 8).slice(0, 64);
}

export async function elfStrings(ctx: Ctx, info: ElfInfo, o: Opts): Promise<Output[]> {
  const regions = stringRegions(info, o, ctx.r.size);
  const res = await collectStrings(ctx.r, regions, o.min, makeFilter(o.filter));
  return stringsOutputs(res, o, regions.length);
}

export function elfDetails(info: ElfInfo): Output[] {
  const h = info.header!;
  const out: Output[] = [];
  out.push(
    kvOutput(T('label.elfHeader'), [
      [T('kv.class'), T('value.bits', { bits: h.bits })],
      [T('kv.byteOrder'), h.le ? T('value.little') : T('value.big')],
      [T('kv.version'), String(h.version)],
      [T('kv.osabi'), `${OSABI[h.osabi] ?? hex(h.osabi)} (ABI ${h.abiVersion})`],
      [T('kv.type'), `${ET_NAMES[h.type] ?? hex(h.type)} (${hex(h.type)})`],
      [T('kv.machine'), `${MACHINES[h.machine] ?? T('value.unknown')} (${hex(h.machine)})`],
      [T('kv.entry'), hex(h.entry)],
      [T('kv.phoff'), `${h.phoff} (${h.phnum} x ${h.phentsize} bytes)`],
      [T('kv.shoff'), `${h.shoff} (${h.shnum} x ${h.shentsize} bytes, strings at ${h.shstrndx})`],
      [T('kv.flags'), hex(h.flags)],
      [T('kv.headerSize'), String(h.ehsize)],
    ]),
  );
  if (info.dynamic.length) {
    out.push({
      type: 'table',
      label: T('label.dynamic', { count: info.dynamic.length }),
      columns: [T('col.tag'), T('col.value'), T('col.text')],
      rows: info.dynamic.map((d) => [d.tagName, hex(d.value), d.text]),
    });
  }
  if (info.notes.length) {
    out.push({
      type: 'table',
      label: T('label.notes', { count: info.notes.length }),
      columns: [T('col.section'), T('col.owner'), T('col.type'), T('col.value')],
      rows: info.notes.map((n) => [n.where, n.owner, n.typeName, n.value]),
    });
  }
  if (info.relocs.length) {
    out.push({
      type: 'table',
      label: T('label.relocations'),
      columns: [T('col.section'), T('col.count')],
      rows: info.relocs.map((r) => [r.section, r.count]),
    });
  }
  if (info.comment.length) {
    out.push(
      kvOutput(
        T('label.comment'),
        info.comment.map((c, i) => [String(i + 1), c]),
      ),
    );
  }
  return out;
}
