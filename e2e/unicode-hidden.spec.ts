import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

// The Hidden Unicode text tool through the real UI: pasting trapped texts, the encoder, a false
// positive check on French, and a megabyte of text. (The examples of the tool are clicked by
// tools.spec.ts like every other tool's.)

const out = (page: Page) => page.locator('.pane-out');
const sample = (name: string) =>
  readFileSync(new URL(`../public/samples/${name}`, import.meta.url), 'utf8');

/** Open the tool, collecting page errors and requests that leave the app's origin. */
async function open(page: Page, baseURL: string | undefined) {
  const origin = new URL(baseURL ?? 'http://localhost:4173/').origin;
  const errors: string[] = [];
  const offsite: string[] = [];
  const chunks: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.context().on('request', (r) => {
    const url = r.url();
    if (url.includes('_unicode-data')) chunks.push(url);
    if (!url.startsWith('blob:') && !url.startsWith('data:') && new URL(url).origin !== origin) {
      offsite.push(url);
    }
  });
  await page.goto('./#/tool/unicode-hidden');
  return { errors, offsite, chunks };
}

const bits = (text: string) =>
  [...new TextEncoder().encode(text)].map((b) => b.toString(2).padStart(8, '0')).join('');

test('a pasted trapped text shows its markers and gives up SECRET42', async ({ page, baseURL }) => {
  const w = await open(page, baseURL);
  const payload = bits('SECRET42').replace(/0/g, '​').replace(/1/g, '‌');
  await page.locator('.input-text').fill(`Hello team,${payload} please read the report.`);
  const result = out(page);
  await expect(result).toContainText('A message is hidden in the invisible characters');
  await expect(
    result.locator('.out-text').filter({ hasText: 'Text with the invisible characters marked' }),
  ).toContainText('Hello team,⟨64 hidden: ZWSP×');
  await expect(result.locator('.out-text').filter({ hasText: /^Hidden message \(/ })).toContainText(
    'SECRET42',
  );
  await expect(result).toContainText('53 45 43 52 45 54 34 32');
  await expect(result).toContainText('ZERO WIDTH NON-JOINER');
  await expect(result.locator('.note-error')).toHaveCount(0);
  expect(w.errors).toEqual([]);
  expect(w.offsite).toEqual([]);
  // The Unicode data is a chunk of its own, loaded (by the worker) when the tool first runs.
  expect(w.chunks.length).toBeGreaterThan(0);
});

test('a text with swapped letters shows the diff and the message in their pattern', async ({
  page,
  baseURL,
}) => {
  const w = await open(page, baseURL);
  await page.locator('.input-text').fill(sample('unicode-hidden-homoglyph.txt'));
  const result = out(page);
  await expect(result).toContainText('A message is hidden in the pattern of lookalike letters');
  await expect(
    result.locator('.out-text').filter({ hasText: 'Text with the lookalike letters marked' }),
  ).toContainText('T⟨һ⟩e c⟨о⟩mmittee');
  await expect(result.locator('.out-text').filter({ hasText: 'ASCII skeleton' })).toContainText(
    'The committee will meet on Thursday',
  );
  await expect(result).toContainText('CYRILLIC SMALL LETTER SHHA');
  await expect(
    result.locator('.out-text').filter({ hasText: /^Hidden message in the/ }),
  ).toContainText('HIDDEN_OK');
  expect(w.errors).toEqual([]);
  expect(w.offsite).toEqual([]);
});

test('tag characters are shown by name and decoded', async ({ page, baseURL }) => {
  await open(page, baseURL);
  await page.locator('.input-text').fill(sample('unicode-hidden-tags.txt'));
  const result = out(page);
  await expect(result).toContainText('TAGS_OK');
  await expect(result).toContainText('TAG LATIN CAPITAL LETTER T');
  await expect(result).toContainText('LANGUAGE TAG');
  await expect(result).toContainText('CANCEL TAG');
});

test('an ordinary French paragraph is clean, an emoji is not a payload', async ({
  page,
  baseURL,
}) => {
  const w = await open(page, baseURL);
  await page
    .locator('.input-text')
    .fill(
      'Il était une fois, à l’école du village : « Où est passé mon cœur ? » demandait M. Ôtez. ' +
        'Superficie : 25 m² ; ça coûte 3 × 4 = 12 € ! ❤️',
    );
  const result = out(page);
  await expect(result).toContainText('Lookalike letters (homoglyphs): 0');
  await expect(result).toContainText('Invisible characters: 0');
  await expect(result).toContainText('In place: emoji sequence');
  await expect(result.locator('.note-warn')).toHaveCount(0);
  await expect(result).not.toContainText('A message is hidden');
  expect(w.errors).toEqual([]);
});

test('hides a message with invisible characters, then with lookalike letters, each read back', async ({
  page,
  baseURL,
}) => {
  const w = await open(page, baseURL);
  const cover =
    'The quick brown fox jumps over the lazy dog while the sun slowly sets behind the old stone bridge near our village.';
  await page.locator('.input-text').fill(cover);
  await page
    .locator('.options')
    .getByRole('button', { name: 'Hide a message', exact: true })
    .click();
  await page.getByLabel('Secret message').fill('SECRET42');
  const result = out(page);
  await expect(result).toContainText('Hidden 64 bits as invisible characters.');
  await expect(result).toContainText('Round trip: OK');
  await expect(result).toContainText('⟨64 hidden:');

  await page
    .locator('.options')
    .getByRole('button', { name: 'Lookalike letters', exact: true })
    .click();
  await expect(result).toContainText('Hidden 64 bits in the letters of the cover');
  await expect(result).toContainText('Round trip: OK');
  await expect(result).toContainText('Capacity used: 64 of');

  // A cover that is too short says exactly what is missing.
  await page.locator('.input-text').fill('Too short.');
  await expect(result.locator('.note-error')).toContainText(
    'the message needs 64 bits, the cover carries',
  );
  expect(w.errors).toEqual([]);
});

test('a megabyte of text is analysed in the worker without freezing the page', async ({
  page,
  baseURL,
}) => {
  const w = await open(page, baseURL);
  const line = 'Où l’été dure, les élèves ôtent leur manteau « à la fin » de la journée.\n';
  const big = line.repeat(Math.ceil(1_000_000 / line.length)).slice(0, 1_000_000);
  const swapped = big.slice(0, 500_000) + big.slice(500_000).replace(/a/g, '\u0430');
  // Set the value directly: typing a megabyte through the browser's input pipeline is slow by
  // itself, whatever the tool. A timer probes how long the page's main thread stays blocked.
  await page.evaluate((text) => {
    const probe = window as unknown as { maxGap: number };
    probe.maxGap = 0;
    let last = performance.now();
    setInterval(() => {
      const now = performance.now();
      probe.maxGap = Math.max(probe.maxGap, now - last - 20);
      last = now;
    }, 20);
    const box = document.querySelector<HTMLTextAreaElement>('.input-text');
    if (!box) throw new Error('no input box');
    box.value = text;
    box.dispatchEvent(new Event('input', { bubbles: true }));
  }, swapped);
  await expect(out(page)).toContainText('first 400 of', { timeout: 15_000 });
  await expect(out(page)).toContainText('Characters: 1000000 characters');
  const ms = Number(((await page.locator('.status').innerText()).match(/(\d+) ms/) ?? [])[1]);
  expect(ms).toBeLessThan(2000);
  const gap = await page.evaluate(() => (window as unknown as { maxGap: number }).maxGap);
  expect(gap).toBeLessThan(1000);
  expect(w.errors).toEqual([]);
});
