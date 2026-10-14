import { bool, defineTool, select, toggle } from '../../core/define';
import { ToolError } from '../../core/errors';
import type { Output } from '../../core/types';
import { toolT } from '../../i18n/tool-text';
import {
  COLS,
  ROWS,
  SEPARATOR_COLUMN,
  bestOrientations,
  centuryText,
  decodeDocuColor,
  encodeDocuColor,
  fieldLabel,
  mappedColumns,
  matrixToText,
  orientationKey,
  orientationText,
  parityCheck,
  parseMatrixText,
  renderMatrix,
  singleDotFix,
  yearRange,
  type DocuFields,
} from './_docucolor';
import {
  columnTable,
  dateText,
  makerNote,
  mappingFrom,
  mappingNote,
  mappingOptions,
  orientationChoices,
  parityCell,
  parityOption,
  parityText,
  printed,
  serialText,
  shortOrientation,
} from './_docucolor-ui';

// Column layout and parity convention: EFF "DocuColor Tracking Dot Decoding Guide"
// (https://w2.eff.org/Privacy/printers/docucolor/) and DEDA (https://github.com/dfd-tud/deda).
// Details and the reasoning behind the parity rule are in _docucolor.ts.

const T = toolT('docucolor');

/**
 * Encode input: 'YYYY-MM-DD HH:MM' (or with a T) and optional serial digits, in any order; the
 * words "Printed" / "Serial" are allowed, so the decoder's own output can be pasted back.
 * Date and time are checked against the calendar.
 */
function parseEncodeInput(s: string): DocuFields {
  const m = /(\d{4})-(\d{1,2})-(\d{1,2})[ T]+(\d{1,2}):(\d{1,2})/.exec(s);
  if (!m) {
    throw new ToolError(
      `${T('error.encode-help')} ${T('error.encode-got', { got: s.trim().slice(0, 40) })}`,
    );
  }
  const rest = `${s.slice(0, m.index)} ${s.slice(m.index + m[0].length)}`
    .replace(/printed|serial|:/gi, ' ')
    .trim();
  if (!/^[\d\s-]*$/.test(rest))
    throw new ToolError(T('error.serial-not-digits', { got: rest.slice(0, 40) }));
  const when = m[0];
  const [year, month, day, hour, minute] = m.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  const real = new Date(Date.UTC(year, month - 1, day));
  if (month < 1 || month > 12 || real.getUTCDate() !== day || real.getUTCMonth() !== month - 1)
    throw new ToolError(T('error.not-a-date', { when }));
  if (hour > 23 || minute > 59) throw new ToolError(T('error.not-a-time', { when }));
  return { year, month, day, hour, minute, serial: rest.replace(/[\s-]/g, '') };
}

