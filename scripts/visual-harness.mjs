import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runHarness } from "../harness/run.mjs";
import { applyReview } from "../harness/report.mjs";
import { serveDirectory } from "../harness/server.mjs";

const { values } = parseArgs({ options: {
  url: { type: "string" }, output: { type: "string" }, config: { type: "string" },
  headed: { type: "boolean" }, strict: { type: "boolean" },
  review: { type: "string" }, serve: { type: "string" }, port: { type: "string", default: "4173" },
  help: { type: "boolean" }
} });
try {
  if (values.help) {
    console.log(`Capture: npm run test:visual -- --url https://example.com [--config harness/example.config.json] [--output artifacts/my-run] [--headed] [--strict]
--strict exits 1 on automated failures, 2 while visual review is pending.
Review: npm run test:visual -- --output artifacts/my-run --review path/to/completed-review.json
Browse: npm run test:visual -- --serve artifacts/my-run [--port 4173]`);
  } else if (values.serve) {
    const server = await serveDirectory(resolve(values.serve), Number(values.port));
    console.log(`Report: ${server.url}`);
    process.on("SIGINT", async () => { await server.close(); process.exit(); });
    process.on("SIGTERM", async () => { await server.close(); process.exit(); });
  } else if (values.review) {
    if (!values.output) throw new Error("--output is required when submitting a review.");
    const report = await applyReview(resolve(values.output), resolve(values.review));
    console.log(`Review recorded: ${report.status}`);
    if (report.status === "failed") process.exitCode = 1;
  } else {
    if (!values.url) throw new Error("Provide the real website to test with --url https://your-website.example.");
    const config = values.config ? JSON.parse(await readFile(values.config, "utf8")) : {};
    await import("./build.mjs");
    const report = await runHarness({ url: values.url, output: values.output ?? `artifacts/visual-${Date.now()}`, config, headed: values.headed });
    if (values.strict) process.exitCode = report.status === "automated-failures" ? 1 : 2;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
