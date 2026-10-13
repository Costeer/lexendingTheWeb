import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { arch, platform, release, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Builder, By, Key, Select } from "selenium-webdriver";
import chrome from "selenium-webdriver/chrome.js";
import firefox from "selenium-webdriver/firefox.js";
import { Command } from "selenium-webdriver/lib/command.js";
import { unzipSync } from "fflate";
import { assertBrowserVersion, isPersistedRestoration, parseBrowserArguments } from "./browser-evidence.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { browserName, browserVersion, output } = parseBrowserArguments(process.argv.slice(2));
const fixture = await readFile(join(root, "scripts/fixtures/compatibility.html"), "utf8");
const historyFixture = await readFile(join(root, "scripts/fixtures/history.html"), "utf8");
const frameFixture = '<!doctype html><style>html{font-size:18px}body{font-family:Georgia,serif}p{font-size:1rem}</style><p id="frame-text" style="letter-spacing: 0.02em;">Frame text</p>';
const server = createServer((request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(request.url === "/frame" ? frameFixture : request.url.startsWith("/history-") ? historyFixture : fixture);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const fixtureUrl = `http://127.0.0.1:${server.address().port}/`;
const artifactDirectory = output ?? join(root, "dist/browser-tests", `${browserName}-${browserVersion}`);
await mkdir(artifactDirectory, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), "lexend-browser-tests-"));
const extensionDirectory = join(profile, "extension");
const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const archive = join(root, "dist/releases", `lexend-the-web-${browserName}-v${version}.zip`);
let driver;
const checks = [];
const report = {
  schemaVersion: 1, browserName, requestedBrowserVersion: browserVersion,
  startedAt: new Date().toISOString(), status: "running", installedExtension: false,
  environment: { node: process.version, platform: platform(), release: release(), arch: arch() },
  browser: null, artifact: null, checks,
  limitations: ["No Android add-on surface is exercised by this desktop command.", "Keyboard and layout checks are not manual screen-reader verification."]
};
const saveReport = () => writeFile(join(artifactDirectory, "results.json"), JSON.stringify(report, null, 2));
const unsupported = async (name, reason, evidence) => {
  checks.push({ name, status: "unsupported", reason, evidence });
  console.log(`UNSUPPORTED ${browserName}: ${name}: ${reason}`);
  await saveReport();
};
const check = async (name, run) => {
  const started = performance.now();
  try {
    const evidence = await run();
    checks.push({ name, status: "passed", durationMs: performance.now() - started, ...(evidence === undefined ? {} : { evidence }) });
    console.log(`PASS ${browserName}: ${name}`);
  } catch (error) {
    checks.push({ name, status: "failed", durationMs: performance.now() - started, error: String(error.stack ?? error) });
    throw error;
  } finally { await saveReport(); }
};
const wait = (expression, description) => driver.wait(() => driver.executeScript(`return (${expression});`), 15000, description, 100);
const script = (fn, ...args) => driver.executeScript(typeof fn === "string" ? `return (${fn});` : fn, ...args);
const navigateExtension = async (url) => {
  if (browserName === "firefox") {
    // WebDriver intentionally disallows privileged URL navigation from content
    // context. Open our page through browser chrome in this isolated profile.
    await driver.setContext(firefox.Context.CHROME);
    try {
      await driver.executeScript(function (url) {
        window.gBrowser.selectedBrowser.loadURI(Services.io.newURI(url), {
          triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal()
        });
      }, url);
    } finally {
      await driver.setContext(firefox.Context.CONTENT);
    }
    await wait(`location.href === ${JSON.stringify(url)} && document.readyState === 'complete'`, "Extension page opens");
  } else await driver.get(url);
};
const extensionCall = async (fn, ...args) => {
  const result = await driver.executeAsyncScript(`
    const done = arguments[arguments.length - 1];
    Promise.resolve().then(() => (${fn.toString()})(...Array.from(arguments).slice(0, -1))).then(
      value => done({ value }), error => done({ error: String(error) })
    );
  `, ...args);
  if (result.error) throw new Error(result.error);
  return result.value;
};
const patch = (changes) => extensionCall(async (changes) => {
  const api = globalThis.browser ?? globalThis.chrome;
  const result = await api.runtime.sendMessage({ type: "LEXEND_SETTINGS_MUTATE", operation: { type: "patch", changes } });
  if (!result.ok) throw new Error(result.message);
  return result.settings;
}, changes);
const saved = () => extensionCall(async () => LexendSettings.decodeSettings(
  await (globalThis.browser ?? globalThis.chrome).storage.sync.get(null)
));
const measurements = () => script(() => Object.fromEntries(["rem", "nested", "fixed", "ignored-text", "code", "svg-text", "layout"].map((id) => {
  const style = getComputedStyle(document.getElementById(id));
  return [id, { size: parseFloat(style.fontSize), family: style.fontFamily, padding: parseFloat(style.paddingTop) }];
})));

const createDriver = () => {
  const builder = new Builder().forBrowser(browserName);
  if (browserName === "chrome") {
    const options = new chrome.Options().setBrowserVersion(browserVersion).addArguments(
      "--no-sandbox", "--disable-dev-shm-usage", "--window-size=1280,900",
      `--user-data-dir=${join(profile, "chrome-profile")}`, `--disable-extensions-except=${extensionDirectory}`, `--load-extension=${extensionDirectory}`
    );
    builder.setChromeOptions(options);
  } else {
    builder.setFirefoxOptions(new firefox.Options().setBrowserVersion(browserVersion));
    builder.setFirefoxService(new firefox.ServiceBuilder().addArguments("--allow-system-access"));
  }
  return builder.build();
};

