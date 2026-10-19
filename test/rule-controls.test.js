import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryStorage } from "./helpers/memory-storage.js";
import "../src/settings.js";
import "../src/preferences.js";

const api = globalThis.LexendSettings;
const fixture = (initial = {}) => {
  const memory = createMemoryStorage(initial);
  let failWrite = false;
  const store = LexendPreferences.createStore({ ...memory.storage, async set(patch) {
    if (failWrite) throw new Error("Write failed");
    await memory.storage.set(patch);
  } });
  return { store, writes: memory.writes, saved: () => api.normalizeSettings(memory.saved()), failWrite: (value) => { failWrite = value; } };
};
const update = (hostname, changes, includeSubdomains = false) => ({ type: "updateRule", hostname, includeSubdomains, changes });
const applyPreview = (preview) => ({ type: "replace", settings: preview.after, expected: preview.before });
const undoPreview = (preview, expected) => ({ type: "undoImport", before: preview.before, after: preview.after, expected });

test("an imported scope-only rule can be edited without losing independent overrides", async () => {
  const initial = api.validateImport({ schemaVersion: 3, settings: api.normalizeSettings({ siteRules: [
    { hostname: "example.com", includeSubdomains: true, enabled: false, scope: "body" },
    { hostname: "docs.example.com", scope: "all" }
  ] }) });
  const f = fixture(initial);
  await f.store.mutate(update("docs.example.com", { enabled: true }));
  assert.deepEqual(api.getDirectRule(f.saved(), "docs.example.com"), {
    hostname: "docs.example.com", includeSubdomains: false, enabled: true, scope: "all"
  });
  await f.store.mutate(update("docs.example.com", { enabled: null }));
  let resolved = api.resolveSite(f.saved(), "docs.example.com");
  assert.equal(resolved.siteEnabled, false);
  assert.equal(resolved.enabledRule.hostname, "example.com");
  assert.equal(resolved.scope, "all");
  assert.equal(resolved.scopeRule.hostname, "docs.example.com");
  await f.store.mutate(update("docs.example.com", { enabled: true, scope: null }));
  resolved = api.resolveSite(f.saved(), "docs.example.com");
  assert.equal(resolved.siteEnabled, true);
  assert.equal(resolved.scope, "body");
  assert.equal(resolved.scopeRule.hostname, "example.com");
  await f.store.mutate(update("docs.example.com", { enabled: null }));
  assert.equal(api.getDirectRule(f.saved(), "docs.example.com"), null);
  assert.equal(api.resolveSite(f.saved(), "docs.example.com").enabledRule.hostname, "example.com");
});

test("exact removal reveals the matching inherited winner for each field", async () => {
  const f = fixture({ scope: "all", siteRules: [
    { hostname: "example.com", includeSubdomains: true, enabled: false, scope: "body" },
    { hostname: "docs.example.com", includeSubdomains: true, enabled: true },
    { hostname: "docs.example.com", enabled: false, scope: "all" }
  ] });
  await f.store.mutate(update("docs.example.com", { enabled: null, scope: null }));
  const result = api.resolveSite(f.saved(), "docs.example.com");
  assert.equal(result.siteEnabled, true);
  assert.equal(result.enabledRule.hostname, "docs.example.com");
  assert.equal(result.enabledRule.includeSubdomains, true);
  assert.equal(result.scope, "body");
  assert.equal(result.scopeRule.hostname, "example.com");
});

test("matching-mode editing preserves values and precedence but rejects identity collisions", async () => {
  const f = fixture({ siteRules: [
    { hostname: "example.com", includeSubdomains: true, enabled: false, scope: "body" },
    { hostname: "docs.example.com", enabled: true, scope: "all" }
  ] });
  await f.store.mutate(update("DOCS.EXAMPLE.COM.", { includeSubdomains: true }));
  const child = api.resolveSite(f.saved(), "child.docs.example.com");
  assert.equal(child.siteEnabled, true);
  assert.equal(child.scope, "all");
  await f.store.mutate({ type: "addRule", rule: { hostname: "docs.example.com", enabled: false, scope: "body" } });
  assert.equal(api.resolveSite(f.saved(), "docs.example.com").siteEnabled, false, "exact wins the hostname tie");
  const before = f.saved();
  await assert.rejects(f.store.mutate(update("docs.example.com", { includeSubdomains: false }, true)), { code: "DUPLICATE_RULE" });
  assert.deepEqual(f.saved(), before);
  await f.store.mutate({ type: "removeRule", hostname: "docs.example.com" });
  assert.equal(api.resolveSite(f.saved(), "docs.example.com").siteEnabled, true);
});

