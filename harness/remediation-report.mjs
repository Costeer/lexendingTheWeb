// Combine retained live captures and targeted agent reviews without converting
// a targeted repair assessment into a whole-page compatibility verdict.
import { parseArgs } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { relative, resolve, join } from "node:path";

const { values } = parseArgs({ options: {
  survey: { type: "string" }, output: { type: "string" },
  captures: { type: "string", multiple: true }, reviews: { type: "string", multiple: true }
} });
if (!values.survey || !values.output) throw new Error("Provide --survey summary.json --output directory, with --captures and --reviews files.");
const directory = resolve(values.output);
await mkdir(directory, { recursive: true });
const read = async (path) => JSON.parse(await readFile(path, "utf8"));
const survey = await read(values.survey);
const captures = await Promise.all((values.captures ?? []).map(async (path) => ({ path: resolve(path), data: await read(path) })));
const reviews = await Promise.all((values.reviews ?? []).map(async (path) => ({ path: resolve(path), data: await read(path) })));
const link = (path) => relative(directory, resolve(path)).split("\\").join("/");
const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const asList = (value) => value == null ? [] : Array.isArray(value) ? value : [value];
const normalizeFinding = (finding) => ({ ...finding,
  description: finding.description ?? finding.issue ?? finding.finding ?? finding.originalDescription ?? finding.originalIssue ?? finding.text ?? finding.id ?? "Reported issue",
  disposition: finding.disposition ?? finding.status,
  notes: finding.notes ?? finding.assessment ?? finding.detail });
const evidenceLink = (evidence, source) => {
  const path = typeof evidence === "string" ? evidence : evidence?.path;
  if (!path) return { path: String(evidence), href: null };
  const absolute = path.startsWith("artifacts/") || path.startsWith("/")
    ? resolve(path) : resolve(source, "..", path);
  return { path, href: existsSync(absolute) ? link(absolute) : null };
};
const pages = survey.pages.map((page, index) => ({
  index, url: page.url, originalStatus: page.visualStatus,
  originalFindings: (page.findings ?? []).map(normalizeFinding),
  captures: captures.flatMap(({ path, data }) => data.pages.filter((entry) => entry.url === page.url)
    .map((entry) => ({ ...entry, createdAt: data.createdAt, summary: link(path), report: link(resolve(path, "..", entry.report)) }))).reverse(),
  reviews: reviews.flatMap(({ path, data }) => [...(data.pages ?? data.records ?? []), ...asList(data.separateLatestSourcePackageProof)].filter((entry) => entry.url === page.url
    || (entry.directory && Number(entry.directory.split("-")[0]) === index + 1))
    .map((entry) => ({ ...entry, reviewSource: link(path), reviewScope: data.scope ?? data.assessmentScope,
      // The three workers use separate schemas; retain originals and expose a
      // common list for reading without discarding their limits or evidence.
      findings: (entry.originalFindings ?? entry.findings ?? entry.originalSurveyFindings ?? (entry.finding ? [entry] : [])).map(normalizeFinding),
      assessment: entry.assessment ?? entry.notes ?? entry.detail,
      limitations: [entry.remainingOrLimitations, ...asList(entry.limitations), ...asList(entry.limits)].filter(Boolean),
      inspectedEvidence: [...new Set([...asList(entry.inspectedEvidence), ...asList(entry.evidence), ...asList(entry.nativeEvidence), ...asList(entry.diagnostic),
        ...(entry.originalFindings ?? entry.findings ?? entry.originalSurveyFindings ?? []).flatMap((finding) => asList(finding.evidence))])]
        .map((evidence) => evidenceLink(evidence, path)),
      newIssues: (entry.newIssues ?? entry.newFindings ?? []).map(normalizeFinding) }))).reverse()
}));
await writeFile(join(directory, "summary.json"), JSON.stringify({ createdAt: new Date().toISOString(), pages }, null, 2));
const findingList = (findings) => findings.length ? `<ul>${findings.map((finding) => `<li><strong>${escape(finding.disposition ?? finding.status ?? "Observation")}</strong>: ${escape(finding.description)}${finding.notes ? `<p>${escape(finding.notes)}</p>` : ""}</li>`).join("")}</ul>` : "<p>No findings recorded in this targeted review.</p>";
const assessmentDetails = (review) => `${review.assessment ? `<p>${escape(review.assessment)}</p>` : ""}${review.reviewScope ? `<p>${escape(review.reviewScope)}</p>` : ""}${review.inspectedEvidence.length ? `<details><summary>Inspected evidence (${review.inspectedEvidence.length})</summary><ul>${review.inspectedEvidence.map((item) => `<li>${item.href ? `<a href="${escape(item.href)}">${escape(item.path)}</a>` : escape(item.path)}</li>`).join("")}</ul></details>` : ""}`;
const latestFull = [...captures].reverse().find(({ data }) => data.pages.length === pages.length);
const latestCapture = captures.at(-1);
const fingerprint = (capture) => capture?.data.pages.find((page) => page.extension?.sha256)?.extension.sha256;
const newerPages = new Set(captures.slice(captures.indexOf(latestFull) + 1)
  .filter((capture) => fingerprint(capture) === fingerprint(latestCapture))
  .flatMap((capture) => capture.data.pages.map((page) => page.url)));
