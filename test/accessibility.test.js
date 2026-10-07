import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const css = await readFile(new URL("../shared.css", import.meta.url), "utf8");
const luminance = (hex) => {
  const linear = [0, 2, 4].map((offset) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
  });
  return linear[0] * .2126 + linear[1] * .7152 + linear[2] * .0722;
};
test("accent text meets normal-text contrast in both interface themes", () => {
  const foreground = css.match(/--on-accent:\s*#([0-9a-f]{6})/i)[1];
  const accents = [...css.matchAll(/--accent:\s*#([0-9a-f]{6})/gi)].map((match) => match[1]);
  assert.equal(accents.length, 2);
  for (const background of accents) {
    const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
    assert((values[0] + .05) / (values[1] + .05) >= 4.5, `#${foreground} on #${background} must meet 4.5:1`);
  }
});
