import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, sep, extname } from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../", import.meta.url));
export async function serveDirectory(directory, port = 0) {
  const base = resolve(directory);
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
      const file = resolve(base, `.${pathname.endsWith("/") ? pathname + "index.html" : pathname}`);
      if (!file.startsWith(base + sep)) { response.writeHead(403).end(); return; }
      const content = await readFile(file);
      const types = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".png": "image/png", ".css": "text/css" };
      response.writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" }).end(content);
    } catch { response.writeHead(404).end("Not found"); }
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", resolveListen);
  });
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((done) => server.close(done)) };
}
