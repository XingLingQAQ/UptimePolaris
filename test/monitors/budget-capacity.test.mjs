// 验证请求预算、跨域跳转与探测任务期限。
// Check request budgets, cross-origin redirects, and probe job deadlines.

import { applyD1Migrations } from '../helpers/apply-d1-migrations.mjs';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

const adminToken = 'isolated-budget-test';
const source = `
import { api } from './backends/worker/src/api';
import { runTick } from './backends/worker/src/lib/jobs/tick.ts';
import { budgetedFetch, ExternalRequestBudget } from './backends/worker/src/lib/http/request-budget.ts';
import { scheduleAgentProbeJobs, pollAgentProbeJobs, pruneAgentProbeJobs } from './backends/worker/src/lib/agent/probes.ts';
import { loadHeartbeats, prepareAvailabilityDayWrites, upsertDay } from './backends/worker/src/lib/monitor/store.ts';
import { withDBScope } from './backends/worker/src/lib/db/factory.ts';
import { sendToChannel } from './backends/worker/src/lib/notification/send';
import { getDB } from './backends/worker/src/lib/db/factory.ts';
let clock = Date.now();
Date.now = () => clock;
globalThis.fetch = async () => new Response('ok', { status: 200 });
let tickUsage;
const log = console.log.bind(console);
console.log = (line) => { try { const value = JSON.parse(line); if (value.event === 'tick_db_usage') tickUsage = value; } catch {} };
export default { async fetch(request, env, ctx) {
  const url = new URL(request.url);
  if (url.pathname === '/__tick') {
    clock = Number(url.searchParams.get('now')) * 1000;
    const result = await runTick(env, Math.floor(clock / 1000));
    return Response.json({ ...result, usage: tickUsage });
  }
  if (url.pathname === '/__late') {
    const now = Number(url.searchParams.get('now'));
    clock = now * 1000;
    const db = getDB(env);
    const monitor = await db.queryOne('SELECT * FROM monitors WHERE id=?', [url.searchParams.get('monitor')]);
    const agent = await db.queryOne('SELECT * FROM agents WHERE id=?', [url.searchParams.get('agent')]);
    await scheduleAgentProbeJobs(env, [monitor], now);
    clock = (now + 30) * 1000;
    const jobs = await pollAgentProbeJobs(env, agent, now + 30);
    return Response.json({ jobs });
  }
  /**
   * A budget skip on a monitor that already had a reading.
   *
   * The capacity error is delivered the way the platform delivers it - as the
   * message on a completed check ("too many subrequests", which
   * isWorkerCapacityError recognises) - so the deterministic branch is
   * exercised without having to overflow the tick with 51 monitors again.
   *
   * The old code wrote unknownSourceEntry() here: fails 0, ts 0, v null,
   * source_available false. For a target already failing that restarted the
   * retry counter every time the free plan ran dry, so DOWN could be postponed
   * forever, and the source-unavailable badge appeared for a monitor whose
   * source was never involved.
   *
   * 已有读数的监控遇到预算跳过。容量错误按平台真实方式作为完成检查的消息返回
   * （isWorkerCapacityError 可识别 too many subrequests），无需再次用 51 个监控溢出 tick。
   * 旧代码写入 unknownSourceEntry()：fails 0、ts 0、v null、source_available false。
   * 对已失败目标，这会在免费额度耗尽时反复重置重试计数，可能永远推迟 DOWN，
   * 且会对从未涉及来源问题的监控显示来源不可用标记。
   */
  if (url.pathname === '/__budget-preserve') {
    const now = Number(url.searchParams.get('now'));
    const id = url.searchParams.get('id');
    clock = now * 1000;
    const before = JSON.parse((await getDB(env).queryOne("SELECT json FROM live_state WHERE id='all'")).json);
    const seed = { st: 0, ts: now - 60, v: 987, code: 0, msg: 'prior failure', fails: 2, stable_st: 0 };
    await getDB(env).execute("UPDATE live_state SET json = ? WHERE id = 'all'", [JSON.stringify({ ...before, [id]: seed })]);
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('too many subrequests by single Worker invocation'); };
    try {
      await runTick(env, now);
    } finally {
      globalThis.fetch = realFetch;
    }
    const after = JSON.parse((await getDB(env).queryOne("SELECT json FROM live_state WHERE id='all'")).json);
    return Response.json({ entry: after[id] });
  }
  if (url.pathname === '/__prune') {
    const now = Number(url.searchParams.get('now'));
    await pruneAgentProbeJobs(env, now);
    return Response.json({ count: await getDB(env).queryOne('SELECT COUNT(*) AS n FROM agent_probe_jobs') });
  }
  if (url.pathname === '/__chunk') {
    const ids = Array.from({ length: Number(url.searchParams.get('count')) }, (_, i) => 'missing-' + i);
    return withDBScope(env, async (scopedEnv) => {
      const rows = await loadHeartbeats(scopedEnv, ids);
      return Response.json({ size: rows.size, usage: getDB(scopedEnv).getUsage() });
    });
  }
  if (url.pathname === '/__exact') {
    return withDBScope(env, async (scopedEnv) => {
      const id = url.searchParams.get('id');
      const day = '2026-10-01';
      await upsertDay(scopedEnv, id, { d: day, t: 50, u: 49, w: 0, avg: 12 });
      const writes = await prepareAvailabilityDayWrites(scopedEnv, new Map([[id, { d: day, t: 2, u: 1, w: 0, avg: null, exact: true }]]), Math.floor(clock / 1000));
      await getDB(scopedEnv).commit(writes);
      await upsertDay(scopedEnv, id, { d: day, t: 99, u: 99, w: 0, avg: 9 });
      const row = await getDB(scopedEnv).queryOne('SELECT days_json FROM monitor_uptime WHERE monitor_id=?', [id]);
      return Response.json(JSON.parse(row.days_json).find((entry) => entry.d === day));
    });
  }
  if (url.pathname === '/__redirect') {
    const calls = [];
    globalThis.fetch = async (input, init) => {
      calls.push({ url: String(input), method: init.method, auth: new Headers(init.headers).get('authorization') });
      return calls.length === 1
        ? new Response('', { status: 302, headers: { location: 'https://other.test/next' } })
        : new Response('ok', { status: 200 });
    };
    const budget = new ExternalRequestBudget();
    await budgetedFetch('https://first.test/start', { method: 'POST', headers: { authorization: 'secret', 'content-type': 'application/json' }, body: '{}' }, budget);
    globalThis.fetch = async () => new Response('ok', { status: 200 });
    return Response.json({ calls, remaining: budget.remaining });
  }
  if (url.pathname === '/__notify-budget') {
    let sends = 0;
    globalThis.fetch = async () => { sends++; return new Response('ok', { status: 200 }); };
    const budget = new ExternalRequestBudget();
    for (let i = 0; i < 49; i++) budget.reserve();
    const channel = { id: 'fixture', name: 'fixture', type: 'webhook', config: { url: 'https://notify.test/hook' }, group_ids: [], active: 1, created_at: 0, updated_at: 0 };
    const event = { monitorName: 'fixture', monitorTarget: 'fixture', monitorType: 'http', status: 0, message: 'fixture', at: 0 };
    const first = await sendToChannel(channel, event, 1000, budget);
    const second = await sendToChannel(channel, event, 1000, budget);
    return Response.json({ sends, first, second, remaining: budget.remaining });
  }
  return api.fetch(request, env, ctx);
} };
`;
const bundle = await build({
  stdin: { contents: source, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, format: 'esm', platform: 'neutral', target: 'es2022', write: false, logLevel: 'error',
  plugins: [{ name: 'stubs', setup(builder) {
    builder.onResolve({ filter: /^cloudflare:sockets$/ }, () => ({ path: 'socket-stub', namespace: 'stub' }));
    builder.onResolve({ filter: /^postgres$/ }, () => ({ path: 'postgres-stub', namespace: 'stub' }));
    builder.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({ contents: args.path === 'postgres-stub' ? "export default function postgres() { throw new Error('postgres fixture only'); }" : "export function connect() { throw new Error('socket not used in fixture'); }" }));
  } }],
});
const mf = new Miniflare({
  modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2025-01-01',
  bindings: { ADMIN_TOKEN: adminToken }, d1Databases: { DB: 'isolated-budget-capacity' },
});

