(() => {
  "use strict";

  const defaults = Object.freeze({
    enabled: true,
    scope: "body",
    siteRules: [],
    textScale: 100,
    lineHeight: 0,
    letterSpacing: 0
  });
  const MAX_SITE_RULE_BYTES = 7000;

  const validHostname = (hostname) => {
    if (typeof hostname !== "string" || !hostname.length || hostname.length > 253) {
      return false;
    }
    if (/^\[[0-9a-f:]+\]$/.test(hostname)) return true;
    return hostname.split(".").every((label) => (
      label.length > 0
      && label.length <= 63
      && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
    ));
  };

  const clampNumber = (value, fallback, min, max, precision = 0) => {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    const clamped = Math.min(max, Math.max(min, number));
    return Number(clamped.toFixed(precision));
  };

  const normalizeRule = (rule) => {
    const hostname = typeof rule?.hostname === "string"
      ? rule.hostname.trim().toLowerCase().replace(/\.$/, "")
      : "";
    if (!validHostname(hostname)) return null;

    const enabled = typeof rule.enabled === "boolean" ? rule.enabled : null;
    const scope = ["body", "all"].includes(rule.scope) ? rule.scope : null;
    if (enabled === null && scope === null) return null;

    return {
      hostname,
      includeSubdomains: Boolean(rule.includeSubdomains),
      enabled,
      scope
    };
  };

  const normalizeSettings = (value = {}) => {
    const sourceRules = Object.prototype.hasOwnProperty.call(value, "siteRules")
      ? value.siteRules
      : (Array.isArray(value.disabledSites)
        ? value.disabledSites.map((hostname) => ({ hostname, enabled: false }))
        : []);
    const rules = new Map();

    if (Array.isArray(sourceRules)) {
      sourceRules.slice(0, 250).forEach((candidate) => {
        const rule = normalizeRule(candidate);
        if (!rule) return;
        rules.set(`${rule.hostname}\n${rule.includeSubdomains}`, rule);
      });
    }

    const siteRules = [];
    rules.forEach((rule) => {
      const candidate = [...siteRules, rule];
      if (JSON.stringify(candidate).length <= MAX_SITE_RULE_BYTES) {
        siteRules.push(rule);
      }
    });

    return {
      enabled: typeof value.enabled === "boolean" ? value.enabled : defaults.enabled,
      scope: value.scope === "all" ? "all" : defaults.scope,
      siteRules,
      textScale: clampNumber(value.textScale, defaults.textScale, 80, 140),
      lineHeight: Number(value.lineHeight) === 0
        ? 0
        : clampNumber(value.lineHeight, defaults.lineHeight, 1, 2.4, 2),
      letterSpacing: Number(value.letterSpacing) === 0
        ? 0
        : clampNumber(value.letterSpacing, defaults.letterSpacing, 0, 0.2, 3)
    };
  };

  const ruleMatches = (rule, hostname) => (
    hostname === rule.hostname
    || (rule.includeSubdomains && hostname.endsWith(`.${rule.hostname}`))
  );

  const matchingRules = (settings, hostname) => settings.siteRules
    .filter((rule) => ruleMatches(rule, hostname))
    .sort((a, b) => {
      const aExact = a.hostname === hostname && !a.includeSubdomains;
      const bExact = b.hostname === hostname && !b.includeSubdomains;
      return Number(bExact) - Number(aExact)
        || b.hostname.length - a.hostname.length
        || Number(a.includeSubdomains) - Number(b.includeSubdomains);
    });

  const resolveSite = (value, hostname) => {
    const settings = normalizeSettings(value);
    const matches = matchingRules(settings, hostname.toLowerCase());
    const enabledRule = matches.find((rule) => rule.enabled !== null);
    const scopeRule = matches.find((rule) => rule.scope !== null);
    const siteEnabled = enabledRule?.enabled ?? true;

    return {
      active: settings.enabled && siteEnabled,
      siteEnabled,
      scope: scopeRule?.scope ?? settings.scope,
      enabledRule: enabledRule ?? null,
      scopeRule: scopeRule ?? null
    };
  };

  const getDirectRule = (value, hostname, includeSubdomains = false) => {
    const settings = normalizeSettings(value);
    return settings.siteRules.find((rule) => (
      rule.hostname === hostname.toLowerCase()
      && rule.includeSubdomains === Boolean(includeSubdomains)
    )) ?? null;
  };

  const setSiteRule = (value, candidate) => {
    const settings = normalizeSettings(value);
    const hostname = typeof candidate?.hostname === "string"
      ? candidate.hostname.toLowerCase()
      : "";
    const includeSubdomains = Boolean(candidate?.includeSubdomains);
    const keyMatches = (rule) => (
      rule.hostname === hostname && rule.includeSubdomains === includeSubdomains
    );
    const current = settings.siteRules.find(keyMatches) ?? {
      hostname,
      includeSubdomains,
      enabled: null,
      scope: null
    };
    const updated = normalizeRule({ ...current, ...candidate });
    const siteRules = settings.siteRules
      .map((rule) => keyMatches(rule) ? updated : rule)
      .filter(Boolean);
    if (updated && !settings.siteRules.some(keyMatches)) siteRules.push(updated);
    return normalizeSettings({ ...settings, siteRules });
  };

  const removeSiteRule = (value, hostname, includeSubdomains = false) => {
    const settings = normalizeSettings(value);
    return normalizeSettings({
      ...settings,
      siteRules: settings.siteRules.filter((rule) => !(
        rule.hostname === hostname.toLowerCase()
        && rule.includeSubdomains === Boolean(includeSubdomains)
      ))
    });
  };

  globalThis.LexendSettings = Object.freeze({
    defaults,
    getDirectRule,
    normalizeSettings,
    removeSiteRule,
    resolveSite,
    setSiteRule,
    validHostname
  });
})();
