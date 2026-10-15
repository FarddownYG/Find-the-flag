import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

// The SQLite tool through the real UI: the engine (sql.js, a WebAssembly build of SQLite) must load
// from the page's own origin inside the tool worker, a file you open must be explored, and the SQL
// box must refuse everything that writes. (The examples of the tool are clicked by tools.spec.ts.)

const sample = (name: string) =>
  fileURLToPath(new URL(`../public/samples/${name}`, import.meta.url));
const chip = (page: Page, name: string) =>
  page.locator('.examples').getByRole('button', { name, exact: true });
const out = (page: Page) => page.locator('.pane-out');

test('the SQL engine is loaded from our own origin, with no other request', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (r) => requests.push(r.url()));
  const wasm = page.waitForResponse((r) => r.url().endsWith('.wasm'));
  await page.goto('./#/tool/sqlite');
  await chip(page, 'Open an app database').click();
  await expect(out(page)).toContainText('FTF{sqlite_demo}');
  const res = await wasm;
  expect(res.status()).toBe(200);
  const origin = new URL(page.url()).origin;
  expect(res.url().startsWith(origin)).toBe(true);
  expect(requests.filter((u) => !u.startsWith(origin) && !u.startsWith('blob:'))).toEqual([]);
});

test('open your own file, browse a table page by page, then use the SQL box', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('./#/tool/sqlite');
  await page.locator('.input-box input[type=file]').setInputFiles(sample('sqlite-app.db'));
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  // Not a demo: it is the user's own file.
  await expect(out(page)).toContainText('Tables, views, indexes and triggers');
  await expect(page.locator('.demo-banner')).toBeHidden();
  await expect(out(page)).toContainText('User version');

  await out(page).getByRole('button', { name: 'Browse notes', exact: true }).click();
  await expect(out(page)).toContainText('rows 1–8 of 8');
  await expect(out(page)).toContainText('Shopping list');
  await expect(page.locator('#opt-sqlite-table')).toHaveValue('notes');

  // Three rows per page: the buttons under the table move through them.
  await page.locator('#opt-sqlite-rows').fill('3');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(out(page)).toContainText('rows 1–3 of 8');
  await out(page).getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(out(page)).toContainText('rows 4–6 of 8');
  await expect(out(page)).toContainText('Pancakes');
  await expect(out(page)).not.toContainText('Shopping list');
  await out(page).getByRole('button', { name: 'Last page', exact: true }).click();
  await expect(out(page)).toContainText('rows 7–8 of 8');

  // The SQL box answers a SELECT ...
  await page.locator('#opt-sqlite-mode').selectOption('sql');
  await page.locator('#opt-sqlite-sql').fill('SELECT author, count(*) FROM notes GROUP BY author');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  // The Page option is shared: page 3 of the table left no page 3 of this short result.
  await expect(out(page)).toContainText('has no rows on page 3');
  await out(page).getByRole('button', { name: 'First page', exact: true }).click();
  await expect(out(page)).toContainText('carol');

  // ... and refuses a write, and says why.
  await page.locator('#opt-sqlite-sql').fill('DELETE FROM notes');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(out(page).locator('.note-error')).toContainText(
    'DELETE is refused: this box only reads',
  );
  await page.locator('#opt-sqlite-sql').fill("ATTACH DATABASE 'x.db' AS x");
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(out(page).locator('.note-error')).toContainText('ATTACH is refused');
  // The table is untouched.
  await page.locator('#opt-sqlite-sql').fill('SELECT count(*) AS n FROM notes');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(out(page).locator('td').filter({ hasText: /^8$/ })).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('a BLOB shows its size, hex and file type, and downloads as the stored bytes', async ({
  page,
}) => {
  await page.goto('./#/tool/sqlite');
  await chip(page, 'A PNG stored as a BLOB').click();
  await expect(out(page)).toContainText(
    'BLOB 363 B · 89 50 4e 47 0d 0a 1a 0a 00 00 00 0d … · PNG image',
  );
  await expect(out(page).locator('img.out-picture')).toHaveCount(2); // the PNG and the GIF
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    out(page)
      .locator('.out-files li', { hasText: 'files_data_row1.png' })
      .getByRole('button', { name: 'Download' })
      .click(),
  ]);
  expect(download.suggestedFilename()).toBe('files_data_row1.png');
  const png = readFileSync(await download.path());
  expect(png).toHaveLength(363);
  expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
});

test('deleted records: the row that was DELETEd comes back with its page and offset', async ({
  page,
}) => {
  await page.goto('./#/tool/sqlite');
  await page.locator('.input-box input[type=file]').setInputFiles(sample('sqlite-deleted.db'));
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(out(page)).toContainText('Possibly deleted records:');
  await out(page).getByRole('button', { name: 'Deleted records', exact: true }).click();
  await expect(out(page)).toContainText('These records are possibly deleted');
  const row = out(page).locator('tr', { hasText: 'FTF{deleted_row}' });
  await expect(row).toContainText('freeblock');
  await expect(row).toContainText('messages → id=NULL | sender=dave');
  await expect(out(page).locator('.flag-strip, .flag-chip').first()).toBeVisible();
});

test('a -wal file added as an option shows the newer state of the data', async ({ page }) => {
  await page.goto('./#/tool/sqlite');
  await page.locator('.input-box input[type=file]').setInputFiles(sample('sqlite-wal.db'));
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(out(page)).toContainText('in WAL mode');
  await page.locator('.options input[type=file]').setInputFiles(sample('sqlite-wal.db-wal'));
  await expect(page.locator('.options')).toContainText('sqlite-wal.db-wal');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(out(page)).toContainText('committed WAL frames written over a copy');
  await expect(out(page)).toContainText('FTF{in_the_wal}');
  // Turned off, the file alone is shown.
  await page.getByLabel('Apply the WAL frames').uncheck();
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(out(page)).toContainText('not applied');
  await expect(out(page)).not.toContainText('FTF{in_the_wal}');
});

test('Chrome history times are shown in UTC', async ({ page }) => {
  await page.goto('./#/tool/sqlite');
  await chip(page, 'Chrome history with UTC times').click();
  await expect(out(page)).toContainText('2024-03-14T09:26:53.123Z');
  await expect(out(page)).toContainText('WebKit time: microseconds since 1601-01-01 UTC');
});

test('a file that is not a database is explained', async ({ page }) => {
  await page.goto('./#/tool/sqlite');
  await page.locator('.input-box input[type=file]').setInputFiles({
    name: 'notes.db',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from('plain text, not a database'),
  });
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(out(page).locator('.note-error')).toContainText('not a SQLite database');
});

test('the home triage suggests the SQLite tool for a database', async ({ page }) => {
  await page.goto('./');
  await page.locator('input[type=file]').first().setInputFiles(sample('sqlite-app.db'));
  await expect(page.locator('.guess').first()).toContainText('SQLite database');
});
