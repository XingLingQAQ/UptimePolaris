import { applyD1Migrations } from '../helpers/apply-d1-migrations.mjs';
/* 通过实际 API 和 D1 验证立即检查的拒绝条件、持久化及维护期通知抑制。
 * Use the API and D1 to check on-demand check refusals, persistence, and notification suppression during maintenance. */
import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import { build } from 'esbuild';
import { readFileSync, readdirSync } from 'node:fs';

const ADMIN_TOKEN = 'monitor-check-token';

const HARNESS = `
import { api } from './backends/worker/src/api';
import { runTick } from './backends/worker/src/lib/jobs/tick.ts';
import { D1Adapter } from './backends/worker/src/lib/db/d1.ts';

/**
 * The injected transport.
 *
 * Every check goes through the global fetch - the target request, the redirects
 * behind it and the DoH lookups the add-ons would run. Replacing it here is what
 * keeps the file deterministic: this machine sits behind a proxy in TUN/fake-IP
 * mode, so a real request to example.com measures the proxy, not the code.
 *
 * \`hits\` is the record of what was asked for, which is how "the interval was not
 * consulted" is asserted as an observable fact rather than as a promise.
 *
 * 注入的传输：目标请求、重定向及附加检查可能执行的 DoH 查询均经过全局 fetch。
 * 替换后测试可重复；此机器位于 TUN/fake-IP 代理后，实际请求 example.com 测量的是代理而非代码。
 * hits 记录请求，以可观察事实断言检查未参考间隔，而非只依赖承诺。
 */
let hits = 0;
let plan = null;
let clock = null;
const realNow = Date.now;
Date.now = () => clock ?? realNow();
let paired = false;
let pairReads = 0;
let pairGate;
let releasePair;
let heldProbe;
const queryOne = D1Adapter.prototype.queryOne;
D1Adapter.prototype.queryOne = async function(sql, params) {
  const result = await queryOne.call(this, sql, params);
  if (paired && sql === 'SELECT json FROM live_state WHERE id = ?') {
    pairReads++;
    if (pairReads === 2) { paired = false; releasePair(); }
    await pairGate;
  }
  return result;
};
globalThis.fetch = async (url, init) => {
  hits++;
  const target = String(url);
  if (heldProbe && target.includes('/lifecycle')) {
    heldProbe.started();
    await heldProbe.wait;
    return new Response('healthy');
  }
  if (plan === 'slow') { await new Promise((resolve) => setTimeout(resolve, 10)); return new Response('healthy', { status: 200 }); }
  if (plan === 'ok') return new Response('healthy', { status: 200 });
  if (plan === 'down') return new Response('boom', { status: 500 });
  if (plan === 'hang') return new Promise(() => {});
  // The DoH resolver the DNS add-on would use. No monitor here enables it, but a
  // route that accidentally ran an add-on would reach this branch and the URL in
  // the message says so.
  // DNS 附加检查使用的 DoH 解析器。本文件没有监控启用它；若路由误运行附加检查，
  // 会进入此分支，消息中的 URL 能指出问题。
  throw new Error('unexpected request: ' + target);
};

export default {
  async fetch(req, env, ctx) {
    const p = new URL(req.url).pathname;
    const json = (o) => Response.json(o);

    if (p === '/__clock') {
      clock = Date.parse(new URL(req.url).searchParams.get('at'));
      return json({ now: clock });
    }
    if (p === '/__tick') return json(await runTick(env, Math.floor(Date.now() / 1000)));
    if (p === '/__lifecycle') {
      const params = new URL(req.url).searchParams;
      const id = params.get('id');
      let started, release;
      const ready = new Promise((resolve) => { started = resolve; });
      heldProbe = { started, wait: new Promise((resolve) => { release = resolve; }) };
      const checking = api.fetch(new Request('http://localhost/api/monitors/' + id + '/check', {
        method: 'POST', headers: { authorization: 'Bearer ' + env.ADMIN_TOKEN },
      }), env, ctx);
      await ready;
      const mode = params.get('mode');
      const changed = await api.fetch(new Request('http://localhost/api/monitors/' + id, {
        method: mode === 'delete' ? 'DELETE' : 'PUT',
        headers: { authorization: 'Bearer ' + env.ADMIN_TOKEN, 'content-type': 'application/json' },
        ...(mode === 'delete' ? {} : { body: JSON.stringify(mode === 'pause' ? { active: 0 } : { target: 'https://example.test/changed' }) }),
      }), env, ctx);
      release();
      const response = await checking;
      heldProbe = null;
      return json({ mutation: changed.status, check: response.status, body: await response.json() });
    }
    if (p === '/__pair') {
      paired = true;
      pairReads = 0;
      pairGate = new Promise((resolve) => { releasePair = resolve; });
      const ids = new URL(req.url).searchParams.get('ids').split(',');
      const responses = await Promise.all(ids.map((id) => api.fetch(new Request('http://localhost/api/monitors/' + id + '/check', {
        method: 'POST', headers: { authorization: 'Bearer ' + env.ADMIN_TOKEN },
      }), env, ctx)));
      return json({ readings: await Promise.all(responses.map((response) => response.json())), reads: pairReads });
    }

    if (p === '/__plan') {
      plan = new URL(req.url).searchParams.get('mode');
      hits = 0;
      return json({ ok: true, plan });
    }
    if (p === '/__hits') return json({ hits });

    return api.fetch(req, env, ctx);
  },
};
`;

