import { expect, test } from '@playwright/test';
import { createServer } from 'vite';
import type { AnyTool } from '../src/core/types';

// The registry relies on import.meta.glob, so load it through Vite rather than Playwright's loader.
const vite = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent',
});
const { TOOLS } = (await vite.ssrLoadModule('/src/core/registry.ts')) as { TOOLS: AnyTool[] };
await vite.close();

/** Real-browser proof: every example of every tool, clicked through the actual UI. */
for (const tool of TOOLS) {
  test.describe(tool.id, () => {
    for (const ex of tool.examples) {
      test(ex.label, async ({ page }) => {
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(e.message));
        await page.goto(`./#/tool/${tool.id}`);
        await page
          .locator('.examples')
          .getByRole('button', { name: ex.label, exact: true })
          .click();
        const out = page.locator('.pane-out');
        await expect(out).toContainText(ex.expect, { timeout: 15_000 });
        await expect(out.locator('.note-error')).toHaveCount(0);
        expect(errors).toEqual([]);
      });
    }
  });
}

test('home triage suggests Base64 for a base64 string', async ({ page }) => {
  await page.goto('./');
  await page.getByLabel('Paste data to identify').fill('ZmxhZ3t0cmlhZ2V9');
  const first = page.locator('.guess').first();
  await expect(first).toContainText('Base64');
  await first.click();
  await expect(page.locator('.pane-out')).toContainText('flag{triage}');
  await expect(page.locator('.flag-strip')).toContainText('flag{triage}');
});

test('output can be piped to another tool', async ({ page }) => {
  await page.goto('./#/tool/base64');
  await page
    .locator('.examples')
    .getByRole('button', { name: 'Decode a flag', exact: true })
    .click();
  await page.locator('.pane-out select.pipe').first().selectOption('caesar');
  await expect(page).toHaveURL(/#\/tool\/caesar/);
  await expect(page.locator('.input-text')).toHaveValue('flag{base64_is_not_crypto}');
});

test('search finds tools by alias and opens with Enter', async ({ page }) => {
  await page.goto('./');
  await page.keyboard.press('/');
  await page.keyboard.type('rot13');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#\/tool\/caesar/);
});

test('typing a number option keeps focus and the value when tabbing away', async ({ page }) => {
  await page.goto('./#/tool/caesar');
  await page.locator('.options').getByRole('button', { name: 'Fixed shift' }).click();
  const shift = page.locator('.options input[type=number]');
  await shift.fill('5');
  await shift.press('Tab');
  await expect(shift).toHaveValue('5');
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('BODY');
});
