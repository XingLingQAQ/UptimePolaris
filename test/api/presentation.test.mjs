// 验证公开展示设置、域名、预览权限与机器公开范围。
// Check presentation settings, domains, preview permissions, and machine visibility.

﻿import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { applyD1Migrations } from '../helpers/apply-d1-migrations.mjs';

const bundle = await build({ entryPoints: ['backends/worker/src/api.ts'], bundle: true, write: false, format: 'esm', target: 'es2022', logLevel: 'error',
  plugins: [{ name: 'stub', setup(b) { b.onResolve({ filter: /^(postgres|cloudflare:sockets)$/ }, ({ path }) => ({ path, namespace: 'fixture' })); b.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: path === 'postgres' ? 'export default function postgres(){throw new Error("unexpected postgres")}' : 'export function connect(){throw new Error("unexpected connect")}' })); } }],
  footer: { js: 'export default { fetch: api.fetch.bind(api) };' },
});
const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2025-01-01', d1Databases: { DB: 'presentation' }, r2Buckets: { THEMES: 'presentation-themes' }, bindings: { ADMIN_TOKEN: 'fixture', DATABASE_TYPE: 'd1' } });
const auth = { authorization: 'Bearer fixture', 'content-type': 'application/json' };
async function req(host, path, init = {}) {
  const response = await mf.dispatchFetch(`https://${host}${path}`, init);
  const text = await response.text();
  return { status: response.status, data: JSON.parse(text), text, cache: response.headers.get('x-public-cache') };
}
async function write(path, method, body) {
  const result = await req('status.example.com', path, { method, headers: auth, body: JSON.stringify(body) });
  assert.ok(result.status >= 200 && result.status < 300, JSON.stringify(result));
  return result.data;
}
try {
  const db = await mf.getD1Database('DB');
  await applyD1Migrations(db);
  const first = await write('/api/monitors', 'POST', { name: 'visible monitor', type: 'http', target: 'https://visible.example/path' });
  const second = await write('/api/monitors', 'POST', { name: 'hidden monitor', type: 'http', target: 'https://hidden.example/path' });
  const secondRow = await db.prepare('SELECT num_id FROM monitors WHERE id=?').bind(second.id).first();
  const machine = await write('/api/admin/agents', 'POST', { name: 'selected machine', probe_enabled: true });
  const hiddenMachine = await write('/api/admin/agents', 'POST', { name: 'hidden machine', probe_enabled: true });
  const manifest = { schema: 2, id: 'fixture-theme', short: 'fixture-theme', name: 'Fixture', version: '1.0.0', themes: [{ id: 'servers', name: 'Servers', target: 'agent', entry: 'index.html', capabilities: ['public.config'], options: [{ key: 'linked', label: 'Linked', type: 'agent' }] }] };
  const prefix = `themes/fixture-theme/1.0.0/${'a'.repeat(64)}/00000000-0000-0000-0000-000000000001`;
  await db.prepare('INSERT INTO themes(short,id,name,version,manifest_json,installed_at,updated_at) VALUES(?,?,?,?,?,?,?)').bind('fixture-theme', 'fixture-theme', 'Fixture', '1.0.0', JSON.stringify(manifest), 1, 1).run();
  await db.prepare('INSERT INTO theme_versions(id,version,digest,prefix,manifest_json,installed_at) VALUES(?,?,?,?,?,?)').bind('fixture-theme', '1.0.0', 'a'.repeat(64), prefix, JSON.stringify(manifest), 1).run();
  await (await mf.getR2Bucket('THEMES')).put(`${prefix}/index.html`, '<html></html>');
  let state = (await req('status.example.com', '/api/admin/presentation', { headers: auth })).data;
  const cfg = state.config;
  cfg.domains = [{ hostname: 'status.example.com', page: 'monitor' }, { hostname: 'servers.example.com', page: 'agent' }];
  await write('/api/monitors/visibility', 'POST', { ids: [second.id], is_public: false });
  assert.equal((await req('status.example.com', '/api/admin/agents/visibility', { method: 'POST', headers: auth, body: JSON.stringify({ ids: [machine.id], is_public: true }) })).status, 409);
  cfg.pages.agent.theme = { short: 'fixture-theme', version: '1.0.0', theme: 'servers' };
  cfg.pages.agent.themeOptions = { linked: machine.id };
  state = await write('/api/admin/presentation', 'PUT', { revision: state.revision, config: cfg });
  assert.equal(state.draft, undefined); assert.equal(state.published, undefined);
  assert.equal((await req('servers.example.com', '/api/public/servers')).status, 404);
  assert.equal((await req('servers.example.com', `/api/public/servers/${machine.id}`)).status, 404);
  assert.equal((await req('unknown.example.com', '/api/public/config')).data.presentation.configured, true);
  assert.equal((await req('status.example.com', '/api/public/status')).data.monitors.length, 1);
  assert.equal((await req('status.example.com', `/api/public/status/detail?id=${second.id}`)).status, 404);
  assert.equal((await req('status.example.com', `/api/recent/${second.id}`)).status, 404);
  assert.equal((await req('status.example.com', '/api/public/monitor-icon?target=https%3A%2F%2Fhidden.example%2F')).status, 404);
  assert.equal((await req('status.example.com', `/api/public/monitor-icon?id=${secondRow.num_id}`)).status, 404);
  assert.equal((await req('servers.example.com', '/api/public/status')).status, 200);
  assert.equal((await req('servers.example.com', '/api/public/config')).data.presentation.kind, 'monitor');
  assert.equal((await req('status.example.com', '/api/public/servers?preview=agent')).status, 401);
  const preview = await req('status.example.com', '/api/public/servers?preview=agent', { headers: auth });
  assert.equal(preview.status, 200); assert.equal(preview.data.servers.length, 0);
  cfg.agentEnabled = true;
  state = await write('/api/admin/presentation', 'PUT', { revision: state.revision, config: cfg });
  await write('/api/admin/agents/visibility', 'POST', { ids: [machine.id], is_public: true });
  assert.equal((await db.prepare('SELECT is_public FROM agents WHERE id=?').bind(hiddenMachine.id).first()).is_public, 0);
  assert.equal((await req('unknown.example.com', '/api/public/config')).data.presentation.configured, false);
  const servers = await req('servers.example.com', '/api/public/servers');
  assert.deepEqual(servers.data.servers.map(server => server.id), [machine.id]);
  assert.equal((await req('servers.example.com', `/api/public/servers/${hiddenMachine.id}`)).status, 404);
  assert.equal((await req('status.example.com', '/api/public/servers')).status, 404);
  for (const secret of [machine.token, hiddenMachine.token, 'public_ip', 'mounts_json', 'interfaces_json', 'command']) assert.ok(!servers.text.includes(secret));
  cfg.agentEnabled = false;
  await write('/api/admin/presentation', 'PUT', { revision: state.revision, config: cfg });
  assert.equal((await req('servers.example.com', `/api/public/servers/${machine.id}`)).status, 404);
  assert.equal((await req('servers.example.com', '/api/public/config')).data.presentation.kind, 'monitor');
  assert.equal((await req('unknown.example.com', '/api/public/config')).data.presentation.configured, true);
  await write(`/api/admin/agents/${machine.id}`, 'DELETE');
  const pruned = (await req('status.example.com', '/api/admin/presentation', { headers: auth })).data;
  assert.deepEqual(pruned.config.pages.agent.themeOptions, {});
  await write('/api/admin/presentation', 'PUT', { revision: pruned.revision, config: pruned.config });
  const stale = await req('status.example.com', '/api/admin/presentation', { method: 'PUT', headers: auth, body: JSON.stringify({ revision: 'stale', config: pruned.config }) });
  assert.equal(stale.status, 409);
  // 配置存在但损坏时拒绝公开请求，不能丢弃域名限制。
  // Reject corrupt stored configuration instead of discarding its domain restrictions.
  const stored = await db.prepare("SELECT config_json FROM presentation_state WHERE id='main'").first();
  for (const config of ['{', JSON.stringify({ ...pruned.config, retiredField: true })]) {
    await db.prepare("UPDATE presentation_state SET config_json=? WHERE id='main'").bind(config).run();
    assert.equal((await req('unknown.example.com', '/api/public/status?fresh=1')).status, 500);
    assert.equal((await req('status.example.com', '/api/admin/presentation', { headers: auth })).status, 500);
  }
  await db.prepare("UPDATE presentation_state SET config_json=? WHERE id='main'").bind(stored.config_json).run();
  assert.equal((await req('status.example.com', '/api/admin/presentation', { headers: auth })).status, 200);
  console.log('PASS presentation domains, preview authentication, monitor scope and Agent publication');
} finally { await mf.dispose(); }
