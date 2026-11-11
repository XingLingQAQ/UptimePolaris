// 验证过期与混合报告按服务端时间处理。
// Check expired and mixed reports against the server clock.

import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({
  entryPoints: ['backends/worker/src/lib/agent/report.ts'], bundle: true, platform: 'node', format: 'esm', write: false,
  plugins: [{ name: 'fixture-db', setup(builder) {
    builder.onResolve({ filter: /\/db\/factory$/ }, () => ({ path: 'factory', namespace: 'fixture' }));
    builder.onResolve({ filter: /\/db\/sql\/agent$/ }, () => ({ path: 'sql', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: path === 'factory'
      ? 'export const getDB = env => env.db; export const withDBScope = (env, fn) => fn(env);'
      : "export const agentLiveSQL = { fixture: { isActive: 'active', upsertStatic: 'static', upsertDynamic: 'dynamic', upsertFinalized: 'finalized' } };" }));
  } }],
});
const { dispatchRpc, isSupportedFrame } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const originalNow = Date.now;
const now = 200_040;
Date.now = () => now * 1000;
try {
  const writes = [];
  const env = { db: { type: 'fixture', queryOne: async () => ({ active: 1 }), execute: async (sql, args) => { writes.push({ sql, args }); } } };
  const monitor = { id: 'fixture' };
  const summary = (bucket_ts) => ({ bucket_ts, sample_count: 1, cpu_samples: 1, cpu_avg: 5, cpu_max: 5, mem_samples: 1, mem_pct_avg: 10, mem_pct_max: 10, load_1_avg: 0, load_5_avg: 0, net_up_bytes: 0, net_down_bytes: 0, network_duration_sec: 1, duration_sec: 1 });
  const report = (observed_at, summaries) => ({ method: 'report', params: { interfaces: null, mounts: null, message: '', observed_at, summaries,
    cpu: { usage: 5 }, ram: { total: 100, used: 10 }, swap: { total: 0, used: 0 },
    load: { load1: 0, load5: 0, load15: 0 }, disk: { total: 100, used: 10 },
    network: { up: 0, down: 0, totalUp: 0, totalDown: 0 }, connections: { tcp: 0, udp: 0 }, uptime: 1, process: 1,
  } });
  const expired = report(now - 86_401, [summary(now)]);
  assert.equal(isSupportedFrame(expired), true);
  assert.deepEqual(await dispatchRpc(env, monitor, expired), { ack: true, ignored: true });
  assert.equal(writes.length, 0);
  assert.ok(expired.params.observed_at < now - 86_400 && now > expired.params.observed_at);
  const validBucket = Math.floor((now - 60) / 60) * 60;
  const oldBucket = Math.floor((now - 90_000) / 60) * 60;
  const fresh = report(now, [summary(oldBucket), summary(validBucket)]);
  assert.deepEqual(await dispatchRpc(env, monitor, fresh), { ack: true, ignored: false });
  assert.equal(writes.filter(row => row.sql === 'finalized').length, 1);
  assert.equal(writes.find(row => row.sql === 'finalized').args[1], validBucket);
  assert.deepEqual(await dispatchRpc(env, monitor, report(now + 365 * 86_400, [])), { ack: true, ignored: false, deferred: true });
  assert.equal(isSupportedFrame(report(now + 301, [])), true);
  assert.equal(isSupportedFrame(report(now + 300, [])), true);
  assert.equal(isSupportedFrame({ method: 'unknown' }), false);
  const basic = { method: 'basicReport', params: { kernel: 'fixture-kernel', mem_total: 1024, version: '0.1.0', transport: 'ws', report_interval_secs: 60, capabilities: [], name: 'fixture', os: 'Windows 11', arch: 'x86_64', cpu_model: 'fixture', cpu_cores: 2 } };
  await dispatchRpc(env, monitor, basic);
  assert.equal(writes.at(-1).args[9], null, 'missing host geography stays unknown');
  assert.equal(writes.at(-1).args[6], null, 'the connection address is not a machine public IP');
  assert.equal(writes.at(-1).args[7], null);
  await dispatchRpc(env, monitor, { ...basic, params: { ...basic.params, publicIp: '192.0.2.1', region: 'Shanghai, CN' } });
  assert.equal(writes.at(-1).args[9], 'Shanghai, CN');
  assert.equal(writes.at(-1).args[6], '192.0.2.1');
  // 当前必填字段必须完整；显式 null 明细仍是有效上报。
  // Require current wire fields while retaining explicit null detail collections.
  for (const [frame, keys] of [
    [basic, ['kernel', 'mem_total', 'version', 'transport', 'report_interval_secs', 'capabilities']],
    [report(now, []), ['observed_at', 'summaries', 'interfaces', 'mounts', 'message']],
  ]) {
    for (const key of keys) {
      const params = { ...frame.params };
      delete params[key];
      const before = writes.length;
      assert.equal(isSupportedFrame({ ...frame, params }), false, key);
      assert.deepEqual(await dispatchRpc(env, monitor, { ...frame, params }), { ack:false, ignored:false });
      assert.equal(writes.length, before);
    }
  }
  for (const patch of [{ summaries: {} }, { interfaces: {} }, { mounts: [1] }, { observed_at: 'now' }]) {
    const frame = report(now, []);
    assert.equal(isSupportedFrame({ ...frame, params: { ...frame.params, ...patch } }), false);
  }
  assert.equal(isSupportedFrame(report(now, [])), true);
} finally {
  Date.now = originalNow;
}
console.log('PASS expired and mixed reports use the server clock and retain valid summaries');
