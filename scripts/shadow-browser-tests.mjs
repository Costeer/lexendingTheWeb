import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Builder } from "selenium-webdriver";
import { Command } from "selenium-webdriver/lib/command.js";
import chrome from "selenium-webdriver/chrome.js";
import firefox from "selenium-webdriver/firefox.js";
import { zipSync } from "fflate";
import { assertBrowserVersion, parseBrowserProofOptions } from "./browser-proof-options.mjs";

// Installed-extension lifecycle proof. Unlike addScriptTag tests, the fixture
// creates its roots in the page world and the runtime runs in ISOLATED.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const options = parseBrowserProofOptions(process.argv.slice(2));
const { browserName, requestedBrowserVersion, checksOnly, negativeBridgeWorld } = options;
const output = options.output ?? join(root, "dist/shadow-browser-tests", browserName);
await mkdir(output, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), "lexend-shadow-tests-"));
const extensionDirectory = join(profile, "extension");
const checks = [];
const artifactEvidence = {
  requestedBrowserVersion,
  sourceHashes: {},
  checkScope: checksOnly ? "custom-only" : "shadow-only",
  negativeControl: negativeBridgeWorld ? { kind: "bridge-world", world: "ISOLATED", releaseProof: false } : null
};
let driver;
let optionsTab;
let websiteTab;
let origin;
const check = async (name, run) => {
  const evidence = await run();
  checks.push({ name, evidence: evidence ?? null });
  console.log(`PASS ${browserName}: ${name}`);
};
const script = (fn, ...args) => driver.executeScript(typeof fn === "string" ? `return (${fn});` : fn, ...args);
const wait = (expression, description) => driver.wait(() => script(expression), 15000, description, 100);
const delay = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));
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
const patch = async (changes) => {
  await driver.switchTo().window(optionsTab);
  const result = await extensionCall(async (changes) => {
    const api = globalThis.browser ?? globalThis.chrome;
    const result = await api.runtime.sendMessage({ type: "LEXEND_SETTINGS_MUTATE", operation: { type: "patch", changes } });
    if (!result.ok) throw new Error(result.message);
    return result.settings;
  }, changes);
  await driver.switchTo().window(websiteTab);
  return result;
};
const probe = (command = "read") => script((command) => {
  let result;
  document.addEventListener("lexend-test-probe-response", (event) => { result = JSON.parse(event.detail); }, { once: true });
  document.dispatchEvent(new CustomEvent("lexend-test-probe-request", { detail: command }));
  return result;
}, command);
const settle = async () => {
  await script(() => document.fonts.ready);
  let previous = await probe();
  for (let attempt = 0; attempt < 40; attempt++) {
    await delay(150);
    const next = await probe();
    if (previous.reads === next.reads && previous.scans === next.scans) {
      await delay(750);
      const confirmed = await probe();
      if (confirmed.reads === next.reads && confirmed.scans === next.scans) return confirmed;
    }
    previous = next;
  }
  throw new Error("Installed runtime did not settle");
};
const fixture = `<!doctype html><meta charset="utf-8"><style>body{font:20px Arial}p{margin:0}</style>
  <p id="prose">Ordinary initial text</p><div id="host"></div><div id="isolated-host"></div>
  <div id="paused-host"></div><div id="closed-host"></div><div id="expando-host"></div>
  <script>window.fixturePageAttach = Element.prototype.attachShadow;</script>`;
const server = createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(fixture);
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const fixtureUrl = `http://127.0.0.1:${server.address().port}/`;

