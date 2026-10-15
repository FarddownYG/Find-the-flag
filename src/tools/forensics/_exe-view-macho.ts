/**
 * What the Executable analyzer shows for a Mach-O file (basic: header, load commands, segments,
 * libraries, symbols), one function per view.
 */
import type { LazyFile, Output } from '../../core/types';
import { toolT } from '../../i18n/tool-text';
import { formatSize } from '../../lib/bytes';
import { Reader, entropyText, hex } from './_exe-bin';
import { demangle } from './_exe-demangle';
import type { MachoInfo } from './_exe-macho';
import { collectStrings, makeFilter, type StringRegion } from './_exe-strings';
import {
  MAX_TABLE,
  findSection,
  kvOutput,
  noteOutputs,
  sectionFile,
  sectionsOutput,
  securityOutput,
  trailingOutputs,
  type Opts,
} from './_exe-view';
import { uncovered } from './_exe-view-elf';
import { stringsOutputs } from './_exe-view-strings';

const T = toolT('exe-analyzer');

interface Ctx {
  file: LazyFile;
  r: Reader;
}

function identification(info: MachoInfo, size: number): [string, string][] {
  const h = info.header!;
  const e: [string, string][] = [
    [T('kv.format'), `Mach-O ${T('value.bits', { bits: h.bits })}${info.fat ? ' (fat)' : ''}`],
    [T('kv.byteOrder'), h.le ? T('value.little') : T('value.big')],
    [T('kv.machine'), `${h.cpuName} (${hex(h.cpu)})`],
    [T('kv.type'), h.fileTypeName],
  ];
  if (info.dylinker) e.push([T('kv.interpreter'), info.dylinker]);
  if (info.entryOffset !== null)
    e.push([T('kv.entry'), `${T('value.fileOffset')} ${hex(info.entryOffset)}`]);
  if (info.uuid) e.push([T('kv.uuid'), info.uuid]);
  if (info.build) e.push([T('kv.build'), info.build]);
  e.push([T('kv.flags'), h.flagNames.join(' | ') || '-']);
  e.push([T('kv.fileSize'), T('value.size', { size: formatSize(size), count: size })]);
  return e;
}

export function machoOverview(ctx: Ctx, info: MachoInfo): Output[] {
  const out: Output[] = [];
  if (!info.header) return noteOutputs(info.hints);
  out.push(kvOutput(T('label.identification'), identification(info, ctx.r.size)));
  out.push(...noteOutputs(info.hints));
  out.push(...securityOutput(info.security));
  if (info.sections.length) out.push(sectionsOutput(info.sections, 'macho', false));
  const contents: [string, string][] = [
    [T('kv.segments'), String(info.segments.length)],
    [T('kv.loadCommands'), String(info.commands.length)],
    [T('kv.libraries'), String(info.dylibs.filter((d) => d.kind !== 'id').length)],
    [T('kv.symbols'), String(info.symbols.length)],
  ];
  out.push(kvOutput(T('label.contents'), contents));
  if (info.trailing) out.push(...trailingOutputs(ctx.file, info.trailing, 'appended'));
  return out;
}

