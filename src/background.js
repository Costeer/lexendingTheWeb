(() => {
  "use strict";

  const extension = globalThis.browser ?? globalThis.chrome;
  if (!globalThis.LexendSettings && typeof importScripts === "function") {
    importScripts("settings.js");
  }
  const settingsApi = globalThis.LexendSettings;
  const iconSizes = [16, 32, 48, 128];

  const iconPaths = (active) => Object.fromEntries(
    iconSizes.map((size) => [
      size,
      `assets/icons/icon${active ? "" : "-off"}-${size}.png`
    ])
  );

  const setTabState = async (tabId, active) => {
    if (tabId === undefined) return;

    await Promise.all([
      extension.action.setIcon({ tabId, path: iconPaths(active) }),
      extension.action.setTitle({
        tabId,
        title: `Lexend for the Web: ${active ? "active" : "paused"}`
      })
    ]).catch(() => {});
  };

  const updateAllTabs = async () => {
    const settings = settingsApi.normalizeSettings(
      await extension.storage.sync.get(null)
    );

    await Promise.all([
      extension.action.setIcon({ path: iconPaths(settings.enabled) }),
      extension.action.setTitle({
        title: `Lexend for the Web: ${settings.enabled ? "active" : "paused"}`
      })
    ]);

    const tabs = await extension.tabs.query({});
    await Promise.all(tabs.map(async (tab) => {
      if (tab.id === undefined) return;
      if (!settings.enabled) {
        await setTabState(tab.id, false);
        return;
      }

      try {
        const state = await extension.tabs.sendMessage(tab.id, {
          type: "LEXEND_GET_STATE"
        }, { frameId: 0 });
        await setTabState(tab.id, Boolean(state?.active));
      } catch {
        await setTabState(tab.id, false);
      }
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

    const settings = settingsApi.normalizeSettings(
      await extension.storage.sync.get(null)
    );
    await extension.storage.sync.set(settingsApi.toggleSite(settings, state.hostname));
    await extension.storage.sync.remove?.(["disabledSites", "spacing"]);
  };

  extension.runtime.onMessage.addListener((message, sender) => {
    if (message?.type === "LEXEND_STATE" && sender.frameId === 0) {
      setTabState(sender.tab?.id, Boolean(message.active));
    }
  });

  extension.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === "loading" || changeInfo.url) {
      setTabState(tabId, false);
    }
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
