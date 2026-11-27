import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

// The real user path: drop variation-selector-smuggled text on the home entry (no tool chosen) and
// the hidden bytes must surface. Fixtures come from the independent encoder in bench/.
const dir = (name: string) =>
  fileURLToPath(new URL(`../bench/variation-selectors/corpus/${name}`, import.meta.url));
const manifest = JSON.parse(readFileSync(dir('manifest.json'), 'utf8')) as {
  file: string;
  secret: string;
}[];

// KO documentés dans bench/RESULTS.md : 06-low-bytes porte des octets de contrôle (pas du texte
// lisible, donc non remonté comme message) ; 08-short ne porte que « ok » (2 car, sous le seuil de
// confiance anti-faux-positif). Cas-limites bornés, non régressifs.
const KO = new Set(['06-low-bytes.txt', '08-short.txt']);

for (const { file, secret } of manifest.filter((m) => !KO.has(m.file))) {
  test(`pasted: ${file} reveals "${secret}"`, async ({ page }) => {
    await page.goto('./');
    await page.locator('.triage-input').fill(readFileSync(dir(file), 'utf8'));
    await expect(page.locator('.analysis-slot')).toContainText(secret, { timeout: 30000 });
  });
}

test('uploaded file reveals the secret', async ({ page }) => {
  const { file, secret } = manifest[0]!;
  await page.goto('./');
  await page.locator('input[type=file]').first().setInputFiles(dir(file));
  await expect(page.locator('.analysis-slot')).toContainText(secret, { timeout: 30000 });
});
