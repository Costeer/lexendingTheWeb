// Diagnostic-only source probes. Never use transformed bytes in the gate.
// Every splice is exact-once so source changes require an explicit probe update.
export function replaceExactlyOnce(source, needle, replacement, label) {
  const matches = source.split(needle).length - 1;
  if (matches !== 1) throw new Error(`Phase probe ${label}: expected exactly one match, found ${matches}`);
  return source.replace(needle, () => replacement);
}

export const contentPhases = ['applyIncomingFonts', 'measureTypography', 'applyTypography',
  'recoverClonedTypography', 'clearTypography', 'visitShadowRoots', 'withViewportPreserved',
  'refresh', 'applySettings', 'runQueuedRefresh'];
export const layoutPhases = ['restore', 'captureBaseline', 'repairLayout', 'repairText',
  'repairContainers', 'repairSiblings', 'repairMediaFootprints', 'repairFloatingBounds',
  'repairExpandedFades', 'repairPseudoTooltips', 'repairPanels', 'repairBackdropSpacing',
  'repairBorderBackdrops', 'repairImageLayers', 'repairOverlays', 'repairTables',
  'repairMaskedContent', 'repairSolidContrast'];

function wrapFunctions(source, names, group, anchor) {
  const wrappers = [];
  for (const name of names) {
    source = replaceExactlyOnce(source, `const ${name} =`, `const profileOriginal_${name} =`, `${group}.${name}`);
    const measured = `globalThis.__phaseProfile.measure(${JSON.stringify(`${group}.${name}`)}, () => profileOriginal_${name}(...args))`;
    wrappers.push(`const ${name} = (...args) => ${group === 'layout' && name === 'repairContainers'
      ? `globalThis.__phaseProfile.containerPass(() => measurements, () => ${measured})` : measured};`);
  }
  return replaceExactlyOnce(source, anchor, `${wrappers.join('\n')}\n${anchor}`, `${group} wrappers`);
}

export function instrumentPhaseSource(path, source) {
  if (path === 'src/adaptive-layout.js') {
    source = replaceExactlyOnce(source,
      '    const invalidateMeasurements = () => { if (measurements) measurements = freshMeasurements(); };',
      '    const invalidateMeasurements = (profileReason = "other") => { const profileBefore = measurements; if (measurements) measurements = freshMeasurements(); globalThis.__phaseProfile.invalidation(profileReason, profileBefore, measurements); };',
      'measurement invalidation');
    source = replaceExactlyOnce(source,
      '        element.style.setProperty(property, value, "important");\n        invalidateMeasurements();',
      '        element.style.setProperty(property, value, "important");\n        invalidateMeasurements("style");',
      'centralized style invalidation');
    source = replaceExactlyOnce(source,
      '        element.setAttribute(name, next);\n        invalidateMeasurements();',
      '        element.setAttribute(name, next);\n        invalidateMeasurements("marker");',
      'centralized marker invalidation');
    return wrapFunctions(source, layoutPhases, 'layout', '    const capture = (roots, options) =>');
  }
  if (path !== 'src/content.js') return source;
  // Support the historical runtime and the stateChanges-aware lifecycle merge,
  // but reject both zero matches and mixtures/duplicates of supported variants.
  const forwarding = ['urgent === true, ariaChanges, styleChanges', 'urgent === true, ariaChanges, styleChanges, stateChanges'];
  const matches = forwarding.map(args => source.split(`    queueRefresh(${args});`).length - 1);
  const total = matches.reduce((sum, count) => sum + count, 0);
  if (total !== 1) throw new Error(`Phase probe invalidation event reason: expected exactly one match, found ${total}`);
  const variant = matches.indexOf(1), args = forwarding[variant];
  source = replaceExactlyOnce(source, `    queueRefresh(${args});`,
    `    globalThis.__phaseProfile.forwardEvent(urgent, () => queueRefresh(${args}));`, 'invalidation event reason');
  source = replaceExactlyOnce(source,
    '  const observer = new MutationObserver((mutations) => {',
    '  const observer = new MutationObserver(globalThis.__phaseProfile.mutations((mutations) => {', 'mutation entry');
  source = replaceExactlyOnce(source, '  });\n  const start = async () => {',
    '  }));\n  const start = async () => {', 'mutation exit');
  source = replaceExactlyOnce(source,
    '    if (refreshing || !settingsLoaded || !isActive()) return;\n    if (pendingRepair !== null) {',
    `    if (refreshing || !settingsLoaded || !isActive()) return;\n    globalThis.__phaseProfile.queue(urgent, ariaChanges, styleChanges${variant ? ', stateChanges' : ''});\n    if (pendingRepair !== null) {`,
    'accepted scheduling request');
  // Preserve Event inputs before the runtime normalizes urgent to a boolean.
  source = replaceExactlyOnce(source, '    urgent = urgent === true;',
    '    globalThis.__phaseProfile.eventReason(urgent);\n    urgent = urgent === true;', 'event reason');
  source = replaceExactlyOnce(source,
    '    for (const root of new Set([document.documentElement, ...styledRoots])) {',
    '    globalThis.__phaseProfile.measure("content.collectNestedScrollers", () => {\n    for (const root of new Set([document.documentElement, ...styledRoots])) {', 'scroll scan start');
  source = replaceExactlyOnce(source,
    '    // Read every scroll offset before changing styles; interleaving these',
    '    });\n    // Read every scroll offset before changing styles; interleaving these', 'scroll scan end');
  source = replaceExactlyOnce(source,
    '    if (refreshing || !document.documentElement) return;\n    const started = performance.now();',
    '    if (refreshing || !document.documentElement) return;\n    globalThis.__phaseProfile.refresh();\n    const started = performance.now();', 'refresh reasons');
  source = replaceExactlyOnce(source,
    'if (newMetrics && (authorMetrics || !initializing && pendingRepair === null)) invalidateAutoContent(true);',
    'if (newMetrics && (authorMetrics || !initializing && pendingRepair === null)) globalThis.__phaseProfile.reason("font-metrics", () => invalidateAutoContent(true));',
    'font reason');
  return wrapFunctions(source, contentPhases, 'content', '  start().finally(() => {');
}

