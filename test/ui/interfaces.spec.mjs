import { test, expect, openInterface, scanAccessibility } from "./fixtures.mjs";

for (const section of ["readability", "rules", "appearance", "tools"]) {
  test(`${section} settings remain accessible and visually stable`, async ({ page }, testInfo) => {
    await openInterface(page, `options.html?section=${section}-panel`);
    await scanAccessibility(page, testInfo);
    await expect(page).toHaveScreenshot(`settings-${section}.png`, { fullPage: true });
  });
}

test("advanced readability controls remain accessible and visually stable", async ({ page }, testInfo) => {
  await openInterface(page, "options.html");
  await page.locator("#advanced-mode").check();
  await expect(page.locator("#text-scale")).toBeVisible();
  await page.locator("#advanced-mode").blur();
  await scanAccessibility(page, testInfo);
  await expect(page).toHaveScreenshot("settings-advanced.png", { fullPage: true });
});

test("rule deletion confirmation remains accessible and restores keyboard focus", async ({ page }, testInfo) => {
  await openInterface(page, "options.html?section=rules-panel");
  const row = page.locator('[data-hostname="example.com"]');
  const remove = row.locator('[data-action="delete"]');
  await remove.focus();
  await page.keyboard.press("Enter");
  await expect(row.locator('[data-action="confirm"]')).toBeVisible();
  await scanAccessibility(page, testInfo);
  await expect(page).toHaveScreenshot("rule-confirmation.png", { fullPage: true });
  await page.keyboard.press("Escape");
  await expect(row.locator('[data-action="confirm"]')).toHaveCount(0);
  await expect(remove).toBeFocused();
  await page.keyboard.press("Enter");
  await row.locator('[data-action="confirm"]').focus();
  await page.keyboard.press("Enter");
  await expect(row).toHaveCount(0);
  await expect(page.locator('[data-hostname="news.example.net"] .delete-rule')).toBeFocused();
});

test("About remains accessible and visually stable", async ({ page }, testInfo) => {
  await openInterface(page, "about.html");
  await scanAccessibility(page, testInfo);
  await expect(page).toHaveScreenshot("about.png", { fullPage: true });
});

test("popup remains accessible and visually stable", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: testInfo.project.use.isMobile ? 320 : 360, height: 800 });
  await openInterface(page, "popup.html");
  await expect(page.locator("#site-strip")).toBeVisible();
  await scanAccessibility(page, testInfo);
  await expect(page).toHaveScreenshot("popup.png", { fullPage: true });
});

test("layout controls save the default and an independent site choice with keyboard support", async ({page}) => {
  await openInterface(page,"options.html");
  await page.locator('#layout-mode').selectOption('fit');
  await expect(page.locator('#layout-mode-description')).toContainText("Keep boxes in place");
  await page.locator('#layout-mode').focus();
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('#layout-mode')).toHaveValue('gentle');
  await openInterface(page,"popup.html");
  await page.locator('#site-layout-mode').selectOption('fit');
  await expect(page.locator('#site-layout-mode')).toHaveValue('fit');
  await expect(page.locator('#site-layout-description')).toContainText('Saved for this site');
  await page.locator('#site-layout-mode').selectOption('default');
  await expect(page.locator('#site-layout-mode')).toHaveValue('default');
});

test("site rules create and edit layouts, preserve pauses, and retain keyboard focus", async ({ page }) => {
  await openInterface(page, "options.html?section=rules-panel");
  await page.locator('#new-hostname').fill('a-layout.example.org');
  await expect(page.locator('#add-rule-button')).toBeDisabled();
  await page.locator('#new-subdomains').check();
  await page.locator('#new-rule-layout').selectOption('gentle');
  await page.locator('#add-rule-button').click();
  const rule = page.locator('[data-hostname="a-layout.example.org"][data-subdomains="true"]');
  const layout = rule.locator('[data-field="layoutMode"]');
  const state = rule.locator('[data-field="enabled"]');
  const saved = () => page.evaluate(async () => (await browser.storage.sync.get(null)).siteRules
    .find(rule => rule.hostname === 'a-layout.example.org'));
  await expect(layout).toHaveValue('gentle');
  await expect.poll(saved).toMatchObject({ enabled: null, includeSubdomains: true, layoutMode: 'gentle' });
  await expect(page.locator('#new-rule-layout')).toHaveValue('default');
  await layout.focus();
  await page.keyboard.press('ArrowDown');
  await expect.poll(saved).toMatchObject({ layoutMode: 'fit' });
  await expect(layout).toBeFocused();
  await state.selectOption('paused');
  await expect.poll(saved).toMatchObject({ enabled: false, layoutMode: 'fit' });
  await layout.selectOption('default');
  await expect.poll(saved).toEqual({ hostname: 'a-layout.example.org', includeSubdomains: true, enabled: false, scope: null });
  await expect(state).toHaveValue('paused');
  await state.focus();
  await state.selectOption('default');
  await expect.poll(saved).toBeUndefined();
  await expect(rule).toHaveCount(0);
  await expect(page.locator('#new-hostname')).toBeFocused();
});
