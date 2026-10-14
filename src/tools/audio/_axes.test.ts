import { describe, expect, it } from 'vitest';
import {
  drawAxes,
  formatFrequency,
  formatTime,
  frequencyToY,
  linearFrequencyTicks,
  logFrequencyTicks,
  axesLayout,
  plotRect,
  niceStep,
  timeTicks,
  timeToX,
  type AxesSpec,
} from './_axes';

describe('niceStep', () => {
  it('picks 1, 2 or 5 times a power of ten', () => {
    expect(niceStep(4000, 8)).toBe(500);
    expect(niceStep(11025, 8)).toBe(2000);
    expect(niceStep(24000, 8)).toBe(5000);
    expect(niceStep(96000, 10)).toBe(10000);
    expect(niceStep(50, 8)).toBe(10);
    expect(niceStep(0.3, 6)).toBe(0.05);
  });
});

describe('frequency ticks', () => {
  it.each([
    [8000, [0, 500, 1000, 1500, 2000, 2500, 3000, 3500, 4000]],
    [22050, [0, 2000, 4000, 6000, 8000, 10000]],
    [44100, [0, 5000, 10000, 15000, 20000]],
    [96000, [0, 10000, 20000, 30000, 40000]],
    [192000, [0, 20000, 40000, 60000, 80000]],
  ])('%i Hz sampling: ticks across 0 to Nyquist', (fs, expected) => {
    const ticks = linearFrequencyTicks(0, fs / 2, 8);
    expect(ticks.map((t) => t.value)).toEqual(expected);
    expect(ticks.at(-1)!.value).toBeLessThanOrEqual(fs / 2);
    expect(ticks.at(-1)!.value).toBeGreaterThan((fs / 2) * 0.7);
  });

  it('labels in Hz below 1 kHz and kHz above', () => {
    expect(formatFrequency(0, 500)).toBe('0Hz');
    expect(formatFrequency(500, 500)).toBe('500Hz');
    expect(formatFrequency(1000, 500)).toBe('1kHz');
    expect(formatFrequency(1500, 500)).toBe('1.5kHz');
    expect(formatFrequency(12500, 2500)).toBe('12.5kHz');
    expect(formatFrequency(11000, 1000)).toBe('11kHz');
    expect(formatFrequency(6050, 50)).toBe('6.05kHz');
    expect(formatFrequency(6005, 5)).toBe('6005Hz');
    expect(formatFrequency(0.5, 0.25)).toBe('0.5Hz');
  });

  it('a narrow zoom gets fine ticks', () => {
    const ticks = linearFrequencyTicks(6000, 6100, 8);
    expect(ticks.map((t) => t.value)).toEqual([6000, 6020, 6040, 6060, 6080, 6100]);
    expect(ticks[1]!.label).toBe('6.02kHz');
  });

  it('log ticks are 1-2-5 values, thinned so they never overlap', () => {
    const ticks = logFrequencyTicks(20, 11025, 1000);
    const values = ticks.map((t) => t.value);
    expect(values).toContain(100);
    expect(values).toContain(1000);
    expect(values).toContain(10000);
    expect(values.every((v) => v >= 20 && v <= 11025)).toBe(true);
    expect(values).toEqual([...values].sort((a, b) => a - b));
    const y = (v: number) => (Math.log(v / 20) / Math.log(11025 / 20)) * 1000;
    for (let i = 1; i < values.length; i++) {
      expect(y(values[i]!) - y(values[i - 1]!)).toBeGreaterThanOrEqual(26);
    }
    // A short picture keeps only the decades.
    const few = logFrequencyTicks(20, 11025, 120).map((t) => t.value);
    expect(few.length).toBeLessThan(values.length);
    expect(few).toContain(1000);
  });
});