// Serialized by Playwright; no closure imports or runtime references are kept.
export function installPhaseProfile() {
  const phases = {}, schedulingReasons = {}, refreshReasons = {}, refreshes = [];
  const stack = [], reasonStack = [], pending = new Set();
  const repairStack = [], cacheIds = new WeakMap();
  const invalidations = { total: 0, style: 0, marker: 0, other: 0, cacheReplacements: 0 };
  const containerPasses = { recordLimit: 4096, total: 0, dropped: 0, records: [] };
  let nextCacheId = 0, nextRepairId = 0;
  const cacheId = cache => {
    if (cache === null) return null;
    if (!cacheIds.has(cache)) cacheIds.set(cache, ++nextCacheId);
    return cacheIds.get(cache);
  };
  let eventReason = null;
  const increment = (object, key) => { object[key] = (object[key] ?? 0) + 1; };
  const profile = globalThis.__phaseProfile = {
    measure(name, callback) {
      const start = performance.now(), frame = { childMs: 0 };
      stack.push(frame);
      if (name === 'content.applySettings') reasonStack.push(['settings-or-startup']);
      if (name === 'layout.repairLayout') repairStack.push({ id: ++nextRepairId, passes: 0 });
      try { return callback(); }
      finally {
        const ms = performance.now() - start;
        stack.pop();
        if (stack.length) stack.at(-1).childMs += ms;
        const value = phases[name] ??= { count: 0, inclusiveMs: 0, selfMs: 0, maxMs: 0 };
        value.count++; value.inclusiveMs += ms; value.selfMs += Math.max(0, ms - frame.childMs); value.maxMs = Math.max(value.maxMs, ms);
        if (name === 'content.applySettings') reasonStack.pop();
        if (name === 'layout.repairLayout') repairStack.pop();
        if (name === 'content.runQueuedRefresh') pending.clear();
      }
    },
    invalidation(reason, before, after) {
      cacheId(before); cacheId(after);
      invalidations.total++;
      increment(invalidations, reason);
      if (before !== after) invalidations.cacheReplacements++;
    },
    containerPass(currentCache, callback) {
      const repair = repairStack.at(-1);
      const record = { order: ++containerPasses.total, repairId: repair?.id ?? null,
        invocationInRepair: repair ? ++repair.passes : null, startMs: performance.now(),
        before: { cacheGeneration: cacheId(currentCache()), invalidations: { ...invalidations } } };
      let completed = false;
      try { const result = callback(); completed = true; return result; }
      finally {
        record.endMs = performance.now();
        record.durationMs = record.endMs - record.startMs;
        record.completed = completed;
        record.after = { cacheGeneration: cacheId(currentCache()), invalidations: { ...invalidations } };
        record.invalidations = Object.fromEntries(Object.keys(invalidations).map(key => [key,
          record.after.invalidations[key] - record.before.invalidations[key]]));
        record.styleOrMarkerInvalidated = record.invalidations.style + record.invalidations.marker > 0;
        if (containerPasses.records.length < containerPasses.recordLimit) containerPasses.records.push(record);
        else containerPasses.dropped++;
      }
    },
    reason(name, callback) {
      reasonStack.push([name]);
      try { return callback(); } finally { reasonStack.pop(); }
    },
    mutations(callback) {
      return mutations => {
        reasonStack.push([...new Set(mutations.map(m => `mutation:${m.type}${m.attributeName ? `:${m.attributeName}` : ''}`))]);
        try { return callback(mutations); } finally { reasonStack.pop(); }
      };
    },
    eventReason(value) { eventReason = value instanceof Event ? `event:${value.type}` : null; },
    forwardEvent(value, callback) { return value instanceof Event ? profile.reason(`event:${value.type}`, callback) : callback(); },
    queue(_urgent, ariaChanges, styleChanges, stateChanges) {
      const reasons = reasonStack.at(-1) ?? [eventReason ?? (ariaChanges || styleChanges || stateChanges ? 'coalescible-author-state' : 'other-runtime')];
      for (const reason of reasons) { pending.add(reason); increment(schedulingReasons, reason); }
    },
    refresh() {
      const reasons = [...new Set([...pending, ...(reasonStack.at(-1) ?? [])])];
      if (!reasons.length) reasons.push('other-runtime');
      for (const reason of reasons) increment(refreshReasons, reason);
      refreshes.push({ startMs: performance.now(), reasons });
      pending.clear();
    },
    snapshot() { return structuredClone({ phases, schedulingReasons, refreshReasons, refreshes, containerPasses, invalidations }); }
  };
  return Boolean(profile);
}
