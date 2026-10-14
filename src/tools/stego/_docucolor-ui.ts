/**
 * What the two DocuColor tools ("Printer dots — DocuColor matrix" and "Printer tracking dots")
 * show and ask the same way: the column-mapping options, the column table and the wording.
 * Format facts and their sources are in _docucolor.ts.
 */
import { number, select, text, toggle } from '../../core/define';
import { ToolError } from '../../core/errors';
import type { Output } from '../../core/types';
import { toolT } from '../../i18n/tool-text';
import {
  COLS,
  DEFAULT_MAPPING,
  MAKER_COLUMN,
  ORIENTATIONS,
  centuryText,
  describeOrientation,
  mappedColumns,
  mappingProblem,
  orientationKey,
  type Decoded,
  type DocuFields,
  type Mapping,
  type Orientation,
  type ParityResult,
} from './_docucolor';

/** Runtime text of both tools lives under the DocuColor tool's keys. */
const T = toolT('docucolor');

export const MAPPING_HINT =
  'EFF layout: 2 minute, 5 hour, 6 day, 7 month, 8 year, 14-13-12-11 serial.';

export const p2 = (n: number) => String(n).padStart(2, '0');
export const printed = (f: DocuFields) =>
  `${f.year}-${p2(f.month)}-${p2(f.day)} ${p2(f.hour)}:${p2(f.minute)}`;
const list = (key: string, xs: number[]) =>
  xs.length ? T(key, { count: xs.length, list: xs.join(', ') }) : '';

/** "rows 4, 6, column 5" (1-based, EFF numbering). */
export const parityText = (p: ParityResult) =>
  [list('value.bad-rows', p.badRows), list('value.bad-cols', p.badCols)].filter(Boolean).join(', ');

/** Table-cell form: "OK" or "FAIL r4,6 c5". */
export const parityCell = (p: ParityResult) =>
  p.ok
    ? T('value.cell-ok')
    : T('value.cell-fail', {
        detail: `${p.badRows.length ? ` r${p.badRows.join(',')}` : ''}${p.badCols.length ? ` c${p.badCols.join(',')}` : ''}`,
      });

/** The date, or a dash when the columns are not a date (the table keeps the raw values). */
export const dateText = (d: Decoded) => (d.dateOk ? printed(d.fields) : '—');
export const serialText = (d: Decoded) => (d.serialOk ? d.fields.serial : '—');

/**
 * Short orientation names for narrow table cells: "as given", "90° cw", "180°", "90° ccw",
 * "mirror", "mirror + 90° cw", "flip top-bottom", "mirror + 90° ccw".
 */
export function shortOrientation(o: Orientation): string {
  return T(`value.orientation-short.${orientationKey(o)}`);
}

export const orientationChoices = (auto: string) => [
  { value: 'auto', label: auto },
  ...ORIENTATIONS.map((o) => ({ value: orientationKey(o), label: describeOrientation(o) })),
];

// ---------- mapping options ----------

const CENTURY_CHOICES = [
  { value: 'pivot', label: 'Auto: 69–99 → 19xx, 00–68 → 20xx' },
  { value: '2000', label: 'Always 20xx' },
  { value: '1900', label: 'Always 19xx' },
] as const;

type ShowIf = (v: Record<string, unknown>) => boolean;

/** Column mapping and century options (hidden unless `showIf`, when given). */
export function mappingOptions(showIf?: ShowIf) {
  const at = <T extends object>(extra: T): T & { showIf?: ShowIf } =>
    showIf ? { ...extra, showIf } : extra;
  return {
    minuteCol: number(
      'Minute column',
      DEFAULT_MAPPING.minute,
      at({ min: 2, max: COLS, hint: MAPPING_HINT }),
    ),
    hourCol: number('Hour column', DEFAULT_MAPPING.hour, at({ min: 2, max: COLS })),
    dayCol: number('Day column', DEFAULT_MAPPING.day, at({ min: 2, max: COLS })),
    monthCol: number('Month column', DEFAULT_MAPPING.month, at({ min: 2, max: COLS })),
    yearCol: number('Year column', DEFAULT_MAPPING.year, at({ min: 2, max: COLS })),
    serialCols: text(
      'Serial columns',
      DEFAULT_MAPPING.serialColumns.join(', '),
      at({
        placeholder: '14, 13, 12, 11',
        hint: 'Most significant first, two decimal digits per column. EFF: 14, 13, 12, 11 (eight digits; DEDA calls them "printer"). DEDA’s six-digit "serial" is 13, 12, 11.',
      }),
    ),
    century: select(
      'Century',
      CENTURY_CHOICES,
      'pivot',
      at({
        hint: 'The tile holds two year digits and no century. Auto picks the century closest to 2018, as DEDA does.',
      }),
    ),
  };
}

