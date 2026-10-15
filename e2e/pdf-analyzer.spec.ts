import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

// The PDF analyzer through the real UI: the hand-made samples dropped on the file input, the
// downloads, the password and inspect options, and a big file that must not freeze the page.

const sample = (name: string) =>
  fileURLToPath(new URL(`../public/samples/${name}`, import.meta.url));
const out = (page: Page) => page.locator('.pane-out');

/** Open the tool, collecting page errors and requests that leave the app's origin. */
async function open(page: Page, baseURL: string | undefined) {
  const origin = new URL(baseURL ?? 'http://localhost:4173/').origin;
  const errors: string[] = [];
  const offsite: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.context().on('request', (r) => {
    const url = r.url();
    if (!url.startsWith('blob:') && !url.startsWith('data:') && new URL(url).origin !== origin) {
      offsite.push(url);
    }
  });
  await page.goto('./#/tool/pdf-analyzer');
  return { errors, offsite };
}

const drop = (page: Page, file: string) =>
  page
    .locator('.input-box input[type=file]')
    .setInputFiles(file.includes('/') ? file : sample(file));

/** The output block with this exact label (or matching this pattern). */
const block = (page: Page, label: string | RegExp) =>
  out(page)
    .locator('section.out')
    .filter({
      has: page.locator('.out-label', {
        hasText:
          typeof label === 'string'
            ? new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)
            : label,
      }),
    });

const run = (page: Page) => page.locator('.btn-run').click();

test('an older revision still holds the flag, and is offered as a file', async ({
  page,
  baseURL,
}) => {
  const w = await open(page, baseURL);
  await drop(page, 'pdf-revisions.pdf');
  const result = out(page);
  await expect(result).toContainText('Revisions in the file: 2');
  const revisions = block(page, 'Revisions (saves) in the file');
  await expect(revisions.locator('tbody tr')).toHaveCount(2);
  await expect(revisions.locator('tbody tr').nth(1)).toContainText('4 page 1 content');
  await expect(block(page, /^Revision 1, page 1/).locator('.out-pre')).toHaveText(
    'FTF{old_revision}',
  );
  await expect(block(page, 'Page 1').locator('.out-pre')).toHaveText('Nothing to see here');
  await expect(page.locator('.flag-strip')).toContainText('FTF{old_revision}');
  // the first revision downloads as a PDF of its own
  const files = block(page, 'Earlier revisions, each as a PDF file');
  await expect(files.locator('.file-name')).toHaveText('revision-1.pdf');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    files.getByRole('button', { name: 'Download' }).click(),
  ]);
  const saved = readFileSync((await download.path())!);
  expect(download.suggestedFilename()).toBe('revision-1.pdf');
  expect(saved.length).toBe(801);
  expect(saved.subarray(0, 8).toString('latin1')).toBe('%PDF-1.7');
  await expect(result.locator('.note-error')).toHaveCount(0);
  expect(w.errors).toEqual([]);
  expect(w.offsite).toEqual([]);
});

test('invisible text: five pieces, each with its reason', async ({ page, baseURL }) => {
  const w = await open(page, baseURL);
  await drop(page, 'pdf-invisible-text.pdf');
  const hidden = block(page, 'Hidden text');
  await expect(hidden.locator('tbody tr')).toHaveCount(5);
  await expect(hidden).toContainText('FTF{invisible_text}');
  await expect(hidden).toContainText('render mode 3 (invisible)');
  await expect(hidden).toContainText('white fill');
  await expect(hidden).toContainText('font smaller than 2 points');
  await expect(hidden).toContainText('outside the page');
  await expect(hidden).toContainText('covered by a filled shape drawn later');
  await expect(block(page, 'Page 1').locator('.out-pre')).toHaveText(
    'Public page: nothing to see\nThe box above hides a line',
  );
  expect(w.errors).toEqual([]);
});