async function harness() {
  const built = await build({
    stdin: { contents: HARNESS, resolveDir: process.cwd(), loader: 'ts' },
    bundle: true,
    format: 'esm',
    write: false,
    target: 'es2022',
    logLevel: 'error',
    plugins: [
      {
        name: 'stub-workers-modules',
        setup(b) {
          // The transport is the global fetch; sockets are only reached by tcp
          // and ssl checks, and no monitor in this file uses either.
          // 传输使用全局 fetch；只有 TCP 和 SSL 检查会访问 socket，本文件没有监控使用它们。
          b.onResolve({ filter: /^cloudflare:sockets$/ }, () => ({ path: 'sockets', namespace: 'stub' }));
          b.onResolve({ filter: /^postgres$/ }, () => ({ path: 'postgres-stub', namespace: 'pgstub' }));
          b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
            contents: 'export const connect = () => { throw new Error("sockets are stubbed in this test bundle"); };',
          }));
          b.onLoad({ filter: /.*/, namespace: 'pgstub' }, () => ({
            contents: 'export default function postgres() { throw new Error("postgres is stubbed in this test bundle"); }',
          }));
        },
      },
    ],
  });

  const mf = new Miniflare({
    modules: true,
    script: built.outputFiles[0].text,
    compatibilityDate: '2025-01-01',
    bindings: { ADMIN_TOKEN },
    d1Databases: { DB: 'monitor-check-test' },
    // Analytics Engine has no local emulation; the binding only needs to accept
    // writeDataPoint(), and the manual-check path calls it best-effort.
    // Analytics Engine 无本地模拟；绑定只需接受 writeDataPoint()，手动检查路径尽力调用它。
    analyticsEngineDatasets: { UPTIME: { dataset: 'uptime_heartbeats' } },
  });

  const db = await mf.getD1Database('DB');
  await applyD1Migrations(db);
  return { mf, db };
}

const { mf, db } = await harness();
const origin = 'http://localhost';

let pass = 0;
let fail = 0;

function check(label, cond, detail) {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${JSON.stringify(detail)}`);
}

async function req(path, init) {
  const res = await mf.dispatchFetch(origin + path, init);
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, json: body };
}

const authed = { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' };

/** Set the fake transport's next answer. / 设置模拟传输的下一次响应。 */
async function plan(mode) {
  await mf.dispatchFetch(`${origin}/__plan?mode=${mode}`);
}

async function hits() {
  return (await (await mf.dispatchFetch(`${origin}/__hits`)).json()).hits;
}

const now = Math.floor(Date.now() / 1000);

/** Insert a monitor directly: the route under test reads rows, it does not create them. / 直接插入监控；被测路由读取而非创建数据行。 */
async function seedMonitor(id, over) {
  const row = Object.assign({
    id,
    name: id,
    type: 'http',
    target: 'https://example.test/health',
    method: 'GET',
    expected_status: '200-299',
    keyword: null,
    interval_sec: 3600,
    timeout_ms: 2000,
    warn_days: 14,
    check_ssl: 0,
    check_domain: 0,
    check_dns: 0,
    options_json: '{}',
    push_token: null,
    agent_id: null,
    group_id: null,
    active: 1,
    created_at: now,
    updated_at: now,
  }, over);
  await db.prepare(
    `INSERT INTO monitors (id, name, type, target, method, expected_status, keyword,
       interval_sec, timeout_ms, warn_days, check_ssl, check_domain, check_dns,
       options_json, push_token, agent_id, group_id, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    row.id, row.name, row.type, row.target, row.method, row.expected_status, row.keyword,
    row.interval_sec, row.timeout_ms, row.warn_days, row.check_ssl, row.check_domain, row.check_dns,
    row.options_json, row.push_token, row.agent_id, row.group_id, row.active, row.created_at, row.updated_at,
  ).run();
}

