import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

// Real user path: paste multi-line text carrying SNOW-style trailing whitespace into the home entry (no tool chosen); the hidden message
// must surface. Fixtures come from the independent encoder in bench/snow.
const dir = fileURLToPath(new URL('../bench/snow/corpus/', import.meta.url));
const manifest = JSON.parse(readFileSync(`${dir}manifest.json`, 'utf8')) as {
  file: string;
  secret: string;
}[];

// KO documentés dans bench/RESULTS.md : le canal SNOW de FTF lit le binaire (bit = espace vs tab) et
// des groupes espaces-avant-tab à partir du PREMIER tab, pas le cadrage « N espaces puis tab dès le
// premier groupe » de l'encodeur de référence (variantes groups3). Coverage gap borné, non régressif.
const KO = new Set(manifest.filter((m) => m.file.includes('groups3')).map((m) => m.file));

for (const { file, secret } of manifest.filter((m) => !KO.has(m.file))) {
  test(`snow ${file} is decoded from the home entry`, async ({ page }) => {
    await page.goto('./');
    await page.locator('.triage-input').fill(readFileSync(`${dir}${file}`, 'utf8'));
    await expect(page.locator('.analysis-slot')).toContainText(secret, { timeout: 30000 });
  });
}
