// 验证管理写入、分组删除、缓存失效与保存恢复。
// Check management writes, group deletion, cache invalidation, and save recovery.

import { applyD1Migrations } from '../helpers/apply-d1-migrations.mjs';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import ts from 'typescript';

const bundled = await build({
  stdin: {
    contents: `
      import { api } from './backends/worker/src/api';
      const timeout = AbortSignal.timeout;
      const timeouts = [];
      AbortSignal.timeout = (ms) => { timeouts.push(ms); return timeout(ms); };
      globalThis.fetch = async () => new Response('healthy');
      export default { fetch(request, env, ctx) {
        if (new URL(request.url).pathname === '/__timeouts') return Response.json(timeouts);
        return api.fetch(request, env, ctx);
      }};
    `,
    resolveDir: process.cwd(), loader: 'ts',
  },
  bundle: true, write: false, format: 'esm', target: 'es2022', logLevel: 'error',
  plugins: [{
    name: 'runtime-stubs',
    setup(builder) {
      builder.onResolve({ filter: /^(cloudflare:sockets|postgres)$/ }, ({ path }) => ({ path, namespace: 'stub' }));
      builder.onLoad({ filter: /.*/, namespace: 'stub' }, ({ path }) => ({
        contents: path === 'postgres'
          ? 'export default function() { throw Error("unused Postgres driver"); }'
          : 'export function connect() { throw Error("unused TCP socket"); }',
        loader: 'js',
      }));
    },
  }],
});

const mf = new Miniflare({
  modules: true, script: bundled.outputFiles[0].text, compatibilityDate: '2025-01-01',
  bindings: { ADMIN_TOKEN: 'management-fixture' }, d1Databases: { DB: 'management-regression' },
});

