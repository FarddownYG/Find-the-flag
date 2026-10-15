import { expect, test } from '@playwright/test';

// Changing a menu while a text option still has focus used to re-render the options from inside
// their own blur handler, which threw "Failed to execute 'removeChild' on 'Node'".
for (const id of ['symmetric', 'columnar', 'playfair', 'whitespace-lang']) {
  test(`${id}: a menu change while a text option has focus keeps the page working`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`./#/tool/${id}`);
    const texts = page.locator('.options input[type="text"], .options input[type="number"]');
    const selects = page.locator('.options select');
    await expect(selects.first()).toBeVisible();
    const textCount = Math.min(await texts.count(), 3);
    const selectCount = Math.min(await selects.count(), 2);
    for (let t = 0; t < textCount; t++) {
      for (let s = 0; s < selectCount; s++) {
        const text = texts.nth(t);
        const select = selects.nth(s);
        if (!(await text.isVisible()) || !(await select.isVisible())) continue;
        await text.fill((await text.getAttribute('type')) === 'number' ? '3' : 'ABC');
        const values = await select
          .locator('option')
          .evaluateAll((o) => o.map((x) => (x as HTMLOptionElement).value));
        await select.selectOption(values[values.length - 1]!);
      }
    }
    await expect(page.locator('.options')).toBeVisible();
    expect(errors).toEqual([]);
  });
}