async function liveEntry(id) {
  const row = await db.prepare("SELECT json FROM live_state WHERE id = 'all'").first();
  if (!row) return undefined;
  return JSON.parse(row.json)[id];
}

async function ringFor(id) {
  const row = await db.prepare('SELECT json FROM heartbeat_ring WHERE id = ?').bind(id).first();
  return row ? JSON.parse(row.json) : [];
}

async function eventsFor(id) {
  return (await db.prepare('SELECT status, message FROM events WHERE monitor_id = ? ORDER BY created_at').bind(id).all()).results;
}

async function count(sql, ...params) {
  const row = await db.prepare(sql).bind(...params).first();
  return row.n;
}

// ---------------------------------------------------------------- 404
// 未找到 / Not found

console.log('\n404: an unknown id is refused, and nothing is written');
{
  await plan('ok');
  const before = await count("SELECT COUNT(*) AS n FROM live_state");
  const r = await req('/api/monitors/no-such-monitor/check', { method: 'POST', headers: authed });
  check('unknown id is 404', r.status === 404, r);
  check('and uses the not_found code', r.json?.error === 'not_found', r.json);
  check('no live_state row was created', await count("SELECT COUNT(*) AS n FROM live_state") === before);
  check('and no check was run', await hits() === 0);
}

// ---------------------------------------------------------------- paused
// 已暂停 / Paused

console.log('\n409: a paused monitor is refused rather than silently checked');
{
  const id = 'paused-monitor';
  await seedMonitor(id, { active: 0, name: 'paused monitor' });
  await plan('ok');
  const r = await req(`/api/monitors/${id}/check`, { method: 'POST', headers: authed });
  check('paused monitor is 409', r.status === 409, r);
  check('with a stable code the console can branch on', r.json?.error === 'monitor_paused', r.json);
  check('the transport was never called', await hits() === 0);
  check('and live_state is untouched', (await liveEntry(id)) === undefined);
}

// ---------------------------------------------------------------- push / agent
// Push 与 Agent / Push and Agent

console.log('\n409: types with nothing to probe are refused, not fabricated');
{
  await seedMonitor('push-monitor', { type: 'push', target: '', push_token: 'push-secret' });
  await db.prepare("INSERT INTO agents(id,name,token,created_at,updated_at) VALUES('agent-secret','Machine','secret',1,1)").run();
  await seedMonitor('agent-monitor', { type: 'agent', target: '', agent_id: 'agent-secret' });
  await seedMonitor('agent-sourced', {
    type: 'http',
    options_json: JSON.stringify({ check_source: { type: 'agent', agent_id: '00000000-0000-4000-8000-000000000001' } }),
  });
  await plan('ok');

  const push = await req('/api/monitors/push-monitor/check', { method: 'POST', headers: authed });
  check('push is 409', push.status === 409, push);
  check('with push_not_probeable', push.json?.error === 'push_not_probeable', push.json);
  check('push wrote no reading', (await liveEntry('push-monitor')) === undefined);

  const agent = await req('/api/monitors/agent-monitor/check', { method: 'POST', headers: authed });
  check('agent is 409', agent.status === 409, agent);
  check('with agent_not_probeable', agent.json?.error === 'agent_not_probeable', agent.json);
  check('agent wrote no reading', (await liveEntry('agent-monitor')) === undefined);

  /**
   * An http row whose check_source is an agent: the probe belongs to the agent,
   * on its own schedule. Running it from the Worker would bypass the source the
   * operator chose and duplicate a probe the agent is already doing.
   * HTTP 行的 check_source 指向 Agent：探测由 Agent 按自己的计划执行。
   * Worker 若自行执行，会绕过操作员选择的来源并重复 Agent 已在做的探测。
   */
  const sourced = await req('/api/monitors/agent-sourced/check', { method: 'POST', headers: authed });
  check('agent-sourced http is 409', sourced.status === 409, sourced);
  check('with agent_source_not_probeable', sourced.json?.error === 'agent_source_not_probeable', sourced.json);

  check('none of the three reached the transport', await hits() === 0);
}

