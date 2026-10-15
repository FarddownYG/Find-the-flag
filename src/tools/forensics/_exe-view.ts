/**
 * Output blocks shared by the three formats: findings, the security table, section tables,
 * trailing data. Every sentence goes through a translation key.
 */
import type { LazyFile, Output } from '../../core/types';
import { tOr } from '../../i18n';
import { signatureName, toolT } from '../../i18n/tool-text';
import { formatSize } from '../../lib/bytes';
import { entropyText, hex } from './_exe-bin';
import type { Note, NoteKey, SecId, SecItem, SectionRow, SecState, Trailing } from './_exe-types';

const T = toolT('exe-analyzer');

export interface Opts {
  view: string;
  filter: string;
  min: number;
  section: string;
  code: boolean;
  demangle: boolean;
}

/** The translated name of another tool, for the hints that point at it. */
export const toolLabel = (id: string): string => tOr(`tool.${id}.name`, id);

type P = Record<string, string | number>;

const NOTES: Record<NoteKey, (p: P) => string> = {
  truncatedHeader: (p) => T('note.truncatedHeader', p),
  badIdent: (p) => T('note.badIdent', p),
  tableTruncated: (p) => T('note.tableTruncated', p),
  tableOutside: (p) => T('note.tableOutside', p),
  noSections: (p) => T('note.noSections', p),
  sectionsBeyondFile: (p) => T('note.sectionsBeyondFile', p),
  capped: (p) => T('note.capped', p),
  stripped: (p) => T('note.stripped', p),
  noDynamic: (p) => T('note.noDynamic', p),
  staticLinked: (p) => T('note.staticLinked', p),
  hasDebugInfo: (p) => T('note.hasDebugInfo', p),
  goBinary: (p) => T('note.goBinary', p),
  rpath: (p) => T('note.rpath', p),
  execStack: (p) => T('note.execStack', p),
  dosOnly: (p) => T('note.dosOnly', p),
  peOutsideFile: (p) => T('note.peOutsideFile', p),
  badOptionalMagic: (p) => T('note.badOptionalMagic', p),
  dotNet: (p) => T('note.dotNet', { ...p, tool: toolLabel('strings') }),
  richBad: (p) => T('note.richBad', p),
  tlsCallbacks: (p) => T('note.tlsCallbacks', p),
  signed: (p) => T('note.signed', p),
  overlay: (p) => T('note.overlay', p),
  timestampOdd: (p) => T('note.timestampOdd', p),
  epOutsideSections: (p) => T('note.epOutsideSections', p),
  entryWritableSection: (p) => T('note.entryWritableSection', p),
  looksPacked: () => T('note.looksPacked'),
  maybePacked: () => T('note.maybePacked'),
  packedUpx: (p) => T('note.packedUpx', p),
  packedSection: (p) => T('note.packedSection', p),
  packedEntropy: (p) => T('note.packedEntropy', { ...p, tool: toolLabel('entropy') }),
  packedFewImports: (p) => T('note.packedFewImports', p),
  packedEmptyRaw: (p) => T('note.packedEmptyRaw', p),
  packedNoSections: (p) => T('note.packedNoSections', p),
  fatBinary: (p) => T('note.fatBinary', p),
  encrypted: (p) => T('note.encrypted', p),
  machoLoadTruncated: (p) => T('note.machoLoadTruncated', p),
};

const TABLE_NAMES: Record<string, () => string> = {
  'program headers': () => T('table.programHeaders'),
  'section headers': () => T('table.sectionHeaders'),
  'section table': () => T('table.sectionTable'),
  directory: () => T('table.directory'),
  'resource directory': () => T('table.resources'),
  sections: () => T('table.sections'),
  symbols: () => T('table.symbols'),
  exports: () => T('table.exports'),
  symtab: () => T('table.symtab'),
  dynsym: () => T('table.dynsym'),
};

export function noteText(n: Note): string {
  const params: P = { ...n.params };
  // Names of tables are English words in the parsers: show them translated.
  for (const key of ['table', 'what'] as const) {
    const v = params[key];
    if (typeof v === 'string' && TABLE_NAMES[v]) params[key] = TABLE_NAMES[v]!();
  }
  return NOTES[n.key](params);
}

