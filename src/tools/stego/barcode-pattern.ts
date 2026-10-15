import { bool, defineTool, toggle } from '../../core/define';
import type { Output } from '../../core/types';
import { toolT } from '../../i18n/tool-text';
import {
  flipped,
  parseModules,
  parseWidths,
  renderPattern,
  type Pattern,
} from './_barcode-modules';
import { reportScan } from './_barcode-report';
import { scanBarcodes, type BarcodeScan, type FormatChoice } from './_barcode-scan';

const T = toolT('barcode-pattern');

// Made-up payloads, drawn by the zxing-wasm writer (see src/tools/stego/_barcode-fixtures.ts).
const CODE128_ROW =
  '11010010000100011000101101110001010001100010111101101101001000011010010110000100100111101011110010010100011110100111001101100011101011';
const CODE128_WIDTHS = '2112141323112133111323114121211214211211241212411142121113411232212331112';
const EAN13_ROW =
  '10100011010011001001101101000010100011011100101010101000010001001001000111010011100101000010101';
const QR_GRID = [
  '111111101101101111111',
  '100000100001001000001',
  '101110101110101011101',
  '101110101011101011101',
  '101110100101101011101',
  '100000101011101000001',
  '111111101010101111111',
  '000000001010000000000',
  '010101111010011101101',
  '110011010001000110000',
  '100001111000111100101',
  '101000001100001001010',
  '010110101110110000111',
  '000000001010111100000',
  '111111101010010111010',
  '100000101101010110000',
  '101110100000111001010',
  '101110101111000010111',
  '101110100100100111001',
  '100000101110011000000',
  '111111100111100111010',
].join('\n');

export default defineTool({
  id: 'barcode-pattern',
  name: 'Barcode from modules',
  category: 'stego',
  description:
    'Decode a barcode written out as text: a row of 1 and 0 (or ▮ and ▯) for a 1D code, bar and space widths, or a grid of lines for a 2D code such as QR or Data Matrix.',
  tags: [
    'barcode',
    'bars',
    'modules',
    'pattern',
    'bit matrix',
    'binary grid',
    'text barcode',
    'ascii art',
    'qr as text',
    'widths',
    'zxing',
  ],
  input: 'text',
  live: false,
  placeholder:
    'Paste the modules, for example 11010010000100011000101101110001...  or  ▮▮▯▮▯▯▮▯▯▯▯▮...',
  options: {
    notation: toggle('Notation', [
      { value: 'modules', label: 'Modules' },
      { value: 'widths', label: 'Widths' },
    ]),
    ones: toggle(
      '1 means',
      [
        { value: 'bar', label: 'Bar (dark)' },
        { value: 'space', label: 'Space (light)' },
      ],
      'bar',
      {
        showIf: (v) => v.notation === 'modules',
        hint: 'Only for 1 and 0. The glyphs ▮ and ▯ always mean dark and light. If nothing is read, the other reading is tried too.',
      },
    ),
    spaces: bool('A space is a light module', false, {
      showIf: (v) => v.notation === 'modules',
      hint: 'Off: spaces and commas only separate the modules. On: they are light modules (for bars drawn with block characters and spaces).',
    }),
  },
  examples: [
    {
      label: 'Code 128 as 1 and 0',
      input: CODE128_ROW,
      expect: 'FTF{bars}',
    },
    {
      label: 'EAN-13 drawn with ▮ and ▯',
      input: [...EAN13_ROW].map((c) => (c === '1' ? '▮' : '▯')).join(''),
      expect: '2012345678903',
    },
    {
      label: 'Bar and space widths',
      input: CODE128_WIDTHS,
      options: { notation: 'widths' },
      expect: 'FTF{bars}',
    },
    {
      label: 'QR code as a grid of 1 and 0',
      input: QR_GRID,
      expect: 'FTF{grid}',
    },
  ],
  async run(text, o) {
    const pattern: Pattern =
      o.notation === 'widths'
        ? parseWidths(text)
        : parseModules(text, { onesAreLight: o.ones === 'space', spaceIsLight: o.spaces });
    const oneD = pattern.rows.length === 1;
    const formats: FormatChoice = oneD ? 'linear' : 'matrix';
    const scanOptions = {
      formats,
      effort: 'smart' as const,
      addOns: true,
      checksum: false,
      invalid: true,
    };
    const image = renderPattern(pattern);
    let scan: BarcodeScan = await scanBarcodes(image, scanOptions);
    let other = false;
    if (!scan.hits.length && o.notation === 'modules') {
      // Nothing: the 1s and 0s may mean the opposite.
      const second = await scanBarcodes(renderPattern(flipped(pattern)), scanOptions);
      if (second.hits.length) {
        other = true;
        scan = {
          ...second,
          hits: second.hits.map((h) => ({ ...h, how: `${T('how.flipped')}, ${h.how}` })),
        };
      }
    }
    const out: Output[] = [
      {
        type: 'kv',
        label: T('label.pattern'),
        entries: [
          [
            T('kv.size'),
            T(oneD ? 'value.sizeBars' : 'value.sizeGrid', {
              cols: pattern.cols,
              rows: pattern.rows.length,
            }),
          ],
          ...(other ? ([[T('kv.reading'), T('value.flipped')]] as [string, string][]) : []),
        ],
      },
    ];
    if (!scan.hits.length && !scan.invalid.length) {
      out.push({ type: 'note', level: 'warn', text: T('note.none', { cols: pattern.cols }) });
      return out;
    }
    out.push(
      ...reportScan(scan, image, {
        effort: 'smart',
        boxes: false,
        showInvalid: true,
        synthetic: true,
        mentionQr: false,
      }),
    );
    return out;
  },
});
