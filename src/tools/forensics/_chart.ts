/**
 * A tiny raster canvas for the Entropy tool: rectangles, lines and a built-in 5x7 digit font,
 * drawn straight into RGBA so it works in Node, workers and the browser alike.
 */
import type { RgbaImage } from '../../core/types';

export type Rgb = readonly [number, number, number];

/** Palette matching the app (dark ground, sea blue, amber, alert red). */
export const COLORS = {
  ground: [20, 32, 49] as Rgb,
  grid: [36, 52, 75] as Rgb,
  axis: [95, 112, 136] as Rgb,
  label: [139, 155, 176] as Rgb,
  sea: [122, 167, 242] as Rgb,
  amber: [229, 160, 70] as Rgb,
  alert: [239, 108, 85] as Rgb,
  ok: [99, 207, 166] as Rgb,
  soft: [58, 80, 112] as Rgb,
};

/** 5x7 glyphs, one string per row ('#' = ink). Digits, hex letters, K M G, '.', '-', 'x'. */
export const FONT: Record<string, readonly string[]> = {
  '0': ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  '3': ['#####', '...#.', '..#..', '...#.', '....#', '#...#', '.###.'],
  '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  '6': ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
  '7': ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  '9': ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.###.'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  x: ['.....', '.....', '#...#', '.#.#.', '..#..', '.#.#.', '#...#'],
  '.': ['.....', '.....', '.....', '.....', '.....', '.##..', '.##..'],
  '-': ['.....', '.....', '.....', '#####', '.....', '.....', '.....'],
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
};

export class Canvas {
  readonly data: Uint8ClampedArray;

  constructor(
    readonly width: number,
    readonly height: number,
    background: Rgb,
  ) {
    this.data = new Uint8ClampedArray(width * height * 4);
    this.rect(0, 0, width, height, background);
  }

  px(x: number, y: number, c: Rgb): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const o = (y * this.width + x) * 4;
    this.data[o] = c[0];
    this.data[o + 1] = c[1];
    this.data[o + 2] = c[2];
    this.data[o + 3] = 255;
  }

  rect(x: number, y: number, w: number, h: number, c: Rgb): void {
    const x1 = Math.min(this.width, Math.round(x + w));
    const y1 = Math.min(this.height, Math.round(y + h));
    for (let yy = Math.max(0, Math.round(y)); yy < y1; yy++) {
      for (let xx = Math.max(0, Math.round(x)); xx < x1; xx++) this.px(xx, yy, c);
    }
  }

  /** Horizontal line; `dash` = [on, off] pixel lengths for a dashed one. */
  hline(x0: number, x1: number, y: number, c: Rgb, dash?: readonly [number, number]): void {
    for (let x = Math.round(x0); x <= Math.round(x1); x++) {
      if (dash && (x - Math.round(x0)) % (dash[0] + dash[1]) >= dash[0]) continue;
      this.px(x, Math.round(y), c);
    }
  }

  vline(x: number, y0: number, y1: number, c: Rgb): void {
    for (let y = Math.round(y0); y <= Math.round(y1); y++) this.px(Math.round(x), y, c);
  }

  /** Straight line of the given thickness (Bresenham with a square brush). */
  line(x0: number, y0: number, x1: number, y1: number, c: Rgb, thick = 1): void {
    let x = Math.round(x0);
    let y = Math.round(y0);
    const xe = Math.round(x1);
    const ye = Math.round(y1);
    const dx = Math.abs(xe - x);
    const dy = -Math.abs(ye - y);
    const sx = x < xe ? 1 : -1;
    const sy = y < ye ? 1 : -1;
    let err = dx + dy;
    const half = Math.floor(thick / 2);
    for (;;) {
      this.rect(x - half, y - half, thick, thick, c);
      if (x === xe && y === ye) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y += sy;
      }
    }
  }

  textWidth(s: string, scale = 2): number {
    return s.length === 0 ? 0 : s.length * 6 * scale - scale;
  }

  /** Draw `s` with its top-left corner at (x, y); align 'right' puts x at the right edge. */
  text(
    x: number,
    y: number,
    s: string,
    c: Rgb,
    scale = 2,
    align: 'left' | 'center' | 'right' = 'left',
  ): void {
    const w = this.textWidth(s, scale);
    let cx = align === 'left' ? x : align === 'center' ? x - Math.round(w / 2) : x - w;
    for (const ch of s) {
      const g = FONT[ch] ?? FONT[' ']!;
      for (let row = 0; row < 7; row++) {
        for (let col = 0; col < 5; col++) {
          if (g[row]![col] === '#') this.rect(cx + col * scale, y + row * scale, scale, scale, c);
        }
      }
      cx += 6 * scale;
    }
  }

  image(): RgbaImage {
    return { width: this.width, height: this.height, data: this.data };
  }
}

/** 0, 512, 64K, 1.5M, 2G: short offsets for axis labels. */
export function shortSize(n: number): string {
  const trim = (v: number) => String(Math.round(v * 10) / 10);
  if (n < 1024) return String(Math.round(n));
  if (n < 1024 * 1024) return `${trim(n / 1024)}K`;
  if (n < 1024 ** 3) return `${trim(n / 1024 ** 2)}M`;
  return `${trim(n / 1024 ** 3)}G`;
}
