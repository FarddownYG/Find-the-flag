import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseMp4 } from './_mp4';

const sample = (name: string) => new Uint8Array(readFileSync(`public/samples/${name}`));

describe('parseMp4', () => {
  it('finds the unreferenced region of an mdat with a hidden payload', () => {
    const r = parseMp4(sample('mp4-encrypted-mdat.mp4'));
    expect(r).not.toBeNull();
    expect(r?.boxes.map((b) => b.type)).toContain('stco');
    expect(r?.unreferenced).toEqual([{ start: 754, end: 754 + 1945600 }]);
  });

  it('reports no unreferenced byte on a clean video', () => {
    const r = parseMp4(sample('clean-video.mp4'));
    expect(r).not.toBeNull();
    expect(r?.mdat).not.toBeNull();
    expect(r?.unreferenced).toEqual([]);
    expect(r?.referencedRanges).toEqual([{ start: r?.mdat?.start, end: r?.mdat?.end }]);
  });

  it('returns null for non-MP4 input and for truncated headers', () => {
    expect(parseMp4(new Uint8Array(0))).toBeNull();
    expect(parseMp4(new TextEncoder().encode('not a movie at all, just text'))).toBeNull();
  });
});
