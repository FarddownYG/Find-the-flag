import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

// Real user path: paste Bidi-override text (RLO/LRO/PDF) into the home entry (no tool chosen); the
// logical-order secret must surface. Fixtures come from the independent encoder in bench/bidi.
const dir = fileURLToPath(new URL('../bench/bidi/corpus/', import.meta.url));
const manifest = JSON.parse(readFileSync(`${dir}manifest.json`, 'utf8')) as {
  file: string;
  secret: string;
}[];

for (const { file, secret } of manifest) {
  test(`bidi ${file} is decoded from the home entry`, async ({ page }) => {
    await page.goto('./');
    await page.locator('.triage-input').fill(readFileSync(`${dir}${file}`, 'utf8'));
    await expect(page.locator('.analysis-slot')).toContainText(secret, { timeout: 30000 });
  });
}
