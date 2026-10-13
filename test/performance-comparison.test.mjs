import assert from 'node:assert/strict';
import test from 'node:test';
import { compareSamples, summarize } from '../scripts/performance/comparison.mjs';

const samples = (metric, values) => values.map(value => ({ [metric]: value }));
const compare = (metric, before, after) => compareSamples(samples(metric, before), samples(metric, after))[0];

test('timing gate tolerates noise but rejects a sustained slowdown', () => {
  assert.equal(compare('settings.taskMs', [100, 101, 99, 100, 100], [104, 99, 102, 500, 101]).regression, false);
  const slow = compare('settings.taskMs', [100, 100, 100], [145, 140, 150]);
  assert.equal(slow.regression, true);
  assert.equal(slow.limit, 130);
  assert.equal(slow.candidate.median, 145);
  assert.equal(slow.candidate.p95, 150);
  assert.equal(compare('settings.taskMs', [1, 1, 1], [5, 6, 7]).regression, false, 'sub-millisecond ratios need an absolute noise floor');
  assert.equal(compare('settings.taskMs', [0, 0, 0], [30, 31, 32]).regression, true);
});

test('deterministic work regressions fail even when elapsed time improves', () => {
  const before = Array.from({ length: 3 }, () => ({ 'settings.taskMs': 200, 'settings.styleReads': 5000 }));
  const after = Array.from({ length: 3 }, () => ({ 'settings.taskMs': 100, 'settings.styleReads': 7000 }));
  assert.deepEqual(compareSamples(before, after).filter(row => row.regression).map(row => row.metric), ['settings.styleReads']);
});

test('idle, pause, and retention budgets apply to every sample, even against a bad baseline', () => {
  for (const phase of ['idle', 'paused']) {
    for (const name of ['refreshes', 'styleReads', 'boxReads']) {
      assert.equal(compare(`${phase}.${name}`, [20, 20, 20], [0, 0, 1]).regression, true);
      assert.equal(compare(`${phase}.${name}`, [20, 20, 20], [0, 0, 0]).regression, false);
    }
  }
  assert.equal(compare('memory.heapGrowthBytes', [2e6, 2e6, 2e6], [0, 0, 1_000_001]).regression, true);
  assert.equal(compare('memory.nodeGrowth', [0, 0, 0], [0, 0, 21]).regression, true);
});

test('missing, unknown, nonfinite, and insufficient measurements fail closed', () => {
  assert.throws(() => compareSamples([{}, {}, {}], [{}, {}, {}]), /No performance metrics/);
  assert.throws(() => compareSamples(samples('settings.taskMs', [1, 1, 1]), samples('settings.boxReads', [1, 1, 1])), /metric sets differ/);
  assert.throws(() => compare('typo', [1, 1, 1], [1, 1, 1]), /No comparison policy/);
  for (const value of [NaN, Infinity, -1, undefined, '1']) {
    assert.throws(() => compare('settings.taskMs', [1, 1, 1], [1, value, 1]), /finite, nonnegative/);
  }
  assert.throws(() => compare('settings.taskMs', [1, 1], [1, 1]), /at least three/);
  assert.throws(() => compare('settings.taskMs', [1, 1, 1], [1, 1, 1, 1]), /equally sized/);
  assert.deepEqual(summarize([4, 1, 2, 3]), { median: 2.5, p95: 4, min: 1, max: 4 });
});