export function noteOutputs(notes: Note[]): Output[] {
  return notes.map((n) => ({ type: 'note', level: n.level, text: noteText(n) }));
}

/** The "looks packed" verdict and the signs it rests on. */
export function packedOutputs(signals: Note[]): Output[] {
  if (signals.length === 0) return [];
  const strong = signals.some((s) => s.key === 'packedUpx' || s.key === 'packedSection');
  const verdict = strong || signals.length >= 2;
  return [
    {
      type: 'note',
      level: verdict ? 'warn' : 'info',
      text: verdict ? T('note.looksPacked') : T('note.maybePacked'),
    },
    {
      type: 'text',
      label: T('label.packingSigns'),
      value: signals.map((s) => `- ${noteText(s)}`).join('\n'),
    },
  ];
}

const SEC_LABELS: Record<SecId, () => string> = {
  nx: () => T('sec.nx'),
  pie: () => T('sec.pie'),
  relro: () => T('sec.relro'),
  canary: () => T('sec.canary'),
  fortify: () => T('sec.fortify'),
  rpath: () => T('sec.rpath'),
  runpath: () => T('sec.runpath'),
  ibt: () => T('sec.ibt'),
  shstk: () => T('sec.shstk'),
  bti: () => T('sec.bti'),
  pac: () => T('sec.pac'),
  aslr: () => T('sec.aslr'),
  highEntropyVa: () => T('sec.highEntropyVa'),
  dep: () => T('sec.dep'),
  cfg: () => T('sec.cfg'),
  noSeh: () => T('sec.noSeh'),
  forceIntegrity: () => T('sec.forceIntegrity'),
  appContainer: () => T('sec.appContainer'),
  signature: () => T('sec.signature'),
  cookie: () => T('sec.cookie'),
  nxHeap: () => T('sec.nxHeap'),
  codeSignature: () => T('sec.codeSignature'),
  encryption: () => T('sec.encryption'),
};

const STATES: Record<SecState, () => string> = {
  enabled: () => T('state.enabled'),
  disabled: () => T('state.disabled'),
  partial: () => T('state.partial'),
  full: () => T('state.full'),
  unknown: () => T('state.unknown'),
  info: () => T('state.info'),
};

export function securityOutput(items: SecItem[]): Output[] {
  if (items.length === 0) return [];
  return [
    {
      type: 'table',
      label: T('label.security'),
      columns: [T('col.property'), T('col.state'), T('col.detail')],
      rows: items.map((i) => [SEC_LABELS[i.id](), STATES[i.state](), i.detail ?? '']),
    },
  ];
}

export const MAX_TABLE = 5000;

/** Section rows for the overview (short) or the sections view (all columns). */
export function sectionsOutput(
  rows: SectionRow[],
  style: 'elf' | 'pe' | 'macho',
  full: boolean,
): Output {
  const label = T('label.sections', { count: rows.length });
  const shown = rows.slice(0, MAX_TABLE);
  const flagged = (r: SectionRow) => (r.outside ? `${r.name} ⚠` : r.name);
  if (style === 'pe') {
    return {
      type: 'table',
      label,
      columns: full
        ? [
            T('col.index'),
            T('col.name'),
            T('col.rva'),
            T('col.virtualSize'),
            T('col.offset'),
            T('col.rawSize'),
            T('col.flags'),
            T('col.entropy'),
            T('col.characteristics'),
          ]
        : [
            T('col.name'),
            T('col.rva'),
            T('col.virtualSize'),
            T('col.rawSize'),
            T('col.flags'),
            T('col.entropy'),
          ],
      rows: shown.map((r) =>
        full
          ? [
              r.index,
              flagged(r),
              hex(r.addr),
              hex(r.vsize),
              hex(r.offset),
              hex(r.size),
              r.flags,
              entropyText(r.entropy),
              r.detail ?? '',
            ]
          : [flagged(r), hex(r.addr), hex(r.vsize), hex(r.size), r.flags, entropyText(r.entropy)],
      ),
    };
  }
  if (style === 'macho') {
    return {
      type: 'table',
      label,
      columns: full
        ? [
            T('col.index'),
            T('col.name'),
            T('col.segment'),
            T('col.address'),
            T('col.offset'),
            T('col.size'),
            T('col.flags'),
            T('col.entropy'),
          ]
        : [
            T('col.name'),
            T('col.segment'),
            T('col.address'),
            T('col.size'),
            T('col.flags'),
            T('col.entropy'),
          ],
      rows: shown.map((r) =>
        full
          ? [
              r.index,
              flagged(r),
              r.type,
              hex(r.addr),
              hex(r.offset),
              hex(r.size),
              r.flags,
              entropyText(r.entropy),
            ]
          : [flagged(r), r.type, hex(r.addr), hex(r.size), r.flags, entropyText(r.entropy)],
      ),
    };
  }
  return {
    type: 'table',
    label,
    columns: full
      ? [
          T('col.index'),
          T('col.name'),
          T('col.type'),
          T('col.address'),
          T('col.offset'),
          T('col.size'),
          T('col.flags'),
          T('col.entropy'),
        ]
      : [
          T('col.name'),
          T('col.type'),
          T('col.address'),
          T('col.size'),
          T('col.flags'),
          T('col.entropy'),
        ],
    rows: shown.map((r) =>
      full
        ? [
            r.index,
            flagged(r),
            r.type,
            hex(r.addr),
            hex(r.offset),
            hex(r.size),
            r.flags,
            entropyText(r.entropy),
          ]
        : [flagged(r), r.type, hex(r.addr), hex(r.size), r.flags, entropyText(r.entropy)],
    ),
  };
}

