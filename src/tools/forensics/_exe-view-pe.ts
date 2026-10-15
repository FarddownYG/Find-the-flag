/**
 * What the Executable analyzer shows for a PE / PE32+ file, one function per view.
 */
import type { LazyFile, Output } from '../../core/types';
import { toolT } from '../../i18n/tool-text';
import { formatSize } from '../../lib/bytes';
import { identify } from '../../lib/signatures';
import { Reader, hex, utcDate } from './_exe-bin';
import { MACHINES, SUBSYSTEMS, DLL_CHARACTERISTICS, type PeInfo, type PeResource } from './_exe-pe';
import {
  buildIco,
  decodeStringTable,
  decodeText,
  parseVersionInfo,
  previewOf,
} from './_exe-pe-res';
import { collectStrings, makeFilter, type StringRegion } from './_exe-strings';
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
import { uncovered } from './_exe-view-elf';
import { stringsOutputs } from './_exe-view-strings';

const T = toolT('exe-analyzer');

interface Ctx {
  file: LazyFile;
  r: Reader;
}

const LANGS: Record<number, string> = {
  0: 'neutral',
  0x409: 'en-US',
  0x809: 'en-GB',
  0x40c: 'fr-FR',
  0x407: 'de-DE',
  0x410: 'it-IT',
  0x40a: 'es-ES',
  0xc0a: 'es-ES',
  0x416: 'pt-BR',
  0x816: 'pt-PT',
  0x419: 'ru-RU',
  0x804: 'zh-CN',
  0x404: 'zh-TW',
  0x411: 'ja-JP',
  0x412: 'ko-KR',
  0x415: 'pl-PL',
  0x41f: 'tr-TR',
  0x413: 'nl-NL',
};
const lang = (id: number | null): string =>
  id === null ? '' : `${id}${LANGS[id] ? ` (${LANGS[id]})` : ` (${hex(id)})`}`;

function peKind(info: PeInfo): string {
  if (info.isDriver) return T('peType.driver');
  return info.isDll ? T('peType.dll') : T('peType.exe');
}

function identification(info: PeInfo, size: number): [string, string][] {
  const opt = info.opt;
  const coff = info.coff;
  const e: [string, string][] = [
    [T('kv.format'), `${opt?.plus ? 'PE32+' : 'PE32'}${info.clr ? ' (.NET)' : ''}`],
    [T('kv.type'), peKind(info)],
  ];
  if (coff)
    e.push([
      T('kv.machine'),
      `${MACHINES[coff.machine] ?? T('value.unknown')} (${hex(coff.machine, 4)})`,
    ]);
  if (opt) {
    e.push([
      T('kv.subsystem'),
      `${SUBSYSTEMS[opt.subsystem] ?? T('value.unknown')} (${opt.subsystem})`,
    ]);
    e.push([
      T('kv.entry'),
      opt.entry === 0
        ? T('value.none')
        : `${hex(opt.entry)} (RVA${info.entrySection ? `, ${info.entrySection}` : ''})`,
    ]);
    e.push([T('kv.imageBase'), hex(opt.imageBase)]);
  }
  if (coff) {
    const date = utcDate(coff.timestamp);
    e.push([
      T('kv.timestamp'),
      coff.timestamp === 0 ? T('value.zero') : `${date ?? '?'} (${hex(coff.timestamp)})`,
    ]);
  }
  if (opt) {
    e.push([T('kv.linker'), opt.linker]);
    e.push([T('kv.osVersion'), opt.osVersion]);
  }
  e.push([T('kv.sections'), String(info.sections.length)]);
  if (info.clr) e.push([T('kv.runtime'), `${info.clr.version || '?'} (CLR ${info.clr.runtime})`]);
  const pdb = info.debug.find((d) => d.pdb);
  if (pdb) e.push([T('kv.pdb'), pdb.pdb!]);
  e.push([T('kv.fileSize'), T('value.size', { size: formatSize(size), count: size })]);
  return e;
}

