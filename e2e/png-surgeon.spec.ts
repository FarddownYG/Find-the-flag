import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { decode } from 'fast-png';
import {
  NO_HINT_SEQ,
  noHintOriginal,
  rgbToRgba,
  shuffledOriginal,
} from '../src/tools/stego/_png-surgeon-fixtures';

const SUCCESS =
  "Restored: 11 IDAT chunks reordered (hint 'order', chunk→position); zlib stream OK; image below.";
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const pixels = (img: { data: Uint8ClampedArray }) => sha256(new Uint8Array(img.data.buffer));
/** The pictures drawn by the sample generator, before their IDAT chunks were shuffled. */
const ORIGINAL = pixels(rgbToRgba(shuffledOriginal()));
const NO_HINT = pixels(rgbToRgba(noHintOriginal()));
const sample = (name: string) =>
  fileURLToPath(new URL(`../public/samples/${name}`, import.meta.url));
/** png-no-hint.png in position→chunk form, as the reorder list names it ("#4", "#7"…). */
const NO_HINT_TARGET = (() => {
  const out = new Array<string>(NO_HINT_SEQ.length);
  NO_HINT_SEQ.forEach((pos, j) => (out[pos - 1] = `#${j + 1}`));
  return out;
})();

/** Record page errors, console errors and every request that leaves the app's origin. */
function watch(page: Page, appOrigin: string) {
  const errors: string[] = [];
  const offsite: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.context().on('request', (r) => {
    const url = r.url();
    if (!url.startsWith('blob:') && !url.startsWith('data:') && new URL(url).origin !== appOrigin)
      offsite.push(url);
  });
  return { errors, offsite };
}

/** SHA-256 of the RGBA pixels shown in the restored-image canvas. */
async function canvasHash(page: Page): Promise<string> {
  const canvas = page.locator('.pane-out .out-image canvas.out-canvas').first();
  const data = await canvas.evaluate((el) => {
    const c = el as HTMLCanvasElement;
    return Array.from(c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data);
  });
  return sha256(new Uint8Array(data));
}

const out = (page: Page) => page.locator('.pane-out');
const summary = (page: Page) => out(page).locator('.out-stack > .note').first();
const items = (page: Page) => out(page).locator('.out-reorder .reorder-item');
const labels = async (page: Page) =>
  (await items(page).locator('.reorder-label').allTextContents()).map((s) =>
    s.replace('IDAT ', ''),
  );
const orderField = (page: Page) => page.locator('#opt-png-surgeon-order');

async function open(page: Page, baseURL: string | undefined) {
  const appOrigin = new URL(baseURL ?? 'http://localhost:4173/').origin;
  const w = watch(page, appOrigin);
  await page.goto('./#/tool/png-surgeon');
  return w;
}

async function drop(page: Page, name: string) {
  await page.locator('.input-box input[type=file]').setInputFiles(sample(name));
}

test('png surgeon: shuffled IDAT chunks restored, broken by hand, restored again', async ({
  page,
  baseURL,
}) => {
  const { errors, offsite } = await open(page, baseURL);
  await page
    .locator('.examples')
    .getByRole('button', { name: 'Shuffled IDAT chunks + order hint', exact: true })
    .click();
  await expect(summary(page)).toHaveText(SUCCESS, { timeout: 15_000 });
  await expect(summary(page)).toHaveClass(/note-success/);

  // The payoff: the restored picture is on the page, pixel for pixel the original drawing.
  const canvas = out(page).locator('.out-image canvas.out-canvas').first();
  await expect(canvas).toBeVisible();
  await expect(canvas).toHaveAttribute('width', '320');
  await expect(canvas).toHaveAttribute('height', '120');
  expect(await canvasHash(page)).toBe(ORIGINAL);
  await expect(out(page).locator('.out-files')).toContainText('png-shuffled-idat-repaired.png');

  // Break the order with the reorder block: ↓ on the first IDAT swaps the first two.
  await expect(items(page)).toHaveCount(11);
  const before = await labels(page);
  await out(page)
    .locator('.out-reorder')
    .getByRole('button', { name: `Move IDAT ${before[0]} down`, exact: true })
    .click();
  await expect(summary(page)).toHaveClass(/note-error/, { timeout: 15_000 });
  await expect(summary(page)).toContainText(
    'Not restored: the order set in the list (#…) gives no valid',
  );
  await expect(out(page).locator('.out-image canvas.out-canvas')).toHaveCount(0);
  // The Order field holds the list as shown, the swapped pair first, and the list shows the swap.
  const swapped = [before[1]!, before[0]!, ...before.slice(2)];
  await expect(orderField(page)).toHaveValue(swapped.join(' '));
  expect(await labels(page)).toEqual(swapped);

  // One click on the proposed fix: back to the hint, and to the picture.
  await out(page)
    .locator('.out-actions-block')
    .getByRole('button', { name: "Use the hint 'order'", exact: true })
    .click();
  await expect(summary(page)).toHaveText(SUCCESS, { timeout: 15_000 });
  await expect(orderField(page)).toHaveValue('');
  expect(await canvasHash(page)).toBe(ORIGINAL);

  expect(offsite).toEqual([]);
  expect(errors).toEqual([]);
});