try {
  const db = await mf.getD1Database('DB');
  await applyD1Migrations(db);
  async function request(path, method = 'GET', body) {
    const response = await mf.dispatchFetch('http://localhost' + path, {
      method, headers: { authorization: 'Bearer management-fixture', 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  }

  const unauthenticated = await mf.dispatchFetch('http://localhost/api/monitors');
  assert.equal(unauthenticated.status, 401);
  const agents = [];
  const machines = [];
  for (const name of ['agent-a', 'agent-b']) {
    const machine = await request('/api/admin/agents', 'POST', { name });
    machines.push(machine.body.id);
    const created = await request('/api/monitors', 'POST', { name, type: 'agent', agent_id: machine.body.id });
    assert.equal(created.status, 201);
    agents.push(created.body.id);
  }
  const now = Math.floor(Date.now() / 1000);
  await db.prepare('INSERT INTO monitor_groups(id,name,weight,created_at,updated_at) VALUES(?,?,0,?,?)')
    .bind('fixture-group', 'Fixture group', now, now).run();
  for (const id of agents) assert.equal((await request('/api/monitors/' + id, 'PUT', { group_id: 'fixture-group' })).status, 200);
  for (const row of (await db.prepare('SELECT group_id, typeof(updated_at) AS timestamp_type FROM monitors').all()).results) {
    assert.equal(row.group_id, 'fixture-group');
    assert.equal(row.timestamp_type, 'integer');
  }

  for (const id of agents) {
    await db.prepare('INSERT INTO monitor_uptime(monitor_id,days_json,updated_at) VALUES(?,?,?)').bind(id, '[]', now).run();
    await db.prepare('INSERT INTO heartbeat_ring(id,json,updated_at) VALUES(?,?,?)').bind(id, '[]', now).run();
    await db.prepare('INSERT INTO events(monitor_id,status,message,created_at) VALUES(?,0,?,?)').bind(id, 'outage', now).run();
    await db.prepare('INSERT INTO pending_notifications(id,event_id,channel_id,payload_json,created_at) VALUES(?,?,?,?,?)')
      .bind(id, id + ':outage', 'fixture-channel', JSON.stringify({ event: { monitorId: id } }), now).run();
  }
  await db.prepare('INSERT INTO live_state(id,json,updated_at) VALUES(?,?,?)')
    .bind('all', JSON.stringify(Object.fromEntries(agents.map((id) => [id, { st: 1, ts: now, v: 0, code: 0, msg: '', fails: 0 }]))), now).run();
  await request('/api/public/status');
  assert.equal((await request('/api/admin/agents/' + machines[0], 'DELETE')).status, 409);
  assert.equal((await request('/api/monitors/' + agents[0], 'DELETE')).status, 200);
  assert.equal((await request('/api/admin/agents/' + machines[0], 'DELETE')).status, 200);
  assert.equal((await request('/api/monitors/' + agents[1], 'DELETE')).status, 200);
  for (const [table, key] of [['heartbeat_ring', 'id'], ['monitor_uptime', 'monitor_id'], ['events', 'monitor_id']]) {
    assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${key} IN (?,?)`).bind(...agents).first()).n, 0);
  }
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM pending_notifications').first()).n, 0);
  assert.deepEqual(JSON.parse((await db.prepare("SELECT json FROM live_state WHERE id='all'").first()).json), {});
  assert.deepEqual((await request('/api/public/status')).body.monitors, []);

  await request('/api/admin/settings', 'PUT', { 'site.title': 'original' });
  await db.exec("CREATE TRIGGER reject_description BEFORE INSERT ON app_settings WHEN NEW.key='site.description' BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END");
  const failed = await request('/api/admin/settings', 'PUT', { 'site.title': 'changed', 'site.description': 'blocked' });
  assert.equal(failed.status, 503);
  assert.equal(JSON.parse((await db.prepare("SELECT value_json FROM app_settings WHERE key='site.title'").first()).value_json), 'original');
  await db.exec('DROP TRIGGER reject_description');

  const preview = await request('/api/monitors/check', 'POST', { name: 'preview', type: 'http', target: 'https://fixture.test', timeout_ms: 60000 });
  assert.equal(preview.status, 200);
  assert.deepEqual((await request('/__timeouts')).body, [60000]);
  assert.equal((await request('/api/cron/sync', 'POST')).body.status, 'disabled');
  console.log('PASS management: grouping, both deletion paths, cache invalidation, atomic settings, preview timeout, disabled sync');
} finally {
  await mf.dispose();
}

function callback(file, name) {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found;
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) found = ts.isCallExpression(node.initializer) ? node.initializer.arguments[0] : node.initializer;
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return ts.transpileModule('(' + found.getText(source) + ')', {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
}

{
  const draftRef = { current: { 'site.title': 'first', 'security.loginMaxAttempts': 7 } };
  const draftVersions = { current: new Map() };
  const pendingSaves = { current: new Map() };
  const GROUP_KEYS = { site: ['site.title'], security: ['security.loginMaxAttempts'] };
  let values = { 'site.title': 'original', 'security.loginMaxAttempts': 8 }, draft;
  let saving = new Set();
  const setValues = (update) => { values = update(values); };
  const setDraft = (update) => { draft = update; };
  const setSavingGroups = (update) => { saving = update(saving); };
  const setSpecs = () => {};
  const setSavedAt = () => {}, setSaveError = () => {}, t = (key) => key;
  const requests = [];
  const settingsApi = { updateSettings: (payload) => new Promise((resolve) => requests.push({ payload, resolve })) };
  const save = eval(callback('frontend/src/admin/settings/SettingsSections.tsx', 'save'));
  const first = save('site');
  await Promise.resolve();
  draftRef.current = { ...draftRef.current, 'site.title': 'second' };
  const second = save('site');
  const security = save('security');
  await Promise.resolve();
  assert.equal(requests.length, 2);
  requests[1].resolve({ values: { 'site.title': 'original', 'security.loginMaxAttempts': 7 } });
  await security;
  requests[0].resolve({ values: { 'site.title': 'first', 'security.loginMaxAttempts': 8 } });
  await first;
  await Promise.resolve();
  assert.equal(draft['site.title'], 'second');
  assert.equal(values['security.loginMaxAttempts'], 7);
  assert.equal(requests[2].payload['site.title'], 'second');
  requests[2].resolve({ values: { 'site.title': 'second', 'security.loginMaxAttempts': 7 } });
  await second;
  assert.equal(values['site.title'], 'second');
  assert.deepEqual(draft, {});
  console.log('PASS settings autosave: later edits survive and groups do not overwrite each other');
}

{
  const GROUP_KEYS = { site: ['site.title'] }, groups = ['site'];
  const pendingSaves = { current: new Map() }, timers = { current: new Map() };
  const draftRef = { current: { 'site.title': 'old draft' } };
  const draftVersions = { current: new Map() };
  let values = { 'site.title': 'original' }, specs = [{ key: 'site.title', stored: true }];
  const setValues = (update) => { values = update(values); };
  const setSpecs = (update) => { specs = update(specs); };
  const setDraft = () => {}, setSavingGroups = () => {}, setSavedAt = () => {}, setSaveError = () => {};
  const t = (key) => key, toast = { error: assert.fail }, schedule = () => {};
  const requests = [];
  const settingsApi = {
    updateSettings: (payload) => new Promise((resolve) => requests.push({ type: 'save', payload, resolve })),
    resetSetting: (key) => new Promise((resolve) => requests.push({ type: 'reset', key, resolve })),
  };
  const save = eval(callback('frontend/src/admin/settings/SettingsSections.tsx', 'save'));
  const reset = eval(callback('frontend/src/admin/settings/SettingsSections.tsx', 'reset'));
  const old = save('site');
  await Promise.resolve();
  const restoring = reset('site.title');
  draftRef.current = { 'site.title': 'old draft' };
  draftVersions.current.set('site.title', 2);
  await Promise.resolve();
  assert.equal(requests.length, 1, 'reset waits for the in-flight save');
  requests[0].resolve({ values: { 'site.title': 'old draft' } });
  await old;
  assert.equal(draftRef.current['site.title'], 'old draft', 'typing the same text after reset is still a new edit');
  await Promise.resolve();
  assert.equal(requests[1].type, 'reset');
  draftRef.current = { 'site.title': 'new draft' };
  draftVersions.current.set('site.title', 3);
  const newer = save('site');
  requests[1].resolve({ value: 'default' });
  await restoring;
  await Promise.resolve();
  assert.equal(values['site.title'], 'default');
  assert.equal(specs[0].stored, false);
  assert.equal(draftRef.current['site.title'], 'new draft');
  requests[2].resolve({ values: { 'site.title': 'new draft' } });
  await newer;
  assert.equal(values['site.title'], 'new draft');
  assert.equal(specs[0].stored, true);
  console.log('PASS settings reset: serialized after saves and preserves later edits');
}

{
  let status, lastToast;
  const jobsApi = { runSync: async () => ({ status, succeeded: 2, failed: 1, monitors: 3 }) };
  const toast = Object.fromEntries(['info', 'warning', 'success', 'error'].map((kind) => [kind, (key) => { lastToast = [kind, key]; }]));
  const t = (key) => key, setBusy = () => {}, loadEvents = async () => {}, requireLogin = () => {};
  class UnauthorizedError extends Error {}
  const run = eval(callback('frontend/src/admin/settings/SettingsPage.tsx', 'run'));
  for (const [result, expected] of [['disabled', ['info', 'toast.syncDisabled']], ['partial', ['warning', 'toast.syncPartial']], ['complete', ['success', 'toast.syncDone']]]) {
    status = result;
    await run('sync');
    assert.deepEqual(lastToast, expected);
  }
  console.log('PASS sync result presentation: disabled, partial, complete');
}
