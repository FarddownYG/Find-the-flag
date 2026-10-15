import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { decode as decodePng } from 'fast-png';

// Symbol ciphers (Pigpen, semaphore, Braille) through the real UI: the symbol keyboard typing the
// letters of a sample picture, the SVG and PNG the tool draws, the reference sheet and printing.
// (The examples of the tool are clicked by tools.spec.ts like every other tool's.)

const out = (page: Page) => page.locator('.pane-out');
const input = (page: Page) => page.locator('.input-text');
const key = (page: Page, k: string) => page.locator(`.keypad .key[data-key="${k}"]`);
const control = (page: Page, k: 'space' | 'backspace' | 'clear') =>
  page.locator(`.keypad-ctl .key[data-key="${k}"]`);
const block = (page: Page, label: RegExp) =>
  page.locator('.out-image').filter({ has: page.locator('.out-label', { hasText: label }) });
const sample = (name: string) =>
  readFileSync(new URL(`../public/samples/${name}`, import.meta.url), 'utf8');

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
  await page.goto('./#/tool/symbol-ciphers');
  await expect(page.locator('.keypad .key').first()).toBeVisible();
  return { errors, offsite };
}

async function chooseAlphabet(page: Page, id: 'pigpen' | 'semaphore' | 'braille') {
  await page.locator('.options select').selectOption(id);
}

