import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { frequencyToY, plotRect, type AxesSpec } from '../src/tools/audio/_axes';

/**
 * A "Try" example is a demo: it must be labelled as one, and it must never be visible next to,
 * or mixed up with, the analysis of the user's own file.
 */
const sample = (name: string) =>
  fileURLToPath(new URL(`../public/samples/${name}`, import.meta.url));
const DEMO = 'Demo: text drawn in a spectrogram';

const chip = (page: Page, name: string) =>
  page.locator('.examples').getByRole('button', { name, exact: true });
const option = (page: Page, key: string) => page.locator(`#opt-spectrogram-${key}`);
const loadFile = (page: Page, name: string) =>
  page.locator('input[type=file]').first().setInputFiles(sample(name));

async function expectDefaultOptions(page: Page) {
  await expect(option(page, 'fftSize')).toHaveValue('2048');
  await expect(option(page, 'overlap')).toHaveValue('75');
  await expect(option(page, 'minFreq')).toHaveValue('0');
  await expect(option(page, 'maxFreq')).toHaveValue('0');
}

/** Bright (text-like) pixels of the picture inside the plot: in 6-8 kHz, and in the rest. */
async function brightPixels(page: Page, nyquist: number) {
  const canvas = page.locator('.pane-out canvas.out-canvas').first();
  const [width, height] = await canvas.evaluate((el) => [
    (el as HTMLCanvasElement).width,
    (el as HTMLCanvasElement).height,
  ]);
  const box = plotRect(width!, height!);
  const axes: AxesSpec = {
    width: box.width,
    height: box.height,
    columnWidth: 1,
    hopSeconds: 1,
    t0: 0,
    t1: 1,
    fMin: 0,
    fMax: nyquist,
    scale: 'linear',
  };
  const y = (hz: number) => box.y + Math.round(frequencyToY(axes, hz));
  const band = [y(8300), y(5700)]; // rows holding 5.7 to 8.3 kHz
  const rest = [
    [box.y, y(8800)],
    [y(5200), box.y + box.height],
  ];
  return canvas.evaluate(
    (el, { box, band, rest }) => {
      const c = el as HTMLCanvasElement;
      const px = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      const count = (y0: number, y1: number) => {
        let n = 0;
        for (let yy = y0; yy < y1; yy++) {
          for (let x = box.x; x < box.x + box.width; x++) {
            const o = (yy * c.width + x) * 4;
            if (px[o]! > 200 && px[o + 1]! > 90) n++;
          }
        }
        return n;
      };
      return {
        inBand: count(band[0]!, band[1]!),
        elsewhere: rest.reduce((a, [y0, y1]) => a + count(y0!, y1!), 0),
      };
    },
    { box, band, rest },
  );
}

for (const [file, label] of [
  ['audio-spectrogram-22k.mp3', 'MP3'],
  ['audio-spectrogram-22k.wav', 'WAV'],
] as const) {
  test(`your own ${label} at 22050 Hz: real rate, full band, text at 6-8 kHz`, async ({ page }) => {
    await page.goto('./#/tool/spectrogram');
    await loadFile(page, file);
    const out = page.locator('.pane-out');
    await expect(out).toContainText('Sample rate: 22050 Hz (from the file)', { timeout: 15_000 });
    await expect(out).toContainText('Nyquist: 11025 Hz');
    await expect(out).toContainText('Frequencies shown: 0 – 11025 Hz');
    await expect(out.locator('.note-error, .note-warn')).toHaveCount(0);
    await expect(page.locator('.demo-banner')).toBeHidden();
    await expectDefaultOptions(page);
    const { inBand, elsewhere } = await brightPixels(page, 11025);
    expect(inBand).toBeGreaterThan(5000);
    expect(elsewhere).toBeLessThan(inBand / 20);
  });
}

