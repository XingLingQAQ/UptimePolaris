// 验证 Agent 附加检查的能力、结果归属与过期租约。
// Check Agent add-on capabilities, result ownership, and stale leases.

import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { applyD1Migrations } from '../helpers/apply-d1-migrations.mjs';
import { workerBundlePlugins } from '../helpers/bundle-worker.mjs';

const bundle = await build({ stdin: { resolveDir: process.cwd(), loader: 'ts', contents: `
  import { api } from './backends/worker/src/api';
  import { runTick } from './backends/worker/src/lib/jobs/tick';
  import { scheduleAgentProbeJobs, latestAgentProbeObservation } from './backends/worker/src/lib/agent/probes';
  import { getDB } from './backends/worker/src/lib/db/factory';
  let clock = 1800000000;
  Date.now = () => clock * 1000;
  export default { async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/__clock') { clock = Number(url.searchParams.get('now')); return Response.json({ok:true}); }
    if (url.pathname === '/__schedule') {
      await scheduleAgentProbeJobs(env, await getDB(env).query('SELECT * FROM monitors'), clock);
      return Response.json({ok:true});
    }
    if (url.pathname === '/__tick') { await runTick(env, clock); return Response.json({ok:true}); }
    return api.fetch(request, env, ctx);
  } };
` }, bundle: true, write: false, format: 'esm', target: 'es2022', plugins: workerBundlePlugins(), logLevel: 'error' });
const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2025-01-01',
  compatibilityFlags: ['nodejs_compat'], d1Databases: { DB: 'agent-addons' }, bindings: { ADMIN_TOKEN: 'fixture' } });
