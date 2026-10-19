import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import "../src/settings.js";

const source = await readFile(new URL("../about.js", import.meta.url), "utf8");
const themeSource = await readFile(new URL("../src/ui-theme.js", import.meta.url), "utf8");

async function openAbout(get, { cachedTheme, cachedDesign } = {}) {
  const root = { dataset: {} };
  const cache = new Map([
    ...(cachedTheme ? [["lexend-ui-theme", cachedTheme]] : []),
    ...(cachedDesign ? [["lexend-ui-design", cachedDesign]] : [])
  ]);
  let onChanged;
  const errors = [];
  const context = {
    document: { documentElement: root, getElementById: () => null },
    localStorage: {
      getItem: (key) => cache.get(key) ?? null,
      setItem: (key, value) => cache.set(key, value)
    },
    LexendSettings: globalThis.LexendSettings,
    browser: {
      storage: {
        sync: { get },
        onChanged: { addListener(listener) { onChanged = listener; } }
      }
    },
    console: { error(...args) { errors.push(args); } }
  };
  runInNewContext(themeSource, context);
  runInNewContext(source, context);
  await new Promise((resolve) => setImmediate(resolve));
  return { root, cache, onChanged, errors };
}

test("About loads the saved theme and follows only synced theme changes", async () => {
  const { root, onChanged } = await openAbout(async () => ({ theme: "dark" }));
  assert.equal(root.dataset.theme, "dark");
  onChanged({ theme: { newValue: "light" } }, "local");
  assert.equal(root.dataset.theme, "dark");
  onChanged({ enabled: { newValue: false } }, "sync");
  assert.equal(root.dataset.theme, "dark");
  onChanged({ theme: { newValue: "light" } }, "sync");
  assert.equal(root.dataset.theme, "light");
  onChanged({ theme: { newValue: "dark" } }, "sync");
  assert.equal(root.dataset.theme, "dark");
  onChanged({ theme: {} }, "sync");
  assert.equal(root.dataset.theme, "light");
});

test("About loads the saved design and follows synced design changes independently of theme", async () => {
  const { root, cache, onChanged } = await openAbout(async () => ({ theme: "dark", design: "paper" }));
  assert.equal(root.dataset.design, "paper");
  onChanged({ design: { newValue: "signal" } }, "local");
  assert.equal(root.dataset.design, "paper");
  onChanged({ theme: { newValue: "light" } }, "sync");
  assert.equal(root.dataset.design, "paper", "a theme change leaves the design alone");
  onChanged({ design: { newValue: "signal" } }, "sync");
  assert.equal(root.dataset.design, "signal");
  assert.equal(cache.get("lexend-ui-design"), "signal");
  onChanged({ design: { newValue: "paper" } }, "sync");
  assert.equal(cache.get("lexend-ui-design"), "paper");
  onChanged({ design: {} }, "sync");
  assert.equal(root.dataset.design, "signal");
});

