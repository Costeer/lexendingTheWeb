import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { contentPhases, layoutPhases, instrumentPhaseSource, installPhaseProfile, replaceExactlyOnce } from '../scripts/performance/phase-profile.mjs';

test('phase probes fail closed on missing or duplicate insertion points', async () => {
  for (const path of ['src/content.js', 'src/adaptive-layout.js']) {
    const source = await readFile(new URL(`../${path}`, import.meta.url), 'utf8');
    const instrumented = instrumentPhaseSource(path, source);
    assert(instrumented.includes('__phaseProfile.measure'));
    assert.doesNotThrow(() => new vm.Script(instrumented));
    assert.throws(() => instrumentPhaseSource(path, `${source}\n${source}`), /expected exactly one match, found 2/);
    for (const name of path === 'src/content.js' ? contentPhases : layoutPhases) {
      assert.throws(() => instrumentPhaseSource(path, source.replace(`const ${name} =`, `const ${name}  =`)), /expected exactly one match, found 0/);
    }
  }
  const source = await readFile(new URL('../src/content.js', import.meta.url), 'utf8');
  assert.throws(() => instrumentPhaseSource('src/content.js', source.replace('    urgent = urgent === true;', '    urgent  = urgent === true;')), /event reason.*found 0/);
  assert.throws(() => replaceExactlyOnce('absent', 'needle', 'replacement', 'missing'), /found 0/);
});

test('phase self time excludes instrumented children and reasons survive coalescing', () => {
  let now = 0;
  const context = vm.createContext({ performance: { now: () => now }, structuredClone, Event });
  vm.runInContext(`(${installPhaseProfile.toString()})()`, context);
  const p = context.__phaseProfile;
  p.measure('parent', () => {
    now += 5;
    p.measure('child', () => { now += 12; });
    now += 3;
  });
  p.reason('font-metrics', () => p.queue());
  p.mutations(() => p.queue())([{ type: 'characterData' }, { type: 'attributes', attributeName: 'style' }]);
  p.refresh();
  const snapshot = p.snapshot();
  assert.equal(snapshot.phases.parent.inclusiveMs, 20);
  assert.equal(snapshot.phases.parent.selfMs, 8);
  assert.equal(snapshot.phases.child.selfMs, 12);
  assert.deepEqual(snapshot.refreshes[0].reasons, ['font-metrics', 'mutation:characterData', 'mutation:attributes:style']);
  p.forwardEvent(new Event('resize'), () => p.queue());
  p.refresh();
  assert.deepEqual(p.snapshot().refreshes[1].reasons, ['event:resize']);
  p.measure('content.runQueuedRefresh', () => p.reason('reverted-author-state', () => p.queue()));
  p.refresh();
  assert.deepEqual(p.snapshot().refreshes[2].reasons, ['other-runtime']);
  assert.throws(() => p.measure('throws', () => { throw new Error('test'); }), /test/);
  assert.equal(p.snapshot().phases.throws.count, 1);
});
