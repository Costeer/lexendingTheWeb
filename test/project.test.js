import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();
const read = (path) => readFile(join(root, path), "utf8");
const readJson = async (path) => JSON.parse(await read(path));

await import("../src/settings.js");
await import("../src/quotes.js");

const settingsApi = globalThis.LexendSettings;

test("browser manifests describe the same extension", async () => {
  const [chrome, firefox, packageJson] = await Promise.all([
    readJson("manifests/manifest.chrome.json"),
    readJson("manifests/manifest.firefox.json"),
    readJson("package.json")
  ]);

  assert.equal(chrome.manifest_version, 3);
  assert.equal(chrome.version, packageJson.version);
  for (const key of ["name", "version", "description", "permissions", "commands"]) {
    assert.deepEqual(chrome[key], firefox[key]);
  }

  assert.deepEqual(chrome.permissions, ["storage"]);
  assert.equal(chrome.options_ui.page, "options.html");
  assert.equal(chrome.commands["toggle-current-site"].suggested_key.default,
    "Ctrl+Shift+L");
  assert.equal(firefox.browser_specific_settings.gecko.id,
    "lexend-the-web@costeer.dev");
  assert.deepEqual(
    firefox.browser_specific_settings.gecko.data_collection_permissions.required,
    ["none"]
  );
});

test("manifest runtime files exist", async () => {
  for (const target of ["chrome", "firefox"]) {
    const manifest = await readJson(`manifests/manifest.${target}.json`);
    const runtimeFiles = new Set([
      manifest.action.default_popup,
      manifest.options_ui.page,
      ...manifest.content_scripts.flatMap(({ js = [], css = [] }) => [...js, ...css]),
      ...Object.values(manifest.icons),
      ...manifest.web_accessible_resources.flatMap(({ resources }) => resources)
    ]);

    for (const path of runtimeFiles) {
      await access(join(root, path));
    }
  }
});

test("popup and settings pages expose their core controls", async () => {
  const [popup, options] = await Promise.all([
    read("popup.html"),
    read("options.html")
  ]);

  for (const id of [
    "enabled",
    "settings-button",
    "site-strip",
    "toggle-site",
    "scope-fieldset",
    "spacing-fieldset"
  ]) {
    assert.match(popup, new RegExp(`id="${id}"`));
  }

  for (const id of [
    "dark-theme",
    "advanced-mode",
    "text-scale",
    "line-height",
    "letter-spacing",
    "add-rule",
    "rule-list",
    "export-settings",
    "import-settings",
    "retry-save"
  ]) {
    assert.match(options, new RegExp(`id="${id}"`));
  }

  assert.match(popup, /src="src\/settings\.js"/);
  assert.match(options, /src="src\/settings\.js"/);
  assert.match(popup, /href="shared\.css"/);
  assert.match(options, /href="shared\.css"/);
  assert.doesNotMatch(options, /id="modern-ui"/);
  assert.doesNotMatch(popup, /wordmark-classic/);
});

test("quote selection returns an entry from the shared collection", () => {
  const quotes = globalThis.LexendQuotes;

  assert.ok(Object.isFrozen(quotes.all));
  assert.ok(quotes.all.length > 1);
  assert.ok(quotes.all.includes(quotes.random()));
});

test("About owns the disclaimer and links donations to the project's Ko-fi page", async () => {
  const [options, about] = await Promise.all([read("options.html"), read("about.html")]);
  assert.doesNotMatch(options, /independent, unofficial extension/);
  assert.match(options, /href="about\.html"/);
  assert.match(about, /independent, unofficial extension/);
  assert.match(about, /href="https:\/\/ko-fi\.com\/costeer"/);
  assert.match(about, /id="donate-link"/);
  assert.match(about, /href="options\.html\?section=appearance-panel"/);
  assert.match(about, /src="about\.js"/);
  for (const asset of ["about.js", "about.css"]) await access(join(root, asset));
});

