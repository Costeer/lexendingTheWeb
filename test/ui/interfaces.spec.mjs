import { test, expect, openInterface, scanAccessibility, assertViewportLayout, containFullPageScreenshot } from "./fixtures.mjs";
import { readFile } from "node:fs/promises";

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

for (const surface of ["about", "popup"]) test(`${surface} saves private diagnostics only on request with realistic active-tab state`, async ({ page }, testInfo) => {
  await openInterface(page, `${surface}.html`);
  await page.evaluate((surface) => {
    globalThis.__diagnosticQueries = 0;
    browser.tabs.query = async () => {
      __diagnosticQueries++;
      return [{ id: 7, url: surface === "about" ? location.href : "https://private-diagnostic-sentinel.example/secret" }];
    };
    browser.tabs.sendMessage = async () => {
      if (surface === "about") throw new Error("No content script in the active About tab");
      return {
      ready: true, pending: false, active: true, healthy: false, refreshRevision: 7, scope: "all",
      hostname: "private-diagnostic-sentinel.example", text: "private-diagnostic-sentinel page text",
      error: "private-diagnostic-sentinel runtime error"
      };
    };
    browser.storage.sync.get = async () => ({
      enabled: true, scope: "all", theme: "dark", textScale: 125, lineHeight: 1.7, letterSpacing: .05,
      siteRules: [{ hostname: "private-diagnostic-sentinel.example", enabled: false }],
      previewText: "private-diagnostic-sentinel preview"
    });
  }, surface);
  expect(await page.evaluate(() => __diagnosticQueries)).toBe(0);
  const requested = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save diagnostics" }).click();
  const download = await requested;
  expect(download.suggestedFilename()).toBe("lexend-the-web-diagnostics.json");
  const serialized = await readFile(await download.path(), "utf8");
  expect(serialized).not.toMatch(/private-diagnostic-sentinel|siteRules|hostname|previewText/);
  const report = JSON.parse(serialized);
  expect(report.build.sourceHash).toBe("0123456789abcdef".repeat(4));
  expect(report.settings).toEqual({ status: "available", enabled: true, layoutRepair: false, scope: "all", theme: "dark",
    design: "signal", textScale: 125, lineHeight: 1.7, letterSpacing: .05 });
  expect(report.runtime).toEqual(surface === "about" ? { status: "unavailable" } : {
    status: "available", ready: true, pending: false, healthy: false, active: true,
    refreshRevision: 7, scope: "all", hasError: true });
  expect(await page.evaluate(() => __diagnosticQueries)).toBe(1);
  await expect(page.locator(surface === "about" ? "#diagnostics-status" : "#popup-diagnostics-status"))
    .toHaveText("Diagnostics saved locally. Nothing was sent.");
  await testInfo.attach("diagnostic-export", { body: serialized, contentType: "application/json" });
});

test("popup remains accessible and visually stable", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: testInfo.project.use.isMobile ? 320 : 360, height: 800 });
  await openInterface(page, "popup.html");
  await expect(page.locator("#site-strip")).toBeVisible();
  await scanAccessibility(page, testInfo);
  if (testInfo.project.use.isMobile) await containFullPageScreenshot(page, testInfo);
  await expect(page).toHaveScreenshot("popup.png", { fullPage: true });
  await assertViewportLayout(page, testInfo);
});

test.describe("paper design", () => {
  const design = "paper";
  test.use({ design });

  test(`${design} popup remains accessible, fits and is visually stable`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: testInfo.project.use.isMobile ? 320 : 360, height: 800 });
    await openInterface(page, "popup.html");
    await expect(page.locator("html")).toHaveAttribute("data-design", design);
    await expect(page.locator("#site-strip")).toBeVisible();
    await scanAccessibility(page, testInfo);
    if (testInfo.project.use.isMobile) await containFullPageScreenshot(page, testInfo);
    await expect(page).toHaveScreenshot(`popup-${design}.png`, { fullPage: true });
    await assertViewportLayout(page, testInfo);
  });

  for (const section of ["readability", "rules", "appearance"]) {
    test(`${design} ${section} settings remain accessible and visually stable`, async ({ page }, testInfo) => {
      await openInterface(page, `options.html?section=${section}-panel`);
      await expect(page.locator("html")).toHaveAttribute("data-design", design);
      await scanAccessibility(page, testInfo);
      await assertViewportLayout(page, testInfo);
      await expect(page).toHaveScreenshot(`settings-${section}-${design}.png`, { fullPage: true });
    });
  }
});

test("choosing a design restyles settings immediately and saves it for every page", async ({ page }) => {
  await openInterface(page, "options.html?section=appearance-panel");
  await expect(page.locator("html")).toHaveAttribute("data-design", "signal");
  const radius = () => page.locator(".design-option").first().evaluate((element) => getComputedStyle(element).borderTopLeftRadius);
  // The fixture reseeds storage on navigation, so check what the popup will read.
  const saved = () => page.evaluate(async () => [(await browser.storage.sync.get()).design, localStorage.getItem("lexend-ui-design")]);
  expect(await radius()).toBe("0px");
  await page.locator(".design-option", { hasText: "Paper" }).click();
  await expect(page.locator('input[name="design"][value="paper"]')).toBeChecked();
  await expect(page.locator("html")).toHaveAttribute("data-design", "paper");
  expect(await radius()).toBe("18px");
  await expect.poll(saved).toEqual(["paper", "paper"]);
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator("html")).toHaveAttribute("data-design", "signal");
  expect(await radius()).toBe("0px");
  await expect.poll(saved).toEqual(["signal", "signal"]);
});
