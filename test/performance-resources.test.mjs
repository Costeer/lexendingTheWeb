import assert from 'node:assert/strict';
import test from 'node:test';
import { runtimeScriptPaths } from '../scripts/performance/runtime-resources.mjs';

test('performance source inventory includes both isolated runtime and page-world lifecycle bridge', () => {
  const runtime = { js: ['src/settings.js', 'src/content.js'], run_at: 'document_start' };
  const bridge = { js: ['src/shadow-discovery.js'], world: 'MAIN', run_at: 'document_start' };
  assert.deepEqual(runtimeScriptPaths({ content_scripts: [runtime] }), runtime.js);
  assert.deepEqual(runtimeScriptPaths({ content_scripts: [runtime, bridge] }), [...runtime.js, ...bridge.js]);
  for (const unsupported of [
    { ...bridge, css: ['bridge.css'] }, { ...bridge, world: 'UNKNOWN' },
    { ...bridge, run_at: 'document_idle' }, { ...bridge, js: [] }, { ...bridge, js: [null] }
  ]) {
    assert.throws(() => runtimeScriptPaths({ content_scripts: [runtime, unsupported] }), /Update the benchmark loader/);
  }
  assert.throws(() => runtimeScriptPaths({ content_scripts: [] }), /missing/);
});
