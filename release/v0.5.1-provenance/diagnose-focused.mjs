import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const root = '/home/costeer/.t3/worktrees/lexendingTheWeb/t3-8edf757d';
const baseline = 'f2670e24aa210b80f6baedfcf09d22a5dd91e640';
const expectedInputsSha256 = '5c129467f2e5b42fe306984be5c268ffda82f40acd00188482ce6ba5c3d8c124';
const [mode, output] = process.argv.slice(2);
if (!['reading-minimal', 'conversation-disconnect'].includes(mode) || !output) throw new Error('usage: node diagnose-focused.mjs reading-minimal|conversation-disconnect ABSOLUTE_NEW_OUTPUT');
const { chromium } = await import(pathToFileURL(resolve(root, 'node_modules/playwright/index.mjs')));
const { runtimeSnapshot, harnessHashes, gitState } = await import(pathToFileURL(resolve(root, 'scripts/performance/sources.mjs')));
const { runWorkload, workloads, protocol } = await import(pathToFileURL(resolve(root, 'scripts/performance/workloads.mjs')));
const sha = value => createHash('sha256').update(value).digest('hex');
const report = { schemaVersion: 1, startedAt: new Date().toISOString(), mode, baseline, protocol,
  scope: 'Diagnostic only: minimally probed immutable historical source and original startup assertions. Reading records accepted queues and the exact state returned to the original check; conversation may disconnect only author observer AFTER actual original15s timeout, then observe2s. Startup prefix only; instrumentation/intervention cannot qualify a release or supply comparative numbers.',
  cases: [] };