test("About keeps the cached design while loading and after a failed read", async () => {
  const failed = await openAbout(async () => { throw new Error("Storage unavailable"); }, { cachedDesign: "paper" });
  assert.equal(failed.root.dataset.design, "paper");
  let resolveSettings;
  const page = await openAbout(() => new Promise((resolve) => { resolveSettings = resolve; }), { cachedDesign: "signal" });
  page.onChanged({ design: { newValue: "paper" } }, "sync");
  resolveSettings({ design: "signal" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(page.root.dataset.design, "paper", "an older initial read cannot replace a newer synced design");
});

test("About remains readable when stored preferences cannot be loaded", async () => {
  const { root, errors } = await openAbout(async () => { throw new Error("Storage unavailable"); });
  assert.equal(root.dataset.theme, "light");
  assert.equal(errors.length, 1);
});

test("About keeps the cached dark theme while synced settings load and on a failed read", async () => {
  let resolveSettings;
  const pending = new Promise((resolve) => { resolveSettings = resolve; });
  const page = await openAbout(() => pending, { cachedTheme: "dark" });
  assert.equal(page.root.dataset.theme, "dark", "startup must not reset the head script's theme");
  resolveSettings({ theme: "dark" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(page.root.dataset.theme, "dark");
  page.onChanged({ theme: { newValue: "light" } }, "sync");
  assert.equal(page.cache.get("lexend-ui-theme"), "light", "navigation cache follows the saved theme");

  const failed = await openAbout(async () => { throw new Error("Storage unavailable"); }, { cachedTheme: "dark" });
  assert.equal(failed.root.dataset.theme, "dark");
  assert.equal(failed.cache.get("lexend-ui-theme"), "dark");
  assert.equal(failed.errors.length, 1);
});

test("About ignores an older initial theme read after a synced theme change or deletion", async () => {
  for (const newValue of ["dark", undefined]) {
    let resolveSettings;
    const page = await openAbout(() => new Promise((resolve) => { resolveSettings = resolve; }));
    page.onChanged({ theme: { newValue } }, "sync");
    resolveSettings({ theme: newValue === "dark" ? "light" : "dark" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(page.root.dataset.theme, newValue ?? "light");
    assert.equal(page.cache.get("lexend-ui-theme"), newValue ?? "light");
  }
});

function openSupport({ reducedMotion = false, focusVisible = true } = {}) {
  const listeners = new Map();
  const particles = new Set();
  const animations = [];
  const light = new Map();
  const motion = {
    matches: reducedMotion,
    addEventListener(type, listener) { this.onChange = listener; }
  };
  const layer = { append(piece) { particles.add(piece); } };
  const card = {
    style: { setProperty: (name, value) => light.set(name, value) },
    matches: (selector) => selector === ":focus-visible" && focusVisible,
    getBoundingClientRect: () => ({ left: 100, top: 40, width: 660, height: 300 }),
    addEventListener(type, listener) { listeners.set(type, listener); }
  };
  runInNewContext(source, {
    document: {
      documentElement: { dataset: {} },
      getElementById: (id) => id === "donate-link" ? card : layer,
      createElement() {
        const piece = {
          remove() { particles.delete(piece); },
          animate(keyframes, options) {
            const animation = {
              keyframes,
              options,
              cancel() { this.oncancel(); }
            };
            animations.push(animation);
            return animation;
          }
        };
        return piece;
      }
    },
    LexendSettings: globalThis.LexendSettings,
    matchMedia: () => motion,
    console
  });
  return {
    particles, animations, motion, light,
    trigger: (type, event = {}) => listeners.get(type)({ type, ...event }),
    finish: () => animations.forEach((animation) => animation.onfinish())
  };
}

test("support confetti starts at the cursor on every entry without a cooldown", () => {
  const support = openSupport();
  support.trigger("pointerenter", { pointerType: "mouse", clientX: 412, clientY: 157 });
  assert.equal(support.particles.size, 16);
  for (const animation of support.animations) {
    assert.match(animation.keyframes[0].transform, /^translate\(412px, 157px\)/);
    assert.equal(animation.keyframes[0].opacity, 1);
    assert.ok(animation.options.duration >= 650 && animation.options.duration <= 850);
    assert.equal(animation.options.easing, "linear");
    assert.doesNotMatch(animation.keyframes.at(-1).transform, /scale/);
    assert.equal(animation.keyframes.at(-1).opacity, 0);
  }
  support.trigger("pointerenter", { pointerType: "mouse", clientX: 600, clientY: 280 });
  assert.equal(support.particles.size, 32, "re-entry immediately adds a fresh burst");
  assert.match(support.animations[16].keyframes[0].transform, /^translate\(600px, 280px\)/);
  support.finish();
  assert.equal(support.particles.size, 0);
});

test("the supplied support widget's light follows the pointer without emitting more confetti", () => {
  const support = openSupport();
  support.trigger("pointermove", { pointerType: "mouse", clientX: 220, clientY: 130 });
  assert.equal(support.light.get("--support-mx"), "120px");
  assert.equal(support.light.get("--support-my"), "90px");
  assert.equal(support.particles.size, 0);
  support.trigger("pointermove", { pointerType: "touch", clientX: 350, clientY: 250 });
  assert.equal(support.light.get("--support-mx"), "120px");
  support.motion.matches = true;
  support.trigger("pointermove", { pointerType: "mouse", clientX: 350, clientY: 250 });
  assert.equal(support.light.get("--support-my"), "90px");
});

test("rapid support re-entry keeps a bounded particle count without skipping bursts", () => {
  const support = openSupport();
  for (let entry = 0; entry < 10; entry += 1) {
    support.trigger("pointerenter", { pointerType: "mouse", clientX: entry, clientY: 50 });
    assert.ok(support.particles.size <= 64);
    assert.equal(support.animations.length, (entry + 1) * 16);
    assert.match(support.animations.at(-1).keyframes[0].transform, new RegExp(`^translate\\(${entry}px, 50px\\)`));
  }
  support.finish();
  assert.equal(support.particles.size, 0);
});

test("keyboard focus celebrates at the card center but pointer focus does not duplicate hover", () => {
  const support = openSupport();
  support.trigger("focus");
  assert.equal(support.particles.size, 16);
  assert.match(support.animations[0].keyframes[0].transform, /^translate\(430px, 190px\)/);
  const pointer = openSupport({ focusVisible: false });
  pointer.trigger("pointerenter", { pointerType: "mouse", clientX: 200, clientY: 100 });
  pointer.trigger("focus");
  assert.equal(pointer.particles.size, 16);
});

test("support confetti skips touch hover and reduced motion, including live changes", () => {
  const support = openSupport();
  support.trigger("pointerenter", { pointerType: "touch" });
  assert.equal(support.particles.size, 0);
  support.trigger("focus");
  assert.equal(support.particles.size, 16);
  support.motion.matches = true;
  support.motion.onChange();
  assert.equal(support.particles.size, 0, "enabling reduced motion cancels and removes particles");
  support.trigger("focus");
  assert.equal(support.particles.size, 0);

  const reduced = openSupport({ reducedMotion: true });
  reduced.trigger("pointerenter", { pointerType: "mouse" });
  reduced.trigger("focus");
  assert.equal(reduced.animations.length, 0);
});