function bounded(promise, label, ms = 15_000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`fixture startup timeout: ${label}`)), ms)),
  ]);
}

try {
  console.log('fixture checkpoint: getD1Database');
  const db = await bounded(mf.getD1Database('DB'), 'getD1Database');
  await applyD1Migrations(db);
  const headers = { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' };
  const request = async (path, init = {}) => {
    const response = await mf.dispatchFetch(`http://localhost${path}`, init);
    return { status: response.status, body: await response.json() };
  };
  const now = Math.floor(Date.now() / 60_000) * 60;
  const created = await Promise.all(Array.from({ length: 51 }, (_, i) => request('/api/monitors', {
    method: 'POST', headers,
    body: JSON.stringify({ name: `Budget fixture ${i}`, type: 'http', target: 'https://fixture.test/health', interval_sec: 60 }),
  })));
  assert(created.every((item) => item.status === 201));
  const tick = await request(`/__tick?now=${now}`, { method: 'POST' });
  assert.equal(tick.body.status, 'completed');
  assert(tick.body.usage.binding_requests > 0);
  assert(tick.body.usage.statements > tick.body.usage.binding_requests);
  assert(tick.body.usage.rows_read > 0 && tick.body.usage.rows_written > 50);
  const state = JSON.parse((await db.prepare('SELECT json FROM live_state WHERE id=?').bind('all').first()).json);
  const statuses = Object.values(state);
  assert.equal(statuses.filter((entry) => entry.st === 1).length, 50);
  /* 预算耗尽不能误标为 Agent 检查来源离线。
   * Budget exhaustion must not be reported as an offline Agent source. */
  const skipped = statuses.filter((entry) => entry.msg === 'worker request budget exhausted; not checked this minute');
  assert.equal(skipped.length, 1, 'exactly one monitor reports the Worker budget, by its own message');
  assert.equal(skipped[0].st, 4);
  assert.equal(skipped[0].v, null);
  assert.equal(skipped[0].source_available, undefined, 'a budget skip must not be reported as an unavailable source');
  assert.equal(statuses.filter((entry) => entry.source_available === false).length, 0);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM events WHERE status=0').first()).n, 0);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM heartbeat_ring').first()).n, 50);
  console.log('D1 tick usage:', tick.body.usage.binding_requests, 'binding calls,', tick.body.usage.statements, 'statements,', tick.body.usage.rows_read, 'rows read,', tick.body.usage.rows_written, 'rows written');

  /**
   * The same figures are persisted for the console's usage panel.
   *
   * `recordTickUsage` is fire-and-forget inside `runTick`'s `finally`, so the
   * row is written shortly after the tick returns. The wait is bounded and
   * short: if the row does not appear within it, the accumulation is broken
   * rather than merely slow.
   *
   * 同一组数据为控制台用量面板持久化。recordTickUsage 在 runTick 的 finally 中异步执行，
   * 因此行会在 tick 返回后稍晚写入；等待时间短且有上限，超时说明累积逻辑损坏而非只是慢。
   */
  let usageRow = null;
  for (let i = 0; i < 40 && !usageRow; i++) {
    usageRow = await db.prepare('SELECT * FROM usage_daily').first();
    if (!usageRow) await new Promise((r) => setTimeout(r, 25));
  }
  assert(usageRow !== null, 'usage_daily row was not written');
  assert.equal(usageRow.ticks, 1);
  assert(usageRow.rows_read > 0, 'rows read were not accumulated');
  assert(usageRow.rows_written > 50, 'rows written were not accumulated');
  assert(usageRow.statements > 0, 'statements were not accumulated');
  assert(usageRow.peak_subrequests > 0, 'the subrequest high-water mark was not recorded');

  // The route the console reads is mounted behind the admin gate; this harness
  // uses the bearer token the rest of this file uses.
  // 控制台读取的路由受管理门禁保护；此环境使用本文件其他位置相同的 bearer 令牌。
  const usage = await request('/api/admin/usage', { headers });
  assert.equal(usage.status, 200);
  assert.equal(usage.body.observed, true);
  assert.equal(usage.body.plan, 'free');
  assert(usage.body.d1RowsRead > 0 && usage.body.d1RowsWritten > 50);
  assert.equal(usage.body.ticks, 1);
  assert.equal(usage.body.limits.d1RowsRead, 5_000_000);
  assert.equal(usage.body.limits.subrequests, 50);

  const chunked = await request('/__chunk?count=101');
  assert.equal(chunked.body.size, 0);
  assert.equal(chunked.body.usage.binding_requests, 2);
  assert.equal(chunked.body.usage.statements, 2);
  const exact = await request(`/__exact?id=${created[0].body.id}`);
  assert.deepEqual(exact.body, { d: '2026-10-01', t: 2, u: 1, w: 0, avg: 12, exact: true });

  const redirect = await request('/__redirect');
  assert.deepEqual(redirect.body.calls.map(({ method, auth }) => ({ method, auth })), [
    { method: 'POST', auth: 'secret' },
    { method: 'GET', auth: null },
  ]);
  assert.equal(redirect.body.remaining, 48);
  const notifications = await request('/__notify-budget');
  assert.equal(notifications.body.sends, 1);
  assert.equal(notifications.body.first.ok, true);
  assert.equal(notifications.body.second.error, 'Worker external request budget exhausted');
  assert.equal(notifications.body.remaining, 0);

  const agent = await request('/api/admin/agents', { method: 'POST', headers, body: JSON.stringify({ name: 'Probe agent' }) });
  assert.equal(agent.status, 201);
  await db.prepare('INSERT INTO machine_live (agent_id, version, probe_capabilities, report_interval_secs, reported_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(agent.body.id, '0.3.0', '["probe_http"]', 60, now, now).run();
  const probe = await request('/api/monitors', {
    method: 'POST', headers,
    body: JSON.stringify({ name: 'Delayed probe', type: 'http', target: 'http://lan.test/', interval_sec: 60, options_json: { check_source: { type: 'agent', agent_id: agent.body.id } } }),
  });
  assert.equal(probe.status, 201);
  const delayed = await request(`/__late?monitor=${probe.body.id}&agent=${agent.body.id}&now=${now + 55}`);
  assert.equal(delayed.body.jobs.length, 1);
  assert.equal(delayed.body.jobs[0].monitor_id, probe.body.id);
  const jobId = delayed.body.jobs[0].run_id;
  await db.prepare("UPDATE agent_probe_jobs SET state='completed', completed_at=? WHERE run_id=?").bind(now - 86_401, jobId).run();
  const pruned = await request(`/__prune?now=${now}`);
  assert.equal(pruned.body.count.n, 0);
  /**
   * The same budget skip, but on a monitor that already had a reading.
   *
   * `retryPending`, `readAll` and the lease statements do not go through
   * `fetch`, so the injected capacity error lands on the checks and nowhere
   * else - which is the platform's own delivery path for this condition.
   *
   * 相同的预算跳过，但监控已有读数。retryPending、readAll 和租约语句不经 fetch，
   * 因此注入的容量错误只落在检查上，符合平台传递此错误的路径。
   */
  const preserved = await request(`/__budget-preserve?now=${now + 60}&id=${created[0].body.id}`);
  assert.equal(preserved.body.entry.fails, 2, 'a budget skip must not clear the consecutive-failure counter');
  assert.equal(preserved.body.entry.st, 0, 'a budget skip must not replace the last known status');
  assert.equal(preserved.body.entry.v, 987, 'a budget skip must not discard the last latency reading');
  assert.equal(preserved.body.entry.ts, now, 'a budget skip is not a completed check, so ts stays at the last real run');
  assert.equal(preserved.body.entry.msg, 'prior failure', 'the previous message survives a round that measured nothing');
  assert.notEqual(preserved.body.entry.source_available, false, 'a budget skip is not an unavailable source');

  console.log('PASS: shared 50-request tick cap, unknown budget exhaustion, bounded cross-origin redirects, delayed Agent leases, and unconsumed result TTL');
} finally {
  await bounded(mf.dispose(), 'dispose', 5_000);
}