test('a demo is labelled, and your own file then replaces it completely', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('./#/tool/spectrogram');
  await chip(page, DEMO).click();
  const out = page.locator('.pane-out');
  const banner = page.locator('.demo-banner');

  // The demo is clearly a demo, with the options of its narrow window.
  await expect(out).toContainText('Frequencies shown: 1100 – 1950 Hz', { timeout: 15_000 });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('Demo');
  await expect(banner).toContainText(DEMO);
  await expect(banner).toContainText('sample file audio-spectrogram.wav');
  await expect(option(page, 'fftSize')).toHaveValue('512');
  await expect(option(page, 'minFreq')).toHaveValue('1100');
  await expect(option(page, 'maxFreq')).toHaveValue('1950');

  // Record everything the output pane shows from now on.
  await page.evaluate(() => {
    const pane = document.querySelector('.pane-out')!;
    const log: { text: string; banner: boolean }[] = [];
    new MutationObserver(() => {
      const b = document.querySelector('.demo-banner');
      log.push({
        text: pane.querySelector('.out-stack')?.textContent ?? '',
        banner: Boolean(b && !(b as HTMLElement).hidden),
      });
    }).observe(pane, { subtree: true, childList: true, characterData: true, attributes: true });
    (window as unknown as { __log: typeof log }).__log = log;
  });

  await loadFile(page, 'audio-spectrogram-22k.mp3');
  await expect(out).toContainText('Sample rate: 22050 Hz (from the file)', { timeout: 15_000 });

  // Nothing of the demo is left: no banner, defaults again, a full 0 - Nyquist view.
  await expect(banner).toBeHidden();
  await expectDefaultOptions(page);
  await expect(out).toContainText('Nyquist: 11025 Hz');
  await expect(out).toContainText('Frequencies shown: 0 – 11025 Hz');
  await expect(out).not.toContainText('audio-spectrogram.wav');
  await expect(page.locator('.file-name')).toHaveText('audio-spectrogram-22k.mp3');

  // While the new file was being decoded the pane showed "Analysing…", never the old output.
  const log = await page.evaluate(
    () => (window as unknown as { __log: { text: string; banner: boolean }[] }).__log,
  );
  expect(log.length).toBeGreaterThan(0);
  expect(log.some((e) => e.text.includes('Analysing audio-spectrogram-22k.mp3'))).toBe(true);
  for (const e of log) {
    expect(e.banner).toBe(false);
    expect(e.text).not.toContain('8000 Hz');
    expect(e.text).not.toContain('1950');
  }

  const { inBand, elsewhere } = await brightPixels(page, 11025);
  expect(inBand).toBeGreaterThan(5000);
  expect(elsewhere).toBeLessThan(inBand / 20);
  expect(errors).toEqual([]);
});

test('options changed by hand after the demo survive, the demo ones go back to default', async ({
  page,
}) => {
  await page.goto('./#/tool/spectrogram');
  await chip(page, DEMO).click();
  await expect(page.locator('.pane-out')).toContainText('1100 – 1950 Hz', { timeout: 15_000 });
  await option(page, 'minFreq').fill('500'); // the user's own choice
  await expect(page.locator('.pane-out')).toContainText('500 – 1950 Hz');

  await loadFile(page, 'audio-spectrogram-22k.wav');
  await expect(page.locator('.pane-out')).toContainText('Sample rate: 22050 Hz (from the file)', {
    timeout: 15_000,
  });
  await expect(option(page, 'minFreq')).toHaveValue('500');
  await expect(option(page, 'maxFreq')).toHaveValue('0');
  await expect(option(page, 'fftSize')).toHaveValue('2048');
  await expect(option(page, 'overlap')).toHaveValue('75');
  await expect(page.locator('.pane-out')).toContainText('Frequencies shown: 500 – 11025 Hz');
  await expect(page.locator('.demo-banner')).toBeHidden();
});

test('removing the demo input clears the banner, the output and the demo options', async ({
  page,
}) => {
  await page.goto('./#/tool/spectrogram');
  await chip(page, DEMO).click();
  await expect(page.locator('.demo-banner')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(page.locator('.demo-banner')).toBeHidden();
  await expect(page.locator('.pane-out')).not.toContainText('Sample rate');
  await expect(page.locator('.pane-out .empty')).toBeVisible();
  await expectDefaultOptions(page);
});

test('demo data piped to another tool stays labelled as a demo there', async ({ page }) => {
  await page.goto('./#/tool/spectrogram');
  await chip(page, DEMO).click();
  await expect(page.locator('.pane-out')).toContainText('Sample rate', { timeout: 15_000 });
  await page.locator('.pane-out select.pipe').first().selectOption('hexdump');
  await expect(page).toHaveURL(/#\/tool\/hexdump/);
  const banner = page.locator('.demo-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('demo data sent from Spectrogram');
  // Your own file there replaces it.
  await page.locator('input[type=file]').first().setInputFiles(sample('audio-dtmf.wav'));
  await expect(banner).toBeHidden();
});

test('a text example is a demo too, until you type over it', async ({ page }) => {
  await page.goto('./#/tool/base64');
  await chip(page, 'Decode a flag').click();
  const banner = page.locator('.demo-banner');
  await expect(page.locator('.pane-out')).toContainText('flag{base64_is_not_crypto}');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('built-in example text');
  // The flag candidates are those of the demo sample, not findings about your data.
  const strip = page.locator('.flag-strip');
  await expect(strip).toContainText('from the demo sample');
  await expect(strip).toHaveClass(/is-demo/);

  await page.locator('.input-text').fill('aGVsbG8=');
  await expect(banner).toBeHidden();
  await expect(page.locator('.pane-out')).toContainText('hello');
  await expect(page.locator('.pane-out')).not.toContainText('flag{base64_is_not_crypto}');
  await expect(strip).toBeHidden();
});
