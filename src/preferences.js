(() => {
  "use strict";

  const api = globalThis.LexendSettings;
  const messageType = "LEXEND_SETTINGS_MUTATE";
  const connectionName = "lexend-settings";
  const preferenceKeys = new Set(api.preferenceKeys);
  const legacyKeys = ["disabledSites", "spacing", "uiStyle"];
  const requireSnapshot = (value) => {
    const normalized = api.normalizeSettings(value);
    if (!value || typeof value !== "object" || Array.isArray(value)
        || [...preferenceKeys].some((key) => value[key] !== normalized[key])
        || !Array.isArray(value.siteRules) || value.siteRules.length !== normalized.siteRules.length
        || value.siteRules.some((rule, index) => ["hostname", "includeSubdomains", "enabled", "scope", "layoutRepair"]
          .some((key) => rule?.[key] !== normalized.siteRules[index]?.[key]))) {
      throw api.settingsError("INVALID_OPERATION", "The saved import snapshot is incomplete. Preview the file again.");
    }
    return normalized;
  };
  const applyOperation = (settings, operation) => {
    switch (operation?.type) {
      case "patch": {
        const changes = operation.changes;
        if (!changes || typeof changes !== "object" || Array.isArray(changes)
            || Object.keys(changes).some((key) => !preferenceKeys.has(key))) {
          throw api.settingsError("INVALID_OPERATION", "Invalid settings change.");
        }
        return api.normalizeSettings({ ...settings, ...changes });
      }
      case "addRule":
        if (!api.validHostname(operation.rule?.hostname)) throw api.settingsError("INVALID_RULE", "Enter a valid domain.");
        if (api.getDirectRule(settings, operation.rule.hostname, operation.rule.includeSubdomains)) {
          throw api.settingsError("DUPLICATE_RULE", "That site already has a rule.");
        }
        return api.setSiteRule(settings, operation.rule);
      case "removeRule":
        return api.removeSiteRule(settings, operation.hostname, operation.includeSubdomains);
      case "updateRule":
        return api.updateSiteRule(settings, operation.hostname, operation.includeSubdomains, operation.changes);
      case "setSiteLayoutRepair":
        if (!api.validHostname(operation.hostname) || (operation.value !== null && typeof operation.value !== "boolean")) throw api.settingsError("INVALID_RULE", "Choose valid layout repair settings for this site.");
        return api.setSiteRule(settings, { hostname: operation.hostname, includeSubdomains: false, layoutRepair: operation.value });
      case "toggleSite":
        if (!api.validHostname(operation.hostname)) throw api.settingsError("INVALID_RULE", "This page cannot have a site rule.");
        return api.toggleSite(settings, operation.hostname);
      case "replace":
        if (Object.hasOwn(operation, "expected")) requireSnapshot(operation.expected);
        api.validateImport({ schemaVersion: 3, settings: operation.settings });
        return api.validateCapacity(requireSnapshot(operation.settings));
      case "undoImport":
        if (!api.settingsEqual(settings, requireSnapshot(operation.expected))) {
          throw api.settingsError("STALE_UNDO", "Settings changed before undo could finish. Review the current settings before trying undo again.");
        }
        return api.validateCapacity(api.restoreImport(settings,
          requireSnapshot(operation.before), requireSnapshot(operation.after)));
      default:
        throw api.settingsError("INVALID_OPERATION", "Invalid settings change.");
    }
  };

  const validateExpected = (settings, operation) => {
    if (operation?.expected === undefined || !["patch", "replace", "addRule", "removeRule", "updateRule", "toggleSite", "setSiteLayoutRepair"].includes(operation.type)) return;
    if (!operation.expected || typeof operation.expected !== "object" || Array.isArray(operation.expected)) {
      throw api.settingsError("INVALID_OPERATION", "Invalid expected settings snapshot.");
    }
    // Run guards only against the latest storage read in the writer queue;
    // optimistic overlays in the client must not compare speculative state.
    if (operation.type === "patch") {
      if (!operation.changes || typeof operation.changes !== "object" || Array.isArray(operation.changes)) {
        throw api.settingsError("INVALID_OPERATION", "Invalid settings change.");
      }
      const keys = Object.keys(operation.changes);
      if (keys.some((key) => !Object.hasOwn(operation.expected, key))) {
        throw api.settingsError("INVALID_OPERATION", "Invalid expected settings snapshot.");
      }
      const expected = api.normalizeSettings(operation.expected);
      if (keys.some((key) => settings[key] !== expected[key])) {
        throw api.settingsError("STALE_SETTINGS", "These preferences changed before the retry could be saved. Review the current values and apply your change again.");
      }
    } else if (operation.type === "replace") {
      if (!api.settingsEqual(settings, operation.expected)) {
        throw api.settingsError("STALE_IMPORT", "Settings changed before this replacement could be saved. Review your settings and import the file again.");
      }
    } else {
      if (!Array.isArray(operation.expected.siteRules)
          || (operation.type === "toggleSite" && !Object.hasOwn(operation.expected, "enabled"))) {
        throw api.settingsError("INVALID_OPERATION", "Invalid expected settings snapshot.");
      }
      const expected = api.normalizeSettings(operation.expected);
      if (!api.settingsEqual({ siteRules: settings.siteRules }, { siteRules: expected.siteRules })
          || (operation.type === "toggleSite" && settings.enabled !== expected.enabled)) {
        throw api.settingsError("STALE_SETTINGS", "Site rules changed before the retry could be saved. Review the current values and apply your change again.");
      }
    }
  };

  const createStore = (storage) => {
    let queue = Promise.resolve();
    return {
      mutate(operation) {
        const write = async () => {
          const raw = await storage.get(null);
          const current = api.decodeSettings(raw);
          validateExpected(current, operation);
          const next = applyOperation(current, operation);
          const encoded = api.encodeSettingsForStorage(next, raw);
          const rulesChanged = !api.settingsEqual({ siteRules: current.siteRules }, { siteRules: next.siteRules });
          // Validate the representation this profile can actually write. A
          // compact-capable model can still exceed the compatible array quota.
          // Existing oversized rules remain untouched by unrelated edits.
          const rulesFit = api.storedRuleBytes(encoded) <= api.MAX_SITE_RULE_BYTES;
          if (rulesChanged && (!rulesFit || next.siteRules.length > api.MAX_SITE_RULES)) {
            throw api.settingsError("RULE_CAPACITY", "There isn't room for these site rules. Remove some rules before adding or importing more.");
          }
          const patch = Object.fromEntries(Object.entries(encoded).filter(([key, value]) => (
            JSON.stringify(value) !== JSON.stringify(raw[key])
          )));
          if (Object.keys(patch).length) await storage.set(patch);
          // Once the canonical keys are stored, old keys are harmless. Cleanup
          // failure must not make a successful write look like a failed mutation.
          // Each sync remove() counts against the write quota, so only remove
          // keys that this snapshot actually contains.
          const canonicalRules = Object.hasOwn(encoded, "siteRules") && rulesFit;
          const staleKeys = legacyKeys.filter((key) => Object.hasOwn(raw, key)
            && (canonicalRules || key !== "disabledSites"));
          if (staleKeys.length) try { await storage.remove?.(staleKeys); } catch {}
          return next;
        };
        const result = queue.then(write, write);
        queue = result.catch(() => {});
        return result;
      }
    };
  };

  const createClient = (extension, { theme = "light", onChange = () => {} } = {}) => {
    let confirmed = api.normalizeSettings({ theme });
    let confirmedRaw = { theme };
    let loaded = false;
    let loading = false;
    let readError = null;
    let generation = 0;
    let eventRevision = 0;
    let responseRevision = 0;
    let startupChanges = {};
    const pending = [];
    let connection;
    let requestId = 0;
    const unavailable = (cause) => {
      const detail = typeof cause?.message === "string" ? cause.message : "";
      const error = api.settingsError("BACKGROUND_UNAVAILABLE",
        "The extension background isn't responding. Reload the extension, then reopen settings."
        + (detail ? ` Background error: ${detail}` : ""));
      if (cause) error.cause = cause;
      return error;
    };
    const sendOperation = (operation) => {
      const runtime = extension?.runtime;
      if (!runtime?.connect) return runtime.sendMessage({ type: messageType, operation });
      // A dedicated connection targets the writer and does not rely on the
      // first response from every runtime.onMessage listener in the extension.
      if (!connection) {
        const port = runtime.connect({ name: connectionName });
        const state = { port, requests: new Map() };
        connection = state;
        port.onMessage.addListener((response) => {
          const request = state.requests.get(response?.id);
          if (!request) return;
          state.requests.delete(response.id);
          clearTimeout(request.timeout);
          request.resolve(response);
        });
        port.onDisconnect.addListener(() => {
          // Read lastError even when idle so Chrome does not report an unchecked
          // disconnect. It exists only during this callback, so preserve its
          // message instead of hiding the reason the background is unavailable.
          // Firefox reports connection errors on the port instead.
          const cause = runtime.lastError ?? port.error;
          if (connection === state) connection = null;
          state.requests.forEach((request) => {
            clearTimeout(request.timeout);
            request.reject(unavailable(cause));
          });
          state.requests.clear();
        });
      }
      const state = connection;
      return new Promise((resolve, reject) => {
        const id = ++requestId;
        const timeout = setTimeout(() => {
          state.requests.delete(id);
          if (connection === state) connection = null;
          try { state.port.disconnect(); } catch {}
          reject(unavailable());
        }, 15000);
        state.requests.set(id, { resolve, reject, timeout });
        try { state.port.postMessage({ id, operation }); }
        catch (error) {
          state.requests.delete(id);
          clearTimeout(timeout);
          if (connection === state) connection = null;
          reject(unavailable(error));
        }
      });
    };
    const current = () => pending.reduce((value, entry) => (
      entry.operation.type === "patch" ? applyOperation(value, entry.operation) : value
    ), confirmed);
    const emit = () => onChange(current(), loaded, readError);
    extension?.storage?.onChanged?.addListener((changes, areaName) => {
      if (areaName !== "sync") return;
      eventRevision++;
      if (loading || !loaded) {
        Object.assign(startupChanges, changes);
        return;
      }
      const next = { ...confirmedRaw };
      Object.entries(changes).forEach(([key, change]) => {
        if (change.newValue === undefined) delete next[key];
        else next[key] = change.newValue;
      });
      try {
        confirmed = api.decodeSettings(next);
        confirmedRaw = next;
        readError = null;
      } catch (error) {
        // Keep the last readable settings, but block writes until a successful
        // reload reconciles the persisted state instead of overwriting it.
        confirmedRaw = next;
        loaded = false;
        readError = error;
      }
      emit();
    });
    return {
      get loaded() { return loaded; },
      get readError() { return readError; },
      get settings() { return current(); },
      // Import recovery needs committed state without pending optimistic edits.
      get confirmedSettings() { return api.normalizeSettings(confirmed); },
      async load() {
        const revision = ++generation;
        loading = true;
        loaded = false;
        readError = null;
        startupChanges = {};
        emit();
        try {
          const raw = extension?.storage?.sync ? await extension.storage.sync.get(null) : confirmed;
          if (revision !== generation) return current();
          const next = { ...raw };
          Object.entries(startupChanges).forEach(([key, change]) => {
            if (change.newValue === undefined) delete next[key];
            else next[key] = change.newValue;
          });
          confirmed = api.decodeSettings(next);
          confirmedRaw = next;
          loaded = true;
          loading = false;
          readError = null;
          emit();
          return current();
        } catch (error) {
          if (revision === generation) { loading = false; readError = error; emit(); }
          throw error;
        }
      },
      async mutate(operation) {
        if (!loaded) throw api.settingsError("NOT_LOADED", "Wait until your settings have loaded.");
        if (!extension?.runtime?.connect && !extension?.runtime?.sendMessage) throw api.settingsError("PREVIEW_ONLY", "Changes are preview-only here.");
        const entry = { operation };
        pending.push(entry);
        emit();
        const revision = eventRevision;
        const loadGeneration = generation;
        try {
          const response = await sendOperation(operation);
          if (!response) throw unavailable();
          if (!response?.ok) throw api.settingsError(response?.code ?? "SAVE_FAILED", response?.message ?? "Changes could not be saved.");
          const reconciliation = ++responseRevision;
          // Do not overwrite a newer storage event with an older response.
          if (revision === eventRevision && loadGeneration === generation) {
            confirmed = api.normalizeSettings(response.settings);
            // A normalized response cannot prove which rule key was written or
            // whether best-effort legacy cleanup succeeded. Read actual bytes
            // instead of inventing a raw snapshot that can hide later events.
            try {
              const raw = await extension.storage.sync.get(null);
              if (revision === eventRevision && loadGeneration === generation && reconciliation === responseRevision) {
                confirmed = api.decodeSettings(raw);
                confirmedRaw = raw;
                readError = null;
              }
            } catch (error) {
              if (revision === eventRevision && loadGeneration === generation && reconciliation === responseRevision) {
                loaded = false;
                readError = error;
              }
            }
          }
          return response.settings;
        } finally {
          pending.splice(pending.indexOf(entry), 1);
          emit();
        }
      }
    };
  };

  globalThis.LexendPreferences = Object.freeze({ createStore, createClient, messageType, connectionName });
})();