// ---------------------------------------------------------------- success
// 成功 / Success

console.log('\npersistence: a successful check writes what a tick writes');
{
  const id = 'healthy-monitor';
  await seedMonitor(id, { name: 'healthy', interval_sec: 3600 });
  await plan('ok');

  const r = await req(`/api/monitors/${id}/check`, { method: 'POST', headers: authed });
  check('the check succeeds', r.status === 200, r);
  check('ok:true', r.json?.ok === true, r.json);
  check('the monitor id is echoed', r.json?.monitor_id === id, r.json);
  check('the persisted badge is UP', r.json?.status === 1, r.json);
  check('the primary verdict is reported alongside', r.json?.primary?.status === 1, r.json);
  check('latency is a number', typeof r.json?.latencyMs === 'number' && r.json.latencyMs >= 0, r.json);
  check('the message is carried', typeof r.json?.message === 'string', r.json);

  const entry = await liveEntry(id);
  check('live_state carries the reading', entry?.st === 1, entry);
  check('live_state records when it ran', typeof entry?.ts === 'number' && entry.ts > 0, entry);
  check('live_state keeps a stable status for the retry logic', entry?.stable_st === 1, entry);

  const ring = await ringFor(id);
  check('the heartbeat ring got a point', ring.length === 1, ring);
  check('the ring point records the real status', ring[0]?.up === 1, ring[0]);
  check('the ring point plots the latency', typeof ring[0]?.ms === 'number', ring[0]);

  const availability = entry?.availability;
  check('the availability window was opened', Boolean(availability), availability);
  check('with one observed minute', availability?.endMinute === Math.floor(r.json.checked_at / 60), availability);
  const packed = typeof availability?.minutes === 'string' && availability.minutes.startsWith('v1:');
  check('stored in the packed window format', packed, typeof availability?.minutes);

  /**
   * A first-ever reading is not a transition, so no event row. That matches the
   * tick: announcing every monitor as UP on its first sighting would bury real
   * transitions in noise.
   * 首次读数不是状态转换，因此不产生事件行，与 tick 一致；首次看到每个监控都公告 UP 会淹没真实转换。
   */
  check('a first reading writes no event', (await eventsFor(id)).length === 0);

  /**
   * The interval is 3600s and the monitor was just checked. A due-filter check
   * would refuse; "check now" must not, which the second call proves.
   * 间隔为 3600 秒且刚检查过；按到期时间过滤会拒绝，但“立即检查”不能拒绝，第二次调用验证这一点。
   */
  await plan('ok');
  const second = await req(`/api/monitors/${id}/check`, { method: 'POST', headers: authed });
  check('a second check runs despite the 3600s interval', second.status === 200, second);
  check('and it really probed', await hits() === 1);
  const afterSecond = await liveEntry(id);
  check('the second reading replaced the first', afterSecond?.ts >= r.json.checked_at, afterSecond);
  /**
   * The ring is keyed by the check's own timestamp, so a second check in the
   * same second replaces the first point and one in a later second appends -
   * both are the tick's behaviour (`buildReading` stamps `t: nowSec`). What
   * matters here is that the newest point is the second check's, not that the
   * ring stayed at one entry.
   * 环按检查自身时间戳索引：同一秒第二次检查替换首个点，后续秒则追加；与 tick 的
   * buildReading 使用 t: nowSec 一致。此处关键是最新点属于第二次检查，而非环始终只有一个条目。
   */
  const ringAfter = await ringFor(id);
  check(
    'the newest ring point is the second check',
    ringAfter.at(-1)?.t === second.json.checked_at,
    { ring: ringAfter, second: second.json.checked_at },
  );

  /**
   * `/api/overview` is the console's single round trip. It must reflect the
   * reading without any cache-busting query, which is what `invalidateLive`
   * inside the check path is for.
   * /api/overview 是控制台单次往返接口，无需缓存破坏查询参数也必须反映读数；
   * 检查路径中的 invalidateLive 即为此目的。
   */
  const overview = await req('/api/overview', { headers: authed });
  const row = overview.json?.monitors?.find((m) => m.id === id);
  check('overview shows the new status', row?.st === 1, row);
  // The second check's latency, not the first's: the overview reads what the
  // latest write put there.
  // 显示第二次检查而非第一次的延迟：overview 读取最新写入。
  check('overview shows the latest latency', row?.v === second.json.latencyMs, { row: row?.v, latest: second.json.latencyMs });
  check('overview counts it as up', overview.json?.counts?.up >= 1, overview.json?.counts);
}

