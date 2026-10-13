import { test, expect, openInterface, scanAccessibility } from "./fixtures.mjs";

const saved = (page) => page.evaluate(async () => LexendSettings.normalizeSettings(await browser.storage.sync.get(null)));
const setSettings = (page, settings) => page.evaluate(async (next) => {
  const current = await browser.storage.sync.get(null);
  await browser.storage.sync.set(LexendSettings.normalizeSettings({ ...next, theme: next.theme ?? current.theme }));
}, settings);
const importSettings = (page, settings) => page.locator("#import-file").setInputFiles({
  name: "lexend-settings.json", mimeType: "application/json",
  buffer: Buffer.from(JSON.stringify({ schemaVersion: 2, settings }))
});

test("scope-only rules can change matching and inherit each value independently", async ({ page }, testInfo) => {
  await openInterface(page, "options.html?section=rules-panel");
  await setSettings(page, { siteRules: [
    { hostname: "example.org", includeSubdomains: true, enabled: false, scope: "all" },
    { hostname: "reading.example.org", includeSubdomains: false, enabled: null, scope: "body" }
  ] });
  const row = page.locator('.rule-row[data-hostname="reading.example.org"]');
  await row.locator("summary").focus();
  await page.keyboard.press("Enter");
  await expect(row.locator('select[name="enabled"]')).toHaveValue("inherit");
  await expect(row.locator('select[name="scope"]')).toHaveValue("body");
  await scanAccessibility(page, testInfo);
  await page.screenshot({ path: testInfo.outputPath("rule-editor.png"), fullPage: true });
  await row.locator('select[name="enabled"]').selectOption("true");
  await row.locator('select[name="scope"]').selectOption("inherit");
  await row.locator('select[name="includeSubdomains"]').selectOption("true");
  await row.locator(".rule-editor-save").click();
  await expect.poll(async () => (await saved(page)).siteRules.find((rule) => rule.hostname === "reading.example.org"))
    .toEqual({ hostname: "reading.example.org", includeSubdomains: true, enabled: true, scope: null });
  const effective = await page.evaluate(async () => LexendSettings.resolveSite(await browser.storage.sync.get(null), "reading.example.org"));
  expect(effective.siteEnabled).toBe(true);
  expect(effective.scope).toBe("all");
  expect(effective.scopeRule.hostname).toBe("example.org");
  await row.locator("summary").click();
  await row.locator('select[name="enabled"]').selectOption("inherit");
  await row.locator(".rule-editor-save").click();
  await expect(row).toHaveCount(0);
  const inherited = await page.evaluate(async () => LexendSettings.resolveSite(await browser.storage.sync.get(null), "reading.example.org"));
  expect(inherited.siteEnabled).toBe(false);
  expect(inherited.scope).toBe("all");
});

test("synced Custom values remain selected through basic and advanced keyboard flow", async ({ page }, testInfo) => {
  await openInterface(page, "options.html");
  await setSettings(page, { textScale: 127, lineHeight: 1.73, letterSpacing: .057 });
  for (const [id, name, group] of [
    ["custom-text-scale", /Custom.*127%/i, "basicTextScale"],
    ["custom-line-height", /Custom.*1\.73/i, "basicLineHeight"],
    ["custom-letter-spacing", /Custom.*0\.057\s?em/i, "basicLetterSpacing"]
  ]) {
    await expect(page.locator(`#${id}`)).toBeChecked();
    await expect(page.locator(`#${id}`)).toHaveAccessibleName(name);
    await expect(page.locator(`#${id} + span`)).toHaveCSS("background-color", "rgb(217, 0, 0)");
    await expect(page.locator(`#${id} + span`)).toHaveCSS("color", "rgb(255, 255, 255)");
    await expect(page.locator(`input[name="${group}"]:checked`)).toHaveCount(1);
  }
  const before = await saved(page);
  await scanAccessibility(page, testInfo);
  await page.screenshot({ path: testInfo.outputPath("custom-values.png"), fullPage: true });
  await expect(page.locator("#basic-readability")).toHaveScreenshot("custom-readability.png");
  await page.locator("#adjust-custom-values").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#advanced-mode")).toBeChecked();
  await expect(page.locator("#line-height")).toHaveAttribute("aria-valuetext", "1.73");
  await page.locator("#advanced-mode").focus();
  await page.keyboard.press("Space");
  await expect(page.locator("#custom-line-height")).toBeChecked();
  expect(await saved(page)).toEqual(before);
  await page.locator('label:has(input[name="basicTextScale"][value="110"])').click();
  await expect.poll(async () => (await saved(page)).textScale).toBe(110);
  await expect(page.locator('input[name="basicTextScale"]:checked')).toHaveCount(1);
  expect((await saved(page)).lineHeight).toBe(1.73);
  await page.evaluate(async () => browser.storage.sync.set({ lineHeight: 1 }));
  await page.locator("#advanced-mode").check();
  await page.locator("#line-height").focus();
  await page.keyboard.press("ArrowLeft");
  await expect.poll(async () => (await saved(page)).lineHeight).toBe(0);
  await expect(page.locator("#line-height")).toHaveAttribute("aria-valuetext", "Default");
});

