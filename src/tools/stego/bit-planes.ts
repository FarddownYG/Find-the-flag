import { bool, defineTool, number, select, toggle } from '../../core/define';
import { ToolError } from '../../core/errors';
import type { Output, RgbaImage } from '../../core/types';
import {
  bitPlaneImage,
  channelImage,
  equalize,
  fitImage,
  mapRgb,
  planeStats,
  randomColormap,
} from './_pixels';

const CHANNELS = [
  { id: 'r', letter: 'R', name: 'Red', index: 0 },
  { id: 'g', letter: 'G', name: 'Green', index: 1 },
  { id: 'b', letter: 'B', name: 'Blue', index: 2 },
  { id: 'a', letter: 'A', name: 'Alpha', index: 3 },
] as const;

const PLANE_SIDE = 512;
const ONE_SIDE = 4096;
const FILTER_SIDE = 1024;

const hasAlpha = (img: RgbaImage) => {
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i] !== 255) return true;
  return false;
};

const bitName = (bit: number) => (bit === 0 ? ' (lowest)' : bit === 7 ? ' (highest)' : '');

function verdict(ones: number, agree: number): string {
  if (ones === 0) return 'blank (all 0)';
  if (ones === 1) return 'blank (all 1)';
  if (agree < 0.58) return 'noise-like';
  return 'structured';
}

