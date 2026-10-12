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