describe('time ticks', () => {
  it('uses fractions of a second for short files', () => {
    const ticks = timeTicks(0, 3, 8);
    expect(ticks.map((t) => t.label)).toEqual(['0s', '0.5s', '1s', '1.5s', '2s', '2.5s', '3s']);
  });

  it('uses minutes:seconds for long files', () => {
    const ticks = timeTicks(0, 600, 8);
    expect(ticks.map((t) => t.label)).toEqual(['0:00', '2:00', '4:00', '6:00', '8:00', '10:00']);
    expect(
      timeTicks(0, 90, 8)
        .map((t) => t.label)
        .slice(0, 3),
    ).toEqual(['0:00', '0:15', '0:30']);
  });

  it('follows a zoomed window and formats hours', () => {
    expect(timeTicks(10, 11, 5).map((t) => t.value)).toEqual([10, 10.2, 10.4, 10.6, 10.8, 11]);
    expect(formatTime(3725, 1)).toBe('1:02:05');
    expect(formatTime(125.5, 0.5, true)).toBe('2:05.5');
    expect(formatTime(0.125, 0.005)).toBe('0.125s');
  });

  it('has no ticks for an empty range', () => {
    expect(timeTicks(2, 2, 8)).toEqual([]);
  });
});

describe('drawAxes', () => {
  const spec: AxesSpec = {
    width: 200,
    height: 400,
    columnWidth: 1,
    hopSeconds: 0.01,
    t0: 0,
    t1: 2,
    fMin: 0,
    fMax: 5000,
    scale: 'linear',
  };
  const plot = {
    width: 200,
    height: 400,
    data: new Uint8ClampedArray(200 * 400 * 4).fill(7),
  };
  for (let i = 3; i < plot.data.length; i += 4) plot.data[i] = 255;
  const L = axesLayout(plot.width);

  it('keeps the plot pixels and adds the margins', () => {
    const img = drawAxes(plot, spec);
    expect(img.width).toBe(200 + L.left + L.right);
    expect(img.height).toBe(400 + L.top + L.bottom);
    const o = ((L.top + 50) * img.width + L.left + 100) * 4;
    expect([img.data[o], img.data[o + 1], img.data[o + 2], img.data[o + 3]]).toEqual([
      7, 7, 7, 255,
    ]);
  });

  it('draws a tick mark and a label at the height of every frequency tick', () => {
    const img = drawAxes(plot, spec);
    const inked = (x: number, y: number) => img.data[(y * img.width + x) * 4]! > 150;
    for (const hz of [0, 1000, 3000, 5000]) {
      const y = L.top + Math.floor(frequencyToY(spec, hz));
      expect(inked(L.left - 2, y)).toBe(true); // the tick mark
      // the label: some ink in the margin left of the tick, within the label's height
      let ink = 0;
      for (let yy = y - 6; yy <= y + 6; yy++) {
        for (let x = 0; x < L.left - 8; x++) if (inked(x, yy)) ink++;
      }
      expect(ink).toBeGreaterThan(8);
    }
    // a place between ticks is empty
    const between = L.top + Math.floor(frequencyToY(spec, 1500));
    expect(inked(L.left - 2, between)).toBe(false);
  });

  it('draws ticks along the bottom for the time axis', () => {
    const img = drawAxes(plot, spec);
    const yTick = L.top + plot.height + 2;
    const inked = (x: number) => img.data[(yTick * img.width + x) * 4]! > 150;
    const xs = Array.from({ length: img.width }, (_, x) => x).filter(inked);
    expect(xs.length).toBeGreaterThanOrEqual(2);
    const x1s = L.left + Math.round(timeToX(spec, 1) - 0.5);
    expect(inked(x1s)).toBe(true);
  });
});

describe('layout', () => {
  it('grows the label font with the picture so labels stay readable when it is shown scaled', () => {
    expect(axesLayout(300).scale).toBe(2);
    expect(axesLayout(900).scale).toBe(3);
    expect(axesLayout(2000).scale).toBe(5);
    expect(axesLayout(300)).toMatchObject({ left: 96, right: 28, top: 12, bottom: 30 });
  });

  it('plotRect inverts the layout for every possible width', () => {
    for (let w = 40; w <= 2000; w += 7) {
      const l = axesLayout(w);
      expect(plotRect(w + l.left + l.right, 500 + l.top + l.bottom)).toEqual({
        x: l.left,
        y: l.top,
        width: w,
        height: 500,
        scale: l.scale,
      });
    }
  });
});
