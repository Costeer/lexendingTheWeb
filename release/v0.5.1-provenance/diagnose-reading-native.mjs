import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const root = '/home/costeer/.t3/worktrees/lexendingTheWeb/t3-8edf757d';
const baseline = 'f2670e24aa210b80f6baedfcf09d22a5dd91e640';
const expectedInputsSha256 = '5c129467f2e5b42fe306984be5c268ffda82f40acd00188482ce6ba5c3d8c124';
const [output] = process.argv.slice(2);
if (!output) throw new Error('usage: node diagnose-reading-native.mjs ABSOLUTE_NEW_OUTPUT');
const { chromium } = await import(pathToFileURL(resolve(root, 'node_modules/playwright/index.mjs')));
const { runtimeSnapshot, harnessHashes, gitState } = await import(pathToFileURL(resolve(root, 'scripts/performance/sources.mjs')));
const { runWorkload, workloads, protocol } = await import(pathToFileURL(resolve(root, 'scripts/performance/workloads.mjs')));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sameHashes = (actual, expected) => Object.keys(actual).length === Object.keys(expected).length && Object.entries(expected).every(([path, hash]) => actual[path] === hash);
async function bounded(promise, milliseconds, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds}ms`)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
const report = { schemaVersion: 1, startedAt: new Date().toISOString(), baseline, protocol,
  scope: 'ONE native diagnostic reading80 startup context. Original historical runtime, fixture, loader and harness bytes unchanged; no inline prefix or source transformation. CDP Tracing/Debugger overhead changes execution. Read original bench.check local state only after its actual thrown exception. Startup prefix only; no numerical comparison, workload pass, policy exception or publication proof.',
  traceCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.stack', 'v8.execute'],
  calls: [], pauses: [], console: [], pageErrors: [], requestFailures: [], httpErrors: [] };
const traceEvents = [], eventLimit = 300000;
let traceDropped = 0, browser, session, traceStarted = false, traceFinished = false, stopPromise;
let traceCompleteResolve, traceCompleteReject, paused = false;
const pauseTasks = [];
const traceComplete = new Promise((resolve, reject) => { traceCompleteResolve = resolve; traceCompleteReject = reject; });
traceComplete.catch(() => {});
async function stopTrace() {
  if (!traceStarted) return;
  if (!stopPromise) stopPromise = (async () => {
    await bounded(session.send('Tracing.end'), 5000, 'Tracing.end');
    report.tracingComplete = await bounded(traceComplete, 5000, 'Tracing.tracingComplete');
    traceFinished = true;
  })();
  return stopPromise;
}
async function onPaused(event) {
  const record = { index: report.pauses.length, hostAt: new Date().toISOString(), inFlight: report.inFlight,
    reason: event.reason, data: event.data, callFrames: event.callFrames, asyncStackTrace: event.asyncStackTrace };
  report.pauses.push(record);
  const top = event.callFrames[0];
  const target = event.reason === 'exception' && report.inFlight?.kind === 'check'
    && /Runtime did not finish healthy and active/.test(event.data?.description ?? '')
    && /check/.test(top?.functionName ?? '');
  record.targetOriginalCheckThrow = target;
  try {
    if (target && !report.targetPause) {
      // VM is already paused at the original throw. No function is called here.
      record.localRead = await bounded(session.send('Debugger.evaluateOnCallFrame', {
        callFrameId: top.callFrameId, expression: '({ state, size })', returnByValue: true,
        throwOnSideEffect: true, silent: true, timeout: 1000
      }), 2000, 'Read original check local state');
      if (record.localRead.exceptionDetails || !record.localRead.result?.value?.state) throw new Error('Original local state unavailable');
      const script = await bounded(session.send('Debugger.getScriptSource', { scriptId: top.location.scriptId }), 2000, 'Read paused original harness source');
      record.pausedScriptSha256 = sha(script.scriptSource);
      record.pausedScriptSource = script.scriptSource;
      if (!script.scriptSource.includes("if (!state?.healthy || !state.active || state.pending) throw new Error('Runtime did not finish healthy and active');")) throw new Error('Paused source is not expected original check');
      report.targetPause = { pauseIndex: record.index, localState: record.localRead.result.value.state, requestedSize: record.localRead.result.value.size };
      // Stop trace while paused, before any timer can fire after the throw.
      await stopTrace();
    } else {
      record.unexpectedOrRepeatedPause = true;
      report.unexpectedPauses = (report.unexpectedPauses ?? 0) + 1;
    }
  } catch (error) { record.captureError = String(error.stack ?? error); report.captureError = record.captureError; }
  finally {
    try { await bounded(session.send('Debugger.resume'), 2000, 'Debugger.resume'); paused = false; record.resumed = true; }
    catch (error) { record.resumeError = String(error.stack ?? error); report.captureError = record.resumeError; }
  }
}
try {
  report.scriptSha256 = sha(await readFile(new URL(import.meta.url)));
  const source = await runtimeSnapshot(root, baseline);
  report.originalRuntimeHashes = source.hashes;
  report.harnessHashes = await harnessHashes(root);
  report.currentRuntimeHashes = (await runtimeSnapshot(root)).hashes;
  report.checkout = gitState(root);
  const expectedBytes = await readFile(new URL('./expected-inputs.json', import.meta.url));
  if (sha(expectedBytes) !== expectedInputsSha256) throw new Error('Reviewed input manifest changed');
  const expected = JSON.parse(expectedBytes);
  report.expectedInputsSha256 = expectedInputsSha256;
  if (report.checkout.commit !== expected.candidateCommit || report.checkout.tree !== expected.candidateTree || report.checkout.gitStatus !== '') throw new Error('Candidate is not exact clean reviewed c38');
  if (baseline !== expected.historicalCommit || !sameHashes(source.hashes, expected.historicalRuntimeHashes)) throw new Error('Historical runtime differs from reviewed source');
  if (!sameHashes(report.harnessHashes, expected.harnessHashes) || !sameHashes(report.currentRuntimeHashes, expected.currentRuntimeHashes)) throw new Error('Current runtime/harness differs from reviewed source');
  report.reviewedInputsVerified = true;
  const expectedInjected = '__bench.begin();\n' + source.scripts.map(path => `${source.files.get(path).toString('utf8')}\n//# sourceURL=${path}\n`).join('\n');
  report.expectedInjectedSourceSha256 = sha(expectedInjected);
  let line = 2;
  report.runtimeLineMap = source.scripts.map(path => { const startLine = line; line += source.files.get(path).toString('utf8').split('\n').length + 2; return { path, startLine, endLine: line - 3 }; });
  browser = await chromium.launch({ headless: true });
  report.chromium = browser.version();
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (...args) => {
    const context = await newContext(...args), close = context.close.bind(context);
    context.close = async (...closeArgs) => {
      try {
        await stopTrace();
        await Promise.all(pauseTasks);
        if (session) {
          await bounded(session.send('Debugger.setPauseOnExceptions', { state: 'none' }), 2000, 'Disable exception pauses');
          if (paused) { await bounded(session.send('Debugger.resume'), 2000, 'Cleanup resume'); paused = false; }
          await bounded(session.detach(), 2000, 'Detach diagnostic session');
          report.diagnosticSessionDetached = true;
        }
      } catch (error) { report.diagnosticCleanupError = String(error.stack ?? error); }
      finally {
        try { const result = await close(...closeArgs); report.contextClosed = true; return result; }
        catch (error) { report.contextCloseError = String(error.stack ?? error); throw error; }
      }
    };
    const newPage = context.newPage.bind(context);
    context.newPage = async (...pageArgs) => {
      const page = await newPage(...pageArgs);
      page.on('console', message => report.console.push({ type: message.type(), text: message.text() }));
      page.on('pageerror', error => report.pageErrors.push(String(error)));
      page.on('crash', () => report.crashed = true);
      page.on('requestfailed', request => report.requestFailures.push({ url: request.url(), error: request.failure()?.errorText }));
      page.on('response', response => { if (response.status() >= 400) report.httpErrors.push({ url: response.url(), status: response.status() }); });
      session = await context.newCDPSession(page);
      session.on('Tracing.dataCollected', bucket => {
        for (const event of bucket.value) { if (traceEvents.length < eventLimit) traceEvents.push(event); else traceDropped++; }
      });
      session.on('Tracing.tracingComplete', result => traceCompleteResolve(result));
      session.on('Debugger.paused', event => {
        paused = true;
        const task = onPaused(event).catch(error => { report.pauseHandlerError = String(error.stack ?? error); });
        pauseTasks.push(task);
      });
      await bounded(session.send('Debugger.enable'), 5000, 'Debugger.enable');
      await bounded(session.send('Debugger.setPauseOnExceptions', { state: 'all' }), 5000, 'Enable exception pauses');
      await bounded(session.send('Tracing.start', { transferMode: 'ReportEvents', traceConfig: {
        recordMode: 'recordUntilFull', traceBufferSizeInKb: 32768, includedCategories: report.traceCategories
      } }), 5000, 'Tracing.start');
      traceStarted = true;
      const addScriptTag = page.addScriptTag.bind(page), evaluate = page.evaluate.bind(page);
      page.addScriptTag = async options => {
        if (options.content !== expectedInjected) throw new Error('Original harness injection bytes changed');
        report.actualInjectedSourceSha256 = sha(options.content);
        report.phase = 'startup';
        // Forward identical options/content, with no prefix or transformed code.
        return addScriptTag(options);
      };
      page.evaluate = async (fn, arg) => {
        const text = typeof fn === 'function' ? fn.toString() : String(fn);
        const kind = text.includes('__bench.check()') ? 'check' : text.includes('__bench.done') ? 'done' : 'evaluate';
        const call = { index: report.calls.length, phase: report.phase ?? 'setup', kind, hostStartedAt: new Date().toISOString() };
        report.calls.push(call); report.inFlight = { index: call.index, phase: call.phase, kind };
        let result;
        try { result = await evaluate(fn, arg); call.status = 'completed'; if (kind === 'done') call.timing = result; }
        catch (error) {
          call.status = 'failed'; call.error = String(error.stack ?? error);
          report.originalRejectedError = error;
          report.originalRejection = { callIndex: call.index, kind, phase: call.phase, error: call.error };
          throw error;
        } finally { call.hostFinishedAt = new Date().toISOString(); report.inFlight = null; }
        if (kind === 'check' && call.phase === 'startup') { report.originalStartupCheckPassed = true; throw new Error('DIAGNOSTIC_STOP_AFTER_STARTUP'); }
        return result;
      };
      return page;
    };
    return context;
  };
  try { await runWorkload(browser, source, workloads.find(workload => workload.name === 'reading-80')); throw new Error('Did not stop after original startup'); }
  catch (error) {
    const stopped = report.originalStartupCheckPassed && String(error).includes('DIAGNOSTIC_STOP_AFTER_STARTUP');
    const originalRejected = report.originalRejectedError === error;
    report.outcome = stopped ? 'original-startup-check-passed-diagnostic' : originalRejected ? 'original-startup-rejected-diagnostic' : 'diagnostic-setup-timeout-or-cleanup-error';
    report.error = String(error.stack ?? error);
    if (!stopped && !originalRejected) process.exitCode = 1;
    delete report.originalRejectedError;
  }
} catch (error) { report.setupError = String(error.stack ?? error); process.exitCode = 1; }
finally {
  try { if (paused && session) { await bounded(session.send('Debugger.resume'), 2000, 'Final resume'); paused = false; } }
  catch (error) { report.finalResumeError = String(error.stack ?? error); process.exitCode = 1; }
  try { await browser?.close(); report.browserClosed = true; } catch (error) { report.browserCloseError = String(error.stack ?? error); process.exitCode = 1; }
  await Promise.all(pauseTasks);
  report.finishedAt = new Date().toISOString();
  report.scriptSha256After = sha(await readFile(new URL(import.meta.url)));
  report.scriptStable = report.scriptSha256After === report.scriptSha256;
  report.checkoutAfter = gitState(root);
  report.harnessHashesAfter = await harnessHashes(root);
  report.currentRuntimeHashesAfter = (await runtimeSnapshot(root)).hashes;
  report.harnessStable = Boolean(report.harnessHashes && sameHashes(report.harnessHashesAfter, report.harnessHashes));
  report.currentRuntimeStable = Boolean(report.currentRuntimeHashes && sameHashes(report.currentRuntimeHashesAfter, report.currentRuntimeHashes));
  report.checkoutStable = JSON.stringify(report.checkout) === JSON.stringify(report.checkoutAfter);
  const raw = JSON.stringify({ traceEvents }, null, 2) + '\n';
  const nativeTracePath = output + '.trace.json';
  await writeFile(nativeTracePath, raw, { flag: 'wx' });
  const names = {};
  for (const event of traceEvents) names[event.name] = (names[event.name] ?? 0) + 1;
  report.nativeTrace = { path: nativeTracePath, sha256: sha(raw), eventLimit, count: traceEvents.length, dropped: traceDropped, complete: traceFinished, names };
  report.diagnosticIntegrity = Boolean(report.reviewedInputsVerified && report.scriptStable && report.harnessStable && report.currentRuntimeStable && report.checkoutStable
    && report.actualInjectedSourceSha256 === report.expectedInjectedSourceSha256 && report.contextClosed && report.browserClosed && report.diagnosticSessionDetached
    && traceFinished && !traceDropped && report.tracingComplete?.dataLossOccurred === false
    && !report.captureError && !report.pauseHandlerError && !report.diagnosticCleanupError && !report.setupError && !report.contextCloseError && !report.browserCloseError && !report.finalResumeError
    && !report.crashed && !report.pageErrors.length && !report.requestFailures.length && !report.httpErrors.length);
  report.causalCaptureReady = Boolean(report.diagnosticIntegrity && report.targetPause && !report.unexpectedPauses && names.TimerInstall && names.EventDispatch);
  report.conclusionBoundary = 'Even causalCaptureReady does not classify cause automatically: independently match native pending timer ID/lifetime/100ms install stack and enclosing event to local original failed-check state. Missing stacks/ambiguous match or a passed original check leaves original reading cause unclassified. Native tracing/debugger overhead remains diagnostic timing interference.';
  if (!report.diagnosticIntegrity) process.exitCode = 1;
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ output, outcome: report.outcome, targetPause: report.targetPause, integrity: report.diagnosticIntegrity, nativeTrace: report.nativeTrace }));
}