try {
  // Selenium Manager resolves the requested browser and its matching driver. Chrome for
  // Testing retains unpacked-extension loading support; ordinary Chrome does not.
  process.env.SE_FORCE_BROWSER_DOWNLOAD ??= "true";
  process.env.SE_AVOID_STATS ??= "true";
  const git = async (...args) => (await promisify(execFile)("git", args, {
    cwd: root, timeout: 5000, killSignal: "SIGKILL", maxBuffer: 256 * 1024
  })).stdout.trim();
  try {
    report.checkout = { status: "available", commit: await git("rev-parse", "HEAD"), dirty: Boolean(await git("status", "--porcelain")) };
  } catch (error) {
    // A mounted worktree can reference a Git directory outside the container.
    // Missing checkout context must not substitute a fabricated source identity
    // or prevent testing the independently hashed release artifact.
    report.checkout = {
      status: "unavailable", commit: null, dirty: null,
      reason: String(error.stderr?.trim() || error.message || error).slice(0, 2048)
    };
  }
  // Checkout identity describes the harness run. Packaged build identity and
  // archive hash below describe the extension actually installed.
  const archiveBytes = await readFile(archive);
  const retainedArchive = join(artifactDirectory, basename(archive));
  await writeFile(retainedArchive, archiveBytes);
  const files = unzipSync(archiveBytes);
  const manifest = JSON.parse(Buffer.from(files["manifest.json"]).toString("utf8"));
  report.artifact = {
    path: archive, retainedPath: retainedArchive, sha256: createHash("sha256").update(archiveBytes).digest("hex"), manifest,
    buildIdentity: files["build-identity.json"] ? JSON.parse(Buffer.from(files["build-identity.json"]).toString("utf8")) : null
  };
  report.harness = Object.fromEntries(await Promise.all(["scripts/browser-tests.mjs", "scripts/browser-evidence.mjs", "scripts/fixtures/compatibility.html", "scripts/fixtures/history.html"].map(async (path) =>
    [path, createHash("sha256").update(await readFile(join(root, path))).digest("hex")])));
  report.environment.selenium = JSON.parse(await readFile(join(root, "node_modules/selenium-webdriver/package.json"), "utf8")).version;
  if (browserName === "chrome") {
    // Exercise the release artifact rather than assuming the unpackaged build
    // is equivalent. Firefox installs its release ZIP directly below.
    for (const [path, contents] of Object.entries(files)) {
      assert(!path.startsWith("/") && !path.split("/").includes("..") && !path.includes("\\"), `Unsafe ZIP path: ${path}`);
      const destination = join(extensionDirectory, path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, contents);
    }
  }
  driver = await createDriver();
  const capabilities = await driver.getCapabilities();
  report.browser = {
    name: capabilities.get("browserName"), version: capabilities.get("browserVersion"),
    driverVersion: browserName === "chrome" ? capabilities.get("chrome")?.chromedriverVersion : capabilities.get("moz:geckodriverVersion"),
    platform: capabilities.get("platformName")
  };
  await check("launched engine matches the requested version and packaged support floor", async () => {
    const minimum = browserName === "chrome" ? manifest.minimum_chrome_version : manifest.browser_specific_settings?.gecko?.strict_min_version;
    assert.equal(report.browser.name, browserName, "The launched engine must match the requested browser");
    assertBrowserVersion(report.browser.version, browserVersion, minimum);
    assert(report.browser.driverVersion, "Driver must identify its actual version");
    return { requested: browserVersion, actual: report.browser.version, manifestMinimum: minimum ?? null };
  });
  await driver.manage().setTimeouts({ script: 20000 });
  if (browserName === "firefox") {
    // Selenium's installAddon sends base64. With geckodriver 0.37+, older
    // Firefox releases delete that temporary backing XPI before content scripts
    // load (Mozilla bug 2045054). The local driver's path endpoint keeps the
    // exact retained archive available for the whole browser session.
    const addonId = await driver.execute(new Command("install addon")
      .setParameter("path", retainedArchive).setParameter("temporary", true));
    report.installation = { method: "geckodriver-path", temporary: true, addonId, path: retainedArchive };
  }
  await driver.manage().window().setRect({ width: 1280, height: 900 });
  await driver.get(fixtureUrl);
  await wait("getComputedStyle(document.querySelector('#rem')).fontFamily.includes('Lexend for the Web')", "Installed content script must style the fixture");
  report.installedExtension = true;
  const websiteTab = await driver.getWindowHandle();
  const origin = await script(() => {
    const css = [...document.querySelectorAll("style")].map((style) => style.textContent);
    for (const sheet of document.adoptedStyleSheets) {
      try { css.push([...sheet.cssRules].map((rule) => rule.cssText).join("\n")); } catch {}
    }
    return css.join("\n").match(/(?:chrome|moz)-extension:\/\/[^/"\s]+\//)?.[0];
  });
  assert(origin, "Installed font URLs identify the extension's real origin");
  await driver.switchTo().newWindow("tab");
  const optionsTab = await driver.getWindowHandle();
  await navigateExtension(`${origin}options.html`);
  await wait("!document.querySelector('#dark-theme').disabled", "Settings must initialize");

  await check("real background serializes concurrent preferences and rule changes", async () => {
    const result = await extensionCall(async () => {
      const api = globalThis.browser ?? globalThis.chrome;
      const first = LexendPreferences.createClient(api);
      const second = LexendPreferences.createClient(api);
      await Promise.all([first.load(), second.load()]);
      await Promise.all([
        first.mutate({ type: "patch", changes: { textScale: 110, scope: "all" } }),
        second.mutate({ type: "patch", changes: { theme: "dark" } }),
        first.mutate({ type: "addRule", rule: { hostname: "keep.example", enabled: false } }),
        second.mutate({ type: "addRule", rule: { hostname: "remove.example", enabled: false } })
      ]);
      await second.mutate({ type: "removeRule", hostname: "remove.example" });
      return LexendSettings.decodeSettings(await api.storage.sync.get(null));
    });
    assert.equal(result.textScale, 110);
    assert.equal(result.theme, "dark");
    assert.deepEqual(result.siteRules.map((rule) => rule.hostname), ["keep.example"]);
  });

  if (browserName === "chrome") await check("rendered settings save after the background worker restarts", async () => {
    await driver.sendDevToolsCommand("ServiceWorker.enable", {});
    for (const value of [120, 110]) {
      await driver.sendDevToolsCommand("ServiceWorker.stopAllWorkers", {});
      await driver.findElement(By.css(`label:has(input[name="basicTextScale"][value="${value}"])`)).click();
      await wait("document.querySelector('#save-status').classList.contains('is-saved')", "The restarted worker confirms the save");
      assert.equal((await saved()).textScale, value);
    }
  });

  await check("px/rem/em typography scales once while opt-outs and layout keep their original metrics", async () => {
    await driver.switchTo().window(websiteTab);
    await wait("parseFloat(getComputedStyle(document.querySelector('#rem')).fontSize) === 22", "110% text scaling");
    const result = await measurements();
    assert.equal(result.rem.size, 22);
    // Engines quantize fractional CSS pixels differently (Firefox uses 1/64px).
    assert(Math.abs(result.fixed.size - 18.7) < .03);
    assert.equal(result.nested.size, 16.5);
    assert.equal(result.layout.padding, 20);
    for (const id of ["ignored-text", "code", "svg-text"]) assert(!result[id].family.includes("Lexend"), `${id} keeps its original font`);
    assert.equal(await script("getComputedStyle(document.documentElement).fontSize"), "20px");
    await script("document.body.classList.add('font-big')");
    await wait("Math.abs(parseFloat(getComputedStyle(document.querySelector('#rem')).fontSize) - 26.4) < .03", "Changed website styles must be remeasured");
    await script("document.body.classList.remove('font-big')");
    await wait("parseFloat(getComputedStyle(document.querySelector('#rem')).fontSize) === 22", "Restored website styles must be remeasured");
    await script(() => {
      const paragraph = document.createElement("p");
      paragraph.id = "changing-text"; paragraph.textContent = "Dynamic text";
      document.body.append(paragraph);
    });
    await wait("parseFloat(getComputedStyle(document.querySelector('#changing-text')).fontSize) === 22", "Inserted text is scaled");
    await script(() => {
      const span = document.createElement("span"); span.textContent = "Child text";
      document.querySelector("#changing-text").replaceChildren(span);
    });
    await wait("parseFloat(getComputedStyle(document.querySelector('#changing-text')).fontSize) === 20 && parseFloat(getComputedStyle(document.querySelector('#changing-text span')).fontSize) === 22", "Text becoming a wrapper must not compound child sizing");
    await script("document.querySelector('#changing-text span').firstChild.data = ' '");
    await wait("!getComputedStyle(document.querySelector('#changing-text span')).fontFamily.includes('Lexend')", "Whitespace no longer needs a text override");
    await script("document.querySelector('#changing-text span').firstChild.data = 'Restored text'");
    await wait("parseFloat(getComputedStyle(document.querySelector('#changing-text span')).fontSize) === 22", "Character data edits restore text scaling");
  });

  await check("main's engine styles mixed prose while preserving editors and nested icon fonts", async () => {
    const result = await script(() => Object.fromEntries(["mixed-prose", "mixed-code", "editor-token", "nested-glyph"].map((id) => {
      const style = getComputedStyle(document.getElementById(id));
      return [id, { family: style.fontFamily, size: parseFloat(style.fontSize) }];
    })));
    assert(result["mixed-prose"].family.includes("Lexend for the Web"));
    assert.equal(result["mixed-prose"].size, 22);
    for (const id of ["mixed-code", "editor-token", "nested-glyph"]) {
      assert(!result[id].family.includes("Lexend for the Web"), `${id} keeps its original font`);
      assert.equal(result[id].size, 20);
    }
  });

  await check("removed stylesheets and later shadow roots recover without changing active settings", async () => {
    await script(() => {
      document.adoptedStyleSheets = [];
      document.querySelector("#lexend-the-web-styles")?.remove();
      Element.prototype.attachShadow = function (options) { return Reflect.apply(window.fixtureAttachShadow, this, [options]); };
      const shadow = document.querySelector("#host").attachShadow({ mode: "open" });
      const paragraph = document.createElement("p"); paragraph.textContent = "Later shadow text"; shadow.append(paragraph);
    });
    await wait("getComputedStyle(document.querySelector('#rem')).fontFamily.includes('Lexend')", "Document styles recover");
    await wait("getComputedStyle(document.querySelector('#host').shadowRoot.querySelector('p')).fontFamily.includes('Lexend')", "Open shadow text is styled");
    await driver.switchTo().window(optionsTab);
    await patch({ textScale: 100 });
    await driver.switchTo().window(websiteTab);
    await wait("parseFloat(getComputedStyle(document.querySelector('#rem')).fontSize) === 20", "Default sizing restores the site's text size");
    await script("document.querySelector('#host').setAttribute('data-lexend-ignore', '')");
    await wait("!getComputedStyle(document.querySelector('#host').shadowRoot.querySelector('p')).fontFamily.includes('Lexend')", "Dynamic opt-outs remove shadow styling");
    await script("document.querySelector('#host').removeAttribute('data-lexend-ignore')");
    await wait("getComputedStyle(document.querySelector('#host').shadowRoot.querySelector('p')).fontFamily.includes('Lexend')", "Removing opt-outs restyles existing shadows");
    await script("history.pushState({}, '', '/new-route')");
    assert((await measurements()).rem.family.includes("Lexend"));
  });

  await check("rule form validation and keyboard deletion confirmation work in the rendered settings", async () => {
    await driver.switchTo().window(optionsTab);
    await driver.findElement(By.css('[data-settings-panel="rules-panel"]')).click();
    const input = await driver.findElement(By.id("new-hostname"));
    assert.equal(await driver.findElement(By.id("add-rule-button")).isEnabled(), false);
    await input.sendKeys("added.example");
    await driver.findElement(By.id("add-rule-button")).click();
    await wait("[...document.querySelectorAll('.rule-row')].some(row=>row.dataset.hostname === 'added.example')", "Rule is saved");
    let remove = await driver.findElement(By.css('[data-hostname="added.example"] .delete-rule'));
    await remove.click();
    await remove.sendKeys(Key.ESCAPE);
    assert.equal(await remove.getAttribute("data-action"), "delete");
    await remove.click();
    await driver.findElement(By.css('[data-hostname="added.example"] [data-action="confirm"]')).sendKeys(Key.ENTER);
    await wait("![...document.querySelectorAll('.rule-row')].some(row=>row.dataset.hostname === 'added.example')", "Only confirmed rule is removed");
    assert.equal((await saved()).siteRules.length, 1);
    assert.equal(await script("document.activeElement.classList.contains('delete-rule')"), true);
  });

  await check("scope-only rules and reversible import use the installed background writer", async () => {
    const original = await extensionCall(async () => LexendSettings.normalizeSettings(await (globalThis.browser ?? globalThis.chrome).storage.sync.get(null)));
    const mutate = (operation) => extensionCall(async (operation) => {
      const client = LexendPreferences.createClient(globalThis.browser ?? globalThis.chrome);
      await client.load();
      return client.mutate(operation);
    }, operation);
    try {
      await mutate({ type: "addRule", rule: { hostname: "scope-only.example", enabled: null, scope: "all" } });
      const row = '[data-hostname="scope-only.example"]';
      await wait("Boolean(document.querySelector('[data-hostname=\"scope-only.example\"] summary'))", "Scope-only rule appears");
      await driver.findElement(By.css(`${row} summary`)).click();
      assert.equal(await driver.findElement(By.css(`${row} select[name="enabled"]`)).getAttribute("value"), "inherit");
      await new Select(await driver.findElement(By.css(`${row} select[name="enabled"]`))).selectByValue("true");
      await new Select(await driver.findElement(By.css(`${row} select[name="scope"]`))).selectByValue("inherit");
      await driver.findElement(By.css(`${row} .rule-editor-save`)).click();
      await driver.wait(async () => (await saved()).siteRules.some((rule) => rule.hostname === "scope-only.example"
        && rule.enabled === true && rule.scope === null), 5000, "Edited rule is saved");
      const edited = await extensionCall(async () => LexendSettings.getDirectRule(await (globalThis.browser ?? globalThis.chrome).storage.sync.get(null), "scope-only.example"));
      assert.equal(edited.enabled, true);
      assert.equal(edited.scope, null);
      const backup = { ...original, textScale: 127, lineHeight: 1.73, letterSpacing: .057, siteRules: [] };
      const file = join(profile, "replacement-preview.json");
      await writeFile(file, JSON.stringify({ schemaVersion: 2, settings: backup }));
      await driver.findElement(By.css('[data-settings-panel="tools-panel"]')).click();
      await driver.findElement(By.id("import-file")).sendKeys(file);
      await wait("!document.querySelector('#import-preview').hidden", "Replacement preview opens");
      assert((await driver.findElement(By.id("import-preview-list")).getText()).includes("scope-only.example"));
      await driver.findElement(By.id("cancel-import")).click();
      assert((await saved()).siteRules.some((rule) => rule.hostname === "scope-only.example"));
      await driver.findElement(By.id("import-file")).sendKeys(file);
      await wait("!document.querySelector('#import-preview').hidden", "Replacement preview reopens");
      await driver.findElement(By.id("apply-import")).click();
      await wait("!document.querySelector('#import-undo').hidden", "Successful import exposes undo");
      await patch({ textScale: 139 });
      await driver.findElement(By.id("undo-import")).click();
      await driver.findElement(By.id("apply-import")).click();
      await driver.wait(async () => (await saved()).siteRules.some((rule) => rule.hostname === "scope-only.example"), 5000);
      assert.equal((await saved()).textScale, 139, "Undo preserves the later scale edit");
      assert.equal((await saved()).lineHeight, original.lineHeight);
    } finally {
      await mutate({ type: "replace", settings: original });
    }
  });

  await check("oversized imports explicitly fail and preserve existing rules", async () => {
    const invalid = join(profile, "oversized.json");
    const payload = { schemaVersion: 2, settings: { ...(await saved()), siteRules: Array.from({ length: 251 }, (_, i) => ({ hostname: `site${i}.example.com`, enabled: false })) } };
    await writeFile(invalid, JSON.stringify(payload));
    await driver.findElement(By.css('[data-settings-panel="tools-panel"]')).click();
    await driver.findElement(By.id("import-file")).sendKeys(invalid);
    await wait("document.querySelector('#import-error').textContent.includes('room')", "Import reports capacity error");
    assert.deepEqual((await saved()).siteRules.map((rule) => rule.hostname), ["keep.example"]);
  });

  await check("RTL text, keyboard disclosures and ordinary editable controls retain native behavior", async () => {
    await patch({ textScale: 110, letterSpacing: .12 });
    await driver.switchTo().window(websiteTab);
    // Engines may serialize zero tracking as either normal or 0px. A Latin
    // positive control proves that the requested tracking has actually applied.
    await wait("['normal', '0px'].includes(getComputedStyle(document.querySelector('#rtl')).letterSpacing) && Math.abs(parseFloat(getComputedStyle(document.querySelector('#rem')).letterSpacing) - 2.64) < .03", "Arabic remains untracked while Latin text receives the requested spacing");
    assert.equal(await script("getComputedStyle(document.querySelector('#rtl')).direction"), "rtl");
    assert.equal(await script("document.querySelector('#rtl').scrollWidth <= document.querySelector('#rtl').clientWidth + 1"), true);
    const input = await driver.findElement(By.id("plain-input"));
    await input.sendKeys(Key.END, " typed");
    assert.equal(await input.getAttribute("value"), "Original typed");
    assert.equal(await script("document.activeElement.id"), "plain-input");
    const editor = await driver.findElement(By.id("plain-editor"));
    await editor.click();
    await editor.sendKeys(Key.END, " typed");
    assert.equal(await editor.getText(), "Original typed");
    assert.equal(await script("document.activeElement.id"), "plain-editor");
    assert.equal(await script("getSelection().isCollapsed && document.querySelector('#plain-editor').contains(getSelection().anchorNode)"), true);
    const summary = await driver.findElement(By.id("native-summary"));
    assert.equal(await script("document.querySelector('#native-details').open"), false);
    await summary.sendKeys(Key.ENTER);
    await wait("document.querySelector('#native-details').open", "Enter opens the native disclosure");
    assert.equal(await script("document.activeElement.id"), "native-summary");
    assert.equal(await driver.findElement(By.id("disclosure-copy")).isDisplayed(), true);
    assert.equal(await script("document.querySelector('#native-details').scrollHeight <= document.querySelector('#native-details').clientHeight + 1"), true);
    await summary.sendKeys(Key.SPACE);
    await wait("!document.querySelector('#native-details').open", "Space closes the native disclosure");
    assert.equal(await driver.findElement(By.id("disclosure-copy")).isDisplayed(), false);
    await driver.switchTo().window(optionsTab);
    await patch({ textScale: 120, letterSpacing: 0 });
    return { editableSurface: 'input and contenteditable="true"', disclosure: "native keyboard activation", manualScreenReader: "not exercised" };
  });

  const frameKinds = ["same-origin", "about-blank", "srcdoc", "blob"];
  const frameState = async (kind, active) => {
    await driver.switchTo().frame(await driver.findElement(By.id(`frame-${kind}`)));
    try {
      const size = active ? 21.6 : 18;
      await wait(`document.querySelector('#frame-text') && getComputedStyle(document.querySelector('#frame-text')).fontFamily.includes('Lexend for the Web') === ${active} && Math.abs(parseFloat(getComputedStyle(document.querySelector('#frame-text')).fontSize) - ${size}) < .03`, `${kind} must be ${active ? 'active at 120%' : 'paused at native size'}`);
      const state = await script(() => {
        const element = document.querySelector("#frame-text"), style = getComputedStyle(element);
        return { url: location.href, size: parseFloat(style.fontSize), family: style.fontFamily, inlineStyle: element.getAttribute("style") };
      });
      if (!active) assert.equal(state.inlineStyle, "letter-spacing: 0.02em;", `${kind} restores the original inline style`);
      return state;
    } finally { await driver.switchTo().defaultContent(); }
  };
  await driver.switchTo().window(websiteTab);
  await wait("window.fixtureFramesReady", "Every related-frame document loaded");
  for (const [stage, active] of [["initial", true], ["paused", false], ["resumed", true]]) {
    if (stage !== "initial") {
      await driver.switchTo().window(optionsTab);
      await patch({ enabled: active });
      await driver.switchTo().window(websiteTab);
    }
    await check(`top document ${stage} typography matches global settings`, async () => {
      await wait(`getComputedStyle(document.querySelector('#rem')).fontFamily.includes('Lexend for the Web') === ${active} && parseFloat(getComputedStyle(document.querySelector('#rem')).fontSize) === ${active ? 24 : 20}`, `Top document ${stage}`);
    });
    for (const kind of frameKinds) await check(`${kind} frame: ${stage}`, () => frameState(kind, active));
  }
  for (const kind of frameKinds) await check(`${kind} replacement frame receives a fresh content script`, async () => {
    await extensionCall((kind) => window.fixtureCreateFrame(kind), kind);
    return frameState(kind, true);
  });

  let historyEvidence;
  const historyState = () => script(() => ({
    ...structuredClone(window.fixtureHistory),
    typography: {
      size: parseFloat(getComputedStyle(document.querySelector("#rem")).fontSize),
      family: getComputedStyle(document.querySelector("#rem")).fontFamily
    },
    notRestoredReasons: performance.getEntriesByType("navigation")[0]?.notRestoredReasons?.toJSON?.() ?? null
  }));
  await check("back and forward navigation reconcile preferences changed while away", async () => {
    await driver.switchTo().window(websiteTab);
    await driver.get(`${fixtureUrl}history-start`);
    await wait("getComputedStyle(document.querySelector('#rem')).fontFamily.includes('Lexend') && parseFloat(getComputedStyle(document.querySelector('#rem')).fontSize) === 24", "History page initializes at 120%");
    await wait("window.fixtureHistory?.pageshow.length > 0", "Initial pageshow recorded");
    const start = await historyState();
    await driver.findElement(By.id("history-next")).click();
    await wait("location.pathname === '/history-next' && window.fixtureHistory?.pageshow.length > 0", "Second document's pageshow recorded");
    await wait("getComputedStyle(document.querySelector('#rem')).fontFamily.includes('Lexend') && parseFloat(getComputedStyle(document.querySelector('#rem')).fontSize) === 24", "Second document initially converts at 120%");
    const next = await historyState();
    await driver.switchTo().window(optionsTab);
    await patch({ enabled: false, textScale: 120 });
    await driver.switchTo().window(websiteTab);
    await wait("!getComputedStyle(document.querySelector('#rem')).fontFamily.includes('Lexend') && parseFloat(getComputedStyle(document.querySelector('#rem')).fontSize) === 20", "Second document must pause before it enters history");
    const nextPaused = await historyState();
    await driver.navigate().back();
    await wait("location.pathname === '/history-start' && !getComputedStyle(document.querySelector('#rem')).fontFamily.includes('Lexend')", "Returning pages honor paused settings");
    assert.equal(await script("parseFloat(getComputedStyle(document.querySelector('#rem')).fontSize)"), 20);
    const back = await historyState();
    await driver.switchTo().window(optionsTab);
    await patch({ enabled: true });
    await driver.switchTo().window(websiteTab);
    await driver.navigate().forward();
    await wait("location.pathname === '/history-next' && parseFloat(getComputedStyle(document.querySelector('#rem')).fontSize) === 24", "Forward navigation scales exactly once");
    assert(await script("getComputedStyle(document.querySelector('#rem')).fontFamily.includes('Lexend')"));
    assert.equal(await script("document.querySelectorAll('#lexend-the-web-styles').length <= 1"), true);
    const forward = await historyState();
    historyEvidence = { back: { before: start, after: back }, forward: { initial: next, before: nextPaused, after: forward } };
    await driver.switchTo().window(optionsTab);
    await patch({ textScale: 100 });
    return historyEvidence;
  });
  const persisted = Object.values(historyEvidence).map(({ before, after }) => isPersistedRestoration(before, after));
  if (persisted.every(Boolean)) {
    await check("genuine BFCache restoration reuses both documents and reconciles paused and active settings", async () => historyEvidence);
  } else {
    await unsupported("genuine BFCache restoration", "This installed browser/profile did not restore both history documents from BFCache; ordinary history navigation passed but is not cached-document proof.", { persisted, ...historyEvidence });
  }

  await check("settings remain operable at actual 200% browser zoom", async () => {
    await driver.findElement(By.css('[data-settings-panel="appearance-panel"]')).click();
    const originalWidth = await script("innerWidth");
    try {
      const zoom = await extensionCall(async () => {
        const api = globalThis.browser ?? globalThis.chrome;
        await api.tabs.setZoom(2);
        return api.tabs.getZoom();
      });
      assert.equal(zoom, 2, "The browser, not a CSS transform, applies zoom");
      await wait(`innerWidth < ${originalWidth * .75} && document.documentElement.scrollWidth <= innerWidth + 1`, "Zoomed settings reflow within the viewport");
      await driver.findElement(By.id("dark-theme")).sendKeys(Key.SPACE);
      await driver.wait(async () => (await saved()).theme === "light", 5000, "Zoomed keyboard control saves its setting");
      await driver.findElement(By.id("dark-theme")).sendKeys(Key.SPACE);
      await driver.wait(async () => (await saved()).theme === "dark", 5000, "Zoomed keyboard control restores its setting");
      return { zoom, originalWidth, zoomedWidth: await script("innerWidth") };
    } finally {
      await extensionCall(() => (globalThis.browser ?? globalThis.chrome).tabs.setZoom(1));
      await wait(`Math.abs(innerWidth - ${originalWidth}) <= 1`, "Browser zoom resets");
    }
  });

  await check("desktop navigation, narrow layout, and dark About navigation remain stable", async () => {
    for (const id of ["readability-panel", "rules-panel", "appearance-panel", "tools-panel", "readability-panel"]) {
      await driver.findElement(By.css(`[data-settings-panel="${id}"]`)).click();
      assert.deepEqual(await script("[...document.querySelectorAll('.settings-panel')].filter(p=>!p.hidden).map(p=>p.id)"), [id]);
    }
    await navigateExtension(`${origin}about.html`);
    assert.equal(await script("document.documentElement.dataset.theme"), "dark");
    assert.notEqual(await script("getComputedStyle(document.querySelector('.attribution-heart')).webkitTextFillColor"), "rgba(0, 0, 0, 0)", "Footer heart must not inherit transparent link text");
    await navigateExtension(`${origin}options.html`);
    await wait("!document.querySelector('#dark-theme').disabled", "Settings reload");
    assert.equal(await script("document.documentElement.dataset.theme"), "dark");
    await driver.manage().window().setRect({ width: 390, height: 844 });
    await wait("[...document.querySelectorAll('.settings-panel')].every(p=>!p.hidden)", "Narrow layout reveals all sections");
    assert.equal(await script("document.documentElement.scrollWidth <= innerWidth + 1"), true, "Narrow settings must not overflow horizontally");
    await writeFile(join(artifactDirectory, "settings-mobile.png"), await driver.takeScreenshot(), "base64");
    await driver.manage().window().setRect({ width: 1280, height: 900 });
    await wait("[...document.querySelectorAll('.settings-panel')].filter(p=>!p.hidden).length === 1", "Desktop layout restores one section");
  });

  await check("font specimens compare fixed defaults, accept local text, and fit narrow screens", async () => {
    const previous = await saved();
    await patch({ textScale: 140, lineHeight: 2, letterSpacing: .2 });
    await driver.findElement(By.css('.preview-modes label:has(input[value="glyphs"])')).click();
    assert.equal(await script("document.querySelector('#preview-reading').hidden"), true);
    await extensionCall(() => document.fonts.ready.then(() => true));
    assert.deepEqual(await script("[...document.querySelectorAll('.preview-specimen')].map(e=>getComputedStyle(e).fontWeight)"), ["400", "600", "800"]);
    await driver.actions().sendKeys(Key.ARROW_LEFT).perform();
    assert.equal(await script("document.querySelector('input[name=previewMode]:checked').value"), "compare", "Native arrow keys switch preview modes");
    assert.equal(await script("document.querySelector('#preview-original').hidden"), false);
    await driver.findElement(By.css('.preview-custom summary')).click();
    const custom = await driver.findElement(By.id("preview-text"));
    const sample = "A reading sample with <tags> & symbols.\nسارة أحمد";
    const preferences = await saved();
    await custom.sendKeys(sample);
    assert.equal(await script("document.querySelector('#preview-copy').textContent"), sample);
    assert.equal(await script("document.querySelector('#preview-original-copy').textContent"), sample);
    assert.equal(await script("document.querySelector('#preview-attribution').hidden"), true);
    await wait("getComputedStyle(document.querySelector('#preview-copy')).letterSpacing === 'normal' || parseFloat(getComputedStyle(document.querySelector('#preview-copy')).letterSpacing) === 0", "Arabic sample remains untracked");
    assert.deepEqual(await saved(), preferences, "Preview text and modes never change stored preferences");
    for (const width of [1280, 390, 320]) {
      await driver.manage().window().setRect({ width, height: 900 });
      await wait(`matchMedia('(min-width: 900px) and (hover: hover) and (pointer: fine)').matches === ${width >= 900}`, "Viewport reaches the requested layout");
      await wait("document.documentElement.scrollWidth <= innerWidth + 1", "Preview fits the viewport");
      const desktop = await script("matchMedia('(min-width: 900px) and (hover: hover) and (pointer: fine)').matches");
      const base = desktop ? 18 : 16;
      // Firefox quantizes computed sizes at fractional display scales (for
      // example 25.1875px for an authored 25.2px). Allow subpixel rounding.
      await wait(`Math.abs(parseFloat(getComputedStyle(document.querySelector('#preview-copy')).fontSize) - ${base * 1.4}) < .05`, "Live sample reflects text scaling");
      const referenceSize = await script("parseFloat(getComputedStyle(document.querySelector('#preview-original-copy')).fontSize)");
      assert(Math.abs(referenceSize - base) < .05, "Reference retains default size");
    }
    await script(() => {
      const input = document.querySelector('#preview-text');
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    assert.equal(await script("document.querySelector('#preview-attribution').hidden"), false);
    await driver.manage().window().setRect({ width: 1280, height: 900 });
    await patch({ textScale: previous.textScale, lineHeight: previous.lineHeight, letterSpacing: previous.letterSpacing });
  });

  if (browserName === "chrome") await check("forced colors retain a visible selected option and reduced motion disables transitions", async () => {
    await driver.sendDevToolsCommand("Emulation.setEmulatedMedia", { features: [{ name: "forced-colors", value: "active" }, { name: "prefers-reduced-motion", value: "reduce" }] });
    await wait("matchMedia('(forced-colors: active)').matches && getComputedStyle(document.querySelector('.segment-group input:checked + span')).backgroundColor !== 'rgba(0, 0, 0, 0)'", "Forced colors selection styles apply");
    const result = await script(() => {
      const selected = document.querySelector('.segment-group input:checked + span');
      return { background: getComputedStyle(selected).backgroundColor, outline: getComputedStyle(selected).outlineWidth,
        duration: getComputedStyle(selected.closest('.segment-group'), '::before').transitionDuration };
    });
    assert.notEqual(result.background, "rgba(0, 0, 0, 0)");
    assert.equal(result.outline, "2px");
    assert(parseFloat(result.duration) < .01);
    await driver.sendDevToolsCommand("Emulation.setEmulatedMedia", { features: [] });
  });

  await check("popup uses the real stored preferences and fits a narrow viewport", async () => {
    await navigateExtension(`${origin}popup.html`);
    await wait("!document.querySelector('#enabled').disabled", "Popup initializes");
    assert.equal(await script("document.documentElement.dataset.theme"), "dark");
    assert.equal(await script("document.querySelectorAll('#scope-fieldset .radio-mark').length"), 0);
    await driver.findElement(By.css('#scope-fieldset label:has(input[value="body"])')).click();
    await driver.wait(async () => (await saved()).scope === "body", 5000, "Clicking a scope card saves its value");
    await driver.actions().sendKeys(Key.ARROW_RIGHT).perform();
    await driver.wait(async () => (await saved()).scope === "all", 5000, "Arrow keys still select and save the next scope");
    assert.equal(await script("document.activeElement.matches('input[name=scope][value=all]')"), true);
    assert(await script("parseFloat(getComputedStyle(document.querySelector('#scope-fieldset .choice-card:has(input:checked)')).outlineWidth) > 0"), "Keyboard focus is visible on the whole card");
    assert.equal(await script("[...document.querySelectorAll('#scope-fieldset .choice-card')].every(card=>getComputedStyle(card).gridTemplateColumns.split(' ').length === 1)"), true, "No empty radio column remains");
    await driver.manage().window().setRect({ width: 390, height: 844 });
    assert.equal(await script("document.documentElement.scrollWidth <= innerWidth + 1"), true);
    // Desktop windows have a minimum width. CDP supplies a real 320px viewport
    // so intrinsic popup sizing cannot hide overflow on narrow mobile surfaces.
    if (browserName === "chrome") {
      await driver.sendDevToolsCommand("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
      await driver.sendDevToolsCommand("Emulation.setDeviceMetricsOverride", { width: 320, height: 844, deviceScaleFactor: 1, mobile: true });
      await wait("innerWidth === 320", "Narrow popup viewport applies");
      await wait("matchMedia('(hover: none) and (pointer: coarse)').matches", "Touch popup layout applies");
      assert.equal(await script("document.documentElement.scrollWidth <= innerWidth + 1"), true, "320px popup must fit");
      await wait("[...document.querySelectorAll('.segments span')].every(el=>{const range=document.createRange();range.selectNodeContents(el);const text=range.getBoundingClientRect(),box=el.getBoundingClientRect();return text.left>=box.left-.5 && text.right<=box.right+.5;})", "All popup option labels fit their segments");
      await driver.sendDevToolsCommand("Emulation.clearDeviceMetricsOverride", {});
      await driver.sendDevToolsCommand("Emulation.setTouchEmulationEnabled", { enabled: false });
    }
    await writeFile(join(artifactDirectory, "popup-mobile.png"), await driver.takeScreenshot(), "base64");
  });

  if (browserName === "chrome") await check("actual toolbar popup has a stable width and saves changes", async () => {
    await driver.manage().window().setRect({ width: 1280, height: 900 });
    const result = await extensionCall(async () => {
      const api = globalThis.chrome;
      await api.action.openPopup();
      let view;
      for (let attempt = 0; attempt < 100; attempt++) {
        view = api.extension.getViews({ type: "popup" })[0];
        if (view?.document.querySelector("#enabled")?.disabled === false) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (!view) throw new Error("The actual toolbar popup did not open");
      await view.document.fonts.ready;
      const bodyWidth = view.document.body.getBoundingClientRect().width;
      const viewportWidth = view.innerWidth;
      const input = view.document.querySelector('input[name="spacing"][value="0.08"]');
      input.click();
      let settings;
      for (let attempt = 0; attempt < 100; attempt++) {
        settings = await api.storage.sync.get(null);
        if (settings.letterSpacing === .08) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const feedback = view.document.querySelector("#popup-feedback").textContent;
      view.close();
      return { bodyWidth, viewportWidth, spacing: settings.letterSpacing, feedback };
    });
    assert.equal(result.bodyWidth, 360);
    assert(result.viewportWidth >= 360 && result.viewportWidth < 380, "Toolbar width stays intrinsic, not collapsed or full-page");
    assert.equal(result.spacing, .08);
    assert.equal(result.feedback, "");
  });

  await check("legacy pauses migrate losslessly within installed storage quotas and remain editable", async () => {
    const original = await extensionCall(() => (globalThis.browser ?? globalThis.chrome).storage.sync.get(null));
    const evidence = { browserName, browserVersion: (await driver.getCapabilities()).get("browserVersion"), cases: [] };
    try {
      for (const count of [120, 250]) {
        const result = await extensionCall(async (count) => {
          const api = globalThis.browser ?? globalThis.chrome;
          const disabledSites = Array.from({ length: count }, (_, index) => `site${index}.example.com`);
          await api.storage.sync.clear();
          await api.storage.sync.set({ enabled: false, scope: "all", textScale: 130, disabledSites });
          const legacy = await api.storage.sync.get(null);
          const expanded = LexendSettings.decodeSettings(legacy);
          // Positive control: the browser itself must reject the old expanded
          // representation. This proves the fixture reaches the real item quota.
          let expandedWriteError;
          try { await api.storage.sync.set({ siteRules: expanded.siteRules }); }
          catch (error) { expandedWriteError = String(error); }
          if (!expandedWriteError) throw new Error("Expanded legacy rules unexpectedly fit the installed browser quota");
          const first = LexendPreferences.createClient(api);
          const second = LexendPreferences.createClient(api);
          await Promise.all([first.load(), second.load()]);
          await Promise.all([
            first.mutate({ type: "patch", changes: { theme: "dark" } }),
            second.mutate({ type: "patch", changes: { lineHeight: 1.73 } })
          ]);
          const afterPatch = LexendSettings.decodeSettings(await api.storage.sync.get(null));
          await first.mutate({ type: "removeRule", hostname: disabledSites[60], includeSubdomains: false });
          const raw = await api.storage.sync.get(null);
          const afterDelete = LexendSettings.decodeSettings(raw);
          const restartedClient = LexendPreferences.createClient(api);
          await restartedClient.load();
          return {
            count, expandedWriteError,
            itemQuota: api.storage.sync.QUOTA_BYTES_PER_ITEM,
            legacyValueBytes: new TextEncoder().encode(JSON.stringify(disabledSites)).length,
            expandedValueBytes: new TextEncoder().encode(JSON.stringify(expanded.siteRules)).length,
            persistedRuleItemBytes: new TextEncoder().encode("siteRules" + JSON.stringify(raw.siteRules)).length,
            remainingLegacy: Object.hasOwn(raw, "disabledSites"),
            afterPatch, afterDelete, restarted: restartedClient.settings
          };
        }, count);
        assert.match(result.expandedWriteError, /quota/i);
        assert.equal(result.afterPatch.siteRules.length, count, "An unrelated preference write preserves every legacy pause");
        assert.equal(result.afterPatch.theme, "dark");
        assert.equal(result.afterPatch.lineHeight, 1.73);
        assert.equal(result.afterPatch.enabled, false);
        assert.equal(result.afterPatch.scope, "all");
        assert.equal(result.afterPatch.textScale, 130);
        assert.deepEqual(result.afterDelete.siteRules.map((rule) => rule.hostname),
          Array.from({ length: count }, (_, index) => `site${index}.example.com`).filter((_, index) => index !== 60));
        assert(result.afterDelete.siteRules.every((rule) => rule.enabled === false && rule.includeSubdomains === false && rule.scope === null));
        assert.deepEqual(result.restarted, result.afterDelete);
        assert.equal(result.remainingLegacy, false, "Legacy keys are cleaned only after durable canonical settings");
        assert(result.persistedRuleItemBytes <= (result.itemQuota ?? 8192));
        evidence.cases.push(result);
      }
      if (browserName === "chrome") {
        const before = await saved();
        await driver.sendDevToolsCommand("ServiceWorker.enable", {});
        await driver.sendDevToolsCommand("ServiceWorker.stopAllWorkers", {});
        await patch({ theme: "light" });
        assert.deepEqual((await saved()).siteRules, before.siteRules, "A restarted worker decodes every migrated pause");
        await driver.quit();
        driver = await createDriver();
        await driver.manage().setTimeouts({ script: 20000 });
        await navigateExtension(`${origin}options.html`);
        await wait("!document.querySelector('#dark-theme').disabled", "Migrated settings initialize after a full browser restart");
        assert.deepEqual(await saved(), { ...before, theme: "light" });
        await patch({ theme: "dark" });
        assert.deepEqual(await saved(), before, "All migrated rules remain editable after restart");
        evidence.workerRestart = true;
        evidence.browserRestart = true;
      }
      await writeFile(join(artifactDirectory, "legacy-quota.json"), JSON.stringify(evidence, null, 2));
    } finally {
      await extensionCall(async (original) => {
        const api = globalThis.browser ?? globalThis.chrome;
        await api.storage.sync.clear();
        await api.storage.sync.set(original);
      }, original);
    }
  });

  if (browserName === "chrome") await check("browser restart preserves custom preferences, site pauses and a working writer", async () => {
    await patch({ theme: "dark", scope: "all", textScale: 127, lineHeight: 1.73, letterSpacing: .057 });
    await extensionCall(async () => {
      const result = await chrome.runtime.sendMessage({ type: "LEXEND_SETTINGS_MUTATE", operation: {
        type: "addRule", rule: { hostname: "127.0.0.1", enabled: false, includeSubdomains: false }
      } });
      if (!result.ok) throw new Error(result.message);
    });
    const before = await saved();
    await driver.quit();
    driver = await createDriver();
    await driver.manage().setTimeouts({ script: 20000 });
    await driver.get(fixtureUrl);
    const restartedWebsite = await driver.getWindowHandle();
    await driver.switchTo().newWindow("tab");
    const restartedOptions = await driver.getWindowHandle();
    await navigateExtension(`${origin}options.html`);
    await wait("!document.querySelector('#dark-theme').disabled", "Settings initialize after a full browser restart");
    assert.deepEqual(await saved(), before, "Reopening must not overwrite custom values or site rules");
    assert.equal(await script("document.documentElement.dataset.theme"), "dark");
    assert.equal(await script("document.querySelector('#text-scale').value"), "127");
    await driver.switchTo().window(restartedWebsite);
    assert(!((await measurements()).rem.family.includes("Lexend")), "Saved site pause survives restart");
    assert.equal((await measurements()).rem.size, 20);
    await driver.switchTo().window(restartedOptions);
    await extensionCall(async () => {
      const result = await chrome.runtime.sendMessage({ type: "LEXEND_SETTINGS_MUTATE", operation: {
        type: "removeRule", hostname: "127.0.0.1"
      } });
      if (!result.ok) throw new Error(result.message);
    });
    await driver.switchTo().window(restartedWebsite);
    await wait("Math.abs(parseFloat(getComputedStyle(document.querySelector('#rem')).fontSize) - 25.4) < .03", "Writer and live page updates work after restarting");
  });
  if (browserName === "firefox") {
    for (const [name, reason] of [
      ["background service worker restart", "Firefox uses a background page rather than Chrome's service worker."],
      ["forced colors and reduced motion emulation", "This installed harness uses Chrome DevTools emulation; this run provides no Firefox emulation evidence."],
      ["actual toolbar popup", "This desktop Firefox harness navigates the popup document; it does not drive Firefox toolbar chrome."],
      ["full browser restart with installed extension", "Firefox installs a temporary add-on here, which does not survive browser restart."]
    ]) await unsupported(name, reason);
  }
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = String(error.stack ?? error);
  if (checks.at(-1)?.status !== "failed") {
    checks.push({ name: report.installedExtension ? "installed browser verification" : "browser and artifact setup", status: "failed", error: report.error });
  }
  if (driver) {
    await writeFile(join(artifactDirectory, "failure.png"), await driver.takeScreenshot(), "base64").catch(() => {});
    await writeFile(join(artifactDirectory, "failure.html"), await driver.getPageSource()).catch(() => {});
  }
  throw error;
} finally {
  report.finishedAt = new Date().toISOString();
  report.summary = Object.fromEntries(["passed", "unsupported", "failed"].map((status) => [status, checks.filter((check) => check.status === status).length]));
  await saveReport();
  try { await driver?.quit(); }
  finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(profile, { recursive: true, force: true });
  }
}
