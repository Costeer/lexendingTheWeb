import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import "../src/settings.js";

const source = await readFile(new URL("../src/content.js", import.meta.url), "utf8");
const detectorSource = await readFile(new URL("../src/shadow-detector.js", import.meta.url), "utf8");
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function openPage({ stored = {}, shared = true, getSettings, emptyDocument = false, detector = true, loading = false, documentSheets = true } = {}) {
  const observers = new Set();
  const tasks = new Map();
  const stats = { visits: 0, resolves: 0, fontUrls: 0, styleWrites: 0, sheetWrites: 0, callbacks: 0 };
  let taskId = 0;
  const descendants = (root) => {
    const nodes = [];
    const stack = [...root.children].reverse();
    while (stack.length) {
      const node = stack.pop();
      nodes.push(node);
      stack.push(...[...node.children].reverse());
    }
    return nodes;
  };
  const mutate = (target, addedNodes = [], removedNodes = []) => {
    for (const observer of observers) {
      if (!observer.root?.contains(target)) continue;
      observer.records.push({ target, addedNodes, removedNodes });
      if (observer.queued) continue;
      observer.queued = true;
      queueMicrotask(() => {
        observer.queued = false;
        const records = observer.records.splice(0);
        if (records.length && observer.root) {
          stats.callbacks++;
          observer.callback(records);
        }
      });
    }
  };
  class Node extends EventTarget {
    children = [];
    parentNode = null;
    contains(node) {
      for (let current = node; current; current = current.parentNode) {
        if (current === this) return true;
      }
      return false;
    }
    get isConnected() { return this === doc || Boolean(this.parentNode?.isConnected); }
    append(node) {
      node.remove();
      node.parentNode = this;
      this.children.push(node);
      mutate(this, [node]);
    }
    remove() {
      if (!this.parentNode) return;
      const parent = this.parentNode;
      parent.children.splice(parent.children.indexOf(this), 1);
      this.parentNode = null;
      mutate(parent, [], [this]);
    }
    getElementById(id) { return descendants(this).find((node) => node.id === id); }
  }
  class Element extends Node {
    constructor(tagName = "div") { super(); this.tagName = tagName; this.id = ""; }
    get textContent() { return this.text ?? ""; }
    set textContent(value) { this.text = value; if (this.tagName === "style") stats.styleWrites++; }
    attachShadow() { this.shadowRoot = new ShadowRoot(this); return this.shadowRoot; }
  }
  class ShadowRoot extends Node {
    constructor(host) { super(); this.host = host; this.adoptedStyleSheets = []; this.mode = "open"; }
    get isConnected() { return this.host.isConnected; }
  }
  class MutationObserver {
    records = [];
    constructor(callback) { this.callback = callback; observers.add(this); }
    observe(root) { this.root = root; }
    disconnect() { this.root = null; this.records = []; }
  }
  class CSSStyleSheet {
    replaceSync(css) { this.css = css; stats.sheetWrites++; }
  }
  class Document extends Node {}
  const nativeAttachShadow = Element.prototype.attachShadow;
  const doc = new Document();
  doc.readyState = loading ? "loading" : "complete";
  doc.adoptedStyleSheets = [];
  if (!documentSheets) Object.defineProperty(doc, "adoptedStyleSheets", {
    get() { return []; },
    set() { throw new Error("Cannot adopt document stylesheet"); }
  });
  doc.referrer = "";
  doc.createElement = (tag) => new Element(tag);
  doc.createTreeWalker = (root) => {
    const nodes = descendants(root);
    let index = 0;
    return { nextNode() { const node = nodes[index++]; if (node) stats.visits++; return node ?? null; } };
  };
  const html = new Element("html");
  const body = new Element("body");
  html.append(body);
  if (!emptyDocument) { doc.documentElement = html; doc.append(html); }
  const window = new EventTarget();
  window.top = window;
  let changeListener;
  let messageListener;
  const notifications = [];
  const api = globalThis.LexendSettings;
  const context = {
    document: doc, window, Element, ShadowRoot, MutationObserver, Node, Document,
    Event, EventTarget, CustomEvent,
    CSSStyleSheet: shared ? CSSStyleSheet : undefined,
    NodeFilter: { SHOW_ELEMENT: 1 }, performance: { now: () => 0 },
    location: { href: "https://example.com/", origin: "https://example.com" }, URL,
    LexendSettings: { ...api, resolveSite(...args) { stats.resolves++; return api.resolveSite(...args); } },
    setTimeout(callback) { const id = ++taskId; tasks.set(id, callback); return id; },
    clearTimeout(id) { tasks.delete(id); }, console,
    browser: {
      runtime: {
        getURL(path) { stats.fontUrls++; return `extension://${path}`; },
        async sendMessage(message) { notifications.push(message); },
        onMessage: { addListener(listener) { messageListener = listener; } }
      },
      storage: {
        sync: { get: getSettings ?? (async () => stored) },
        onChanged: { addListener(listener) { changeListener = listener; } }
      }
    }
  };
  runInNewContext(source, context);
  if (detector) runInNewContext(detectorSource, context);
  await tick();
  const runTask = async () => {
    const [id, callback] = tasks.entries().next().value;
    tasks.delete(id);
    const before = stats.visits;
    callback();
    await tick();
    return stats.visits - before;
  };
  const flush = async () => {
    await tick();
    let slices = 0;
    while (tasks.size) { assert(slices++ < 1000, "discovery must settle"); await runTask(); }
  };
  return {
    doc, html, body, stats, tasks, observers, notifications, runTask, flush, nativeAttachShadow,
    resetStats() { Object.keys(stats).forEach((key) => { stats[key] = 0; }); },
    documentStyled() { return Boolean(doc.getElementById(styleId) || doc.adoptedStyleSheets.some((sheet) => sheet.css.includes("Lexend for the Web"))); },
    change(changes) { changeListener(changes, "sync"); },
    state() { let response; messageListener({ type: "LEXEND_GET_STATE" }, {}, (state) => { response = state; }); return response; },
    host(parent = body) { const host = new Element(); const root = host.attachShadow(); root.append(new Element("p")); parent.append(host); return root; }
  };
}

