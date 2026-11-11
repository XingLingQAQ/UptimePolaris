// 通过 D1 验证探测调度、租约竞争、重复结果与状态更新。
// Use D1 to check probe scheduling, lease races, duplicate results, and status updates.

import { applyD1Migrations } from '../helpers/apply-d1-migrations.mjs';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
/* 先解码分钟标记再比较内容；另行检查编码前缀和长度。
 * Decode minute marks before comparing their values; check the encoding prefix and length separately. */
function decodeMinutes(minutes) {
  if (Array.isArray(minutes)) return minutes;
  assert.equal(typeof minutes, 'string');
  assert.ok(minutes.startsWith('v1:'), `unexpected minute encoding: ${minutes.slice(0, 8)}`);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  assert.equal(minutes.length, 3 + (1440 / 8) * 4);
  const out = [];
  for (let at = 3; at < minutes.length; at += 4) {
    let bits = 0;
    for (let k = 0; k < 4; k++) bits = (bits << 6) | alphabet.indexOf(minutes[at + k]);
    for (let k = 0; k < 8; k++) out.push((bits >>> ((7 - k) * 3)) & 7);
  }
  assert.equal(out.length, 1440);
  return out;
}

const adminToken = 'probe-test-admin';
const harness = `
import { api } from './backends/worker/src/api';
import { runTick } from './backends/worker/src/lib/jobs/tick.ts';
import { pruneAgentProbeJobs } from './backends/worker/src/lib/agent/probes.ts';
import { agentIsOnline, agentStaleAfterSec } from './backends/worker/src/lib/agent/liveness.ts';
import { getDB, withDBScope } from './backends/worker/src/lib/db/factory.ts';
let simulatedNow = Date.now();
Date.now = () => simulatedNow;
function failNextBatch(env) {
  return new Proxy(env, { get(target, key) {
    if (key !== 'DB') return Reflect.get(target, key, target);
    return new Proxy(target.DB, { get(db, property) {
      if (property === 'batch') return async () => { throw new Error('fixture tick batch failure'); };
      return Reflect.get(db, property, db);
    } });
  } });
}
export default { async fetch(request, env, ctx) {
  const url = new URL(request.url);
  if (url.pathname === '/__prune') { simulatedNow = Number(url.searchParams.get('now')) * 1000; await pruneAgentProbeJobs(env, Math.floor(simulatedNow / 1000)); return Response.json({ ok: true }); }
  if (url.pathname === '/__clear-public-monitors') {
    await caches.default.delete(new Request('http://localhost/api/public/monitors?pageId=default'));
    return Response.json({ ok: true });
  }
  if (url.pathname === '/__pg-normalize') return Response.json({ online: agentIsOnline('1790000000', 1790000060, agentStaleAfterSec('60')) });
  if (url.pathname === '/__tick') {
    simulatedNow = Number(url.searchParams.get('now')) * 1000;
    try {
      return await withDBScope(url.searchParams.has('failBatch') ? failNextBatch(env) : env, async (scopedEnv) => {
        await runTick(scopedEnv, Math.floor(simulatedNow / 1000));
        return Response.json({ ok: true, usage: getDB(scopedEnv).getUsage() });
      });
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 500 });
    }
  }
  return api.fetch(request, env, ctx);
} };
`;
const bundled = await build({
  stdin: { contents: harness, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, format: 'esm', platform: 'neutral', target: 'es2022', write: false,
  external: ['cloudflare:sockets'], logLevel: 'error',
  plugins: [{ name: 'stub-postgres', setup(builder) {
    builder.onResolve({ filter: /^postgres$/ }, () => ({ path: 'pg-stub', namespace: 'stub' }));
    builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: "export default function postgres() { throw new Error('postgres unavailable in D1 fixture'); }" }));
  } }],
});
const mf = new Miniflare({
  modules: true, script: bundled.outputFiles[0].text, compatibilityDate: '2025-01-01',
  compatibilityFlags: ['nodejs_compat'],
  bindings: { CF_ACCOUNT_ID: 'isolated', CF_API_TOKEN: 'isolated', ADMIN_TOKEN: adminToken },
  d1Databases: { DB: 'isolated-agent-probes' },
});

