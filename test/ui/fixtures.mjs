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
          sendMessage: async ({ operation }) => {
            store ??= LexendPreferences.createStore(sync);
            try { return { ok: true, settings: await store.mutate(operation) }; }
            catch (error) { return { ok: false, code: error.code, message: error.message }; }
          }
        },
        tabs: {
          query: async () => [{ id: 1, url: "https://reading.example.org/article" }],
          sendMessage: async () => ({ hostname: "reading.example.org", supported: true, active: true, healthy: true })
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
  await page.evaluate(() => document.fonts.ready);
  // Keep hover and keyboard focus out of the baseline; interactive tests cover them.
  await page.mouse.move(0, 0);
}

export async function scanAccessibility(page, testInfo) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  await testInfo.attach("accessibility", { body: JSON.stringify(results, null, 2), contentType: "application/json" });
  expect(results.violations.map(({ id, nodes }) => ({ id, targets: nodes.map(({ target }) => target) }))).toEqual([]);
}