const styleId = "lexend-the-web-styles";

test("paused pages do no DOM work and resume discovers hosts added while paused", async () => {
  const page = await openPage({ stored: { enabled: false } });
  page.resetStats();
  const shadow = page.host();
  await page.flush();
  assert.equal(page.tasks.size, 0);
  assert.equal(page.stats.callbacks, 0);
  assert.equal(page.stats.visits, 0);
  assert.equal(page.stats.fontUrls, 0);
  assert.equal(page.doc.getElementById(styleId), undefined);
  page.change({ enabled: { newValue: true } });
  await page.flush();
  assert(page.documentStyled());
  assert.equal(shadow.adoptedStyleSheets.length, 1);
});

test("discovery yields after 250 elements and pause cancels pending work", async () => {
  const page = await openPage();
  for (let i = 0; i < 600; i++) page.host();
  await tick();
  assert.equal(page.tasks.size, 1, "a mutation burst schedules one task");
  assert((await page.runTask()) <= 250);
  assert.equal(page.tasks.size, 1, "unfinished traversal resumes in another task");
  page.change({ enabled: { newValue: false } });
  await page.flush();
  assert.equal(page.tasks.size, 0);
  assert([...page.observers].every((observer) => !observer.root));
  assert.equal(page.doc.getElementById(styleId), undefined);
});

test("shared sheets update without rescanning; irrelevant preferences do no work", async () => {
  const page = await openPage();
  const roots = Array.from({ length: 30 }, () => page.host());
  await page.flush();
  const sheet = roots[0].adoptedStyleSheets[0];
  assert(roots.every((root) => root.adoptedStyleSheets[0] === sheet));
  page.resetStats();
  page.change({ theme: { newValue: "dark" } });
  page.change({ siteRules: { newValue: [{ hostname: "unrelated.example", enabled: false }] } });
  await page.flush();
  assert.equal(page.stats.styleWrites, 0);
  assert.equal(page.stats.sheetWrites, 0);
  assert.equal(page.stats.visits, 0);
  page.resetStats();
  page.change({ letterSpacing: { newValue: 0.08 } });
  await page.flush();
  assert.match(sheet.css, /letter-spacing: 0.08em/);
  assert.equal(page.stats.sheetWrites, 2);
  assert.equal(page.stats.styleWrites, 0);
  assert.equal(page.stats.visits, 0);
  assert.equal(page.stats.fontUrls, 0);
  assert.equal(page.stats.resolves, 1);
  assert.equal(page.notifications.length, 1, "typography changes do not resend toolbar state");
});

test("fallback styles are cleaned on detachment, pause and reattachment", async () => {
  const page = await openPage({ shared: false });
  const root = page.host();
  const nested = page.host(root);
  await page.flush();
  assert(root.getElementById(styleId));
  assert(nested.getElementById(styleId));
  root.host.remove();
  await page.flush();
  assert.equal(root.getElementById(styleId), undefined);
  assert.equal(nested.getElementById(styleId), undefined);
  page.change({ enabled: { newValue: false } });
  page.body.append(root.host);
  await page.flush();
  assert.equal(root.getElementById(styleId), undefined);
  page.change({ enabled: { newValue: true } });
  await page.flush();
  assert(root.getElementById(styleId));
  assert(nested.getElementById(styleId));
});

test("settings events received during startup override a stale storage snapshot", async () => {
  let resolveStorage;
  const page = await openPage({ getSettings: () => new Promise((resolve) => { resolveStorage = resolve; }) });
  assert.equal(page.state().ready, false);
  page.change({ enabled: { newValue: false } });
  resolveStorage({ enabled: true, textScale: 120 });
  await page.flush();
  assert.equal(page.state().ready, true);
  assert.equal(page.state().active, false);
  assert.equal(page.stats.styleWrites, 0);
  assert.equal(page.tasks.size, 0);
});

test("document-start initialization handles an HTML root arriving later", async () => {
  const page = await openPage({ emptyDocument: true });
  page.doc.documentElement = page.html;
  page.doc.append(page.html);
  const root = page.host();
  await page.flush();
  assert(page.documentStyled());
  assert.equal(root.adoptedStyleSheets.length, 1);
});