/** What a challenge picture shows, in reading order: a drawn symbol, or a character of plain text. */
function readPicture(svg: string) {
  const items: ({ glyph: string } | { plain: string })[] = [];
  for (const m of svg.matchAll(
    /<g class="glyph"[^>]*>(.*?)<\/g>|<text class="plain"[^>]*>(.*?)<\/text>/g,
  )) {
    if (m[1] !== undefined) {
      items.push({ glyph: [...m[1].matchAll(/ d="([^"]*)"/g)].map((d) => d[1]).join('|') });
    } else items.push({ plain: m[2]! });
  }
  return items;
}

/**
 * Read a picture the way a person does: for every symbol find the key that looks the same (the
 * drawing of the key is compared with the drawing in the file) and click it; type the plain text.
 */
async function typePicture(page: Page, svg: string) {
  const keys = await page.locator('.keypad .key[data-key]').evaluateAll((els) =>
    els.map((e) => ({
      key: (e as HTMLElement).dataset.key ?? '',
      drawing: [...e.querySelectorAll('path')].map((p) => p.getAttribute('d')).join('|'),
    })),
  );
  for (const item of readPicture(svg)) {
    if ('plain' in item) {
      await input(page).press('End');
      await input(page).pressSequentially(item.plain);
    } else {
      const found = keys.filter((k) => k.drawing === item.glyph);
      expect(found, `a key for ${item.glyph.slice(0, 40)}`).toHaveLength(1);
      await key(page, found[0]!.key).click();
    }
  }
}

test('clicking the Pigpen keys that match the sample picture types FTF{PIGPEN}', async ({
  page,
  baseURL,
}) => {
  const w = await open(page, baseURL);
  const svg = sample('symbols-pigpen-flag.svg');
  expect(svg).not.toContain('PIGPEN'); // the file is a puzzle: no letters in it
  await typePicture(page, svg);
  await expect(input(page)).toHaveValue('FTF{PIGPEN}');
  await expect(out(page).locator('.out-text').first()).toContainText('FTF{PIGPEN}');
  await expect(page.locator('.flag-strip')).toContainText('FTF{PIGPEN}');
  await expect(out(page).locator('.note-error')).toHaveCount(0);
  expect(w.errors).toEqual([]);
  expect(w.offsite).toEqual([]);
});

test('clicking the semaphore figures that match the sample picture types FTF{FLAGS}', async ({
  page,
  baseURL,
}) => {
  const w = await open(page, baseURL);
  await chooseAlphabet(page, 'semaphore');
  await typePicture(page, sample('symbols-semaphore-line.svg'));
  await expect(input(page)).toHaveValue('FTF{FLAGS}');
  await expect(page.locator('.flag-strip')).toContainText('FTF{FLAGS}');
  expect(w.errors).toEqual([]);
});

test('clicking the Braille cells that match the sample picture types ftf{braille}', async ({
  page,
  baseURL,
}) => {
  const w = await open(page, baseURL);
  await chooseAlphabet(page, 'braille');
  await typePicture(page, sample('symbols-braille-line.svg'));
  await expect(input(page)).toHaveValue('ftf{braille}');
  await expect(out(page)).toContainText('Braille cells (Unicode text)');
  await expect(out(page).locator('.out-text').filter({ hasText: 'Braille cells' })).toContainText(
    '⠋⠞⠋',
  );
  expect(w.errors).toEqual([]);
});

test('the keyboard follows the alphabet, and each key is named by its letter', async ({
  page,
  baseURL,
}) => {
  await open(page, baseURL);
  const count = () => page.locator('.keypad .key[data-key]').count();
  expect(await count()).toBe(26);
  await expect(page.locator('.keypad[role="group"]')).toHaveAttribute(
    'aria-label',
    'Symbol keyboard',
  );
  await expect(key(page, 'F')).toHaveAttribute('aria-label', 'F');
  await expect(page.getByRole('button', { name: 'F', exact: true })).toBeVisible();
  await chooseAlphabet(page, 'semaphore');
  expect(await count()).toBe(26);
  await expect(page.locator('.options').getByLabel('Mirrored')).toBeVisible();
  await chooseAlphabet(page, 'braille');
  expect(await count()).toBe(44);
  await expect(key(page, 'a')).toHaveAttribute('aria-label', 'a');
  await expect(page.locator('.options').getByLabel('Mirrored')).toHaveCount(0);
  // The symbols themselves are decorative: the name is on the button.
  await expect(key(page, 'a').locator('svg')).toHaveAttribute('aria-hidden', 'true');
});

test('space, backspace and clear, and keys type where the caret is', async ({ page, baseURL }) => {
  await open(page, baseURL);
  for (const k of 'FTF') await key(page, k).click();
  await control(page, 'space').click();
  await key(page, 'G').click();
  await expect(input(page)).toHaveValue('FTF G');
  await control(page, 'backspace').click();
  await control(page, 'backspace').click();
  await expect(input(page)).toHaveValue('FTF');
  await expect(page.locator('.count')).toHaveText('3 chars');
  // Click into the middle of the text, then press a key: it goes where the caret was left.
  await input(page).focus();
  await input(page).press('Home');
  await input(page).press('ArrowRight');
  await key(page, 'X').click();
  await expect(input(page)).toHaveValue('FXTF');
  await key(page, 'Y').click();
  await expect(input(page)).toHaveValue('FXYTF');
  // A selection is replaced.
  await input(page).focus();
  await input(page).press('Home');
  await input(page).press('Shift+ArrowRight');
  await input(page).press('Shift+ArrowRight');
  await key(page, 'Z').click();
  await expect(input(page)).toHaveValue('ZYTF');
  await control(page, 'clear').click();
  await expect(input(page)).toHaveValue('');
  await expect(page.locator('.count')).toHaveText('0 chars');
  await expect(out(page)).toContainText('Paste input');
  // Typing in the box works as before and the picture follows.
  await input(page).fill('abc');
  await expect(block(page, /^Symbols$/).locator('img')).toBeVisible();
});

test('the picture is a well-formed SVG with one glyph per letter, saved as SVG and as PNG', async ({
  page,
  baseURL,
}) => {
  await open(page, baseURL);
  await input(page).fill('FTF{PIGPEN} ok');
  const symbols = block(page, /^Symbols$/);
  await expect(symbols.locator('img')).toBeVisible();

  const [svgDownload] = await Promise.all([
    page.waitForEvent('download'),
    symbols.getByRole('button', { name: 'Download SVG' }).click(),
  ]);
  expect(svgDownload.suggestedFilename()).toBe('pigpen.svg');
  const svg = readFileSync((await svgDownload.path())!, 'utf8');
  const parsed = await page.evaluate((text) => {
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    return {
      error: doc.querySelector('parsererror')?.textContent ?? null,
      root: doc.documentElement.nodeName,
      glyphs: doc.querySelectorAll('g.glyph').length,
      chars: [...doc.querySelectorAll('g.glyph')].map((g) => g.getAttribute('data-char')).join(''),
      plain: [...doc.querySelectorAll('text.plain')].map((t) => t.textContent).join(''),
      scripts: doc.querySelectorAll('script, image, foreignObject').length,
    };
  }, svg);
  expect(parsed).toEqual({
    error: null,
    root: 'svg',
    glyphs: 11, // FTFPIGPEN + OK
    chars: 'FTFPIGPENOK',
    plain: '{}',
    scripts: 0,
  });

  const [pngDownload] = await Promise.all([
    page.waitForEvent('download'),
    symbols.getByRole('button', { name: 'Download PNG' }).click(),
  ]);
  expect(pngDownload.suggestedFilename()).toBe('pigpen.png');
  const png = readFileSync((await pngDownload.path())!);
  expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const [w, h] = (svg.match(/width="(\d+)" height="(\d+)"/) ?? []).slice(1).map(Number);
  // Drawn at twice the size, so that the lines stay sharp.
  expect(png.readUInt32BE(16)).toBe(w! * 2);
  expect(png.readUInt32BE(20)).toBe(h! * 2);
});

test('the PNG is drawn from the symbols (dark ink on white paper)', async ({ page, baseURL }) => {
  await open(page, baseURL);
  await input(page).fill('E');
  const symbols = block(page, /^Symbols$/);
  await expect(symbols.locator('img')).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    symbols.getByRole('button', { name: 'Download PNG' }).click(),
  ]);
  const bytes = readFileSync((await download.path())!);
  const image = decodePng(bytes);
  const data = image.data as Uint8Array;
  const channels = image.channels;
  let dark = 0;
  let white = 0;
  for (let i = 0; i < data.length; i += channels) {
    if (data[i]! < 80 && (channels < 4 || data[i + 3]! > 200)) dark++;
    if (data[i]! > 250 && data[i + 1]! > 250 && data[i + 2]! > 250) white++;
  }
  expect(dark).toBeGreaterThan(200); // the square of E, drawn at twice the size
  expect(white).toBeGreaterThan((image.width * image.height) / 2);
});

