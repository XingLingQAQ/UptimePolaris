import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { applyD1Migrations } from '../helpers/apply-d1-migrations.mjs';
import { workerBundlePlugins } from '../helpers/bundle-worker.mjs';

const cases = JSON.parse(readFileSync('test/fixtures/agent-containers.json', 'utf8'));
const protocol = await build({ entryPoints: ['backends/worker/src/lib/agent/protocol.ts'], bundle: true, write: false, format: 'esm' });
const { asReportParams } = await import(`data:text/javascript;base64,${Buffer.from(protocol.outputFiles[0].text).toString('base64')}`);
const now = Math.floor(Date.now() / 1000);
const report = (extra = {}, at = now) => ({
  observed_at: at, summaries: [], interfaces: null, mounts: null, message: '',
  cpu: { usage: 5 }, ram: { total: 100, used: 10 }, swap: { total: 0, used: 0 },
  load: { load1: 0, load5: 0, load15: 0 }, disk: { total: 100, used: 10 },
  network: { up: 0, down: 0, totalUp: 0, totalDown: 0 }, connections: { tcp: 0, udp: 0 },
  uptime: 1, process: 1, ...extra,
});
for (const item of cases) {
  const parsed = asReportParams(report(item.input));
  if (item.invalid) assert.equal(parsed, null, item.name);
  else {
    assert.ok(parsed, item.name);
    assert.deepEqual(parsed.containers, item.expected.containers, item.name);
  }
}
for (const value of [NaN, Infinity, -Infinity]) {
  assert.equal(asReportParams(report({ containers: [{ id: 'id', name: 'Container', runtime: 'docker', state: 'running', cpu_pct: value }] })), null);
}

const bundle = await build({
  stdin: { resolveDir: process.cwd(), loader: 'ts', contents: "import { api } from './backends/worker/src/api'; export default { fetch: api.fetch };" },
  bundle: true, write: false, format: 'esm', target: 'es2022', logLevel: 'error', plugins: workerBundlePlugins(),
});
const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2025-01-01',
  compatibilityFlags: ['nodejs_compat'], d1Databases: { DB: 'containers' }, kvNamespaces: { CONFIG: 'containers' },
  analyticsEngineDatasets: { UPTIME: { dataset: 'containers' } }, bindings: { ADMIN_TOKEN: 'containers-fixture', DATABASE_TYPE: 'd1' } });
async function request(path, method = 'GET', body, auth = true) {
  const response = await mf.dispatchFetch(`http://localhost${path}`, { method,
    headers: { ...(auth ? { authorization: 'Bearer containers-fixture' } : {}), 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}
async function success(path, method = 'GET', body, auth = true) {
  const result = await request(path, method, body, auth);
  assert.ok(result.status >= 200 && result.status < 300, JSON.stringify(result));
  return result.body;
}
try {
  const db = await mf.getD1Database('DB');
  await applyD1Migrations(db);
  const presentation = await success('/api/admin/presentation');
  await success('/api/admin/presentation', 'PUT', { config: { ...presentation.config, agentEnabled: true,
    domains: [] }, revision: presentation.revision });
  const agent = await success('/api/admin/agents', 'POST', { name: 'Containers fixture', is_public: true });
  const monitor = await success('/api/monitors', 'POST', { name: 'Containers', type: 'agent', agent_id: agent.id, is_public: true });
  const { num_id: numId } = await db.prepare('SELECT num_id FROM monitors WHERE id=?').bind(monitor.id).first();
  const path = `/api/public/agent/push/${agent.token}`;
  const push = (extra, at) => success(path, 'POST', { method: 'report', params: report(extra, at) }, false);
  const detail = () => success(`/api/admin/agents/${agent.id}/detail`);
  await push({}, now - 5);
  const old = await detail();
  assert.equal(Object.hasOwn(old, 'containers_json'), false);
  assert.deepEqual(await db.prepare('SELECT containers_json FROM machine_live WHERE agent_id=?').bind(agent.id).first(), { containers_json: null });
  const valid = cases.find(item => item.name === 'valid');
  await push(valid.input, now - 4);
  const stored = await detail();
  for (const field of ['containers']) assert.deepEqual(JSON.parse(stored[field + '_json']), valid.expected[field]);
  assert.equal((await request(`/api/admin/agents/${agent.id}/detail`, 'GET', undefined, false)).status, 401);
  for (const showContainers of [false, true]) {
    await success('/api/admin/settings', 'PUT', { 'site.showPublicAgentHardware': showContainers });
    for (const publicPath of [`/api/public/agent/detail/${numId}`, `/api/public/servers/${agent.id}?view=agent`]) {
      const exposed = await success(publicPath, 'GET', undefined, false);
      assert.doesNotMatch(JSON.stringify(exposed), /containers_json|Private container|private.registry|private secret/);
    }
  }
  for (const item of cases.filter(item => item.invalid)) {
    const invalid = await request(path, 'POST', { method: 'report', params: report(item.input) }, false);
    assert.equal(invalid.status, 400, item.name);
  }
  await push({ containers: null }, now - 3);
  await push({}, now - 2);
  assert.equal((await detail()).containers_json, stored.containers_json);
  await push({ containers: [] }, now - 10);
  assert.equal((await detail()).containers_json, stored.containers_json, 'stale snapshot must not clear containers');
  await push({ containers: [] }, now - 1);
  assert.equal((await detail()).containers_json, '[]');
  console.log('PASS containers contract, D1 persistence, old reports, private detail, public redaction and bounds');
} finally { await mf.dispose(); }
