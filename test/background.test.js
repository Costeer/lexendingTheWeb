import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import "../src/settings.js";
import "../src/preferences.js";

const source = await readFile(new URL("../src/background.js", import.meta.url), "utf8");

const event = () => ({
  addListener(listener) { this.listener = listener; }
});

function createBackground({ stored = {}, supported = true } = {}) {
  const messages = [];
  const writes = [];
  const icons = [];
  const browser = {
    action: {
      async setIcon(value) { icons.push(value); },
      async setTitle() {}
    },
    tabs: {
      // The manifest grants no permission to read tab URLs.
      async query() { return [{ id: 42 }]; },
      async sendMessage(tabId, message, options) {
        messages.push({ tabId, message, options });
        if (!supported) throw new Error("No content script");
        return { ready: true, active: true, hostname: "example.com" };
      },
      onUpdated: event(),
      onRemoved: event()
    },
    storage: {
      sync: {
        async get() { return stored; },
        async set(value) { stored = { ...stored, ...value }; writes.push(value); },
        async remove() {}
      },
      onChanged: event()
    },
    commands: { onCommand: event() },
    runtime: {
      onMessage: event(),
      onConnect: event(),
      id: "test-extension",
      getURL: (path) => `extension://test/${path}`,
      onInstalled: event(),
      onStartup: event()
    }
  };
  runInNewContext(source, { browser, LexendSettings: globalThis.LexendSettings, LexendPreferences: globalThis.LexendPreferences, console, URL });
  return { browser, messages, writes, icons };
}

test("keyboard shortcut toggles the main page without tab URL access", async () => {
  const { browser, messages, writes } = createBackground();
  await browser.commands.onCommand.listener("toggle-current-site");
  assert.equal(messages[0].tabId, 42);
  assert.equal(messages[0].options.frameId, 0);
  assert.equal(writes[0].siteRules[0].hostname, "example.com");
  assert.equal(writes[0].siteRules[0].enabled, false);

  await browser.commands.onCommand.listener("toggle-current-site");
  assert.equal(writes[1].siteRules.length, 0);
});

test("shortcut leaves settings unchanged when the page has no content script", async () => {
  const { browser, writes } = createBackground({ supported: false });
  await browser.commands.onCommand.listener("toggle-current-site");
  assert.equal(writes.length, 0);
});

test("toolbar state ignores messages from subframes", () => {
  const { browser, icons } = createBackground();
  browser.runtime.onMessage.listener(
    { type: "LEXEND_STATE", active: false }, { tab: { id: 42 }, frameId: 7 }
  );
  assert.equal(icons.length, 0);
  browser.runtime.onMessage.listener(
    { type: "LEXEND_STATE", active: true }, { tab: { id: 42 }, frameId: 0 }
  );
  assert.equal(icons.length, 1);
  assert.equal(icons[0].tabId, 42);
  assert.equal(icons[0].path["16"], "assets/icons/icon-16.png");
});

test("frame sizing messages still relay alongside the settings save handler", async () => {
  const { browser, messages, writes } = createBackground();
  const requirement = { viewportHeight: 48, requiredHeight: 80, baselineHeight: 48 };
  const sender = { id: browser.runtime.id, tab: { id: 42 }, frameId: 7, url: "https://embedded.example/frame" };
  const reply = await new Promise((resolve) => {
    assert.equal(browser.runtime.onMessage.listener({ type: "LEXEND_FRAME_REQUIREMENT", requirement }, sender, resolve), true);
  });
  assert.equal(reply.relayed, true);
  assert.equal(messages[0].message.type, "LEXEND_APPLY_FRAME_REQUIREMENT");
  assert.equal(messages[0].message.frameUrl, sender.url);
  assert.equal(messages[0].message.sourceFrameId, 7);
  assert.equal(writes.length, 0);
  browser.runtime.onMessage.listener({ type: "LEXEND_FRAME_REQUIREMENT", requirement }, { ...sender, id: "other-extension" }, () => assert.fail("Untrusted frames cannot relay"));
  assert.equal(messages.length, 1);
});

test("toolbar refresh requests the main frame's state", async () => {
  const { browser, messages, icons } = createBackground();
  browser.runtime.onStartup.listener();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].options.frameId, 0);
  assert.equal(icons.at(-1).tabId, 42);
});

test("repeated toolbar states avoid duplicate browser API calls and closed tabs release their state", async () => {
  const { browser, icons } = createBackground();
  const sender = { tab: { id: 42 }, frameId: 0 };
  browser.runtime.onMessage.listener({ type: "LEXEND_STATE", active: true }, sender);
  browser.runtime.onMessage.listener({ type: "LEXEND_STATE", active: true }, sender);
  assert.equal(icons.length, 1);
  browser.tabs.onUpdated.listener(42, { status: "loading" });
  browser.tabs.onUpdated.listener(42, { url: "https://example.com/next" });
  assert.equal(icons.length, 2);
  assert.equal(icons.at(-1).path["16"], "assets/icons/icon-off-16.png");
  browser.tabs.onRemoved.listener(42);
  browser.runtime.onMessage.listener({ type: "LEXEND_STATE", active: false }, sender);
  assert.equal(icons.length, 3);
});

