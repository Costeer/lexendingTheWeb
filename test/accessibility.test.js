import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import "../src/settings.js";

const css = await readFile(new URL("../shared.css", import.meta.url), "utf8");
const luminance = (hex) => {
  const linear = [0, 2, 4].map((offset) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
  });
  return linear[0] * .2126 + linear[1] * .7152 + linear[2] * .0722;
};
const contrast = (a, b) => {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + .05) / (low + .05);
};

// Resolve each design's color tokens the way the cascade does on the root:
// base :root tokens, then the design's light block, then its dark block.
const blocks = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map(([, selector, body]) => ({
    selector: selector.trim(),
    tokens: Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*#([0-9a-f]{6})\b/gi)].map(([, name, hex]) => [name, hex]))
  }))
  .filter(({ tokens }) => Object.keys(tokens).length);
const resolve = (design, theme) => {
  const tokens = {};
  for (const { selector, tokens: declared } of blocks) {
    const dark = selector.includes('[data-theme="dark"]');
    const applies = selector === ":root"
      || (selector.includes(`[data-design="${design}"]`) && (!dark || theme === "dark"));
    if (applies) Object.assign(tokens, declared);
  }
  return tokens;
};

const designs = globalThis.LexendSettings.designs;
const cases = designs.flatMap((design) => ["light", "dark"].map((theme) => [design, theme, resolve(design, theme)]));

test("every design declares a complete color palette for both themes", () => {
  assert.deepEqual([...designs], ["signal", "paper"]);
  for (const [design, theme, tokens] of cases) {
    for (const name of ["--accent", "--on-accent", "--ink", "--ink-soft", "--surface", "--surface-sunken",
      "--accent-tint", "--accent-text", "--line-strong", "--line"]) {
      assert.ok(tokens[name], `${design} ${theme} defines ${name}`);
    }
  }
});

test("interface text keeps enhanced contrast in every design and theme", () => {
  for (const [design, theme, tokens] of cases) {
    const label = `${design} ${theme}`;
    for (const background of ["--surface", "--surface-sunken", "--accent-tint"]) {
      assert.ok(contrast(tokens["--ink"], tokens[background]) >= 12, `${label}: ink on ${background} stays at least 12:1`);
      assert.ok(contrast(tokens["--ink-soft"], tokens[background]) >= 7, `${label}: secondary text on ${background} meets 7:1`);
    }
    assert.ok(contrast(tokens["--on-accent"], tokens["--accent"]) >= 4.5, `${label}: text on the accent meets 4.5:1`);
    assert.ok(contrast(tokens["--accent-text"], tokens["--surface"]) >= 4.5, `${label}: red text meets 4.5:1`);
  }
});

test("control boundaries and the accent meet non-text contrast in every design and theme", () => {
  for (const [design, theme, tokens] of cases) {
    const label = `${design} ${theme}`;
    for (const background of ["--surface", "--surface-sunken"]) {
      assert.ok(contrast(tokens["--line-strong"], tokens[background]) >= 3, `${label}: control borders on ${background} meet 3:1`);
      assert.ok(contrast(tokens["--accent"], tokens[background]) >= 3, `${label}: accent frames on ${background} meet 3:1`);
    }
  }
});

test("the head script and settings agree on the available designs", async () => {
  const source = await readFile(new URL("../src/ui-theme.js", import.meta.url), "utf8");
  assert.match(source, new RegExp(`Object\\.freeze\\(\\[${designs.map((design) => `"${design}"`).join(", ")}\\]\\)`));
});
