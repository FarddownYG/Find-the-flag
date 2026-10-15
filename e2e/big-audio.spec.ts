import { writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

/**
 * Big audio files must not freeze the page: decoding happens in the tool worker, the decoded
 * samples stay there between runs, and only options cross threads when they change. The page
 * must never run a task longer than this while a long file loads or is re-analysed.
 */
const LONG_TASK_MS = 100;
const RATE = 44100;
const SECONDS = 240;

/** RIFF/WAVE file: a "fmt " chunk body and the data. */
function riff(fmt: Buffer, data: Buffer): Buffer {
  const head = Buffer.alloc(20);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(4 + 8 + fmt.length + 8 + data.length, 4);
  head.write('WAVEfmt ', 8, 'latin1');
  head.writeUInt32LE(fmt.length, 16);
  const dataHead = Buffer.alloc(8);
  dataHead.write('data', 0, 'latin1');
  dataHead.writeUInt32LE(data.length, 4);
  return Buffer.concat([head, fmt, dataHead, data]);
}

function fmtChunk(
  codec: number,
  channels: number,
  rate: number,
  bits: number,
  extra = Buffer.alloc(0),
) {
  const align = Math.max(1, (channels * bits) >> 3);
  const b = Buffer.alloc(16);
  b.writeUInt16LE(codec, 0);
  b.writeUInt16LE(channels, 2);
  b.writeUInt32LE(rate, 4);
  b.writeUInt32LE(rate * align, 8);
  b.writeUInt16LE(align, 12);
  b.writeUInt16LE(bits, 14);
  return Buffer.concat([b, extra]);
}

/** A long 16-bit stereo WAV: 440 Hz on the left, 1200 Hz on the right (one second, tiled). */
function longStereoWav(seconds: number): Buffer {
  const second = Buffer.alloc(RATE * 4);
  for (let i = 0; i < RATE; i++) {
    second.writeInt16LE(Math.round(9000 * Math.sin((2 * Math.PI * 440 * i) / RATE)), i * 4);
    second.writeInt16LE(Math.round(9000 * Math.sin((2 * Math.PI * 1200 * i) / RATE)), i * 4 + 2);
  }
  const data = Buffer.alloc(second.length * seconds);
  for (let s = 0; s < seconds; s++) second.copy(data, s * second.length);
  return riff(fmtChunk(1, 2, RATE, 16), data);
}

/** Collect the page's long tasks from its very first script on. */
async function watchLongTasks(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __longTasks: number[] };
    w.__longTasks = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.__longTasks.push(Math.round(e.duration));
    }).observe({ type: 'longtask', buffered: true });
  });
}

/** Durations of the tasks over the limit since the last call (and forget them). */
async function blockingTasks(page: Page): Promise<number[]> {
  const all = await page.evaluate(() => {
    const w = window as unknown as { __longTasks: number[] };
    return w.__longTasks.splice(0);
  });
  return all.filter((d) => d > LONG_TASK_MS);
}

/** Let a task that ends with the run (drawing the result) be reported before reading. */
const settle = (page: Page) => page.evaluate(() => new Promise((r) => setTimeout(r, 200)));

test.describe('big audio files', () => {
  test.describe.configure({ timeout: 120_000 });

  test('spectrogram: a 4-minute stereo WAV loads and re-runs without blocking the page', async ({
    page,
  }, info) => {
    const path = info.outputPath('long.wav');
    writeFileSync(path, longStereoWav(SECONDS));
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await watchLongTasks(page);
    await page.goto('./#/tool/spectrogram');
    await expect(page.locator('.dropzone')).toBeVisible();
    await settle(page);
    await blockingTasks(page); // page start-up is not what is measured

    const out = page.locator('.pane-out');
    await page.locator('.input-box input[type=file]').setInputFiles(path);
    await expect(out).toContainText('Duration: 4:00.00 (240.0 s)', { timeout: 60_000 });
    await expect(out).toContainText('Sample rate: 44100 Hz (from the file)');
    await expect(out).toContainText('Channels: 2 (stereo)');
    await settle(page);
    expect(await blockingTasks(page), 'long tasks while loading').toEqual([]);

    const changes: [string, () => Promise<unknown>, string | RegExp][] = [
      [
        'FFT size',
        () => page.locator('.options select').first().selectOption('4096'),
        /FFT: 4096 samples/,
      ],
      [
        'channel',
        () => page.locator('.options').getByRole('button', { name: 'Right', exact: true }).click(),
        'Analysed: right',
      ],
      [
        'axis',
        () => page.locator('.options').getByRole('button', { name: 'Log', exact: true }).click(),
        /Frequencies shown: 20 – 22050 Hz \(log\)/,
      ],
    ];
    for (const [what, change, expected] of changes) {
      await change();
      await expect(out).toContainText(expected, { timeout: 60_000 });
      await settle(page);
      expect(await blockingTasks(page), `long tasks after changing the ${what}`).toEqual([]);
    }
    // The right channel holds the 1200 Hz tone: the samples are the file's, not a stale copy.
    await expect(out).toContainText(/Strongest on average: 1(199|200|201)\.\d Hz/);

    // Changing an option again while a run is in flight cancels it (the worker is replaced and
    // the file sent to the new one): the last choice wins, still without blocking the page.
    const fft = page.locator('.options select').first();
    await fft.selectOption('8192');
    await fft.selectOption('512');
    await expect(out).toContainText(/FFT: 512 samples/, { timeout: 60_000 });
    await expect(out.locator('.note-error')).toHaveCount(0);
    await settle(page);
    expect(await blockingTasks(page), 'long tasks around a cancelled run').toEqual([]);
    expect(errors).toEqual([]);
  });

  test('audio lab: a 4-minute stereo WAV loads and takes presets without blocking the page', async ({
    page,
  }, info) => {
    const path = info.outputPath('long.wav');
    writeFileSync(path, longStereoWav(SECONDS));
    await watchLongTasks(page);
    await page.goto('./#/tool/audio-lab');
    await expect(page.locator('.dropzone')).toBeVisible();
    await settle(page);
    await blockingTasks(page);

    const out = page.locator('.pane-out');
    await page.locator('.input-box input[type=file]').setInputFiles(path);
    await expect(out).toContainText('Chain applied: none (the file as decoded)', {
      timeout: 60_000,
    });
    await expect(out).toContainText('Input: 44100 Hz · stereo · 4:00.00');
    await settle(page);
    expect(await blockingTasks(page), 'long tasks while loading').toEqual([]);

    for (const [preset, chain] of [
      ['Reverse', 'Chain applied: reverse'],
      ['Left only', 'Chain applied: channel left'],
      ['L + R (mid)', 'Chain applied: channel mid'],
    ] as const) {
      await out.getByRole('button', { name: preset, exact: true }).click();
      await expect(out).toContainText(chain, { timeout: 60_000 });
      await settle(page);
      expect(await blockingTasks(page), `long tasks after “${preset}”`).toEqual([]);
    }
    await expect(out).toContainText('Output: 44100 Hz · mono · 4:00.00');
  });
});
