import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();

test("both manifests expose the same user-facing capability", async () => {
  const chrome = JSON.parse(await readFile(
    join(root, "manifests/manifest.chrome.json"),
    "utf8"
  ));
  const firefox = JSON.parse(await readFile(
    join(root, "manifests/manifest.firefox.json"),
    "utf8"
  ));

  for (const key of ["name", "version", "description", "permissions"]) {
    assert.deepEqual(chrome[key], firefox[key]);
  }

  assert.equal(firefox.browser_specific_settings.gecko.id,
    "lexend-the-web@costeer.dev");
  assert.equal(chrome.options_ui.page, "options.html");
  assert.equal(chrome.commands["toggle-current-site"].suggested_key.default,
    "Ctrl+Shift+L");
  assert.equal(chrome.content_scripts[0].js[0], "src/settings.js");
});

test("content script supports both scope choices and live updates", async () => {
  const source = await readFile(join(root, "src/content.js"), "utf8");

  assert.match(source, /scope === "body"/);
  assert.match(source, /scope === "all"/);
  assert.match(source, /settings\.textScale/);
  assert.match(source, /settings\.lineHeight/);
  assert.match(source, /settings\.letterSpacing/);
  assert.match(source, /storage\.onChanged\.addListener/);
  assert.match(source, /MutationObserver/);
});

test("text inside icon-labelled controls remains eligible for styling", async () => {
  const source = await readFile(join(root, "src/content.js"), "utf8");

  assert.match(source, /\[class\*='icon' i\]/);
  assert.match(source, /\[class\*='symbol' i\]/);
  assert.doesNotMatch(source, /\[class\*='icon' i\] \*/);
  assert.doesNotMatch(source, /\[class\*='symbol' i\] \*/);
});

test("the interface has square corners and a fixed light palette", async () => {
  const css = await readFile(join(root, "popup.css"), "utf8");

  assert.doesNotMatch(css, /border-radius\s*:/);
  assert.match(css, /color-scheme: only light/);
  assert.match(css, /#c70000/gi);
  assert.match(css, /scrollbar-width:\s*none/);
  assert.match(css, /:root::\-webkit-scrollbar/);
});

test("popup and options markup expose their required controls", async () => {
  const [popup, options] = await Promise.all([
    readFile(join(root, "popup.html"), "utf8"),
    readFile(join(root, "options.html"), "utf8")
  ]);

  assert.match(popup, /id="status"/);
  assert.match(popup, /id="site-scope"/);
  assert.match(popup, /id="site-match"/);
  assert.match(popup, /id="open-options"/);
  assert.match(options, /id="rule-list"/);
  assert.match(options, /id="text-scale"/);
  assert.match(options, /id="letter-spacing"/);
  assert.match(options, /id="export-settings"/);
});

test("site rules support migration, subdomains, and exact-host overrides", async () => {
  await import("../src/settings.js");
  const api = globalThis.LexendSettings;
  let settings = api.normalizeSettings({
    disabledSites: ["example.com"]
  });

  assert.equal(api.resolveSite(settings, "example.com").siteEnabled, false);
  assert.equal(api.resolveSite(settings, "www.example.com").siteEnabled, true);

  settings = api.setSiteRule(settings, {
    hostname: "example.com",
    includeSubdomains: true,
    enabled: false,
    scope: "body"
  });
  settings = api.setSiteRule(settings, {
    hostname: "docs.example.com",
    includeSubdomains: false,
    enabled: true,
    scope: "all"
  });

  assert.equal(api.resolveSite(settings, "shop.example.com").siteEnabled, false);
  assert.equal(api.resolveSite(settings, "docs.example.com").siteEnabled, true);
  assert.equal(api.resolveSite(settings, "docs.example.com").scope, "all");
  assert.equal(api.resolveSite(settings, "unrelated.test").siteEnabled, true);
  assert.equal(api.validHostname("valid-subdomain.example.com"), true);
  assert.equal(api.validHostname("-invalid.example.com"), false);
});

test("legacy spacing presets migrate to independent letter spacing", async () => {
  await import("../src/settings.js");
  const api = globalThis.LexendSettings;

  assert.equal(api.normalizeSettings({ spacing: "default" }).letterSpacing, 0);
  assert.equal(api.normalizeSettings({ spacing: "wide" }).letterSpacing, 0.04);
  assert.equal(api.normalizeSettings({ spacing: "wider" }).letterSpacing, 0.08);
  assert.equal(api.normalizeSettings({ letterSpacing: 0.06 }).letterSpacing, 0.06);
});

test("site rules remain within synchronized-storage item limits", async () => {
  await import("../src/settings.js");
  const api = globalThis.LexendSettings;
  const siteRules = Array.from({ length: 250 }, (_, index) => ({
    hostname: `site-${index}.${"a".repeat(48)}.example`,
    includeSubdomains: index % 2 === 0,
    enabled: false,
    scope: index % 2 === 0 ? "all" : "body"
  }));
  const settings = api.normalizeSettings({ siteRules });

  assert.ok(JSON.stringify(settings.siteRules).length <= 7000);
  assert.ok(settings.siteRules.length < siteRules.length);
});
