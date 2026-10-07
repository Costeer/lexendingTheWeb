import assert from "node:assert/strict";
import test from "node:test";
import "../src/settings.js";

const api = globalThis.LexendSettings;

test("oversized rule collections remain intact on read and fail explicitly before writing", () => {
  const candidates = Array.from({ length: 250 }, (_, i) => ({
    hostname: `site${i}.${"a".repeat(i % 3 === 0 ? 63 : 1)}.example.com`,
    includeSubdomains: i % 2 === 0,
    enabled: false,
    scope: null
  }));
  assert.deepEqual(api.normalizeSettings({ siteRules: candidates }).siteRules, candidates);
  assert.throws(() => api.validateCapacity({ siteRules: candidates }), { code: "RULE_CAPACITY" });
});

test("enabled and scope precedence are independent of rule insertion order", () => {
  const rules = [
    { hostname: "example.com", includeSubdomains: true, enabled: false, scope: "body" },
    { hostname: "docs.example.com", includeSubdomains: true, enabled: true, scope: "all" },
    { hostname: "docs.example.com", includeSubdomains: false, enabled: false, scope: null },
    { hostname: "api.docs.example.com", includeSubdomains: false, enabled: null, scope: "body" }
  ];
  for (const ordered of [rules, [...rules].reverse(), [...rules.slice(2), ...rules.slice(0, 2)]]) {
    const direct = api.resolveSite({ siteRules: ordered }, "docs.example.com");
    assert.equal(direct.active, false, "exact rule controls enabled");
    assert.equal(direct.scope, "all", "scope inherits independently from the closest domain rule");
    const subdomain = api.resolveSite({ siteRules: ordered }, "api.docs.example.com");
    assert.equal(subdomain.active, true);
    assert.equal(subdomain.scope, "body");
    assert.equal(api.resolveSite({ siteRules: ordered }, "unrelated.com").active, true);
    assert.equal(api.resolveSite({ siteRules: ordered, enabled: false }, "api.docs.example.com").active, false);
  }
});