test("missing identities and malformed edits fail instead of creating or erasing rules", async () => {
  const f = fixture({ siteRules: [{ hostname: "example.com", enabled: false, scope: "all" }] });
  const before = f.saved();
  await assert.rejects(f.store.mutate(update("missing.example", { enabled: true })), { code: "RULE_NOT_FOUND" });
  for (const changes of [null, [], { hostname: "other.example" }, { enabled: "inherit" }, { enabled: undefined },
    { scope: "global" }, { includeSubdomains: null }, { includeSubdomains: "false" }]) {
    await assert.rejects(f.store.mutate(update("example.com", changes)), { code: "INVALID_RULE" });
  }
  await assert.rejects(f.store.mutate(update("example.com", { enabled: true }, "false")), { code: "INVALID_RULE" });
  assert.deepEqual(f.saved(), before);
  assert.equal(f.writes.length, 0);
});

test("queued independent rule-field updates retain each other's intent and scalar settings", async () => {
  const f = fixture({ textScale: 127, letterSpacing: .057, siteRules: [{ hostname: "example.com", enabled: false }] });
  await Promise.all([
    f.store.mutate(update("example.com", { scope: "all" })),
    f.store.mutate(update("example.com", { enabled: true })),
    f.store.mutate({ type: "patch", changes: { lineHeight: 1.73 } })
  ]);
  assert.deepEqual(api.getDirectRule(f.saved(), "example.com"), {
    hostname: "example.com", includeSubdomains: false, enabled: true, scope: "all"
  });
  assert.equal(f.saved().textScale, 127);
  assert.equal(f.saved().lineHeight, 1.73);
  assert.equal(f.saved().letterSpacing, .057);
});

test("preview enumerates scalar replacement and every added, removed, or changed rule without writing", () => {
  const original = api.normalizeSettings({ theme: "dark", textScale: 127, lineHeight: 1.73, letterSpacing: .057, siteRules: [
    { hostname: "removed.example", enabled: false },
    { hostname: "changed.example", enabled: false, scope: "all" },
    { hostname: "same.example", scope: "all" }
  ] });
  const imported = api.normalizeSettings({ theme: "dark", siteRules: [
    { hostname: "changed.example", scope: "body" },
    { hostname: "same.example", scope: "all" },
    { hostname: "new.example", includeSubdomains: true, enabled: true }
  ] });
  const originals = structuredClone({ original, imported });
  const preview = api.previewImport(original, imported);
  assert.deepEqual(preview.changes, [
    { key: "textScale", before: 127, after: 100 },
    { key: "lineHeight", before: 1.73, after: 0 },
    { key: "letterSpacing", before: .057, after: 0 }
  ]);
  assert.deepEqual(preview.rules.added.map((rule) => rule.hostname), ["new.example"]);
  assert.deepEqual(preview.rules.removed.map((rule) => rule.hostname), ["removed.example"]);
  assert.deepEqual(preview.rules.changed, [{ before: original.siteRules[1], after: imported.siteRules[0] }]);
  preview.before.siteRules[0].enabled = true;
  preview.after.textScale = 120;
  assert.deepEqual({ original, imported }, originals, "snapshots never alias live normalized settings");
});

test("semantic guards accept reordered rules but reject queued edits after the preview", async () => {
  const f = fixture({ siteRules: [{ hostname: "one.example", enabled: false }, { hostname: "two.example", scope: "all" }] });
  const expected = { ...f.saved(), siteRules: f.saved().siteRules.reverse() };
  const preview = api.previewImport(expected, { textScale: 127, siteRules: expected.siteRules });
  await f.store.mutate(applyPreview(preview));
  assert.equal(f.saved().textScale, 127);
  const stale = api.previewImport(f.saved(), { textScale: 110 });
  const laterEdit = f.store.mutate({ type: "patch", changes: { theme: "dark" } });
  const replacement = f.store.mutate(applyPreview(stale));
  await laterEdit;
  await assert.rejects(replacement, { code: "STALE_IMPORT" });
  assert.equal(f.saved().theme, "dark");
  assert.equal(f.saved().siteRules.length, 2);
  assert.equal(f.saved().textScale, 127);
});

test("conditional undo restores imported changes while retaining later scalar, rule and field edits", async () => {
  const f = fixture({ textScale: 120, siteRules: [
    { hostname: "changed.example", enabled: false, scope: "body" },
    { hostname: "removed.example", scope: "all" },
    { hostname: "deleted-later.example", enabled: true }
  ] });
  const preview = api.previewImport(f.saved(), { textScale: 127, lineHeight: 1.73, siteRules: [
    { hostname: "changed.example", enabled: true, scope: "all" },
    { hostname: "added.example", enabled: false },
    { hostname: "edited-addition.example", enabled: false },
    { hostname: "deleted-later.example", enabled: false }
  ] });
  await f.store.mutate(applyPreview(preview));
  await f.store.mutate({ type: "patch", changes: { theme: "dark", textScale: 135 } });
  await f.store.mutate(update("changed.example", { scope: null }));
  await f.store.mutate(update("edited-addition.example", { scope: "all" }));
  await f.store.mutate({ type: "removeRule", hostname: "deleted-later.example" });
  await f.store.mutate({ type: "addRule", rule: { hostname: "later.example", scope: "body" } });
  await f.store.mutate(undoPreview(preview, f.saved()));
  const saved = f.saved();
  assert.equal(saved.theme, "dark");
  assert.equal(saved.textScale, 135);
  assert.equal(saved.lineHeight, 0);
  assert.equal(api.getDirectRule(saved, "changed.example").enabled, false);
  assert.equal(api.getDirectRule(saved, "changed.example").scope, null, "later scope choice survives enabled recovery");
  assert.equal(api.getDirectRule(saved, "removed.example").scope, "all");
  assert.equal(api.getDirectRule(saved, "added.example"), null);
  assert.equal(api.getDirectRule(saved, "edited-addition.example").scope, "all");
  assert.equal(api.getDirectRule(saved, "deleted-later.example"), null);
  assert.equal(api.getDirectRule(saved, "later.example").scope, "body");
});

