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
  const layout = await readFile(new URL('../src/adaptive-layout.js', import.meta.url), 'utf8');
  for (const [anchor, label] of [
    ['    const invalidateMeasurements = () => { if (measurements) measurements = freshMeasurements(); };', 'measurement invalidation'],
    ['        element.style.setProperty(property, value, "important");\n        invalidateMeasurements();', 'centralized style invalidation'],
    ['        element.setAttribute(name, next);\n        invalidateMeasurements();', 'centralized marker invalidation']
  ]) {
    assert.throws(() => instrumentPhaseSource('src/adaptive-layout.js', layout.replace(anchor, anchor.replace('invalidateMeasurements', 'unexpectedInvalidation'))),
      new RegExp(`${label}.*found 0`));
    assert.throws(() => instrumentPhaseSource('src/adaptive-layout.js', `${layout}\n${anchor}`),
      new RegExp(`${label}.*found 2`));
  }
});

test('invalidation probes support exactly one legacy or state-aware forwarding signature', async () => {
  const current = await readFile(new URL('../src/content.js', import.meta.url), 'utf8');
  const oldCall = '    queueRefresh(urgent === true, ariaChanges, styleChanges);';
  const newCall = '    queueRefresh(urgent === true, ariaChanges, styleChanges, stateChanges);';
  const legacy = current.replace(newCall, oldCall);
  assert(instrumentPhaseSource('src/content.js', current).includes('__phaseProfile.queue(urgent, ariaChanges, styleChanges, stateChanges)'));
  assert(instrumentPhaseSource('src/content.js', legacy).includes('__phaseProfile.queue(urgent, ariaChanges, styleChanges)'));
  for (const source of [current, legacy]) {
    const instrumented = instrumentPhaseSource('src/content.js', source);
    assert.doesNotThrow(() => new vm.Script(instrumented));
    assert(instrumented.includes(`forwardEvent(urgent, () => ${source === current ? newCall.trim().slice(0, -1) : oldCall.trim().slice(0, -1)})`));
  }
  assert.throws(() => instrumentPhaseSource('src/content.js', current.replace(newCall, '')), /invalidation event reason.*found 0/);
  assert.throws(() => instrumentPhaseSource('src/content.js', `${current}\n${oldCall}`), /invalidation event reason.*found 2/);
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
  p.queue(false, null, null, [{}]);
  p.refresh();
  assert.deepEqual(p.snapshot().refreshes[3].reasons, ['coalescible-author-state']);
  assert.throws(() => p.measure('throws', () => { throw new Error('test'); }), /test/);
  assert.equal(p.snapshot().phases.throws.count, 1);
});

test('container diagnostics distinguish no-write passes, intervening invalidations, and repair lifetimes', () => {
  let now = 0;
  const context = vm.createContext({ performance: { now: () => now }, structuredClone, Event });
  vm.runInContext(`(${installPhaseProfile.toString()})()`, context);
  const p = context.__phaseProfile;
  let cache = { secret: 'must not appear in evidence' };
  const run = callback => p.containerPass(() => cache, () => p.measure('layout.repairContainers', callback));
  p.measure('layout.repairLayout', () => {
    run(() => { now += 12; });
    const before = cache;
    cache = {};
    p.invalidation('marker', before, cache);
    run(() => {
      now += 8;
      const before = cache;
      cache = {};
      p.invalidation('style', before, cache);
      now += 2;
    });
    run(() => { now += 3; });
  });
  p.measure('layout.repairLayout', () => {
    cache = {};
    assert.throws(() => run(() => { throw new Error('failed repair'); }), /failed repair/);
  });
  const snapshot = p.snapshot(), records = snapshot.containerPasses.records;
  assert.deepEqual(records.map(record => [record.order, record.repairId, record.invocationInRepair]), [[1, 1, 1], [2, 1, 2], [3, 1, 3], [4, 2, 1]]);
  assert.deepEqual(records.map(record => record.durationMs), [12, 10, 3, 0]);
  assert.equal(records[0].before.cacheGeneration, records[0].after.cacheGeneration);
  assert.equal(records[0].styleOrMarkerInvalidated, false);
  assert.notEqual(records[0].after.cacheGeneration, records[1].before.cacheGeneration);
  assert.equal(records[1].before.invalidations.marker, 1);
  assert.equal(records[1].invalidations.marker, 0);
  assert.equal(records[1].invalidations.style, 1);
  assert.equal(records[1].invalidations.cacheReplacements, 1);
  assert.equal(records[1].styleOrMarkerInvalidated, true);
  assert.notEqual(records[1].before.cacheGeneration, records[1].after.cacheGeneration);
  assert.equal(records[2].before.cacheGeneration, records[1].after.cacheGeneration);
  assert.equal(records[3].completed, false);
  assert(!JSON.stringify(snapshot).includes('must not appear'));
  assert.equal(snapshot.phases['layout.repairContainers'].count, records.length);
});

test('container diagnostic records are bounded and expose overflow without dropping aggregate counts', () => {
  const context = vm.createContext({ performance: { now: () => 0 }, structuredClone, Event });
  vm.runInContext(`(${installPhaseProfile.toString()})()`, context);
  const p = context.__phaseProfile, limit = p.snapshot().containerPasses.recordLimit;
  p.measure('layout.repairLayout', () => {
    for (let i = 0; i <= limit; i++) p.containerPass(() => null, () => {});
  });
  const evidence = p.snapshot().containerPasses;
  assert.equal(evidence.total, limit + 1);
  assert.equal(evidence.records.length, limit);
  assert.equal(evidence.dropped, 1);
  assert.equal(evidence.records[0].before.cacheGeneration, null);
});
