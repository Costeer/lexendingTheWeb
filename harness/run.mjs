import { chromium } from "playwright";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { collectSnapshot, compareSnapshots } from "./audit.js";
import { motionSettleDelay } from "./motion.mjs";
import { writeReport, reviewTemplate } from "./report.mjs";
import { root } from "./server.mjs";
import { uncoveredRanges, missingFrames } from "./coverage.mjs";
import { collectMediaSnapshot, compareMediaSnapshots } from "./media-audit.js";
import { pageScrollState } from "./scroll.mjs";
import { captureScreenshot } from "./screenshot.mjs";
export { captureScreenshot } from "./screenshot.mjs";

export const defaultProfiles = [
  { name: "body-default", settings: { scope: "body", textScale: 100, lineHeight: 0, letterSpacing: 0 } },
  { name: "all-readable", settings: { scope: "all", textScale: 110, lineHeight: 1.6, letterSpacing: 0.02 } },
  { name: "all-stress", settings: { scope: "all", textScale: 140, lineHeight: 2, letterSpacing: 0.08 } }
];
export const defaultViewports = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 }
];

export function validateConfig(config) {
  for (const [key, defaults] of [["profiles", defaultProfiles], ["viewports", defaultViewports]]) {
    const entries = config[key] ?? defaults;
    if (!Array.isArray(entries) || !entries.length) throw new Error(`${key} must contain at least one entry.`);
    const names = new Set();
    for (const entry of entries) {
      if (!/^[a-z0-9][a-z0-9-]*$/.test(entry.name) || names.has(entry.name)) throw new Error(`${key}: names must be unique lowercase slugs.`);
      names.add(entry.name);
      if (key === "viewports" && (!Number.isInteger(entry.width) || !Number.isInteger(entry.height) || entry.width < 200 || entry.height < 200)) throw new Error("Viewport width and height must be integers >= 200.");
      if (key === "profiles") {
        const settings = entry.settings ?? {};
        if (settings.scope !== undefined && !["all", "body"].includes(settings.scope)) throw new Error("Scope must be all or body.");
        for (const [field, min, max] of [["textScale", 80, 140], ["lineHeight", 1, 2.4], ["letterSpacing", 0, 0.2]]) {
          if (settings[field] !== undefined && !(field === "lineHeight" && settings[field] === 0) && (typeof settings[field] !== "number" || !Number.isFinite(settings[field]) || settings[field] < min || settings[field] > max)) throw new Error(`Invalid ${field}.`);
        }
        if (settings.enabled === false || settings.siteRules?.length) throw new Error("Compatibility profiles must enable the extension without site rules.");
      }
    }
  }
  if (config.captureActions && (!Array.isArray(config.captureActions)
      || config.captureActions.some((action) => !["focus", "press", "scroll", "wait"].includes(action.type)))) {
    throw new Error("captureActions must contain repeatable focus, press, scroll or wait actions.");
  }
  for (const [key, minimum] of [["maxTiles", 1], ["settleMs", 0], ["timeoutMs", 1]]) {
    if (config[key] !== undefined && (!Number.isInteger(config[key]) || config[key] < minimum)) throw new Error(`${key} must be an integer >= ${minimum}.`);
  }
}

