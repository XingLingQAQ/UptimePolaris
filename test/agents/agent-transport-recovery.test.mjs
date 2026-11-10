// 验证 HTTP 与 WebSocket 暂缓未来报告而继续接收有效报告。
// Check that HTTP and WebSocket defer future reports while accepting current ones.

import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { applyD1Migrations } from '../helpers/apply-d1-migrations.mjs';

const built = await build({
  stdin: { contents: "import { api } from './backends/worker/src/api'; let clock = null; const realNow = Date.now; Date.now = () => clock ?? realNow(); export default { fetch: (req, env, ctx) => { const url = new URL(req.url); if (url.pathname === '/__clock') { clock = Number(url.searchParams.get('now')) * 1000; return Response.json({ ok: true }); } return api.fetch(req, env, ctx); } };", resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, format: 'esm', write: false, target: 'es2022', logLevel: 'error',
  plugins: [{ name: 'stubs', setup(b) {
    b.onResolve({ filter: /^(postgres|cloudflare:sockets)$/ }, args => ({ path: args.path, namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({ contents: args.path === 'postgres' ? "export default function postgres() { throw Error('stub'); }" : "export const connect = () => { throw Error('stub'); };" }));
  } }],
});
const mf = new Miniflare({ modules: true, script: built.outputFiles[0].text, compatibilityDate: '2025-01-01', bindings: { ADMIN_TOKEN: 'test-admin-token', CF_ACCOUNT_ID: 'test', CF_API_TOKEN: 'test' }, d1Databases: { DB: 'agent-transport-fixture' } });
try {
  const db = await mf.getD1Database('DB');
  await applyD1Migrations(db);
  const create = await mf.dispatchFetch('http://localhost/api/admin/agents', { method: 'POST', headers: { authorization: 'Bearer test-admin-token', 'content-type': 'application/json' }, body: JSON.stringify({ name: 'fixture' }) });
  assert.equal(create.status, 201);
  const { token: token } = await create.json();
  const now = Math.floor(Date.now() / 1000);
  const frame = (id, observed_at) => ({ jsonrpc: '2.0', id, method: 'report', params: {
    observed_at, cpu: { usage: 5 }, ram: { total: 100, used: 10 }, swap: { total: 0, used: 0 },
    load: { load1: 0, load5: 0, load15: 0 }, disk: { total: 100, used: 10 },
    network: { up: 0, down: 0, totalUp: 0, totalDown: 0 }, connections: { tcp: 0, udp: 0 }, uptime: 1, process: 1,
  } });
  const future = frame(1, now + 365 * 86_400);
  const current = frame(2, now);
  const expired = frame(3, now - 90_000);
  const push = await mf.dispatchFetch(`http://localhost/api/public/agent/push/${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify([future, current, expired]) });
  assert.equal(push.status, 200);
  const body = await push.json();
  assert.deepEqual(body.acks, [{ id: 1, ack: true, ignored: false, deferred: true }, { id: 2, ack: true, ignored: false }, { id: 3, ack: true, ignored: true }]);
  assert.deepEqual([body.accepted, body.ignored, body.deferred], [1, 1, 1]);
  const upgrade = await mf.dispatchFetch(`http://localhost/api/public/agent/${token}`, { headers: { Upgrade: 'websocket' } });
  assert.equal(upgrade.status, 101);
  const ws = upgrade.webSocket;
  ws.accept();
  const acks = [];
  ws.addEventListener('message', event => acks.push(JSON.parse(String(event.data))));
  for (const item of [future, current, expired]) ws.send(JSON.stringify(item));
  for (let i = 0; i < 50 && acks.length < 3; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(acks.map(({ id, result }) => ({ id, ...result })), body.acks);
  await mf.dispatchFetch(`http://localhost/__clock?now=${future.params.observed_at}`);
  const retried = await mf.dispatchFetch(`http://localhost/api/public/agent/push/${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(future) });
  assert.equal(retried.status, 200);
  assert.deepEqual((await retried.json()).acks, [{ id: 1, ack: true, ignored: false }]);
  ws.send(JSON.stringify(future));
  for (let i = 0; i < 50 && acks.length < 4; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(acks[3].result, { ack: true, ignored: false });
  ws.close();
  console.log('PASS HTTP and WebSocket defer future frames while accepting current reports');
} finally {
  await mf.dispose();
}
