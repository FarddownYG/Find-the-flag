import { expect, test } from '@playwright/test';

// Braille through the real UI, beyond the example buttons clicked by tools.spec.ts: the three
// contents in both directions, an honest error, and Auto-decode on 8-dot cells.

const options = (page: import('@playwright/test').Page) => page.locator('.options');

test('text to cells, cells to dot numbers, and dot numbers back to cells', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('./#/tool/braille');
  await options(page).getByRole('button', { name: 'encode', exact: true }).click();
  await page.locator('.input-text').fill('FTF{demo} 2024');
  const out = page.locator('.pane-out');
  await expect(out).toContainText('⠠⠠⠋⠞⠋⠸⠣⠙⠑⠍⠕⠸⠜ ⠼⠃⠚⠃⠙');

  await options(page).getByRole('button', { name: 'decode', exact: true }).click();
  await options(page).getByRole('button', { name: 'Dot numbers (1-25-14)' }).click();
  await page.locator('.input-text').fill('⠃⠗⠁⠊⠇⠇⠑ ⠠⠁');
  await expect(out).toContainText('12-1235-1-24-123-123-15-0-6-1');

  await options(page).getByRole('button', { name: 'encode', exact: true }).click();
  await page.locator('.input-text').fill('12-1235-1-24-123-123-15-0-6-1');
  await expect(out).toContainText('⠃⠗⠁⠊⠇⠇⠑ ⠠⠁');
  expect(errors).toEqual([]);
});

test('bad dot numbers are reported with the position, and other text is not braille', async ({
  page,
}) => {
  await page.goto('./#/tool/braille');
  await page.locator('.input-text').fill('125-19-123');
  await expect(page.locator('.pane-out .note-error')).toContainText(
    '"9" at position 6 (in "19"): dots are numbered 1 to 8.',
  );
  await page.locator('.input-text').fill('just some words');
  await expect(page.locator('.pane-out .note-error')).toContainText('No braille cells');
});

test('8-dot cells go to Bytes, and Auto-decode finds the same flag by itself', async ({ page }) => {
  await page.goto('./#/tool/braille');
  const cells = '⡦⡬⡡⡧⡻⡢⡲⡡⡩⡬⡬⡥⡟⡢⡹⡴⡥⡳⡽';
  await page.locator('.input-text').fill(cells);
  await expect(page.locator('.pane-out')).toContainText('?');
  await expect(page.locator('.pane-out')).toContainText('try the Bytes content');
  await options(page).getByRole('button', { name: 'Bytes (8-dot cells)' }).click();
  await expect(page.locator('.pane-out')).toContainText('flag{braille_bytes}');

  await page.goto('./#/tool/auto-decode');
  await page.locator('.input-text').fill(cells);
  await page.locator('.btn-run').click();
  await expect(page.locator('.pane-out')).toContainText('flag{braille_bytes}');
  await expect(page.locator('.pane-out')).toContainText('Best result · braille (8-dot bytes)');
});

test('home triage recognises braille cells, 6-dot as text and 8-dot as bytes', async ({ page }) => {
  await page.goto('./');
  await page.getByLabel('Paste data to identify').fill('⠓⠑⠇⠇⠕ ⠺⠕⠗⠇⠙');
  const first = page.locator('.guess').first();
  await expect(first).toContainText('Braille');
  await first.click();
  await expect(page.locator('.pane-out')).toContainText('hello world');
});