test("ordinary pages disconnect after discovery and CSS-only updates stay idle", async () => {
  const page = await openPage();
  await page.flush();
  assert.equal(page.state().discoveryMode, "css");
  assert([...page.observers].every((observer) => !observer.root));
  page.resetStats();
  for (let i = 0; i < 1000; i++) page.body.append(page.doc.createElement("p"));
  await page.flush();
  assert.equal(page.stats.callbacks, 0);
  assert.equal(page.stats.visits, 0);
  page.change({ letterSpacing: { newValue: 0.04 } });
  await page.flush();
  assert.equal(page.state().discoveryMode, "css");
  assert.equal(page.stats.callbacks, 0);
  assert.equal(page.stats.visits, 0);
  assert(page.doc.adoptedStyleSheets.some((sheet) => sheet.css.includes("letter-spacing: 0.04em")));
});

test("a shadow root attached to an existing host wakes a CSS-only page", async () => {
  const page = await openPage();
  const host = page.doc.createElement("div");
  page.body.append(host);
  await page.flush();
  assert.equal(page.state().discoveryMode, "css");
  const shadow = host.attachShadow();
  shadow.append(page.doc.createElement("p"));
  await page.flush();
  assert.equal(page.state().discoveryMode, "shadow");
  assert.equal(shadow.adoptedStyleSheets.length, 1);
});

for (const signal of ["first", "targeted", "watch"]) {
  test(`${signal} shadow discovery revisits hosts already passed in an unfinished scan`, async () => {
    const page = await openPage();
    const existing = signal === "first" ? null : page.host();
    const host = page.doc.createElement("div");
    page.body.append(host);
    for (let i = 0; i < 600; i++) page.body.append(page.doc.createElement("p"));
    await tick();
    await page.runTask();
    assert(page.tasks.size, "the first traversal is still in progress");
    let shadow;
    if (signal === "watch") {
      // Declarative parsing creates roots without calling attachShadow.
      shadow = host.shadowRoot = new existing.constructor(host);
      page.doc.dispatchEvent(new CustomEvent("lexend-shadow-state-v1", { detail: "watch" }));
    } else {
      shadow = host.attachShadow();
      if (signal === "targeted") {
        // The mock EventTarget lacks real DOM bubbling/composed paths.
        const event = new Event("lexend-shadow-attached-v1");
        Object.defineProperty(event, "composedPath", { value: () => [host] });
        page.doc.dispatchEvent(event);
      }
    }
    shadow.append(page.doc.createElement("p"));
    await page.flush();
    assert.equal(shadow.adoptedStyleSheets.length, 1);
  });
}

test("a missing detector retains discovery and style fallbacks stay observable", async () => {
  for (const options of [{ detector: false }, { shared: false }]) {
    const page = await openPage(options);
    await page.flush();
    assert.equal(page.state().discoveryMode, "fallback");
    assert([...page.observers].some((observer) => observer.root === page.doc));
    const root = page.host();
    await page.flush();
    assert(root.adoptedStyleSheets.length || root.getElementById(styleId));
  }
});

test("discovery continues until parsing finishes and catches declarative roots", async () => {
  const page = await openPage({ loading: true });
  await page.flush();
  assert.equal(page.state().discoveryMode, "discovering");
  page.doc.readyState = "interactive";
  page.doc.dispatchEvent(new Event("DOMContentLoaded"));
  await page.flush();
  assert.equal(page.state().discoveryMode, "css");
});

test("CSS-only document styles survive replacement of the HTML element", async () => {
  const page = await openPage();
  await page.flush();
  const sheet = page.doc.adoptedStyleSheets[0];
  page.html.remove();
  page.doc.documentElement = page.doc.createElement("html");
  page.doc.append(page.doc.documentElement);
  await page.flush();
  assert.equal(page.state().discoveryMode, "css");
  assert.equal(page.doc.adoptedStyleSheets[0], sheet);
  assert(page.documentStyled());
});

test("document adoption failure falls back once and repairs later style removal", async () => {
  const page = await openPage({ documentSheets: false });
  await page.flush();
  assert.equal(page.state().discoveryMode, "fallback");
  assert(page.doc.getElementById(styleId));
  page.resetStats();
  page.doc.getElementById(styleId).remove();
  await page.flush();
  assert(page.doc.getElementById(styleId));
  assert.equal(page.stats.sheetWrites, 0, "unsupported adoption is not retried on every mutation");
});

test("resuming rechecks detector hooks replaced while paused", async () => {
  const page = await openPage();
  await page.flush();
  assert.equal(page.state().discoveryMode, "css");
  page.change({ enabled: { newValue: false } });
  Object.getPrototypeOf(page.body).attachShadow = page.nativeAttachShadow;
  page.change({ enabled: { newValue: true } });
  await page.flush();
  assert.equal(page.state().discoveryMode, "fallback");
  const root = page.host();
  await page.flush();
  assert.equal(root.adoptedStyleSheets.length, 1);
});