// ---------------------------------------------------------------- transition
// 状态转换 / Transition

console.log('\ntransition: a changed badge writes an event and queues an alert');
{
  const id = 'flipping-monitor';
  await seedMonitor(id, { name: 'flipping' });
  /**
   * A previous reading two failures into the retry budget, so this check is the
   * one that settles to DOWN. A first failure would land as PENDING (4), and
   * PENDING transitions deliberately do not notify - which would make the alert
   * assertion below pass for the wrong reason.
   * 先前读数已消耗两次失败预算，因此本次检查确定为 DOWN。首次失败为 PENDING (4)，
   * PENDING 转换有意不通知，否则下方告警断言会因错误原因通过。
   */
  await db.prepare("UPDATE live_state SET json = ?, updated_at = ? WHERE id = 'all'")
    .bind(JSON.stringify({ [id]: { st: 4, ts: now - 60, v: 10, code: 200, msg: '', fails: 2, stable_st: 1 } }), now - 60)
    .run();
  await db.prepare(
    "INSERT INTO notifications (id, name, type, config_json, active, created_at, updated_at) VALUES (?, ?, 'webhook', ?, 1, ?, ?)",
  ).bind('check-hook', 'check hook', JSON.stringify({ url: 'https://hooks.example.test/check' }), now, now).run();

  await plan('down');
  const r = await req(`/api/monitors/${id}/check`, { method: 'POST', headers: authed });
  check('a failing check still succeeds as a request', r.status === 200, r);
  /**
   * The third consecutive failure settles to DOWN, the same rule `buildReading`
   * applies to a scheduled check - this is the "retry budget spent" transition.
   * 连续第三次失败确定为 DOWN，与 buildReading 对定时检查的规则一致，即“重试预算耗尽”的转换。
   */
  check('the persisted badge settles to DOWN', r.json?.status === 0, r.json);
  check('the raw verdict is DOWN too', r.json?.primary?.status === 0, r.json);
  check('a transition was reported', r.json?.event === true, r.json);
  check('and an alert was queued', r.json?.notified === true, r.json);

  const events = await eventsFor(id);
  check('the event log has the transition', events.length === 1, events);
  check('with the settled DOWN status', events[0]?.status === 0, events[0]);
  check(
    'the outbox holds one row for the unscoped channel',
    await count("SELECT COUNT(*) AS n FROM pending_notifications WHERE event_id LIKE ?", `${id}:%`) === 1,
  );
}

// ---------------------------------------------------------------- maintenance
// 维护窗口 / Maintenance

console.log('\nmaintenance: the alert is held, the reading is still written');
{
  const id = 'window-monitor';
  await seedMonitor(id, { name: 'window' });
  // Two failures already spent, so this check settles to DOWN and *would* page.
  // 已消耗两次失败预算，本次会确定为 DOWN，原本应发出告警。
  await db.prepare("UPDATE live_state SET json = ?, updated_at = ? WHERE id = 'all'")
    .bind(JSON.stringify({ [id]: { st: 4, ts: now - 60, v: 10, code: 200, msg: '', fails: 2, stable_st: 1 } }), now - 60)
    .run();

  /* 通过设置 API 清除缓存；每日窗口在 UTC 23:59 的边界单独处理。
   * Write through the settings API to clear its cache; handle the UTC 23:59 window boundary separately. */
  const nowMinutes = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
  if (nowMinutes === 23 * 60 + 59) {
    console.log('  SKIP  the run landed in 23:59 UTC, the one minute a 00:00-23:59 window excludes');
  } else {
    const window = { kind: 'weekly', day: new Date().getUTCDay(), start: '00:00', end: '23:59' };
    const saved = await req('/api/admin/settings', {
      method: 'PUT',
      headers: authed,
      body: JSON.stringify({ 'maintenance.scheduleEnabled': true, 'alerts.maintenanceWindows': [window] }),
    });
    check('the maintenance window was stored', saved.status === 200, saved);

    try {
      await plan('down');
      const r = await req(`/api/monitors/${id}/check`, { method: 'POST', headers: authed });
      check('the check still runs inside the window', r.status === 200, r);
      check('and reports the window held the alert', r.json?.maintenance === true, r.json);
      check('nothing was queued', r.json?.notified === false, r.json);

      const entry = await liveEntry(id);
      check('live_state still carries the failing reading', entry?.st === 0, entry);
      const events = await eventsFor(id);
      check('the transition is still in the event log', events.length === 1, events);
      check(
        'but the outbox is empty',
        await count("SELECT COUNT(*) AS n FROM pending_notifications WHERE event_id LIKE ?", `${id}:%`) === 0,
      );
    } finally {
      await req('/api/admin/settings/alerts.maintenanceWindows', { method: 'DELETE', headers: authed });
      await req('/api/admin/settings/maintenance.scheduleEnabled', { method: 'DELETE', headers: authed });
    }
  }
}