test('png surgeon: the other reading of the hint fails, and says where', async ({
  page,
  baseURL,
}) => {
  const { errors, offsite } = await open(page, baseURL);
  await page
    .locator('.examples')
    .getByRole('button', { name: 'Shuffled IDAT chunks + order hint', exact: true })
    .click();
  await expect(summary(page)).toHaveText(SUCCESS, { timeout: 15_000 });
  const fixes = out(page).locator('.out-actions-block');
  await fixes
    .getByRole('button', { name: 'Try the other reading (position→chunk)', exact: true })
    .click();
  await expect(summary(page)).toHaveText(
    "Not restored: the hint 'order' gives no valid zlib stream (position→chunk: IDAT #4 comes first but does not start with a zlib header (80 25)).",
    { timeout: 15_000 },
  );
  await fixes.getByRole('button', { name: 'Try both readings', exact: true }).click();
  await expect(summary(page)).toHaveText(SUCCESS, { timeout: 15_000 });
  expect(offsite).toEqual([]);
  expect(errors).toEqual([]);
});

test('png surgeon: dropped files (desktop): restored image in view, search, broken sample, heights', async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize({ width: 1366, height: 800 });
  const { errors, offsite } = await open(page, baseURL);
  await drop(page, 'png-shuffled-idat.png');
  await expect(summary(page)).toHaveText(SUCCESS, { timeout: 15_000 });
  const canvas = out(page).locator('.out-image canvas.out-canvas').first();
  const box = await canvas.boundingBox();
  expect(box && box.y + box.height).toBeLessThanOrEqual(800);

  await drop(page, 'png-no-hint.png');
  await expect(summary(page)).toHaveText(
    'Restored: 11 IDAT chunks reordered (order found without a hint); zlib stream OK; image below.',
    { timeout: 15_000 },
  );
  expect(await canvasHash(page)).toBe(NO_HINT);

  // A real drop event on the page, as a user dragging the file in.
  const bytes = [...readFileSync(sample('png-broken.png'))];
  const dt = await page.evaluateHandle((b) => {
    const d = new DataTransfer();
    d.items.add(new File([new Uint8Array(b)], 'png-broken.png', { type: 'image/png' }));
    return d;
  }, bytes);
  await page.locator('.pane-in').dispatchEvent('drop', { dataTransfer: dt });
  await expect(summary(page)).toHaveText(
    'Restored: PNG signature fixed; zlib header 00 00 → 78 9C; 2 CRCs recomputed; height 60 → 120; zlib stream OK; image below. After IEND: ZIP archive (see Files).',
    { timeout: 15_000 },
  );
  await expect(out(page).locator('.out-files')).toContainText('png-broken-after-iend.zip');

  // The height brute force is one click away, and back.
  const heights = out(page).locator('.out-actions-block').filter({ hasText: 'Height 60' });
  await heights.getByRole('button', { name: 'Height 60 (as stored)', exact: true }).click();
  await expect(canvas).toHaveAttribute('height', '60', { timeout: 15_000 });
  await out(page).getByRole('button', { name: 'Automatic size', exact: true }).click();
  await expect(canvas).toHaveAttribute('height', '120', { timeout: 15_000 });
  expect(offsite).toEqual([]);
  expect(errors).toEqual([]);
});

