import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import "../src/settings.js";

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
        async set(value) { stored = value; writes.push(value); },
        async remove() {}
      },
      onChanged: event()
    },
    commands: { onCommand: event() },
    runtime: {
      onMessage: event(),
      onInstalled: event(),
      onStartup: event()
    }
  };
  runInNewContext(source, { browser, LexendSettings: globalThis.LexendSettings, console });
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
