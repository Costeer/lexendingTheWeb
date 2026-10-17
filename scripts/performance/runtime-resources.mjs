// The empirical fixture executes these bytes in its controlled page context.
// Installed-browser checks separately establish MAIN/ISOLATED world behavior.
// Refuse unsupported resources instead of silently excluding them from timing
// and source hashes when a second, MAIN-world lifecycle script is present.
export function runtimeScriptPaths(manifest) {
  if (!Array.isArray(manifest.content_scripts) || !manifest.content_scripts.length) {
    throw new Error('Runtime content scripts are missing');
  }
  const paths = [];
  for (const entry of manifest.content_scripts) {
    if (!Array.isArray(entry.js) || !entry.js.length || entry.js.some(path => typeof path !== 'string')
        || entry.css?.length || !['ISOLATED', 'MAIN'].includes(entry.world ?? 'ISOLATED')
        || entry.run_at !== 'document_start') {
      throw new Error('Update the benchmark loader to cover the changed content-script manifest');
    }
    paths.push(...entry.js);
  }
  return paths;
}
