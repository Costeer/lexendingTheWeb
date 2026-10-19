import { test as base, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// Only browser APIs are simulated here. The HTML, CSS, scripts, preferences
// writer and fonts come from the packaged build; Selenium covers real APIs.
export const test = base.extend({
  page: async ({ page }, use, testInfo) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("response", (response) => {
      if (response.url().startsWith("http://127.0.0.1:4173/") && response.status() >= 400) {
        errors.push(`${response.status()} ${response.url()}`);
      }
    });
    // Build hashes change with any packaged source edit. Keep only that value
    // fixed for visual comparisons; exercise the real generated schema/asset.
    await page.route("**/build-identity.json", async (route) => {
      const response = await route.fetch();
      const identity = await response.json();
      expect(identity.schemaVersion).toBe(1);
      expect(identity.target).toBe("chrome");
      expect(identity.sourceHash).toMatch(/^[a-f0-9]{64}$/);
      await route.fulfill({ response, json: { ...identity, sourceHash: "0123456789abcdef".repeat(4) } });
    });
    await page.addInitScript(({ theme }) => {
      Math.random = () => 0;
      localStorage.removeItem("lexendLastQuoteIndex");
      localStorage.setItem("lexend-ui-theme", theme);
      let settings = {
        enabled: true, scope: "body", theme, textScale: 110, lineHeight: 1.6, letterSpacing: .04,
        siteRules: [
          { hostname: "example.com", includeSubdomains: true, enabled: false, scope: null },
          { hostname: "docs.example.com", includeSubdomains: false, enabled: true, scope: "all" },
          { hostname: "news.example.net", includeSubdomains: false, enabled: false, scope: null }
        ]
      };
      const listeners = [];
      const sync = {
        get: async () => structuredClone(settings),
        set: async (patch) => {
          const changes = Object.fromEntries(Object.entries(patch).map(([key, newValue]) =>
            [key, { oldValue: settings[key], newValue }]));
          settings = { ...settings, ...structuredClone(patch) };
          listeners.forEach((listener) => listener(changes, "sync"));
        },
        remove: async () => {}
      };
      let store;
      globalThis.browser = {
        storage: { sync, local: { get: async () => ({}), set: async () => {} },
          onChanged: { addListener: (listener) => listeners.push(listener) } },
        runtime: {
          getURL: (path) => new URL(path, location.origin).href,
          getManifest: () => ({ version: "0.5.0" }),
          sendMessage: async ({ operation }) => {
            store ??= LexendPreferences.createStore(sync);
            try { return { ok: true, settings: await store.mutate(operation) }; }
            catch (error) { return { ok: false, code: error.code, message: error.message }; }
          }
        },
        tabs: {
          query: async () => [{ id: 1, url: "https://reading.example.org/article" }],
          sendMessage: async () => ({ ready: true, hostname: "reading.example.org", supported: true,
            active: true, healthy: true, pending: false, refreshRevision: 3, scope: "body" })
        },
        commands: { getAll: async () => [{ name: "toggle-current-site", shortcut: "Ctrl+Shift+L" }] }
      };
    }, { theme: testInfo.project.use.colorScheme });
    await use(page);
    expect(errors, "The built interface must not throw or load missing assets").toEqual([]);
  }
});

export { expect };

export async function openInterface(page, url) {
  await page.goto(url);
  if (url.startsWith("options")) await expect(page.locator("#dark-theme")).toBeEnabled();
  if (url.startsWith("popup")) await expect(page.locator("#enabled")).toBeEnabled();
  if (url.startsWith("about")) await expect(page.locator("#build-fingerprint")).toHaveText("0123456789abcdef".repeat(4));
  await page.evaluate(() => document.fonts.ready);
  // Keep hover and keyboard focus out of the baseline; interactive tests cover them.
  await page.mouse.move(0, 0);
}

export async function scanAccessibility(page, testInfo) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  await testInfo.attach("accessibility", { body: JSON.stringify(results, null, 2), contentType: "application/json" });
  expect(results.violations.map(({ id, nodes }) => ({ id, targets: nodes.map(({ target }) => target) }))).toEqual([]);
}

export async function assertViewportLayout(page, testInfo) {
  const viewport = page.viewportSize();
  const actual = await page.evaluate(() => ({
    innerWidth, innerHeight,
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    coarsePointer: matchMedia("(pointer: coarse)").matches,
    hover: matchMedia("(hover: hover)").matches,
    touch: navigator.maxTouchPoints > 0
  }));
  expect(actual, "The page must retain its intended viewport and input capabilities").toMatchObject({
    innerWidth: viewport.width, innerHeight: viewport.height, clientWidth: viewport.width,
    coarsePointer: Boolean(testInfo.project.use.isMobile),
    hover: !testInfo.project.use.isMobile,
    touch: Boolean(testInfo.project.use.hasTouch)
  });
  expect(actual.scrollWidth, "The interface must not overflow horizontally").toBeLessThanOrEqual(viewport.width);
}

export async function containFullPageScreenshot(page, testInfo) {
  await assertViewportLayout(page, testInfo);
  // Chromium's captureBeyondViewport can clear mobile touch emulation. Give
  // the capture the whole document at the same width so it stays in-viewport.
  // Resize once, then fail if content does not fit; never conceal overflow.
  const viewport = page.viewportSize();
  const documentHeight = await page.evaluate(() => Math.ceil(Math.max(
    document.documentElement.scrollHeight, document.body.scrollHeight,
    document.body.getBoundingClientRect().bottom + scrollY
  )));
  if (documentHeight > viewport.height) {
    await page.setViewportSize({ width: viewport.width, height: documentHeight });
  }
  await assertViewportLayout(page, testInfo);
  expect(await page.evaluate(() => document.documentElement.scrollHeight),
    "The full document must fit inside the screenshot viewport").toBeLessThanOrEqual(page.viewportSize().height);
}