test("undo preserves a new rule at the identity an import removed", async () => {
  const f = fixture({ siteRules: [{ hostname: "example.com", enabled: false, scope: "all" }] });
  const preview = api.previewImport(f.saved(), {});
  await f.store.mutate(applyPreview(preview));
  await f.store.mutate({ type: "addRule", rule: { hostname: "example.com", enabled: true } });
  await f.store.mutate(undoPreview(preview, f.saved()));
  assert.deepEqual(api.getDirectRule(f.saved(), "example.com"), {
    hostname: "example.com", includeSubdomains: false, enabled: true, scope: null
  });
});

test("failed guarded apply may retry only while the preview still matches", async () => {
  const f = fixture({ textScale: 120 });
  const preview = api.previewImport(f.saved(), { textScale: 127 });
  const operation = applyPreview(preview);
  f.failWrite(true);
  await assert.rejects(f.store.mutate(operation), /Write failed/);
  assert.equal(f.saved().textScale, 120);
  f.failWrite(false);
  await f.store.mutate({ type: "patch", changes: { theme: "dark" } });
  await assert.rejects(f.store.mutate(operation), { code: "STALE_IMPORT" });
  assert.equal(f.saved().theme, "dark");
  assert.equal(f.saved().textScale, 120);
});

test("undo rejects a queued competing edit and an ambiguous successful-write retry", async () => {
  const f = fixture({ textScale: 120, siteRules: [{ hostname: "old.example", enabled: false }] });
  const preview = api.previewImport(f.saved(), { textScale: 127 });
  await f.store.mutate(applyPreview(preview));
  const staleUndo = undoPreview(preview, f.saved());
  const edit = f.store.mutate({ type: "patch", changes: { theme: "dark" } });
  const undo = f.store.mutate(staleUndo);
  await edit;
  await assert.rejects(undo, { code: "STALE_UNDO" });
  const reviewedUndo = undoPreview(preview, f.saved());
  await f.store.mutate(reviewedUndo);
  // Model a lost response: the writer committed, and the client resends the
  // exact operation. It must not overwrite a later edit or duplicate a rule.
  await f.store.mutate({ type: "patch", changes: { lineHeight: 1.73 } });
  const writes = f.writes.length;
  await assert.rejects(f.store.mutate(reviewedUndo), { code: "STALE_UNDO" });
  assert.equal(f.writes.length, writes);
  assert.equal(f.saved().textScale, 120);
  assert.equal(f.saved().theme, "dark");
  assert.equal(f.saved().lineHeight, 1.73);
  assert.equal(f.saved().siteRules.length, 1);
});

test("unchanged-state retry recovers a failed undo, and incomplete snapshots never write defaults", async () => {
  const f = fixture({ textScale: 120 });
  const preview = api.previewImport(f.saved(), { textScale: 127 });
  await f.store.mutate(applyPreview(preview));
  const undo = undoPreview(preview, f.saved());
  f.failWrite(true);
  await assert.rejects(f.store.mutate(undo), /Write failed/);
  f.failWrite(false);
  await f.store.mutate(undo);
  assert.equal(f.saved().textScale, 120);
  const writes = f.writes.length;
  for (const operation of [
    { type: "replace", settings: preview.after, expected: null },
    { type: "undoImport", before: {}, after: preview.after, expected: f.saved() },
    { type: "undoImport", before: preview.before, after: preview.after }
  ]) await assert.rejects(f.store.mutate(operation), { code: "INVALID_OPERATION" });
  assert.equal(f.writes.length, writes);
});

test("conditional recovery is idempotent and cannot mutate its input snapshots", () => {
  const original = api.normalizeSettings({ textScale: 120, siteRules: [{ hostname: "old.example", enabled: false }] });
  const imported = api.normalizeSettings({ textScale: 127, siteRules: [{ hostname: "new.example", scope: "all" }] });
  const snapshots = structuredClone({ original, imported });
  const restored = api.restoreImport(imported, original, imported);
  assert.deepEqual(restored, original);
  assert.deepEqual(api.restoreImport(restored, original, imported), restored);
  assert.deepEqual({ original, imported }, snapshots);
});