function contents(info: PeInfo): [string, string][] {
  const e: [string, string][] = [];
  if (info.imports.length) {
    e.push([
      T('kv.imports'),
      T('value.importsSummary', { functions: info.importCount, dlls: info.imports.length }),
    ]);
  } else e.push([T('kv.imports'), T('value.none')]);
  if (info.exports) e.push([T('kv.exports'), String(info.exports.rows.length)]);
  if (info.resources.length) e.push([T('kv.resources'), String(info.resources.length)]);
  if (info.rich) {
    e.push([
      T('kv.rich'),
      info.rich.computed === info.rich.key
        ? T('value.richOk', { count: info.rich.entries.length })
        : T('value.richBad'),
    ]);
  }
  if (info.tls) e.push([T('kv.tls'), String(info.tls.callbacks.length)]);
  if (info.certificate)
    e.push([
      T('kv.certificate'),
      T('value.size', { size: formatSize(info.certificate.size), count: info.certificate.size }),
    ]);
  return e;
}

export function peOverview(ctx: Ctx, info: PeInfo): Output[] {
  const out: Output[] = [];
  out.push(kvOutput(T('label.identification'), identification(info, ctx.r.size)));
  out.push(...packedOutputs(info.packed));
  out.push(...noteOutputs(info.hints.filter((h) => h.key !== 'overlay' && h.key !== 'signed')));
  out.push(...securityOutput(info.security));
  if (info.sections.length) out.push(sectionsOutput(info.sections, 'pe', false));
  out.push(kvOutput(T('label.contents'), contents(info)));
  if (info.overlay) out.push(...trailingOutputs(ctx.file, info.overlay, 'overlay'));
  return out;
}

