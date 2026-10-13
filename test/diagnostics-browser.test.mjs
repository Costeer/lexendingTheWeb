import assert from "node:assert/strict";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium } from "playwright";
import { createBuildIdentity } from "../scripts/build-identity.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

test("installed toolbar diagnostics report the active website while About reports unavailable runtime", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "lexend-diagnostics-"));
  const extension = join(temporary, "extension");
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end("<!doctype html><p>private-diagnostic-sentinel page text</p>");
  });
  let context;
  try {
    for (const file of ["src", "assets", "shared.css", "popup.html", "popup.css", "popup.js",
      "options.html", "options.css", "options-desktop.css", "options.js", "about.html", "about.css", "about.js"]) {
      await cp(join(root, file), join(extension, file), { recursive: true });
    }
    await cp(join(root, "manifests/manifest.chrome.json"), join(extension, "manifest.json"));
    const identity = await createBuildIdentity({ root, output: extension, target: "chrome" });
    await writeFile(join(extension, "build-identity.json"), JSON.stringify(identity));
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    context = await chromium.launchPersistentContext(join(temporary, "profile"), {
      channel: "chromium", headless: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
    });
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
    await worker.evaluate(() => chrome.storage.sync.set({ enabled: true, scope: "all", textScale: 120,
      siteRules: [{ hostname: "private-diagnostic-sentinel.example", enabled: false }] }));
    const origin = `chrome-extension://${new URL(worker.url()).host}`;
    const about = await context.newPage();
    await about.goto(`${origin}/about.html`);
    await about.waitForFunction(() => document.querySelector("#build-fingerprint").textContent.length === 64);
    const unavailable = await about.evaluate(() => LexendDiagnostics.collect());
    assert.deepEqual(unavailable.runtime, { status: "unavailable" }, "the active extension tab has no page runtime");

    const website = await context.newPage();
    await website.goto(`http://127.0.0.1:${server.address().port}/private-diagnostic-sentinel`);
    await website.waitForFunction(() => getComputedStyle(document.querySelector("p")).fontFamily.includes("Lexend"));
    await website.bringToFront();
    const result = await about.evaluate(async () => {
      await chrome.action.openPopup();
      let view;
      for (let attempt = 0; attempt < 100; attempt++) {
        view = chrome.extension.getViews({ type: "popup" })[0];
        if (view?.document.querySelector("#enabled")?.disabled === false
            && view.document.querySelector("#popup-export-diagnostics")) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      if (!view) throw new Error("The real toolbar popup did not open");
      // Observe the Blob passed to the real download; do not mock tabs, storage,
      // runtime messages, build identity, collection, or the download handler.
      const createObjectURL = view.URL.createObjectURL;
      let blob;
      view.URL.createObjectURL = value => { blob = value; return createObjectURL.call(view.URL, value); };
      view.document.querySelector("#popup-export-diagnostics").click();
      for (let attempt = 0; attempt < 100 && !blob; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      if (!blob) throw new Error("Toolbar click did not create a diagnostic download");
      const report = JSON.parse(await blob.text());
      view.close();
      return report;
    });
    assert.deepEqual(result.build, identity);
    assert.equal(result.settings.textScale, 120);
    assert.equal(result.runtime.status, "available");
    assert.equal(result.runtime.ready, true);
    assert.equal(result.runtime.active, true);
    assert.equal(result.runtime.healthy, true);
    assert.equal(result.runtime.scope, "all");
    assert(Number.isSafeInteger(result.runtime.refreshRevision));
    assert.match(result.browser.version, /^\d+(?:\.\d+){1,3}$/);
    if (result.browser.source === "user-agent-data") {
      assert.equal(result.browser.version, context.browser().version(), "full-version diagnostics identify the actual installed Chromium");
    }
    assert.doesNotMatch(JSON.stringify(result), /private-diagnostic-sentinel|127\.0\.0\.1|siteRules|hostname/);
  } finally {
    await context?.close();
    await new Promise(resolve => server.close(resolve));
    await rm(temporary, { recursive: true, force: true });
  }
});