export default defineTool({
  id: 'docucolor',
  name: 'Printer dots — DocuColor matrix',
  category: 'stego',
  description:
    'Decode or build the Xerox DocuColor yellow-dot tracking grid (15 × 8): print date, time and printer serial, with parity check.',
  tags: [
    'yellow dots',
    'tracking dots',
    'machine identification code',
    'MIC',
    'printer steganography',
    'Xerox',
    'EFF',
    'DEDA',
    'points jaunes',
    'imprimante',
  ],
  input: 'text',
  placeholder:
    'Decode: the dot grid, one row per line, 8 rows × 15 columns (or 15 × 8), 1/0, x/. or ●/·\nEncode: YYYY-MM-DD HH:MM then the serial digits, e.g. 2024-03-14 15:09 12345678',
  options: {
    mode: toggle('Mode', [
      { value: 'decode', label: 'Decode' },
      { value: 'encode', label: 'Encode' },
    ]),
    orientation: select('Orientation', orientationChoices('Auto (try all)'), 'auto', {
      showIf: (v) => v.mode === 'decode',
      hint: 'Auto tries every turn and mirror that gives an 8 × 15 tile and keeps the one passing parity.',
    }),
    fixOne: bool('Correct one misread dot', false, {
      showIf: (v) => v.mode === 'decode',
      hint: 'When parity fails and flipping exactly one dot fixes it, decode the corrected tile (flagged as corrected).',
    }),
    separator: bool('Column 10 all dots', true, {
      showIf: (v) => v.mode === 'encode',
      hint: 'The EFF guide says column 10 is a separator, typically all dots.',
    }),
    ...mappingOptions(),
    parity: parityOption(),
  },
  examples: [
    {
      label: 'Decode a tile',
      input: [
        '● · ● ● · ● · · ● · · · · · ●',
        '· · · · · · · · · ● · · · · ·',
        '● ● · · · · · · · ● · ● ● · ·',
        '· · · · · · · ● · ● ● ● · ● ·',
        '● ● · · ● · ● · · ● ● ● ● ● ·',
        '· · · · · ● · · · ● · · · ● ·',
        '· ● · · · · ● ● · ● ● ● · ● ·',
        '· · · · · ● ● ● · ● · ● ● ● ·',
      ].join('\n'),
      expect: 'Printed: 2019-11-05 08:42',
    },
    {
      label: 'Encode',
      input: '2024-03-14 15:09 12345678',
      options: { mode: 'encode' },
      expect: 'Round trip OK',
    },
    {
      label: 'Upside down (turned 180°)',
      input: [
        '· ● · · · ● · ● · · ● · · ● ·',
        '· ● ● · ● ● · · ● ● ● · · ● ●',
        '· · · ● · ● · ● ● ● ● · · · ●',
        '· ● · ● · ● · · · ● · · · ● ·',
        '· ● ● ● ● ● · ● · ● ● · · ● ·',
        '· · · · · ● · · · · · · · ● ●',
        '· · · · · ● · · · · · · · · ·',
        '● ● ● · ● · ● · ● ● ● ● ● · ·',
      ].join('\n'),
      expect: 'Printed: 2021-06-30 23:59',
    },
    {
      label: 'Read sideways (15 × 8)',
      input: [
        '● · · ● · · · ●',
        '● ● ● · · · · ·',
        '· · · · · · · ●',
        '· · · · · · · ●',
        '· · · · · · · ●',
        '● · ● ● ● · · ●',
        '· ● · · · · · ·',
        '· · · · ● · · ·',
        '· · · · · · · ●',
        '● ● ● ● ● ● ● ·',
        '● ● · · · · · ●',
        '· ● · · ● · · ●',
        '· · · · ● · · ·',
        '· · · · · · · ●',
        '· · · · · · · ●',
      ].join('\n'),
      expect: 'Printed: 2016-02-29 00:07',
    },
    {
      label: 'One dot misread, corrected',
      input: [
        '● · ● ● · ● · · ● · · · · · ●',
        '· · · · · · · · · ● · · · · ·',
        '● ● · · · · · · · ● · ● ● · ·',
        '· · · · · ● · ● · ● ● ● · ● ·',
        '● ● · · ● · ● · · ● ● ● ● ● ·',
        '· · · · · ● · · · ● · · · ● ·',
        '· ● · · · · ● ● · ● ● ● · ● ·',
        '· · · · · ● ● ● · ● · ● ● ● ·',
      ].join('\n'),
      options: { fixOne: true },
      expect: 'Printed: 2019-11-05 08:42 (1 dot corrected)',
    },
  ],
  detect({ text }) {
    if (!text) return null;
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length !== ROWS && lines.length !== COLS) return null;
    const width = lines.length === ROWS ? COLS : ROWS;
    const cell = /^[\s01xX.·●•o○*#-]*$/;
    const ok = lines.every((l) => cell.test(l) && l.replace(/\s/g, '').length === width);
    if (!ok) return null;
    return {
      score: /[●·]/.test(text) ? 0.85 : 0.55,
      options: { mode: 'decode' },
      reason: T('detect.tile', { rows: lines.length, cols: width }),
    };
  },
  run(input, o) {
    const mapping = mappingFrom(o);
    const mapped = mappedColumns(mapping);
    const odd = o.parity === 'odd';

    if (o.mode === 'encode') {
      if (!input.trim()) throw new ToolError(T('error.encode-help'));
      const fields = parseEncodeInput(input);
      const [first, last] = yearRange(mapping.century);
      if (fields.year < first || fields.year > last)
        throw new ToolError(
          T('error.year-range', { century: centuryText(mapping.century), first, last }),
        );
      const out: Output[] = [];
      const extras: Partial<Record<number, number>> = {};
      if (o.separator && !mapped.has(SEPARATOR_COLUMN)) extras[SEPARATOR_COLUMN] = 127;
      if (o.separator && mapped.has(SEPARATOR_COLUMN))
        out.push({
          type: 'note',
          level: 'warn',
          text: T('note.separator-mapped', {
            col: SEPARATOR_COLUMN,
            field: fieldLabel(mapped.get(SEPARATOR_COLUMN)!),
          }),
        });
      const m = encodeDocuColor(fields, mapping, extras, odd);
      const back = decodeDocuColor(m, mapping, odd);
      const serial = fields.serial.padStart(2 * mapping.serialColumns.length, '0');
      const same = printed(back.fields) === printed(fields) && back.fields.serial === serial;
      out.unshift(
        same && back.parity.ok
          ? {
              type: 'note',
              level: 'success',
              text: T('note.round-trip-ok', {
                printed: printed(fields),
                serial,
                parity: T(odd ? 'value.parity-of.odd' : 'value.parity-of.even'),
              }),
            }
          : {
              type: 'note',
              level: 'error',
              text: T('note.round-trip-failed', {
                printed: printed(back.fields),
                serial: back.fields.serial,
              }),
            },
      );
      out.push(
        {
          type: 'kv',
          entries: [
            [T('kv.printed'), printed(fields)],
            [T('kv.serial'), serial],
          ],
        },
        {
          type: 'text',
          label: T('label.dot-matrix'),
          value: matrixToText(m),
        },
        {
          type: 'image',
          label: T('label.tile-image'),
          image: renderMatrix(m),
          filename: 'docucolor-tile.png',
        },
        columnTable(back, mapping),
      );
      return out;
    }

    if (!input.trim()) throw new ToolError(T('error.paste', { rows: ROWS, cols: COLS }));
    const tries = bestOrientations(parseMatrixText(input), mapping, odd);
    let chosen = tries[0]!;
    if (o.orientation !== 'auto') {
      const forced = tries.find((t) => orientationKey(t.orientation) === o.orientation);
      if (!forced)
        throw new ToolError(
          T('error.orientation', {
            rows: ROWS,
            cols: COLS,
            list: tries.map((t) => orientationText(t.orientation)).join(', '),
          }),
        );
      chosen = forced;
    }
    const asRead = decodeDocuColor(chosen.matrix, mapping, odd);
    const anyOk = tries.some((t) => t.parityOk);
    // Optional single-dot correction: in auto mode, among orientations, prefer a plausible fix.
    let fix: { row: number; col: number; matrix: boolean[][] } | null = null;
    if (o.fixOne && !asRead.parity.ok && !(o.orientation === 'auto' && anyOk)) {
      const pool = o.orientation === 'auto' ? tries : [chosen];
      const fixes = pool.flatMap((t) => {
        const f = singleDotFix(t.matrix, odd);
        return f ? [{ t, f, ok: decodeDocuColor(f.matrix, mapping, odd).plausible }] : [];
      });
      const pick = fixes.find((x) => x.ok) ?? fixes[0];
      if (pick) {
        chosen = pick.t;
        fix = pick.f;
      }
    }
    const tile = fix ? fix.matrix : chosen.matrix;
    const d = decodeDocuColor(tile, mapping, odd);
    // Readings that pass parity with valid values, counted once per distinct date + serial: two
    // of them means the orientation is ambiguous (e.g. a mirrored read without the separator).
    const readings = new Set(
      tries
        .filter((t) => t.parityOk && t.plausible)
        .map((t) => {
          const td = decodeDocuColor(t.matrix, mapping, odd);
          return `${printed(td.fields)} ${td.fields.serial}`;
        }),
    );
    const ambiguous = o.orientation === 'auto' && !fix && d.parity.ok && readings.size > 1;
    const out: Output[] = [];
    if (fix) {
      const before = parityCheck(chosen.matrix, odd);
      out.push({
        type: 'note',
        level: 'warn',
        text: T('note.corrected', { bad: parityText(before), row: fix.row, col: fix.col }),
      });
    } else if (ambiguous) {
      out.push({
        type: 'note',
        level: 'warn',
        text: T('note.ambiguous', {
          count: readings.size,
          orientation: orientationText(chosen.orientation),
          separator: chosen.separatorFull ? T('note.ambiguous-separator') : '',
        }),
      });
    } else if (d.parity.ok && d.plausible) {
      out.push({
        type: 'note',
        level: 'success',
        text: T('note.parity-ok', {
          parity: T(odd ? 'value.dots-count.odd' : 'value.dots-count.even'),
        }),
      });
    } else if (d.parity.ok) {
      out.push({
        type: 'note',
        level: 'warn',
        text: T('note.parity-ok-implausible', { issues: d.issues.join('; ') }),
      });
    } else {
      out.push({
        type: 'note',
        level: 'error',
        text: `${T('note.parity-failed', { bad: parityText(d.parity) })}${
          o.orientation === 'auto' && !anyOk
            ? T('note.none-passes', { count: tries.length, rows: ROWS, cols: COLS })
            : ''
        }`,
      });
      const guess = singleDotFix(chosen.matrix, odd);
      const alt = guess ? decodeDocuColor(guess.matrix, mapping, odd) : null;
      if (guess && alt?.plausible)
        out.push({
          type: 'note',
          level: 'warn',
          text: T('note.single-dot', {
            row: guess.row,
            col: guess.col,
            printed: printed(alt.fields),
            serial: alt.fields.serial,
          }),
        });
    }
    if (!d.plausible && !(d.parity.ok && !fix))
      out.push({
        type: 'note',
        level: 'warn',
        text: T('note.invalid-values', { issues: d.issues.join('; ') }),
      });
    const maker = makerNote(d);
    if (maker) out.push(maker);
    const custom = mappingNote(mapping);
    if (custom) out.push(custom);
    const suffix = fix
      ? T('value.suffix-corrected')
      : ambiguous
        ? T('value.suffix-ambiguous')
        : d.parity.ok && d.plausible
          ? ''
          : T('value.suffix-uncertain');

    out.push(
      {
        type: 'kv',
        entries: [
          [T('kv.printed'), `${dateText(d)}${suffix}`],
          [T('kv.serial'), `${serialText(d)}${suffix}`],
          [T('kv.orientation-used'), orientationText(chosen.orientation)],
          [
            T('kv.parity'),
            fix
              ? T('value.parity-fixed', { row: fix.row, col: fix.col })
              : d.parity.ok
                ? T('value.parity-ok')
                : T('value.parity-failed', { bad: parityText(d.parity) }),
          ],
        ],
      },
      columnTable(d, mapping),
      {
        type: 'table',
        label: T('label.orientations'),
        columns: [
          T('col.orientation'),
          T('col.parity'),
          T('col.valid'),
          T('col.printed'),
          T('col.serial'),
        ],
        rows: tries.map((t) => {
          const td = decodeDocuColor(t.matrix, mapping, odd);
          return [
            shortOrientation(t.orientation),
            parityCell(td.parity),
            td.plausible ? T('value.yes') : T('value.no-because', { issue: td.issues[0] ?? '' }),
            dateText(td),
            serialText(td),
          ];
        }),
        highlight: [tries.indexOf(chosen)],
      },
      {
        type: 'text',
        label: fix
          ? T('label.tile-flipped', { row: fix.row, col: fix.col })
          : T('label.tile-as-read'),
        value: matrixToText(tile),
      },
    );
    return out;
  },
});