try {
  const db = await mf.getD1Database('DB');
  await applyD1Migrations(db);
  const adminHeaders = { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' };
  const request = async (path, init = {}) => {
    const response = await mf.dispatchFetch(`http://localhost${path}`, init);
    let text;
    try { text = await response.text(); }
    catch (error) {
      throw new Error(`fixture response body unreadable for ${path} (status ${response.status}, cache ${response.headers.get('x-public-cache') ?? 'n/a'}): ${String(error)}`);
    }
    let body;
    try { body = JSON.parse(text); }
    catch { throw new Error(`fixture response was not JSON for ${path} (status ${response.status}, cache ${response.headers.get('x-public-cache') ?? 'n/a'}): ${text.slice(0, 240)}`); }
    return { status: response.status, headers: response.headers, body };
  };
  const createAgent = await request('/api/admin/agents', {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ name: 'Probe fixture agent' }),
  });
  assert.equal(createAgent.status, 201);
  const agentId = createAgent.body.id;
  const agentToken = createAgent.body.token;
  const agentMonitor = await request('/api/monitors', { method: 'POST', headers: adminHeaders, body: JSON.stringify({ name: 'Probe fixture agent', type: 'agent', agent_id: agentId }) });
  assert.equal(agentMonitor.status, 201);
  const agentMonitorId = agentMonitor.body.id;
  const frames = [
    { jsonrpc: '2.0', id: 1, method: 'basicReport', params: { kernel: 'fixture-kernel', mem_total: 1024, transport: 'ws',
      name: 'probe-node', os: 'linux', arch: 'x86_64', cpu_model: 'fixture', cpu_cores: 2,
      version: '0.3.0', capabilities: ['probe_http', 'probe_tcp'], report_interval_secs: 60,
    } },
    { jsonrpc: '2.0', id: null, method: 'report', params: { summaries: [], interfaces: null, mounts: null, message: '',
      cpu: { usage: 2 }, ram: { total: 1000, used: 100 }, swap: { total: 0, used: 0 },
      load: { load1: 0, load5: 0, load15: 0 }, disk: { total: 1000, used: 100 },
      network: { up: 0, down: 0, totalUp: 0, totalDown: 0 }, connections: { tcp: 1, udp: 0 },
      uptime: 100, process: 2, observed_at: Math.floor(Date.now() / 1000),
    } },
  ];
  for (const frame of frames) {
    const accepted = await request(`/api/public/agent/push/${agentToken}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(frame) });
    assert.equal(accepted.status, 200);
  }
  const probeSources = await request('/api/agents/probe-sources', { headers: adminHeaders });
  assert.equal(probeSources.status, 200);
  assert.deepEqual(probeSources.body.agents.find((agent) => agent.id === agentId), {
    id: agentId, name: 'Probe fixture agent', active: true, version: '0.3.0', capabilities: ['probe_http', 'probe_tcp'], online: true,
    // Absent in the row's options, which means enabled - an agent enrolled
    // before the switch existed must keep taking jobs.
    // 行选项中缺少此字段表示启用；开关引入前注册的 Agent 仍须接受任务。
    probe_enabled: true,
    // It has reported, so the monitor form may offer it as a probe source.
    // Agent 已上报，监控表单可以将其作为探测来源。
    installed: true,
  });
  const unreadyAgent = await request('/api/admin/agents', {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ name: 'Agent awaiting update' }),
  });
  assert.equal(unreadyAgent.status, 201);
  const unreadySource = await request('/api/monitors', {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ name: 'Unsupported Agent', type: 'tcp', target: '10.0.0.2:80', options_json: { check_source: { type: 'agent', agent_id: unreadyAgent.body.id } } }),
  });
  assert.equal(unreadySource.status, 400);
  assert.equal(unreadySource.body.error, 'agent_probe_capability_required');
  const source = { check_source: { type: 'agent', agent_id: agentId } };
  const createMonitor = await request('/api/monitors', {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ name: 'LAN fixture', type: 'http', target: 'http://fixture.invalid', interval_sec: 60, options_json: source }),
  });
  assert.equal(createMonitor.status, 201);
  for (const addon of ['check_ssl', 'check_domain', 'check_dns']) {
    const rejected = await request('/api/monitors', {
      method: 'POST', headers: adminHeaders,
      body: JSON.stringify({
        name: `Unsupported ${addon}`, type: 'http', target: 'https://fixture.invalid', [addon]: 1,
        options_json: { check_source: { type: 'agent', agent_id: agentId }, ...(addon === 'check_dns' ? { dns: { recordType: 'A' } } : {}) },
      }),
    });
    assert.equal(rejected.status, 400, `${addon} must be rejected for Agent probes`);
    assert.equal(rejected.body.error, 'agent_probe_capability_required');
  }
  const manualTest = await request('/api/monitors/check', {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({
      name: 'Agent manual test', type: 'http', target: 'http://127.0.0.1:1/',
      options_json: { check_source: { type: 'agent', agent_id: agentId } },
    }),
  });
  assert.equal(manualTest.status, 200);
  assert.equal(manualTest.body.status, 2);
  assert.equal(manualTest.body.statusCode, 0);
  assert.match(manualTest.body.message, /agent probe result not available yet|agent source unavailable/);

  /*
   * The probe-node switch.
   *
   * Disabling must refuse new selections and flip the source list; enabling
   * must restore both. The monitors already pointing at the agent are left
   * untouched, so the interesting assertion is that they come back without
   * being rewritten.
   *
   * 探测节点开关：关闭须拒绝新选择并更新来源列表，重新启用须恢复两者。
   * 已指向该 Agent 的监控不应被改写；重要断言是它们无需重写即可恢复。
   */
  const disable = await request(`/api/admin/agents/${agentId}/probe`, {
    method: 'POST', headers: adminHeaders, body: JSON.stringify({ enabled: false }),
  });
  assert.equal(disable.status, 200, `toggle failed: ${JSON.stringify(disable.body)}`);
  assert.equal(disable.body.probe_enabled, false);
  const disabledList = await request('/api/agents/probe-sources', { headers: adminHeaders });
  assert.equal(disabledList.body.agents.find((agent) => agent.id === agentId).probe_enabled, false);
  const refusedSource = await request('/api/monitors', {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ name: 'Refused by switch', type: 'http', target: 'http://refused.invalid', options_json: source }),
  });
  assert.equal(refusedSource.status, 400);
  assert.equal(refusedSource.body.error, 'agent_probe_disabled');

  const enable = await request(`/api/admin/agents/${agentId}/probe`, {
    method: 'POST', headers: adminHeaders, body: JSON.stringify({ enabled: true }),
  });
  assert.equal(enable.status, 200);
  assert.equal(enable.body.probe_enabled, true);
  const enabledList = await request('/api/agents/probe-sources', { headers: adminHeaders });
  assert.equal(enabledList.body.agents.find((agent) => agent.id === agentId).probe_enabled, true);

  const badFlag = await request(`/api/admin/agents/${agentId}/probe`, {
    method: 'POST', headers: adminHeaders, body: JSON.stringify({ enabled: 'yes' }),
  });
  assert.equal(badFlag.status, 400);
  assert.equal(badFlag.body.error, 'invalid_enabled');
  const additionalMonitors = await Promise.all(Array.from({ length: 4 }, (_, index) => request('/api/monitors', {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ name: `LAN fixture ${index}`, type: 'http', target: `http://fixture-${index}.invalid`, interval_sec: 60, options_json: source }),
  })));
  assert(additionalMonitors.every((result) => result.status === 201));
  await db.prepare('UPDATE monitors SET timeout_ms = 60000 WHERE id IN (SELECT id FROM monitors WHERE type = ?)').bind('http').run();

  const now = Math.floor(Date.now() / 60000) * 60;
  const budgetTick = await request(`/__tick?now=${now}`, { method: 'POST', headers: adminHeaders });
  assert.equal(budgetTick.status, 200);
  assert(budgetTick.body.usage.binding_requests <= 50, `Agent probes used ${budgetTick.body.usage.binding_requests} D1 calls`);
  const initialLiveRow = await db.prepare('SELECT json FROM live_state WHERE id = ?').bind('all').first();
  const initialLive = JSON.parse(initialLiveRow.json);
  const noResultMonitor = await db.prepare('SELECT id, num_id FROM monitors WHERE name = ?').bind('LAN fixture').first();
  assert.equal(initialLive[noResultMonitor.id].source_available, false);
  assert.equal(initialLive[noResultMonitor.id].st, 4);
  assert.equal(initialLive[noResultMonitor.id].ts, 0);
  const overview = await request('/api/overview', { headers: adminHeaders });
  const overviewSource = overview.body.monitors.find((monitor) => monitor.id === noResultMonitor.id);
  assert.equal(overviewSource.st, null);
  assert.equal(overviewSource.v, 0);
  assert.equal(overviewSource.source, 'agent');
  assert.equal(overviewSource.source_id, agentId);
  assert.equal(overviewSource.source_name, 'Probe fixture agent');
  assert.equal(overviewSource.source_available, false);
  // The agent is healthy, so this must read as "waiting", not "unavailable".
  // Before `source_pending` existed both cases looked identical, which is what
  // made a freshly added monitor look broken for its first ~90 seconds.
  // Agent 健康，应显示“等待”而非“不可用”。引入 source_pending 前两者相同，
  // 新监控在最初约 90 秒会看起来像故障。
  assert.equal(overviewSource.source_pending, true);
  assert.equal(overviewSource.source_last_observed_at, null);
  const publicStatus = await request('/api/public/status');
  const publicStatusSource = publicStatus.body.monitors.find((monitor) => monitor.id === noResultMonitor.id);
  assert.equal(publicStatusSource.num_id, noResultMonitor.num_id);
  assert.equal(publicStatusSource.st, null);
  assert.equal(publicStatusSource.v, null);
  assert.equal(publicStatusSource.source, 'agent');
  assert.equal('source_id' in publicStatusSource, false);
  assert.equal('source_name' in publicStatusSource, false);
  assert.equal(publicStatusSource.source_available, false);
  assert.equal(publicStatusSource.source_pending, true);
  assert.equal(publicStatusSource.uptime, null);
  const pushFixture = await request('/api/monitors', {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ name: 'Push fixture', type: 'push' }),
  });
  assert.equal(pushFixture.status, 201);
  const publicMonitors = await request('/api/public/monitors');
  const publicCards = publicMonitors.body.monitorGroups.flatMap((group) => group.monitorList ?? []);
  const publicSource = publicCards.find((monitor) => monitor.name === 'LAN fixture');
  assert.equal(publicSource.source, 'agent');
  assert.equal('sourceId' in publicSource, false);
  assert.equal('sourceName' in publicSource, false);
  assert.equal(publicSource.sourceAvailable, false);
  assert.equal(publicCards.find((monitor) => monitor.name === 'Probe fixture agent').source, undefined);
  assert.equal(publicCards.find((monitor) => monitor.name === 'Push fixture').source, undefined);
  const unavailableBeats = publicMonitors.body.data.heartbeatList[String(publicSource.id)] ?? [];
  if (unavailableBeats.length) assert.equal(unavailableBeats.at(-1).ping, null);
  const jobs = await request(`/api/public/agent/jobs/${agentToken}`);
  assert.equal(jobs.status, 200);
  assert.equal(jobs.body.jobs.length, 4);
  assert(jobs.body.jobs.every((job) => job.lease_expires_at - now * 1000 >= job.timeout_ms + 30_000));
  const job = jobs.body.jobs[0];
  const staleJob = jobs.body.jobs[1];
  assert.equal(job.target, 'http://fixture.invalid');
  assert.equal(job.type, 'http');
  assert.equal('agent_token' in job, false);
  const targetChanged = await request(`/api/monitors/${staleJob.monitor_id}`, {
    method: 'PUT', headers: adminHeaders,
    body: JSON.stringify({ target: 'http://changed-target.invalid' }),
  });
  assert.equal(targetChanged.status, 200);

  const competingPolls = await Promise.all([
    request(`/api/public/agent/jobs/${agentToken}`),
    request(`/api/public/agent/jobs/${agentToken}`),
  ]);
  assert(competingPolls.every((result) => result.body.jobs.length <= 4));
  const extraRuns = competingPolls.flatMap((result) => result.body.jobs.map((item) => item.run_id));
  assert.equal(new Set(extraRuns).size, extraRuns.length);
  assert.equal(extraRuns.length, 1);

  const warningJob = competingPolls.flatMap((result) => result.body.jobs)[0];
  const warningSaved = await request(`/api/public/agent/results/${agentToken}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ run_id: warningJob.run_id, lease_token: warningJob.lease_token, observed_at: now, status: 2, status_code: 200, latency_ms: 4000, message: 'slow response' }),
  });
  assert.equal(warningSaved.status, 200);

  const observation = { run_id: job.run_id, lease_token: job.lease_token, observed_at: now, status: 1, status_code: 200, latency_ms: 17.5, message: 'fixture response' };
  const staleResult = await request(`/api/public/agent/results/${agentToken}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...observation, run_id: staleJob.run_id, lease_token: staleJob.lease_token }) });
  assert.equal(staleResult.status, 409);
  const otherAgent = await request(`/api/public/agent/results/${unreadyAgent.body.token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(observation) });
  assert.equal(otherAgent.status, 404);
  const saved = await request(`/api/public/agent/results/${agentToken}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(observation) });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body, { ok: true, duplicate: false });
  const replay = await request(`/api/public/agent/results/${agentToken}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(observation) });
  assert.deepEqual(replay.body, { ok: true, duplicate: true });

  const tickFailure = await request(`/__tick?now=${now + 60}&failBatch=1`, { method: 'POST', headers: adminHeaders });
  assert.equal(tickFailure.status, 500);
  const unconsumed = await db.prepare('SELECT consumed_at FROM agent_probe_jobs WHERE run_id = ?').bind(job.run_id).first();
  assert.equal(unconsumed.consumed_at, null);
  const beforeCommitLive = JSON.parse((await db.prepare('SELECT json FROM live_state WHERE id = ?').bind('all').first()).json);
  assert.equal(beforeCommitLive[job.monitor_id].source_run_id, undefined);
  assert.equal(await db.prepare('SELECT id FROM heartbeat_ring WHERE id = ?').bind(job.monitor_id).first(), null);

  await request(`/__tick?now=${now + 60}`, { method: 'POST', headers: adminHeaders });
  const live = await db.prepare('SELECT json FROM live_state WHERE id = ?').bind('all').first();
  const state = JSON.parse(live.json);
  assert.equal(state[job.monitor_id].st, 1);
  assert.equal(state[warningJob.monitor_id].st, 2);
  assert.equal(state[warningJob.monitor_id].fails, 0);
  assert.equal(state[job.monitor_id].v, 17.5);
  assert.equal(state[job.monitor_id].msg, 'fixture response');
  assert.equal(decodeMinutes(state[job.monitor_id].availability.minutes)[Math.floor((now + 60) / 60) % 1440], 2);
  const consumed = await db.prepare('SELECT consumed_at FROM agent_probe_jobs WHERE run_id = ?').bind(job.run_id).first();
  assert.equal(typeof consumed.consumed_at, 'number');

  /*
    What the agent detail dialog renders.

    `probe_targets` is derived from `options_json`, and `probe_jobs` is a read of
    the same table the scheduler writes - so this asserts the join between the
    two halves of the feature, not a formatting detail.

    Agent 详情弹窗展示的数据：probe_targets 来自 options_json，probe_jobs 读取调度器写入的
    同一张表；此断言验证两部分的关联，而非格式细节。
  */
  const agentDetail = await request(`/api/admin/agents/${agentId}/detail`, { headers: adminHeaders });
  assert.equal(agentDetail.status, 200);
  const targetNames = agentDetail.body.probe_targets.map((entry) => entry.name).sort();
  assert.deepEqual(targetNames, ['LAN fixture', 'LAN fixture 0', 'LAN fixture 1', 'LAN fixture 2', 'LAN fixture 3'].sort());
  assert(agentDetail.body.probe_targets.every((entry) => entry.type === 'http' && entry.interval_sec === 60));
  assert(agentDetail.body.probe_jobs.length > 0);
  const completedJob = agentDetail.body.probe_jobs.find((row) => row.run_id === job.run_id);
  assert.equal(completedJob.state, 'completed');
  assert.equal(completedJob.status, 1);
  assert.equal(completedJob.latency_ms, 17.5);
  assert.equal(completedJob.monitor_name, 'LAN fixture');
  const fleetAfterProbes = await request('/api/admin/agents', { headers: adminHeaders });
  assert.equal(fleetAfterProbes.body.agents.find((row) => row.id === agentId).probe_target_count, 5);

  const agentBeforeRollover = JSON.parse((await db.prepare('SELECT json FROM live_state WHERE id = ?').bind('all').first()).json);
  const previousDay = new Date((now + 120) * 1000 - 86400_000).toISOString().slice(0, 10);
  agentBeforeRollover[agentMonitorId].availability.daily = [previousDay, 3, 2, 0];
  await db.prepare('UPDATE live_state SET json = ? WHERE id = ?').bind(JSON.stringify(agentBeforeRollover), 'all').run();

  await request(`/__tick?now=${now + 120}`, { method: 'POST', headers: adminHeaders });
  const unavailableState = JSON.parse((await db.prepare('SELECT json FROM live_state WHERE id = ?').bind('all').first()).json);
  assert.equal(unavailableState[job.monitor_id].source_available, false);
  assert.equal(unavailableState[job.monitor_id].st, 4);
  assert.equal(unavailableState[job.monitor_id].ts, 0);
  assert.equal(unavailableState[job.monitor_id].source_run_id, job.run_id);
  assert.deepEqual(decodeMinutes(unavailableState[job.monitor_id].availability.minutes), decodeMinutes(state[job.monitor_id].availability.minutes));
  const uptimeRow = await db.prepare('SELECT days_json FROM monitor_uptime WHERE monitor_id = ?').bind(agentMonitorId).first();
  assert(JSON.parse(uptimeRow.days_json).some((day) => day.d === previousDay && day.t === 3 && day.u === 2 && day.avg === null));
  await request('/__clear-public-monitors');
  const unavailableMonitors = await request('/api/public/monitors');
  const unavailableCard = unavailableMonitors.body.monitorGroups.flatMap((group) => group.monitorList ?? []).find((monitor) => monitor.name === 'LAN fixture');
  assert.equal(unavailableCard.sourceAvailable, false);
  assert.equal(unavailableCard.sourcePending, false);
  await request(`/api/admin/agents/${agentId}/probe`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ enabled: false }) });
  const disabledOverview = await request('/api/overview', { headers: adminHeaders });
  const disabledMonitor = disabledOverview.body.monitors.find((monitor) => monitor.id === job.monitor_id);
  assert.equal(disabledMonitor.source_available, false);
  assert.equal(disabledMonitor.source_pending, false);
  const disabledPublic = await request('/api/public/monitors', { headers: adminHeaders });
  const disabledCard = disabledPublic.body.monitorGroups.flatMap((group) => group.monitorList).find((monitor) => monitor.id === unavailableCard.id);
  assert.equal(disabledCard.sourceAvailable, false);
  assert.equal(disabledCard.sourcePending, false);
  await request(`/api/admin/agents/${agentId}/probe`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ enabled: true }) });
  assert.equal(unavailableMonitors.body.data.uptimeList[`${unavailableCard.id}_24`], 1);
  assert.equal(unavailableMonitors.body.data.uptimeCoverage[`${unavailableCard.id}_24`], 1 / 1440);
  const unavailableBeatsAfterUp = unavailableMonitors.body.data.heartbeatList[String(unavailableCard.id)] ?? [];
  assert.ok(unavailableBeatsAfterUp.length > 0);
  assert.equal(unavailableBeatsAfterUp.at(-1).ping, null);
  assert.equal(unavailableBeatsAfterUp.at(-1).status, 4);
  assert.equal(unavailableState[staleJob.monitor_id].source_available, false);
  assert.equal(unavailableState[staleJob.monitor_id].st, 4);
  assert.equal(unavailableState[staleJob.monitor_id].ts, 0);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM events WHERE monitor_id = ? AND status = 0').bind(job.monitor_id).first()).n, 0);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM monitor_uptime WHERE monitor_id = ?').bind(job.monitor_id).first()).n, 0);
  const afterExpiredLeaseTick = await request(`/api/public/agent/jobs/${agentToken}`);
  assert(afterExpiredLeaseTick.body.jobs.length <= 4);
  assert.equal(new Set(afterExpiredLeaseTick.body.jobs.map((entry) => entry.run_id)).size, afterExpiredLeaseTick.body.jobs.length);
  assert(afterExpiredLeaseTick.body.jobs.every((entry) => entry.run_id !== job.run_id && entry.run_id !== staleJob.run_id));
  assert(afterExpiredLeaseTick.body.jobs.every((entry) => entry.lease_expires_at > (now + 120) * 1000));

  await request(`/__prune?now=${now + 90000}`);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM agent_probe_jobs').first()).n, 0);
  await db.prepare('UPDATE machine_live SET reported_at = ? WHERE agent_id = ?').bind(now + 90060, agentId).run();
  await request(`/__tick?now=${now + 90060}`, { method: 'POST', headers: adminHeaders });
  await db.prepare('UPDATE machine_live SET reported_at = ? WHERE agent_id = ?').bind(now + 90060 - 1000, agentId).run();
  await request(`/__tick?now=${now + 90120}`, { method: 'POST', headers: adminHeaders });
  const offlineAgent = JSON.parse((await db.prepare('SELECT json FROM live_state WHERE id = ?').bind('all').first()).json);
  assert.equal(offlineAgent[agentMonitorId].st, 0);
  await request('/__clear-public-monitors');
  const offlineAgentCardData = await request('/api/public/monitors');
  const offlineAgentCard = offlineAgentCardData.body.monitorGroups.flatMap((group) => group.monitorList ?? []).find((monitor) => monitor.name === 'Probe fixture agent');
  const offlineAgentBeat = offlineAgentCardData.body.data.heartbeatList[String(offlineAgentCard.id)].at(-1);
  assert.equal(offlineAgentBeat.status, 0);
  assert.equal(offlineAgentBeat.ping, null);
  await request(`/api/admin/agents/${agentId}/active`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ active: false }) });
  await request(`/__tick?now=${now + 90120}`, { method: 'POST', headers: adminHeaders });
  let unavailable = JSON.parse((await db.prepare('SELECT json FROM live_state WHERE id = ?').bind('all').first()).json);
  assert.equal(unavailable[job.monitor_id].source_available, false);
  /*
    The counterpart to `source_pending: true` above: a paused agent is a real
    outage, so it must NOT read as "waiting". These two assertions are what
    keep the distinction honest - if the flag ever collapsed into "no reading",
    this side would still pass while the other silently regressed.

    与上方 source_pending: true 对应：暂停的 Agent 确实不可用，不能显示“等待”。
    两组断言共同保留区别；若标志退化为“无读数”，本侧仍可能通过而另一侧静默回归。
  */
  {
    const pausedSource = (await request('/api/overview', { headers: adminHeaders })).body.monitors
      .find((monitor) => monitor.id === job.monitor_id);
    assert.equal(pausedSource.source_available, false);
    assert.equal(pausedSource.source_pending, false);
  }
  await request(`/api/admin/agents/${agentId}/active`, { method: 'PUT', headers: adminHeaders, body: JSON.stringify({ active: true }) });
  await db.prepare('UPDATE machine_live SET probe_capabilities = ?, reported_at = ? WHERE agent_id = ?').bind('[]', now + 90120, agentId).run();
  await request(`/__tick?now=${now + 90180}`, { method: 'POST', headers: adminHeaders });
  unavailable = JSON.parse((await db.prepare('SELECT json FROM live_state WHERE id = ?').bind('all').first()).json);
  assert.equal(unavailable[job.monitor_id].source_available, false);
  await db.prepare('UPDATE machine_live SET version = ?, reported_at = ? WHERE agent_id = ?').bind('["probe_http","probe_tcp"]', now + 89680, agentId).run();
  await request(`/__tick?now=${now + 90240}`, { method: 'POST', headers: adminHeaders });
  unavailable = JSON.parse((await db.prepare('SELECT json FROM live_state WHERE id = ?').bind('all').first()).json);
  assert.equal(unavailable[job.monitor_id].source_available, false);
  await db.prepare('UPDATE machine_live SET reported_at = ? WHERE agent_id = ?').bind(now + 90240, agentId).run();
  const inUse = await request(`/api/admin/agents/${agentId}`, { method: 'DELETE', headers: adminHeaders });
  assert.equal(inUse.status, 409);
  await request(`/api/admin/agents/${agentId}/active`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ active: false }) });
  const preservedEdit = await request(`/api/monitors/${job.monitor_id}`, {
    method: 'PUT', headers: adminHeaders,
    body: JSON.stringify({ name: 'Preserved unavailable source' }),
  });
  assert.equal(preservedEdit.status, 200);
  const preservedRow = await db.prepare('SELECT options_json FROM monitors WHERE id = ?').bind(job.monitor_id).first();
  assert.deepEqual(JSON.parse(preservedRow.options_json).check_source, { type: 'agent', agent_id: agentId });
  const unavailableManualTest = await request('/api/monitors/check', {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ name: 'Removed agent test', type: 'http', target: 'http://127.0.0.1:1/', options_json: { check_source: { type: 'agent', agent_id: agentId } } }),
  });
  assert.equal(unavailableManualTest.status, 200);
  assert.equal(unavailableManualTest.body.status, 2);
  assert.equal(unavailableManualTest.body.statusCode, 0);
  assert.equal(unavailableManualTest.body.message, 'agent source unavailable');
  await request(`/__tick?now=${now + 90300}`, { method: 'POST', headers: adminHeaders });
  unavailable = JSON.parse((await db.prepare('SELECT json FROM live_state WHERE id = ?').bind('all').first()).json);
  assert.equal(unavailable[job.monitor_id].source_available, false);

  const staleCreate = await request('/api/monitors', {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ name: 'Unsupported source', type: 'tcp', target: '10.0.0.2:80', options_json: { check_source: { type: 'agent', agent_id: '00000000-0000-4000-8000-000000000000' } } }),
  });
  assert.equal(staleCreate.status, 400);
  assert.equal(staleCreate.body.error, 'agent_probe_capability_required');

  const jobsCount = await db.prepare('SELECT COUNT(*) AS n FROM agent_probe_jobs').first();
  assert.equal(jobsCount.n, 0);
  const pgNormalization = await request('/__pg-normalize');
  assert.equal(pgNormalization.body.online, true);
  console.log('Agent probe jobs: isolated D1 schedule, lease race, idempotent result, and cron pipeline passed.');
} finally {
  await mf.dispose();
}