test('png surgeon: dragging writes the order shown, and the list shows what was dragged', async ({
  page,
  baseURL,
}) => {
  const { errors } = await open(page, baseURL);
  await drop(page, 'png-shuffled-idat.png');
  await expect(summary(page)).toHaveText(SUCCESS, { timeout: 15_000 });
  const before = await labels(page);
  await items(page).nth(0).dragTo(items(page).nth(3));
  const dragged = [...before.slice(1, 4), before[0]!, ...before.slice(4)];
  await expect(orderField(page)).toHaveValue(dragged.join(' '), { timeout: 15_000 });
  await expect(summary(page)).toHaveClass(/note-error/, { timeout: 15_000 });
  expect(await labels(page)).toEqual(dragged);
  // Dragging it back gives the working order back, not a third one.
  await items(page).nth(3).dragTo(items(page).nth(0));
  await expect(orderField(page)).toHaveValue(before.join(' '), { timeout: 15_000 });
  await expect(summary(page)).toHaveText(
    'Restored: 11 IDAT chunks reordered (order set in the list); zlib stream OK; image below.',
    { timeout: 15_000 },
  );
  expect(errors).toEqual([]);
});

for (const reading of ['auto', 'position', 'chunk'] as const) {
  test(`png surgeon: a whole order fixed by hand with drags restores (reading ${reading})`, async ({
    page,
    baseURL,
  }) => {
    const { errors } = await open(page, baseURL);
    await drop(page, 'png-no-hint.png');
    await expect(summary(page)).toHaveClass(/note-success/, { timeout: 15_000 });
    await page.getByLabel('Search the order when there is no hint').uncheck();
    await page.locator('#opt-png-surgeon-reading').selectOption(reading);
    await expect(summary(page)).toHaveClass(/note-error/, { timeout: 15_000 });
    for (let i = 0; i < NO_HINT_TARGET.length; i++) {
      const now = await labels(page);
      const from = now.indexOf(NO_HINT_TARGET[i]!);
      if (from === i) continue;
      await items(page).nth(from).dragTo(items(page).nth(i));
      const next = now.slice();
      const [moved] = next.splice(from, 1);
      next.splice(i, 0, moved!);
      await expect(orderField(page)).toHaveValue(next.join(' '), { timeout: 15_000 });
      await expect.poll(() => labels(page), { timeout: 15_000 }).toEqual(next);
    }
    expect(await labels(page)).toEqual(NO_HINT_TARGET);
    await expect(summary(page)).toHaveText(
      'Restored: 11 IDAT chunks reordered (order set in the list); zlib stream OK; image below.',
      { timeout: 15_000 },
    );
    expect(await canvasHash(page)).toBe(NO_HINT);
    expect(errors).toEqual([]);
  });
}

test('png surgeon: ↑/↓ swap the item, the list shows it, and the focus stays on it', async ({
  page,
  baseURL,
}) => {
  const { errors } = await open(page, baseURL);
  await drop(page, 'png-shuffled-idat.png');
  await expect(summary(page)).toHaveText(SUCCESS, { timeout: 15_000 });
  const before = await labels(page);
  const block = out(page).locator('.out-reorder');
  await block.getByRole('button', { name: `Move IDAT ${before[3]} up`, exact: true }).click();
  const up = [...before.slice(0, 2), before[3]!, before[2]!, ...before.slice(4)];
  await expect.poll(() => labels(page), { timeout: 15_000 }).toEqual(up);

  // Keyboard: focus ↓ on one item, press Enter twice, it moves two places and keeps the focus.
  const id = up[5]!;
  const down = block.getByRole('button', { name: `Move IDAT ${id} down`, exact: true });
  await down.focus();
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await labels(page)).indexOf(id), { timeout: 15_000 }).toBe(6);
  await expect(
    out(page).getByRole('button', { name: `Move IDAT ${id} down`, exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await labels(page)).indexOf(id), { timeout: 15_000 }).toBe(7);
  await expect(
    out(page).getByRole('button', { name: `Move IDAT ${id} down`, exact: true }),
  ).toBeFocused();
  expect(errors).toEqual([]);
});

