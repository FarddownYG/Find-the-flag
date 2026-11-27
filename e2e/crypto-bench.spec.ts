import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

// User path: paste an encoded text chain into the home entry (no tool chosen); the clear flag must
// surface. Fixtures come from the independent reference encoder (bench/crypto).
const path = (n: string) => fileURLToPath(new URL(`../bench/crypto/corpus/${n}`, import.meta.url));
const manifest: { file: string; secret: string }[] = JSON.parse(
  readFileSync(path('manifest.json'), 'utf8'),
);

for (const { file, secret } of manifest) {
  test(`pasted encoding chain is unrolled: ${file}`, async ({ page }) => {
    await page.goto('./');
    await page.locator('.triage-input').fill(readFileSync(path(file), 'utf8'));
    await expect(page.locator('.analysis-slot')).toContainText(secret, { timeout: 30000 });
  });
}
