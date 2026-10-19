(() => {
  "use strict";

  // Keep failures attached to the intent that failed, not to the most recent
  // request. A newer edit supersedes only the fields/rule it actually changes.
  const createTracker = ({ mutate, getSettings, getConfirmedSettings = getSettings, onChange = () => {} }) => {
    const api = globalThis.LexendSettings;
    const entries = new Set();
    const fields = ["enabled", "layoutRepair", "scope", "theme", "design", "textScale", "lineHeight", "letterSpacing", "siteRules"];
    const ruleKey = (operation) => {
      const rule = operation.rule ?? operation;
      const normalized = api.normalizeSettings({ siteRules: [{ ...rule, enabled: false }] }).siteRules[0];
      return `rule:${normalized?.hostname ?? rule.hostname}:${Boolean(rule.includeSubdomains)}`;
    };
    const keysFor = (operation) => {
      if (!["patch", "addRule", "removeRule", "updateRule", "toggleSite", "setSiteLayoutRepair"].includes(operation?.type)) {
        throw api.settingsError("INVALID_OPERATION", "This operation requires its own recovery flow.");
      }
      if (operation.type === "patch") return Object.keys(operation.changes);
      if (operation.type === "updateRule") return [ruleKey(operation), ruleKey({
        ...operation, includeSubdomains: operation.changes?.includeSubdomains ?? operation.includeSubdomains
      })];
      if (operation.type === "toggleSite") return [...(getSettings().enabled ? [] : ["enabled"]), ruleKey(operation)];
      return [ruleKey(operation)];
    };
    const overlaps = (a, b) => a === b
      || a === "siteRules" && b.startsWith("rule:")
      || b === "siteRules" && a.startsWith("rule:");
    const state = () => ({
      pending: [...entries].filter((entry) => entry.keys.size && entry.pending).length,
      failures: [...entries].filter((entry) => entry.keys.size && entry.error)
        .map((entry) => ({ keys: [...entry.keys], error: entry.error }))
    });
    const emit = () => onChange(state());
    const supersedeKeys = (keys) => {
      for (const entry of entries) {
        for (const key of entry.keys) {
          if ([...keys].some((newKey) => overlaps(key, newKey))) entry.keys.delete(key);
        }
        // Toggle and rule operations cannot be split into independent writes.
        if (entry.operation.type !== "patch" && entry.keys.size !== entry.keyCount) entry.keys.clear();
        if (!entry.keys.size && !entry.pending) entries.delete(entry);
      }
    };
    const run = async (operation, retainedKeys = keysFor(operation), baseline = api.normalizeSettings(getConfirmedSettings()), previousTarget) => {
      const keys = new Set(retainedKeys);
      supersedeKeys(keys);
      const entry = { operation, keys, keyCount: keys.size, baseline, pending: true, error: null };
      if (operation.type === "toggleSite") {
        const settings = getSettings();
        entry.target = previousTarget ?? (settings.enabled ? !api.resolveSite(settings, operation.hostname).siteEnabled : true);
      }
      entries.add(entry);
      emit();
      try {
        const result = await mutate(operation);
        entries.delete(entry);
        return result;
      } catch (error) {
        entry.error = error;
        throw error;
      } finally {
        entry.pending = false;
        if (!entry.keys.size) entries.delete(entry);
        emit();
      }
    };
    const ruleIntentFulfilled = (entry, settings) => {
      const operation = entry.operation;
      if (operation.type === "addRule") {
        const current = api.getDirectRule(settings, operation.rule.hostname, operation.rule.includeSubdomains);
        const desired = api.normalizeSettings({ siteRules: [operation.rule] }).siteRules[0];
        return current && desired && JSON.stringify(current) === JSON.stringify(desired);
      }
      if (operation.type === "setSiteLayoutRepair") {
        const current = api.getDirectRule(settings, operation.hostname);
        return operation.value === null ? current?.layoutRepair === undefined : current?.layoutRepair === operation.value;
      }
      if (operation.type === "removeRule") return !api.getDirectRule(settings, operation.hostname, operation.includeSubdomains);
      if (operation.type === "updateRule") {
        // Compare the complete intended rule with its original confirmed state.
        // A lost reply after a rename/removal must not replay against another
        // identity; a later different edit must still reach the writer guard.
        let desiredSettings;
        try {
          desiredSettings = api.updateSiteRule(entry.baseline, operation.hostname,
            operation.includeSubdomains, operation.changes);
        } catch { return false; }
        const mode = operation.changes.includeSubdomains ?? operation.includeSubdomains;
        const desired = api.getDirectRule(desiredSettings, operation.hostname, mode);
        const current = api.getDirectRule(settings, operation.hostname, mode);
        const original = api.getDirectRule(settings, operation.hostname, operation.includeSubdomains);
        if (!desired) return !original;
        return (Boolean(mode) === Boolean(operation.includeSubdomains) || !original)
          && current && JSON.stringify(current) === JSON.stringify(desired);
      }
      return operation.type === "toggleSite" && settings.enabled
        && api.resolveSite(settings, operation.hostname).siteEnabled === entry.target;
    };
    return {
      mutate: run,
      // Dedicated import/undo flows own their exact operations and retry
      // snapshots. Accepted intent retires overlapping generic retries without
      // enrolling a new operation or performing a write here.
      supersede(fieldNames) {
        if (!Array.isArray(fieldNames)) throw api.settingsError("INVALID_OPERATION", "Invalid settings fields to supersede.");
        const keys = new Set(fieldNames);
        if ([...keys].some((key) => !fields.includes(key))) {
          throw api.settingsError("INVALID_OPERATION", "Invalid settings fields to supersede.");
        }
        if (!keys.size) return;
        supersedeKeys(keys);
        emit();
      },
      get state() { return state(); },
      async retry() {
        const failed = [...entries].filter((entry) => entry.error && entry.keys.size);
        for (const entry of failed) {
          // Recheck after every await: another edit may have superseded part of
          // this intent while an earlier retry was waiting for its write.
          if (!entries.has(entry) || !entry.keys.size) continue;
          let operation = entry.operation;
          const confirmed = api.normalizeSettings(getConfirmedSettings());
          if (operation.type === "patch") {
            const desired = operation.changes;
            for (const key of entry.keys) {
              if (api.settingsEqual(confirmed, { ...confirmed, [key]: desired[key] })) entry.keys.delete(key);
            }
            const changes = Object.fromEntries(Object.entries(desired).filter(([key]) => entry.keys.has(key)));
            const expected = Object.fromEntries([...entry.keys].map((key) => [key, entry.baseline[key]]));
            operation = { type: "patch", changes, expected };
          } else if (ruleIntentFulfilled(entry, confirmed)) {
            // A write with a lost response or another page already fulfilled
            // the requested state. Replaying a toggle would reverse it.
            entry.keys.clear();
          } else {
            operation = { ...operation, expected: { siteRules: entry.baseline.siteRules,
              ...(operation.type === "toggleSite" ? { enabled: entry.baseline.enabled } : {}) } };
          }
          if (!entry.keys.size) { entries.delete(entry); emit(); continue; }
          // Writer-side guards compare the original confirmed values inside
          // the serialized queue. Never rebase unresolved fields onto newer
          // remote values: a conflict stays visible for review/reapplication.
          try { await run(operation, [...entry.keys], entry.baseline, entry.target); }
          catch { /* Keep each unresolved failure visible. */ }
        }
      }
    };
  };
  globalThis.LexendSaveRecovery = Object.freeze({ createTracker });
})();
