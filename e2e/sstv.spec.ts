import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

/**
 * SSTV in a real browser: recordings made by PySSTV (see scripts/gen-samples-sstv.py) are opened
 * through the file input, and the picture on the canvas is checked pixel by pixel.
 */
const sample = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../public/samples/${name}`, import.meta.url)));

/** An 8-bit unsigned mono WAV (what the samples are) as floats in [-1, 1]. */
function readWav8(buf: Buffer): { rate: number; x: Float32Array } {
  return {
    rate: buf.readUInt32LE(24),
    x: Float32Array.from(buf.subarray(44), (v) => (v - 128) / 128),
  };
}

/** 16-bit mono WAV. */
function wav16(x: Float32Array, rate: number): Buffer {
  const head = Buffer.alloc(44);
  const data = Buffer.alloc(x.length * 2);
  for (let i = 0; i < x.length; i++) {
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[i]! * 32767))), i * 2);
  }
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVEfmt ', 8, 'latin1');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36, 'latin1');
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

/** Small seeded noise generator (mulberry32 summed to a rough Gaussian). */
function noise(length: number, sigma: number, seed: number): Float32Array {
  let a = seed >>> 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return Float32Array.from({ length }, () => {
    let s = 0;
    for (let k = 0; k < 6; k++) s += rand();
    return (s - 3) * Math.SQRT2 * sigma;
  });
}

const open = async (page: Page, name: string, buffer: Buffer) => {
  await page.goto('./#/tool/sstv');
  await page
    .locator('.input-box input[type=file]')
    .setInputFiles({ name, mimeType: 'audio/wav', buffer });
  return page.locator('.pane-out');
};

/** RGB of canvas pixels, read from the page. */
const pixels = (page: Page, points: [number, number][]) =>
  page
    .locator('.pane-out canvas')
    .first()
    .evaluate((canvas: HTMLCanvasElement, pts: [number, number][]) => {
      const c2d = canvas.getContext('2d')!;
      return pts.map(([x, y]) => Array.from(c2d.getImageData(x, y, 1, 1).data.slice(0, 3)));
    }, points);

const near = (got: number[], want: number[], tol = 16) =>
  got.forEach((v, i) =>
    expect(Math.abs(v - want[i]!), `${got} vs ${want}`).toBeLessThanOrEqual(tol),
  );

test.describe('SSTV', () => {
  test('a dropped recording becomes a picture with the right colours, and downloads as PNG', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const out = await open(page, 'robot.wav', sample('sstv-martin-m1.wav'));
    await expect(out).toContainText('Mode: Martin M1', { timeout: 15_000 });
    await expect(out).toContainText('VIS header 44 (0x2c) at 0.61 s');
    await expect(out).toContainText('Lines received: 32 of 256');
    await expect(out.locator('.note-error')).toHaveCount(0);
    const canvas = out.locator('canvas').first();
    await expect(canvas).toHaveAttribute('width', '320');
    await expect(canvas).toHaveAttribute('height', '32');
    // Bars of the test picture: white, yellow, cyan, green, magenta, red, blue, black.
    const bars = [
      [255, 255, 255],
      [255, 255, 0],
      [0, 255, 255],
      [0, 255, 0],
      [255, 0, 255],
      [255, 0, 0],
      [0, 0, 255],
      [0, 0, 0],
    ];
    const got = await pixels(
      page,
      bars.map((_, i) => [i * 40 + 20, 1] as [number, number]),
    );
    bars.forEach((want, i) => near(got[i]!, want));
    // Dark blue background and the amber of FTF{SSTV}'s first letter (the F's top bar).
    const [background, ink] = await pixels(page, [
      [8, 20],
      [86, 7],
    ]);
    near(background!, [16, 24, 64]);
    near(ink!, [255, 220, 64], 40);

    const download = page.waitForEvent('download');
    await out.getByRole('button', { name: 'Download PNG' }).click();
    const file = await (await download).createReadStream();
    const chunks: Buffer[] = [];
    for await (const c of file) chunks.push(c as Buffer);
    const png = Buffer.concat(chunks);
    expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
    expect(png.readUInt32BE(16)).toBe(320);
    expect(png.readUInt32BE(20)).toBe(32);
    expect(errors).toEqual([]);
  });

  test('an MP3 recording goes through the browser decoder and still gives the picture', async ({
    page,
  }) => {
    // The Robot 36 recording as a 22050 Hz, 48 kbit/s MP3 (lossy: tones and timing survive).
    await page.goto('./#/tool/sstv');
    await page.locator('.input-box input[type=file]').setInputFiles({
      name: 'robot36.mp3',
      mimeType: 'audio/mpeg',
      buffer: sample('sstv-robot36.mp3'),
    });
    const out = page.locator('.pane-out');
    await expect(out).toContainText('Mode: Robot 36', { timeout: 20_000 });
    await expect(out).toContainText('Lines received: 32 of 240');
    await expect(out.locator('.note-error')).toHaveCount(0);
    const bars = [
      [255, 255, 255],
      [255, 255, 0],
      [0, 255, 255],
      [0, 255, 0],
      [255, 0, 255],
      [255, 0, 0],
      [0, 0, 255],
      [0, 0, 0],
    ];
    const got = await pixels(
      page,
      bars.map((_, i) => [i * 40 + 20, 2] as [number, number]),
    );
    bars.forEach((want, i) => near(got[i]!, want, 40));
    const [background] = await pixels(page, [[8, 20]]);
    near(background!, [16, 24, 64], 30);
  });

  test('without a VIS header the mode is guessed, and can be forced', async ({ page }) => {
    const { rate, x } = readWav8(sample('sstv-scottie-s1.wav'));
    const out = await open(page, 'headless.wav', wav16(x.subarray(Math.round(0.91 * rate)), rate));
    await expect(out).toContainText('Mode: Scottie S1', { timeout: 15_000 });
    await expect(out).toContainText('No VIS header was found');
    await expect(out).toContainText('Identified by: rhythm of the sync pulses');
    await page.locator('#opt-sstv-mode').selectOption('scottie-s1');
    await expect(out).toContainText('Identified by: the Mode option');
    await expect(out).toContainText('The picture starts at the first sync pulse');
    // A mode whose line time matches nothing in the file says so instead of drawing noise.
    await page.locator('#opt-sstv-mode').selectOption('pd240');
    await expect(out.locator('.note-error')).toContainText('No SSTV picture found');
  });

  test('a recording clock that is off is corrected, or set by hand', async ({ page }) => {
    const { rate, x } = readWav8(sample('sstv-scottie-s1.wav'));
    // Read 0.4 % too fast, as a sound card clock that is a little off does.
    const out = await open(page, 'slanted.wav', wav16(x, Math.round(rate * 1.004)));
    await expect(out).toContainText('Mode: Scottie S1', { timeout: 15_000 });
    await expect(out).toContainText(/Line time: 426\.\d\d ms \(standard 428\.22 ms, -39\d\d ppm\)/);
    await expect(out).toContainText('The line time differs from the standard by -39');
    const upright = await pixels(page, [
      [160, 18],
      [8, 20],
    ]);
    near(upright[1]!, [16, 24, 64]);

    await page.locator('.options').getByRole('button', { name: 'Set by hand' }).click();
    const ppm = page.locator('#opt-sstv-clockPpm');
    await expect(ppm).toBeVisible();
    await expect(out).toContainText('Line time set by hand (0 ppm)');
    // At 0 ppm the picture slants: the rows drift off and the sync pulses are lost.
    await expect(out).toContainText(/Sync pulses: \d of 31 located/);
    await ppm.fill('-3980');
    await ppm.press('Tab');
    await expect(out).toContainText('Sync pulses: 32 of 32 located');
    await expect(out).toContainText('Line time set by hand (-3980 ppm)');
    const fixed = await pixels(page, [[8, 20]]);
    near(fixed[0]!, [16, 24, 64]);
  });

  test('noise is reported, not drawn', async ({ page }) => {
    const out = await open(page, 'noise.wav', wav16(noise(8000 * 12, 0.3, 5), 8000));
    await expect(out.locator('.note-error')).toContainText('No SSTV picture found', {
      timeout: 15_000,
    });
    await expect(out.locator('canvas')).toHaveCount(0);
  });

  test('a two-minute recording decodes without blocking the page', async ({ page }, info) => {
    test.setTimeout(90_000);
    // The Martin M1 sample, resampled to 44.1 kHz and buried in faint noise at 40 s of 120 s.
    const { rate, x } = readWav8(sample('sstv-martin-m1.wav'));
    const to = 44100;
    const long = noise(120 * to, 0.01, 3);
    const pic = Math.floor((x.length * to) / rate);
    for (let i = 0; i < pic; i++) {
      const p = (i * rate) / to;
      const j = Math.floor(p);
      long[40 * to + i] = long[40 * to + i]! + x[j]! + (p - j) * ((x[j + 1] ?? x[j]!) - x[j]!);
    }
    const path = info.outputPath('two-minutes.wav');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path, wav16(long, to));

    await page.addInitScript(() => {
      const w = window as unknown as { __longTasks: number[] };
      w.__longTasks = [];
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) w.__longTasks.push(Math.round(e.duration));
      }).observe({ type: 'longtask', buffered: true });
    });
    await page.goto('./#/tool/sstv');
    await expect(page.locator('.dropzone')).toBeVisible();
    await page.evaluate(() => new Promise((r) => setTimeout(r, 300)));
    await page.evaluate(() => {
      (window as unknown as { __longTasks: number[] }).__longTasks.splice(0);
    });

    const out = page.locator('.pane-out');
    await page.locator('.input-box input[type=file]').setInputFiles(path);
    await expect(out).toContainText('Mode: Martin M1', { timeout: 60_000 });
    await expect(out).toContainText(/VIS header 44 \(0x2c\) at 40\.6\d s/);
    await expect(out).toContainText('Lines received: 32 of 256');
    // Changing options re-runs on the demodulated samples kept in the worker.
    await page.locator('.options').getByRole('button', { name: 'Set by hand' }).click();
    await expect(out).toContainText('Line time set by hand', { timeout: 60_000 });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 300)));
    // Wall-clock longtasks: a CPU-starved runner can spike one task, so flag a real freeze (250 ms)
    // rather than scheduler jitter. The decode runs in the worker; the page should stay responsive.
    const blocking = await page.evaluate(() =>
      (window as unknown as { __longTasks: number[] }).__longTasks.filter((d) => d > 250),
    );
    expect(blocking, 'tasks over 250 ms on the page').toEqual([]);
  });
});
