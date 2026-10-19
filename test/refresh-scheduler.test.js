import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

const source = await readFile(new URL("../src/refresh-scheduler.js", import.meta.url), "utf8");

// A deterministic clock: timers run only when the test advances time.
const harness = ({ active = true, starting = false } = {}) => {
  let now = 0, nextId = 1;
  const timers = new Map();
  const calls = [];
  const state = { active, starting, queued: [] };
  const context = {
    performance: { now: () => now },
    setTimeout: (callback, delay) => { const id = nextId++; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout: (id) => { timers.delete(id); }
  };
  runInNewContext(source, context);
  const scheduler = context.LexendRefreshScheduler.create({
    canQueue: () => state.active,
    isStarting: () => state.starting,
    onQueued: (transient) => state.queued.push(transient),
    styleSignature: (element, cssText) => cssText ?? "",
    refresh: () => { calls.push("refresh"); scheduler.claim(); },
    refreshRegions: (roots) => { calls.push(["regions", roots.length]); scheduler.claim(); },
    resumeRepair: () => calls.push("resume")
  });
  const advance = (milliseconds) => {
    now += milliseconds;
    for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at > now) continue;
      timers.delete(id);
      timer.callback();
    }
  };
  return { scheduler, calls, state, timers, advance };
};

test("required refreshes coalesce behind one deadline and urgent work jumps the queue once", () => {
  const h = harness();
  h.scheduler.queue();
  h.scheduler.queue();
  assert.equal(h.timers.size, 1);
  assert.equal(h.scheduler.pending, true);
  h.advance(99);
  assert.deepEqual(h.calls, []);
  h.advance(1);
  assert.deepEqual(h.calls, ["refresh"]);
  assert.equal(h.scheduler.pending, false);

  h.scheduler.queue();
  h.scheduler.queue(true);
  assert.equal(h.timers.size, 1, "the urgent request replaces the ordinary timer");
  h.scheduler.queue(true);
  h.advance(0);
  assert.deepEqual(h.calls, ["refresh", "refresh"]);
});

test("the budget delays the next pass by four times an expensive refresh", () => {
  const h = harness();
  h.scheduler.budget(200);
  h.scheduler.queue(true);
  h.advance(799);
  assert.deepEqual(h.calls, []);
  h.advance(1);
  assert.deepEqual(h.calls, ["refresh"]);
  h.scheduler.budget(20);
  h.scheduler.queue();
  h.advance(100);
  assert.deepEqual(h.calls, ["refresh", "refresh"], "cheap full passes use the ordinary 100ms coalescing delay");
});

test("reverted transient changes resume a deferred repair instead of converting again", () => {
  const h = harness();
  const element = { isConnected: true, attributes: { "aria-hidden": "true", style: "color: red" },
    getAttribute(name) { return this.attributes[name] ?? null; } };
  h.scheduler.queue(false, [{ target: element, oldValue: "true" }], new Map([[element, "color: red"]]));
  assert.deepEqual(h.state.queued, [true]);
  assert.equal(h.scheduler.hasQueuedWork, true);
  h.advance(100);
  assert.deepEqual(h.calls, ["resume"]);
  assert.equal(h.scheduler.hasQueuedWork, false);

  element.attributes["aria-hidden"] = "false";
  h.scheduler.queue(false, [{ target: element, oldValue: "true" }]);
  h.advance(100);
  assert.deepEqual(h.calls, ["resume", "refresh"], "a lasting change still converts");
});

test("regional work stays regional until any global change joins it", () => {
  const h = harness();
  h.scheduler.queue(false, null, null, null, ["root-a"]);
  h.scheduler.queue(false, null, null, null, ["root-b", "root-a"]);
  h.advance(100);
  assert.deepEqual(h.calls, [["regions", 2]]);
  h.scheduler.queue(false, null, null, null, ["root-a"]);
  h.scheduler.queue();
  h.scheduler.queue(false, null, null, null, ["root-b"]);
  h.advance(100);
  assert.deepEqual(h.calls, [["regions", 2], "refresh"]);
});

test("claim, cancel, inactive pages and startup never leave a stray refresh", () => {
  const h = harness();
  h.scheduler.queue();
  h.scheduler.claim();
  assert.equal(h.timers.size, 0);
  assert.equal(h.scheduler.hasQueuedWork, false);
  h.scheduler.queue();
  h.scheduler.cancel();
  h.advance(1000);
  assert.deepEqual(h.calls, []);
  assert.equal(h.scheduler.hasQueuedWork, true, "cancel keeps queued work for the caller's own refresh");

  const paused = harness({ active: false });
  paused.scheduler.queue(true);
  assert.equal(paused.timers.size, 0);
  assert.equal(paused.scheduler.hasQueuedWork, false);
  assert.deepEqual(paused.state.queued, []);

  const starting = harness({ starting: true });
  starting.scheduler.queue();
  assert.equal(starting.timers.size, 0, "startup records work without scheduling a capture");
  assert.equal(starting.scheduler.hasQueuedWork, true);
});