// ---------------------------------------------------------------- interval
// 检查间隔 / Interval

console.log('\ninterval: "check now" does not wait for the due filter');
{
  const id = 'fresh-monitor';
  // A reading stamped one second ago and a 3600s interval: due-filter logic
  // would leave this monitor alone for another hour.
  // 读数时间是一秒前、间隔为 3600 秒；到期过滤会让该监控再等待约一小时。
  await seedMonitor(id, { name: 'fresh', interval_sec: 3600 });
  await db.prepare("UPDATE live_state SET json = ?, updated_at = ? WHERE id = 'all'")
    .bind(JSON.stringify({ [id]: { st: 1, ts: now, v: 10, code: 200, msg: '', fails: 0 } }), now)
    .run();
  await plan('ok');
  const r = await req(`/api/monitors/${id}/check`, { method: 'POST', headers: authed });
  check('the check runs anyway', r.status === 200, r);
  check('the transport was called once', await hits() === 1);
  const entry = await liveEntry(id);
  check('the reading was refreshed', entry?.ts >= now, entry);
}

// ---------------------------------------------------------------- auth
// 认证 / Authentication

console.log('\nauth: the route sits behind the same gate as the rest of the console');
{
  const r = await req('/api/monitors/healthy-monitor/check', { method: 'POST' });
  check('no token is 401', r.status === 401, r);
}

console.log('\nfirst abnormal readings notify once');
await req('/api/admin/settings', { method: 'PUT', headers: authed, body: JSON.stringify({ 'monitor.defaultRetries': 1 }) });
{
  await seedMonitor('first-down');
  await plan('down');
  const first = await req('/api/monitors/first-down/check', { method: 'POST', headers: authed });
  const second = await req('/api/monitors/first-down/check', { method: 'POST', headers: authed });
  check('a first failure is recorded and queued', first.json?.status === 0 && first.json.event && first.json.notified, first);
  check('a persistent failure does not create another alert', second.json?.notified === false && (await eventsFor('first-down')).length === 1, second);

  await seedMonitor('first-warning', { options_json: JSON.stringify({ maxLatencyMs: 1 }) });
  await plan('slow');
  const warning = await req('/api/monitors/first-warning/check', { method: 'POST', headers: authed });
  check('a first slow response is WARN and queued', warning.json?.status === 2 && warning.json.notified, warning);
  for (let round = 0; round < 3; round++) {
    const continued = await req('/api/monitors/first-warning/check', { method: 'POST', headers: authed });
    check('continued slow responses stay WARN without duplicate alerts', continued.json?.status === 2 && !continued.json.notified, continued);
  }
}

console.log('\nconcurrent checks preserve both monitors');
{
  for (const id of ['parallel-a', 'parallel-b']) {
    await seedMonitor(id);
    await plan('ok');
    await req('/api/monitors/' + id + '/check', { method: 'POST', headers: authed });
  }
  await plan('down');
  const pair = await req('/__pair?ids=parallel-a,parallel-b');
  check('both checks read the same starting state', pair.json.reads === 2, pair);
  check('both checks return DOWN', pair.json.readings.every((reading) => reading.status === 0), pair);
  check('both DOWN readings remain in live_state', (await liveEntry('parallel-a')).st === 0 && (await liveEntry('parallel-b')).st === 0);
}

