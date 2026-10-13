import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const git = (root, ...args) => execFileSync('git', args, { cwd: root, maxBuffer: 20 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const commitFor = (root, ref) => git(root, 'rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`).toString().trim();
export const gitState = root => ({
  commit: commitFor(root, 'HEAD'),
  tree: git(root, 'rev-parse', 'HEAD^{tree}').toString().trim(),
  gitStatus: git(root, 'status', '--porcelain=v1', '--untracked-files=all').toString()
});

export async function runtimeSnapshot(root, revision) {
  const read = path => revision ? git(root, 'show', `${revision}:${path}`) : readFile(resolve(root, path));
  const manifestPath = 'manifests/manifest.chrome.json';
  const manifestBytes = await read(manifestPath);
  const manifest = JSON.parse(manifestBytes);
  const scripts = manifest.content_scripts[0].js;
  if (manifest.content_scripts.length !== 1 || manifest.content_scripts[0].css?.length) {
    throw new Error('Update the benchmark loader to cover the changed content-script manifest');
  }
  const resources = manifest.web_accessible_resources.flatMap(entry => entry.resources);
  const files = new Map([[manifestPath, manifestBytes]]);
  for (const path of new Set([...scripts, ...resources])) {
    if (!/^(src|assets)\/[a-zA-Z0-9_./-]+$/.test(path) || path.split('/').includes('..')) {
      throw new Error(`Unsupported runtime resource path: ${path}`);
    }
    files.set(path, await read(path));
  }
  return { scripts, files, hashes: Object.fromEntries([...files].map(([path, bytes]) => [path, sha256(bytes)])) };
}

export const harnessFiles = ['scripts/test-performance.mjs', 'scripts/performance/sources.mjs',
  'scripts/performance/workloads.mjs', 'scripts/performance/comparison.mjs', 'test/helpers/conversation.mjs'];
export async function harnessHashes(root, revision) {
  return Object.fromEntries(await Promise.all(harnessFiles.map(async path => [path,
    sha256(revision ? git(root, 'show', `${revision}:${path}`) : await readFile(resolve(root, path)))])));
}
