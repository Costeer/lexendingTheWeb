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
        title: `Lexend for the Web — ${active ? "active" : "paused"}`
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
        title: `Lexend for the Web — ${settings.enabled ? "active" : "paused"}`
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

    let url;
    try {
      url = new URL(tab.url ?? "");
    } catch {
      return;
    }
    if (!["http:", "https:"].includes(url.protocol)) return;

    let settings = settingsApi.normalizeSettings(
      await extension.storage.sync.get(null)
    );
    const hostname = url.hostname.toLowerCase();
    const effective = settingsApi.resolveSite(settings, hostname);
    if (!settings.enabled) {
      settings = { ...settings, enabled: true };
      if (!effective.siteEnabled) {
        settings = settingsApi.setSiteRule(settings, {
          hostname,
          includeSubdomains: false,
          enabled: true
        });
      }
    } else {
      settings = settingsApi.setSiteRule(settings, {
        hostname,
        includeSubdomains: false,
        enabled: !effective.siteEnabled
      });
    }

    await extension.storage.sync.set(settings);
    await extension.storage.sync.remove?.(["disabledSites", "spacing"]);
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
    if (areaName === "sync" && (changes.enabled || changes.siteRules)) {
      updateAllTabs().catch(() => {});
    }
  });

  extension.commands?.onCommand.addListener((command) => {
    if (command === "toggle-current-site") toggleCurrentSite().catch(() => {});
  });

  extension.runtime.onInstalled.addListener(() => {
    updateAllTabs().catch(() => {});
  });

  extension.runtime.onStartup.addListener(() => {
    updateAllTabs().catch(() => {});
  });
})();
