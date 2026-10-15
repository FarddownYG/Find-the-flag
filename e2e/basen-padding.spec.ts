import { expect, test } from '@playwright/test';

// The base64 / base32 padding tool through the real UI: the encoder, the extractor reading what
// the encoder wrote, and the one-click "decode again" that makes a layer's payload the next input.
// (The examples of the tool are clicked by tools.spec.ts like every other tool's.)

const LAYERS = 'Two layers: base32 lines hidden in base64 lines';

test('hide a message, then read it back from the lines the encoder wrote', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('./#/tool/basen-padding');
  await page
    .locator('.examples')
    .getByRole('button', { name: 'Hide a message in your own lines', exact: true })
    .click();
  const out = page.locator('.pane-out');
  await expect(out).toContainText('Capacity used: 72 of 72 bits (100 %)');
  await expect(out).toContainText('Round trip: OK');

  const lines = await out.locator('section.out-text pre.out-pre').first().innerText();
  expect(lines.split('\n')).toHaveLength(18);
  await page.locator('.options').getByRole('button', { name: 'Extract', exact: true }).click();
  await page.locator('.input-text').fill(lines);
  await expect(out).toContainText('Hidden bits: 72 bits from 18 lines');
  await expect(out.locator('.out-text').filter({ hasText: 'hidden payload (text)' })).toContainText(
    'HIDDEN_OK',
  );
  await expect(out.locator('.note-error')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('the layers example reads both layers, and Decode again goes one layer further', async ({
  page,
}) => {
  await page.goto('./#/tool/basen-padding');
  await page.locator('.examples').getByRole('button', { name: LAYERS, exact: true }).click();
  const out = page.locator('.pane-out');
  await expect(out).toContainText('Layer 1: summary');
  await expect(out).toContainText('Layer 2: summary');
  await expect(out).toContainText('LAYERED_OK');
  await expect(out).toContainText('Stopped after layer 2');

  // One layer only: the tool says it stopped at the limit and offers the next step.
  await page.locator('.options input[type=number]').first().fill('1');
  await expect(out).toContainText('Stopped at the limit of 1 layer');
  await expect(out).not.toContainText('Layer 2: summary');
  await out.getByRole('button', { name: 'Decode this payload again (layer 2)' }).click();
  await expect(out).toContainText('Starting at layer 2');
  await expect(out).toContainText('Layer 2: summary');
  await expect(out).toContainText('LAYERED_OK');
  await expect(page.locator('.options input[type=number]').nth(1)).toHaveValue('2');

  await out.getByRole('button', { name: 'Back to the original input' }).click();
  await expect(out).toContainText('Layer 1: summary');
});

test('a missing capacity is explained with the exact numbers', async ({ page }) => {
  await page.goto('./#/tool/basen-padding');
  await page
    .locator('.options')
    .getByRole('button', { name: 'Hide a message', exact: true })
    .click();
  await page.getByLabel('Message to hide').fill('HIDDEN_OK');
  await page.locator('.input-text').fill(Array.from({ length: 20 }, () => 'ab').join('\n'));
  await expect(page.locator('.pane-out .note-error')).toContainText(
    'The message needs 72 bits but these 20 lines carry 40: add lines or use lines whose length is not a multiple of 3.',
  );
});