export function parityOption(showIf?: ShowIf) {
  return toggle(
    'Parity',
    [
      { value: 'odd', label: 'Odd' },
      { value: 'even', label: 'Even' },
    ],
    'odd',
    {
      hint: 'Odd, as the EFF and DEDA: every column, and every row but the top one, holds an odd number of dots. Try Even if nothing passes.',
      ...(showIf ? { showIf } : {}),
    },
  );
}

export interface MappingValues {
  minuteCol: number;
  hourCol: number;
  dayCol: number;
  monthCol: number;
  yearCol: number;
  serialCols: string;
  century: 'pivot' | '2000' | '1900';
}

/** The mapping the options describe, or what is wrong with it. */
export function readMapping(o: MappingValues): { mapping: Mapping } | { problem: string } {
  const parts = o.serialCols.split(/[\s,;]+/).filter(Boolean);
  const bad = parts.find((p) => !Number.isInteger(Number(p)));
  if (bad !== undefined) return { problem: T('error.serial-columns', { value: bad }) };
  const mapping: Mapping = {
    minute: o.minuteCol,
    hour: o.hourCol,
    day: o.dayCol,
    month: o.monthCol,
    year: o.yearCol,
    serialColumns: parts.map(Number),
    century: o.century === 'pivot' ? 'pivot' : o.century === '1900' ? 1900 : 2000,
  };
  const problem = mappingProblem(mapping);
  return problem ? { problem } : { mapping };
}

/** The mapping the options describe; a ToolError when it is not usable. */
export function mappingFrom(o: MappingValues): Mapping {
  const r = readMapping(o);
  if ('problem' in r) throw new ToolError(r.problem);
  return r.mapping;
}

/** "minute 3, century 19xx": where the mapping departs from the EFF layout (null if nowhere). */
export function mappingDiff(m: Mapping): string | null {
  const d = DEFAULT_MAPPING;
  const parts: string[] = [];
  if (m.minute !== d.minute) parts.push(T('value.diff.minute', { col: m.minute }));
  if (m.hour !== d.hour) parts.push(T('value.diff.hour', { col: m.hour }));
  if (m.day !== d.day) parts.push(T('value.diff.day', { col: m.day }));
  if (m.month !== d.month) parts.push(T('value.diff.month', { col: m.month }));
  if (m.year !== d.year) parts.push(T('value.diff.year', { col: m.year }));
  if (m.serialColumns.join() !== d.serialColumns.join())
    parts.push(T('value.diff.serial', { cols: m.serialColumns.join(', ') }));
  if (m.century !== d.century)
    parts.push(T('value.diff.century', { century: centuryText(m.century) }));
  return parts.length ? parts.join('; ') : null;
}

/** An info note when the mapping is not the EFF one, so a reading is never taken for EFF's. */
export function mappingNote(m: Mapping): Output | null {
  const diff = mappingDiff(m);
  return diff
    ? {
        type: 'note',
        level: 'info',
        text: T('note.custom-mapping', { diff }),
      }
    : null;
}

// ---------- outputs ----------

export function columnTable(d: Decoded, mapping: Mapping): Output {
  const mapped = mappedColumns(mapping);
  const bad = new Set(d.parity.badCols);
  const highlight: number[] = [];
  const rows = d.columns.map((c, i) => {
    if (mapped.has(c.col)) highlight.push(i);
    return [
      c.col,
      c.field,
      c.bits,
      c.col === 1 ? '—' : c.value,
      bad.has(c.col) ? T('value.bad') : T('value.ok'),
    ];
  });
  return {
    type: 'table',
    label: T('label.columns', { century: centuryText(mapping.century) }),
    columns: [T('col.col'), T('col.field'), T('col.bits'), T('col.value'), T('col.parity')],
    rows,
    highlight,
  };
}

/** DEDA's maker reading of column 4, when it says something beyond the usual Xerox. */
export function makerNote(d: Decoded): Output | null {
  if (d.maker === 'Dell')
    return {
      type: 'note',
      level: 'info',
      text: T('note.maker-dell', { col: MAKER_COLUMN }),
    };
  if (d.maker === 'Epson')
    return {
      type: 'note',
      level: 'info',
      text: T('note.maker-epson', { col: MAKER_COLUMN }),
    };
  return null;
}
