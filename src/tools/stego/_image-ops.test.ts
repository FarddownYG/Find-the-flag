import { describe, expect, it } from 'vitest';
import type { RgbaImage } from '../../core/types';
import {
  channelDiff,
  gammaImage,
  rgbReduce,
  sobel,
  stretchImage,
  superimposePlane,
} from './_image-ops';

const img = (w: number, h: number, px: number[][]): RgbaImage => ({
  width: w,
  height: h,
  data: Uint8ClampedArray.from(px.flatMap(([r, g, b]) => [r!, g!, b!, 255])),
});
const grey = (i: RgbaImage) => Array.from({ length: i.width * i.height }, (_, k) => i.data[k * 4]!);

describe('image ops', () => {
  const two = img(2, 2, [
    [1, 1, 1],
    [1, 0, 0],
    [1, 1, 0],
    [0, 0, 0],
  ]);
  it('superimposes a bit with or / and / xor', () => {
    expect(grey(superimposePlane(two, 0, 'or'))).toEqual([255, 255, 255, 0]);
    expect(grey(superimposePlane(two, 0, 'and'))).toEqual([255, 0, 0, 0]);
    expect(grey(superimposePlane(two, 0, 'xor'))).toEqual([255, 255, 0, 0]);
  });
  it('reduces RGB to min, max and median', () => {
    const i = img(1, 2, [
      [10, 200, 50],
      [7, 7, 9],
    ]);
    expect(grey(rgbReduce(i, 'min'))).toEqual([10, 7]);
    expect(grey(rgbReduce(i, 'max'))).toEqual([200, 9]);
    expect(grey(rgbReduce(i, 'median'))).toEqual([50, 7]);
  });
  it('diffs channels', () => {
    const i = img(1, 1, [[0b1100, 0b1010, 3]]);
    expect(grey(channelDiff(i, 0, 1, 'xor'))).toEqual([0b0110]);
    expect(grey(channelDiff(i, 1, 2, 'sub'))).toEqual([7]);
    expect(grey(channelDiff(i, 2, 1, 'sub'))).toEqual([7]);
  });
  it('sobel is flat on flat images and fires on a vertical edge', () => {
    const flat = img(
      3,
      3,
      Array.from({ length: 9 }, () => [90, 90, 90]),
    );
    expect(grey(sobel(flat))).toEqual(Array(9).fill(0));
    const edge = img(
      4,
      3,
      Array.from({ length: 12 }, (_, k) => (k % 4 < 2 ? [0, 0, 0] : [255, 255, 255])),
    );
    const s = grey(sobel(edge));
    expect(s[0]).toBe(0);
    expect(s[1]).toBe(255);
    expect(s[2]).toBe(255);
    expect(s[3]).toBe(0);
  });
  it('gamma lifts mid-tones, stretch spreads a narrow range', () => {
    const i = img(2, 1, [
      [64, 64, 64],
      [255, 255, 255],
    ]);
    const g = gammaImage(i, 2);
    expect(g.data[0]).toBe(128);
    expect(g.data[4]).toBe(255);
    const narrow = img(
      4,
      1,
      [100, 101, 102, 103].map((v) => [v, v, v]),
    );
    const s = stretchImage(narrow);
    expect(Math.min(...grey(s))).toBe(0);
    expect(Math.max(...grey(s))).toBe(255);
  });
});
