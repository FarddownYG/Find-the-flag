import { expect, test } from '@playwright/test';

// The NATO phonetic alphabet through the real UI, beyond the example buttons clicked by
// tools.spec.ts: the options of both directions, the typo hint and the home triage.

test('encode with the options: common spelling, plain digits, capitals, dashes', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('./#/tool/nato');
  const options = page.locator('.options');
  await options.getByRole('button', { name: 'encode', exact: true }).click();
  await page.locator('.input-text').fill('AJ 349');
  const out = page.locator('.pane-out');
  await expect(out).toContainText('Alfa Juliett / Tree Fower Niner');

  await options.getByRole('button', { name: 'Common (Alpha, Juliet)' }).click();
  await options.getByRole('button', { name: 'Plain (Three, Four, Five, Nine)' }).click();
  await expect(out).toContainText('Alpha Juliet / Three Four Nine');

  await options.getByRole('button', { name: 'UPPER' }).click();
  await options.getByRole('button', { name: 'Dash' }).click();
  await expect(out).toContainText('ALPHA-JULIET / THREE-FOUR-NINE');
  expect(errors).toEqual([]);
});

test('a mistyped word gets a hint with its position, or is marked on request', async ({ page }) => {
  await page.goto('./#/tool/nato');
  await page.locator('.input-text').fill('Alfa Brovo Charlie');
  await expect(page.locator('.pane-out .note-error')).toContainText(
    '"Brovo" at position 6 is not a word of the NATO alphabet (did you mean "Bravo"?)',
  );
  await page.locator('.options').getByRole('button', { name: 'Show ?' }).click();
  await expect(page.locator('.pane-out')).toContainText('A?C');
  await expect(page.locator('.pane-out')).toContainText('Brovo (6)');
  await expect(page.locator('.pane-out .note-error')).toHaveCount(0);
});

test('messy input: mixed case, commas, slashes and run-together words', async ({ page }) => {
  await page.goto('./#/tool/nato');
  await page
    .locator('.input-text')
    .fill('hOtEl,ECHO ; lima-LIMA-oscar / whiskeyoscarromeolimadelta / juliettangoniner');
  await expect(page.locator('.pane-out')).toContainText('HELLO WORLD JT9');
});

test('home triage recognises a spelled message', async ({ page }) => {
  await page.goto('./');
  await page
    .getByLabel('Paste data to identify')
    .fill('Sierra Echo Charlie Romeo Echo Tango Mike Echo Echo Tango India November Golf');
  const first = page.locator('.guess').first();
  await expect(first).toContainText('NATO');
  await first.click();
  await expect(page.locator('.pane-out')).toContainText('SECRETMEETING');
});
