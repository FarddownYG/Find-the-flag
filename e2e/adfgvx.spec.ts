import { expect, test, type Page } from '@playwright/test';

// The ADFGX / ADFGVX tool through the real UI: typing the square and the key by hand, switching
// to the 5 x 5 variant, your own coordinate letters, the error messages and the home triage.
// (The examples of the tool are clicked by tools.spec.ts like every other tool's.)

const out = (page: Page) => page.locator('.pane-out');
const seg = (page: Page, group: string, name: string) =>
  page.getByRole('group', { name: group }).getByRole('button', { name, exact: true });

// Wikipedia, "ADFGVX cipher": this square, the key PRIVACY, the message "Attack at 1200AM".
const SQUARE = 'NA1C3H8TB2OME5WRPD4F6G7I9J0KLQSUVXYZ';
const CIPHER = 'DGDD DAGD DGAF ADDF DADV DVFA ADVX';

async function open(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('./#/tool/adfgvx');
  return errors;
}

test('decrypts by hand: square, key, then the three steps are shown', async ({ page }) => {
  const errors = await open(page);
  await page.locator('.input-text').fill(CIPHER);
  await expect(out(page).locator('.note-error')).toContainText('Enter a key');
  await page.locator('#opt-adfgvx-key').fill('PRIVACY');
  await page.locator('#opt-adfgvx-square').fill(SQUARE);
  const result = out(page);
  await expect(result.locator('.out-text').first()).toContainText('ATTACKAT1200AM');
  await expect(result).toContainText('AD DD DD AD AG VG AD DD AF DG VF VF AD DX');
  // The grid shows the key and the order in which its columns were read, and the square its labels.
  await expect(result.getByText('Transposition grid')).toBeVisible();
  await expect(result.locator('table').first().locator('tr').nth(1)).toContainText('5');
  await expect(result.locator('table').nth(1)).toContainText('N');
  await expect(result.locator('.note-error')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('encrypts in groups of five and switches to the 5 x 5 variant', async ({ page }) => {
  const errors = await open(page);
  await seg(page, 'Mode', 'Encrypt').click();
  await page.locator('#opt-adfgvx-key').fill('PRIVACY');
  await page.locator('#opt-adfgvx-square').fill(SQUARE);
  await page.locator('.input-text').fill('Attack at 1200AM');
  const result = out(page);
  await expect(result.locator('.out-text').first()).toContainText(
    'DGDDD AGDDG AFADD FDADV DVFAA DVX',
  );

  await seg(page, 'Cipher', 'ADFGX (5×5)').click();
  // A 36-cell square cannot be a 5 x 5 square: it is read as a keyword, the digits have no cell.
  await expect(result).toContainText('left out');
  await page.locator('#opt-adfgvx-square').fill('ZEBRAS');
  await expect(result).toContainText('I and J share a cell');
  expect(errors).toEqual([]);
});

test('your own coordinate letters name the rows and the columns', async ({ page }) => {
  const errors = await open(page);
  await page.locator('#opt-adfgvx-key').fill('PRIVACY');
  await page.locator('#opt-adfgvx-square').fill(SQUARE);
  await page.locator('.input-text').fill(CIPHER);
  await page.locator('#opt-adfgvx-labels').fill('ABCDE');
  await expect(out(page).locator('.note-error')).toContainText('exactly 6');
  await page.locator('#opt-adfgvx-labels').fill('abcdef');
  await page.locator('.input-text').fill('DGDD DAGD DGAF ADDF DADV DVFA ADVX');
  // The labels are now A B C D E F, so the Wikipedia ciphertext (with D, G, V, X) is in error.
  await expect(out(page).locator('.note-error')).toContainText('not one of the coordinate letters');
  await page.locator('.input-text').fill('ABDB BBAB DBCB');
  await expect(out(page).locator('.note-error')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('an odd number of letters is explained', async ({ page }) => {
  await open(page);
  await page.locator('#opt-adfgvx-key').fill('KEY');
  await page.locator('.input-text').fill('ADFGX');
  await expect(out(page).locator('.note-error')).toContainText('even number');
});

test('the home page suggests the tool for coordinate letters', async ({ page }) => {
  await page.goto('./');
  await page.getByLabel('Paste data to identify').fill(CIPHER);
  await expect(page.locator('.guess').first()).toContainText('ADFGX / ADFGVX');
});
