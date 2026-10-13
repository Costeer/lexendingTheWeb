import assert from "node:assert/strict";
import test from "node:test";
import "../src/settings.js";
import "../src/preferences.js";
const api=globalThis.LexendSettings;

test('existing settings and malformed modes safely default to Off',()=>{
  assert.equal(api.normalizeSettings({textScale:120}).layoutMode,'off');
  for(const layoutMode of [null,{},'legacy','constructor','toString']) assert.equal(api.normalizeSettings({layoutMode}).layoutMode,'off');
  for(const layoutMode of ['off','gentle','fit']) assert.equal(api.normalizeSettings({layoutMode}).layoutMode,layoutMode);
});
test('site layout precedence is independent of pause and scope',()=>{
  let settings=api.normalizeSettings({layoutMode:'off',siteRules:[
    {hostname:'example.com',includeSubdomains:true,layoutMode:'gentle',enabled:false},
    {hostname:'docs.example.com',scope:'all',layoutMode:'fit'}
  ]});
  const site=api.resolveSite(settings,'docs.example.com');
  assert.equal(site.layoutMode,'fit');assert.equal(site.scope,'all');assert.equal(site.active,false);
  assert.equal(api.resolveSite(settings,'other.example.com').layoutMode,'gentle');
  assert.equal(api.resolveSite(settings,'notexample.com').layoutMode,'off');
  settings=api.toggleSite(settings,'docs.example.com');
  assert.equal(api.resolveSite(settings,'docs.example.com').layoutMode,'fit');
  assert.equal(api.resolveSite(settings,'docs.example.com').active,true);
  settings=api.setSiteRule(settings,{hostname:'docs.example.com',layoutMode:null});
  assert.equal(api.resolveSite(settings,'docs.example.com').layoutMode,'gentle');
  assert.equal(api.resolveSite(settings,'docs.example.com').scope,'all');
});
test('layout modes round trip in backups and invalid values are rejected',()=>{
  for(const layoutMode of ['off','gentle','fit']) {
    const settings=api.normalizeSettings({layoutMode,siteRules:[{hostname:'example.com',layoutMode}]});
    assert.deepEqual(api.validateImport({schemaVersion:2,settings}),settings);
  }
  for(const settings of [{layoutMode:'bad'},{siteRules:[{hostname:'example.com',enabled:true,layoutMode:'bad'}]}])
    assert.throws(()=>api.validateImport({schemaVersion:2,settings}),{code:'INVALID_IMPORT'});
});
test('the writer validates site-mode changes and keeps unrelated settings',async()=>{
  let settings=api.normalizeSettings({textScale:120});
  const store=LexendPreferences.createStore({get:async()=>settings,set:async patch=>{settings={...settings,...patch};}});
  await store.mutate({type:'setSiteLayout',hostname:'example.com',layoutMode:'fit'});
  assert.equal(settings.textScale,120);assert.equal(settings.layoutMode,'off');
  await assert.rejects(store.mutate({type:'setSiteLayout',hostname:'example.com',layoutMode:'bad'}),{code:'INVALID_OPERATION'});
  await store.mutate({type:'setSiteLayout',hostname:'example.com',layoutMode:null});
  assert.equal(settings.siteRules.length,0);
});

test('rule updates serialize independent fields and never recreate deleted rules', async () => {
  let settings = api.normalizeSettings({ siteRules: [
    { hostname: 'example.com', includeSubdomains: true, enabled: false, scope: 'all', layoutMode: 'off' },
    { hostname: 'example.com', includeSubdomains: false, layoutMode: 'fit' }
  ] });
  const store = LexendPreferences.createStore({ get: async () => settings, set: async patch => { settings = { ...settings, ...patch }; } });
  const update = changes => ({ type: 'updateRule', hostname: 'example.com', includeSubdomains: true, changes });
  await Promise.all([store.mutate(update({ layoutMode: 'gentle' })), store.mutate(update({ enabled: true }))]);
  assert.deepEqual(api.getDirectRule(settings, 'example.com', true), {
    hostname: 'example.com', includeSubdomains: true, enabled: true, scope: 'all', layoutMode: 'gentle'
  });
  assert.equal(api.getDirectRule(settings, 'example.com').layoutMode, 'fit');
  await store.mutate(update({ layoutMode: null }));
  assert.equal(api.getDirectRule(settings, 'example.com', true).scope, 'all');
  for (const changes of [{}, { layoutMode: 'bad' }, { enabled: 'false' }, { scope: 'body' }, { layoutMode: undefined }]) {
    await assert.rejects(store.mutate(update(changes)), { code: 'INVALID_OPERATION' });
  }
  await store.mutate({ type: 'removeRule', hostname: 'example.com', includeSubdomains: true });
  await assert.rejects(store.mutate(update({ layoutMode: 'fit' })), { code: 'RULE_NOT_FOUND' });
  assert.equal(settings.siteRules.length, 1);
});

test('creation rejects invalid or empty rule choices instead of silently dropping them', async () => {
  const store = LexendPreferences.createStore({ get: async () => ({}), set: async () => assert.fail('invalid rules must not write') });
  for (const choices of [{}, { enabled: null, layoutMode: null }, { layoutMode: 'bad' }, { enabled: 'paused', layoutMode: 'fit' }]) {
    await assert.rejects(store.mutate({ type: 'addRule', rule: { hostname: 'example.com', ...choices } }), { code: 'INVALID_RULE' });
  }
});