test("import enumerates replacement, cancellation writes nothing, and undo preserves later intent", async ({ page }, testInfo) => {
  await openInterface(page, "options.html?section=tools-panel");
  const before = await saved(page);
  const imported = { ...before, textScale: 127, lineHeight: 1.73, letterSpacing: .057, siteRules: [
    { hostname: "example.com", includeSubdomains: true, enabled: null, scope: "all" },
    { hostname: "new.example.org", includeSubdomains: false, enabled: false, scope: null }
  ] };
  await importSettings(page, imported);
  await expect(page.locator("#import-preview")).toBeVisible();
  for (const value of ["127", "1.73", "0.057", "example.com", "docs.example.com", "news.example.net", "new.example.org"]) {
    await expect(page.locator("#import-preview-list")).toContainText(value);
  }
  expect(await saved(page)).toEqual(before);
  await scanAccessibility(page, testInfo);
  await page.screenshot({ path: testInfo.outputPath("import-preview.png"), fullPage: true });
  await page.locator("#cancel-import").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#import-preview")).toBeHidden();
  expect(await saved(page)).toEqual(before);
  await importSettings(page, imported);
  await page.locator("#apply-import").click();
  await expect(page.locator("#undo-import")).toBeVisible();
  await expect.poll(() => saved(page)).toEqual(imported);
  await page.evaluate(async () => {
    await browser.runtime.sendMessage({ operation: { type: "patch", changes: { textScale: 139 } } });
    await browser.runtime.sendMessage({ operation: { type: "addRule", rule: { hostname: "later.example.org", enabled: false } } });
  });
  await page.locator("#undo-import").click();
  await expect(page.locator("#import-preview")).toBeVisible();
  await page.locator("#apply-import").click();
  await expect.poll(async () => (await saved(page)).lineHeight).toBe(before.lineHeight);
  const restored = await saved(page);
  expect(restored.textScale).toBe(139);
  expect(restored.letterSpacing).toBe(before.letterSpacing);
  expect(restored.siteRules).toEqual(expect.arrayContaining([
    ...before.siteRules,
    { hostname: "later.example.org", includeSubdomains: false, enabled: false, scope: null }
  ]));
  expect(restored.siteRules.some((rule) => rule.hostname === "new.example.org")).toBe(false);
});

test("a preview made before a synced edit cannot overwrite that edit", async ({ page }) => {
  await openInterface(page, "options.html?section=tools-panel");
  const before = await saved(page);
  await importSettings(page, { ...before, textScale: 127 });
  await page.evaluate(async () => browser.storage.sync.set({ textScale: 139 }));
  await page.locator("#apply-import").click();
  await expect(page.locator("#import-error")).not.toBeEmpty();
  expect((await saved(page)).textScale).toBe(139);
});

test("popup identifies the independent winning rules beside global controls", async ({ page }, testInfo) => {
  await openInterface(page, "popup.html");
  await setSettings(page, { scope: "body", letterSpacing: .057, siteRules: [
    { hostname: "example.org", includeSubdomains: true, enabled: false, scope: "all" },
    { hostname: "reading.example.org", includeSubdomains: false, enabled: true, scope: null }
  ] });
  await expect(page.locator('#scope-fieldset input[value="body"]')).toBeChecked();
  await expect(page.locator("#scope-fieldset")).toContainText(/global/i);
  await expect(page.locator("#site-sources")).toContainText("reading.example.org");
  await expect(page.locator("#site-sources")).toContainText("example.org");
  await expect(page.locator("#site-sources")).toContainText(/headings/i);
  await expect(page.locator("#site-sources")).toHaveCSS("white-space", "normal");
  expect(await page.locator("#site-sources").evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await expect(page.locator("#spacing-custom")).toBeChecked();
  await expect(page.locator("#spacing-custom")).toHaveAccessibleName(/Custom.*0\.057\s?em/i);
  await expect(page.locator("#spacing-custom + span")).toHaveCSS("background-color", "rgb(217, 0, 0)");
  await scanAccessibility(page, testInfo);
  await expect(page.locator("#spacing-fieldset")).toHaveScreenshot("custom-popup-spacing.png");
  await page.emulateMedia({ forcedColors: "active" });
  const customPaint = await page.locator("#spacing-custom + span").evaluate((element) => {
    const style = getComputedStyle(element);
    return { color: style.color, background: style.backgroundColor };
  });
  expect(customPaint.background).not.toBe("rgba(0, 0, 0, 0)");
  expect(customPaint.color).not.toBe(customPaint.background);
  await page.emulateMedia({ forcedColors: "none" });
  await page.locator("#use-inherited-site").click();
  await expect.poll(async () => (await saved(page)).siteRules.length).toBe(1);
  await expect(page.locator("#site-sources")).toContainText("example.org");
});
