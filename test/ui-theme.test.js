import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";

const source = await readFile(new URL("../src/ui-theme.js", import.meta.url), "utf8");

function openPage(cache, { readFails = false, writeFails = false } = {}) {
  const root = { dataset: {} };
  const context = {
    document: { documentElement: root },
    localStorage: {
      getItem(key) {
        if (readFails) throw new Error("Storage unavailable");
        return cache.get(key) ?? null;
      },
      setItem(key, value) {
        if (writeFails) throw new Error("Storage unavailable");
        cache.set(key, value);
      }
    }
  };
  runInNewContext(source, context);
  return { root, theme: context.LexendTheme };
}

test("theme bootstrap applies dark synchronously and preserves it across page navigation", () => {
  const cache = new Map([["lexend-ui-theme", "dark"]]);
  const about = openPage(cache);
  assert.equal(about.root.dataset.theme, "dark");
  const settings = openPage(cache);
  assert.equal(settings.root.dataset.theme, "dark");
  settings.theme.apply("light");
  assert.equal(openPage(cache).root.dataset.theme, "light");
  about.theme.apply("dark");
  assert.equal(openPage(cache).root.dataset.theme, "dark");
});

test("theme bootstrap defaults to light for missing or invalid cache values", () => {
  for (const value of [undefined, "unknown", "<script>", "light"]) {
    const cache = new Map(value ? [["lexend-ui-theme", value]] : []);
    const page = openPage(cache);
    assert.equal(page.root.dataset.theme, "light");
    assert.equal(cache.get("lexend-ui-theme"), "light");
  }
});

test("design bootstrap applies the cached design synchronously and normalizes unknown values", () => {
  const cache = new Map([["lexend-ui-design", "paper"]]);
  const page = openPage(cache);
  assert.equal(page.root.dataset.design, "paper");
  assert.deepEqual([...page.theme.designs], ["signal", "paper"]);
  assert.equal(page.theme.applyDesign("signal"), "signal");
  assert.equal(openPage(cache).root.dataset.design, "signal");
  for (const value of [undefined, "classic", "wide", "<script>"]) {
    const fresh = new Map(value ? [["lexend-ui-design", value]] : []);
    assert.equal(openPage(fresh).root.dataset.design, "signal");
    assert.equal(fresh.get("lexend-ui-design"), "signal");
  }
  assert.equal(openPage(new Map([["lexend-ui-design", "paper"]]), { readFails: true }).root.dataset.design, "signal");
});

test("theme application works even when cache reads or writes are unavailable", () => {
  const cache = new Map([["lexend-ui-theme", "dark"]]);
  const unavailable = openPage(cache, { readFails: true, writeFails: true });
  assert.equal(unavailable.root.dataset.theme, "light");
  unavailable.theme.apply("dark");
  assert.equal(unavailable.root.dataset.theme, "dark");
  const readOnly = openPage(cache, { writeFails: true });
  assert.equal(readOnly.root.dataset.theme, "dark");
  readOnly.theme.apply("light");
  assert.equal(readOnly.root.dataset.theme, "light");
});
