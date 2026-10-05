import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baselineRef = process.argv[2] ?? "HEAD";
const baseline = new Map(["settings", "content"].map((name) => [
  `/baseline/${name}.js`,
  execFileSync("git", ["show", `${baselineRef}:src/${name}.js`], { cwd: root })
]));
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" };
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (baseline.has(pathname)) {
      response.setHeader("Content-Type", "text/javascript");
      response.end(baseline.get(pathname));
      return;
    }
    const path = resolve(root, `.${pathname === "/" ? "/benchmarks/performance.html" : pathname}`);
    if (!path.startsWith(`${root}${sep}`)) {
      response.writeHead(403).end();
      return;
    }
    const data = await readFile(path);
    response.setHeader("Content-Type", types[path.slice(path.lastIndexOf("."))] ?? "application/octet-stream");
    response.setHeader("Cache-Control", "no-store");
    response.end(data);
  } catch {
    response.writeHead(404).end();
  }
});
const port = Number(process.env.LEXEND_BENCH_PORT ?? 4174);
server.listen(port, "0.0.0.0", () => {
  console.log(`Performance harness: http://localhost:${server.address().port} (baseline ${baselineRef})`);
});
