(() => {
  "use strict";

  const numericVersion = (value) => typeof value === "string" && /^\d{1,5}(?:\.\d{1,10}){0,3}$/.test(value) ? value : null;
  const sanitizeBuildIdentity = (value) => {
    if (value?.schemaVersion !== 1 || !numericVersion(value.version)
        || !["chrome", "firefox"].includes(value.target)
        || typeof value.sourceHash !== "string" || !/^[a-f0-9]{64}$/.test(value.sourceHash)) return null;
    return { schemaVersion: 1, version: value.version, target: value.target, sourceHash: value.sourceHash };
  };
  const bounded = async (operation) => {
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(operation),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Unavailable")), 1500); })
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const settingsSnapshot = async (extension) => {
    try {
      if (!extension?.storage?.sync?.get) return { status: "unavailable" };
      // Read the shared list lazily: loading this helper must touch nothing.
      const settingKeys = globalThis.LexendSettings.preferenceKeys;
      const saved = await bounded(() => extension.storage.sync.get([...settingKeys, "spacing"]));
      const selected = Object.fromEntries([...settingKeys, "spacing"].map((key) => [key, saved?.[key]]));
      const normalized = globalThis.LexendSettings.normalizeSettings(selected);
      return { status: "available", ...Object.fromEntries(settingKeys.map((key) => [key, normalized[key]])) };
    } catch {
      return { status: "unavailable" };
    }
  };
  // The popup reports the page it was opened over. A tab-based extension page,
  // such as About, is itself the active tab; it reports the most recently used
  // other tab in its window instead, and says so in the report.
  const diagnosticTab = async (extension) => {
    const current = typeof extension.tabs.getCurrent === "function"
      ? await bounded(() => extension.tabs.getCurrent()) : undefined;
    if (!Number.isInteger(current?.id)) {
      const [tab] = await bounded(() => extension.tabs.query({ active: true, currentWindow: true }));
      return { tab, source: null };
    }
    const tabs = await bounded(() => extension.tabs.query({ currentWindow: true }));
    const [tab] = (Array.isArray(tabs) ? tabs : [])
      .filter((candidate) => Number.isInteger(candidate?.id) && candidate.id !== current.id)
      .sort((left, right) => (Number(right.lastAccessed) || 0) - (Number(left.lastAccessed) || 0));
    return { tab, source: "recent-tab" };
  };
  const runtimeSnapshot = async (extension) => {
    try {
      if (!extension?.tabs?.query || !extension.tabs.sendMessage) return { status: "unavailable" };
      const { tab, source } = await diagnosticTab(extension);
      if (!Number.isInteger(tab?.id)) return { status: "unavailable" };
      const state = await bounded(() => extension.tabs.sendMessage(tab.id, { type: "LEXEND_GET_STATE" }, { frameId: 0 }));
      if (!state || typeof state.ready !== "boolean") return { status: "unavailable" };
      const result = { status: "available", ...(source ? { source } : {}) };
      for (const key of ["ready", "pending", "healthy", "active", "layoutRepair"]) {
        if (typeof state[key] === "boolean") result[key] = state[key];
      }
      if (Number.isSafeInteger(state.refreshRevision) && state.refreshRevision >= 0) result.refreshRevision = state.refreshRevision;
      if (["body", "all"].includes(state.scope)) result.scope = state.scope;
      // Runtime errors can contain page text or addresses. Export only presence.
      result.hasError = state.error !== undefined && state.error !== null;
      return result;
    } catch {
      return { status: "unavailable" };
    }
  };
  const browserSnapshot = async (extension, navigator) => {
    try {
      if (extension?.runtime?.getBrowserInfo) {
        const info = await bounded(() => extension.runtime.getBrowserInfo());
        if (["Firefox", "Fennec"].includes(info?.name) && numericVersion(info.version)) {
          return { name: info.name, version: info.version, source: "browser-api" };
        }
      }
    } catch {}
    try {
      if (navigator?.userAgentData?.getHighEntropyValues) {
        const info = await bounded(() => navigator.userAgentData.getHighEntropyValues(["fullVersionList"]));
        const versions = Array.isArray(info?.fullVersionList) ? info.fullVersionList.slice(0, 10) : [];
        for (const [brand, name] of [["Microsoft Edge", "Edge"], ["Opera", "Opera"], ["Google Chrome", "Chrome"], ["Chromium", "Chromium"]]) {
          const version = versions.find((entry) => entry?.brand === brand)?.version;
          if (numericVersion(version)) return { name, version, source: "user-agent-data" };
        }
      }
    } catch {}
    // Only the recognized product/version pair leaves the device; never raw UA.
    const ua = typeof navigator?.userAgent === "string" ? navigator.userAgent.slice(0, 2048) : "";
    for (const [token, name] of [["Edg", "Edge"], ["OPR", "Opera"], ["Firefox", "Firefox"], ["Chrome", "Chromium"]]) {
      const version = ua.match(new RegExp(`(?:^|\\s)${token}/([\\d.]+)(?:\\s|$)`))?.[1];
      if (numericVersion(version)) return { name, version, source: "user-agent" };
    }
    return { status: "unavailable" };
  };
  const collect = async ({ extension = globalThis.browser ?? globalThis.chrome,
    navigator = globalThis.navigator, buildIdentity } = {}) => {
    const [settings, runtime, browser] = await Promise.all([
      settingsSnapshot(extension), runtimeSnapshot(extension), browserSnapshot(extension, navigator)
    ]);
    return { schemaVersion: 1, build: sanitizeBuildIdentity(buildIdentity), browser, settings, runtime };
  };

  // Loading this helper performs no collection. About calls collect on a click.
  globalThis.LexendDiagnostics = Object.freeze({ collect, sanitizeBuildIdentity });
})();