test("the floating Ko-fi support button is bundled locally for MV3", async () => {
  const [about, css] = await Promise.all([read("about.html"), read("about.css")]);
  assert.match(about, /<span>Support me<\/span>/);
  assert.match(about, /aria-label="Support me on Ko-fi \(opens in a new tab\)"/);
  assert.match(css, /\.donate-button\s*\{[^}]*position: fixed;/);
  assert.match(css, /\.donate-button\s*\{[^}]*color: #fff;[^}]*background: #d9534f;/);
  for (const page of ["about.html", "options.html", "popup.html"]) {
    assert.doesNotMatch(await read(page), /<script\b[^>]*src=["']https?:\/\//i);
  }
});

test("site rules migrate and resolve by specificity", () => {
  let settings = settingsApi.normalizeSettings({
    disabledSites: ["Example.com"],
    spacing: "wide"
  });

  assert.equal(settings.letterSpacing, 0.04);
  assert.equal(settingsApi.resolveSite(settings, "example.com").siteEnabled, false);
  assert.equal(settingsApi.resolveSite(settings, "www.example.com").siteEnabled, true);

  settings = settingsApi.setSiteRule(settings, {
    hostname: "example.com",
    includeSubdomains: true,
    enabled: false,
    scope: "body"
  });
  settings = settingsApi.setSiteRule(settings, {
    hostname: "docs.example.com",
    includeSubdomains: false,
    enabled: true,
    scope: "all"
  });

  assert.equal(settingsApi.resolveSite(settings, "shop.example.com").siteEnabled, false);
  const docs = settingsApi.resolveSite(settings, "docs.example.com");
  assert.equal(docs.siteEnabled, true);
  assert.equal(docs.scope, "all");
  assert.equal(docs.enabledRule.hostname, "docs.example.com");
  assert.equal(docs.scopeRule.hostname, "docs.example.com");

  settings = settingsApi.removeSiteRule(settings, "docs.example.com");
  assert.equal(settingsApi.resolveSite(settings, "docs.example.com").siteEnabled, false);
});

test("normalization rejects invalid values and respects the sync storage limit", () => {
  assert.equal(settingsApi.validHostname("valid-subdomain.example.com"), true);
  assert.equal(settingsApi.validHostname("-invalid.example.com"), false);

  const siteRules = Array.from({ length: 250 }, (_, index) => ({
    hostname: `site-${index}.${"a".repeat(48)}.example`,
    includeSubdomains: index % 2 === 0,
    enabled: false,
    scope: index % 2 === 0 ? "all" : "body"
  }));
  const settings = settingsApi.normalizeSettings({
    uiStyle: "lexend",
    textScale: 500,
    lineHeight: -1,
    letterSpacing: 3,
    siteRules
  });

  assert.equal(settings.textScale, 140);
  assert.equal(settings.lineHeight, 1);
  assert.equal(settings.letterSpacing, 0.2);
  assert.equal(settings.theme, "light");
  assert.ok(JSON.stringify(settings.siteRules).length <= 7000);
  assert.ok(settings.siteRules.length < siteRules.length);
});

test("interface themes normalize and replace legacy styles without changing readability", () => {
  for (const uiStyle of ["classic", "lexend", "modern", "unknown"]) {
    const migrated = settingsApi.normalizeSettings({
      uiStyle,
      enabled: false,
      scope: "all",
      textScale: 120,
      lineHeight: 1.8,
      letterSpacing: 0.08,
      siteRules: [{ hostname: "example.com", enabled: false }]
    });
    assert.equal(migrated.theme, "light");
    assert.equal(Object.hasOwn(migrated, "uiStyle"), false);
    assert.equal(migrated.enabled, false);
    assert.equal(migrated.scope, "all");
    assert.equal(migrated.textScale, 120);
    assert.equal(migrated.lineHeight, 1.8);
    assert.equal(migrated.letterSpacing, 0.08);
    assert.equal(migrated.siteRules[0].hostname, "example.com");
  }
  assert.equal(settingsApi.normalizeSettings({ theme: "dark" }).theme, "dark");
  for (const theme of [undefined, "light", "unknown", null, true]) {
    assert.equal(settingsApi.normalizeSettings({ theme }).theme, "light");
  }
  const dark = settingsApi.normalizeSettings({ theme: "dark" });
  assert.deepEqual(settingsApi.normalizeSettings(dark), dark);
  assert.equal(settingsApi.toggleSite(dark, "example.com").theme, "dark");
});

test("malformed settings do not coerce missing numbers or inherit legacy spacing", () => {
  for (const value of [null, [], false, "settings"]) {
    assert.deepEqual(settingsApi.normalizeSettings(value), settingsApi.normalizeSettings());
  }
  for (const value of [null, false, [], {}, "", " "]) {
    assert.equal(settingsApi.normalizeSettings({ textScale: value }).textScale, 100);
  }
  for (const spacing of ["toString", "constructor", "__proto__"]) {
    assert.equal(settingsApi.normalizeSettings({ spacing }).letterSpacing, 0);
  }
  assert.equal(settingsApi.validHostname("[::1]"), true);
  assert.equal(settingsApi.validHostname("[0:0:0:0:0:0:0:1]"), true);
  assert.equal(settingsApi.validHostname("[::::]"), false);
  assert.equal(settingsApi.validHostname("[::1]/path"), false);
  assert.equal(settingsApi.normalizeSettings({ spacing: { toString: null } }).letterSpacing, 0);
  assert.equal(settingsApi.normalizeSettings({ lineHeight: { toString: null } }).lineHeight, 0);
});

test("rule lookup, update, resolution and removal normalize hostnames consistently", () => {
  let settings = settingsApi.setSiteRule({}, {
    hostname: " Example.COM. ", enabled: false, scope: "all"
  });
  assert.equal(settingsApi.getDirectRule(settings, "Example.COM.").scope, "all");
  assert.equal(settingsApi.resolveSite(settings, " Example.COM. ").active, false);
  settings = settingsApi.setSiteRule(settings, { hostname: "Example.COM.", enabled: true });
  assert.equal(settings.siteRules.length, 1);
  assert.equal(settings.siteRules[0].scope, "all");
  assert.equal(settings.siteRules[0].enabled, true);
  assert.equal(settingsApi.removeSiteRule(settings, "Example.COM.").siteRules.length, 0);

  const ipv6 = settingsApi.setSiteRule({}, { hostname: "[0:0:0:0:0:0:0:1]", enabled: false });
  assert.equal(settingsApi.resolveSite(ipv6, "[::1]").active, false);
});

test("site toggles remove redundant overrides and preserve per-site scope", () => {
  let settings = settingsApi.setSiteRule({}, {
    hostname: "example.com", includeSubdomains: true, enabled: false
  });
  settings = settingsApi.setSiteRule(settings, { hostname: "docs.example.com", scope: "all" });
  settings = settingsApi.toggleSite(settings, "docs.example.com");
  assert.equal(settingsApi.resolveSite(settings, "docs.example.com").active, true);
  settings = settingsApi.toggleSite(settings, "docs.example.com");
  assert.equal(settingsApi.resolveSite(settings, "docs.example.com").active, false);
  assert.equal(settingsApi.getDirectRule(settings, "docs.example.com").enabled, null);
  assert.equal(settingsApi.getDirectRule(settings, "docs.example.com").scope, "all");

  const resumed = settingsApi.toggleSite({ ...settings, enabled: false }, "docs.example.com");
  assert.equal(resumed.enabled, true);
  assert.equal(settingsApi.resolveSite(resumed, "docs.example.com").active, true);
  assert.equal(settingsApi.resolveSite(resumed, "other.example.com").active, false);

  const paused = settingsApi.toggleSite({}, "example.org");
  assert.deepEqual(settingsApi.toggleSite(paused, "example.org").siteRules, []);
});
