import { expect, test } from '@playwright/test';

// The sidebar search through the real UI: the words people type for a base or a conversion find
// the right tool first, a digit after "base" is the whole number, accents do not matter. The
// ranking itself is tested in src/ui/search.test.ts.

test.describe('the sidebar search finds it for the words people type', () => {
  for (const [query, first] of [
    ['octal', 'Binary / Octal / Decimal / Hex'],
    ['base 8', 'Binary / Octal / Decimal / Hex'],
    ['décimal', 'Binary / Octal / Decimal / Hex'],
    ['conversion', 'Binary / Octal / Decimal / Hex'],
    ['binaire', 'Binary (0/1)'],
    ['hexa', 'Hex'],
  ] as const) {
    test(`"${query}"`, async ({ page }) => {
      await page.goto('./');
      await page.getByPlaceholder('Search tools').fill(query);
      const links = page.locator('nav a');
      await expect(links.first()).toHaveText(first);
      await expect(page.locator('nav a', { hasText: 'Binary / Octal' })).toHaveCount(1);
    });
  }

  test('"base 8" does not bring up Base32, Base58 or Base85', async ({ page }) => {
    await page.goto('./');
    await page.getByPlaceholder('Search tools').fill('base 8');
    const names = await page.locator('nav a').allTextContents();
    expect(names).toEqual(['Binary / Octal / Decimal / Hex', 'Number / base converter']);
  });

  test('Enter opens the first result', async ({ page }) => {
    await page.goto('./');
    await page.keyboard.press('/');
    await page.keyboard.type('octal');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#\/tool\/base-convert/);
  });
});

test('French interface: a French query finds the tool under its French name', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('ftf.locale', 'fr'));
  await page.goto('./');
  await page.getByPlaceholder('Chercher un outil').fill('décimal');
  await expect(page.locator('nav a').first()).toHaveText('Binaire / Octal / Décimal / Hexa');
  await page.getByPlaceholder('Chercher un outil').fill('base 8');
  await expect(page.locator('nav a')).toHaveCount(2);
});
