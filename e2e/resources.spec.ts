import { expect, test } from '@playwright/test';

test.describe('resources directory', () => {
  test('lists every entry, filters, searches and shows an empty state', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('./#/resources');

    const cards = page.locator('.res-card');
    await expect(cards).toHaveCount(63);
    await expect(page.locator('.res-count')).toContainText('63');

    // Every link opens in a new tab and is a real external URL.
    const first = page.locator('.res-link').first();
    await expect(first).toHaveAttribute('target', '_blank');
    await expect(first).toHaveAttribute('rel', /noopener/);
    await expect(first).toHaveAttribute('href', /^https?:\/\//);

    // Category filter narrows the list.
    await page.selectOption('select[aria-label="Category"]', 'crypto');
    await expect(cards).toHaveCount(20);

    // Type filter composes with it; reset category first.
    await page.selectOption('select[aria-label="Category"]', '');
    await page.selectOption('select[aria-label="Type"]', 'train');
    await expect(cards.first()).toBeVisible();
    const trainCount = await cards.count();
    expect(trainCount).toBeGreaterThan(0);
    expect(trainCount).toBeLessThan(63);

    // Search with no match shows the empty state.
    await page.selectOption('select[aria-label="Type"]', '');
    await page.fill('.res-search', 'zzzznomatch');
    await expect(page.locator('.empty')).toBeVisible();
    await expect(cards).toHaveCount(0);

    expect(errors).toEqual([]);
  });

  test('is reachable from the sidebar link', async ({ page }) => {
    await page.goto('./');
    await page.locator('.sidebar .side-link[href="#/resources"]').click();
    await expect(page).toHaveURL(/#\/resources$/);
    await expect(page.locator('.res-title')).toBeVisible();
  });
});
