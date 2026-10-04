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
    "toggle-rule-list",
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

test("content script reacts to page and settings changes", async () => {
  const [contentSource, popupSource] = await Promise.all([
    read("src/content.js"),
    read("popup.js")
  ]);

  assert.match(contentSource, /MutationObserver/);
  assert.match(contentSource, /shadowRoot/);
  assert.match(contentSource, /storage\.onChanged\.addListener/);
  assert.match(contentSource, /data-lexend-ignore/);
  assert.match(contentSource, /data-lexend-text/);
  assert.match(contentSource, /getComputedStyle\(element\)/);
  assert.match(contentSource, /LexendLayout/);
  assert.match(contentSource, /LEXEND_GET_STATE/);
  assert.match(popupSource, /LEXEND_GET_STATE/);
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

test("Ko-fi support stays in a responsive About card, not the sidebar", async () => {
  const [about, css] = await Promise.all([read("about.html"), read("about.css")]);
  assert.match(about, /aria-label="Support Me :3 on Ko-fi \(opens in a new tab\)"/);
  assert.match(about, /class="support-card-title">Support<br \/>Me :3<\/span>/);
  assert.match(about, /class="support-avatar" src="assets\/costeer-avatar\.png" width="320" height="320" alt=""/);
  assert.match(about, /class="support-kofi-logo" src="assets\/kofi-logo\.avif" width="1024" height="1024" alt=""/);
  for (const asset of ["costeer-avatar.png", "kofi-logo.avif"]) await access(join(root, "assets", asset));
  assert.match(about, /class="support-confetti" aria-hidden="true"/);
  assert.match(about, /<span>ko-fi\.com\/costeer<\/span>/);
  assert.doesNotMatch(about, /kofi-support\.jpg|support-coffee-heart|<img\b[^>]*src="https?:/);
  assert.doesNotMatch(about, /Support development|If this extension helps you|Donations are entirely optional/);
  assert.match(about, /<main>[\s\S]*id="donate-link"[\s\S]*<\/main>/);
  assert.doesNotMatch(css.match(/\.support-card\s*\{[^}]*\}/)?.[0], /position:\s*fixed/);
  assert.match(css, /\.support-confetti\s*\{[^}]*position: fixed;[^}]*overflow: hidden;[^}]*pointer-events: none;/);
  assert.doesNotMatch(css, /support-avatar-float|Bricolage|fonts\.googleapis/);
  assert.match(css, /\.support-card\s*\{[^}]*width: 100%;[^}]*font-family: var\(--font-ui\);/);
  assert.match(css, /\.support-card\s*\{[^}]*border-radius: 12px;/);
  assert.doesNotMatch(css.match(/\.support-card\s*\{[^}]*\}/)?.[0], /max-width:/);
  assert.match(about, /class="support-copy"/);
  assert.match(about, /class="support-live"/);
  assert.match(css, /radial-gradient\(380px circle at var\(--support-mx\) var\(--support-my\)/);
  assert.match(css, /@keyframes support-ring-spin/);
  assert.match(css, /@keyframes support-arrow-shoot/);
  assert.match(css, /@keyframes support-cup-steam/);
  assert.match(css, /@media \(max-width: 360px\)[\s\S]*\.support-handle \{ grid-column: 1 \/ -1; \}/);
  assert.match(css, /animation: none !important;/);
  assert.doesNotMatch(css, /\.support-card\s*\{[^}]*display: none;/);
  assert.doesNotMatch(css, /url\(["']?https?:/);
  assert.doesNotMatch(about, /class="donate-button"/);
  assert.match(css, /@media \(prefers-reduced-motion: no-preference\)/);
  assert.match(css, /\.support-confetti\s*\{[^}]*pointer-events: none;/);
  for (const page of ["about.html", "options.html", "popup.html"]) {
    assert.doesNotMatch(await read(page), /<script\b[^>]*src=["']https?:\/\//i);
  }
  for (const page of ["about.html", "options.html"]) {
    const html = await read(page);
    const nav = html.match(/<nav class="desktop-settings-nav"[\s\S]*?<\/nav>/)?.[0];
    assert.ok(nav, `${page} has desktop navigation`);
    assert.doesNotMatch(nav, /sidebar-support|Support the project|ko-fi\.com/);
  }
});

test("support stars stay decorative and the departing arrow returns as a hammer and sickle", async () => {
  const [about, css] = await Promise.all([read("about.html"), read("about.css")]);
  assert.match(about, /class="support-stars" aria-hidden="true"/);
  assert.equal((about.match(/class="support-sparkle"/g) ?? []).length, 5);
  assert.equal((about.match(/class="support-shooting-star"/g) ?? []).length, 5);
  assert.match(css, /\.support-stars\s*\{[^}]*opacity: \.35;[^}]*pointer-events: none;/);
  assert.match(css, /\.support-card:hover \.support-stars\s*\{\s*opacity: \.8;/);
  assert.match(css, /\.support-constellation::before\s*\{[^}]*opacity: \.65;/);
  assert.match(about, /class="support-constellation"/);
  assert.match(css, /\.support-constellation\s*\{\s*animation: support-star-drift 36s linear infinite;/);
  assert.match(css, /@keyframes support-star-drift\s*\{[\s\S]*?translate\(48px, -32px\)/);
  assert.match(css, /\.support-shooting-star\s*\{[^}]*opacity: 0;[^}]*animation: none;/);
  assert.match(css, /\.support-card:hover \.support-shooting-star\s*\{\s*animation: support-star-shoot 8s linear infinite;/);
  assert.match(css, /translate\(100px, -45px\) rotate\(-25deg\)/);
  assert.match(css, /@keyframes support-star-twinkle/);
  assert.match(css, /@keyframes support-star-shoot/);
  assert.match(about, /class="support-arrow-outbound"/);
  assert.match(about, /class="support-arrow-return">☭<\/span>/);
  assert.match(css, /\.support-arrow-outbound\s*\{\s*animation: support-arrow-shoot 550ms[^;]*both;/);
  assert.match(css, /\.support-arrow-return\s*\{\s*animation: support-symbol-return 550ms[^;]*both;/);
  assert.match(css, /@keyframes support-symbol-return/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.support-card \*\s*,[\s\S]*animation: none !important;/);
});

test("mobile settings fill the viewport and use a non-interactive receipt edge", async () => {
  const css = await read("options-desktop.css");
  assert.match(css, /@media not all and \(min-width: 900px\) and \(hover: hover\) and \(pointer: fine\)/);
  assert.match(css, /:root body\.settings-page\s*\{[^}]*min-height: 100dvh;[^}]*padding: 0;/);
  assert.match(css, /\.settings-layout main\s*\{[^}]*flex: 1;[^}]*width: 100%;[^}]*overflow: visible;/);
  assert.match(css, /\.settings-card\s*\{[^}]*flex: 1;[^}]*width: 100%;/);
  assert.match(css, /\.readability-title-row\s*\{[^}]*flex-wrap: wrap;/);
});

test("mobile About is in the header and the desktop tab remains Appearance", async () => {
  const options = await read("options.html");
  for (const page of ["options.html", "about.html"]) {
    const html = await read(page);
    const header = html.match(/<header\b[\s\S]*?<\/header>/)?.[0];
    assert.ok(header, `${page} has a header`);
    assert.match(header, /class="mobile-about-link" href="about\.html"/);
    const nav = html.match(/<nav class="desktop-settings-nav"[\s\S]*?<\/nav>/)?.[0];
    assert.match(nav, />\s*Appearance\s*</);
    assert.doesNotMatch(nav, /Lexend for the Web/);
  }
  assert.match(options, /<h2 id="appearance-title">Appearance<\/h2>/);
  assert.match(options.match(/<footer\b[\s\S]*?<\/footer>/)?.[0], /href="about\.html"/);
});

test("Appearance contains theme settings while About owns the project introduction", async () => {
  const [options, about, aboutCss] = await Promise.all([read("options.html"), read("about.html"), read("about.css")]);
  const appearance = options.match(/<section id="appearance-panel"[\s\S]*?<\/section>/)?.[0];
  assert.ok(appearance);
  assert.match(appearance, /id="dark-theme"/);
  assert.match(appearance, /aria-describedby="appearance-description"/);
  assert.doesNotMatch(appearance, /<a\b|Lexend for the Web|clearer, more readable interface/);
  assert.match(about, /<h2 id="about-title">Lexend for the Web<\/h2>/);
  assert.match(about, /The extension uses Lexend for a clearer, more readable interface\./);
  assert.match(about, /class="about-lexend-link" href="https:\/\/www\.lexend\.com\/"/);
  assert.match(aboutCss, /\.about-lexend-link:is\(:hover, :focus-visible\) \.about-lexend-word\s*\{\s*letter-spacing: \.14em;/);
});

test("settings navigation keeps scrollbar space and selected label metrics stable", async () => {
  const [optionsCss, desktopCss] = await Promise.all([read("options.css"), read("options-desktop.css")]);
  assert.match(optionsCss, /:root\s*\{[^}]*scrollbar-gutter: stable;/);
  const selectedStyle = desktopCss.match(/\.desktop-settings-nav :is\(button, a\)\[aria-current="page"\]\s*\{([^}]*)\}/)?.[1];
  assert.ok(selectedStyle, "selected sidebar navigation has a style");
  assert.match(selectedStyle, /border-color: var\(--accent\);/);
  assert.doesNotMatch(selectedStyle, /font-weight|font-size|padding|border-width/);
});

test("all extension interfaces bootstrap the theme before render-blocking stylesheets", async () => {
  await access(join(root, "src/ui-theme.js"));
  for (const page of ["options.html", "about.html", "popup.html"]) {
    const html = await read(page);
    const head = html.match(/<head>[\s\S]*?<\/head>/)?.[0];
    const script = '<script src="src/ui-theme.js"></script>';
    assert.ok(head.includes(script), `${page} uses a synchronous head script`);
    assert.ok(head.indexOf(script) < head.indexOf('<link rel="stylesheet"'), `${page} applies the cached theme before CSS`);
  }
});

test("sidebar press feedback animates only contents and keeps its hit area stable", async () => {
  const [optionsCss, desktopCss] = await Promise.all([read("options.css"), read("options-desktop.css")]);
  assert.match(optionsCss, /button:not\(:disabled\):not\(\[data-settings-panel\]\):active,/);
  assert.doesNotMatch(optionsCss, /button:not\(:disabled\):active,/);
  assert.match(desktopCss, /\.settings-nav-content\s*\{[^}]*pointer-events: none;[^}]*transition: transform var\(--motion-fast\) var\(--motion-ease\);/);
  assert.match(desktopCss, /@media \(prefers-reduced-motion: no-preference\)\s*\{\s*\.desktop-settings-nav :is\(button, a\):active \.settings-nav-content\s*\{\s*transform: translateY\(1px\) scale\(\.98\);/);
  for (const page of ["options.html", "about.html"]) {
    const html = await read(page);
    const nav = html.match(/<nav class="desktop-settings-nav"[\s\S]*?<\/nav>/)?.[0];
    const items = [...nav.matchAll(/<(?:button|a)\b[^>]*>([\s\S]*?)<\/(?:button|a)>/g)];
    assert.equal(items.length, 5);
    for (const [, content] of items) {
      assert.match(content, /^\s*<span class="settings-nav-content">[\s\S]*<svg\b[\s\S]*<\/span>\s*$/);
    }
  }
});

test("preset controls use equal fixed slots and motion-aware selection growth", async () => {
  const [sharedCss, optionsCss, desktopCss, popupCss, popupJs] = await Promise.all([
    read("shared.css"), read("options.css"), read("options-desktop.css"), read("popup.css"), read("popup.js")
  ]);
  assert.match(sharedCss, /:root :is\(\.segment-group, \.segments\)\s*\{\s*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/);
  assert.match(sharedCss, /:root :is\(\.segment-group, \.segments\) span\s*\{[^}]*pointer-events: none;[^}]*transform: scale\(1\);/);
  assert.match(sharedCss, /@media \(prefers-reduced-motion: no-preference\)\s*\{\s*:root :is\(\.segment-group, \.segments\) input:checked \+ span\s*\{[^}]*transform: scale\(1\.04\);/);
  for (const css of [optionsCss, desktopCss, popupCss]) {
    assert.doesNotMatch(css, /grid-template-columns: \.9fr 1\.2fr \.9fr;/);
    assert.match(css, /:root [^{]*\.(?:segment-group|segments)\s*\{[^}]*overflow: visible;/);
  }
  for (const css of [optionsCss, popupCss]) {
    assert.match(css, /transform var\(--motion-base\) var\(--motion-ease\)/);
  }
  assert.doesNotMatch(popupJs, /nearestSpacing/);
  assert.match(popupJs, /input.checked = Number\(input.value\) === settings.letterSpacing;/);
});

test("settings paper has a receipt edge on desktop and mobile, with an About footer outside", async () => {
  const css = await read("options-desktop.css");
  const sharedLayout = css.split("@media")[0];
  assert.match(sharedLayout, /body\.settings-page\s*\{\s*background: var\(--settings-muted\);/);
  assert.match(sharedLayout, /\.settings-card\s*\{[^}]*position: relative;[^}]*background: var\(--surface\);/);
  assert.match(sharedLayout, /\.settings-card::after\s*\{[^}]*bottom: -12px;[^}]*linear-gradient\(135deg, var\(--surface\)[^}]*linear-gradient\(225deg, var\(--surface\)[^}]*pointer-events: none;/);
  assert.doesNotMatch(css, /main::after|sidebar-support|support-heart-pulse/);
  for (const page of ["options.html", "about.html"]) {
    const html = await read(page);
    assert.match(html, /class="settings-card">[\s\S]*<header\b[\s\S]*class="settings-layout"/);
    assert.match(html, /<\/main>\s*<\/div>\s*<\/div>\s*<footer class="page-attribution">/);
    const footer = html.match(/<footer\b[\s\S]*?<\/footer>/)?.[0];
    assert.match(footer, /href="about\.html"/);
    assert.match(footer, /aria-label="About Lexend for the Web, made by costeer"/);
    assert.doesNotMatch(footer, /target="_blank"|costeer\.dev|<svg/);
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
