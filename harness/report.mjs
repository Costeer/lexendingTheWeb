import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
export async function writeReport(directory, report) {
  await writeFile(join(directory, "results.json"), JSON.stringify(report, null, 2));
  let hasReviewTemplate = false;
  try {
    await access(join(directory, "review-template.json"));
    hasReviewTemplate = true;
  } catch {
    // Interrupted captures retain evidence but cannot be formally reviewed.
  }
  const cases = report.cases.map((item) => `<section id="${escape(item.id)}">
    <h2>${escape(item.name)} <span>${item.viewport.width} × ${item.viewport.height}</span></h2>
    <p>${item.audit.converted}/${item.audit.eligible} eligible elements converted · ${item.audit.excluded} preserved elements · ${item.audit.findings.filter((finding) => finding.severity === "error").length} errors · ${item.audit.findings.filter((finding) => finding.severity === "review").length} review flags</p>
    <p><a href="${item.id}/before-full.png">Before page overview</a> · <a href="${item.id}/after-full.png">After page overview</a> · <a href="${item.id}/elements.json">Every audited element</a></p>
    <details><summary>Element findings (${item.audit.findings.length})</summary><table><thead><tr><th>Finding</th><th>Element / text</th><th>Detail</th></tr></thead><tbody>${item.audit.findings.map((finding) => `<tr><td><strong>${escape(finding.code)}</strong><br>${escape(finding.severity)}</td><td><code>${escape(finding.path)}</code><br>${escape(finding.text)}</td><td>${escape(finding.message)}</td></tr>`).join("")}</tbody></table></details>
    ${item.limitations.length ? `<details><summary>Inspection limitations (${item.limitations.length})</summary><ul>${item.limitations.map((limitation) => `<li>${escape(limitation.reason)} ${escape(limitation.path ?? "")}</li>`).join("")}</ul></details>` : ""}
    ${item.tiles.map((tile) => `<article><h3>${escape(tile.id)} · scroll position ${tile.y}px</h3><div class="pair"><figure><figcaption>Before · extension paused</figcaption><a href="${tile.before}"><img loading="lazy" src="${tile.before}" alt="Before conversion, ${escape(tile.id)}"></a></figure><figure><figcaption>After · ${escape(item.profile.name)}</figcaption><a href="${tile.after}"><img loading="lazy" src="${tile.after}" alt="After conversion, ${escape(tile.id)}"></a></figure></div></article>`).join("")}
    </section>`).join("");
  await writeFile(join(directory, "index.html"), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Lexend visual compatibility report</title>
    <style>body{margin:0;font:16px/1.6 system-ui;background:#f3f5f8;color:#1b2c42}main{max-width:1600px;margin:auto;padding:28px}header,section{background:white;padding:24px;margin-bottom:24px;border:1px solid #dae2eb;border-radius:12px}h1{margin:0;font-size:30px}h2{font-size:23px}h2 span{font-size:16px;color:#54647a}.status{display:inline-block;background:#fff0c2;padding:5px 12px;border-radius:6px;font-weight:700}.pair{display:grid;grid-template-columns:1fr 1fr;gap:20px}figure{margin:0;min-width:0}figcaption{font-weight:600;padding:8px 0}img{display:block;width:100%;border:1px solid #dce3eb}a{color:#145cc2}code{overflow-wrap:anywhere;font-size:12px}table{width:100%;border-collapse:collapse}td,th{padding:10px;border-bottom:1px solid #dae2eb;text-align:left;vertical-align:top}details{margin:16px 0}summary{cursor:pointer;font-weight:600}article{margin:28px 0}nav{display:flex;gap:12px;flex-wrap:wrap}@media(max-width:700px){main{padding:12px}.pair{grid-template-columns:1fr}header,section{padding:16px}}</style>
    <main><header><p class="status">${escape(report.status)}</p><h1>Lexend visual compatibility report</h1><p>${escape(report.url)}<br>Real unpacked Chromium extension · ${escape(report.createdAt)}</p>
    <p>Inspect <strong>every paired tile</strong> at its native resolution. Check that text is easier to read, controls work, icons retain their meaning, and nothing overlaps, clips, disappears, or loses contrast. The automated audit cannot establish subjective readability.</p>
    <p><a href="results.json">Machine-readable results</a>${hasReviewTemplate ? ' · <a href="review-template.json">Agent review template</a>' : ""}</p>
    ${report.captureError ? `<p>Capture error: ${escape(report.captureError)}</p>` : ""}
    ${report.review ? `<p>Reviewer: ${escape(report.review.reviewer)} · Verdict: ${escape(report.review.verdict)}</p><p>${escape(report.review.summary)}</p>` : ""}
    <nav>${report.cases.map((item) => `<a href="#${escape(item.id)}">${escape(item.name)}</a>`).join("")}</nav></header>${cases}</main></html>`);
}

export function validateReview(report, review) {
  const errors = [];
  if (report.captureError || report.cases.length === 0) errors.push("Capture must complete before review.");
  if (review.runId !== report.runId) errors.push("Review runId does not match this run.");
  if (typeof review.reviewer !== "string" || !review.reviewer.trim()) errors.push("A reviewer is required.");
  if (typeof review.summary !== "string" || !review.summary.trim()) errors.push("A concrete summary is required.");
  if (!["pass", "fail"].includes(review.verdict)) errors.push("Verdict must be pass or fail.");
  const expected = report.cases.flatMap((item) => item.tiles.map((tile) => tile.id));
  const inspected = review.inspectedTiles ?? [];
  if (!Array.isArray(inspected) || expected.some((id) => !inspected.includes(id))) errors.push("Every screenshot tile must be inspected.");
  if (Array.isArray(inspected) && inspected.some((id) => !expected.includes(id))) errors.push("Review names an unknown screenshot tile.");
  for (const item of report.cases) {
    const assessment = review.cases?.find((candidate) => candidate.id === item.id);
    if (!assessment || typeof assessment.notes !== "string" || !assessment.notes.trim()) { errors.push(`${item.id}: case notes are required.`); continue; }
    for (const key of ["moreReadable", "allEligibleTextConverted", "layoutIntact", "controlsUsable", "protectedContentIntact"]) {
      if (typeof assessment[key] !== "boolean") errors.push(`${item.id}: ${key} requires an explicit true/false assessment.`);
      if (review.verdict === "pass" && assessment[key] !== true) errors.push(`${item.id}: ${key} must be true to pass.`);
    }
    const flags = item.audit.findings.filter((finding) => finding.severity === "review");
    for (const [index] of flags.entries()) {
      const explanation = assessment.flagNotes?.[index];
      if (typeof explanation !== "string" || !explanation.trim()) errors.push(`${item.id}: review flag ${index} needs an explanation.`);
    }
    for (const [index] of item.limitations.entries()) {
      const explanation = assessment.limitationNotes?.[index];
      if (typeof explanation !== "string" || !explanation.trim()) errors.push(`${item.id}: limitation ${index} needs an explanation.`);
    }
  }
  if (review.verdict === "pass" && report.cases.some((item) => item.audit.findings.some((finding) => finding.severity === "error"))) errors.push("Automated errors must be fixed and the site rerun before it can pass.");
  if (review.verdict === "pass" && report.cases.some((item) => item.audit.converted !== item.audit.eligible)) errors.push("Complete typeface conversion must be established for every eligible text element before it can pass.");
  if (review.verdict === "pass" && report.cases.some((item) => item.incomplete)) errors.push("Incomplete evidence must be recaptured before it can pass.");
  return errors;
}

export async function applyReview(directory, reviewFile) {
  const report = JSON.parse(await readFile(join(directory, "results.json"), "utf8"));
  const review = JSON.parse(await readFile(reviewFile, "utf8"));
  const errors = validateReview(report, review);
  if (errors.length) throw new Error(errors.join("\n"));
  report.review = review;
  report.status = review.verdict === "pass" ? "passed" : "failed";
  await writeReport(directory, report);
  return report;
}

export function reviewTemplate(report) {
  return {
    runId: report.runId, reviewer: "", verdict: "", summary: "", inspectedTiles: [],
    cases: report.cases.map((item) => ({
      id: item.id, moreReadable: null, allEligibleTextConverted: null, layoutIntact: null,
      controlsUsable: null, protectedContentIntact: null, notes: "",
      flagNotes: item.audit.findings.filter((finding) => finding.severity === "review").map(() => ""),
      limitationNotes: item.limitations.map(() => "")
    }))
  };
}
