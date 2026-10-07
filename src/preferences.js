(() => {
  "use strict";

  const api = globalThis.LexendSettings;
  const messageType = "LEXEND_SETTINGS_MUTATE";
  const preferenceKeys = new Set(["enabled", "scope", "theme", "textScale", "lineHeight", "letterSpacing"]);
  const legacyKeys = ["disabledSites", "spacing", "uiStyle"];
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
      case "toggleSite":
        if (!api.validHostname(operation.hostname)) throw api.settingsError("INVALID_RULE", "This page cannot have a site rule.");
        return api.toggleSite(settings, operation.hostname);
      case "replace":
        return api.validateImport({ schemaVersion: 2, settings: operation.settings });
      default:
        throw api.settingsError("INVALID_OPERATION", "Invalid settings change.");
    }
  };

  const createStore = (storage) => {
    let queue = Promise.resolve();
    return {
      mutate(operation) {
        const write = async () => {
          const raw = await storage.get(null);
          const next = applyOperation(api.normalizeSettings(raw), operation);
          // A preference-only edit must not drop existing oversized legacy rules.
          // Rule mutations and imports validate their own capacity above.
          const patch = Object.fromEntries(Object.entries(next).filter(([key, value]) => (
            JSON.stringify(value) !== JSON.stringify(raw[key])
          )));
          if (Object.keys(patch).length) await storage.set(patch);
          // Once the canonical keys are stored, old keys are harmless. Cleanup
          // failure must not make a successful write look like a failed mutation.
          try { await storage.remove?.(legacyKeys); } catch {}
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
    let loaded = false;
    let loading = false;
    let generation = 0;
    let eventRevision = 0;
    let startupChanges = {};
    const pending = [];
    const current = () => pending.reduce((value, entry) => (
      entry.operation.type === "patch" ? applyOperation(value, entry.operation) : value
    ), confirmed);
    const emit = () => onChange(current(), loaded);
    extension?.storage?.onChanged?.addListener((changes, areaName) => {
      if (areaName !== "sync") return;
      eventRevision++;
      if (loading || !loaded) {
        Object.assign(startupChanges, changes);
        return;
      }
      const next = { ...confirmed };
      Object.entries(changes).forEach(([key, change]) => {
        if (change.newValue === undefined) delete next[key];
        else next[key] = change.newValue;
      });
      confirmed = api.normalizeSettings(next);
      emit();
    });
    return {
      get loaded() { return loaded; },
      get settings() { return current(); },
      async load() {
        const revision = ++generation;
        loading = true;
        loaded = false;
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
          confirmed = api.normalizeSettings(next);
          loaded = true;
          loading = false;
          emit();
          return current();
        } catch (error) {
          if (revision === generation) { loading = false; emit(); }
          throw error;
        }
      },
      async mutate(operation) {
        if (!loaded) throw api.settingsError("NOT_LOADED", "Wait until your settings have loaded.");
        if (!extension?.runtime?.sendMessage) throw api.settingsError("PREVIEW_ONLY", "Changes are preview-only here.");
        const entry = { operation };
        pending.push(entry);
        emit();
        const revision = eventRevision;
        try {
          const response = await extension.runtime.sendMessage({ type: messageType, operation });
          if (!response?.ok) throw api.settingsError(response?.code ?? "SAVE_FAILED", response?.message ?? "Changes could not be saved.");
          // Do not overwrite a newer storage event with an older response.
          if (revision === eventRevision) confirmed = api.normalizeSettings(response.settings);
          return response.settings;
        } finally {
          pending.splice(pending.indexOf(entry), 1);
          emit();
        }
      }
    };
  };

  globalThis.LexendPreferences = Object.freeze({ createStore, createClient, messageType });
})();
