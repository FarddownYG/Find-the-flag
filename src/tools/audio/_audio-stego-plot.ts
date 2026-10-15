/**
 * The bit-plane view: for each channel and each of the four lowest bit planes, the share of ones
 * over time, drawn as bars. Digital silence is flat (0, or 1 for a negative offset), natural sound
 * and hidden data sit around 0.5, so data hidden in a quiet or silent stretch shows up as a block
 * where the plane wakes up. Drawn straight into RGBA with the entropy chart's raster canvas.
 */
import type { RgbaImage } from '../../core/types';
import { Canvas, COLORS, FONT, type Rgb } from '../forensics/_chart';
import { formatTime, niceStep, timeTicks } from './_axes';
import { STAT_PLANES, type PlaneStats } from './_audio-stego-pcm';

const GLYPHS: Record<string, readonly string[]> = {
  ...FONT,
  I: ['.###.', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  s: ['.....', '.....', '.####', '#....', '.###.', '....#', '####.'],
  ':': ['.....', '.##..', '.##..', '.....', '.##..', '.##..', '.....'],
};

/** Where the bits of a hit come from: frames [from, to) of these channels (all when empty). */
export interface PlotMark {
  fromFrame: number;
  toFrame: number;
  channels: number[];
}

const LEFT = 52;
const RIGHT = 10;
const TOP = 8;
const STRIP = 30;
const GAP = 4;
const GROUP_GAP = 10;
const AXIS = 26;
const WIDTH = 720;

const FLAT = 0.02;
const RANDOM: readonly [number, number] = [0.3, 0.7];

function label(c: Canvas, x: number, y: number, s: string, color: Rgb, align: 'left' | 'right') {
  const scale = 2;
  const w = s.length * 6 * scale - scale;
  let cx = align === 'right' ? x - w : x;
  for (const ch of s) {
    const g = GLYPHS[ch] ?? GLYPHS[' ']!;
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 5; col++) {
        if (g[row]![col] === '#') c.rect(cx + col * scale, y + row * scale, scale, scale, color);
      }
    }
    cx += 6 * scale;
  }
}

const channelName = (c: number, channels: number): string =>
  channels === 1 ? '' : channels === 2 ? (c === 0 ? 'L' : 'R') : `${c + 1}-`;

export function renderPlanes(s: PlaneStats, rate: number, mark: PlotMark | null): RgbaImage {
  const colW = Math.max(1, Math.floor((WIDTH - LEFT - RIGHT) / s.columns));
  const plotW = colW * s.columns;
  const width = LEFT + plotW + RIGHT;
  const groupH = STAT_PLANES * STRIP + (STAT_PLANES - 1) * GAP;
  const height = TOP + s.channels * groupH + (s.channels - 1) * GROUP_GAP + AXIS;
  const c = new Canvas(width, height, COLORS.ground);
  const xOf = (frame: number) => LEFT + Math.round((frame / s.windowFrames) * colW);

  for (let ch = 0; ch < s.channels; ch++) {
    const gy = TOP + ch * (groupH + GROUP_GAP);
    for (let pl = 0; pl < STAT_PLANES; pl++) {
      const y = gy + pl * (STRIP + GAP);
      c.rect(LEFT, y, plotW, STRIP, COLORS.grid);
      c.rect(LEFT, y, plotW, STRIP, [27, 41, 61]);
      const ratios = s.ratios[ch]![pl]!;
      for (let col = 0; col < ratios.length; col++) {
        const r = ratios[col]!;
        const flat = r <= FLAT || r >= 1 - FLAT;
        const random = r >= RANDOM[0] && r <= RANDOM[1];
        const h = Math.max(1, Math.round(r * (STRIP - 1)));
        c.rect(
          LEFT + col * colW,
          y + STRIP - h,
          colW,
          h,
          flat ? COLORS.soft : random ? COLORS.amber : COLORS.sea,
        );
      }
      c.hline(LEFT, LEFT + plotW - 1, y + (STRIP - 1) / 2, COLORS.axis, [2, 4]); // 0.5
      c.rect(LEFT, y + STRIP - 1, plotW, 1, COLORS.axis); // 0
      label(
        c,
        LEFT - 6,
        y + STRIP / 2 - 7,
        `${channelName(ch, s.channels)}${pl}`,
        COLORS.label,
        'right',
      );
    }
    if (mark && (mark.channels.length === 0 || mark.channels.includes(ch))) {
      const x0 = xOf(mark.fromFrame);
      const x1 = Math.max(x0 + 2, xOf(mark.toFrame));
      for (let pl = 0; pl < STAT_PLANES; pl++) {
        c.rect(x0, gy + pl * (STRIP + GAP), Math.min(x1, LEFT + plotW) - x0, 2, COLORS.ok);
      }
      c.vline(x0, gy, gy + groupH, COLORS.ok);
    }
  }

  // Time axis.
  const total = (s.frames || 1) / rate;
  const ay = TOP + s.channels * groupH + (s.channels - 1) * GROUP_GAP + 4;
  c.hline(LEFT, LEFT + plotW - 1, ay, COLORS.axis);
  const ticks = timeTicks(0, total, Math.max(2, Math.floor(plotW / 90)));
  const step = ticks.length > 1 ? ticks[1]!.value - ticks[0]!.value : niceStep(total, 4);
  for (const t of ticks) {
    const x = LEFT + Math.round((t.value / total) * plotW);
    if (x > LEFT + plotW) continue;
    c.vline(x, ay, ay + 4, COLORS.axis);
    label(
      c,
      Math.min(x, width - 6),
      ay + 8,
      formatTime(t.value, step, total >= 60),
      COLORS.label,
      x > LEFT + plotW - 30 ? 'right' : 'left',
    );
  }
  return c.image();
}
