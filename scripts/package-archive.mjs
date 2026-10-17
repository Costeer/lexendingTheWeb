import { zipSync } from "fflate";

export function createArchive(files) {
  const ordered = Object.create(null);
  for (const name of Object.keys(files).sort()) {
    if (!name || name.startsWith("/") || name.includes("\\")
        || name.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new Error(`Unsafe ZIP path: ${name}`);
    }
    if (!(files[name] instanceof Uint8Array)) throw new Error(`ZIP input must contain only file bytes: ${name}`);
    ordered[name] = files[name];
  }
  // ZIP stores local calendar fields, so construct the same fields in every TZ.
  // No input filesystem mtime, wall clock, permissions, or host OS enters the ZIP.
  return zipSync(ordered, { level: 9, mtime: new Date(1980, 0, 1, 0, 0, 0), os: 0, attrs: 0 });
}