test('embedded file download, JavaScript shown but never run, form value', async ({
  page,
  baseURL,
}) => {
  const w = await open(page, baseURL);
  await drop(page, 'pdf-embedded-js.pdf');
  await expect(block(page, 'JavaScript of object 9 (not run)').locator('.out-pre')).toHaveText(
    "app.alert('demo');",
  );
  await expect(out(page)).toContainText('never run');
  await expect(block(page, 'Form fields')).toContainText('FTF{form_value}');
  await expect(block(page, 'Actions and links')).toContainText('https://example.com/ftf-demo');
  const files = block(page, 'Embedded files, to download');
  await expect(files.locator('.file-name')).toHaveText('hidden-note.txt');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    files.getByRole('button', { name: 'Download' }).click(),
  ]);
  expect(readFileSync((await download.path())!, 'latin1')).toBe(
    'FTF{embedded_file}\nThis note travels inside the PDF.\n',
  );
  // pipeable to the other tools
  await expect(files.locator('select.pipe')).toHaveCount(1);
  expect(w.errors).toEqual([]);
  expect(w.offsite).toEqual([]);
});

test('an encrypted PDF asks for the user password and opens once it is typed', async ({
  page,
  baseURL,
}) => {
  const w = await open(page, baseURL);
  await drop(page, 'pdf-encrypted-password.pdf');
  await expect(out(page)).toContainText('the empty user password does not open it');
  await expect(block(page, 'Page 1')).toHaveCount(0);
  await page.locator('#opt-pdf-analyzer-password').fill('demo123');
  await run(page);
  await expect(block(page, 'Page 1').locator('.out-pre')).toHaveText('FTF{password_ok}', {
    timeout: 15_000,
  });
  await expect(block(page, 'Encryption')).toContainText('opened with your password');
  expect(w.errors).toEqual([]);
});

test('inspect one object as of the first revision, then search the streams', async ({
  page,
  baseURL,
}) => {
  const w = await open(page, baseURL);
  await drop(page, 'pdf-revisions.pdf');
  await expect(block(page, 'Revisions (saves) in the file')).toBeVisible();
  await page.locator('#opt-pdf-analyzer-object').fill('4');
  await page.locator('#opt-pdf-analyzer-object').press('Tab');
  await page.locator('#opt-pdf-analyzer-revision').fill('1');
  await run(page);
  const data = block(page, /^Stream data/);
  await expect(data).toContainText('FTF{old_revision}', { timeout: 15_000 });
  await expect(block(page, 'Object 4')).toContainText('1 / 2');
  await expect(
    block(page, 'Every version of this object in the file').locator('tbody tr'),
  ).toHaveCount(2);
  // download the decoded stream
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    data.getByRole('button', { name: 'Download' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('object-4.txt');
  await page.locator('#opt-pdf-analyzer-search').fill('Nothing to');
  await run(page);
  await expect(block(page, 'Search: Nothing to')).toContainText('decoded stream', {
    timeout: 15_000,
  });
  expect(w.errors).toEqual([]);
});

test('a 60 MB PDF is analysed in the worker and the page keeps drawing', async ({
  page,
  baseURL,
}) => {
  test.setTimeout(90_000);
  const w = await open(page, baseURL);
  const head =
    '%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n';
  const big = Buffer.alloc(60 * 1024 * 1024);
  for (let i = 0; i < big.length; i += 4096) big[i] = (i / 4096) & 255;
  let small = '';
  for (let n = 4; n < 3004; n++) small += `${n} 0 obj\n<< /N ${n} >>\nendobj\n`;
  const body = Buffer.concat([
    Buffer.from(head, 'latin1'),
    Buffer.from(`3 0 obj\n<< /Length ${big.length} >>\nstream\n`, 'latin1'),
    big,
    Buffer.from(
      `\nendstream\nendobj\n${small}trailer\n<< /Root 1 0 R /Size 3004 >>\n%%EOF\n`,
      'latin1',
    ),
  ]);
  // how long the page goes without drawing a frame while the file is read and analysed
  await page.evaluate(() => {
    const w = window as unknown as { __gap: number };
    w.__gap = 0;
    let last = performance.now();
    const tick = (now: number) => {
      w.__gap = Math.max(w.__gap, now - last);
      last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const dir = mkdtempSync(join(tmpdir(), 'ftf-pdf-'));
  try {
    const file = join(dir, 'big.pdf');
    writeFileSync(file, body);
    await drop(page, file);
    await expect(block(page, 'Streams')).toContainText('60', { timeout: 60_000 });
    await expect(block(page, 'Objects')).toBeVisible({ timeout: 60_000 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const gap = await page.evaluate(() => (window as unknown as { __gap: number }).__gap);
  expect(gap).toBeLessThan(1500);
  expect(w.errors).toEqual([]);
});
