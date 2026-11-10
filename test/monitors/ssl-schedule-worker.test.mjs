// 验证 Worker 证书检查按 UTC 日缓存和更新。
// Check Worker certificate-check caching and refresh across UTC days.

import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { applyD1Migrations } from '../helpers/apply-d1-migrations.mjs';

const entry = `
import { runTick, runMonitorCheck } from './backends/worker/src/lib/jobs/tick';
import { withDBScope } from './backends/worker/src/lib/db/factory';
import { invalidateConfig } from './backends/worker/src/lib/monitor/store';
let now = Date.parse('2026-11-03T12:00:00Z');
Date.now = () => now;
let primaryRequests = 0;
let certificateRequests = 0;
let failCertificate = false;
globalThis.fetch = async input => {
  const url = new URL(input);
  if (['api.ctlogs.dev', 'ct.certkit.io', 'api.certspotter.com', 'crt.sh'].includes(url.hostname)) {
    certificateRequests++;
    if (failCertificate) return new Response('fixture unavailable', { status: 503 });
    if (url.hostname === 'api.ctlogs.dev') return Response.json({ rows: [{ id: '1', match: decodeURIComponent(url.pathname.split('/').at(-1)), issuer: 'Fixture CA',
      not_before: new Date(now - 86400000).toISOString(), not_after: new Date(now + 30 * 86400000).toISOString() }], has_next: false, next_cursor: '' });
    return Response.json([{ id: 1, name_value: url.searchParams.get('q'), issuer_name: 'Fixture CA',
      not_before: new Date(now - 86400000).toISOString(), not_after: new Date(now + 30 * 86400000).toISOString() }]);
  }
  if (url.hostname.endsWith('.example.com')) {
    primaryRequests++;
    return new Response('fixture healthy');
  }
  throw new Error('unexpected external request');
};
export default { async fetch(request, env) {
  const url = new URL(request.url);
  now = Number(url.searchParams.get('now')) * 1000;
  if (url.searchParams.has('fail')) failCertificate = true;
  if (url.searchParams.has('retarget')) {
    await env.DB.prepare("UPDATE monitors SET target = 'https://api.other.example.com', updated_at = ? WHERE id = 'ssl-daily'").bind(Math.floor(now / 1000)).run();
    invalidateConfig();
  }
  let outcome;
  if (url.pathname === '/manual') {
    const monitor = await env.DB.prepare("SELECT * FROM monitors WHERE id='ssl-daily'").first();
    outcome = await withDBScope(env, scopedEnv => runMonitorCheck(scopedEnv, monitor));
  } else outcome = await runTick(env, Math.floor(now / 1000));
  const row = await env.DB.prepare("SELECT json FROM live_state WHERE id='all'").first();
  return Response.json({ outcome, primaryRequests, certificateRequests, entry: JSON.parse(row.json)['ssl-daily'] });
} };
`;
const bundle = await build({
  stdin: { contents: entry, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false,
  format: 'esm', platform: 'neutral', target: 'es2022', external: ['cloudflare:sockets'], logLevel: 'error',
  plugins: [{ name: 'd1-only', setup(builder) {
    builder.onResolve({ filter: /^postgres$/ }, () => ({ path: 'postgres', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: "export default function postgres() { throw new Error('D1 fixture'); }" }));
  } }],
});
const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2025-01-01',
  compatibilityFlags: ['nodejs_compat'], d1Databases: { DB: 'ssl-daily-fixture' } });
try {
  const db = await mf.getD1Database('DB');
  await applyD1Migrations(db);
  await db.prepare(`INSERT INTO monitors (id, name, type, target, interval_sec, timeout_ms, warn_days, check_ssl, active, created_at, updated_at)
    VALUES ('ssl-daily', 'Daily SSL fixture', 'http', 'https://www.example.com', 60, 1000, 14, 1, 1, 0, 0)`).run();
  const start = Date.parse('2026-11-03T12:00:00Z') / 1000;
  const run = async (path, now, extra = '') => {
    const response = await mf.dispatchFetch('http://localhost' + path + '?now=' + now + extra);
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  const first = await run('/tick', start);
  assert.equal(first.primaryRequests, 1);
  assert.equal(first.certificateRequests, 2);
  assert.ok(first.entry.ssl.checkKey);
  const second = await run('/tick', start + 60);
  assert.equal(second.primaryRequests, 2);
  assert.equal(second.certificateRequests, 2);
  assert.equal(second.entry.ssl.ts, first.entry.ssl.ts);
  const manual = await run('/manual', start + 120);
  assert.equal(manual.outcome.status, 'checked');
  assert.equal(manual.primaryRequests, 3);
  assert.equal(manual.certificateRequests, 2);
  assert.equal(manual.entry.ssl.ts, first.entry.ssl.ts);
  const nextDay = await run('/tick', start + 86400);
  assert.equal(nextDay.primaryRequests, 4);
  assert.equal(nextDay.certificateRequests, 4);
  assert.ok(nextDay.entry.ssl.ts > first.entry.ssl.ts);
  const retarget = await run('/tick', start + 86460, '&retarget=1');
  assert.equal(retarget.primaryRequests, 5);
  assert.equal(retarget.certificateRequests, 6);
  assert.notEqual(retarget.entry.ssl.checkKey, nextDay.entry.ssl.checkKey);
  const failed = await run('/tick', start + 2 * 86400, '&fail=1');
  assert.equal(failed.certificateRequests, 11);
  assert.equal(failed.entry.ssl.days, null);
  assert.equal(failed.entry.ssl.st, 2);
  const retry = await run('/tick', start + 2 * 86400 + 60);
  assert.equal(retry.primaryRequests, failed.primaryRequests + 1);
  assert.equal(retry.certificateRequests, 11);
  assert.equal(retry.entry.ssl.ts, failed.entry.ssl.ts);
  console.log('PASS actual D1 scheduling: primary minute checks, manual checks, persisted daily SSL reads, UTC rollover, retargeting and saved failure results');
} finally { await mf.dispose(); }
