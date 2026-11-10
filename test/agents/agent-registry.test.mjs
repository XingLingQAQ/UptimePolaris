// 验证独立机器登记、显隐及监控删除后的数据保留。
// Check independent machine enrollment, visibility, and data retention after monitor deletion.

import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { applyD1Migrations } from '../helpers/apply-d1-migrations.mjs';

const bundle = await build({
  stdin: { resolveDir: process.cwd(), loader: 'ts', contents: `
    import { api } from './backends/worker/src/api';
    import { rollupAgentMetrics } from './backends/worker/src/lib/agent/rollup';
    export default { async fetch(request, env, ctx) {
      if (new URL(request.url).pathname === '/__rollup') {
        const result = await rollupAgentMetrics(env, Math.floor(Date.now()/1000));
        return Response.json({ entries: [...result.entries] });
      }
      return api.fetch(request, env, ctx);
    } };
  ` },
  bundle: true, write: false, format: 'esm', target: 'es2022', logLevel: 'error',
  plugins: [{ name: 'unneeded-transports', setup(builder) {
    builder.onResolve({ filter: /^(postgres|cloudflare:sockets)$/ }, ({ path }) => ({ path, namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: path === 'postgres'
      ? 'export default function postgres(){throw new Error("Unexpected Postgres connection")}'
      : 'export function connect(){throw new Error("Unexpected Worker TCP probe")}' }));
  } }],
});
const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text,
  compatibilityDate: '2025-01-01', d1Databases: { DB: 'registry' }, bindings: { ADMIN_TOKEN: 'fixture', DATABASE_TYPE: 'd1' } });