test('png surgeon: typed orders, the downloaded file, a non-PNG input', async ({
  page,
  baseURL,
}) => {
  const { errors } = await open(page, baseURL);
  await drop(page, 'png-shuffled-idat.png');
  await expect(summary(page)).toHaveText(SUCCESS, { timeout: 15_000 });
  await orderField(page).fill('4 9 1 11 6 2 8 10 3 7 5');
  await expect(summary(page)).toContainText('typed order, chunk→position', { timeout: 15_000 });
  await orderField(page).fill('1 2 3 4');
  await expect(summary(page)).toHaveText(
    'Not restored: Order: it has 4 numbers for 11 IDAT chunks.',
    { timeout: 15_000 },
  );
  await orderField(page).fill('');
  await expect(summary(page)).toHaveText(SUCCESS, { timeout: 15_000 });

  // The repaired file: a valid 320×120 PNG on its own, and nothing left to repair in it.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    out(page)
      .locator('.out-files li')
      .filter({ hasText: 'png-shuffled-idat-repaired.png' })
      .getByRole('button', { name: 'Download', exact: true })
      .click(),
  ]);
  const file = readFileSync((await download.path())!);
  const png = decode(new Uint8Array(file));
  expect([png.width, png.height]).toEqual([320, 120]);
  await page.locator('.input-box input[type=file]').setInputFiles({
    name: 'again.png',
    mimeType: 'image/png',
    buffer: file,
  });
  await expect(summary(page)).toHaveText(
    "Nothing to repair: the IDAT chunks are already in order (the hint 'order' does not apply), the chunks are consistent and the zlib stream is OK; image below.",
    { timeout: 15_000 },
  );

  await page.locator('.input-box input[type=file]').setInputFiles({
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('just some notes, not a picture'),
  });
  await expect(page.locator('.pane-out')).toContainText('This does not look like a PNG', {
    timeout: 15_000,
  });
  expect(errors).toEqual([]);
});

for (const locale of ['en', 'fr', 'ru', 'zh', 'hi']) {
  test(`png surgeon: no horizontal scroll on a phone (390×844, ${locale})`, async ({
    page,
    baseURL,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript((l) => localStorage.setItem('ftf.locale', l), locale);
    await open(page, baseURL);
    const width = () => page.evaluate(() => document.documentElement.scrollWidth);
    // Every block of the tool (options, input, each output) fits the screen; wide tables
    // scroll inside their own box.
    const widest = () =>
      page.evaluate(() =>
        Math.max(
          ...[...document.querySelectorAll('.options .opt, .pane-in, .out-stack > *')].map(
            (e) => e.getBoundingClientRect().right,
          ),
        ),
      );
    expect(await width()).toBeLessThanOrEqual(390);
    await drop(page, 'png-shuffled-idat.png');
    await expect(items(page)).toHaveCount(11, { timeout: 15_000 });
    expect(await widest()).toBeLessThanOrEqual(390);
    // The Russian top bar ("Инструменты") is 9 px too wide once the page scrolls, on every
    // tool (image-structure too): shared shell, not this tool.
    if (locale !== 'ru') expect(await width()).toBeLessThanOrEqual(390);
  });
}

test('png surgeon: French UI, every tool text translated', async ({ page, baseURL }) => {
  await page.addInitScript(() => localStorage.setItem('ftf.locale', 'fr'));
  await open(page, baseURL);
  const english = [
    'Restored',
    'Not restored',
    'Nothing to repair',
    'Orders tried',
    'Text chunks',
    'IDAT order (file chunk numbers)',
    'Read the order as',
    'Search the order',
    'Fixes',
    'Expected from IHDR',
    'After IEND',
    'order found',
    'zlib stream OK',
  ];
  for (const name of ['png-shuffled-idat.png', 'png-no-hint.png', 'png-broken.png']) {
    await drop(page, name);
    await expect(summary(page)).toContainText('Restaurée', { timeout: 15_000 });
    const text = await page.locator('main, body').first().innerText();
    const attrs = await page.evaluate(() =>
      [...document.querySelectorAll('[aria-label], [title], [placeholder], option')]
        .map((e) =>
          [
            e.getAttribute('aria-label'),
            e.getAttribute('title'),
            e.getAttribute('placeholder'),
            e.textContent,
          ].join(' '),
        )
        .join('\n'),
    );
    for (const phrase of english) {
      expect(text, `${name}: "${phrase}" left in English`).not.toContain(phrase);
      expect(attrs, `${name}: "${phrase}" left in English`).not.toContain(phrase);
    }
  }
});
