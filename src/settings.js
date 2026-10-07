(() => {
  "use strict";

  const defaults = Object.freeze({
    enabled: true,
    scope: "body",
    siteRules: [],
    theme: "light",
    textScale: 100,
    lineHeight: 0,
    letterSpacing: 0
  });
  const MAX_SITE_RULE_BYTES = 7000;
  const legacySpacingValues = Object.freeze({
    default: 0,
    wide: 0.04,
    wider: 0.08
  });

  const normalizeHostname = (hostname) => {
    if (typeof hostname !== "string") return "";
    const value = hostname.trim().toLowerCase().replace(/\.$/, "");
    if (/^\[[0-9a-f:.]+\]$/.test(value)) {
      try {
        return new URL(`http://${value}`).hostname;
      } catch {}
    }
    return value;
  };

  const validHostname = (hostname) => {
    if (typeof hostname !== "string" || !hostname.length || hostname.length > 253) {
      return false;
    }
    if (hostname.startsWith("[")) {
      try {
        new URL(`http://${hostname}`);
        return /^\[[0-9a-f:.]+\]$/i.test(hostname);
      } catch {
        return false;
      }
    }
    return hostname.split(".").every((label) => (
      label.length > 0
      && label.length <= 63
      && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
    ));
  };

  const clampNumber = (value, fallback, min, max, precision = 0) => {
    if (typeof value !== "number" && typeof value !== "string") return fallback;
    if (typeof value === "string" && !value.trim()) return fallback;
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    const clamped = Math.min(max, Math.max(min, number));
    return Number(clamped.toFixed(precision));
  };

  const normalizeLetterSpacing = (value) => {
    if (value.letterSpacing !== undefined) {
      return clampNumber(
        value.letterSpacing,
        defaults.letterSpacing,
        0,
        0.2,
        3
      );
    }
    return typeof value.spacing === "string" && Object.hasOwn(legacySpacingValues, value.spacing)
      ? legacySpacingValues[value.spacing]
      : defaults.letterSpacing;
  };

  const normalizeRule = (rule) => {
    const hostname = normalizeHostname(rule?.hostname);
    if (!validHostname(hostname)) return null;

    const enabled = typeof rule?.enabled === "boolean" ? rule.enabled : null;
    const scope = ["body", "all"].includes(rule?.scope) ? rule.scope : null;
    if (enabled === null && scope === null) return null;

    return {
      hostname,
      includeSubdomains: Boolean(rule.includeSubdomains),
      enabled,
      scope
    };
  };

  const normalizeSettings = (value = {}) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) value = {};
    const sourceRules = Object.prototype.hasOwnProperty.call(value, "siteRules")
      ? value.siteRules
      : (Array.isArray(value.disabledSites)
        ? value.disabledSites.map((hostname) => ({ hostname, enabled: false }))
        : []);
    const rules = new Map();

    if (Array.isArray(sourceRules)) {
      sourceRules.forEach((candidate) => {
        const rule = normalizeRule(candidate);
        if (!rule) return;
        rules.set(`${rule.hostname}\n${rule.includeSubdomains}`, rule);
      });
    }

    // Reading and resolving settings must never silently discard saved rules.
    // Enforce write limits separately, before making a storage mutation.
    const siteRules = [...rules.values()];

    return {
      enabled: typeof value.enabled === "boolean" ? value.enabled : defaults.enabled,
      scope: value.scope === "all" ? "all" : defaults.scope,
      siteRules,
      theme: value.theme === "dark" ? "dark" : defaults.theme,
      textScale: clampNumber(value.textScale, defaults.textScale, 80, 140),
      lineHeight: (value.lineHeight === 0 || value.lineHeight === "0")
        ? 0
        : clampNumber(value.lineHeight, defaults.lineHeight, 1, 2.4, 2),
      letterSpacing: normalizeLetterSpacing(value)
    };
  };

  const settingsError = (code, message) => Object.assign(new Error(message), { code });
  const validateCapacity = (value) => {
    const settings = normalizeSettings(value);
    if (settings.siteRules.length > 250
        || new TextEncoder().encode(JSON.stringify(settings.siteRules)).length > MAX_SITE_RULE_BYTES) {
      throw settingsError("RULE_CAPACITY", "There isn't room for these site rules. Remove some rules before adding or importing more.");
    }
    return settings;
  };

  const validateImport = (payload) => {
    const value = payload?.settings;
    if (![1, 2].includes(payload?.schemaVersion) || !value || typeof value !== "object" || Array.isArray(value)) {
      throw settingsError("INVALID_IMPORT", "Choose a valid Lexend settings file.");
    }
    if (value.siteRules !== undefined && (!Array.isArray(value.siteRules)
        || value.siteRules.some((rule) => !normalizeRule(rule)
          || (rule.enabled !== undefined && rule.enabled !== null && typeof rule.enabled !== "boolean")
          || (rule.scope !== undefined && rule.scope !== null && !["body", "all"].includes(rule.scope))
          || (rule.includeSubdomains !== undefined && typeof rule.includeSubdomains !== "boolean")))) {
      throw settingsError("INVALID_IMPORT", "The settings file contains an invalid site rule. Nothing was imported.");
    }
    if (value.disabledSites !== undefined && (!Array.isArray(value.disabledSites)
        || value.disabledSites.some((hostname) => !validHostname(normalizeHostname(hostname))))) {
      throw settingsError("INVALID_IMPORT", "The settings file contains an invalid site rule. Nothing was imported.");
    }
    for (const [key, valid] of [
      ["enabled", (v) => typeof v === "boolean"],
      ["scope", (v) => ["body", "all"].includes(v)],
      ["theme", (v) => ["light", "dark"].includes(v)],
      ["textScale", (v) => typeof v === "number" && v >= 80 && v <= 140],
      ["lineHeight", (v) => typeof v === "number" && (v === 0 || (v >= 1 && v <= 2.4))],
      ["letterSpacing", (v) => typeof v === "number" && v >= 0 && v <= 0.2]
    ]) {
      if (value[key] !== undefined && !valid(value[key])) {
        throw settingsError("INVALID_IMPORT", `The settings file contains an invalid ${key} value. Nothing was imported.`);
      }
    }
    const settings = validateCapacity(value);
    const source = value.siteRules ?? value.disabledSites;
    if (source && settings.siteRules.length !== source.length) {
      throw settingsError("INVALID_IMPORT", "The settings file contains duplicate site rules. Nothing was imported.");
    }
    return settings;
  };

  const ruleMatches = (rule, hostname) => (
    hostname === rule.hostname
    || (rule.includeSubdomains && hostname.endsWith(`.${rule.hostname}`))
  );

  const compareRules = (a, b, hostname) => {
    const aExact = a.hostname === hostname && !a.includeSubdomains;
    const bExact = b.hostname === hostname && !b.includeSubdomains;
    return Number(bExact) - Number(aExact)
      || b.hostname.length - a.hostname.length
      || Number(a.includeSubdomains) - Number(b.includeSubdomains);
  };

  const resolveSite = (value, hostname) => {
    const settings = normalizeSettings(value);
    const normalizedHostname = normalizeHostname(hostname);
    let enabledRule = null;
    let scopeRule = null;
    for (const rule of settings.siteRules) {
      if (!ruleMatches(rule, normalizedHostname)) continue;
      if (rule.enabled !== null && (!enabledRule || compareRules(rule, enabledRule, normalizedHostname) < 0)) {
        enabledRule = rule;
      }
      if (rule.scope !== null && (!scopeRule || compareRules(rule, scopeRule, normalizedHostname) < 0)) {
        scopeRule = rule;
      }
    }
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
      rule.hostname === normalizeHostname(hostname)
      && rule.includeSubdomains === Boolean(includeSubdomains)
    )) ?? null;
  };

  const setSiteRule = (value, candidate) => {
    const settings = normalizeSettings(value);
    const hostname = normalizeHostname(candidate?.hostname);
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
    return validateCapacity({ ...settings, siteRules });
  };

  const removeSiteRule = (value, hostname, includeSubdomains = false) => {
    const settings = normalizeSettings(value);
    return normalizeSettings({
      ...settings,
      siteRules: settings.siteRules.filter((rule) => !(
        rule.hostname === normalizeHostname(hostname)
        && rule.includeSubdomains === Boolean(includeSubdomains)
      ))
    });
  };

  const toggleSite = (value, hostname) => {
    const settings = normalizeSettings(value);
    const effective = resolveSite(settings, hostname);
    const inherited = resolveSite(removeSiteRule(settings, hostname), hostname);
    const enabled = settings.enabled ? !effective.siteEnabled : true;
    return setSiteRule({ ...settings, enabled: true }, {
      hostname,
      includeSubdomains: false,
      enabled: enabled === inherited.siteEnabled ? null : enabled
    });
  };

  globalThis.LexendSettings = Object.freeze({
    defaults,
    getDirectRule,
    normalizeSettings,
    removeSiteRule,
    resolveSite,
    setSiteRule,
    toggleSite,
    settingsError,
    validateCapacity,
    validateImport,
    validHostname
  });
})();
