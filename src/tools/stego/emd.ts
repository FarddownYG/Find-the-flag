import { defineTool, number, select, text, toggle } from '../../core/define';
import { embedOutputs, extractOutputs } from './_emd-run';

export default defineTool({
  id: 'emd',
  name: 'EMD steganography',
  category: 'stego',
  description:
    'Read or hide a message with EMD (Exploiting Modification Direction): every group of n pixels carries one digit in base 2n+1. Shows the raw digits and tries the usual digit-to-text conventions.',
  tags: [
    'exploiting modification direction',
    'emd',
    'steganography',
    'pixel group',
    'base 5',
    'modulo',
    'zhang wang',
    'lsb',
    'extract',
    'embed',
    'encoder',
  ],
  input: 'image',
  placeholder: 'Drop a PNG or BMP (the exact pixel values matter, so no JPEG)',
  options: {
    mode: toggle('Mode', [
      { value: 'extract', label: 'Extract' },
      { value: 'embed', label: 'Embed' },
    ]),
    message: text('Message to hide', 'HELLO_EMD', {
      placeholder: 'HELLO_EMD',
      hint: 'Written as UTF-8 bytes, turned into digits with the convention below.',
      showIf: (v) => v.mode === 'embed',
    }),
    n: select(
      'Group size n',
      [
        { value: '1', label: 'n = 1 (base 3)' },
        { value: '2', label: 'n = 2 (base 5)' },
        { value: '3', label: 'n = 3 (base 7)' },
        { value: '4', label: 'n = 4 (base 9)' },
        { value: '5', label: 'n = 5 (base 11)' },
        { value: '6', label: 'n = 6 (base 13)' },
        { value: '7', label: 'n = 7 (base 15)' },
        { value: '8', label: 'n = 8 (base 17)' },
      ],
      '2',
      {
        hint: 'Pixels per group. A group carries one digit in base 2n+1 and is read as (1·g1 + 2·g2 + … + n·gn) mod (2n+1).',
      },
    ),
    channel: select(
      'Channel',
      [
        { value: 'r', label: 'Red' },
        { value: 'g', label: 'Green' },
        { value: 'b', label: 'Blue' },
        { value: 'luma', label: 'Grayscale (luma)' },
        { value: 'avg', label: 'Average of RGB' },
        { value: 'auto', label: 'Auto (guess)' },
      ],
      'r',
      {
        hint: 'Value taken from each pixel. Ignored by the raw byte order. Auto tries every channel and traversal and ranks the readings: a guess, not a proof.',
      },
    ),
    traversal: select(
      'Traversal',
      [
        { value: 'horizontal', label: 'Horizontal (row by row)' },
        { value: 'vertical', label: 'Vertical (column by column)' },
        { value: 'raw', label: 'Raw byte order' },
      ],
      'horizontal',
      {
        hint: 'The order pixels are cut into groups. Raw uses every byte of the RGB (or RGBA) stream in turn.',
        showIf: (v) => v.channel !== 'auto',
      },
    ),
    offset: number('Start offset', 0, {
      min: 0,
      hint: 'Pixels skipped along the traversal before the first group (bytes in raw order).',
    }),
    length: number('Message length', 892, {
      min: 0,
      hint: 'Characters (bytes) to read. 0 = everything the image holds.',
      showIf: (v) => v.mode === 'extract',
    }),
    grouping: select(
      'Digits per character',
      [
        { value: 'fixed', label: 'Fixed: enough for any byte' },
        { value: 'minimal', label: 'Minimal: enough for ASCII letters' },
        { value: 'bignum', label: 'One big number' },
      ],
      'fixed',
      {
        hint: 'Fixed = ceil(8 / log2 base) digits per byte (base 5: 4). Minimal = the fewest digits that reach "z" (base 5: 3). One big number = the whole stream read as one number in the base. All are tried and ranked below.',
      },
    ),
    order: toggle(
      'Digit order',
      [
        { value: 'msd', label: 'Most significant first' },
        { value: 'lsd', label: 'Least significant first' },
      ],
      'msd',
      { hint: 'Whether the first digit of a character is its highest or its lowest.' },
    ),
  },
  examples: [
    {
      label: 'Extract the hidden word',
      input: { sample: 'emd-hello.png' },
      options: { length: 9 },
      expect: 'HELLO_EMD',
    },
    {
      label: 'Show the base-5 digit stream',
      input: { sample: 'emd-hello.png' },
      options: { length: 9 },
      expect: '0242 0234 0301 0301 0304 0340 0234 0302 0233',
    },
    {
      label: 'Read everything the image holds',
      input: { sample: 'emd-hello.png' },
      options: { length: 0 },
      expect: 'HELLO_EMD',
    },
    {
      label: 'Auto: guess the channel and traversal',
      input: { sample: 'emd-hello.png' },
      options: { channel: 'auto', length: 9 },
      expect: 'HELLO_EMD',
    },
    {
      label: 'Embed a message in a cover image',
      input: { sample: 'emd-cover.png' },
      options: { mode: 'embed', message: 'HELLO_EMD' },
      expect: "Round trip: OK, extracted 'HELLO_EMD'",
    },
  ],
  run({ image, bytes }, o) {
    return o.mode === 'embed' ? embedOutputs(image, o) : extractOutputs(image, bytes, o);
  },
});
