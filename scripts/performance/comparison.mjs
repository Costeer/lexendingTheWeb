// Tolerances are deliberately fixed and reviewed with the workload. A run must
// exceed both the relative allowance and the absolute noise floor to regress.
export const policy = {
  firstFontFrameMs: { relative: 0.30, absolute: 30 },
  settledMs: { relative: 0.30, absolute: 50 },
  taskMs: { relative: 0.30, absolute: 25 },
  styleReads: { relative: 0.15, absolute: 100 },
  boxReads: { relative: 0.15, absolute: 50 },
  heapBytes: { relative: 0.20, absolute: 1_000_000 },
  domNodes: { relative: 0.05, absolute: 20 },
  // These are diagnostic; scheduling makes small count differences normal.
  refreshes: null,
  layouts: null,
  styleRecalculations: null,
  heapGrowthBytes: { maximum: 1_000_000 },
  nodeGrowth: { maximum: 20 }
};

export function summarize(values) {
  if (!values.length || values.some(value => !Number.isFinite(value) || value < 0)) {
    throw new Error('Performance samples must contain finite, nonnegative numbers');
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    min: sorted[0], max: sorted.at(-1)
  };
}

export function compareSamples(baseline, candidate) {
  if (baseline.length < 3 || baseline.length !== candidate.length) {
    throw new Error('Comparison requires at least three equally sized sets of measured runs');
  }
  const keys = Object.keys(baseline[0]).sort();
  if (!keys.length) throw new Error('No performance metrics were collected');
  for (const sample of [...baseline, ...candidate]) {
    if (JSON.stringify(Object.keys(sample).sort()) !== JSON.stringify(keys)) {
      throw new Error('Performance metric sets differ; missing metrics cannot pass');
    }
  }
  return keys.map(metric => {
    const name = metric.split('.').at(-1);
    if (!Object.hasOwn(policy, name)) throw new Error(`No comparison policy for ${metric}`);
    const before = summarize(baseline.map(sample => sample[metric]));
    const after = summarize(candidate.map(sample => sample[metric]));
    const rule = policy[name];
    let limit = rule && 'relative' in rule
      ? before.median + Math.max(before.median * rule.relative, rule.absolute)
      : rule?.maximum ?? null;
    // Idle and paused pages must do no typography work, on every run. A median
    // must never hide an occasional feedback loop or work performed while paused.
    if (/^(idle|paused)\.(refreshes|styleReads|boxReads)$/.test(metric)) limit = 0;
    const absolute = limit !== null && (!rule || !('relative' in rule) || limit === 0);
    return {
      metric, baseline: before, candidate: after, limit,
      delta: after.median - before.median,
      percent: before.median ? (after.median / before.median - 1) * 100 : null,
      regression: limit !== null && (absolute ? after.max : after.median) > limit
    };
  });
}
