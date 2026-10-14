import { bool, defineTool, file, select } from '../../core/define';
import { ToolError } from '../../core/errors';
import type { RgbaImage } from '../../core/types';
import { toolT } from '../../i18n/tool-text';

const T = toolT('image-combine');

type Op = 'xor' | 'diff' | 'add' | 'sub' | 'and' | 'or' | 'mask';

const OPS: Record<Exclude<Op, 'mask'>, (a: number, b: number) => number> = {
  xor: (a, b) => a ^ b,
  diff: (a, b) => Math.abs(a - b),
  add: (a, b) => (a + b) & 0xff,
  sub: (a, b) => (a - b) & 0xff,
  and: (a, b) => a & b,
  or: (a, b) => a | b,
};

/** Combine two images pixel by pixel (stegsolve "Image Combiner"). */
export function combine(a: RgbaImage, b: RgbaImage, op: Op, amplify: boolean) {
  const width = Math.min(a.width, b.width);
  const height = Math.min(a.height, b.height);
  const data = new Uint8ClampedArray(width * height * 4);
  let differing = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const ia = (y * a.width + x) * 4;
      const ib = (y * b.width + x) * 4;
      const o = (y * width + x) * 4;
      let differs = false;
      for (let c = 0; c < 3; c++) {
        const va = a.data[ia + c]!;
        const vb = b.data[ib + c]!;
        if (va !== vb) differs = true;
        if (op === 'mask') continue;
        const v = OPS[op](va, vb);
        data[o + c] = amplify && (op === 'xor' || op === 'diff') && v ? 255 : v;
      }
      if (op === 'mask') data[o] = data[o + 1] = data[o + 2] = differs ? 255 : 0;
      data[o + 3] = 255;
      if (differs) {
        differing++;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  const box = maxX < 0 ? null : { minX, minY, maxX, maxY };
  return { image: { width, height, data }, differing, box };
}

export default defineTool({
  id: 'image-combine',
  name: 'Combine two images',
  category: 'stego',
  description:
    'XOR, subtract or diff two images pixel by pixel to reveal what differs between them.',
  tags: ['stegsolve', 'image combiner', 'xor images', 'diff', 'compare', 'twin'],
  input: 'image',
  options: {
    other: file('Second image', 'image'),
    op: select(
      'Operation',
      [
        { value: 'xor', label: 'XOR' },
        { value: 'diff', label: 'Difference |a−b|' },
        { value: 'mask', label: 'Mask of differing pixels' },
        { value: 'sub', label: 'Subtract a−b' },
        { value: 'add', label: 'Add' },
        { value: 'and', label: 'AND' },
        { value: 'or', label: 'OR' },
      ],
      'xor',
    ),
    amplify: bool('Amplify tiny differences', true, {
      showIf: (v) => v.op === 'xor' || v.op === 'diff',
      hint: 'Any non-zero channel becomes 255, so a 1-bit change is visible.',
    }),
  },
  examples: [
    {
      label: 'Twin images',
      input: { sample: 'stego-twin-a.png' },
      options: { other: { sample: 'stego-twin-b.png' } },
      expect: 'Differing pixels',
    },
    {
      label: 'Mask',
      input: { sample: 'stego-twin-a.png' },
      options: { other: { sample: 'stego-twin-b.png' }, op: 'mask' },
      expect: 'Bounding box: x 4',
    },
  ],
  run({ image }, { other, op, amplify }) {
    if (!other) {
      throw new ToolError(T('error.noSecond'));
    }
    const r = combine(image, other.image, op, amplify);
    const sameSize = image.width === other.image.width && image.height === other.image.height;
    return [
      ...(sameSize
        ? []
        : [
            {
              type: 'note' as const,
              level: 'warn' as const,
              text: T('note.sizes', {
                aw: image.width,
                ah: image.height,
                bw: other.image.width,
                bh: other.image.height,
                w: r.image.width,
                h: r.image.height,
              }),
            },
          ]),
      {
        type: 'image',
        label: T('label.result', { op: op.toUpperCase() }),
        image: r.image,
        filename: `combined-${op}.png`,
      },
      {
        type: 'kv',
        label: T('label.comparison'),
        entries: [
          [T('kv.differing'), String(r.differing)],
          [
            T('kv.box'),
            r.box
              ? T('value.box', { x0: r.box.minX, x1: r.box.maxX, y0: r.box.minY, y1: r.box.maxY })
              : T('value.identical'),
          ],
        ],
      },
    ];
  },
});