// Serialized into the page. No added style reads and no per-frame state logs.
function installTrace() {
  const events = [], counts = {}, limit = 512;
  let dropped = 0, inOriginalCheck = false;
  const trace = globalThis.__releaseDiag = {
    log(kind, detail = {}) {
      counts[kind] = (counts[kind] ?? 0) + 1;
      if (events.length >= limit) { dropped++; return; }
      events.push({ sequence: events.length, at: performance.now(), kind, ...detail });
    },
    count(kind) { return counts[kind] ?? 0; },
    snapshot() { return { events: events.slice(), counts: { ...counts }, limit, dropped, authorWrites: globalThis.__authorWrites }; }
  };
  const state = __bench.state, begin = __bench.begin, check = __bench.check;
  __bench.state = (...args) => {
    const result = state(...args);
    // Capture exactly the original check's state read in the same call stack.
    // Existing settling-frame state calls retain just this boolean branch.
    if (inOriginalCheck) trace.log('original-check-state', { state: result ?? null });
    return result;
  };
  __bench.begin = (...args) => {
    const result = begin(...args);
    __bench.done.then(value => trace.log('original-done-resolved', { value }), error => trace.log('original-done-rejected', { error: String(error) }));
    return result;
  };
  __bench.check = (...args) => {
    trace.log('original-check-enter');
    inOriginalCheck = true;
    try { const result = check(...args); trace.log('original-check-passed'); return result; }
    catch (error) { trace.log('original-check-rejected', { error: String(error) }); throw error; }
    finally { inOriginalCheck = false; }
  };
}
function instrumentContent(original) {
  let source = original;
  const transforms = [];
  const replace = (needle, replacement, label) => {
    const count = source.split(needle).length - 1;
    if (count !== 1) throw new Error(`${label}: expected exactly one match; got ${count}`);
    source = source.replace(needle, () => replacement);
    transforms.push({ label, needleSha256: sha(needle), replacementSha256: sha(replacement) });
  };
  replace('    refreshTimer = setTimeout(refresh, urgent ? 0 : 100);',
    '    refreshTimer = setTimeout(refresh, urgent ? 0 : 100);\n    __releaseDiag.log("queue-accepted", { urgent, delay: urgent ? 0 : 100, refreshTimer, refreshRevision, caller: new Error().stack });', 'accepted queue only');
  replace('      if (newMetrics) invalidateAutoContent();',
    '      if (newMetrics) {\n        __releaseDiag.log("new-font-metrics", { refreshRevision });\n        invalidateAutoContent();\n      }', 'new font metrics only');
  return { source, transforms };
}
// Called only after the original startup done rejects with its actual15s error.
// Original failure evidence is captured first and kept unsuccessful.
async function disconnectAfterTimeout() {
  if (!globalThis.__authorObserver || typeof __authorObserver.disconnect !== 'function') throw new Error('Expected fixture author observer missing');
  const state = () => __bench.state();
  const before = { at: performance.now(), state: state(), authorWrites: __authorWrites, trace: __releaseDiag.snapshot() };
  const start = performance.now(), observations = [];
  let stableFrames = 0, firstSettled = null;
  __authorObserver.disconnect();
  __releaseDiag.log('diagnostic-author-observer-disconnected');
  while (performance.now() - start < 2000) {
    await new Promise(requestAnimationFrame);
    const current = state();
    observations.push({ at: performance.now(), state: current, authorWrites: __authorWrites, queueCount: __releaseDiag.count('queue-accepted') });
    if (current?.healthy && current.active && !current.pending) stableFrames++; else stableFrames = 0;
    if (stableFrames >= 2 && firstSettled === null) firstSettled = observations.at(-1);
  }
  const after = { at: performance.now(), state: state(), authorWrites: __authorWrites, trace: __releaseDiag.snapshot(), fontsStatus: document.fonts.status, fontCheck: document.fonts.check('19.2px "Lexend for the Web"', 'Reading') };
  let originalTypographyCheck;
  try { __bench.check(); originalTypographyCheck = { passed: true }; }
  catch (error) { originalTypographyCheck = { passed: false, error: String(error.stack ?? error) }; }
  return { kind: 'disconnect-only-author-observer-after-original-timeout', windowMs: 2000, actualWindowMs: performance.now() - start,
    before, firstSettled, after, observations, originalTypographyCheck,
    recoveredForThisDiagnostic: Boolean(firstSettled && after.state?.healthy && after.state.active && !after.state.pending && originalTypographyCheck.passed && after.fontCheck),
    scope: 'Diagnostic intervention only. Fonts, runtime invalidations, geometry, original source fixtures and failure report remain retained. No full workload or numerical release proof.' };
}
let browser;
const sameHashes = (actual, expected) => Object.keys(actual).length === Object.keys(expected).length && Object.entries(expected).every(([path, hash]) => actual[path] === hash);
try {
  report.scriptSha256 = sha(await readFile(new URL(import.meta.url)));
  const source = await runtimeSnapshot(root, baseline);
  report.originalRuntimeHashes = source.hashes;
  report.harnessHashes = await harnessHashes(root);
  report.checkout = gitState(root);
  const expectedBytes = await readFile(new URL('./expected-inputs.json', import.meta.url));
  if (sha(expectedBytes) !== expectedInputsSha256) throw new Error('Reviewed input manifest changed');
  const expected = JSON.parse(expectedBytes);
  report.expectedInputsSha256 = expectedInputsSha256;
  report.currentRuntimeHashes = (await runtimeSnapshot(root)).hashes;
  if (report.checkout.commit !== expected.candidateCommit || report.checkout.tree !== expected.candidateTree || report.checkout.gitStatus !== '') throw new Error('Candidate is not exact clean reviewed c38');
  if (baseline !== expected.historicalCommit || !sameHashes(source.hashes, expected.historicalRuntimeHashes)) throw new Error('Historical runtime identity differs from reviewed original');
  if (!sameHashes(report.harnessHashes, expected.harnessHashes) || !sameHashes(report.currentRuntimeHashes, expected.currentRuntimeHashes)) throw new Error('Current harness/runtime identity differs from reviewed input');
  report.reviewedInputsVerified = true;
  if (source.hashes['src/content.js'] !== '7667b43e9830ee5ef41ce3154b123ed797dea851b286bddb2061540cd153180b') throw new Error('Historical content identity changed');
  {
    const instrumented = instrumentContent(source.files.get('src/content.js').toString('utf8'));
    source.files.set('src/content.js', Buffer.from(instrumented.source));
    report.transformedContentSha256 = sha(instrumented.source);
    report.transforms = instrumented.transforms;
    // source.hashes intentionally keeps the immutable original identities;
    // transformed identities above are separate and never used as gate proof.
    report.prefixSha256 = sha(`(${installTrace.toString()})();\n`);
    report.interventionFunctionSha256 = mode === 'conversation-disconnect' ? sha(disconnectAfterTimeout.toString()) : null;
  }
  browser = await chromium.launch({ headless: true });
  report.chromium = browser.version();
  const newContext = browser.newContext.bind(browser);
  let current;
  browser.newContext = async (...args) => {
    const context = await newContext(...args);
    const close = context.close.bind(context);
    context.close = async (...closeArgs) => {
      try { const result = await close(...closeArgs); current.contextCloseSucceeded = true; return result; }
      catch (error) { current.contextCloseError = String(error.stack ?? error); throw error; }
    };
    const newPage = context.newPage.bind(context);
    context.newPage = async (...pageArgs) => {
      const page = await newPage(...pageArgs);
      page.on('console', message => current.console.push({ type: message.type(), text: message.text() }));
      page.on('pageerror', error => current.pageErrors.push(String(error)));
      page.on('crash', () => current.crashed = true);
      page.on('requestfailed', request => current.requestFailures.push({ url: request.url(), error: request.failure()?.errorText, phase: current.phase }));
      page.on('response', response => { if (response.status() >= 400) current.httpErrors.push({ url: response.url(), status: response.status(), phase: current.phase }); });
      const addScriptTag = page.addScriptTag.bind(page), evaluate = page.evaluate.bind(page);
      page.addScriptTag = async options => {
        current.phase = 'startup';
        return addScriptTag({ ...options, content: `(${installTrace.toString()})();\n` + options.content });
      };
      const observe = async () => evaluate(() => {
        const paragraph = document.querySelector('main p'), style = paragraph && getComputedStyle(paragraph);
        return { state: __bench?.state(), time: performance.now(), fontsStatus: document.fonts.status,
          paragraph: style && { family: style.fontFamily, size: style.fontSize },
          fontCheck: style && document.fonts.check(`${style.fontSize} "Lexend for the Web"`, 'Reading'),
          trace: globalThis.__releaseDiag?.snapshot() ?? null };
      });
      page.evaluate = async (fn, arg) => {
        const text = typeof fn === 'function' ? fn.toString() : String(fn);
        const isCheck = text.includes('__bench.check()'), isDone = text.includes('__bench.done');
        const call = { index: current.calls.length, phase: current.phase, kind: isCheck ? 'check' : isDone ? 'done' : 'evaluate', startedAt: new Date().toISOString() };
        current.calls.push(call);
        let value;
        try { value = await evaluate(fn, arg); call.status = 'completed'; }
        catch (error) {
          call.status = 'failed'; call.error = String(error.stack ?? error);
          call.errorOrigin = 'original-page-evaluate';
          if (current.phase === 'startup' && (isCheck || isDone)) {
            current.originalRejectedError = error;
            current.originalStartupRejection = { kind: call.kind, callIndex: call.index, error: call.error, knownAssertion: /Runtime did not finish healthy and active|Typography did not settle with loaded fonts within 15 seconds|Runtime reported unhealthy state/.test(String(error)) };
          }
          // Only observe after the original call's outcome is settled.
          if (current.phase === 'startup') {
            try { current.observation = await observe(); } catch (e) { current.observationError = String(e); }
            if (mode === 'conversation-disconnect' && isDone && /Typography did not settle with loaded fonts within 15 seconds/.test(String(error))) {
              current.controlPreconditionSatisfied = true;
              if (current.observation?.state && !current.observationError) {
                current.phase = 'diagnostic-intervention';
                try { current.intervention = await evaluate(disconnectAfterTimeout); } catch (e) { current.interventionError = String(e.stack ?? e); }
                finally { current.phase = 'startup'; }
              }
            }
          }
          throw error;
        }
        finally { call.finishedAt = new Date().toISOString(); }
        if (isCheck && current.phase === 'startup') {
          current.originalStartupCheckPassed = true;
          try { current.observation = await observe(); } catch (e) { current.observationError = String(e); }
          throw new Error('DIAGNOSTIC_STOP_AFTER_STARTUP');
        }
        return value;
      };
      return page;
    };
    return context;
  };
  for (const name of [mode === 'reading-minimal' ? 'reading-80' : 'conversation-120']) {
    current = { workload: name, phase: 'setup', calls: [], console: [], pageErrors: [], requestFailures: [], httpErrors: [] };
    report.cases.push(current);
    try { await runWorkload(browser, source, workloads.find(workload => workload.name === name)); throw new Error('Diagnostic failed to stop after startup'); }
    catch (error) {
      const stopped = current.originalStartupCheckPassed && String(error).includes('DIAGNOSTIC_STOP_AFTER_STARTUP');
      const originalRejected = current.originalRejectedError === error;
      current.status = stopped ? 'startup-completed-diagnostic' : originalRejected && current.originalStartupRejection.knownAssertion ? 'original-startup-assertion-failed' : originalRejected ? 'original-startup-evaluate-unclassified' : 'diagnostic-setup-timeout-or-cleanup-error';
      current.error = String(error.stack ?? error);
      if (!stopped && !originalRejected) process.exitCode = 1;
      delete current.originalRejectedError;
    }
    current.browserResourceErrors = Boolean(current.crashed || current.pageErrors.length || current.requestFailures.length || current.httpErrors.length);
    current.observationSucceeded = Boolean(current.observation?.state && !current.observationError && current.observation.trace?.events);
    current.diagnosticIntegrity = current.contextCloseSucceeded === true && current.observationSucceeded && !current.browserResourceErrors && ['startup-completed-diagnostic', 'original-startup-assertion-failed'].includes(current.status);
    if (mode === 'conversation-disconnect') {
      current.interventionIntegrity = Boolean(current.controlPreconditionSatisfied && current.intervention && !current.interventionError && current.intervention.before.trace.dropped === 0 && current.intervention.after.trace.dropped === 0);
      if (!current.interventionIntegrity) current.diagnosticIntegrity = false;
    }
    if (!current.diagnosticIntegrity) process.exitCode = 1;
    current.coverageLimit = 'Startup prefix only: the host stop bypasses later phases and final workload page/resource-error assertions. Errors are independently retained and invalidate diagnostic integrity. Context-close success is checked below.';
    current.finishedAt = new Date().toISOString();
  }
} catch (error) { report.error = String(error.stack ?? error); process.exitCode = 1; }
finally {
  try { await browser?.close(); report.browserClosed = true; }
  catch (error) { report.shutdownError = String(error); process.exitCode = 1; }
  report.finishedAt = new Date().toISOString();
  report.scriptSha256After = sha(await readFile(new URL(import.meta.url)));
  report.scriptStable = report.scriptSha256 === report.scriptSha256After;
  if (!report.scriptStable) { report.scriptStabilityError = 'Diagnostic script changed during execution'; process.exitCode = 1; }
  report.checkoutAfter = gitState(root);
  report.harnessHashesAfter = await harnessHashes(root);
  report.harnessStable = report.harnessHashes && sameHashes(report.harnessHashes, report.harnessHashesAfter);
  report.currentRuntimeHashesAfter = (await runtimeSnapshot(root)).hashes;
  report.currentRuntimeStable = report.currentRuntimeHashes && sameHashes(report.currentRuntimeHashes, report.currentRuntimeHashesAfter);
  if (!report.harnessStable || !report.currentRuntimeStable || JSON.stringify(report.checkout) !== JSON.stringify(report.checkoutAfter)) { report.sourceStabilityError = 'Checkout or harness changed during diagnostics'; process.exitCode = 1; }
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ output, cases: report.cases.map(item => ({ workload: item.workload, status: item.status, state: item.observation?.state, traceCounts: item.observation?.trace?.counts })) }));
}
