import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

// Real user path: drop an PDF with a PNG appended after %%EOF on the home entry (no tool chosen); the flag must surface.
// Fixtures come from the independent encoder in bench/pdf/.
const dir = (name: string) =>
  fileURLToPath(new URL(`../bench/pdf/corpus/${name}`, import.meta.url));
const manifest = JSON.parse(readFileSync(dir('manifest.json'), 'utf8')) as {
  file: string;
  secret: string;
}[];

for (const { file, secret } of manifest) {
  test(`uploaded: ${file} reveals "${secret}"`, async ({ page }) => {
    await page.goto('./');
    await page.locator('input[type=file]').first().setInputFiles(dir(file));
    await expect(page.locator('.analysis-slot')).toContainText(secret, { timeout: 30000 });
  });
}
