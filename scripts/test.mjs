import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// Run repository tests with shell-independent file discovery.
const root = fileURLToPath(new URL("../", import.meta.url));
const files = (await readdir(new URL("../test/", import.meta.url)))
  .filter((file) => /\.test\.m?js$/.test(file)).sort().map((file) => `test/${file}`);
if (!files.length) throw new Error("No repository tests found.");
const child = spawn(process.execPath, ["--test", ...files], { cwd: root, stdio: "inherit" });
child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code ?? 1; });