export default defineTool({
  id: 'bit-planes',
  name: 'Bit planes / color filters',
  category: 'stego',
  description:
    'See every bit plane of every colour channel (like StegSolve), plus inverted, grayscale, random-colour and other filters that reveal hidden pictures.',
  tags: [
    'stegsolve',
    'bit plane',
    'color filter',
    'channel',
    'xor',
    'invert',
    'histogram',
    'steganography',
  ],
  input: 'image',
  placeholder: 'Drop a PNG or BMP image',
  options: {
    mode: toggle('Mode', [
      { value: 'all', label: 'All planes' },
      { value: 'one', label: 'One plane' },
      { value: 'filters', label: 'Filters' },
    ]),
    channel: select(
      'Channel',
      [
        { value: 'r', label: 'Red' },
        { value: 'g', label: 'Green' },
        { value: 'b', label: 'Blue' },
        { value: 'a', label: 'Alpha' },
      ],
      'r',
      { showIf: (v) => v.mode === 'one' },
    ),
    bit: number('Bit', 0, {
      min: 0,
      max: 7,
      hint: '0 = least significant bit, 7 = most significant.',
      showIf: (v) => v.mode === 'one',
    }),
    filter: select(
      'Filter',
      [
        { value: 'all', label: 'All filters' },
        { value: 'invert', label: 'Inverted' },
        { value: 'grayscale', label: 'Grayscale' },
        { value: 'channels', label: 'Each channel alone' },
        { value: 'colormap', label: 'Random colormap' },
        { value: 'xor', label: 'XOR with value' },
        { value: 'equalize', label: 'Histogram equalize' },
      ],
      'all',
      { showIf: (v) => v.mode === 'filters' },
    ),
    xor: number('XOR value', 0, {
      min: 0,
      max: 255,
      hint: 'Applied to R, G and B. 0 skips the XOR picture in "All filters".',
      showIf: (v) => v.mode === 'filters',
    }),
    alpha: bool('Keep alpha', false, {
      hint: 'Off (default): every output is opaque, so colours hidden under transparent pixels show up.',
      showIf: (v) => v.mode === 'filters',
    }),
  },
  examples: [
    {
      label: 'All planes (text hides in G1)',
      input: { sample: 'stego-planes.png' },
      expect: 'G1',
    },
    {
      label: 'Just green bit 1',
      input: { sample: 'stego-planes.png' },
      options: { mode: 'one', channel: 'g', bit: 1 },
      expect: 'Green bit 1',
    },
    {
      label: 'Filters: random colormap',
      input: { sample: 'stego-planes.png' },
      options: { mode: 'filters', filter: 'colormap' },
      expect: 'Random colormap',
    },
  ],
  run({ image }, o) {
    const out: Output[] = [];
    const opaque = !hasAlpha(image);

    if (o.mode === 'one') {
      const ch = CHANNELS.find((c) => c.id === o.channel);
      if (!ch) throw new ToolError('Pick a channel: red, green, blue or alpha.');
      if (!Number.isInteger(o.bit) || o.bit < 0 || o.bit > 7) {
        throw new ToolError('Bit must be a whole number from 0 (lowest) to 7 (highest).');
      }
      const { image: shown, scaled } = fitImage(image, ONE_SIDE);
      const stats = planeStats(image, ch.index, o.bit);
      out.push({
        type: 'kv',
        entries: [
          ['Plane', `${ch.name} bit ${o.bit}${bitName(o.bit)}`],
          ['Pixels set to 1', `${(stats.ones * 100).toFixed(1)}%`],
          ['Looks', verdict(stats.ones, stats.agree)],
        ],
      });
      if (ch.id === 'a' && opaque) {
        out.push({
          type: 'note',
          level: 'info',
          text: 'The alpha channel is 255 everywhere, so this plane is constant.',
        });
      }
      if (scaled) {
        out.push({
          type: 'note',
          level: 'info',
          text: `Shown at ${shown.width}x${shown.height} (nearest-neighbour) because the image is very large.`,
        });
      }
      out.push({
        type: 'image',
        label: `${ch.name} bit ${o.bit}${bitName(o.bit)}`,
        image: bitPlaneImage(shown, ch.index, o.bit),
        filename: `plane-${ch.id}${o.bit}.png`,
      });
      return out;
    }

    if (o.mode === 'all') {
      const channels = CHANNELS.filter((c) => c.id !== 'a' || !opaque);
      const { image: shown, scaled } = fitImage(image, PLANE_SIDE);
      const rows: (string | number)[][] = [];
      const highlight: number[] = [];
      const images: Output[] = [];
      for (const ch of channels) {
        for (let bit = 0; bit < 8; bit++) {
          const stats = planeStats(image, ch.index, bit);
          const v = verdict(stats.ones, stats.agree);
          if (bit <= 3 && v === 'structured') highlight.push(rows.length);
          rows.push([
            `${ch.letter}${bit}`,
            `${(stats.ones * 100).toFixed(1)}%`,
            `${(stats.agree * 100).toFixed(0)}%`,
            v,
          ]);
          images.push({
            type: 'image',
            label: `${ch.letter}${bit} (${ch.name.toLowerCase()} bit ${bit}${bitName(bit)})`,
            image: bitPlaneImage(shown, ch.index, bit),
            filename: `plane-${ch.id}${bit}.png`,
          });
        }
      }
      out.push({
        type: 'note',
        level: 'info',
        text:
          'Hidden data usually sits in the low planes (bit 0 to 3). Look for text, QR codes or patterns where the rest looks like static; ' +
          (opaque
            ? 'alpha planes are skipped because alpha is 255 everywhere.'
            : 'alpha planes are included.'),
      });
      if (scaled) {
        out.push({
          type: 'note',
          level: 'info',
          text: `Planes are shrunk to ${shown.width}x${shown.height} (nearest-neighbour). Use "One plane" for the full size.`,
        });
      }
      out.push({
        type: 'table',
        label: 'Plane summary',
        columns: ['Plane', 'Ones', 'Neighbours equal', 'Looks'],
        rows,
        highlight,
      });
      out.push(...images);
      return out;
    }

    // filters
    const { image: src, scaled } = fitImage(image, FILTER_SIDE);
    const keepAlpha = o.alpha;
    const finish = (img: RgbaImage): RgbaImage => {
      if (!keepAlpha) return img;
      const data = new Uint8ClampedArray(img.data);
      for (let i = 3; i < data.length; i += 4) data[i] = src.data[i]!;
      return { width: img.width, height: img.height, data };
    };
    const want = (f: string) => o.filter === 'all' || o.filter === f;
    const add = (label: string, img: RgbaImage, file: string) =>
      out.push({ type: 'image', label, image: finish(img), filename: `${file}.png` });

    if (scaled) {
      out.push({
        type: 'note',
        level: 'info',
        text: `Filters are applied to a ${src.width}x${src.height} copy (nearest-neighbour) because the image is very large.`,
      });
    }
    if (!opaque && !keepAlpha) {
      out.push({
        type: 'note',
        level: 'info',
        text: 'The image has transparency. Outputs are opaque so colours hidden under transparent pixels are visible.',
      });
    }
    if (want('invert'))
      add(
        'Inverted',
        mapRgb(src, (r, g, b) => [255 - r, 255 - g, 255 - b]),
        'inverted',
      );
    if (want('grayscale')) {
      add(
        'Grayscale',
        mapRgb(src, (r, g, b) => {
          const y = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
          return [y, y, y];
        }),
        'grayscale',
      );
    }
    if (want('channels')) {
      for (const ch of CHANNELS) {
        if (ch.id === 'a' && opaque) continue;
        add(`${ch.name} channel alone (grey)`, channelImage(src, ch.index), `channel-${ch.id}`);
      }
    }
    if (want('colormap')) {
      out.push({
        type: 'note',
        level: 'info',
        text: 'Random colormap: every distinct value gets its own vivid colour, so shades that look identical but differ by 1 become clearly different areas.',
      });
      add('Random colormap (every distinct colour)', randomColormap(src, -1), 'colormap');
      for (const ch of CHANNELS) {
        if (ch.id === 'a' && opaque) continue;
        add(
          `Random colormap, ${ch.name.toLowerCase()} channel`,
          randomColormap(src, ch.index),
          `colormap-${ch.id}`,
        );
      }
    }
    if (want('equalize')) add('Histogram equalized', equalize(src), 'equalized');
    if (o.filter === 'xor' || (o.filter === 'all' && o.xor !== 0)) {
      if (!Number.isInteger(o.xor) || o.xor < 0 || o.xor > 255) {
        throw new ToolError('XOR value must be a whole number from 0 to 255.');
      }
      const k = o.xor;
      add(
        `XOR with ${k} (0x${k.toString(16).padStart(2, '0')})`,
        mapRgb(src, (r, g, b) => [r ^ k, g ^ k, b ^ k]),
        `xor-${k}`,
      );
    }
    return out;
  },
});
