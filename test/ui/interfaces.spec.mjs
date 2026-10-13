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
  // Capture the mobile page inside its viewport. Chromium's beyond-viewport
  // capture can temporarily apply the desktop popup's intrinsic sizing.
  if (testInfo.project.use.isMobile) {
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.setViewportSize({ width: 320, height });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  }
  await expect(page).toHaveScreenshot("popup.png", { fullPage: !testInfo.project.use.isMobile });
});

test("layout controls save the default and an independent site choice with keyboard support", async ({page}) => {
  await openInterface(page,"options.html");
  await page.locator('#layout-mode input[value="fit"]').check();
  await expect(page.locator('#layout-mode-description')).toContainText("Keep boxes in place");
  await page.locator('#layout-mode input:checked').focus();
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('#layout-mode input[value="gentle"]')).toBeChecked();
  await openInterface(page,"popup.html");
  await page.locator('#site-layout-mode input[value="fit"]').check();
  await expect(page.locator('#site-layout-mode input[value="fit"]')).toBeChecked();
  await expect(page.locator('#site-layout-mode-note')).toContainText('Saved for this site');
  await page.locator('#site-layout-mode input[value="default"]').check();
  await expect(page.locator('#site-layout-mode input[value="default"]')).toBeChecked();
});

test("site rules create and edit layouts, preserve pauses, and retain keyboard focus", async ({ page }) => {
  await openInterface(page, "options.html?section=rules-panel");
  await page.locator('#new-hostname').fill('a-layout.example.org');
  await expect(page.locator('#add-rule-button')).toBeDisabled();
  await page.locator('#new-subdomains').check();
  await page.locator('#new-rule-layout input[value="gentle"]').check();
  await page.locator('#add-rule-button').click();
  const rule = page.locator('[data-hostname="a-layout.example.org"][data-subdomains="true"]');
  const layout = rule.locator('[data-field="layoutMode"]');
  const state = rule.locator('[data-field="enabled"]');
  const saved = () => page.evaluate(async () => (await browser.storage.sync.get(null)).siteRules
    .find(rule => rule.hostname === 'a-layout.example.org'));
  await expect(layout.locator('input[value="gentle"]')).toBeChecked();
  await expect.poll(saved).toMatchObject({ enabled: null, includeSubdomains: true, layoutMode: 'gentle' });
  await expect(page.locator('#new-rule-layout input[value="default"]')).toBeChecked();
  await layout.locator('input:checked').focus();
  await page.keyboard.press('ArrowDown');
  await expect.poll(saved).toMatchObject({ layoutMode: 'fit' });
  await expect(layout.locator('input:checked')).toBeFocused();
  await state.selectOption('paused');
  await expect.poll(saved).toMatchObject({ enabled: false, layoutMode: 'fit' });
  await layout.locator('input[value="default"]').check();
  await expect.poll(saved).toEqual({ hostname: 'a-layout.example.org', includeSubdomains: true, enabled: false, scope: null });
  await expect(state).toHaveValue('paused');
  await state.focus();
  await state.selectOption('default');
  await expect.poll(saved).toBeUndefined();
  await expect(rule).toHaveCount(0);
  await expect(page.locator('#new-hostname')).toBeFocused();
});

test("layout pickers explain inherited modes and paused choices, including subdomain rules", async ({ page }) => {
  await openInterface(page, "options.html?section=rules-panel");
  await page.evaluate(() => browser.storage.sync.set({ layoutMode: 'gentle', siteRules: [
    { hostname: 'example.org', includeSubdomains: true, enabled: false, layoutMode: 'fit' },
    { hostname: 'docs.example.org', includeSubdomains: false, enabled: true, layoutMode: 'off' },
    { hostname: 'docs.example.org', includeSubdomains: true, enabled: true }
  ] }));
  const rule = page.locator('[data-hostname="docs.example.org"][data-subdomains="true"]');
  const picker = rule.locator('.layout-picker');
  await expect(picker.locator('.layout-inherit')).toContainText('Fit text');
  await expect(picker.locator('.layout-explanation')).toContainText('the rule for example.org and its subdomains');
  await page.locator('#new-hostname').fill('child.example.org');
  await expect(page.locator('#new-rule-layout .layout-inherit')).toContainText('Fit text');
  await expect(page.locator('#new-rule-layout-note')).toContainText('Lexend is paused');
  await page.locator('#new-rule-enabled').selectOption('on');
  await expect(page.locator('#new-rule-layout-note')).toBeHidden();
  await page.evaluate(() => browser.storage.sync.set({ enabled: false }));
  await expect(picker.locator('.layout-note')).toContainText('Lexend is paused');
  await expect(page.locator('#new-rule-layout-note')).toContainText('Lexend is paused');
  await page.evaluate(() => browser.storage.sync.set({ enabled: true, layoutMode: 'off', siteRules: [
    { hostname: 'docs.example.org', includeSubdomains: true, enabled: true }
  ] }));
  await expect(picker.locator('.layout-inherit')).toContainText('Off');
  await expect(picker.locator('.layout-explanation')).toContainText('your global default');
});

test("popup layout selection survives slow saves, restores failed choices, and disables restricted pages", async ({ page }, testInfo) => {
  // Desktop toolbar popups use their intrinsic 360px width. Touch surfaces
  // are responsive and must also fit the narrower 320px viewport.
  await page.setViewportSize({ width: testInfo.project.use.isMobile ? 320 : 360, height: 600 });
  await openInterface(page, "popup.html");
  const picker = page.locator('#site-layout-mode');
  await page.evaluate(() => {
    const send = browser.runtime.sendMessage;
    globalThis.saveLayout = send;
    globalThis.releaseLayoutSave = null;
    browser.runtime.sendMessage = async message => {
      await new Promise(resolve => { globalThis.releaseLayoutSave = resolve; });
      return send(message);
    };
  });
  await picker.locator('input[value="gentle"]').check();
  await expect(picker.locator('input[value="gentle"]')).toBeChecked();
  await expect(picker.locator('.layout-note')).toHaveText('Saving layout choice…');
  await page.evaluate(() => releaseLayoutSave());
  await expect(picker.locator('.layout-note')).toContainText('Saved for this site');
  await page.evaluate(() => { browser.runtime.sendMessage = async () => ({ ok: false, message: 'Storage unavailable' }); });
  await picker.locator('input[value="fit"]').click();
  await expect(picker.locator('input[value="gentle"]')).toBeChecked();
  await expect(page.locator('#popup-feedback')).toContainText('Storage unavailable');
  await page.evaluate(() => { browser.runtime.sendMessage = saveLayout; });
  await picker.locator('input[value="off"]').check();
  await expect(page.locator('#popup-feedback')).toBeEmpty();
  await picker.locator('input:checked').focus();
  await page.keyboard.press('Tab');
  await expect(page.locator('input[name="scope"]:checked')).toBeFocused();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.addInitScript(() => {
    browser.tabs.query = async () => [{ id: 1, url: 'chrome://settings' }];
    browser.tabs.sendMessage = async () => { throw new Error('Restricted'); };
  });
  await openInterface(page, 'popup.html');
  await expect(picker.locator('input[value="off"]')).toBeDisabled();
  await expect(picker.locator('.layout-note')).toContainText('Open a website');
});
