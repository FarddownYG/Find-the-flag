import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const sample = (name: string) =>
  fileURLToPath(new URL(`../public/samples/${name}`, import.meta.url));

/** Format and length of a 16-bit PCM WAV with a plain 44-byte header. */
function wavInfo(b: Buffer) {
  expect(b.toString('latin1', 0, 4)).toBe('RIFF');
  expect(b.toString('latin1', 8, 16)).toBe('WAVEfmt ');
  expect(b.readUInt16LE(20)).toBe(1); // PCM
  expect(b.readUInt16LE(34)).toBe(16);
  const rate = b.readUInt32LE(24);
  const channels = b.readUInt16LE(22);
  const frames = b.readUInt32LE(40) / (2 * channels);
  return { rate, channels, frames, seconds: frames / rate };
}

/** Best normalised cross-correlation of two mono 16-bit WAVs over small lags. */
function correlation(a: Buffer, b: Buffer): number {
  const pcm = (w: Buffer) =>
    new Int16Array(w.buffer.slice(w.byteOffset + 44, w.byteOffset + w.length));
  const x = pcm(a);
  const y = pcm(b);
  let best = -1;
  for (let lag = -20; lag <= 20; lag++) {
    let xy = 0;
    let xx = 0;
    let yy = 0;
    for (let i = Math.max(0, -lag); i < x.length && i + lag < y.length; i++) {
      xy += x[i]! * y[i + lag]!;
      xx += x[i]! * x[i]!;
      yy += y[i + lag]! * y[i + lag]!;
    }
    best = Math.max(best, xy / Math.sqrt(xx * yy));
  }
  return best;
}

test('audio lab: undo a reversed, sped-up voice, play it, download it, chain more', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('./#/tool/audio-lab');
  await page
    .locator('.input-box input[type=file]')
    .setInputFiles(sample('audio-lab-reversed-fast.wav'));
  const out = page.locator('.pane-out');
  await expect(out).toContainText('Chain applied: none (the file as decoded)', { timeout: 15_000 });
  await expect(out).toContainText('No speech recognition here');
  await expect(out).toContainText('Mono check: Mono: one channel');

  // One click on the preset fills the steps and re-runs.
  await out.getByRole('button', { name: 'Undo a reversed + ×1.5 voice', exact: true }).click();
  await expect(out).toContainText('Chain applied: reverse, speed 1/1.5', { timeout: 15_000 });
  await expect(page.locator('.options input[type=text]')).toHaveValue('reverse, speed 1/1.5');
  await expect(out).toContainText('Duration: 1.60 s → 2.40 s (×1.5)');
  await expect(out.locator('.out-image canvas')).toHaveCount(1);

  // The player holds the result as a blob: WAV of the expected duration, and it plays.
  const player = out.locator('.out-audio-block audio');
  await expect(player).toHaveCount(1);
  const src = await player.getAttribute('src');
  expect(src).toMatch(/^blob:/);
  const duration = await player.evaluate(
    (a: HTMLAudioElement) =>
      new Promise<number>((resolve) => {
        if (a.readyState >= 1) resolve(a.duration);
        else a.addEventListener('loadedmetadata', () => resolve(a.duration), { once: true });
      }),
  );
  expect(Math.abs(duration - 2.4)).toBeLessThan(0.02);
  await expect(out.locator('.out-audio-block .out-meta')).toContainText('2.40 s');
  const played = await player.evaluate(async (a: HTMLAudioElement) => {
    a.muted = true;
    await a.play();
    await new Promise((r) => setTimeout(r, 400));
    a.pause();
    return a.currentTime;
  });
  expect(played).toBeGreaterThan(0);

  // The download is that WAV, and it is the source voice again.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    out.locator('.out-audio-block').getByRole('button', { name: 'Download', exact: true }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('audio-lab-reversed-fast-lab.wav');
  const wav = readFileSync(await download.path());
  const info = wavInfo(wav);
  expect(info).toMatchObject({ rate: 22050, channels: 1 });
  expect(Math.abs(info.seconds - duration)).toBeLessThan(0.01);
  expect(correlation(readFileSync(sample('audio-lab-voice.wav')), wav)).toBeGreaterThan(0.95);

  // Add a step in one click: the chain grows, a new result replaces the old one...
  await out.getByRole('button', { name: '+ stretch 2', exact: true }).click();
  await expect(out).toContainText('Chain applied: reverse, speed 1/1.5, stretch 2', {
    timeout: 15_000,
  });
  await expect(out).toContainText('Duration: 1.60 s → 4.80 s (×3)');
  await expect(player).toHaveCount(1);
  expect(await player.getAttribute('src')).not.toBe(src);
  expect(errors).toEqual([]);
  // ...and the previous blob: URL was revoked (loading it fails, which the console reports).
  const old = await page.evaluate(
    (url) =>
      new Promise<string>((resolve) => {
        const a = new Audio();
        a.onerror = () => resolve('revoked');
        a.onloadedmetadata = () => resolve('still alive');
        a.src = url;
      }),
    src!,
  );
  expect(old).toBe('revoked');
  expect(errors.splice(0)).toEqual(['Failed to load resource: net::ERR_FILE_NOT_FOUND']);

  // A bad step is explained, not swallowed.
  await page.locator('.options input[type=text]').fill('reverse, sped 2');
  await page.locator('.pane-head .btn-run').click();
  await expect(out.locator('.note-error')).toContainText(
    'Step 2 “sped 2” is not a known transform',
  );

  // The result can go on to another audio tool.
  await page.locator('.options input[type=text]').fill('reverse, speed 1/1.5');
  await page.locator('.pane-head .btn-run').click();
  await expect(out).toContainText('Chain applied: reverse, speed 1/1.5', { timeout: 15_000 });
  await out.locator('.out-audio-block select.pipe').selectOption('spectrogram');
  await expect(page).toHaveURL(/#\/tool\/spectrogram/);
  await expect(page.locator('.file-card .file-name')).toHaveText('audio-lab-reversed-fast-lab.wav');
  await expect(page.locator('.pane-out .out-image canvas')).toHaveCount(1, { timeout: 15_000 });

  expect(errors).toEqual([]);
});

test('audio lab: a stereo file gets channel presets and an exact mono check', async ({ page }) => {
  await page.goto('./#/tool/audio-lab');
  await page.locator('.input-box input[type=file]').setInputFiles(sample('audio-lab-stereo.wav'));
  const out = page.locator('.pane-out');
  await expect(out).toContainText('Mono check: Stereo: L ≠ R', { timeout: 15_000 });
  await out.getByRole('button', { name: 'L − R (side)', exact: true }).click();
  await expect(out).toContainText('Chain applied: channel side, normalize', { timeout: 15_000 });
  await expect(out).toContainText('Output: 16000 Hz · mono · 2.40 s');
  await expect(out).toContainText('Output peak: -1.0 dBFS');
});
