import assert from "node:assert/strict";
import test from "node:test";
import "../src/settings.js";
import "../src/preferences.js";

const api = globalThis.LexendSettings;
// Fixed seeds make failures reproducible without adding a fuzzing dependency.
const generator = (seed) => () => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) / 2 ** 32;
};
const choose = (random, values) => values[Math.floor(random() * values.length)];

test("generated settings normalize idempotently and valid backups round-trip", () => {
  const random = generator(0x4c455845);
  const malformed = [undefined, null, false, [], {}, "", "unknown", "__proto__", NaN, Infinity];
  for (let iteration = 0; iteration < 500; iteration++) {
    const settings = api.normalizeSettings({
      enabled: choose(random, [...malformed, true]),
      scope: choose(random, [...malformed, "body", "all"]),
      theme: choose(random, [...malformed, "dark"]),
      textScale: choose(random, [...malformed, random() * 500, "120"]),
      lineHeight: choose(random, [...malformed, random() * 4, 0]),
      letterSpacing: choose(random, [...malformed, random(), ".04"]),
      siteRules: [
        { hostname: ` S${iteration}.EXAMPLE.COM. `, enabled: random() > .5 },
        { hostname: "bad/path", enabled: false },
        { hostname: "example.com", includeSubdomains: true, scope: "all" }
      ]
    });
    assert.deepEqual(api.normalizeSettings(settings), settings, `normalization case ${iteration}`);
    assert.deepEqual(api.validateImport(JSON.parse(JSON.stringify({ schemaVersion: 2, settings }))), settings,
      `backup case ${iteration}`);
  }
});

// Independent reference: compare DNS labels and explicitly walk from a host
// toward its parents. This does not reuse the implementation's suffix sorting.
function referenceResolution(settings, hostname) {
  const labels = hostname.split(".");
  const candidates = settings.siteRules.filter((rule) => rule.hostname === hostname && !rule.includeSubdomains);
  for (let offset = 0; offset < labels.length; offset++) {
    candidates.push(...settings.siteRules.filter((rule) => rule.includeSubdomains
      && rule.hostname === labels.slice(offset).join(".")));
  }
  const enabled = candidates.find((rule) => rule.enabled !== null)?.enabled ?? true;
  return {
    active: settings.enabled && enabled,
    siteEnabled: enabled,
    scope: candidates.find((rule) => rule.scope !== null)?.scope ?? settings.scope
  };
}

test("generated rule precedence matches a DNS-label model regardless of insertion order", () => {
  const random = generator(0x52554c45);
  for (let iteration = 0; iteration < 300; iteration++) {
    const base = `site${iteration}.example.com`;
    const hosts = [base, `docs.${base}`, `api.docs.${base}`];
    const siteRules = hosts.flatMap((hostname) => [false, true].map((includeSubdomains) => {
      const enabled = choose(random, [true, false, null]);
      return { hostname, includeSubdomains, enabled, scope: enabled === null ? "all" : choose(random, ["body", "all", null]) };
    }));
    const settings = { enabled: random() > .2, scope: choose(random, ["body", "all"]), siteRules };
    for (const hostname of [...hosts, `child.api.docs.${base}`, `fake${base}`, `${base}.attacker.test`, "unrelated.test"]) {
      const expected = referenceResolution(settings, hostname);
      for (const ordered of [siteRules, [...siteRules].reverse(), [...siteRules.slice(3), ...siteRules.slice(0, 3)]]) {
        const { active, siteEnabled, scope } = api.resolveSite({ ...settings, siteRules: ordered }, hostname);
        assert.deepEqual({ active, siteEnabled, scope }, expected, `case ${iteration}: ${hostname}`);
      }
    }
  }
});

test("generated writer operations preserve unrelated preferences and both rule variants", async () => {
  const random = generator(0x53544f52);
  let saved = { theme: "dark", textScale: 123, lineHeight: 1.73, letterSpacing: .057 };
  const store = LexendPreferences.createStore({
    get: async () => structuredClone(saved),
    set: async (patch) => { Object.assign(saved, structuredClone(patch)); }
  });
  const rules = new Map();
  for (let iteration = 0; iteration < 500; iteration++) {
    const hostname = `s${Math.floor(random() * 15)}.example.com`;
    const includeSubdomains = random() > .5;
    const key = `${hostname}:${includeSubdomains}`;
    if (random() > .5) {
      const rule = { hostname, includeSubdomains, enabled: random() > .5, scope: choose(random, ["body", "all", null]) };
      if (rules.has(key)) {
        const before = structuredClone(saved);
        await assert.rejects(store.mutate({ type: "addRule", rule }), { code: "DUPLICATE_RULE" });
        assert.deepEqual(saved, before);
      } else {
        await store.mutate({ type: "addRule", rule });
        rules.set(key, rule);
      }
    } else {
      await store.mutate({ type: "removeRule", hostname, includeSubdomains });
      rules.delete(key);
    }
    assert.deepEqual(new Map(saved.siteRules.map((rule) => [`${rule.hostname}:${rule.includeSubdomains}`, rule])), rules);
    for (const [key, value] of Object.entries({ theme: "dark", textScale: 123, lineHeight: 1.73, letterSpacing: .057 })) {
      assert.equal(saved[key], value, `operation ${iteration} preserves ${key}`);
    }
  }
});
