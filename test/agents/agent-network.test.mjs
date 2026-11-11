// 验证已认证报告中的机器网络身份不受代理来源覆盖。
// Check that proxy metadata does not overwrite network identity in authenticated reports.

import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({
  entryPoints: ['backends/worker/src/lib/agent/http-push.ts'], bundle: true, write: false, format: 'esm', platform: 'node',
  plugins: [{ name: 'fixture-db', setup(builder) {
    builder.onResolve({ filter: /\/db\/factory$/ }, () => ({ path: 'factory', namespace: 'fixture' }));
    builder.onResolve({ filter: /\/db\/sql\/agent$/ }, () => ({ path: 'agent', namespace: 'fixture' }));
    builder.onResolve({ filter: /\/db\/sql\/monitors$/ }, () => ({ path: 'monitors', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: path === 'factory'
      ? 'export const getDB = env => env.db; export const withDBScope = (env, fn) => fn(env);'
      : path === 'agent' ? "export const agentLiveSQL = { fixture: { isActive: 'active', upsertStatic: 'static' } };"
      : "export const monitorSQL = { fixture: { byAgentToken: 'monitor' } };" }));
  } }],
});
const { handleAgentHttpPush } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const writes = [];
const monitor = { id: 'fixture', type: 'agent', active: 1 };
const env = { db: { type: 'fixture', queryOne: async sql => sql.includes('FROM agents') ? monitor : { active: 1 },
  execute: async (_sql, args) => { writes.push(args); return { rowsAffected: 1 }; } } };
async function report(network) {
  const raw = new Request('https://fixture/api/public/agent/push/token', { headers: { 'cf-connecting-ip': '203.0.113.1' } });
  raw.cf = { country: 'US', city: 'Proxy City', asOrganization: 'Proxy ISP' };
  const frame = { method: 'basicReport', params: { kernel: 'fixture-kernel', mem_total: 1024, version: '0.1.0', transport: 'ws', report_interval_secs: 60, capabilities: [], name: 'fixture', os: 'Windows', arch: 'x86_64', cpu_model: 'fixture', cpu_cores: 2, ...network } };
  const response = await handleAgentHttpPush({ env, req: { raw, param: () => 'token', query: () => undefined, json: async () => frame },
    json: (value, status = 200) => Response.json(value, { status }) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
  return writes.at(-1);
}
const missing = await report({});
assert.deepEqual(missing.slice(6, 10), [null, null, null, null], 'proxy connection metadata cannot fill missing machine identity');
const native = await report({ publicIp: '192.0.2.1', region: 'Shanghai, CN', isp: 'Native ISP' });
assert.deepEqual(native.slice(6, 10), ['192.0.2.1', null, 'Native ISP', 'Shanghai, CN']);
console.log('PASS host network identity stays independent of proxy IP, country and ISP on authenticated reports');