console.log('\nmaintenance end reconciles the current condition');
{
  await req('/__clock?at=2026-10-26T02%3A10%3A00Z');
  await seedMonitor('still-down-after-maintenance', { interval_sec: 3600 });
  await plan('ok');
  await req('/api/monitors/still-down-after-maintenance/check', { method: 'POST', headers: authed });
  await req('/api/admin/settings', { method: 'PUT', headers: authed, body: JSON.stringify({
    'alerts.maintenanceWindows': [{ kind: 'weekly', day: 1, start: '02:00', end: '02:15' }],
    'maintenance.scheduleEnabled': true,
  }) });
  await plan('down');
  const inside = await req('/api/monitors/still-down-after-maintenance/check', { method: 'POST', headers: authed });
  check('maintenance holds the alert and marks it pending', !inside.json.notified && (await liveEntry('still-down-after-maintenance')).alert_pending === true, inside);
  await req('/__clock?at=2026-10-26T02%3A16%3A00Z');
  await req('/__tick');
  const after = await liveEntry('still-down-after-maintenance');
  check('the minute after maintenance rechecks an hourly monitor', after.ts === Date.parse('2026-10-26T02:16:00Z') / 1000, after);
  check('the persistent outage queues its current condition', await count("SELECT COUNT(*) AS n FROM pending_notifications WHERE event_id LIKE ?", 'still-down-after-maintenance:maintenance-ended@%') === 1);
  check('the maintenance marker is cleared', after.alert_pending === undefined, after);
  await req('/__clock?at=2026-10-26T02%3A17%3A00Z');
  await req('/__tick');
  check('later ticks do not queue another maintenance-end alert', await count("SELECT COUNT(*) AS n FROM pending_notifications WHERE event_id LIKE ?", 'still-down-after-maintenance:maintenance-ended@%') === 1);
  await req('/api/admin/settings/alerts.maintenanceWindows', { method: 'DELETE', headers: authed });
}

console.log('\npush deadlines run independently of the reporting interval');
{
  await req('/__clock?at=2026-10-26T06%3A00%3A00Z');
  await seedMonitor('hourly-push', { type: 'push', target: '', push_token: 'hourly-push-secret', interval_sec: 3600 });
  await req('/api/public/push/hourly-push-secret', { method: 'POST' });
  await plan('ok');
  await req('/__tick');
  check('a received push starts UP', (await liveEntry('hourly-push')).st === 1);
  await req('/__clock?at=2026-10-26T07%3A01%3A00Z');
  await req('/__tick');
  check('the first minute past the deadline is DOWN', (await liveEntry('hourly-push')).st === 0, await liveEntry('hourly-push'));
  await req('/api/public/push/hourly-push-secret', { method: 'POST' });
  await req('/__clock?at=2026-10-26T07%3A02%3A00Z');
  await req('/__tick');
  check('a new push restores UP on the next minute', (await liveEntry('hourly-push')).st === 1, await liveEntry('hourly-push'));
}

console.log('\ndefault timeout matches monitor validation');
{
  const invalid = await req('/api/admin/settings', { method: 'PUT', headers: authed, body: JSON.stringify({ 'monitor.defaultTimeoutMs': 120000 }) });
  check('the settings API rejects unsupported timeout defaults', invalid.status === 400, invalid);
  await req('/api/admin/settings', { method: 'PUT', headers: authed, body: JSON.stringify({ 'monitor.defaultTimeoutMs': 60000 }) });
  const created = await req('/api/monitors', { method: 'POST', headers: authed, body: JSON.stringify({ name: 'timeout boundary', type: 'http', target: 'https://example.test', timeout_ms: 60000 }) });
  check('the maximum default is accepted by monitor creation', created.status === 201, created);
  const saved = await db.prepare('SELECT timeout_ms FROM monitors WHERE id=?').bind(created.json.id).first();
  check('the saved timeout is the configured value', saved.timeout_ms === 60000, saved);
}

console.log('\nlifecycle: stale checks cannot recreate deleted or changed monitor data');
for (const mode of ['delete', 'pause', 'change']) {
  const id = `lifecycle-${mode}`;
  await seedMonitor(id, { target: 'https://example.test/lifecycle' });
  const result = await req(`/__lifecycle?id=${id}&mode=${mode}`);
  check(`${mode} succeeds while the target is pending`, result.json.mutation === 200, result);
  check(`${mode} supersedes the in-flight check`, result.json.check === 409 && result.json.body.error === 'monitor_changed', result);
  check(`${mode} writes no live state`, await liveEntry(id) === undefined);
  check(`${mode} writes no ring history`, await count('SELECT COUNT(*) AS n FROM heartbeat_ring WHERE id=?', id) === 0);
}

await mf.dispose();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