const fullCounts = latestFull?.data.pages.reduce((counts, page) => {
  counts[page.status] = (counts[page.status] ?? 0) + 1;
  return counts;
}, {});
const coverageNote = latestFull ? `The latest full ${pages.length}-page replay recorded ${fullCounts["needs-visual-review"] ?? 0} captures without automated errors, ${fullCounts["automated-failures"] ?? 0} with automated findings, and ${fullCounts["capture-failed"] ?? 0} capture ${(fullCounts["capture-failed"] ?? 0) === 1 ? "failure" : "failures"}. ${latestCapture && fingerprint(latestCapture) !== fingerprint(latestFull) ? `A newer build was then checked on ${newerPages.size} distinct targeted pages; see each capture's build fingerprint.` : ""}` : "Each capture covers the pages listed in its run.";
await writeFile(join(directory, "index.html"), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>60-page Lexend repair review</title><style>body{font:16px/1.65 system-ui;color:#17253a;max-width:1120px;margin:32px auto;padding:0 24px}a{color:#135ba5}article{border-top:2px solid #d0d8e3;padding:20px 0}table{border-collapse:collapse;width:100%}td,th{border:1px solid #d0d8e3;padding:8px;text-align:left}p{max-width:85ch}summary{cursor:pointer;font-weight:bold}li p{margin:4px 0 12px}nav{display:flex;gap:12px;flex-wrap:wrap}</style><h1>60-page Lexend repair review</h1><p>Reusable typography and geometry repairs, checked against real websites at desktop and mobile widths. ${escape(coverageNote)} Original evidence is retained. Findings below are targeted assessments; they do not certify every page element or interaction. Open each capture to inspect paired screenshots and independent audit findings. Incomplete or failed captures remain explicit.</p><nav><a href="summary.json">Combined review data</a></nav><details><summary>Jump to a website</summary><nav>${pages.map((page) => `<a href="#page-${page.index + 1}">${page.index + 1}. ${escape(new URL(page.url).hostname)}</a>`).join("")}</nav></details><details><summary>Source review files</summary><nav>${reviews.map(({ path }) => `<a href="${escape(link(path))}">${escape(path.split("/").at(-1))}</a>`).join("")}</nav></details>${pages.map((page) => `<article id="page-${page.index + 1}"><h2>${page.index + 1}. ${escape(new URL(page.url).hostname)}</h2><p><a href="${escape(page.url)}">${escape(page.url)}</a> · Original result: ${escape(page.originalStatus)}</p><details><summary>Original reported issues (${page.originalFindings.length})</summary>${findingList(page.originalFindings)}</details>${page.captures.map((capture) => `<h3><a href="${escape(capture.report)}">Capture ${escape(capture.createdAt)} · ${escape(capture.status)} · build ${escape(capture.extension?.sha256?.slice(0, 8) ?? "unknown")}</a></h3>${capture.error ? `<p>${escape(capture.error)}</p>` : `<table><thead><tr><th>Viewport</th><th>Converted / eligible</th><th>Errors</th><th>Coverage evidence</th></tr></thead><tbody>${capture.cases.map((item) => `<tr><td>${escape(item.id)}</td><td>${item.converted}/${item.eligible}</td><td>${item.errors}</td><td>${item.incomplete ? "Incomplete" : "Captured"}, ${item.tiles} paired tiles</td></tr>`).join("")}</tbody></table>`}`).join("")}${page.reviews.map((review) => `<h3>Targeted visual assessment · ${escape(review.reviewSource)}</h3><p>${escape(review.status ?? review.visualStatus ?? review.reviewStatus)} · <a href="${escape(review.reviewSource)}">Full evidence and limitations</a></p>${assessmentDetails(review)}${findingList(review.findings)}${review.newIssues.length ? `<h4>Additional observations</h4>${findingList(review.newIssues)}` : ""}${review.limitations?.length ? `<p>${escape(review.limitations.join(" "))}</p>` : ""}`).join("")}</article>`).join("")}</html>`);
console.log(`Repair report: ${join(directory, "index.html")}`);