try {
  await cp(join(root, "dist", browserName), extensionDirectory, { recursive: true });
  const builtManifest = await readFile(join(extensionDirectory, "manifest.json"), "utf8");
  const manifest = JSON.parse(builtManifest);
  artifactEvidence.originalManifestHash = createHash("sha256").update(builtManifest).digest("hex");
  const productionPaths = new Set([
    ...manifest.content_scripts.flatMap((entry) => entry.js ?? []),
    ...manifest.web_accessible_resources.flatMap((entry) => entry.resources ?? [])
  ]);
  for (const path of productionPaths) {
    artifactEvidence.sourceHashes[path] = createHash("sha256").update(await readFile(join(extensionDirectory, path))).digest("hex");
  }
  assert(manifest.content_scripts.some((entry) => entry.world === "MAIN" && entry.js.includes("src/shadow-discovery.js")), "Build must include the actual MAIN bridge");
  if (negativeBridgeWorld) {
    // Deliberately break only the temporary installed manifest. The unchanged
    // delayed-root assertion must fail through the actual browser command.
    for (const entry of manifest.content_scripts) {
      if (entry.world === "MAIN" && entry.js.includes("src/shadow-discovery.js")) entry.world = "ISOLATED";
    }
  }
  const isolated = manifest.content_scripts.find((entry) => entry.world !== "MAIN");
  isolated.js.unshift("shadow-test-probe.js");
  await writeFile(join(extensionDirectory, "manifest.json"), JSON.stringify(manifest));
  artifactEvidence.testInstrumentedManifestHash = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
  await writeFile(join(extensionDirectory, "shadow-test-probe.js"), `(() => {
    let isolatedAttachCalls = 0, reads = 0, scans = 0, hints = 0, trustedHints = 0;
    const attach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (...args) { isolatedAttachCalls++; return Reflect.apply(attach, this, args); };
    const computed = globalThis.getComputedStyle;
    globalThis.getComputedStyle = function (...args) { reads++; return Reflect.apply(computed, this, args); };
    for (const prototype of [Element.prototype, Document.prototype, DocumentFragment.prototype]) {
      const query = prototype.querySelectorAll;
      prototype.querySelectorAll = function (...args) { scans++; return Reflect.apply(query, this, args); };
    }
    document.addEventListener("lexend-open-shadow-root", (event) => { hints++; if (event.isTrusted) trustedHints++; }, true);
    document.addEventListener("lexend-test-probe-request", (event) => {
      if (event.detail === "attach") document.getElementById("isolated-host").attachShadow({ mode: "open" });
      document.dispatchEvent(new CustomEvent("lexend-test-probe-response", { detail: JSON.stringify({ isolatedAttachCalls, reads, scans, hints, trustedHints }) }));
    });
  })();`);
  artifactEvidence.testProbeHash = createHash("sha256").update(await readFile(join(extensionDirectory, "shadow-test-probe.js"))).digest("hex");
  process.env.SE_FORCE_BROWSER_DOWNLOAD ??= "true";
  process.env.SE_AVOID_STATS ??= "true";
  const builder = new Builder().forBrowser(browserName);
  if (browserName === "chrome") {
    builder.setChromeOptions(new chrome.Options().setBrowserVersion(requestedBrowserVersion).addArguments(
      "--no-sandbox", "--disable-dev-shm-usage", "--window-size=1280,900",
      `--user-data-dir=${join(profile, "chrome-profile")}`, `--disable-extensions-except=${extensionDirectory}`, `--load-extension=${extensionDirectory}`
    ));
  } else {
    builder.setFirefoxOptions(new firefox.Options().setBrowserVersion(requestedBrowserVersion));
    builder.setFirefoxService(new firefox.ServiceBuilder().addArguments("--allow-system-access"));
  }
  driver = await builder.build();
  const capabilities = await driver.getCapabilities();
  artifactEvidence.browserVersion = capabilities.get("browserVersion");
  artifactEvidence.driverVersion = capabilities.get("moz:geckodriverVersion") ?? capabilities.get("chrome")?.chromedriverVersion;
  artifactEvidence.minimumBrowserVersion = assertBrowserVersion({ browserName, requestedBrowserVersion, actualBrowserVersion: artifactEvidence.browserVersion, manifest });
  await driver.manage().setTimeouts({ script: 20000 });
  if (browserName === "firefox") {
    const files = {};
    const collect = async (path = "") => {
      for (const entry of await readdir(join(extensionDirectory, path), { withFileTypes: true })) {
        const relative = path ? `${path}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await collect(relative);
        else files[relative] = new Uint8Array(await readFile(join(extensionDirectory, relative)));
      }
    };
    await collect();
    const archive = join(output, "test-instrumented-extension.zip");
    const archiveBytes = zipSync(files);
    await writeFile(archive, archiveBytes);
    artifactEvidence.testInstrumentedArchive = {
      path: archive, sha256: createHash("sha256").update(archiveBytes).digest("hex")
    };
    // Keep the exact archive available throughout the local driver session.
    // Older Firefox can remove Selenium's base64-backed temporary XPI before
    // content scripts load (Mozilla bug 2045054); the path endpoint retains it.
    artifactEvidence.installation = {
      method: "geckodriver-path", temporary: true, path: archive,
      archiveSha256: artifactEvidence.testInstrumentedArchive.sha256, addonId: null
    };
    artifactEvidence.installation.addonId = await driver.execute(new Command("install addon")
      .setParameter("path", archive).setParameter("temporary", true));
  }
  await driver.get(fixtureUrl);
  await wait("getComputedStyle(document.querySelector('#prose')).fontFamily.includes('Lexend')", "Installed extension applies initial typography");
  websiteTab = await driver.getWindowHandle();
  origin = await script(() => {
    const css = [...document.querySelectorAll("style")].map((style) => style.textContent);
    for (const sheet of document.adoptedStyleSheets) {
      try { css.push([...sheet.cssRules].map((rule) => rule.cssText).join("\n")); } catch {}
    }
    return css.join("\n").match(/(?:chrome|moz)-extension:\/\/[^/"\s]+\//)?.[0];
  });
  assert(origin, "Installed font resource reveals extension origin");
  await driver.switchTo().newWindow("tab");
  optionsTab = await driver.getWindowHandle();
  if (browserName === "firefox") {
    await driver.setContext(firefox.Context.CHROME);
    try {
      await driver.executeScript(function (url) {
        window.gBrowser.selectedBrowser.loadURI(Services.io.newURI(url), { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
      }, `${origin}options.html`);
    } finally { await driver.setContext(firefox.Context.CONTENT); }
  } else await driver.get(`${origin}options.html`);
  await wait("document.querySelector('#dark-theme')?.disabled === false", "Installed settings initialize");
  await patch({ scope: "all", textScale: 110 });
  await wait("getComputedStyle(document.querySelector('#prose')).fontSize === '22px'", "110% scale applies");
  await settle();

  if (!checksOnly) {
  await check("page-world delayed attach is detected while isolated prototype patch sees zero calls", async () => {
    const before = await probe();
    await script(() => {
      const root = document.querySelector("#host").attachShadow({ mode: "open" });
      root.innerHTML = '<style>p{font:20px Arial}</style><p id="text">Delayed shadow text</p><div id="nested"></div><slot></slot>';
    });
    await wait("getComputedStyle(document.querySelector('#host').shadowRoot.querySelector('#text')).fontSize === '22px'", "Settled host delayed root converts without unrelated mutation");
    const after = await settle();
    assert.equal(after.isolatedAttachCalls, 0, "Page-world call cannot be intercepted by isolated prototype");
    assert.equal(after.hints - before.hints, 1);
    assert.equal(after.trustedHints, 0, "Bridge hints are intentionally untrusted DOM events");
    const isolated = await probe("attach");
    assert.equal(isolated.isolatedAttachCalls, 1, "Positive control proves isolated prototype instrumentation works");
    assert.equal(isolated.hints, after.hints, "Isolated attachment does not pass through MAIN prototype");
    return { before, after, isolated };
  });

  await check("delayed nested roots, slots and detach/reattach preserve single scaling", async () => {
    await script(() => {
      const host = document.querySelector("#host");
      const root = host.shadowRoot.querySelector("#nested").attachShadow({ mode: "open" });
      root.innerHTML = '<style>p{font:18px Arial}</style><p>Nested delayed text</p>';
    });
    await wait("Math.abs(parseFloat(getComputedStyle(document.querySelector('#host').shadowRoot.querySelector('#nested').shadowRoot.querySelector('p')).fontSize) - 19.8) < .03", "Nested root is discovered through composed event path");
    await script(() => {
      const paragraph = document.createElement("p"); paragraph.id = "slotted"; paragraph.textContent = "Slotted author text";
      document.querySelector("#host").append(paragraph);
    });
    await wait("getComputedStyle(document.querySelector('#slotted')).fontSize === '22px'", "Slotted text converts once");
    await script(() => { window.detachedHost = document.querySelector("#host"); detachedHost.remove(); });
    await settle();
    await script(() => { document.body.append(detachedHost); delete window.detachedHost; });
    await wait("getComputedStyle(document.querySelector('#host').shadowRoot.querySelector('#text')).fontSize === '22px' && getComputedStyle(document.querySelector('#slotted')).fontSize === '22px'", "Reattached root retains correct single scaling");
    await settle();
  });

  await check("spoofed discovery hints for known roots or non-hosts perform no scans or typography reads", async () => {
    const before = await settle();
    await script(() => {
      for (let index = 0; index < 100; index++) {
        document.querySelector("#host").dispatchEvent(new CustomEvent("lexend-open-shadow-root", { bubbles: true, composed: true, detail: { privileged: true } }));
        document.querySelector("#prose").dispatchEvent(new Event("lexend-open-shadow-root", { bubbles: true, composed: true }));
        document.dispatchEvent(new Event("lexend-open-shadow-root"));
        document.dispatchEvent(new Event("lexend-design-mode"));
      }
    });
    await delay(1000);
    const after = await probe();
    assert.equal(after.reads, before.reads);
    assert.equal(after.scans, before.scans);
    return { before, after };
  });

  await check("disconnected attachments are discovered by insertion without bridge hints", async () => {
    const before = await settle();
    await script(() => {
      const host = document.createElement("div"); host.id = "disconnected-host";
      host.attachShadow({ mode: "open" }).innerHTML = '<style>p{font:20px Arial}</style><p>Detached construction</p>';
      window.pendingDisconnectedHost = host;
    });
    const detached = await probe();
    assert.equal(detached.hints, before.hints);
    await script(() => { document.body.append(pendingDisconnectedHost); delete window.pendingDisconnectedHost; });
    await wait("getComputedStyle(document.querySelector('#disconnected-host').shadowRoot.querySelector('p')).fontSize === '22px'", "Insertion discovers a detached-created root");
    await settle();
  });

  await check("paused delayed root stays untouched with zero runtime reads then is rediscovered on resume", async () => {
    await patch({ enabled: false });
    await wait("getComputedStyle(document.querySelector('#prose')).fontSize === '20px'", "Pause restores author typography");
    const before = await settle();
    await script(() => {
      const root = document.querySelector("#paused-host").attachShadow({ mode: "open" });
      root.innerHTML = '<style>p{font:24px Arial}</style><p>Created while paused</p>';
    });
    await delay(1000);
    const after = await probe();
    assert.equal(after.reads, before.reads);
    assert.equal(after.scans, before.scans);
    assert.equal(await script("getComputedStyle(document.querySelector('#paused-host').shadowRoot.querySelector('p')).fontSize"), "24px");
    await patch({ enabled: true });
    await wait("Math.abs(parseFloat(getComputedStyle(document.querySelector('#paused-host').shadowRoot.querySelector('p')).fontSize) - 26.4) < .03", "Resume discovers roots attached while paused");
    await settle();
    return { before, after };
  });

  await check("closed roots stay private and native attachShadow return/exception behavior is preserved", async () => {
    const before = await settle();
    const result = await script(() => {
      const host = document.querySelector("#closed-host");
      const root = host.attachShadow({ mode: "closed" });
      root.innerHTML = '<p>Closed text</p>';
      let error;
      try { host.attachShadow({ mode: "open" }); } catch (caught) { error = caught.name; }
      return { mode: root.mode, host: root.host === host, exposed: host.shadowRoot !== null, error };
    });
    assert.deepEqual(result, { mode: "closed", host: true, exposed: false, error: "NotSupportedError" });
    const after = await probe();
    assert.equal(after.hints, before.hints);
    return result;
  });

  await check("throwing host expandos and illegal receivers preserve native attachShadow behavior", async () => {
    const result = await script(() => {
      const host = document.querySelector("#expando-host");
      let getterCalls = 0;
      Object.defineProperty(host, "isConnected", { configurable: true, get() { getterCalls++; throw new Error("Author expando getter"); } });
      let root;
      try {
        root = host.attachShadow({ mode: "open" });
        root.innerHTML = '<style>p{font:20px Arial}</style><p>Native connected host</p>';
      } finally { delete host.isConnected; }
      let illegalReceiverError;
      try { Element.prototype.attachShadow.call({}, { mode: "open" }); }
      catch (error) { illegalReceiverError = error.name; }
      return { getterCalls, mode: root.mode, host: root.host === host, illegalReceiverError };
    });
    assert.deepEqual(result, { getterCalls: 0, mode: "open", host: true, illegalReceiverError: "TypeError" });
    await wait("getComputedStyle(document.querySelector('#expando-host').shadowRoot.querySelector('p')).fontSize === '22px'", "Native connected host still receives delayed-root discovery");
    await settle();
    return result;
  });
  }

  if (options.checks) {
    const { runLifecycleChecks } = await import(pathToFileURL(resolve(options.checks)).href);
    await runLifecycleChecks({ driver, browserName, script, wait, check, patch, setSettings: patch, settle, probe, delay, fixtureUrl, websiteTab, optionsTab, extensionCall });
    if (!checksOnly) artifactEvidence.checkScope = "shadow-and-custom";
  }
  await writeFile(join(output, "results.json"), JSON.stringify({ browserName, installedExtension: true, testOnlyIsolatedProbe: true, fixtureUrl, ...artifactEvidence, checks }, null, 2));
} catch (error) {
  await writeFile(join(output, "failure.json"), JSON.stringify({ browserName, error: String(error), stack: error.stack, ...artifactEvidence, checks }, null, 2));
  if (driver) {
    await writeFile(join(output, "failure.png"), await driver.takeScreenshot(), "base64").catch(() => {});
    await writeFile(join(output, "failure.html"), await driver.getPageSource()).catch(() => {});
  }
  throw error;
} finally {
  await driver?.quit();
  await new Promise((done) => server.close(done));
  await rm(profile, { recursive: true, force: true });
}
