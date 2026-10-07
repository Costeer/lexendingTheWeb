(() => {
  "use strict";

  const extension = globalThis.browser ?? globalThis.chrome;
  if (!globalThis.LexendSettings && typeof importScripts === "function") {
    importScripts("settings.js", "preferences.js");
  }
  const settingsApi = globalThis.LexendSettings;
  const store = globalThis.LexendPreferences.createStore(extension.storage.sync);
  const iconSizes = [16, 32, 48, 128];

  const iconPaths = (active) => Object.fromEntries(
    iconSizes.map((size) => [
      size,
      `assets/icons/icon${active ? "" : "-off"}-${size}.png`
    ])
  );
  const icons = { active: iconPaths(true), paused: iconPaths(false) };
  const tabStates = new Map();
  const tabErrors = new Set();
  const tabRevisions = new Map();
  let refreshRevision = 0;
  const advanceTab = (tabId) => {
    const revision = (tabRevisions.get(tabId) ?? 0) + 1;
    tabRevisions.set(tabId, revision);
    return revision;
  };
  const refreshTab = async (tabId) => {
    const revision = advanceTab(tabId);
    try {
      const state = await extension.tabs.sendMessage(tabId, { type: "LEXEND_GET_STATE" }, { frameId: 0 });
      if (tabRevisions.get(tabId) === revision) await setTabState(tabId, Boolean(state?.ready && state.active));
    } catch {
      if (tabRevisions.get(tabId) === revision) await setTabState(tabId, false);
    }
  };

  const setTabState = async (tabId, active) => {
    if (tabId === undefined) return;
    if (tabStates.get(tabId) === active && !tabErrors.has(tabId)) return;
    tabStates.set(tabId, active);
    const hadError = tabErrors.delete(tabId);

    await Promise.all([
      extension.action.setIcon({ tabId, path: icons[active ? "active" : "paused"] }),
      extension.action.setTitle({
        tabId,
        title: `Lexend for the Web: ${active ? "active" : "paused"}`
      }),
      ...(hadError ? [extension.action.setBadgeText?.({ tabId, text: "" })] : [])
    ]).catch(() => {
      if (tabStates.get(tabId) === active) tabStates.delete(tabId);
      if (hadError) tabErrors.add(tabId);
    });
  };
  const showTabError = async (tabId, error) => {
    tabErrors.add(tabId);
    await Promise.all([
      extension.action.setBadgeText?.({ tabId, text: "!" }),
      extension.action.setBadgeBackgroundColor?.({ tabId, color: "#D90000" }),
      extension.action.setBadgeTextColor?.({ tabId, color: "#FFFFFF" }),
      extension.action.setTitle({ tabId, title: `Lexend for the Web: ${error.message || "This site could not be toggled."}` })
    ]).catch(() => { tabErrors.delete(tabId); });
  };

  const updateAllTabs = async () => {
    const revision = ++refreshRevision;
    const settings = settingsApi.normalizeSettings(
      await extension.storage.sync.get(null)
    );
    if (revision !== refreshRevision) return;

    await Promise.all([
      extension.action.setIcon({ path: icons[settings.enabled ? "active" : "paused"] }),
      extension.action.setTitle({
        title: `Lexend for the Web: ${settings.enabled ? "active" : "paused"}`
      })
    ]);

    const tabs = await extension.tabs.query({});
    if (revision !== refreshRevision) return;
    await Promise.all(tabs.map(async (tab) => {
      if (tab.id === undefined) return;
      if (!settings.enabled) {
        advanceTab(tab.id);
        await setTabState(tab.id, false);
        return;
      }

      await refreshTab(tab.id);
    }));
  };

  const toggleCurrentSite = async () => {
    const [tab] = await extension.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) return;

    let state;
    try {
      state = await extension.tabs.sendMessage(tab.id, {
        type: "LEXEND_GET_STATE"
      }, { frameId: 0 });
    } catch {
      return;
    }
    if (!state?.ready || !settingsApi.validHostname(state.hostname)) return;

    try {
      await store.mutate({ type: "toggleSite", hostname: state.hostname });
    } catch (error) {
      await showTabError(tab.id, error);
      throw error;
    }
  };

  extension.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "LEXEND_FRAME_REQUIREMENT") {
      // Runtime sender metadata identifies the actual extension/frame. Page
      // postMessage events can lose their source in an isolated content world.
      if (sender.id !== extension.runtime.id || !Number.isInteger(sender.tab?.id)
          || !Number.isInteger(sender.frameId) || sender.frameId <= 0) return undefined;
      let frameUrl;
      try {
        frameUrl = new URL(sender.url);
        if (!["http:", "https:", "about:", "blob:"].includes(frameUrl.protocol)) return undefined;
      } catch { return undefined; }
      const requirement = message.requirement;
      if (requirement !== null && (!requirement || typeof requirement !== "object" || Array.isArray(requirement)
          || ![requirement.viewportHeight, requirement.requiredHeight, requirement.baselineHeight].every(Number.isFinite)
          || requirement.viewportHeight <= 0 || requirement.viewportHeight > 160
          || requirement.requiredHeight <= requirement.viewportHeight || requirement.requiredHeight > 320
          || requirement.baselineHeight <= 0 || requirement.baselineHeight > 160
          || requirement.baselineHeight > requirement.viewportHeight + 2)) return undefined;
      // Every parent checks only its own unique direct embedding. Broadcasting
      // supports nested frames without adding webNavigation or tabs permission.
      extension.tabs.sendMessage(sender.tab.id, {
        type: "LEXEND_APPLY_FRAME_REQUIREMENT", frameUrl: frameUrl.href,
        sourceFrameId: sender.frameId, requirement
      }).then(() => sendResponse({ relayed: true }), () => sendResponse({ relayed: false }));
      return true;
    }
    if (message?.type === globalThis.LexendPreferences.messageType) {
      // Only our extension pages can mutate settings. Content scripts, which
      // run in third-party tabs, may report state but cannot submit writes.
      if (sender.id !== extension.runtime.id
          || !sender.url?.startsWith(extension.runtime.getURL(""))) {
        sendResponse({ ok: false, code: "FORBIDDEN", message: "Settings changes must come from an extension page." });
        return undefined;
      }
      store.mutate(message.operation).then(
        (settings) => sendResponse({ ok: true, settings }),
        (error) => sendResponse({ ok: false, code: error.code ?? "SAVE_FAILED", message: error.message ?? "Changes could not be saved." })
      );
      return true;
    }
    if (message?.type === "LEXEND_STATE" && sender.frameId === 0) {
      advanceTab(sender.tab?.id);
      setTabState(sender.tab?.id, Boolean(message.active));
    }
  });

  extension.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === "loading") {
      advanceTab(tabId);
      setTabState(tabId, false);
    } else if (changeInfo.url || changeInfo.status === "complete") {
      refreshTab(tabId).catch(() => {});
    }
  });

  extension.tabs.onRemoved?.addListener((tabId) => {
    tabStates.delete(tabId);
    tabErrors.delete(tabId);
    tabRevisions.delete(tabId);
  });

  extension.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "sync" && (changes.enabled || changes.siteRules)) {
      updateAllTabs().catch(() => {});
    }
  });

  extension.commands?.onCommand.addListener((command) => {
    if (command === "toggle-current-site") {
      return toggleCurrentSite().catch((error) => {
        console.warn("Lexend for the Web could not toggle the current site.", error);
      });
    }
  });

  extension.runtime.onInstalled.addListener(() => {
    updateAllTabs().catch(() => {});
  });

  extension.runtime.onStartup.addListener(() => {
    updateAllTabs().catch(() => {});
  });
})();