async function request(path, body, admin = false, method = body === undefined ? 'GET' : 'POST') {
  const response = await mf.dispatchFetch('http://fixture.test' + path, { method,
    headers: { ...(admin ? { authorization: 'Bearer fixture' } : {}), 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
}
async function success(...args) { const result = await request(...args); assert.ok(result.status < 300, JSON.stringify(result)); return result.body; }
try {
  const db = await mf.getD1Database('DB');
  await applyD1Migrations(db);
  let now = Math.floor(1800000000 / 86400) * 86400 + 3600;
  await success('/__clock?now=' + now);
  const machine = await success('/api/admin/agents', { name: 'Addon probe' }, true);
  const foreign = await success('/api/admin/agents', { name: 'Other probe' }, true);
  const frames = { method: 'basicReport', params: { name: 'addon-node', os: 'linux', arch: 'x86_64', cpu_model: 'fixture', cpu_cores: 1,
    version: '0.5.4', report_interval_secs: 60, capabilities: ['probe_http', 'probe_tcp', 'probe_ssl', 'probe_domain', 'probe_dns'] } };
  const report = () => success('/api/public/agent/push/' + machine.token, [frames, { method: 'report', params: {
    observed_at: now, cpu: { usage: 5 }, ram: { total: 100, used: 10 }, swap: { total: 0, used: 0 },
    load: { load1: 0, load5: 0, load15: 0 }, disk: { total: 100, used: 10 }, network: { up: 0, down: 0, totalUp: 0, totalDown: 0 },
    connections: { tcp: 1, udp: 1 }, uptime: 1, process: 1, summaries: [] }, }]);
  await report();
  const monitor = await success('/api/monitors', { name: 'Full Agent checks', type: 'http', target: 'https://www.example.com:8443/health',
    check_ssl: 1, check_domain: 1, check_dns: 1, timeout_ms: 20000, interval_sec: 60,
    options_json: { check_source: { type: 'agent', agent_id: machine.id }, dns: { recordType: 'AAAA', expected: '2001:db8' } } }, true);
  const jobs = () => success('/api/public/agent/jobs/' + machine.token);
  const submit = (job, addons, token = machine.token) => request('/api/public/agent/results/' + token, {
    run_id: job.run_id, lease_token: job.lease_token, observed_at: now, status: 1, status_code: 200, latency_ms: 17.5, message: '', addons });
  const results = () => ({
    ssl: { status: 1, days_left: 45, tls_valid: true, message: 'Certificate valid', observed_at: now },
    domain: { status: 1, days_left: 90, message: 'Domain valid', observed_at: now },
    dns: { status: 1, message: 'DNS matches', observed_at: now, records: ['2001:db8::1'], rcode: 'NOERROR' },
  });
  await success('/__schedule');
  const first = (await jobs()).jobs[0];
  assert.deepEqual(first.addons.ssl, { host: 'www.example.com', port: 8443, warn_days: 14 });
  assert.deepEqual(first.addons.domain, { domain: 'example.com', warn_days: 14 });
  assert.equal(first.addons.dns.record_type, 'AAAA');
  assert.equal(first.addons.dns.expected, '2001:db8');
  assert.equal((await submit(first, {})).status, 400, 'requested checks cannot disappear');
  assert.equal((await submit(first, { ...results(), ssl: { ...results().ssl, tls_valid: undefined } })).status, 400);
  assert.equal((await submit(first, results(), foreign.token)).status, 404, 'another machine cannot complete the lease');
  assert.equal((await submit(first, { ...results(), dns: { ...results().dns, observed_at: now + 300 } })).status, 400);
  assert.equal((await submit(first, results())).status, 200);
  assert.equal((await submit(first, results())).body.duplicate, true);
  await success('/__tick');
  const live = () => db.prepare("SELECT json FROM live_state WHERE id='all'").first().then(row => JSON.parse(row.json));
  const initial = (await live())[monitor.id];
  assert.equal(initial.st, 1);
  assert.equal(initial.v, 17.5, 'TLS and registry time must not become HTTP latency');
  assert.equal(initial.ssl.days, 45);
  assert.equal(initial.ssl.tls_valid, true);
  assert.equal(initial.domain.days, 90);
  assert.deepEqual(initial.dns.records, ['2001:db8::1']);

  const next = async (offset = 60) => {
    now += offset;
    await success('/__clock?now=' + now);
    await report();
    await success('/__schedule');
    return (await jobs()).jobs.at(-1);
  };
  const second = await next();
  assert.equal(second.addons.ssl, undefined, 'same-day SSL is loaded from persisted live state');
  assert.ok(second.addons.dns && second.addons.domain, 'primary cadence and other add-ons continue');
  assert.equal((await submit(second, results())).status, 400, 'unsolicited SSL results cannot overwrite the daily reading');
  const withoutSsl = results(); delete withoutSsl.ssl;
  assert.equal((await submit(second, withoutSsl)).status, 200);
  await success('/__tick');
  assert.equal((await live())[monitor.id].ssl.ts, initial.ssl.ts);

  await success('/api/monitors/' + monitor.id, { warn_days: 50 }, true, 'PUT');
  const third = await next();
  assert.equal(third.addons.ssl, undefined, 'changing the threshold reuses the certificate');
  const thirdResults = results(); delete thirdResults.ssl;
  assert.equal((await submit(third, thirdResults)).status, 200);
  await success('/__tick');
  assert.equal((await live())[monitor.id].ssl.st, 2, 'the new warning threshold is applied');

  const tomorrow = await next(86400);
  assert.ok(tomorrow.addons.ssl, 'a new UTC day requests a fresh handshake');
  const untrusted = results(); untrusted.ssl = { ...untrusted.ssl, status: 2, tls_valid: false, days_left: 70, message: 'certificate is not trusted' };
  assert.equal((await submit(tomorrow, untrusted)).status, 200);
  await success('/__tick');
  assert.equal((await live())[monitor.id].ssl.st, 2);
  await success('/api/monitors/' + monitor.id, { warn_days: 1 }, true, 'PUT');
  const preserved = await next();
  assert.equal(preserved.addons.ssl, undefined);
  const remaining = results(); delete remaining.ssl;
  assert.equal((await submit(preserved, remaining)).status, 200);
  await success('/__tick');
  assert.equal((await live())[monitor.id].ssl.tls_valid, false);
  assert.equal((await live())[monitor.id].ssl.st, 2, 'lowering the threshold cannot clear a TLS trust warning');

  const stale = await next();
  await success('/api/monitors/' + monitor.id, { check_dns: 0 }, true, 'PUT');
  assert.equal((await submit(stale, remaining)).status, 409, 'configuration changes invalidate old results');
  console.log('PASS Agent add-ons: issued capability checks, ownership, malformed results, native readings, daily SSL reuse, UTC rollover, threshold changes and stale leases');
} finally { await mf.dispose(); }