export function machoSections(ctx: Ctx, info: MachoInfo, o: Opts): Output[] {
  const out: Output[] = [];
  if (info.segments.length) {
    out.push({
      type: 'table',
      label: T('label.segments', { count: info.segments.length }),
      columns: [
        T('col.name'),
        T('col.address'),
        T('col.memSize'),
        T('col.offset'),
        T('col.fileSize'),
        T('col.maxProt'),
        T('col.initProt'),
        T('col.entropy'),
      ],
      rows: info.segments.map((s) => [
        s.name,
        hex(s.vmaddr),
        hex(s.vmsize),
        hex(s.fileoff),
        hex(s.filesize),
        s.maxprot,
        s.initprot,
        entropyText(s.entropy),
      ]),
    });
  }
  if (info.sections.length) out.push(sectionsOutput(info.sections, 'macho', true));
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

export function machoDetails(info: MachoInfo): Output[] {
  const out: Output[] = [];
  const h = info.header;
  if (info.fat) {
    out.push({
      type: 'table',
      label: T('label.fatArchs'),
      columns: [T('col.index'), T('col.machine'), T('col.offset'), T('col.size')],
      rows: info.fat.map((a, i) => [i + 1, a.cpu, hex(a.offset), a.size]),
    });
  }
  if (h) {
    out.push(
      kvOutput(T('label.machoHeader'), [
        [T('kv.machine'), `${h.cpuName} (${hex(h.cpu)})`],
        [T('kv.type'), `${h.fileTypeName} (${h.fileType})`],
        [T('kv.loadCommands'), `${h.ncmds} (${h.sizeofcmds} bytes)`],
        [T('kv.flags'), `${hex(h.flags)}: ${h.flagNames.join(' | ')}`],
      ]),
    );
  }
  if (info.commands.length) {
    out.push({
      type: 'table',
      label: T('label.loadCommands', { count: info.commands.length }),
      columns: [T('col.index'), T('col.command'), T('col.size'), T('col.detail')],
      rows: info.commands.map((c) => [c.index, c.name, c.size, c.detail]),
    });
  }
  return out;
}

export function machoSymbols(info: MachoInfo, o: Opts): Output[] {
  if (info.symbols.length === 0)
    return [{ type: 'note', level: 'info', text: T('note.noSymbols') }];
  const test = makeFilter(o.filter);
  const rows = info.symbols
    .map((s) => ({
      s,
      shown: o.demangle ? (demangle(s.name.replace(/^_/, '')) ?? s.name) : s.name,
    }))
    .filter(({ s, shown }) => !test || test(shown) || test(s.name));
  const shown = rows.slice(0, MAX_TABLE);
  const out: Output[] = [
    {
      type: 'table',
      label: T('label.symbolsOf', { shown: shown.length, total: info.symbols.length }),
      columns: [
        T('col.index'),
        T('col.value'),
        T('col.type'),
        T('col.bind'),
        T('col.section'),
        T('col.name'),
      ],
      rows: shown.map(({ s, shown: name }) => [
        s.index,
        hex(s.value),
        s.kind,
        s.bind,
        s.section,
        name,
      ]),
    },
  ];
  if (rows.length > shown.length) {
    out.push({
      type: 'note',
      level: 'info',
      text: T('note.rowsCapped', { shown: shown.length, total: rows.length }),
    });
  }
  return out;
}

export function machoImports(info: MachoInfo, o: Opts): Output[] {
  const out: Output[] = [];
  if (info.dylibs.length) {
    out.push({
      type: 'table',
      label: T('label.libraries'),
      columns: [T('col.kind'), T('col.name'), T('col.version')],
      rows: info.dylibs.map((d) => [d.kind, d.name, d.version]),
    });
  }
  if (info.rpaths.length)
    out.push(
      kvOutput(
        T('kv.rpath'),
        info.rpaths.map((p, i) => [String(i + 1), p]),
      ),
    );
  const test = makeFilter(o.filter);
  const rows = info.symbols.filter((s) => s.undefined && (!test || test(s.name)));
  if (rows.length) {
    out.push({
      type: 'table',
      label: T('label.imported', { count: rows.length }),
      columns: [T('col.name'), T('col.type'), T('col.bind')],
      rows: rows.slice(0, MAX_TABLE).map((s) => [s.name, s.kind, s.bind]),
    });
  }
  return out;
}

export async function machoStrings(ctx: Ctx, info: MachoInfo, o: Opts): Promise<Output[]> {
  const want = o.section.trim();
  const regions: StringRegion[] = [];
  const covered: [number, number][] = [];
  for (const s of info.sections) {
    if (s.size === 0 || s.outside) continue;
    covered.push([s.offset, s.offset + s.size]);
    if (want) {
      if (findSection([s], want) === null) continue;
    } else if (s.exec && !o.code) continue;
    regions.push({ name: `${s.type},${s.name}`, offset: s.offset, size: s.size, wide: false });
  }
  if (!want) {
    for (const [a, b] of uncovered(covered, ctx.r.size)) {
      regions.push({ name: T('value.noSection'), offset: a, size: b - a, wide: false });
    }
  }
  const res = await collectStrings(ctx.r, regions, o.min, makeFilter(o.filter));
  return stringsOutputs(res, o, regions.length);
}
