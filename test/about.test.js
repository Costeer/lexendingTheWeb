import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import "../src/settings.js";

const source = await readFile(new URL("../about.js", import.meta.url), "utf8");

async function openAbout(get) {
  const root = { dataset: {} };
  let onChanged;
  const errors = [];
  runInNewContext(source, {
    document: { documentElement: root, getElementById: () => null },
    LexendSettings: globalThis.LexendSettings,
    browser: {
      storage: {
        sync: { get },
        onChanged: { addListener(listener) { onChanged = listener; } }
      }
    },
    console: { error(...args) { errors.push(args); } }
  });
  await new Promise((resolve) => setImmediate(resolve));
  return { root, onChanged, errors };
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

test("About remains readable when stored preferences cannot be loaded", async () => {
  const { root, errors } = await openAbout(async () => { throw new Error("Storage unavailable"); });
  assert.equal(root.dataset.theme, "light");
  assert.equal(errors.length, 1);
});

function openSupport({ reducedMotion = false } = {}) {
  const listeners = new Map();
  const particles = new Set();
  const animations = [];
  const motion = {
    matches: reducedMotion,
    addEventListener(type, listener) { this.onChange = listener; }
  };
  let now = 0;
  const layer = { append(piece) { particles.add(piece); } };
  const card = {
    querySelector(selector) {
      return selector === ".support-confetti" ? layer : {
        getBoundingClientRect: () => ({ left: 400, top: 80, width: 160, height: 160 })
      };
    },
    getBoundingClientRect: () => ({ left: 100, top: 40, width: 660, height: 300 }),
    addEventListener(type, listener) { listeners.set(type, listener); }
  };
  runInNewContext(source, {
    document: {
      documentElement: { dataset: {} },
      getElementById: () => card,
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
    performance: { now: () => now },
    console
  });
  return {
    particles, animations, motion,
    trigger: (type, event = {}) => listeners.get(type)(event),
    advance: (value) => { now += value; },
    finish: () => animations.forEach((animation) => animation.onfinish())
  };
}

test("support hover emits one bounded confetti burst and cleans up finished particles", () => {
  const support = openSupport();
  support.trigger("pointerenter", { pointerType: "mouse" });
  assert.equal(support.particles.size, 28);
  for (const animation of support.animations) {
    assert.ok(animation.options.duration >= 1000 && animation.options.duration <= 1400);
    assert.equal(animation.keyframes.at(-1).opacity, 0);
  }
  support.trigger("focus");
  support.advance(1500);
  support.trigger("pointerenter", { pointerType: "mouse" });
  assert.equal(support.animations.length, 28, "overlapping bursts are ignored");
  support.finish();
  assert.equal(support.particles.size, 0);
  support.trigger("focus");
  assert.equal(support.particles.size, 28, "keyboard focus can celebrate after cleanup");
  support.finish();
  support.trigger("pointerenter", { pointerType: "mouse" });
  assert.equal(support.particles.size, 0, "rapid repeat entries respect the cooldown");
});

test("support confetti skips touch hover and reduced motion, including live changes", () => {
  const support = openSupport();
  support.trigger("pointerenter", { pointerType: "touch" });
  assert.equal(support.particles.size, 0);
  support.trigger("focus");
  assert.equal(support.particles.size, 28);
  support.motion.matches = true;
  support.motion.onChange();
  assert.equal(support.particles.size, 0, "enabling reduced motion cancels and removes particles");
  support.advance(2000);
  support.trigger("focus");
  assert.equal(support.particles.size, 0);

  const reduced = openSupport({ reducedMotion: true });
  reduced.trigger("pointerenter", { pointerType: "mouse" });
  reduced.trigger("focus");
  assert.equal(reduced.animations.length, 0);
});
