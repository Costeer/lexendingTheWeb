// Replay the URLs from a real-site survey against the currently built extension.
// Existing captures are retained; a rerun creates a separate evidence directory.
import { parseArgs } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runHarness } from "./run.mjs";

const { values } = parseArgs({ options: {
  survey: { type: "string" }, output: { type: "string" },
  config: { type: "string" }, concurrency: { type: "string", default: "2" },
  indices: { type: "string" }
} });
if (!values.survey || !values.output || !values.config) throw new Error("Provide --survey summary.json --config config.json --output directory.");
const concurrency = Number(values.concurrency);
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error("Concurrency must be 1–4.");
const survey = JSON.parse(await readFile(values.survey, "utf8"));
const config = JSON.parse(await readFile(values.config, "utf8"));
const selected = values.indices ? new Set(values.indices.split(",").map(Number)) : null;
const queue = survey.pages.map((page, index) => ({ page, index })).filter(({ index }) => !selected || selected.has(index));
const directory = resolve(values.output);
await mkdir(directory, { recursive: true });
const summary = { createdAt: new Date().toISOString(), sourceSurvey: resolve(values.survey), config, pages: [] };
const esc = (text) => String(text ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
let writeQueue = Promise.resolve();
function save() {
  writeQueue = writeQueue.then(async () => {
    summary.pages.sort((a, b) => a.index - b.index);
    await writeFile(join(directory, "summary.json"), JSON.stringify(summary, null, 2));
    await writeFile(join(directory, "index.html"), `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Lexend remediation evidence</title><style>body{max-width:1100px;margin:32px auto;padding:0 20px;font:16px/1.6 system-ui;color:#17253a}article{border-top:1px solid #ccd3df;padding:20px 0}table{border-collapse:collapse}td,th{padding:8px;border:1px solid #ccd3df;text-align:left}a{color:#165cba}</style><h1>Lexend remediation evidence</h1><p>Fresh captures of live websites using generic typography and geometry rules. ${summary.pages.length}/${queue.length} attempts complete; ${summary.pages.filter((page) => page.status !== "capture-failed").length} captured and ${summary.pages.filter((page) => page.status === "capture-failed").length} failed. Automated counts do not establish readability: inspect every paired screenshot before assigning a visual verdict.</p><a href="summary.json">Machine-readable comparison</a>${summary.pages.map((entry) => `<article><h2><a href="${entry.report}">${esc(entry.url)}</a></h2><p>Previous visual result: ${esc(entry.previousVisualStatus)} · New result: ${esc(entry.status)}</p>${entry.error ? `<p>${esc(entry.error)}</p>` : `<table><tr><th>Viewport</th><th>Converted / eligible</th><th>Previous errors</th><th>New errors</th><th>Evidence</th></tr>${entry.cases.map((item) => `<tr><td>${esc(item.id)}</td><td>${item.converted}/${item.eligible}</td><td>${item.previousErrors}</td><td>${item.errors}</td><td>${item.incomplete ? "Incomplete" : "Captured"} · ${item.tiles} paired tiles</td></tr>`).join("")}</table>`}<p><a href="${entry.report}">Open screenshots and element findings</a></p></article>`).join("")}`);
  });
  return writeQueue;
}
await save();
let cursor = 0;
await Promise.all(Array.from({ length: concurrency }, async () => {
  while (cursor < queue.length) {
    const { page, index } = queue[cursor++];
    const name = `${String(index + 1).padStart(2, "0")}-${new URL(page.url).hostname.replace(/[^a-z0-9.-]/g, "-")}`;
    const output = join(directory, name);
    const entry = { index, url: page.url, previousVisualStatus: page.visualStatus, previousFindings: page.findings, report: `${name}/index.html` };
    try {
      const report = await runHarness({ url: page.url, output, config });
      Object.assign(entry, { status: report.status, extension: report.extension, cases: report.cases.map((item) => ({
        id: item.id, eligible: item.audit.eligible, converted: item.audit.converted,
        previousErrors: page.cases?.find((old) => old.id === item.id)?.errors ?? null,
        errors: item.audit.findings.filter((finding) => finding.severity === "error").length,
        errorCodes: [...new Set(item.audit.findings.filter((finding) => finding.severity === "error").map((finding) => finding.code))],
        incomplete: item.incomplete, tiles: item.tiles.length
      })) });
    } catch (error) {
      Object.assign(entry, { status: "capture-failed", error: error.message });
    }
    summary.pages.push(entry);
    await save();
  }
}));
console.log(`Remediation evidence: ${join(directory, "index.html")}`);
