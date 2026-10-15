import { expect, test } from '@playwright/test';

// Base100 through the real UI, beyond the example buttons clicked by tools.spec.ts.

test('encode a flag to emoji, then hand it to Auto-decode, which finds the layer by itself', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('./#/tool/base100');
  await page.locator('.options').getByRole('button', { name: 'encode', exact: true }).click();
  await page.locator('.input-text').fill('flag{emoji_ui}');
  const out = page.locator('.pane-out');
  await expect(out).toContainText('👝👣👘👞👲');
  await out.locator('select.pipe').first().selectOption('auto-decode');
  await expect(page).toHaveURL(/#\/tool\/auto-decode/);
  await expect(page.locator('.pane-out')).toContainText('flag{emoji_ui}');
  await expect(page.locator('.pane-out')).toContainText('Best result · base100');
  expect(errors).toEqual([]);
});

test('text that is not base100 is rejected with its position, or skipped on request', async ({
  page,
}) => {
  await page.goto('./#/tool/base100');
  await page.locator('.input-text').fill('👟👜 oops');
  await expect(page.locator('.pane-out .note-error')).toContainText(
    'Not base100: "o" (U+006F) at position 4',
  );
  await page.locator('.options').getByText('Skip other characters').click();
  await expect(page.locator('.pane-out')).toContainText('he');
  await expect(page.locator('.pane-out')).toContainText('Characters left out: 4');
  await expect(page.locator('.pane-out .note-error')).toHaveCount(0);
});

test('home triage recognises a run of base100 emoji', async ({ page }) => {
  await page.goto('./');
  await page.getByLabel('Paste data to identify').fill('👟👜👣👣👦');
  const first = page.locator('.guess').first();
  await expect(first).toContainText('Base100');
  await first.click();
  await expect(page.locator('.pane-out')).toContainText('hello');
});
