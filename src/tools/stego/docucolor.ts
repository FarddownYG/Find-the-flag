import { bool, defineTool, select, toggle } from '../../core/define';
import { ToolError } from '../../core/errors';
import type { Output } from '../../core/types';
import {
  COLS,
  ROWS,
  SEPARATOR_COLUMN,
  bestOrientations,
  centuryText,
  decodeDocuColor,
  describeOrientation,
  encodeDocuColor,
  mappedColumns,
  matrixToText,
  orientationKey,
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

const ENCODE_HELP =
  'To encode, write the date and time as YYYY-MM-DD HH:MM, then the serial digits, e.g. "2024-03-14 15:09 12345678".';

/**
 * Encode input: 'YYYY-MM-DD HH:MM' (or with a T) and optional serial digits, in any order; the
 * words "Printed" / "Serial" are allowed, so the decoder's own output can be pasted back.
 * Date and time are checked against the calendar.
 */
function parseEncodeInput(s: string): DocuFields {
  const m = /(\d{4})-(\d{1,2})-(\d{1,2})[ T]+(\d{1,2}):(\d{1,2})/.exec(s);
  if (!m) throw new ToolError(`${ENCODE_HELP} Got "${s.trim().slice(0, 40)}".`);
  const rest = `${s.slice(0, m.index)} ${s.slice(m.index + m[0].length)}`
    .replace(/printed|serial|:/gi, ' ')
    .trim();
  if (!/^[\d\s-]*$/.test(rest))
    throw new ToolError(`The serial number must be digits; got "${rest.slice(0, 40)}".`);
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
    throw new ToolError(`${when} is not a calendar date.`);
  if (hour > 23 || minute > 59) throw new ToolError(`${when} is not a time of day.`);
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
      reason: `${lines.length} rows of ${width} dots: a DocuColor tracking tile`,
    };
  },
  run(input, o) {
    const mapping = mappingFrom(o);
    const mapped = mappedColumns(mapping);
    const odd = o.parity === 'odd';

    if (o.mode === 'encode') {
      if (!input.trim()) throw new ToolError(ENCODE_HELP);
      const fields = parseEncodeInput(input);
      const [first, last] = yearRange(mapping.century);
      if (fields.year < first || fields.year > last)
        throw new ToolError(
          `The year column holds two digits: with the century set to ${centuryText(mapping.century)} the year must be ${first}-${last}. Change Century for other years.`,
        );
      const out: Output[] = [];
      const extras: Partial<Record<number, number>> = {};
      if (o.separator && !mapped.has(SEPARATOR_COLUMN)) extras[SEPARATOR_COLUMN] = 127;
      if (o.separator && mapped.has(SEPARATOR_COLUMN))
        out.push({
          type: 'note',
          level: 'warn',
          text: `Column ${SEPARATOR_COLUMN} is mapped to the ${mapped.get(SEPARATOR_COLUMN)}, so it is not filled as a separator.`,
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
              text: `Round trip OK: the tile decodes back to ${printed(fields)}, serial ${serial}, ${odd ? 'odd' : 'even'} parity.`,
            }
          : {
              type: 'note',
              level: 'error',
              text: `Round trip FAILED: the tile decodes to ${printed(back.fields)}, serial ${back.fields.serial}.`,
            },
      );
      out.push(
        {
          type: 'kv',
          entries: [
            ['Printed', printed(fields)],
            ['Serial', serial],
          ],
        },
        {
          type: 'text',
          label: 'Dot matrix (● dot, · none; row 1 and column 1 are parity)',
          value: matrixToText(m),
        },
        {
          type: 'image',
          label: 'One tile (enlarged; parity row and column tinted)',
          image: renderMatrix(m),
          filename: 'docucolor-tile.png',
        },
        columnTable(back, mapping),
      );
      return out;
    }

    if (!input.trim())
      throw new ToolError(
        `Paste the dot matrix: ${ROWS} rows × ${COLS} columns (or ${COLS} × ${ROWS}), one row per line, with 1/x/● for a dot and 0/./· for none.`,
      );
    const tries = bestOrientations(parseMatrixText(input), mapping, odd);
    let chosen = tries[0]!;
    if (o.orientation !== 'auto') {
      const forced = tries.find((t) => orientationKey(t.orientation) === o.orientation);
      if (!forced)
        throw new ToolError(
          `That orientation does not give an ${ROWS} × ${COLS} tile from this grid; try: ${tries
            .map((t) => describeOrientation(t.orientation))
            .join(', ')}.`,
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
        text: `Corrected, not clean: parity failed as read (${parityText(before)}); flipping the dot at row ${fix.row}, column ${fix.col} makes it pass. The reading below assumes that one dot was misread — check it on the scan.`,
      });
    } else if (ambiguous) {
      out.push({
        type: 'note',
        level: 'warn',
        text: `Parity OK, but ${readings.size} orientations pass parity with valid but different values: the reading is ambiguous. Shown: ${describeOrientation(chosen.orientation)}${
          chosen.separatorFull ? ', whose column 10 is all dots as the EFF describes' : ''
        }. Compare them in the orientation table, or set the orientation if you know it.`,
      });
    } else if (d.parity.ok && d.plausible) {
      out.push({
        type: 'note',
        level: 'success',
        text: `Parity OK — every column and every row but the top one has an ${odd ? 'odd' : 'even'} number of dots.`,
      });
    } else if (d.parity.ok) {
      out.push({
        type: 'note',
        level: 'warn',
        text: `Parity OK, but the values are not a valid date or serial (${d.issues.join('; ')}): low confidence. Check the orientation and the column mapping.`,
      });
    } else {
      out.push({
        type: 'note',
        level: 'error',
        text: `Parity FAILED (${parityText(d.parity)}) — the reading below is uncertain.${
          o.orientation === 'auto' && !anyOk
            ? ` None of the ${tries.length} orientations that give an ${ROWS} × ${COLS} tile passes parity.`
            : ''
        }`,
      });
      const guess = singleDotFix(chosen.matrix, odd);
      const alt = guess ? decodeDocuColor(guess.matrix, mapping, odd) : null;
      if (guess && alt?.plausible)
        out.push({
          type: 'note',
          level: 'warn',
          text: `A single misread dot would explain it: flipping row ${guess.row}, column ${guess.col} makes parity pass and reads ${printed(alt.fields)}, serial ${alt.fields.serial}. That is a guess, not a reading ("Correct one misread dot" decodes it).`,
        });
    }
    if (!d.plausible && !(d.parity.ok && !fix))
      out.push({
        type: 'note',
        level: 'warn',
        text: `These values are not a valid date or serial (${d.issues.join('; ')}): check the orientation and the column mapping.`,
      });
    const maker = makerNote(d);
    if (maker) out.push(maker);
    const custom = mappingNote(mapping);
    if (custom) out.push(custom);
    const suffix = fix
      ? ' (1 dot corrected)'
      : ambiguous
        ? ' (ambiguous)'
        : d.parity.ok && d.plausible
          ? ''
          : ' (uncertain)';

    out.push(
      {
        type: 'kv',
        entries: [
          ['Printed', `${dateText(d)}${suffix}`],
          ['Serial', `${serialText(d)}${suffix}`],
          ['Orientation used', describeOrientation(chosen.orientation)],
          [
            'Parity',
            fix
              ? `OK after flipping row ${fix.row}, column ${fix.col} (FAILED as read)`
              : d.parity.ok
                ? 'OK'
                : `FAILED (${parityText(d.parity)})`,
          ],
        ],
      },
      columnTable(d, mapping),
      {
        type: 'table',
        label: 'Orientations tried (applied to the grid as given)',
        columns: ['Orientation', 'Parity', 'Valid', 'Printed', 'Serial'],
        rows: tries.map((t) => {
          const td = decodeDocuColor(t.matrix, mapping, odd);
          return [
            shortOrientation(t.orientation),
            parityCell(td.parity),
            td.plausible ? 'yes' : `no: ${td.issues[0] ?? ''}`,
            dateText(td),
            serialText(td),
          ];
        }),
        highlight: [tries.indexOf(chosen)],
      },
      {
        type: 'text',
        label: fix
          ? `Tile with row ${fix.row}, column ${fix.col} flipped (row 1 and column 1 are parity)`
          : 'Tile as read (row 1 and column 1 are parity)',
        value: matrixToText(tile),
      },
    );
    return out;
  },
});
