import { bool, defineTool, toggle } from '../../core/define';
import type { Output } from '../../core/types';
import { toolT } from '../../i18n/tool-text';

const T = toolT('ascii-table');

/** Placeholder shown in the Char column for codes that have no visible glyph. */
const PLACEHOLDER = '·';

const C0 = (
  'NUL SOH STX ETX EOT ENQ ACK BEL BS HT LF VT FF CR SO SI ' +
  'DLE DC1 DC2 DC3 DC4 NAK SYN ETB CAN EM SUB ESC FS GS RS US'
).split(' ');

const C1 = (
  'PAD HOP BPH NBH IND NEL SSA ESA HTS HTJ VTS PLD PLU RI SS2 SS3 ' +
  'DCS PU1 PU2 STS CCH MW SPA EPA SOS SGCI SCI CSI ST OSC PM APC'
).split(' ');

/** Abbreviation of a control or invisible code, or '' for an ordinary printable one. */
function codeName(code: number): string {
  if (code < 32) return C0[code]!;
  if (code === 32) return 'SP';
  if (code === 127) return 'DEL';
  if (code >= 128 && code <= 159) return C1[code - 128]!;
  if (code === 160) return 'NBSP';
  if (code === 173) return 'SHY';
  return '';
}

/** True when the code has no usable glyph of its own (controls, DEL, space, NBSP, SHY). */
function isInvisible(code: number): boolean {
  return codeName(code) !== '';
}

const hex = (n: number) => '0x' + n.toString(16).padStart(2, '0');

function glyph(code: number): string {
  return isInvisible(code) ? PLACEHOLDER : String.fromCodePoint(code);
}

export default defineTool({
  id: 'ascii-table',
  name: 'ASCII table',
  category: 'misc',
  description:
    'Look up ASCII / Latin-1 codes in decimal, hex, octal and binary, with control names.',
  tags: [
    'ascii',
    'ascii table',
    'control characters',
    'non-printable',
    'dec hex oct bin',
    'charcode',
    'codepage',
    'latin1',
  ],
  input: 'text',
  placeholder: 'Leave empty for the full table, or type text to look its characters up',
  options: {
    range: toggle('Range', [
      { value: 'ascii', label: 'ASCII (0–127)' },
      { value: 'latin1', label: 'Latin-1 (0–255)' },
    ]),
    controls: bool('Name control chars', true, {
      hint: 'Show NUL, LF, ESC… names for 0–31 and 127',
    }),
  },
  examples: [
    // The full reference table is shown for any input (clear the box for just the table); the
    // input only marks which codes appear. An example needs non-empty input to run in the UI.
    { label: 'The whole table', input: 'A', expect: 'NUL' },
    { label: 'Look up a word', input: 'Flag!', expect: '0x46' },
    { label: 'Latin-1 range', input: 'é', options: { range: 'latin1' }, expect: '0xe9' },
  ],
  detect: () => null,
  run(text, { range, controls }) {
    const size = range === 'latin1' ? 256 : 128;
    const chars = Array.from(text, (ch) => ch.codePointAt(0)!);

    const counts = new Map<number, number>();
    for (const c of chars) counts.set(c, (counts.get(c) ?? 0) + 1);

    const outputs: Output[] = [];

    if (chars.length > 0) {
      outputs.push({
        type: 'table',
        label: T('label.yourText'),
        columns: [T('col.char'), T('col.dec'), T('col.hex'), T('col.note')],
        rows: chars.map((c) => {
          const note =
            c >= size
              ? T('note.outside', { range: range === 'latin1' ? '0–255' : '0–127' })
              : controls
                ? codeName(c)
                : '';
          return [c >= size ? String.fromCodePoint(c) : glyph(c), c, hex(c), note];
        }),
      });
    }

    const highlight: number[] = [];
    const rows: (string | number)[][] = [];
    for (let code = 0; code < size; code++) {
      const n = counts.get(code) ?? 0;
      if (n > 0) highlight.push(code);
      rows.push([
        code,
        hex(code),
        '0o' + code.toString(8).padStart(3, '0'),
        code.toString(2).padStart(8, '0'),
        glyph(code),
        controls ? codeName(code) : '',
        n > 0 ? n : '',
      ]);
    }
    outputs.push({
      type: 'table',
      label: T('label.reference'),
      columns: [
        T('col.dec'),
        T('col.hex'),
        T('col.oct'),
        T('col.bin'),
        T('col.char'),
        T('col.name'),
        T('col.inText'),
      ],
      rows,
      highlight,
    });
    return outputs;
  },
});
