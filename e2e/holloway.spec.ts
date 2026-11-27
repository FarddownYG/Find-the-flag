import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

// The real user path: paste Holloway homoglyph text into the home entry (no tool chosen) and the
// hidden message must surface. Fixture is encoded by the independent reference encoder (bench).
const corpus = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../bench/holloway/corpus/${name}`, import.meta.url)), 'utf8');

test('a pasted homoglyph message is decoded from the home entry', async ({ page }) => {
  await page.goto('./');
  const text = corpus('01-tweet-weather.txt'); // secret: ftf_homoglyph_1
  await page.locator('.triage-input').fill(text);
  await expect(page.locator('.analysis-slot')).toContainText('ftf_homoglyph_1', { timeout: 30000 });
});
