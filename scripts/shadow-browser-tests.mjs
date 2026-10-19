import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertBrowserVersion, parseBrowserProofOptions } from "./browser-proof-options.mjs";
import { installTemporaryFirefoxAddon } from "./firefox-installation.mjs";
import { createBrowserCalls, createBrowserDriver, findExtensionOrigin } from "./browser-session.mjs";
import { captureBrowserFailure, finishBrowserRun, startBrowserReport } from "./browser-run.mjs";
import { collectFiles } from "./build-identity.mjs";
import { createArchive } from "./package-archive.mjs";

// Installed-extension lifecycle proof. Unlike addScriptTag tests, the fixture
// creates its roots in the page world and the runtime runs in ISOLATED.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const options = parseBrowserProofOptions(process.argv.slice(2));
const { browserName, requestedBrowserVersion, negativeBridgeWorld } = options;
const output = options.output ?? join(root, "dist/shadow-browser-tests", browserName);
const checks = [];
const headlessFirefox = browserName === "firefox" && process.env.MOZ_HEADLESS === "1";
const report = {
  schemaVersion: 1, browserName, requestedBrowserVersion, installedExtension: false, testOnlyIsolatedProbe: true,
  environment: { headlessFirefox, firefoxPointerPreset: headlessFirefox ? "fine-hover" : null },
  checks,
  sourceHashes: {},
  checkScope: options.checks ? "shadow-and-custom" : "shadow-only",
  negativeControl: negativeBridgeWorld ? { kind: "bridge-world", world: "ISOLATED", releaseProof: false } : null
};
const saveReport = await startBrowserReport(output, report);
let driver, profile, server, runError;
try {
  const harnessPaths = ["scripts/shadow-browser-tests.mjs", "scripts/browser-proof-options.mjs", "scripts/browser-session.mjs", "scripts/browser-run.mjs", "scripts/firefox-installation.mjs", "scripts/build-identity.mjs", "scripts/package-archive.mjs"];
  if (options.checks) harnessPaths.push(relative(root, resolve(options.checks)));
  report.harnessHashes = Object.fromEntries(await Promise.all(harnessPaths.map(async (path) =>
    [path, createHash("sha256").update(await readFile(resolve(root, path))).digest("hex")])));
  report.customChecks = options.checks ? relative(root, resolve(options.checks)) : null;
  profile = await mkdtemp(join(tmpdir(), "lexend-shadow-tests-"));
  const extensionDirectory = join(profile, "extension");
  let optionsTab;
  let websiteTab;
  let origin;
  const check = async (name, run) => {
    try {
      const evidence = await run();
      checks.push({ name, status: "passed", evidence: evidence ?? null });
      console.log(`PASS ${browserName}: ${name}`);
    } catch (error) {
      checks.push({ name, status: "failed", error: String(error.stack ?? error) });
      throw error;
    }
  };
  const { script, wait, extensionCall, navigateExtension, mutate } = createBrowserCalls(() => driver, browserName);
  const delay = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));
  const patch = async (changes) => {
    await driver.switchTo().window(optionsTab);
    const result = await mutate({ type: "patch", changes });
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
  server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(fixture);
  });
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const fixtureUrl = `http://127.0.0.1:${server.address().port}/`;

  report.fixtureUrl = fixtureUrl;

  await cp(join(root, "dist", browserName), extensionDirectory, { recursive: true });
  const builtManifest = await readFile(join(extensionDirectory, "manifest.json"), "utf8");
  const manifest = JSON.parse(builtManifest);
  report.originalManifestHash = createHash("sha256").update(builtManifest).digest("hex");
  const productionPaths = new Set([
    ...manifest.content_scripts.flatMap((entry) => entry.js ?? []),
    ...manifest.web_accessible_resources.flatMap((entry) => entry.resources ?? [])
  ]);
  for (const path of productionPaths) {
    report.sourceHashes[path] = createHash("sha256").update(await readFile(join(extensionDirectory, path))).digest("hex");
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
  report.testInstrumentedManifestHash = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
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
    // Hints use a per-document type that pages never see. This isolated probe
    // observes the same pre-page-script offer that the runtime accepts.
    let hintType = null;
    document.addEventListener("lexend-bridge-offer", (event) => {
      if (hintType !== null) return;
      hintType = event.relatedTarget?.getAttribute("data-channel") ?? null;
      if (hintType !== null) document.addEventListener(hintType, (hint) => {
        if (hint.target === document) return;
        hints++; if (hint.isTrusted) trustedHints++;
      }, true);
    }, true);
    document.addEventListener("lexend-test-probe-request", (event) => {
      if (event.detail === "attach") document.getElementById("isolated-host").attachShadow({ mode: "open" });
      document.dispatchEvent(new CustomEvent("lexend-test-probe-response", { detail: JSON.stringify({ isolatedAttachCalls, reads, scans, hints, trustedHints }) }));
    });
  })();`);
  report.testProbeHash = createHash("sha256").update(await readFile(join(extensionDirectory, "shadow-test-probe.js"))).digest("hex");
  driver = await createBrowserDriver({ browserName, browserVersion: requestedBrowserVersion, profile, extensionDirectory, headlessFirefox });
  const capabilities = await driver.getCapabilities();
  report.browserVersion = capabilities.get("browserVersion");
  report.driverVersion = capabilities.get("moz:geckodriverVersion") ?? capabilities.get("chrome")?.chromedriverVersion;
  report.minimumBrowserVersion = assertBrowserVersion({ browserName, requestedBrowserVersion, actualBrowserVersion: report.browserVersion, manifest });
  await driver.manage().setTimeouts({ script: 20000 });
  if (browserName === "firefox") {
    const archive = join(output, `${report.runId}-test-instrumented-extension.zip`);
    const archiveBytes = createArchive(await collectFiles(extensionDirectory));
    await writeFile(archive, archiveBytes);
    report.testInstrumentedArchive = {
      path: archive, sha256: createHash("sha256").update(archiveBytes).digest("hex")
    };
    // Keep the exact archive available throughout the local driver session.
    // Older Firefox can remove Selenium's base64-backed temporary XPI before
    // content scripts load (Mozilla bug 2045054); the path endpoint retains it.
    report.installation = {
      method: "geckodriver-path", temporary: true, path: archive,
      archiveSha256: report.testInstrumentedArchive.sha256, addonId: null
    };
    report.installation = { ...report.installation,
      ...await installTemporaryFirefoxAddon(driver, archive) };
  }
  await driver.get(fixtureUrl);
  await wait("getComputedStyle(document.querySelector('#prose')).fontFamily.includes('Lexend')", "Installed extension applies initial typography");
  report.installedExtension = true;
  websiteTab = await driver.getWindowHandle();
  origin = await findExtensionOrigin({ driver, browserName, extensionDirectory, addonId: report.installation?.addonId });
  assert(origin, "The browser identifies the installed extension's origin");
  await driver.switchTo().newWindow("tab");
  optionsTab = await driver.getWindowHandle();
  await navigateExtension(`${origin}options.html`);
  await wait("document.querySelector('#dark-theme')?.disabled === false", "Installed settings initialize");
  await patch({ scope: "all", layoutRepair: true, textScale: 110 });
  await wait("getComputedStyle(document.querySelector('#prose')).fontSize === '22px'", "110% scale applies");
  await settle();

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

  if (options.checks) {
    const { runLifecycleChecks } = await import(pathToFileURL(resolve(options.checks)).href);
    await runLifecycleChecks({ driver, browserName, script, wait, check, patch, setSettings: patch, settle, probe, delay, fixtureUrl, websiteTab, optionsTab, extensionCall });
  }
  report.status = "passed";
} catch (error) {
  runError = error;
  report.status = "failed";
  report.error = String(error.stack ?? error);
  if (checks.at(-1)?.status !== "failed") checks.push({ name: "installed shadow verification", status: "failed", error: report.error });
  await captureBrowserFailure(driver, output);
} finally {
  await finishBrowserRun({ error: runError, report, saveReport, driver, server, profile });
}
