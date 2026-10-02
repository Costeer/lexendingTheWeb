// Internal regression check for the harness. Website testing uses --url.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runHarness } from "./run.mjs";
import { root, serveDirectory } from "./server.mjs";

const server = await serveDirectory(join(root, "harness/fixtures"));
try {
  const output = join(root, "artifacts", `harness-self-test-${Date.now()}`);
  const report = await runHarness({
    url: server.url,
    output,
    config: {
      profiles: [{ name: "all-readable", settings: { scope: "all", textScale: 110, lineHeight: 1.6, letterSpacing: 0.02 } }],
      viewports: [{ name: "mobile", width: 390, height: 844 }],
      actions: [{ type: "click", locator: "summary" }, { type: "click", locator: "#add-content" }],
      afterActions: [{ type: "click", locator: "#add-content" }]
    }
  });
  const findings = report.cases[0].audit.findings;
  assert.ok(report.cases[0].audit.eligible > 30);
  assert.ok(!findings.some((finding) => finding.code === "unconverted" && (finding.path.includes("priority") || finding.text.startsWith("An author"))));
  assert.ok(!findings.some((finding) => finding.code === "new-clipping" && finding.text.startsWith("A fixed height")));
  assert.ok(findings.some((finding) => finding.code === "unpaired-element" && finding.text.startsWith("Dynamically")));
  assert.ok(!findings.some((finding) => finding.code === "unconverted" && finding.text.startsWith("Dynamically")));
  assert.ok(!findings.some((finding) => finding.code === "unconverted" && finding.text.startsWith("Typography inside")));
  assert.ok(!findings.some((finding) => finding.code === "unconverted" && finding.text.startsWith("Frame paragraphs")));
  const elements = JSON.parse(await readFile(join(output, "mobile-all-readable/elements.json"), "utf8"));
  assert.ok(elements.after[0].elements.some((element) => element.text.startsWith("An author") && element.fontFamily.startsWith('"Lexend for the Web"')));
  assert.equal(elements.after.length, 3);
  for (const frame of elements.after.slice(1)) {
    assert.ok(frame.elements.some((element) => element.text.startsWith("Frame paragraphs") && element.fontFamily.startsWith('"Lexend for the Web"')));
  }
  assert.ok(elements.after[2].url.startsWith("http://127.0.0.2:"));
  assert.notEqual(report.status, "passed");
  assert.equal(report.cases[0].incomplete, true, "changing DOM cannot silently pass");
  console.log("Harness regression checks passed: conversion, layout repair, dynamic DOM, shadow roots, and frames.");
} finally {
  await server.close();
}