export function peSections(ctx: Ctx, info: PeInfo, o: Opts): Output[] {
  const out: Output[] = [];
  if (info.sections.length) out.push(sectionsOutput(info.sections, 'pe', true));
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

export function peDetails(info: PeInfo): Output[] {
  const out: Output[] = [];
  const coff = info.coff;
  const opt = info.opt;
  out.push(
    kvOutput(T('label.dosHeader'), [
      ['e_lfanew', hex(info.dos.lfanew)],
      [T('kv.dosStub'), info.dos.stub ?? T('value.none')],
      [T('kv.stubSize'), String(info.dos.stubSize)],
    ]),
  );
  if (coff) {
    out.push(
      kvOutput(T('label.coffHeader'), [
        [
          T('kv.machine'),
          `${MACHINES[coff.machine] ?? T('value.unknown')} (${hex(coff.machine, 4)})`,
        ],
        [T('kv.sections'), String(coff.sections)],
        [T('kv.timestamp'), `${utcDate(coff.timestamp) ?? '?'} (${hex(coff.timestamp)})`],
        [T('kv.symbolTable'), `${hex(coff.symbolTable)} (${coff.symbols})`],
        [T('kv.optionalSize'), String(coff.optionalSize)],
        [T('kv.characteristics'), `${hex(coff.characteristics, 4)}: ${coff.flags.join(' | ')}`],
      ]),
    );
  }
  if (opt) {
    out.push(
      kvOutput(T('label.optionalHeader'), [
        [T('kv.format'), `${hex(opt.magic, 3)} (${opt.plus ? 'PE32+' : 'PE32'})`],
        [T('kv.linker'), opt.linker],
        [T('kv.sizeOfCode'), hex(opt.sizeOfCode)],
        [T('kv.entry'), hex(opt.entry)],
        [T('kv.baseOfCode'), hex(opt.baseOfCode)],
        [T('kv.imageBase'), hex(opt.imageBase)],
        [T('kv.alignment'), `${hex(opt.sectionAlignment)} / ${hex(opt.fileAlignment)}`],
        [T('kv.osVersion'), opt.osVersion],
        [T('kv.imageVersion'), opt.imageVersion],
        [T('kv.subsystemVersion'), opt.subsystemVersion],
        [T('kv.sizeOfImage'), hex(opt.sizeOfImage)],
        [T('kv.sizeOfHeaders'), hex(opt.sizeOfHeaders)],
        [T('kv.checksum'), hex(opt.checksum)],
        [
          T('kv.subsystem'),
          `${SUBSYSTEMS[opt.subsystem] ?? T('value.unknown')} (${opt.subsystem})`,
        ],
        [
          T('kv.dllCharacteristics'),
          `${hex(opt.dllCharacteristics, 4)}: ${DLL_CHARACTERISTICS.filter(
            ([bit]) => opt.dllCharacteristics & bit,
          )
            .map(([, name, gloss]) => (gloss ? `${name} (${gloss})` : name))
            .join(', ')}`,
        ],
        [T('kv.stack'), `${hex(opt.stackReserve)} / ${hex(opt.stackCommit)}`],
        [T('kv.heap'), `${hex(opt.heapReserve)} / ${hex(opt.heapCommit)}`],
      ]),
    );
  }
  if (info.dirs.length) {
    out.push({
      type: 'table',
      label: T('label.directories'),
      columns: [T('col.index'), T('col.name'), T('col.rva'), T('col.size')],
      rows: info.dirs
        .filter((d) => d.rva !== 0 || d.size !== 0)
        .map((d) => [d.index, d.name, hex(d.rva), hex(d.size)]),
    });
  }
  if (info.rich) {
    const rich = info.rich;
    out.push({
      type: 'table',
      label: T('label.rich', {
        key: hex(rich.key, 8),
        check: rich.computed === rich.key ? T('value.checkOk') : T('value.checkBad'),
      }),
      columns: [T('col.productId'), T('col.build'), T('col.count')],
      rows: rich.entries.map((e) => [`${e.productId} (${hex(e.productId, 4)})`, e.build, e.count]),
    });
    out.push({ type: 'note', level: 'info', text: T('note.richIds') });
  }
  if (info.debug.length) {
    out.push({
      type: 'table',
      label: T('label.debug'),
      columns: [T('col.type'), T('col.timestamp'), T('col.size')],
      rows: info.debug.map((d) => [d.type, utcDate(d.timestamp) ?? hex(d.timestamp), d.size]),
    });
    for (const d of info.debug.filter((x) => x.pdb)) {
      out.push(
        kvOutput(T('label.codeview', { format: d.format ?? '' }), [
          [T('kv.pdb'), d.pdb ?? ''],
          [T('kv.guid'), d.guid ?? ''],
          [T('kv.age'), String(d.age ?? 0)],
        ]),
      );
    }
  }
  if (info.tls) {
    out.push({
      type: 'table',
      label: T('label.tls', { count: info.tls.callbacks.length }),
      columns: [T('col.rva'), T('col.section')],
      rows: info.tls.callbacks.map((c) => [hex(c.rva), c.section]),
    });
  }
  if (info.clr) {
    const clr = info.clr;
    out.push(
      kvOutput(T('label.clr'), [
        [T('kv.runtime'), `${clr.version || '?'}`],
        [T('kv.clrVersion'), clr.runtime],
        [T('kv.flags'), hex(clr.flags)],
        [T('kv.entryToken'), hex(clr.entryPointToken, 8)],
      ]),
    );
    if (clr.streams.length) {
      out.push({
        type: 'table',
        label: T('label.clrStreams'),
        columns: [T('col.name'), T('col.offset'), T('col.size')],
        rows: clr.streams.map((s) => [s.name, hex(s.offset), s.size]),
      });
    }
    if (clr.userStrings.length) {
      out.push({
        type: 'table',
        label: T('label.userStrings', { count: clr.userStrings.length }),
        columns: [T('col.index'), T('col.string')],
        rows: clr.userStrings.map((s, i) => [i + 1, s]),
        highlight: [],
      });
    }
  }
  if (info.certificate) {
    out.push(
      kvOutput(T('label.certificate'), [
        [T('kv.offset'), hex(info.certificate.offset)],
        [
          T('kv.size'),
          T('value.size', {
            size: formatSize(info.certificate.size),
            count: info.certificate.size,
          }),
        ],
      ]),
    );
  }
  return out;
}

export function peSymbols(info: PeInfo, o: Opts): Output[] {
  const ex = info.exports;
  if (!ex || ex.rows.length === 0)
    return [{ type: 'note', level: 'info', text: T('note.noExports') }];
  const test = makeFilter(o.filter);
  const rows = ex.rows.filter((r) => !test || test(r.name ?? '') || test(r.forwarder ?? ''));
  const out: Output[] = [
    kvOutput(T('label.exportDirectory'), [
      [T('kv.name'), ex.dllName],
      [T('kv.timestamp'), utcDate(ex.timestamp) ?? hex(ex.timestamp)],
      [T('kv.ordinalBase'), String(ex.base)],
      [T('kv.functions'), `${ex.count} (${ex.named} named)`],
    ]),
    {
      type: 'table',
      label: T('label.exports', { shown: Math.min(rows.length, MAX_TABLE), total: ex.rows.length }),
      columns: [T('col.ordinal'), T('col.rva'), T('col.name'), T('col.forwarder')],
      rows: rows
        .slice(0, MAX_TABLE)
        .map((r) => [r.ordinal, hex(r.rva), r.name ?? '', r.forwarder ?? '']),
    },
  ];
  return out;
}

export function peImports(info: PeInfo, o: Opts): Output[] {
  if (info.imports.length === 0)
    return [{ type: 'note', level: 'info', text: T('note.noImports') }];
  const test = makeFilter(o.filter);
  const out: Output[] = [
    {
      type: 'table',
      label: T('label.importDlls', { count: info.imports.length }),
      columns: [T('col.dll'), T('col.count'), T('col.kind')],
      rows: info.imports.map((i) => [
        i.dll,
        i.functions.length,
        i.kind === 'delay' ? T('value.delayLoad') : T('value.normal'),
      ]),
    },
  ];
  const rows: (string | number)[][] = [];
  for (const imp of info.imports) {
    for (const f of imp.functions) {
      const name = f.name ?? `#${f.ordinal ?? '?'}`;
      if (test && !test(name) && !test(imp.dll)) continue;
      rows.push([
        imp.dll,
        name,
        f.ordinal ?? '',
        f.hint ?? '',
        imp.kind === 'delay' ? T('value.delayLoad') : '',
      ]);
    }
  }
  out.push({
    type: 'table',
    label: T('label.importFunctions', {
      shown: Math.min(rows.length, MAX_TABLE),
      total: info.importCount,
    }),
    columns: [T('col.dll'), T('col.function'), T('col.ordinal'), T('col.hint'), T('col.kind')],
    rows: rows.slice(0, MAX_TABLE),
  });
  if (rows.length > MAX_TABLE) {
    out.push({
      type: 'note',
      level: 'info',
      text: T('note.rowsCapped', { shown: MAX_TABLE, total: rows.length }),
    });
  }
  return out;
}

const MAX_DECODE = 1 << 20;
const MAX_FILES = 200;
const EXT_BY_SIG = new Set([
  'png',
  'jpg',
  'gif',
  'zip',
  'gz',
  'pdf',
  'exe',
  'dll',
  'elf',
  'xml',
  '7z',
  'rar',
  'bmp',
]);

async function readRes(ctx: Ctx, res: PeResource, cap: number): Promise<Uint8Array> {
  if (res.offset === null) return new Uint8Array(0);
  return ctx.file.read(res.offset, Math.min(res.size, cap));
}

const safe = (s: string): string => s.replace(/[^A-Za-z0-9_.-]+/g, '_');

export async function peResources(ctx: Ctx, info: PeInfo): Promise<Output[]> {
  if (info.resources.length === 0)
    return [{ type: 'note', level: 'info', text: T('note.noResources') }];
  const out: Output[] = [];
  const previews: string[] = [];
  const heads: Uint8Array[] = [];
  for (const [i, res] of info.resources.entries()) {
    if (i < 400) {
      const head = await readRes(ctx, res, 96);
      heads.push(head);
      previews.push(previewOf(head));
    } else {
      heads.push(new Uint8Array(0));
      previews.push('');
    }
  }
  out.push({
    type: 'table',
    label: T('label.resourceTree', { count: info.resources.length }),
    columns: [
      T('col.type'),
      T('col.name'),
      T('col.language'),
      T('col.size'),
      T('col.offset'),
      T('col.preview'),
    ],
    rows: info.resources.map((r, i) => [
      r.type,
      r.name,
      lang(r.lang),
      r.size,
      r.offset === null ? T('value.outsideFile') : hex(r.offset),
      previews[i]!,
    ]),
  });

  // manifest, version info, string tables
  for (const res of info.resources) {
    if (res.typeId === 24 && res.offset !== null) {
      const text = decodeText(await readRes(ctx, res, 65536));
      out.push({ type: 'text', label: T('label.manifest', { name: res.name }), value: text });
    }
  }
  for (const res of info.resources) {
    if (res.typeId !== 16 || res.offset === null) continue;
    const v = parseVersionInfo(await readRes(ctx, res, MAX_DECODE));
    if (!v) continue;
    const entries: [string, string][] = [];
    if (v.fileVersion) entries.push([T('kv.fileVersion'), v.fileVersion]);
    if (v.productVersion) entries.push([T('kv.productVersion'), v.productVersion]);
    entries.push(...v.strings);
    if (v.translations.length) entries.push([T('kv.translation'), v.translations.join(', ')]);
    out.push(kvOutput(T('label.versionInfo'), entries));
  }
  const strings: string[] = [];
  for (const res of info.resources) {
    if (res.typeId !== 6 || res.offset === null || res.nameId === null) continue;
    for (const [id, text] of decodeStringTable(await readRes(ctx, res, 65536), res.nameId)) {
      strings.push(`${id}: ${text}`);
    }
  }
  if (strings.length) {
    out.push({
      type: 'text',
      label: T('label.stringTable', { count: strings.length }),
      value: strings.join('\n'),
    });
  }

  // files: icons rebuilt as .ico, everything else as it is
  const files: Extract<Output, { type: 'files' }>['files'] = [];
  const icons = new Map<number, Uint8Array>();
  for (const res of info.resources) {
    if (res.typeId === 3 && res.nameId !== null && res.offset !== null) {
      icons.set(res.nameId, await readRes(ctx, res, MAX_DECODE));
    }
  }
  for (const res of info.resources) {
    if (res.typeId !== 14 || res.offset === null) continue;
    const ico = buildIco(await readRes(ctx, res, 65536), icons);
    if (ico) {
      files.push({
        name: `icon_${safe(res.name)}.ico`,
        data: ico,
        note: `${T('value.rebuiltIcon')} - ${formatSize(ico.length)}`,
      });
    }
  }
  const handled = new Set([3, 14, 1, 12, 24, 16, 6]);
  let extra = 0;
  for (const [i, res] of info.resources.entries()) {
    if ((res.typeId !== null && handled.has(res.typeId)) || res.offset === null || res.size === 0)
      continue;
    if (files.length >= MAX_FILES) {
      extra++;
      continue;
    }
    const head = heads[i]!;
    const sig = identify(head).find((s) => !s.weak);
    const printable = previews[i]!.length > 0 && !/^([0-9a-f]{2} ?)+$/.test(previews[i]!);
    const ext = sig && EXT_BY_SIG.has(sig.ext) ? sig.ext : printable ? 'txt' : 'bin';
    files.push({
      name: `${safe(res.type)}_${safe(res.name)}${res.lang ? `_${res.lang}` : ''}.${ext}`,
      data: new Uint8Array(0),
      blob: ctx.file.blob.slice(res.offset, res.offset + res.size),
      note: `${res.type} - ${formatSize(res.size)}`,
    });
  }
  if (files.length)
    out.push({ type: 'files', label: T('label.extracted', { count: files.length }), files });
  if (extra > 0)
    out.push({
      type: 'note',
      level: 'warn',
      text: T('note.filesCapped', { shown: MAX_FILES, total: MAX_FILES + extra }),
    });
  return out;
}

export async function peStrings(ctx: Ctx, info: PeInfo, o: Opts): Promise<Output[]> {
  const want = o.section.trim();
  const regions: StringRegion[] = [];
  const covered: [number, number][] = [];
  for (const s of info.sections) {
    if (s.size === 0 || s.outside) continue;
    covered.push([s.offset, s.offset + s.size]);
    if (want) {
      if (findSection([s], want) === null) continue;
    } else if (s.exec && !o.code) continue;
    regions.push({ name: s.name, offset: s.offset, size: s.size, wide: true });
  }
  if (!want) {
    if (info.overlay)
      regions.push({
        name: T('value.overlay'),
        offset: info.overlay.offset,
        size: info.overlay.size,
        wide: true,
      });
    if (info.overlay) covered.push([info.overlay.offset, info.overlay.offset + info.overlay.size]);
    for (const [a, b] of uncovered(covered, ctx.r.size)) {
      regions.push({ name: T('value.noSection'), offset: a, size: b - a, wide: true });
    }
  }
  const res = await collectStrings(ctx.r, regions, o.min, makeFilter(o.filter));
  return stringsOutputs(res, o, regions.length);
}