test("a failed toolbar update can retry the same state", async () => {
  const { browser, icons } = createBackground();
  let attempts = 0;
  const setIcon = browser.action.setIcon;
  browser.action.setIcon = async (value) => {
    if (++attempts === 1) throw new Error("Tab temporarily unavailable");
    return setIcon(value);
  };
  const sender = { tab: { id: 42 }, frameId: 0 };
  browser.runtime.onMessage.listener({ type: "LEXEND_STATE", active: true }, sender);
  await new Promise((resolve) => setImmediate(resolve));
  browser.runtime.onMessage.listener({ type: "LEXEND_STATE", active: true }, sender);
  assert.equal(icons.length, 1);
});

test("single-page URL updates reconcile the toolbar with the main frame", async () => {
  const { browser, icons, messages } = createBackground();
  browser.runtime.onMessage.listener({ type: "LEXEND_STATE", active: true }, { tab: { id: 42 }, frameId: 0 });
  browser.tabs.onUpdated.listener(42, { url: "https://example.com/route" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(messages.at(-1).options.frameId, 0);
  assert.equal(icons.at(-1).path[16], "assets/icons/icon-16.png");
});

test("stale toolbar queries cannot override a newer document state or a closed tab", async () => {
  const { browser, icons } = createBackground();
  let respond;
  browser.tabs.sendMessage = () => new Promise((resolve) => { respond = resolve; });
  browser.tabs.onUpdated.listener(42, { url: "https://example.com/first" });
  browser.runtime.onMessage.listener({ type: "LEXEND_STATE", active: true }, { tab: { id: 42 }, frameId: 0 });
  respond({ ready: true, active: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(icons.at(-1).path[16], "assets/icons/icon-16.png");
  const count = icons.length;
  browser.tabs.onUpdated.listener(42, { status: "complete" });
  browser.tabs.onRemoved.listener(42);
  respond({ ready: true, active: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(icons.length, count);
});

test("only extension pages can use the settings mutation channel", async () => {
  const { browser, writes } = createBackground();
  const request = { type: "LEXEND_SETTINGS_MUTATE", operation: { type: "patch", changes: { theme: "dark" } } };
  let denied;
  browser.runtime.onMessage.listener(request, { id: "test-extension", url: "https://example.com", tab: { id: 42 } }, (value) => { denied = value; });
  assert.equal(denied.code, "FORBIDDEN");
  assert.equal(writes.length, 0);
  const response = await new Promise((resolve) => {
    assert.equal(browser.runtime.onMessage.listener(request, { id: "test-extension", url: "extension://test/options.html" }, resolve), true);
  });
  assert.equal(response.ok, true);
  assert.equal(writes[0].theme, "dark");
});

test("dedicated settings connections authorize the sender and reply only after saving", async () => {
  const { browser, writes } = createBackground();
  const responses = [];
  const port = { name: globalThis.LexendPreferences.connectionName,
    sender: { id: "test-extension", url: "extension://test/options.html" },
    onMessage: event(), onDisconnect: event(), postMessage(value) { responses.push(value); } };
  browser.runtime.onConnect.listener(port);
  port.onMessage.listener({ id: 1, operation: { type: "patch", changes: { textScale: 120 } } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(responses[0].id, 1);
  assert.equal(responses[0].ok, true);
  assert.equal(writes[0].textScale, 120);
  const denied = { ...port, sender: { id: "test-extension", url: "https://example.com" }, onMessage: event(), onDisconnect: event() };
  browser.runtime.onConnect.listener(denied);
  denied.onMessage.listener({ id: 2, operation: { type: "patch", changes: { theme: "dark" } } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(responses[1].code, "FORBIDDEN");
  assert.equal(writes.length, 1);
});

test("shortcut capacity failures show a toolbar error without dropping any rules", async () => {
  const rules = Array.from({ length: 250 }, (_, index) => ({ hostname: `site${index}.example.com`, enabled: false }));
  const { browser, writes } = createBackground({ stored: { siteRules: rules } });
  const badges = [];
  const titles = [];
  browser.action.setBadgeText = async (value) => { badges.push(value); };
  browser.action.setTitle = async (value) => { titles.push(value); };
  await browser.commands.onCommand.listener("toggle-current-site");
  assert.equal(writes.length, 0);
  assert.equal(badges.at(-1).text, "!");
  assert.match(titles.at(-1).title, /room/);
  browser.runtime.onMessage.listener({ type: "LEXEND_STATE", active: true }, { tab: { id: 42 }, frameId: 0 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(badges.at(-1).text, "");
});
