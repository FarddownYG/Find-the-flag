import { expect, test } from '@playwright/test';

// Bubble Babble through the real UI, beyond the example buttons clicked by tools.spec.ts.

const SPEC = 'xesef-disof-gytuf-katof-movif-baxux'; // "1234567890", from the specification

test('a damaged string is refused with the group and positions, then read on request', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('./#/tool/bubblebabble');
  await page.locator('.input-text').fill(SPEC);
  await expect(page.locator('.pane-out')).toContainText('1234567890');

  await page.locator('.input-text').fill('xesef-disof-gytuf-katof-movif-baxax');
  await expect(page.locator('.pane-out .note-error')).toContainText(
    'Checksum error: group 6 (positions 32–34)',
  );
  await page.locator('.options').getByText('Ignore checksum errors').click();
  await expect(page.locator('.pane-out')).toContainText('1234567890');
  await expect(page.locator('.pane-out')).toContainText('Checksum does not match in group 6');
  await expect(page.locator('.pane-out .note-error')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('encode text, then decode what was written', async ({ page }) => {
  await page.goto('./#/tool/bubblebabble');
  await page.locator('.options').getByRole('button', { name: 'encode', exact: true }).click();
  await page.locator('.input-text').fill('Pineapple');
  const out = page.locator('.pane-out');
  await expect(out).toContainText('xigak-nyryk-humil-bosek-sonax');
  await out.locator('select.pipe').first().selectOption('auto-decode');
  await expect(page).toHaveURL(/#\/tool\/auto-decode/);
  await expect(page.locator('.pane-out')).toContainText('Best result · bubblebabble');
  await expect(page.locator('.pane-out')).toContainText('Pineapple');
});

test('home triage recognises an OpenSSH-style fingerprint', async ({ page }) => {
  await page.goto('./');
  await page.getByLabel('Paste data to identify').fill(SPEC);
  const first = page.locator('.guess').first();
  await expect(first).toContainText('Bubble Babble');
  await first.click();
  await expect(page.locator('.pane-out')).toContainText('1234567890');
});
