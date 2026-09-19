(() => {
  "use strict";

  const extension = globalThis.browser ?? globalThis.chrome;
  const defaults = { enabled: true, disabledSites: [] };
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
        title: `Lexend the Web — ${active ? "active" : "paused"}`
      })
    ]).catch(() => {});
  };

  const updateAllTabs = async () => {
    const { enabled } = await extension.storage.sync.get(defaults);

    await Promise.all([
      extension.action.setIcon({ path: iconPaths(enabled) }),
      extension.action.setTitle({
        title: `Lexend the Web — ${enabled ? "active" : "paused"}`
      })
    ]);

    const tabs = await extension.tabs.query({});
    await Promise.all(tabs.map(async (tab) => {
      if (tab.id === undefined) return;
      if (!enabled) {
        await setTabState(tab.id, false);
        return;
      }

      try {
        const state = await extension.tabs.sendMessage(tab.id, {
          type: "LEXEND_GET_STATE"
        });
        await setTabState(tab.id, Boolean(state?.active));
      } catch {
        await setTabState(tab.id, false);
      }
    }));
  };

  extension.runtime.onMessage.addListener((message, sender) => {
    if (message?.type === "LEXEND_STATE") {
      setTabState(sender.tab?.id, Boolean(message.active));
    }
  });

  extension.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === "loading" || changeInfo.url) {
      setTabState(tabId, false);
    }
  });

  extension.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "sync" && (changes.enabled || changes.disabledSites)) {
      updateAllTabs().catch(() => {});
    }
  });

  extension.runtime.onInstalled.addListener(() => {
    updateAllTabs().catch(() => {});
  });

  extension.runtime.onStartup.addListener(() => {
    updateAllTabs().catch(() => {});
  });
})();