// An acknowledgement can describe the preceding refresh while new DOM text
// is waiting for repair. Wait for a bounded quiet revision; a continuously
// changing feed remains incomplete evidence instead of hanging the survey.
export async function waitForTypographyState(readState, { timeoutMs = 1500, pollMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let previousRevision;
  for (;;) {
    const state = await readState();
    if (!state) throw new Error("The real extension's content script did not respond on this website.");
    const revision = state.refreshRevision;
    if (!state.pending && (revision === undefined || revision === previousRevision)) {
      return { state, settled: true };
    }
    previousRevision = state.pending ? undefined : revision;
    if (Date.now() >= deadline) return { state, settled: false };
    await new Promise((done) => setTimeout(done, pollMs));
  }
}

async function actions(page, entries = []) {
  for (const action of entries) {
    const frame = action.frameSelector
      ? await (await page.locator(action.frameSelector).elementHandle())?.contentFrame()
      : action.frame ? page.frame({ url: action.frame }) : page.mainFrame();
    if (!frame) throw new Error(`Action frame not found: ${action.frame}`);
    const locator = action.locator ? frame.locator(action.locator) : null;
    if (action.type === "focus") await locator.focus();
    else if (action.type === "click") await locator.click();
    else if (action.type === "fill") await locator.fill(action.value);
    else if (action.type === "press") await locator.press(action.key);
    else if (action.type === "wait") await locator.waitFor({ state: action.state ?? "visible" });
    else if (action.type === "scroll") {
      if (locator) await locator.evaluate((element, { x = 0, y }) => element.scrollTo({ left: x, top: y, behavior: "instant" }), action);
      else await evaluateFrame(frame, pageScrollState, action);
    }
    else throw new Error(`Unknown action type: ${action.type}`);
  }
}

// A frame whose event loop is blocked cannot even execute an in-page timeout.
// Bound the protocol call in Node as well, so ads/widgets cannot hang a survey.
async function evaluateFrame(frame, expression, argument) {
  let timer;
  try {
    return await Promise.race([
      frame.evaluate(expression, argument),
      new Promise((_, reject) => {
        // Large live documents can briefly block during their own rendering or
        // a measured extension refresh. Keep the shorter bound for ad frames.
        timer = setTimeout(() => reject(new Error(`Frame evaluation timed out: ${frame.url()}`)), frame.parentFrame() ? 5000 : 15000);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const unresponsiveFrames = new WeakSet();
export function reconcileReappeared(findings, finalFrames) {
  return findings.map((finding) => {
    if (finding.code !== "missing-element") return finding;
    const frame = finalFrames.find((candidate) => candidate.index === finding.frameIndex);
    const visibleAgain = frame?.elements?.some((element) => element.path === finding.path && element.text === finding.text);
    return visibleAgain ? { ...finding, code: "reappeared-element", severity: "review",
      message: "Text disappeared during the initial comparison but reappeared at the same DOM location in the final capture. Review a stable equivalent state." } : finding;
  });
}

export function visibleInScreenshot(snapshot, element) {
  const box = element?.rect;
  if (!box || box.width <= 0 || box.height <= 0) return false;
  const horizontal = Math.min(box.x + box.width, snapshot.scrollX + snapshot.width) - Math.max(box.x, snapshot.scrollX);
  const vertical = Math.min(box.y + box.height, snapshot.scrollY + snapshot.viewportHeight) - Math.max(box.y, snapshot.scrollY);
  // A one-pixel seam at the edge of a tile is not inspectable evidence. Its
  // neighbor tile will test the painted text when that region is on screen.
  return horizontal > Math.min(8, box.width / 3) && vertical > Math.min(8, box.height / 3);
}

async function settle(page, delay) {
  await Promise.allSettled(page.frames().filter((frame) => !unresponsiveFrames.has(frame)).map(async (frame) => {
    try {
      await evaluateFrame(frame, async () => {
        await Promise.race([document.fonts.ready, new Promise((done) => setTimeout(done, 3000))]);
      });
    } catch {
      // Snapshot collection still attempts this frame and records any error as
      // incomplete evidence. Avoid paying the same delay for every image tile.
      unresponsiveFrames.add(frame);
    }
  }));
  // Offscreen cross-origin frames can suspend rAF indefinitely. Only wait for
  // main-frame layout, with a bound for background/browser-throttled tabs.
  await evaluateFrame(page.mainFrame(), () => Promise.race([
    new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    new Promise((done) => setTimeout(done, 150))
  ]));
  await page.waitForTimeout(await evaluateFrame(page.mainFrame(), motionSettleDelay, delay));
}

async function snapshots(page, scope) {
  const frames = [];
  for (const [index, frame] of page.frames().entries()) {
    try {
      const snapshot = await evaluateFrame(frame, collectSnapshot, { scope });
      snapshot.media = await evaluateFrame(frame, collectMediaSnapshot);
      if (frame.parentFrame()) {
        const embedding = await frame.frameElement();
        try {
          snapshot.embedding = await embedding.evaluate((element) => {
            const box = element.getBoundingClientRect();
            let painted = box.width > 0 && box.height > 0;
            for (let current = element; current; current = current.parentElement) {
              const style = getComputedStyle(current);
              if (style.display === "none" || style.visibility !== "visible" || Number(style.opacity) === 0) painted = false;
            }
            return { painted, width: box.width, height: box.height };
          });
          if (!snapshot.embedding.painted) snapshot.limitations.push({ reason: "This embedded frame is not painted by its parent in this state. Reveal it separately before establishing visual compatibility." });
        } finally { await embedding.dispose(); }
      }
      frames.push({ index, ...snapshot });
    } catch (error) {
      frames.push({ index, url: frame.url(), error: error.message, elements: [], limitations: [] });
    }
  }
  return frames;
}

// Load deferred sections before pairing DOM nodes. This is bounded for infinite
// feeds; any remaining growth is still reported as incomplete evidence.
async function warmPage(page, viewport, config) {
  if (config.preScroll === false) return;
  const limit = config.maxTiles ?? 30;
  for (let index = 0; index < limit; index++) {
    const geometry = await evaluateFrame(page.mainFrame(), pageScrollState);
    const target = Math.min(index * viewport.height, Math.max(0, geometry.height - viewport.height));
    await evaluateFrame(page.mainFrame(), pageScrollState, { y: target });
    await settle(page, config.preScrollSettleMs ?? 100);
    const next = await evaluateFrame(page.mainFrame(), pageScrollState);
    if (next.y + viewport.height >= next.height - 2 && next.height === geometry.height) break;
    if (index > 0 && next.y < target - 2 && next.y === geometry.y) break;
  }
  await evaluateFrame(page.mainFrame(), pageScrollState, { y: 0 });
  await settle(page, config.settleMs ?? 300);
}

export async function runHarness({ url, output, config = {}, headed = false }) {
  validateConfig(config);
  if (!url || !["http:", "https:"].includes(new URL(url).protocol)) throw new Error("Provide an http(s) website URL with --url.");
  const directory = resolve(output);
  await mkdir(directory, { recursive: true });
  // Never overwrite evidence or a completed review from an earlier run.
  await writeFile(join(directory, "run.lock"), "", { flag: "wx" });
  const profileDirectory = await mkdtemp(join(tmpdir(), "lexend-visual-"));
  let context;
  const report = { schemaVersion: 1, runId: randomUUID(), createdAt: new Date().toISOString(), url, browser: "Chromium", status: "needs-visual-review", cases: [] };
  try {
    const extensionPath = join(root, "dist/chrome");
    const manifestBytes = await readFile(join(extensionPath, "manifest.json"));
    const manifest = JSON.parse(manifestBytes);
    const runtimeFiles = [...new Set([
      ...manifest.content_scripts.flatMap((script) => script.js),
      ...(manifest.background?.scripts ?? []),
      ...(manifest.background?.service_worker ? [manifest.background.service_worker] : [])
    ])];
    const fingerprint = createHash("sha256").update(manifestBytes);
    for (const file of runtimeFiles) fingerprint.update(file).update(await readFile(join(extensionPath, file)));
    report.extension = { version: manifest.version, runtimeFiles, sha256: fingerprint.digest("hex") };
    context = await chromium.launchPersistentContext(profileDirectory, {
      channel: "chromium", headless: !headed,
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
      reducedMotion: "reduce", colorScheme: config.colorScheme ?? "light"
    });
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 15000 });
    const extensionId = new URL(worker.url()).host;
    // An extension page avoids worker suspension dropping a settings toggle.
    const controller = await context.newPage();
    await controller.goto(`chrome-extension://${extensionId}/options.html`);
    const setSettings = async (settings) => controller.evaluate(async (value) => {
      await chrome.storage.sync.clear();
      await chrome.storage.sync.set(value);
    }, settings);
    for (const viewport of config.viewports ?? defaultViewports) {
      for (const profile of config.profiles ?? defaultProfiles) {
        const settings = { enabled: true, scope: "all", siteRules: [], textScale: 100, lineHeight: 0, letterSpacing: 0, ...profile.settings };
        const id = `${viewport.name}-${profile.name}`;
        const caseDirectory = join(directory, id);
        await mkdir(caseDirectory);
        console.log(`Capturing ${id}: ${url}`);
        await setSettings({ ...settings, enabled: false });
        const page = await context.newPage();
        await page.setViewportSize(viewport);
        page.setDefaultTimeout(config.timeoutMs ?? 15000);
        const runtimeErrors = [];
        page.on("pageerror", (error) => runtimeErrors.push(error.message));
        const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: config.timeoutMs ?? 30000 });
        if (response && response.status() >= 400) throw new Error(`Website returned HTTP ${response.status()}; capture the intended page after resolving access.`);
        // Bound third-party load waits; readiness can be made site-specific with
        // readyLocator/wait actions instead of depending on every ad finishing.
        await page.waitForLoadState("load", { timeout: Math.min(config.timeoutMs ?? 5000, 5000) }).catch(() => {});
        if (config.readyLocator) await page.locator(config.readyLocator).waitFor();
        await actions(page, config.actions);
        await settle(page, config.settleMs ?? 300);
        await warmPage(page, viewport, config);
        await evaluateFrame(page.mainFrame(), pageScrollState, { y: 0 });
        await actions(page, config.captureActions);
        await settle(page, config.settleMs ?? 300);
        const before = await snapshots(page, settings.scope);
        const pendingCaptures = [];
        const pendingFontCaptures = [];
        const readState = async () => {
          // This extension has no tabs permission, so tab URLs are unavailable.
          // Only the current website tab has a responding content script.
          return controller.evaluate(async () => {
            for (const tab of await chrome.tabs.query({})) {
              try {
              const response = await chrome.tabs.sendMessage(tab.id, { type: "LEXEND_GET_STATE" }, { frameId: 0 });
                if (response?.ready) return response;
              } catch { /* Extension pages and the blank tab have no content script. */ }
            }
            return null;
          });
        };
        const verifyState = async (active) => {
          const { state, settled } = await waitForTypographyState(readState);
          if (!settled) pendingCaptures.push(state.refreshRevision ?? "unknown");
          if (!state) throw new Error("The real extension's content script did not respond on this website.");
          if (settled && state.healthy !== true) throw new Error(`The extension did not confirm a successful typography/layout refresh: ${state.error ?? "health acknowledgement unavailable"}`);
          if (!state.ready || state.active !== active || state.scope !== settings.scope) throw new Error("Extension did not acknowledge the requested settings.");
          return { pending: !settled, refreshRevision: state.refreshRevision, healthy: state.healthy, error: state.error };
        };
        await verifyState(false);
        await setSettings(settings);
        await settle(page, config.settleMs ?? 300);
        await verifyState(true);
        await actions(page, config.afterActions);
        await settle(page, config.settleMs ?? 300);
        await actions(page, config.captureActions);
        await settle(page, config.settleMs ?? 300);
        await verifyState(true);
        const after = await snapshots(page, settings.scope);
        const audit = { eligible: 0, converted: 0, excluded: 0, findings: [] };
        const limitations = [];
        let incomplete = false;
        for (const frame of after) {
          const baseline = before.find((candidate) => candidate.index === frame.index && candidate.url === frame.url);
          if (frame.error || !baseline || baseline.error) {
            limitations.push({ reason: `Frame not compared: ${frame.url}: ${frame.error ?? baseline?.error ?? "new or navigated frame"}` });
            incomplete = true;
            continue;
          }
          const comparison = compareSnapshots(baseline, frame, settings);
          if (comparison.findings.some((finding) => ["unpaired-element", "changed-content", "hidden-state-change", "replaced-element", "hidden-frame-overflow", "font-fallback-coverage", "font-coverage-unknown", "font-state-pending"].includes(finding.code))) incomplete = true;
          for (const key of ["eligible", "converted", "excluded"]) audit[key] += comparison[key];
          audit.findings.push(...comparison.findings.map((finding) => ({ ...finding, frame: frame.url, frameIndex: frame.index })));
          limitations.push(...frame.limitations.map((limitation) => ({ ...limitation, frame: frame.url })));
        }
        if (before.some((frame) => !after.some((current) => current.index === frame.index && current.url === frame.url))) {
          audit.findings.push({ code: "missing-frame", severity: "error", path: "document", text: "", message: "A frame disappeared or navigated between captures." });
        }
        if (runtimeErrors.length) limitations.push(...runtimeErrors.map((reason) => ({ reason: `Page runtime error: ${reason}` })));
        audit.coverage = audit.eligible ? audit.converted / audit.eligible : 0;
        const height = Math.max(before[0]?.height ?? viewport.height, after[0]?.height ?? viewport.height);
        const requiredTiles = Math.ceil(height / viewport.height);
        const tileCount = Math.min(requiredTiles, config.maxTiles ?? 30);
        if (tileCount < requiredTiles) {
          limitations.push({ reason: `Screenshot tiles truncated: ${tileCount}/${requiredTiles}. Increase maxTiles and rerun.` });
          incomplete = true;
        }
        const makeTile = (index) => ({
          id: `${id}-tile-${index + 1}`, y: index * viewport.height,
          before: `${id}/before-${index + 1}.png`, after: `${id}/after-${index + 1}.png`
        });
        const tiles = Array.from({ length: tileCount }, (_, index) => makeTile(index));
        const captured = {};
        const tileSnapshots = { before: new Map(), after: new Map() };
        const captureTile = async (phase, tile, index) => {
          await evaluateFrame(page.mainFrame(), pageScrollState, { y: tile.y });
          await actions(page, config.captureActions);
          await settle(page, config.tileSettleMs ?? 150);
          tile[`${phase}TypographyState`] = await verifyState(phase === "after");
          const position = await evaluateFrame(page.mainFrame(), pageScrollState);
          tile[`${phase}ScrollY`] = position.y;
          tile[`${phase}ScrollContainer`] = position.container;
          await captureScreenshot(page, { path: join(caseDirectory, `${phase}-${index + 1}.png`),
            onFontWaitFallback: (finding) => pendingFontCaptures.push({ ...finding, tileId: tile.id, phase }) });
          // Save the typography accompanying each image. A final snapshot alone
          // can miss transient clone/scroll changes that happened in earlier tiles.
          const snapshotStart = await readState();
          const snapshot = await evaluateFrame(page.mainFrame(), collectSnapshot, { scope: settings.scope });
          snapshot.media = await evaluateFrame(page.mainFrame(), collectMediaSnapshot);
          const snapshotEnd = await readState();
          const stable = Boolean(snapshotStart && snapshotEnd && !snapshotStart.pending && !snapshotEnd.pending
            && snapshotStart.healthy && snapshotEnd.healthy
            && snapshotStart.active === (phase === "after") && snapshotEnd.active === snapshotStart.active
            && snapshotStart.refreshRevision === snapshotEnd.refreshRevision);
          const snapshotState = { start: snapshotStart, end: snapshotEnd, stable };
          snapshot.typographyState = snapshotState;
          tile[`${phase}SnapshotTypographyState`] = snapshotState;
          if (!stable || snapshotStart?.refreshRevision !== tile[`${phase}TypographyState`].refreshRevision) {
            pendingCaptures.push(`${phase}/${tile.id}/snapshot-drift`);
          }
          tileSnapshots[phase].set(tile.id, snapshot);
          await writeFile(join(caseDirectory, `${phase}-${index + 1}.elements.json`), JSON.stringify(snapshot));
        };
        for (const phase of ["before", "after"]) {
          await setSettings({ ...settings, enabled: phase === "after" });
          await settle(page, config.settleMs ?? 300);
          await evaluateFrame(page.mainFrame(), pageScrollState, { y: 0 });
          await actions(page, config.captureActions);
          await settle(page, config.tileSettleMs ?? 150);
          await verifyState(phase === "after");
          await captureScreenshot(page, {
            path: join(caseDirectory, `${phase}-full.png`), fullPage: true,
            onFontWaitFallback: (finding) => pendingFontCaptures.push({ ...finding, phase }),
            ...(requiredTiles > tileCount ? { clip: { x: 0, y: 0, width: viewport.width, height: tileCount * viewport.height } } : {})
          });
          for (let index = 0; index < tiles.length; index++) {
            const tile = tiles[index];
            await captureTile(phase, tile, index);
            const { height: currentHeight } = await evaluateFrame(page.mainFrame(), pageScrollState);
            const needed = Math.min(Math.ceil(currentHeight / viewport.height), config.maxTiles ?? 30);
            while (tiles.length < needed) tiles.push(makeTile(tiles.length));
          }
          await verifyState(phase === "after");
          captured[phase] = await snapshots(page, settings.scope);
        }
        // Conversion itself can expose deferred content. Pair any new tiles
        // with an actual paused capture instead of leaving broken image links.
        const unpairedTiles = tiles.filter((tile) => tile.beforeScrollY === undefined);
        if (unpairedTiles.length) {
          await setSettings({ ...settings, enabled: false });
          await settle(page, config.settleMs ?? 300);
          for (const tile of unpairedTiles) {
            await captureTile("before", tile, tiles.indexOf(tile));
          }
          await verifyState(false);
          captured.before = await snapshots(page, settings.scope);
          await setSettings(settings);
          await settle(page, config.settleMs ?? 300);
          await verifyState(true);
          captured.after = await snapshots(page, settings.scope);
        }
        for (const phase of ["before", "after"]) {
          const gaps = uncoveredRanges(tiles, phase, viewport.height, captured[phase][0]?.height ?? height);
          if (gaps.length) {
            limitations.push({ reason: `${phase} screenshot coverage has gaps at vertical pixels ${gaps.map(([start, end]) => `${start}–${end}`).join(", ")}. Layout grew or scrolling did not reach the requested content; stabilize the page and rerun.` });
            incomplete = true;
          }
        }
        if (pendingFontCaptures.length) {
          limitations.push(...pendingFontCaptures);
          incomplete = true;
        }
        if (pendingCaptures.length) {
          limitations.push({ reason: `${pendingCaptures.length} capture checks observed pending typography, a changing refresh revision, or drift between the image and its text snapshot. The live page kept changing; recapture a stable state before assigning a pass.` });
          incomplete = true;
        }
        const final = captured.after;
        for (const frame of [...captured.before, ...final]) {
          for (const limitation of frame.limitations ?? []) {
            if (!limitations.some((item) => item.frame === frame.url && item.path === limitation.path && item.reason === limitation.reason)) {
              limitations.push({ ...limitation, frame: frame.url });
            }
          }
        }
        const changedDuringCapture = final.some((frame) => {
          const initial = after.find((candidate) => candidate.index === frame.index && candidate.url === frame.url);
          if (!initial || frame.error) return true;
          const knownIds = new Set(initial.domIds);
          const text = new Map(initial.elements.map((element) => [element.id, element.text]));
          // Existing sticky/scroll controls becoming visible is normal. New DOM
          // or changed text needs a new stable capture, since earlier tiles may
          // not contain it. The final off/on comparison handles visibility loss.
          return frame.elements.some((element) => !knownIds.has(element.id) || (text.has(element.id) && text.get(element.id) !== element.text));
        });
        if (changedDuringCapture) {
          limitations.push({ reason: "Scrolling or capture changed the rendered text. Add actions to load a stable state, then rerun." });
          incomplete = true;
        }
        // Use the typography observed during screenshot capture. Scrolling can
        // activate deferred rendering/scaling in previously offscreen frames.
        // Keep structural changes from the initial comparison as blockers.
        const structural = reconcileReappeared(audit.findings.filter((finding) => ["unpaired-element", "changed-content", "missing-element", "missing-frame", "unconverted", "font-not-loaded"].includes(finding.code)), final);
        if (structural.some((finding) => finding.code === "reappeared-element")) incomplete = true;
        Object.assign(audit, { eligible: 0, converted: 0, excluded: 0, findings: [] });
        const offscreenClipping = new Set();
        const clippingKey = (finding) => `${finding.path}\n${finding.text}`;
        for (const frame of final) {
          const baseline = captured.before.find((candidate) => candidate.index === frame.index && candidate.url === frame.url);
          if (frame.error || !baseline || baseline.error) {
            limitations.push({ reason: `Frame unavailable during screenshot capture: ${frame.url}: ${frame.error ?? baseline?.error ?? "new/navigated frame"}` });
            incomplete = true;
            continue;
          }
          const comparison = compareSnapshots(baseline, frame, settings);
          if (comparison.findings.some((finding) => ["unpaired-element", "changed-content", "hidden-state-change", "replaced-element", "hidden-frame-overflow", "font-fallback-coverage", "font-coverage-unknown", "font-state-pending"].includes(finding.code))) incomplete = true;
          for (const key of ["eligible", "converted", "excluded"]) audit[key] += comparison[key];
          for (const finding of comparison.findings) {
            if (frame.index === 0 && finding.code === "new-clipping" && finding.severity === "error") {
              offscreenClipping.add(clippingKey(finding));
              continue;
            }
            audit.findings.push({ ...finding, frame: frame.url, frameIndex: frame.index });
          }
          const mediaFindings = compareMediaSnapshots(baseline.media, frame.media);
          if (mediaFindings.some((finding) => finding.severity === "review")) incomplete = true;
          audit.findings.push(...mediaFindings.map((finding) => ({ ...finding, frame: frame.url, frameIndex: frame.index })));
        }
        audit.findings.push(...structural.filter((finding) => !audit.findings.some((current) => current.code === finding.code && current.elementId === finding.elementId && current.frameIndex === finding.frameIndex)));
        for (const tile of tiles) {
          const baseline = tileSnapshots.before.get(tile.id), current = tileSnapshots.after.get(tile.id);
          if (!baseline || !current || baseline.url !== current.url) {
            limitations.push({ reason: `${tile.id}: image-local typography comparison unavailable.` });
            incomplete = true;
            continue;
          }
          const comparison = compareSnapshots(baseline, current, settings);
          const mediaFindings = compareMediaSnapshots(baseline.media, current.media);
          comparison.findings.push(...mediaFindings);
          if (mediaFindings.some((finding) => finding.severity === "review") || comparison.findings.some((finding) => ["unpaired-element", "changed-content", "hidden-state-change", "replaced-element", "hidden-frame-overflow", "font-fallback-coverage", "font-coverage-unknown", "font-state-pending"].includes(finding.code))) incomplete = true;
          for (const finding of comparison.findings) {
            if (finding.severity !== "error") continue;
            if (finding.code === "new-clipping") {
              if (!visibleInScreenshot(current, finding.after)) {
                offscreenClipping.add(clippingKey(finding));
                continue;
              }
              offscreenClipping.delete(clippingKey(finding));
            }
            if (!audit.findings.some((item) => item.code === finding.code && item.elementId === finding.elementId && item.frameIndex === 0)) {
              audit.findings.push({ ...finding, frame: current.url, frameIndex: 0, tileId: tile.id,
                message: `${finding.message} Observed beside screenshot ${tile.id}.` });
            }
          }
        }
        if (offscreenClipping.size) {
          limitations.push({ reason: `${offscreenClipping.size} clipping comparisons involved text outside their paired screenshot viewport. Reveal those states separately before assigning a visual verdict.` });
          incomplete = true;
        }
        for (const frame of missingFrames(captured.before, final)) {
          audit.findings.push({ code: "missing-frame", severity: "error", path: "document", text: "", frame: frame.url, frameIndex: frame.index, message: "A baseline frame disappeared or navigated during screenshot capture." });
          incomplete = true;
        }
        if (audit.eligible === 0 && !audit.findings.some((finding) => finding.code === "no-eligible-text")) {
          audit.findings.push({ code: "no-eligible-text", severity: "error", path: "document", text: "", message: "No eligible text was compared." });
        }
        audit.coverage = audit.eligible ? audit.converted / audit.eligible : 0;
        await writeFile(join(caseDirectory, "elements.json"), JSON.stringify({ settings, before: captured.before, after: final, initialBefore: before, initialAfter: after }, null, 2));
        report.cases.push({ id, name: `${viewport.name} / ${profile.name}`, viewport, profile, settings, url: page.url(), title: final[0]?.title ?? "", audit, limitations, incomplete, tiles });
        await writeReport(directory, report);
        await page.close();
      }
    }
    if (report.cases.some((item) => item.audit.findings.some((finding) => finding.severity === "error"))) report.status = "automated-failures";
    await writeFile(join(directory, "review-template.json"), JSON.stringify(reviewTemplate(report), null, 2));
    await writeReport(directory, report);
    console.log(`Evidence: ${directory}/index.html\nStatus: ${report.status}`);
    return report;
  } catch (error) {
    report.status = "capture-failed";
    report.captureError = error.message;
    await writeReport(directory, report);
    throw error;
  } finally {
    await context?.close();
    await rm(profileDirectory, { recursive: true, force: true });
  }
}