/** Find a section by name (exact, then case-insensitive) or by `#index`. */
export function findSection(rows: SectionRow[], query: string): SectionRow | null {
  const q = query.trim();
  if (q === '') return null;
  const byIndex = /^#?(\d+)$/.exec(q);
  if (byIndex) return rows.find((r) => r.index === Number(byIndex[1])) ?? null;
  return (
    rows.find((r) => r.name === q) ??
    rows.find((r) => r.name.toLowerCase() === q.toLowerCase()) ??
    null
  );
}

const safeName = (s: string): string =>
  s.replace(/^[.#]+/, '').replace(/[^A-Za-z0-9_.-]+/g, '_') || 'section';

/** A section's bytes as a downloadable file (a Blob slice: nothing is copied). */
export function sectionFile(file: LazyFile, row: SectionRow): Output {
  return {
    type: 'files',
    label: T('label.sectionDump', { name: row.name }),
    files: [
      {
        name: `${safeName(row.name)}.bin`,
        data: new Uint8Array(0),
        blob: file.blob.slice(row.offset, row.offset + row.size),
        note: T('value.bytesAt', { size: formatSize(row.size), offset: hex(row.offset) }),
      },
    ],
  };
}

/** Data after the end of what the headers describe: where, how big, what it looks like, download. */
export function trailingOutputs(
  file: LazyFile,
  tr: Trailing,
  kind: 'overlay' | 'appended',
): Output[] {
  const type = tr.magic
    ? signatureName(tr.magic)
    : tr.text !== null
      ? T('value.text')
      : T('value.unknown');
  const entries: [string, string][] = [
    [T('kv.offset'), hex(tr.offset)],
    [T('kv.size'), T('value.size', { size: formatSize(tr.size), count: tr.size })],
    [T('kv.looksLike'), type],
    [T('kv.startsWith'), tr.head],
  ];
  if (tr.entropy !== null) entries.push([T('kv.entropy'), tr.entropy.toFixed(2)]);
  if (tr.text !== null) entries.push([T('kv.text'), tr.text]);
  const label = kind === 'overlay' ? T('label.overlay') : T('label.appended');
  return [
    { type: 'kv', label, entries },
    {
      type: 'files',
      label: T('label.download'),
      files: [
        {
          name: kind === 'overlay' ? 'overlay.bin' : 'appended.bin',
          data: new Uint8Array(0),
          blob: file.blob.slice(tr.offset, tr.offset + tr.size),
          note: T('value.bytesAt', { size: formatSize(tr.size), offset: hex(tr.offset) }),
        },
      ],
    },
    {
      type: 'note',
      level: 'info',
      text: T('hint.trailing', {
        carve: toolLabel('carve'),
        entropy: toolLabel('entropy'),
        binary: toolLabel('binary-analyzer'),
      }),
    },
  ];
}

export function kvOutput(label: string, entries: [string, string][]): Output {
  return { type: 'kv', label, entries };
}
