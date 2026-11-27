import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

// Real user path: paste Unicode-Tags text into the home entry (no tool chosen); the hidden message
// must surface. Fixtures come from the independent encoder in bench/unicode-tags.
const dir = fileURLToPath(new URL('../bench/unicode-tags/corpus/', import.meta.url));
const manifest = JSON.parse(readFileSync(`${dir}manifest.json`, 'utf8')) as {
  file: string;
  secret: string;
}[];

for (const { file, secret } of manifest) {
  test(`unicode tags ${file} is decoded from the home entry`, async ({ page }) => {
    await page.goto('./');
    await page.locator('.triage-input').fill(readFileSync(`${dir}${file}`, 'utf8'));
    await expect(page.locator('.analysis-slot')).toContainText(secret, { timeout: 30000 });
  });
}
