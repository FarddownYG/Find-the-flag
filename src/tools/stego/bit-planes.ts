import { bool, defineTool, number, select, toggle } from '../../core/define';
import { ToolError } from '../../core/errors';
import type { Output, RgbaImage } from '../../core/types';
import { toolT } from '../../i18n/tool-text';
import {
  bitPlaneImage,
  channelImage,
  equalize,
  fitImage,
  mapRgb,
  planeStats,
  randomColormap,
} from './_pixels';

const T = toolT('bit-planes');

const CHANNELS = [
  { id: 'r', letter: 'R', name: () => T('channel.r'), index: 0 },
  { id: 'g', letter: 'G', name: () => T('channel.g'), index: 1 },
  { id: 'b', letter: 'B', name: () => T('channel.b'), index: 2 },
  { id: 'a', letter: 'A', name: () => T('channel.a'), index: 3 },
] as const;

const PLANE_SIDE = 512;
const ONE_SIDE = 4096;
const FILTER_SIDE = 1024;

const hasAlpha = (img: RgbaImage) => {
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i] !== 255) return true;
  return false;
};

/** "Green bit 0 (lowest)": the channel name, the bit and a hint for the two ends. */
const planeName = (channel: string, bit: number) =>
  bit === 0
    ? T('label.planeLowest', { channel, bit })
    : bit === 7
      ? T('label.planeHighest', { channel, bit })
      : T('label.plane', { channel, bit });

type Verdict = 'blank0' | 'blank1' | 'noise' | 'structured';

function verdict(ones: number, agree: number): Verdict {
  if (ones === 0) return 'blank0';
  if (ones === 1) return 'blank1';
  if (agree < 0.58) return 'noise';
  return 'structured';
}

const verdictText = (v: Verdict) =>
  v === 'blank0'
    ? T('value.blank0')
    : v === 'blank1'
      ? T('value.blank1')
      : v === 'noise'
        ? T('value.noise')
        : T('value.structured');

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
      if (!ch) throw new ToolError(T('error.channel'));
      if (!Number.isInteger(o.bit) || o.bit < 0 || o.bit > 7) {
        throw new ToolError(T('error.bit'));
      }
      const { image: shown, scaled } = fitImage(image, ONE_SIDE);
      const stats = planeStats(image, ch.index, o.bit);
      out.push({
        type: 'kv',
        entries: [
          [T('kv.plane'), planeName(ch.name(), o.bit)],
          [T('kv.ones'), `${(stats.ones * 100).toFixed(1)}%`],
          [T('kv.looks'), verdictText(verdict(stats.ones, stats.agree))],
        ],
      });
      if (ch.id === 'a' && opaque) {
        out.push({
          type: 'note',
          level: 'info',
          text: T('note.alphaConstant'),
        });
      }
      if (scaled) {
        out.push({
          type: 'note',
          level: 'info',
          text: T('note.shown', { w: shown.width, h: shown.height }),
        });
      }
      out.push({
        type: 'image',
        label: planeName(ch.name(), o.bit),
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
            verdictText(v),
          ]);
          images.push({
            type: 'image',
            label: `${ch.letter}${bit} (${planeName(ch.name().toLowerCase(), bit)})`,
            image: bitPlaneImage(shown, ch.index, bit),
            filename: `plane-${ch.id}${bit}.png`,
          });
        }
      }
      out.push({
        type: 'note',
        level: 'info',
        text: opaque ? T('note.lowPlanesOpaque') : T('note.lowPlanesAlpha'),
      });
      if (scaled) {
        out.push({
          type: 'note',
          level: 'info',
          text: T('note.shrunk', { w: shown.width, h: shown.height }),
        });
      }
      out.push({
        type: 'table',
        label: T('label.summary'),
        columns: [T('col.plane'), T('col.ones'), T('col.neighbours'), T('col.looks')],
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
        text: T('note.filterScaled', { w: src.width, h: src.height }),
      });
    }
    if (!opaque && !keepAlpha) {
      out.push({
        type: 'note',
        level: 'info',
        text: T('note.transparency'),
      });
    }
    if (want('invert'))
      add(
        T('label.inverted'),
        mapRgb(src, (r, g, b) => [255 - r, 255 - g, 255 - b]),
        'inverted',
      );
    if (want('grayscale')) {
      add(
        T('label.grayscale'),
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
        add(
          T('label.channelAlone', { channel: ch.name() }),
          channelImage(src, ch.index),
          `channel-${ch.id}`,
        );
      }
    }
    if (want('colormap')) {
      out.push({
        type: 'note',
        level: 'info',
        text: T('note.colormap'),
      });
      add(T('label.colormap'), randomColormap(src, -1), 'colormap');
      for (const ch of CHANNELS) {
        if (ch.id === 'a' && opaque) continue;
        add(
          T('label.colormapChannel', { channel: ch.name().toLowerCase() }),
          randomColormap(src, ch.index),
          `colormap-${ch.id}`,
        );
      }
    }
    if (want('equalize')) add(T('label.equalized'), equalize(src), 'equalized');
    if (o.filter === 'xor' || (o.filter === 'all' && o.xor !== 0)) {
      if (!Number.isInteger(o.xor) || o.xor < 0 || o.xor > 255) {
        throw new ToolError(T('error.xor'));
      }
      const k = o.xor;
      add(
        T('label.xor', { k, hex: k.toString(16).padStart(2, '0') }),
        mapRgb(src, (r, g, b) => [r ^ k, g ^ k, b ^ k]),
        `xor-${k}`,
      );
    }
    return out;
  },
});