test('the reference sheet shows every symbol, saves as SVG and prints on its own', async ({
  page,
  baseURL,
}) => {
  await open(page, baseURL);
  await input(page).fill('ABC');
  const sheet = block(page, /^Reference/);
  await expect(sheet.locator('img')).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    sheet.getByRole('button', { name: 'Download SVG' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('pigpen-reference.svg');
  const svg = readFileSync((await download.path())!, 'utf8');
  const parsed = await page.evaluate((text) => {
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    return {
      error: doc.querySelector('parsererror')?.textContent ?? null,
      chars: [...doc.querySelectorAll('g.glyph')].map((g) => g.getAttribute('data-char')).join(''),
      labels: [...doc.querySelectorAll('text.label')].map((t) => t.textContent).join(''),
    };
  }, svg);
  expect(parsed).toEqual({
    error: null,
    chars: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    labels: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  });

  // Print: the print dialog is replaced by a probe that records what the page marks for printing.
  await page.evaluate(() => {
    (window as unknown as { printed: unknown }).printed = null;
    window.print = () => {
      (window as unknown as { printed: unknown }).printed = {
        targets: document.querySelectorAll('.print-target').length,
        bodyClass: document.body.classList.contains('print-one'),
        inTarget: document.querySelectorAll('.print-target img').length,
      };
    };
  });
  await sheet.getByRole('button', { name: 'Print' }).click();
  const printed = await page.evaluate(() => (window as unknown as { printed: unknown }).printed);
  expect(printed).toEqual({ targets: 1, bodyClass: true, inTarget: 1 });
  await expect(page.locator('.print-target')).toHaveCount(0);
  expect(await page.evaluate(() => document.body.classList.contains('print-one'))).toBe(false);
});

test('in print media only the chosen block is visible', async ({ page, baseURL }) => {
  await open(page, baseURL);
  await input(page).fill('ABC');
  const sheet = block(page, /^Reference/);
  await expect(sheet.locator('img')).toBeVisible();
  await page.emulateMedia({ media: 'print' });
  await sheet.evaluate((el) => {
    el.classList.add('print-target');
    document.body.classList.add('print-one');
  });
  await expect(sheet.locator('img')).toBeVisible();
  await expect(page.locator('.tool-head h1')).toBeHidden();
  await expect(page.locator('.keypad .key').first()).toBeHidden();
  await expect(block(page, /^Symbols$/).locator('img')).toBeHidden();
});

test('semaphore can be drawn mirrored', async ({ page, baseURL }) => {
  await open(page, baseURL);
  await chooseAlphabet(page, 'semaphore');
  await input(page).fill('ABC');
  const symbols = block(page, /^Symbols$/);
  const download = async () => {
    const [d] = await Promise.all([
      page.waitForEvent('download'),
      symbols.getByRole('button', { name: 'Download SVG' }).click(),
    ]);
    return readFileSync((await d.path())!, 'utf8');
  };
  await expect(symbols.locator('img')).toBeVisible();
  const normal = await download();
  await page.locator('.options').getByLabel('Mirrored').check();
  await expect(page.locator('.keypad .key').first()).toBeVisible();
  await expect.poll(async () => (await download()) !== normal).toBe(true);
  await page.locator('.options').getByLabel('Mirrored').uncheck();
  await expect.poll(async () => (await download()) === normal).toBe(true);
});

test('Braille cells pasted on the home page are also offered to this tool', async ({ page }) => {
  await page.goto('./');
  await page.getByLabel('Paste data to identify').fill('⠋⠞⠋ ⠃⠗⠁⠊⠇⠇⠑ ⠼⠁⠃⠉');
  // The Braille text tool comes first for pasted cells; this one (pictures) is offered too.
  await expect(page.locator('.guess').first()).toContainText('Braille');
  const guess = page.locator('.guess', { hasText: 'Symbol ciphers' });
  await expect(guess).toHaveCount(1);
  await guess.click();
  await expect(page.locator('.options select')).toHaveValue('braille');
  await expect(out(page).locator('.out-text').first()).toContainText('ftf braille 123');
});

test('a long text is drawn up to a limit, not frozen', async ({ page, baseURL }) => {
  await open(page, baseURL);
  await chooseAlphabet(page, 'semaphore');
  await input(page).fill('ABCDEFGH '.repeat(400));
  await expect(out(page)).toContainText('Only the first 1500 symbols are drawn', {
    timeout: 15_000,
  });
  await expect(block(page, /^Symbols$/).locator('img')).toBeVisible();
});

test('the keyboard stays usable on a phone', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, baseURL);
  for (const k of 'HI') await key(page, k).click();
  await expect(input(page)).toHaveValue('HI');
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  const box = (await key(page, 'H').boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(40);
  expect(box.height).toBeGreaterThanOrEqual(40);
});
