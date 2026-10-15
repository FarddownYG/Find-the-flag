import { bool, defineTool, select, toggle } from '../../core/define';
import { ToolError } from '../../core/errors';
import { toolT } from '../../i18n/tool-text';
import { reportScan } from './_barcode-report';
import { scanBarcodes } from './_barcode-scan';

const T = toolT('barcode');

export default defineTool({
  id: 'barcode',
  name: 'Barcode reader',
  category: 'stego',
  description:
    'Read 1D and 2D barcodes in an image (Code 128, Code 39, EAN-13, UPC, Data Matrix, Aztec, PDF417, MaxiCode, QR...), several at once, tilted or inverted; shows text, raw bytes and where each one is.',
  tags: [
    'barcode',
    'bar code',
    'ean',
    'upc',
    'gtin',
    'isbn',
    'code128',
    'code39',
    'code93',
    'codabar',
    'itf',
    'databar',
    'datamatrix',
    'aztec',
    'pdf417',
    'maxicode',
    'qr',
    '1d',
    '2d',
    'scan',
    'decode',
    'zxing',
    'zbar',
  ],
  input: 'image',
  placeholder: 'Drop an image that contains a barcode',
  options: {
    formats: select(
      'Code types',
      [
        { value: 'all', label: 'All (1D and 2D)' },
        { value: 'linear', label: '1D codes only' },
        { value: 'matrix', label: '2D codes only' },
        { value: 'code128', label: 'Code 128' },
        { value: 'code39', label: 'Code 39' },
        { value: 'code93', label: 'Code 93' },
        { value: 'codabar', label: 'Codabar' },
        { value: 'itf', label: 'ITF' },
        { value: 'eanupc', label: 'EAN / UPC' },
        { value: 'databar', label: 'DataBar' },
        { value: 'qr', label: 'QR / Micro QR / rMQR' },
        { value: 'datamatrix', label: 'Data Matrix' },
        { value: 'aztec', label: 'Aztec' },
        { value: 'pdf417', label: 'PDF417' },
        { value: 'maxicode', label: 'MaxiCode' },
      ],
      'all',
      {
        hint: 'Limiting the search to the type you expect makes a weak or damaged code easier to read and avoids false hits.',
      },
    ),
    effort: toggle(
      'Search',
      [
        { value: 'smart', label: 'Smart' },
        { value: 'quick', label: 'One pass' },
        { value: 'full', label: 'All passes' },
      ],
      'smart',
      {
        hint: 'Smart reads the picture as it is first, then tries inverted colours, pure mode, a quiet-zone margin, greyscale thresholds, noise removal, rescaling and tilting, and stops at the first pass that reads something. All passes keeps going and merges every code found (use it when only some codes of a picture are read). One pass only reads the picture as it is.',
      },
    ),
    boxes: bool('Draw boxes on the picture', true),
    addOns: bool('Read EAN / UPC add-ons (+2, +5)', true),
    checksum: bool('Check optional check digits (Code 39, ITF)', false),
    invalid: bool('Also list codes that fail their check', false, {
      hint: 'A code with a wrong check digit or damaged data is normally ignored. Turn this on to see what the reader saw and why it was rejected.',
    }),
  },
  examples: [
    {
      label: 'Code 128',
      input: { sample: 'barcode-code128.png' },
      expect: 'FTF{code128_demo}',
    },
    {
      label: 'EAN-13 and its check digit',
      input: { sample: 'barcode-ean13.png' },
      expect: 'Check digit: 3 (valid)',
    },
    {
      label: 'Data Matrix',
      input: { sample: 'barcode-datamatrix.png' },
      expect: 'FTF{datamatrix_demo}',
    },
    { label: 'Aztec', input: { sample: 'barcode-aztec.png' }, expect: 'FTF{aztec_demo}' },
    { label: 'PDF417', input: { sample: 'barcode-pdf417.png' }, expect: 'FTF{pdf417_demo}' },
    {
      label: 'MaxiCode',
      input: { sample: 'barcode-maxicode.png' },
      expect: 'FTF{maxicode_demo}',
    },
    {
      label: 'Two codes in one picture',
      input: { sample: 'barcode-two-codes.png' },
      expect: '2 codes found.',
    },
    {
      label: 'White on black, tilted',
      input: { sample: 'barcode-hard.png' },
      expect: 'FTF{hard_to_read}',
    },
  ],
  async run({ image }, o) {
    if (!image.width || !image.height) throw new ToolError(T('error.noPixels'));
    const scan = await scanBarcodes(image, {
      formats: o.formats,
      effort: o.effort,
      addOns: o.addOns,
      checksum: o.checksum,
      invalid: o.invalid,
    });
    return reportScan(scan, image, {
      effort: o.effort,
      boxes: o.boxes,
      showInvalid: o.invalid,
      synthetic: false,
      mentionQr: o.formats === 'all' || o.formats === 'matrix' || o.formats === 'qr',
    });
  },
});
