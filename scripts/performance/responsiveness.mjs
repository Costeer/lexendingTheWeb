import assert from 'node:assert/strict';

// These are a separate, additional phase. Do not change the existing burst,
// settings, idle, or retention workloads to make responsiveness measurements fit.
export const responsivenessProtocol = {
  edits: 100,
  intervalMs: 25,
  calibrationBlockMs: 70
};

// No content-script rewriting: observe browser tasks around the unmodified
// runtime. Long Tasks measures main-thread blocking, not actual input latency or
// compositor presentation. The identical bounded probes run in both versions.
export async function measureResponsiveness(page, injectedBlockMs = 0) {
  const raw = await page.evaluate(async ({ edits, intervalMs, calibrationBlockMs, injectedBlockMs }) => {
    if (!globalThis.PerformanceObserver?.supportedEntryTypes.includes('longtask')) {
      throw new Error('Native Long Tasks observation is unavailable');
    }
    if (document.visibilityState !== 'visible') throw new Error('Responsiveness requires a visible document');
    const tasks = [];
    const collect = entries => {
      for (const entry of entries) tasks.push({ startTime: entry.startTime, duration: entry.duration });
    };
    const observer = new PerformanceObserver(list => collect(list.getEntries()));
    observer.observe({ type: 'longtask' });
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    const block = ms => {
      const startTime = performance.now();
      while (performance.now() - startTime < ms) { /* Deliberate negative/positive control only. */ }
      return { startTime, endTime: performance.now() };
    };
    let contentionObserver;
    try {
      // A supportedEntryTypes string alone cannot establish a functioning probe.
      // Use a separate task; discard it before the measured stream begins.
      const calibration = await new Promise(resolve => setTimeout(() => resolve(block(calibrationBlockMs)), 0));
      for (let attempt = 0; attempt < 20; attempt++) {
        await delay(10);
        collect(observer.takeRecords());
        if (tasks.some(task => task.startTime <= calibration.startTime
          && task.startTime + task.duration >= calibration.endTime - 2)) break;
      }
      calibration.tasks = tasks.splice(0);
      if (!calibration.tasks.some(task => task.duration >= 50 && task.startTime <= calibration.startTime
        && task.startTime + task.duration >= calibration.endTime - 2)) {
        throw new Error('Long Tasks positive control was not observed');
      }

      const text = document.querySelector('main p')?.firstChild;
      const label = document.querySelector('#author-label');
      if (text?.nodeType !== Node.TEXT_NODE) throw new Error('Timed stream requires a connected text-node target');
      const originalText = text.data;
      const authorWritesBefore = globalThis.__authorWrites;
      if (!label || !Number.isInteger(authorWritesBefore) || !globalThis.__authorObserver) {
        throw new Error('Author observer fixture is missing');
      }
      let observerDeliveries = 0;
      contentionObserver = new MutationObserver(() => { observerDeliveries++; });
      contentionObserver.observe(label, { attributes: true, attributeFilter: ['style'] });
      const startTime = performance.now();
      const stream = [];
      let injectedBlock = null;
      // Schedule arrivals in advance. If a repair blocks the renderer, the raw
      // timestamps expose delayed deliveries rather than redefining the stream
      // as a sequence of immediate microtasks after each repair finishes.
      await new Promise(resolve => {
        for (let i = 0; i < edits; i++) setTimeout(() => {
          const deliveredAt = performance.now();
          if (injectedBlockMs && i === Math.floor(edits / 2)) injectedBlock = block(injectedBlockMs);
          text.data += 'word ';
          globalThis.__authorStyle = i % 2 ? 'color: rgb(12, 34, 56);' : 'color: rgb(23, 45, 67);';
          // The fixture's existing author observer restores its whole style
          // attribute. The temporary property ensures that it really writes;
          // alternating author color also produces genuine style changes.
          label.style.cssText = `${globalThis.__authorStyle} --stream-token: ${i};`;
          stream.push({ index: i, scheduledAt: startTime + (i + 1) * intervalMs, deliveredAt });
          if (stream.length === edits) resolve();
        }, (i + 1) * intervalMs);
      });
      // Include the final queued refresh/deferred repair, not just stream arrival.
      __bench.begin();
      await __bench.done;
      __bench.check();
      const endTime = performance.now();
      await delay(0);
      collect(observer.takeRecords());
      if (!text.isConnected || text.data !== originalText + 'word '.repeat(edits)) throw new Error('Timed stream did not finish');
      const authorWrites = globalThis.__authorWrites - authorWritesBefore;
      if (observerDeliveries < edits || authorWrites < edits) throw new Error('Timed author observer contention did not run');
      const longTasks = tasks.filter(task => task.startTime >= startTime && task.startTime < endTime);
      if (injectedBlock && !longTasks.some(task => task.startTime <= injectedBlock.startTime
        && task.startTime + task.duration >= injectedBlock.endTime - 2)) {
        throw new Error('Injected synchronous block was not captured by Long Tasks');
      }
      return {
        startTime, endTime, calibration, stream, longTasks, authorWrites, observerDeliveries, injectedBlock
      };
    } finally {
      contentionObserver?.disconnect();
      observer.disconnect();
    }
  }, { ...responsivenessProtocol, injectedBlockMs });
  assert.equal(raw.stream.length, responsivenessProtocol.edits);
  assert(raw.endTime - raw.startTime >= responsivenessProtocol.edits * responsivenessProtocol.intervalMs - 1,
    'Timed streaming window was shorter than its scheduled arrivals');
  return {
    metrics: {
      maxLongTaskMs: Math.max(0, ...raw.longTasks.map(task => task.duration)),
      longTaskCount: raw.longTasks.length,
      totalBlockingMs: raw.longTasks.reduce((total, task) => total + Math.max(0, task.duration - 50), 0)
    },
    raw
  };
}
