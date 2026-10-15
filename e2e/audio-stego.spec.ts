import { readFileSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

// The Audio steganography tool through the real UI: files opened from disk, the picture and the
// plot drawn, the "use these settings" button, a big file that must not freeze the page, and no
// request leaving the app. (The examples of the tool are clicked by tools.spec.ts.)

const out = (page: Page) => page.locator('.pane-out');
const sample = (name: string) =>
  readFileSync(new URL(`../public/samples/${name}`, import.meta.url));

/** Open the tool, collecting page errors and requests that leave the app's origin. */
async function open(page: Page, baseURL: string | undefined) {
  const origin = new URL(baseURL ?? 'http://localhost:4173/').origin;
  const errors: string[] = [];
  const offsite: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.context().on('request', (r) => {
    const url = r.url();
    if (!url.startsWith('blob:') && !url.startsWith('data:') && new URL(url).origin !== origin) {
      offsite.push(url);
    }
  });
  await page.goto('./#/tool/audio-stego');
  return { errors, offsite };
}

async function openFile(page: Page, name: string, buffer: Buffer) {
  await page.locator('input[type=file]').setInputFiles({ name, mimeType: 'audio/wav', buffer });
}

test('a WAV opened from disk: the flag, the table, the plot, nothing leaves the page', async ({
  page,
  baseURL,
}) => {
  const w = await open(page, baseURL);
  await openFile(page, 'hidden.wav', sample('audio-stego-lsb.wav'));
  const result = out(page);
  await expect(result).toContainText('Best hit');
  await expect(
    result.locator('.out-text, .out-pre').filter({ hasText: 'FTF{wav_lsb}' }),
  ).toBeVisible();
  await expect(result.locator('.flag-mark').first()).toHaveText('FTF{wav_lsb}');
  await expect(result).toContainText('the only channel, bit 0, MSB first');
  await expect(result).toContainText('PCM 16-bit, mono, 8000 Hz');
  const plot = result.locator('canvas.out-canvas');
  await expect(plot).toHaveCount(1);
  // the plot is really drawn: some amber (random-looking bits) and some silence on it
  const colours = await plot.evaluate((c: HTMLCanvasElement) => {
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    const seen = new Set<string>();
    for (let i = 0; i < d.length; i += 4) seen.add(`${d[i]},${d[i + 1]},${d[i + 2]}`);
    return { amber: seen.has('229,160,70'), green: seen.has('99,207,166'), width: c.width };
  });
  expect(colours.amber).toBe(true);
  expect(colours.green).toBe(true);
  expect(colours.width).toBeLessThanOrEqual(720 + 62);
  await expect(result.locator('.note-error')).toHaveCount(0);
  expect(w.errors).toEqual([]);
  expect(w.offsite).toEqual([]);
});

test('the PNG found in the low bits is shown as a picture and the button opens manual mode', async ({
  page,
  baseURL,
}) => {
  const w = await open(page, baseURL);
  await openFile(page, 'stereo.wav', sample('audio-stego-png.wav'));
  const result = out(page);
  await expect(result).toContainText('File: PNG image');
  const picture = result.locator('img.out-picture');
  await expect(picture).toHaveCount(1);
  await expect
    .poll(() => picture.evaluate((i: HTMLImageElement) => i.naturalWidth))
    .toBeGreaterThan(100);
  await result.getByRole('button', { name: 'Use these settings' }).click();
  await expect(result).toContainText('Extraction');
  await expect(page.locator('.options')).toContainText('Bit planes');
  await expect(result).toContainText('left channel');
  await expect(result).toContainText('The extracted data starts like a file: PNG image (.png).');
  await expect(result.locator('img.out-picture')).toHaveCount(1);
  expect(w.errors).toEqual([]);
  expect(w.offsite).toEqual([]);
});

test('manual options: unit, planes, channel, bit order, a length header, errors', async ({
  page,
  baseURL,
}) => {
  const w = await open(page, baseURL);
  await openFile(page, 'hidden.wav', sample('audio-stego-lsb.wav'));
  const result = out(page);
  await expect(result).toContainText('FTF{wav_lsb}');
  await page.locator('.options').getByRole('button', { name: 'Manual LSB' }).click();
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(result).toContainText('Length header found: 32-bit BE length (12 bytes)');
  await expect(result.locator('.out-pre').filter({ hasText: /^FTF\{wav_lsb\}$/ })).toBeVisible();
  // a bit order the file was not written with reads as noise, and a wrong plane list is explained
  await page.locator('.options').getByRole('button', { name: 'LSB first' }).click();
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(result).not.toContainText('Length header found');
  await page.locator('.options input[type=text]').first().fill('0-9');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(result.locator('.note-error')).toContainText('Bit 9 does not exist');
  expect(w.errors).toEqual([]);
});

test('an MP3: the comment is a flag, the cover is drawn, and the lossy format is explained', async ({
  page,
  baseURL,
}) => {
  const w = await open(page, baseURL);
  await openFile(page, 'song.mp3', sample('audio-stego-id3.mp3'));
  const result = out(page);
  await expect(result.locator('.flag-mark').first()).toHaveText('FTF{id3_comment}');
  await expect(result.locator('img.out-picture')).toHaveCount(1);
  await expect(result).toContainText('MP3 is a lossy format');
  await expect(result).toContainText('Xing / Info');
  await expect(result.locator('canvas.out-canvas')).toHaveCount(0);
  // the payload can be sent to another tool
  await result.locator('.out-files select.pipe').first().selectOption('file-type');
  await expect(page).toHaveURL(/#\/tool\/file-type/);
  expect(w.errors).toEqual([]);
  expect(w.offsite).toEqual([]);
});

test('a WAV with an extra chunk and a ZIP behind it', async ({ page, baseURL }) => {
  const w = await open(page, baseURL);
  await openFile(page, 'odd.wav', sample('audio-stego-chunk.wav'));
  const result = out(page);
  await expect(result).toContainText('Data in the "ftfx" chunk');
  await expect(result).toContainText('wav-after-data.bin');
  await expect(result).toContainText('ZIP archive');
  await result.locator('.out-files select.pipe').nth(1).selectOption('archive');
  await expect(page).toHaveURL(/#\/tool\/archive/);
  await expect(out(page)).toContainText('flag.txt');
  expect(w.errors).toEqual([]);
});

test('not audio: the message says what to do', async ({ page, baseURL }) => {
  await open(page, baseURL);
  await page.locator('input[type=file]').setInputFiles({
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('just some text, nothing like audio'),
  });
  await expect(out(page).locator('.note-error')).toContainText(
    'This is not a WAV, AIFF, MP3, FLAC or Ogg file',
  );
});

/** A long 16-bit stereo WAV with "FTF{big_wav}" behind a length in the low bit of the left channel. */
function bigWav(seconds: number): Buffer {
  const rate = 44100;
  const frames = rate * seconds;
  const data = Buffer.alloc(frames * 4);
  let seed = 7;
  for (let i = 0; i < data.length; i += 2) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    data.writeInt16LE((seed >>> 16) - 32768, i);
  }
  const payload = Buffer.concat([Buffer.from([0, 0, 0, 12]), Buffer.from('FTF{big_wav}')]);
  for (let i = 0; i < payload.length * 8; i++) {
    const bit = (payload[i >> 3]! >> (7 - (i & 7))) & 1;
    const at = i * 4; // low byte of the left sample of frame i
    data[at] = (data[at]! & 0xfe) | bit;
  }
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVEfmt ', 8, 'latin1');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(2, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 4, 28);
  head.writeUInt16LE(4, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36, 'latin1');
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

test('a 20 MiB WAV is analysed in the worker without freezing the page', async ({
  page,
  baseURL,
}) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __longTasks: number[] };
    w.__longTasks = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.__longTasks.push(Math.round(e.duration));
    }).observe({ type: 'longtask', buffered: true });
  });
  const w = await open(page, baseURL);
  // From a path, like a real file: a buffer would be decoded by the page itself.
  const path = test.info().outputPath('big.wav');
  writeFileSync(path, bigWav(120));
  await page.locator('input[type=file]').setInputFiles(path);
  const result = out(page);
  await expect(result.locator('.flag-mark').first()).toHaveText('FTF{big_wav}', {
    timeout: 40_000,
  });
  await expect(result).toContainText('left channel, bit 0, MSB first');
  await expect(result.locator('canvas.out-canvas')).toHaveCount(1);
  const tasks = await page.evaluate(
    () => (window as unknown as { __longTasks: number[] }).__longTasks,
  );
  // loading and analysing the file happen in the worker: the page never stalls for long
  expect(Math.max(0, ...tasks)).toBeLessThan(400);
  expect(w.errors).toEqual([]);
  expect(w.offsite).toEqual([]);
});