const origin = 'http://localhost';
async function request(path, method = 'GET', body, admin = true) {
  const response = await mf.dispatchFetch(origin + path, { method,
    headers: { ...(admin ? { authorization: 'Bearer fixture' } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  let data; try { data = JSON.parse(text); } catch {}
  return { status: response.status, data, text, cache: response.headers.get('x-public-cache') };
}
async function success(path, method = 'GET', body, admin = true) {
  const response = await request(path, method, body, admin);
  assert.ok(response.status >= 200 && response.status < 300, JSON.stringify({ path, ...response }));
  return response.data;
}
try {
  const db = await mf.getD1Database('DB');
  await applyD1Migrations(db);
  const machine = await success('/api/admin/agents', 'POST', { name: 'Independent machine', probe_enabled: true });
  assert.ok(machine.id && machine.token);
  const rejectedGroup = await request('/api/admin/agents', 'POST', { name: 'Invalid machine group', group_id: null });
  assert.equal(rejectedGroup.status, 400);
  assert.equal((await db.prepare('PRAGMA table_info(agents)').all()).results.some(column => column.name === 'group_id'), true);
  assert.equal((await success('/api/admin/agents')).agents[0].group_id, null);
  const removedRoute = await mf.dispatchFetch(origin + '/api/admin/agents/group', { method: 'POST', headers: { authorization: 'Bearer fixture', 'content-type': 'application/json' }, body: JSON.stringify({ ids: [machine.id], group_id: null }) });
  assert.equal(removedRoute.status, 404);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM monitors').first()).n, 0);
  assert.deepEqual((await success('/__rollup')).entries, []);
  assert.equal((await success('/api/agents/probe-sources')).agents[0].installed, false);

  const now = Math.floor(Date.now() / 1000);
  const frames = [{ method: 'basicReport', params: { name: 'fixture', os: 'Linux', arch: 'x86_64', cpu_model: 'CPU', cpu_cores: 2,
    version: '0.5.4', report_interval_secs: 60, capabilities: ['probe_http', 'probe_tcp', 'probe_ssl', 'probe_dns', 'probe_domain', 'commands'] } },
  { method: 'report', params: { observed_at: now, cpu: { usage: 5 }, ram: { total: 100, used: 20 }, swap: { total: 0, used: 0 },
    load: { load1: 0, load5: 0, load15: 0 }, disk: { total: 100, used: 10 }, network: { up: 0, down: 0, totalUp: 0, totalDown: 0 },
    connections: { tcp: 1, udp: 1 }, uptime: 1, process: 1, summaries: [] } }];
  await success('/api/public/agent/push/' + machine.token, 'POST', frames, false);
  const sources = (await success('/api/agents/probe-sources')).agents;
  assert.equal(sources[0].online, true);
  assert.equal(sources[0].installed, true);
  assert.equal((await success('/api/monitors')).monitors.length, 0);

  const missingMachine = await request('/api/monitors', 'POST', { name: 'Missing selection', type: 'agent' });
  assert.equal(missingMachine.status, 400);
  const monitoring = await success('/api/monitors', 'POST', { name: 'Explicit machine monitor', type: 'agent', agent_id: machine.id });
  assert.equal(monitoring.agent_token, undefined);
  const monitor = await db.prepare('SELECT * FROM monitors WHERE id=?').bind(monitoring.id).first();
  assert.equal(monitor.agent_id, machine.id);
  assert.equal((await success('/__rollup')).entries[0][0], monitoring.id);
  assert.equal((await success('/__rollup')).entries[0][1].st, 1);

  const hidden = await success('/api/monitors', 'POST', { name: 'Never-public-secret', type: 'http', target: 'https://private.fixture', is_public: false });
  const hiddenMonitor = await db.prepare('SELECT * FROM monitors WHERE id=?').bind(hidden.id).first();
  assert.equal(hiddenMonitor.is_public, 0);
  const cachePaths = ['/api/public/status', '/api/public/monitors?pageId=alternate', '/api/public/monitors/' + monitor.num_id,
    '/api/public/status/detail?id=' + monitoring.id,
    '/api/public/agent/detail/' + monitor.num_id + '?minutes=15', '/api/public/agent/detail/' + monitor.num_id + '?minutes=60'];
  for (const path of cachePaths) {
    const first = await request(path, 'GET', undefined, false);
    assert.equal(first.status, 200, JSON.stringify({ path, ...first }));
    assert.ok(!first.text.includes('Never-public-secret'));
    const cached = await request(path, 'GET', undefined, false);
    assert.equal(cached.cache, 'HIT', path);
  }
  await success('/api/monitors/' + monitoring.id, 'PUT', { is_public: false });
  for (const path of cachePaths) {
    const response = await request(path, 'GET', undefined, false);
    assert.ok(!response.text.includes('Explicit machine monitor'), JSON.stringify({ path, ...response }));
    if (path.includes('/detail/') || path.includes('/status/detail?') || /\/monitors\/\d/.test(path)) assert.equal(response.status, 404, path);
  }
  assert.equal((await request('/api/public/monitors/' + hiddenMonitor.num_id, 'GET', undefined, false)).status, 404);
  assert.equal((await request('/api/public/status/detail?id=' + hidden.id, 'GET', undefined, false)).status, 404);
  await success('/api/monitors/' + monitoring.id, 'PUT', { name: 'Renamed private monitor' });
  assert.equal((await db.prepare('SELECT is_public FROM monitors WHERE id=?').bind(monitoring.id).first()).is_public, 0);
  const visibilityIds = [monitoring.id, hidden.id];
  const missingBatch = await request('/api/monitors/visibility', 'POST', { ids: [monitoring.id, 'missing-monitor'], is_public: true });
  assert.equal(missingBatch.status, 404);
  assert.equal((await db.prepare('SELECT is_public FROM monitors WHERE id=?').bind(monitoring.id).first()).is_public, 0);
  const published = await success('/api/monitors/visibility', 'POST', { ids: visibilityIds, is_public: true });
  assert.equal(published.updated, 2);
  assert.equal((await success('/api/public/status', 'GET', undefined, false)).monitors.length, 2);
  const concealed = await success('/api/monitors/visibility', 'POST', { ids: visibilityIds, is_public: false });
  assert.equal(concealed.updated, 2);
  assert.equal((await success('/api/public/status', 'GET', undefined, false)).monitors.length, 0);
  assert.equal((await success('/api/monitors')).monitors.length, 2);
  assert.equal((await request('/api/admin/agents/' + machine.id, 'DELETE')).status, 409);
  await success('/api/monitors/' + monitoring.id, 'DELETE');
  assert.ok(await db.prepare('SELECT * FROM machine_live WHERE agent_id=?').bind(machine.id).first());
  assert.equal((await success('/api/admin/agents')).agents.length, 1);
  await success('/api/public/agent/push/' + machine.token, 'POST', frames, false);
  await success('/api/admin/agents/' + machine.id, 'DELETE');
  assert.equal(await db.prepare('SELECT * FROM machine_live WHERE agent_id=?').bind(machine.id).first(), null);
  console.log('PASS independent enrollment, explicit machine monitoring, monitor deletion isolation, and private monitor cache/detail access');
} finally { await mf.dispose(); }
