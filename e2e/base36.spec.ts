import { expect, test } from '@playwright/test';

// Base36 / Base26 through the real UI, beyond the example buttons clicked by tools.spec.ts.

test('numbers: base36 to decimal in a table, and back', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('./#/tool/base36');
  await page.locator('#opt-base36-format').selectOption('base36-numbers');
  await page.locator('.input-text').fill('zz 1k8 10');
  const out = page.locator('.pane-out');
  await expect(out).toContainText('1295 2024 36');
  await expect(out.locator('table')).toContainText('07e8');

  await page.locator('.options').getByRole('button', { name: 'encode', exact: true }).click();
  await page.locator('.input-text').fill('2024, 1295 0x10');
  await expect(out).toContainText('1k8 zz g');
  await page.locator('.options').getByText('Upper case output').click();
  await expect(out).toContainText('1K8 ZZ G');
  expect(errors).toEqual([]);
});

test('a wrong digit is reported with its position, spreadsheet columns have no zero', async ({
  page,
}) => {
  await page.goto('./#/tool/base36');
  await page.locator('.input-text').fill('5pz-szu7');
  await expect(page.locator('.pane-out .note-error')).toContainText(
    'Not Base36: "-" at position 4 is not in the alphabet',
  );
  await page.locator('#opt-base36-format').selectOption('excel');
  await page.locator('.options').getByRole('button', { name: 'encode', exact: true }).click();
  await page.locator('.input-text').fill('0');
  await expect(page.locator('.pane-out .note-error')).toContainText('has no name');
  await page.locator('.input-text').fill('16384');
  await expect(page.locator('.pane-out')).toContainText('XFD');
});

test('a flag written as a big base36 integer is decoded by Auto-decode too', async ({ page }) => {
  await page.goto('./#/tool/auto-decode');
  await page.locator('.input-text').fill('1okh233vdr1fz2nano6oob99ewq1z1');
  await page.locator('.btn-run').click();
  await expect(page.locator('.pane-out')).toContainText('flag{base36_bigint}');
  await expect(page.locator('.pane-out')).toContainText('Best result · base36');
});

test('home triage suggests Base36 for a base36 string that reads as text', async ({ page }) => {
  await page.goto('./');
  await page.getByLabel('Paste data to identify').fill('1okh233vdr1fz2nano6oob99ewq1z1');
  await expect(page.locator('.guess').first()).toContainText('Base36');
});
