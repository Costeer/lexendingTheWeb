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
  const MAX_SITE_RULE_BYTES = 8192;
  const ruleStoragePrefix = "@1\n";
  const preferenceKeys = ["enabled", "scope", "theme", "textScale", "lineHeight", "letterSpacing"];
  const ruleKey = (rule) => `${rule.hostname}\n${rule.includeSubdomains}`;
  const sameRule = (left, right) => left.enabled === right.enabled && left.scope === right.scope;
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

  // One atomic storage item avoids exposing an incomplete set of rule shards.
  // Exact pauses need only a hostname: their serialized bytes are smaller than
  // the corresponding legacy disabledSites item, including the storage key.
  const encodeRules = (rules) => ruleStoragePrefix + rules.map((rule) => {
    const flags = Number(rule.includeSubdomains) * 9
      + (rule.enabled === false ? 0 : rule.enabled === true ? 1 : 2) * 3
      + (rule.scope === "body" ? 1 : rule.scope === "all" ? 2 : 0);
    return rule.hostname + (flags ? `\t${flags}` : "");
  }).join("\n");

  const decodeRules = (value) => {
    if (typeof value !== "string") return value;
    const invalid = () => { throw settingsError("INVALID_STORAGE", "Saved site rules could not be read. No settings were changed. Reload the extension and try again, or use the extension version that saved these settings."); };
    if (!value.startsWith(ruleStoragePrefix)) return invalid();
    const body = value.slice(ruleStoragePrefix.length);
    if (!body) return [];
    const keys = new Set();
    return body.split("\n").map((line) => {
      const fields = line.split("\t");
      const [hostname, encodedFlags] = fields;
      if (fields.length > 2 || (fields.length === 2 && !/^(?:[0-9]|1[0-7])$/.test(encodedFlags))) return invalid();
      const flags = encodedFlags === undefined ? 0 : Number(encodedFlags);
      const enabled = [false, true, null][Math.floor(flags % 9 / 3)];
      const scope = [null, "body", "all"][flags % 3];
      const includeSubdomains = flags >= 9;
      const key = `${hostname}\n${includeSubdomains}`;
      if (!validHostname(hostname) || hostname !== normalizeHostname(hostname)
          || (enabled === null && scope === null) || keys.has(key)) return invalid();
      keys.add(key);
      return { hostname, includeSubdomains, enabled, scope };
    });
  };

  const normalizeSettings = (value = {}) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) value = {};
    const sourceRules = Object.prototype.hasOwnProperty.call(value, "siteRules")
      ? decodeRules(value.siteRules)
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
  const settingsEqual = (left, right) => {
    const a = normalizeSettings(left), b = normalizeSettings(right);
    if (Object.keys(defaults).some((key) => key !== "siteRules" && a[key] !== b[key])
        || a.siteRules.length !== b.siteRules.length) return false;
    const rules = new Map(b.siteRules.map((rule) => [`${rule.hostname}\n${rule.includeSubdomains}`, rule]));
    return a.siteRules.every((rule) => {
      const other = rules.get(`${rule.hostname}\n${rule.includeSubdomains}`);
      return other && rule.enabled === other.enabled && rule.scope === other.scope;
    });
  };
  const encodeSettings = (value) => {
    const settings = normalizeSettings(value);
    return { ...settings, siteRules: encodeRules(settings.siteRules) };
  };
  const ruleStorageBytes = (value) => new TextEncoder().encode(
    "siteRules" + JSON.stringify(encodeRules(normalizeSettings(value).siteRules))
  ).length;
  const validateCapacity = (value) => {
    const settings = normalizeSettings(value);
    if (settings.siteRules.length > 250
        || ruleStorageBytes(settings) > MAX_SITE_RULE_BYTES) {
      throw settingsError("RULE_CAPACITY", "There isn't room for these site rules. Remove some rules before adding or importing more.");
    }
    return settings;
  };

  const validateImport = (payload) => {
    const value = payload?.settings;
    if (![1, 2].includes(payload?.schemaVersion) || !value || typeof value !== "object" || Array.isArray(value)) {
      throw settingsError("INVALID_IMPORT", "Choose a valid Lexend settings file.");
    }
    if (payload.schemaVersion === 2 && Object.keys(defaults).some((key) => !Object.hasOwn(value, key))) {
      throw settingsError("INVALID_IMPORT", "This settings backup is incomplete. Nothing was imported.");
    }
    if (payload.schemaVersion === 2 && !Array.isArray(value.siteRules)) {
      throw settingsError("INVALID_IMPORT", "The settings file contains an invalid site rule list. Nothing was imported.");
    }
    if (payload.schemaVersion === 1 && ![...Object.keys(defaults), "disabledSites", "spacing"].some((key) => Object.hasOwn(value, key))) {
      throw settingsError("INVALID_IMPORT", "This legacy settings backup is empty. Nothing was imported.");
    }
    if (value.spacing !== undefined && !Object.hasOwn(legacySpacingValues, value.spacing)) {
      throw settingsError("INVALID_IMPORT", "The settings file contains an invalid spacing value. Nothing was imported.");
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
      if ((payload.schemaVersion === 2 || value[key] !== undefined) && !valid(value[key])) {
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

  // Rule order does not affect resolution. Compare normalized values by rule
  // identity so a harmless reordering cannot invalidate a replacement preview.
  const settingsEqual = (left, right) => {
    const before = normalizeSettings(left);
    const after = normalizeSettings(right);
    if (preferenceKeys.some((key) => before[key] !== after[key])
        || before.siteRules.length !== after.siteRules.length) return false;
    const rules = new Map(after.siteRules.map((rule) => [ruleKey(rule), rule]));
    return before.siteRules.every((rule) => {
      const other = rules.get(ruleKey(rule));
      return other && sameRule(rule, other);
    });
  };

  const previewImport = (current, imported) => {
    const before = normalizeSettings(current);
    const after = normalizeSettings(imported);
    const beforeRules = new Map(before.siteRules.map((rule) => [ruleKey(rule), rule]));
    const afterRules = new Map(after.siteRules.map((rule) => [ruleKey(rule), rule]));
    return {
      before,
      after,
      changes: preferenceKeys.filter((key) => before[key] !== after[key])
        .map((key) => ({ key, before: before[key], after: after[key] })),
      rules: {
        added: after.siteRules.filter((rule) => !beforeRules.has(ruleKey(rule))),
        removed: before.siteRules.filter((rule) => !afterRules.has(ruleKey(rule))),
        changed: after.siteRules.filter((rule) => {
          const previous = beforeRules.get(ruleKey(rule));
          return previous && !sameRule(previous, rule);
        }).map((rule) => ({ before: beforeRules.get(ruleKey(rule)), after: rule }))
      }
    };
  };

  const restoreImport = (current, original, imported) => {
    const settings = normalizeSettings(current);
    const { before, after, rules } = previewImport(original, imported);
    for (const key of preferenceKeys) {
      if (before[key] !== after[key] && settings[key] === after[key]) settings[key] = before[key];
    }
    const currentRules = new Map(settings.siteRules.map((rule) => [ruleKey(rule), rule]));
    // Whole-rule additions/removals are deliberately conservative. A later
    // edit owns that identity; undo must not remove or overwrite its fields.
    for (const rule of rules.added) {
      const currentRule = currentRules.get(ruleKey(rule));
      if (currentRule && sameRule(currentRule, rule)) currentRules.delete(ruleKey(rule));
    }
    for (const rule of rules.removed) {
      if (!currentRules.has(ruleKey(rule))) currentRules.set(ruleKey(rule), rule);
    }
    for (const change of rules.changed) {
      const currentRule = currentRules.get(ruleKey(change.after));
      if (!currentRule) continue;
      for (const key of ["enabled", "scope"]) {
        if (change.before[key] !== change.after[key] && currentRule[key] === change.after[key]) {
          currentRule[key] = change.before[key];
        }
      }
    }
    return normalizeSettings({ ...settings, siteRules: [...currentRules.values()] });
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

  const updateSiteRule = (value, hostname, includeSubdomains = false, changes) => {
    const settings = normalizeSettings(value);
    const normalizedHostname = normalizeHostname(hostname);
    if (!validHostname(normalizedHostname) || typeof includeSubdomains !== "boolean"
        || !changes || typeof changes !== "object" || Array.isArray(changes)
        || Object.keys(changes).some((key) => !["includeSubdomains", "enabled", "scope"].includes(key))
        || (Object.hasOwn(changes, "includeSubdomains") && typeof changes.includeSubdomains !== "boolean")
        || (Object.hasOwn(changes, "enabled") && changes.enabled !== null && typeof changes.enabled !== "boolean")
        || (Object.hasOwn(changes, "scope") && changes.scope !== null && !["body", "all"].includes(changes.scope))) {
      throw settingsError("INVALID_RULE", "Choose valid settings for this site rule.");
    }
    const index = settings.siteRules.findIndex((rule) => (
      rule.hostname === normalizedHostname && rule.includeSubdomains === includeSubdomains
    ));
    if (index < 0) throw settingsError("RULE_NOT_FOUND", "This rule was removed. Refresh the rule list before editing it.");
    const updated = { ...settings.siteRules[index], ...changes };
    if (settings.siteRules.some((rule, position) => position !== index && ruleKey(rule) === ruleKey(updated))) {
      throw settingsError("DUPLICATE_RULE", "A rule with that domain and matching mode already exists.");
    }
    if (updated.enabled === null && updated.scope === null) {
      settings.siteRules.splice(index, 1);
      return settings;
    }
    settings.siteRules[index] = updated;
    return validateCapacity(settings);
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
    decodeSettings: normalizeSettings,
    encodeSettings,
    getDirectRule,
    normalizeSettings,
    previewImport,
    removeSiteRule,
    resolveSite,
    restoreImport,
    setSiteRule,
    settingsEqual,
    toggleSite,
    updateSiteRule,
    settingsError,
    settingsEqual,
    ruleStorageBytes,
    validateCapacity,
    validateImport,
    validHostname
  });
})();
