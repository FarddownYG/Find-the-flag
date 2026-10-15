import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { encode as encodeJpeg } from 'jpeg-js';
import { decodeImageExact } from '../src/core/decode-image';

const sample = (name: string) =>
  fileURLToPath(new URL(`../public/samples/${name}`, import.meta.url));

/** Every request the page makes, plus console errors and CSP violations. */
function watch(page: Page) {
  const requests: string[] = [];
  const errors: string[] = [];
  page.context().on('request', (r) => requests.push(r.url()));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  void page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`);
    });
  });
  return { requests, errors };
}

const out = (page: Page) => page.locator('.pane-out');
const drop = (page: Page, name: string) =>
  page.locator('.input-box input[type=file]').setInputFiles(sample(name));
const run = (page: Page) => page.locator('.btn-run').click();

test('barcode: the engine loads only when used, from our own files, and nothing leaves', async ({
  page,
  baseURL,
}) => {
  const { requests, errors } = watch(page);
  const origin = new URL(baseURL ?? 'http://localhost:4173/').origin;
  await page.goto('./#/tool/barcode');
  await expect(page.getByRole('heading', { name: 'Barcode reader' })).toBeVisible();
  // Opening the tool (or the whole app) does not fetch the WebAssembly file.
  expect(requests.filter((u) => u.endsWith('.wasm'))).toEqual([]);

  await drop(page, 'barcode-code128.png');
  await expect(out(page)).toContainText('FTF{code128_demo}', { timeout: 20_000 });
  await expect(out(page)).toContainText('Format: Code 128 (1D)');
  await expect(out(page)).toContainText('Raw bytes (hex): 46 54 46 7b');
  // The picture with the box is there.
  await expect(out(page).locator('.out-image canvas.out-canvas')).toHaveCount(1);

  const wasm = requests.filter((u) => /\.wasm($|\?)/.test(u));
  expect(wasm.length).toBeGreaterThan(0);
  for (const u of wasm) {
    expect(new URL(u).origin).toBe(origin);
    expect(new URL(u).pathname).toMatch(/\/assets\/zxing_reader-[\w-]+\.wasm$/);
  }
  // No CDN, no other host: everything the page asked for came from this origin (or blob:/data:).
  const foreign = requests.filter((u) => {
    const proto = new URL(u).protocol;
    return proto !== 'blob:' && proto !== 'data:' && new URL(u).origin !== origin;
  });
  expect(foreign).toEqual([]);
  expect(errors).toEqual([]);
});

test('barcode: two codes are listed with their position and drawn on the picture', async ({
  page,
}) => {
  const { errors } = watch(page);
  await page.goto('./#/tool/barcode');
  await drop(page, 'barcode-two-codes.png');
  await expect(out(page)).toContainText('2 codes found.', { timeout: 20_000 });
  const table = out(page).locator('table');
  await expect(table).toContainText('Code 128');
  await expect(table).toContainText('FTF{first_code}');
  await expect(table).toContainText('QR Code');
  await expect(table).toContainText('FTF{second_code}');
  await expect(out(page).locator('.out-image canvas.out-canvas')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('barcode: the helper passes read a white-on-black, tilted, speckled code and say so', async ({
  page,
}) => {
  const { errors } = watch(page);
  await page.goto('./#/tool/barcode');
  const options = page.locator('.options');
  await options.getByRole('button', { name: 'One pass' }).click();
  await drop(page, 'barcode-hard.png');
  await expect(out(page)).toContainText('No barcode found with the picture as it is', {
    timeout: 20_000,
  });
  await expect(out(page)).toContainText('Bit planes');
  await options.getByRole('button', { name: 'Smart' }).click();
  await run(page);
  await expect(out(page)).toContainText('FTF{hard_to_read}', { timeout: 30_000 });
  await expect(out(page)).toContainText(
    'Read after: colours inverted (light on dark), noise removed (3x3 median filter)',
  );
  expect(errors).toEqual([]);
});

test('barcode: a code without a readable payload says plainly that nothing was found', async ({
  page,
}) => {
  await page.goto('./#/tool/barcode');
  await drop(page, 'meta-plain.png');
  await expect(out(page).locator('.note-warn')).toContainText('No barcode found after', {
    timeout: 20_000,
  });
  await expect(out(page)).toContainText('QR code reader');
});

test('barcode: a lossy JPEG of two codes is read through the browser decoder', async ({ page }) => {
  const { errors } = watch(page);
  const png = decodeImageExact(new Uint8Array(readFileSync(sample('barcode-two-codes.png'))));
  if (!png) throw new Error('the sample is not a PNG');
  const jpeg = encodeJpeg({ width: png.width, height: png.height, data: png.data }, 55).data;
  await page.goto('./#/tool/barcode');
  await page.locator('.input-box input[type=file]').setInputFiles({
    name: 'photo.jpg',
    mimeType: 'image/jpeg',
    buffer: Buffer.from(jpeg),
  });
  await expect(out(page)).toContainText('2 codes found.', { timeout: 20_000 });
  await expect(out(page)).toContainText('FTF{first_code}');
  await expect(out(page)).toContainText('FTF{second_code}');
  expect(errors).toEqual([]);
});

test('barcode from modules: a pasted pattern is decoded', async ({ page }) => {
  const { errors } = watch(page);
  await page.goto('./#/tool/barcode-pattern');
  await page
    .locator('.input-text')
    .fill(
      '11010010000100011000101101110001010001100010111101101101001000011010010110000100100111101011110010010100011110100111001101100011101011',
    );
  await run(page);
  await expect(out(page)).toContainText('FTF{bars}', { timeout: 20_000 });
  await expect(out(page)).toContainText('Format: Code 128 (1D)');
  await expect(out(page)).toContainText('Size: 134 modules wide, one row (1D bars)');
  await page.locator('.input-text').fill('1012');
  await run(page);
  await expect(out(page)).toContainText('Unexpected character', { timeout: 15_000 });
  expect(errors).toEqual([]);
});

test('the QR reader points to the barcode reader when it finds no QR code', async ({ page }) => {
  await page.goto('./#/tool/qr');
  await drop(page, 'barcode-code128.png');
  await expect(out(page)).toContainText('No QR code found', { timeout: 20_000 });
  await expect(out(page)).toContainText('The Barcode reader also reads 1D codes');
});
