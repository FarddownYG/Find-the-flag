import { defineTool, number, text } from '../../core/define';
import type { Output, RgbaImage } from '../../core/types';
import { toolT } from '../../i18n/tool-text';

const T = toolT('color-inspector');

const SWATCH = 24; // px per colour block in the palette strip

interface ColorCount {
  r: number;
  g: number;
  b: number;
  a: number;
  count: number;
}

const hex2 = (n: number) => n.toString(16).padStart(2, '0');

function hexOf(c: ColorCount): string {
  const base = `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
  return c.a === 255 ? base : base + hex2(c.a);
}

/** HSL as whole degrees / percents, the way a colour picker shows it. */
function hslOf(c: ColorCount): string {
  const r = c.r / 255;
  const g = c.g / 255;
  const b = c.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return `${Math.round(h * 360)}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%`;
}

/** Count every distinct RGBA colour in one pass. */
function palette(img: RgbaImage): ColorCount[] {
  const counts = new Map<number, number>();
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const key = ((d[i]! << 24) | (d[i + 1]! << 16) | (d[i + 2]! << 8) | d[i + 3]!) >>> 0;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const out: ColorCount[] = [];
  for (const [key, count] of counts) {
    out.push({
      r: (key >>> 24) & 0xff,
      g: (key >>> 16) & 0xff,
      b: (key >>> 8) & 0xff,
      a: key & 0xff,
      count,
    });
  }
  return out;
}

/** A horizontal strip of colour blocks, drawn as its own image. */
function swatchStrip(colors: ColorCount[]): RgbaImage {
  const width = Math.max(1, colors.length * SWATCH);
  const height = SWATCH;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let x = 0; x < width; x++) {
    const c = colors[Math.floor(x / SWATCH)];
    if (!c) continue;
    for (let y = 0; y < height; y++) {
      const i = (y * width + x) * 4;
      data[i] = c.r;
      data[i + 1] = c.g;
      data[i + 2] = c.b;
      data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

function colorRow(c: ColorCount, total: number): (string | number)[] {
  return [
    hexOf(c),
    `${c.r}, ${c.g}, ${c.b}${c.a === 255 ? '' : `, ${c.a}`}`,
    hslOf(c),
    c.count,
    `${((c.count / total) * 100).toFixed(c.count / total < 0.01 ? 3 : 1)}%`,
  ];
}

/** Read the "x,y x2,y2" coordinate list; out-of-range and unparseable entries are reported too. */
function pickedPixels(img: RgbaImage, raw: string): { rows: (string | number)[][]; bad: string[] } {
  const rows: (string | number)[][] = [];
  const bad: string[] = [];
  for (const tok of raw.split(/[\s;]+/).filter(Boolean)) {
    const m = /^(\d+),(\d+)$/.exec(tok);
    if (!m) {
      bad.push(tok);
      continue;
    }
    const x = Number(m[1]);
    const y = Number(m[2]);
    if (x >= img.width || y >= img.height) {
      bad.push(tok);
      continue;
    }
    const i = (y * img.width + x) * 4;
    const c: ColorCount = {
      r: img.data[i]!,
      g: img.data[i + 1]!,
      b: img.data[i + 2]!,
      a: img.data[i + 3]!,
      count: 1,
    };
    rows.push([
      `${x}, ${y}`,
      hexOf(c),
      `${c.r}, ${c.g}, ${c.b}${c.a === 255 ? '' : `, ${c.a}`}`,
      hslOf(c),
    ]);
  }
  return { rows, bad };
}

export default defineTool({
  id: 'color-inspector',
  name: 'Colour inspector',
  category: 'stego',
  description:
    'Read the exact colour of any pixel and the full palette of an image — the rare colours a hidden message hides in jump out.',
  tags: [
    'color picker',
    'colour picker',
    'eyedropper',
    'pipette',
    'palette',
    'hex color',
    'rgb',
    'hsl',
    'pixel color',
    'dominant colors',
    'rare color',
    'stego',
    'imagecolorpicker',
  ],
  input: 'image',
  options: {
    top: number('Palette size', 24, {
      min: 1,
      max: 256,
      hint: 'How many colours to show in the swatch strip and tables.',
    }),
    at: text('Pixels to read', '', {
      placeholder: '10,4 63,15',
      hint: 'Report the exact colour at these x,y coordinates (top-left is 0,0), space-separated.',
    }),
  },
  examples: [
    {
      label: 'Palette and the rare pixel',
      input: { sample: 'color-swatches.png' },
      expect: 'f2c84b',
    },
    {
      label: 'Read one pixel',
      input: { sample: 'color-swatches.png' },
      options: { at: '0,0' },
      expect: '#7aa7f2',
    },
  ],
  run({ image }, { top, at }) {
    const colors = palette(image);
    const total = image.width * image.height;
    const byCount = [...colors].sort((x, y) => y.count - x.count);
    const n = Math.max(1, Math.min(Math.floor(top) || 24, 256));

    const out: Output[] = [
      {
        type: 'kv',
        label: T('label.summary'),
        entries: [
          [T('kv.dimensions'), `${image.width} × ${image.height}`],
          [T('kv.pixels'), String(total)],
          [T('kv.distinct'), String(colors.length)],
        ],
      },
    ];

    const atText = at.trim();
    if (atText) {
      const { rows, bad } = pickedPixels(image, atText);
      if (rows.length) {
        out.push({
          type: 'table',
          label: T('label.picked'),
          columns: [T('col.coord'), T('col.hex'), T('col.rgb'), T('col.hsl')],
          rows,
        });
      }
      if (bad.length) {
        out.push({
          type: 'note',
          level: 'warn',
          text: T('note.badCoord', { list: bad.join(' ') }),
        });
      }
    }

    const common = byCount.slice(0, n);
    out.push({ type: 'image', label: T('label.swatch'), image: swatchStrip(common) });
    out.push({
      type: 'table',
      label: T('label.common'),
      columns: [T('col.hex'), T('col.rgb'), T('col.hsl'), T('col.count'), T('col.share')],
      rows: common.map((c) => colorRow(c, total)),
    });

    // Rare colours — the least common, where hidden pixels tend to sit.
    const threshold = Math.max(1, Math.round(total * 0.0005));
    const rare = [...colors].filter((c) => c.count <= threshold).sort((x, y) => x.count - y.count);
    if (rare.length && colors.length > common.length) {
      out.push({
        type: 'table',
        label: T('label.rare'),
        columns: [T('col.hex'), T('col.rgb'), T('col.hsl'), T('col.count'), T('col.share')],
        rows: rare.slice(0, n).map((c) => colorRow(c, total)),
      });
      out.push({
        type: 'note',
        level: 'info',
        text: T('note.rare', { count: rare.length, threshold }),
      });
    }
    return out;
  },
});
