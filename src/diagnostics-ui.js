(() => {
  "use strict";
  const extension = globalThis.browser ?? globalThis.chrome;
  const diagnostics = globalThis.LexendDiagnostics;
  if (!diagnostics) return;

  const loadIdentity = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    try {
      const response = await fetch(extension?.runtime?.getURL?.("build-identity.json") ?? "build-identity.json", { signal: controller.signal });
      if (!response.ok) return null;
      return diagnostics.sanitizeBuildIdentity(await response.json());
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
  let identity;
  const getIdentity = () => identity ??= loadIdentity();
  const versionLabel = document.getElementById("build-version");
  const fingerprintLabel = document.getElementById("build-fingerprint");
  if (versionLabel && fingerprintLabel) {
    getIdentity().then((build) => {
      versionLabel.textContent = build ? `Version ${build.version} · ${build.target === "chrome" ? "Chrome" : "Firefox"}` : "Build identity unavailable";
      fingerprintLabel.textContent = build?.sourceHash ?? "Rebuild and reload the extension to identify this installation.";
    });
  }

  for (const button of document.querySelectorAll("[data-diagnostics-export]")) {
    const status = document.getElementById(button.dataset.diagnosticsStatus);
    if (!status) continue;
    button.addEventListener("click", async () => {
      button.disabled = true;
      status.textContent = "Preparing diagnostics…";
      let url;
      let link;
      try {
        const report = await diagnostics.collect({ extension, buildIdentity: await getIdentity() });
        const blob = new Blob([`${JSON.stringify(report, null, 2)}\n`], { type: "application/json" });
        url = URL.createObjectURL(blob);
        link = document.createElement("a");
        link.href = url;
        link.download = "lexend-the-web-diagnostics.json";
        document.body.append(link);
        link.click();
        status.textContent = "Diagnostics saved locally. Nothing was sent.";
      } catch {
        status.textContent = "Diagnostics could not be saved. Try again.";
      } finally {
        link?.remove();
        if (url) setTimeout(() => URL.revokeObjectURL(url), 1000);
        button.disabled = false;
      }
    });
  }
})();
