// 验证每日证书检查、目标变化与失败结果保存。
// Check daily certificate checks, target changes, and saved failures.

import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({
  stdin: { contents: "export { runAddons } from './backends/worker/src/lib/check/run'; export { ExternalRequestBudget } from './backends/worker/src/lib/http/request-budget';", resolveDir: process.cwd() },
  bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'error',
  plugins: [{ name: 'no-transport-check', setup(builder) {
    builder.onResolve({ filter: /^cloudflare:sockets$/ }, () => ({ path: 'sockets', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: "export function connect() { throw new Error('SSL schedule must not invoke a transport check'); }" }));
  } }],
});
const url = `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`;
let moduleId = 0;
const fresh = async () => (await import(url + '#' + ++moduleId)).runAddons;
const originalFetch = globalThis.fetch;
const originalNow = Date.now;
let now = Date.parse('2026-11-03T23:59:58Z');
Date.now = () => now;
const monitor = { id: 'ssl-daily', type: 'http', target: 'https://www.example.com', check_ssl: 1, check_domain: 0,
  check_dns: 0, options_json: '{}', warn_days: 14, timeout_ms: 1000 };
let calls = { ssl: 0, dns: 0, domain: 0 };
globalThis.fetch = async input => {
  const request = new URL(input);
  if (request.hostname === 'api.ctlogs.dev') {
    calls.ssl++;
    return Response.json({ rows: [{ id: '1', match: decodeURIComponent(request.pathname.split('/').at(-1)), issuer: 'Fixture CA',
      not_before: new Date(now - 86400000).toISOString(), not_after: new Date(now + 30 * 86400000).toISOString() }], has_next: false, next_cursor: '' });
  }
  if (request.hostname === 'crt.sh') {
    calls.ssl++;
    return Response.json([{ id: 1, name_value: request.searchParams.get('q'), issuer_name: 'Fixture CA',
      not_before: new Date(now - 86400000).toISOString(), not_after: new Date(now + 30 * 86400000).toISOString() }]);
  }
  if (request.hostname === 'cloudflare-dns.com') {
    calls.dns++;
    return Response.json({ Status: 0, Answer: [{ name: 'www.example.com', type: 1, TTL: 300, data: '192.0.2.1' }] });
  }
  if (request.hostname === 'data.iana.org') return Response.json({ services: [[['com'], ['https://rdap.example/']]] });
  if (request.hostname === 'rdap.example') {
    calls.domain++;
    return Response.json({ ldhName: 'example.com', events: [{ eventAction: 'expiration', eventDate: new Date(now + 100 * 86400000).toISOString() }] });
  }
  throw Error('Unexpected provider');
};

try {
  let runAddons = await fresh();
  const first = await runAddons(monitor);
  assert.equal(calls.ssl, 2);
  assert.equal(first.ssl.st, 1);
  assert.ok(first.ssl.checkKey);
  const saved = JSON.parse(JSON.stringify(first.ssl));
  now += 1000;
  const reused = await runAddons(monitor, undefined, saved);
  assert.deepEqual(reused.ssl, saved);
  assert.equal(calls.ssl, 2);
  const adjusted = await runAddons({ ...monitor, warn_days: 40 }, undefined, saved);
  assert.equal(adjusted.ssl.st, 2);
  assert.equal(adjusted.ssl.ts, saved.ts);
  assert.equal(calls.ssl, 2, 'warning changes use existing readings instead of another request');
  const revoked = await runAddons({ ...monitor, warn_days: 1 }, undefined, { ...saved, revoked: true, st: 2 });
  assert.equal(revoked.ssl.st, 2, 'changing the threshold cannot clear a known revocation warning');
  assert.equal(calls.ssl, 2);

  runAddons = await fresh();
  const cold = await runAddons(monitor, undefined, saved);
  assert.deepEqual(cold.ssl, saved, 'persisted readings survive a fresh isolate with an empty in-memory cache');
  assert.equal(calls.ssl, 2);
  const changedPath = await runAddons({ ...monitor, target: 'https://WWW.EXAMPLE.COM./another-path:8443' }, undefined, saved);
  assert.deepEqual(changedPath.ssl, saved);
  assert.equal(calls.ssl, 2);
  const otherChecks = { ...monitor, check_dns: 1, check_domain: 1 };
  const otherFirst = await runAddons(otherChecks, undefined, saved);
  const otherSecond = await runAddons(otherChecks, undefined, saved);
  assert.equal(otherFirst.dns.st, 1);
  assert.equal(otherSecond.domain.st, 1);
  assert.deepEqual(calls, { ssl: 2, dns: 2, domain: 2 }, 'DNS and domain registration keep their ordinary cadence');

  const retargeted = await runAddons({ ...monitor, target: 'https://api.other.example.com' }, undefined, saved);
  assert.notEqual(retargeted.ssl.checkKey, saved.checkKey);
  assert.equal(calls.ssl, 4);

  now = Date.parse('2026-11-04T23:59:58Z');
  runAddons = await fresh();
  const beforeMidnight = await runAddons(monitor);
  assert.equal(calls.ssl, 6);
  now += 4000;
  const nextDay = await runAddons(monitor, undefined, JSON.parse(JSON.stringify(beforeMidnight.ssl)));
  assert.equal(calls.ssl, 8, 'a new UTC day refreshes even a seconds-old provider cache');
  assert.notEqual(nextDay.ssl.checkKey, beforeMidnight.ssl.checkKey);
  assert.ok(nextDay.ssl.ts > beforeMidnight.ssl.ts);

  runAddons = await fresh();
  const withoutKey = { ...nextDay.ssl };
  delete withoutKey.checkKey;
  await runAddons(monitor, undefined, withoutKey);
  assert.equal(calls.ssl, 10, 'unidentified observations are not silently adopted as a daily result');

  const deferredModule = await import(url + '#deferred-budget');
  const exhausted = new deferredModule.ExternalRequestBudget();
  for (let index = 0; index < 50; index++) exhausted.reserve();
  const deferred = await deferredModule.runAddons(monitor, exhausted);
  assert.equal(deferred.ssl.ts, 0);
  assert.equal(calls.ssl, 10, 'a quota deferral does not contact the provider');
  const resumed = await deferredModule.runAddons(monitor, undefined, deferred.ssl);
  assert.ok(resumed.ssl.ts > 0);
  assert.equal(calls.ssl, 12, 'an unstarted lookup can retry later in the same day');

  let failures = 0;
  globalThis.fetch = async () => { failures++; throw new TypeError('fixture index unavailable'); };
  runAddons = await fresh();
  const failed = await runAddons(monitor);
  assert.equal(failed.ssl.st, 2);
  assert.equal(failed.ssl.days, null);
  assert.equal(failures, 5);
  runAddons = await fresh();
  const failedAgain = await runAddons(monitor, undefined, JSON.parse(JSON.stringify(failed.ssl)));
  assert.deepEqual(failedAgain.ssl, failed.ssl);
  assert.equal(failures, 5, 'failure observations also prevent repeated daily requests after a restart');
  now += 86400000;
  await runAddons(monitor, undefined, failed.ssl);
  assert.equal(failures, 10, 'failed lookups are retried on the next UTC day');
  console.log('PASS daily SSL: persisted success/failure observations, cold isolates, UTC rollover, target changes, warning thresholds and independent DNS/RDAP cadence');
} finally { Date.now = originalNow; globalThis.fetch = originalFetch; }
