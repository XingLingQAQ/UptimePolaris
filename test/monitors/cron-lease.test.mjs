// 验证定时任务租约、竞争、故障重试与探测提交。
// Check cron leases, races, failure retries, and probe commits.

import { applyD1Migrations } from '../helpers/apply-d1-migrations.mjs';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

const harness = `
import { runTick } from './backends/worker/src/lib/jobs/tick.ts';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let wallNow = Date.now();
Date.now = () => wallNow;
globalThis.__cronLeaseProbe = { next: null };
globalThis.__aePoints = [];
// 通知也留在测试环境内。 / Keep notification delivery inside the fixture.
globalThis.fetch = async () => Response.json({ ok: true });
/**
 * Fault injection for the two cron-loop defects this file pins: a checker that
 * throws every round, and an add-on that throws while the primary succeeded.
 * Read by the stubbed checkers the esbuild plugin installs below.
 *
 * No backticks in this file's harness template comments: the whole harness is
 * one template literal (see \`harness\` below), so a backtick inside it ends the
 * string early.
 *
 * 为本文件固定的两个定时循环缺陷注入故障：检查器每轮抛错，以及主检查成功时附加检查抛错。
 * 由下方 esbuild 插件安装的检查器替身读取。测试环境整体是模板字符串（见下方 harness），
 * 所以其中的注释不能含未转义的反引号，否则会提前结束字符串。
 */
globalThis.__faults = { http: '', ssl: '' };
function probeGate() {
  let release;
  let started;
  const gate = { wait: new Promise((resolve) => { release = resolve; }), started: () => {}, release: () => release() };
  gate.startedPromise = new Promise((resolve) => { started = resolve; });
  gate.started = started;
  globalThis.__cronLeaseProbe.next = gate;
  return gate;
}
function withDB(env, mode) {
  return new Proxy(env, { get(target, key) {
    if (key === 'UPTIME') return { writeDataPoint: (point) => globalThis.__aePoints.push(point) };
    if (key !== 'DB' || !mode) return Reflect.get(target, key, target);
    return new Proxy(target.DB, { get(db, property) {
      if (property === 'batch') return async (statements) => {
        if (mode.failBatch === 'before') { mode.failBatch = ''; throw new Error('fixture batch failure before commit'); }
        if (mode.failBatch === 'delete-lease') {
          mode.failBatch = '';
          await db.prepare('DELETE FROM cron_tick_lease WHERE id = 1').run();
        }
        const result = await db.batch(statements);
        if (mode.failBatch === 'after') { mode.failBatch = ''; throw new Error('fixture batch acknowledgement lost after commit'); }
        return result;
      };
      if (property !== 'prepare') return Reflect.get(db, property, db);
      return (sql) => {
        const monitorRead = sql.startsWith('SELECT * FROM monitors');
        const renew = sql.startsWith('UPDATE cron_tick_lease SET lease_until');
        const release = sql.includes('SET owner = NULL');
        if (!monitorRead && !renew && !release) return db.prepare(sql);
        const wrap = (statement, bound = []) => new Proxy(statement, { get(query, method) {
          if (method === 'bind') return (...args) => wrap(query.bind(...args), args);
          if (method !== (monitorRead ? 'all' : 'run')) return Reflect.get(query, method, query);
          return async (...args) => {
            if (mode.fail && monitorRead) { mode.fail = false; throw new Error('fixture monitor read failure'); }
            if (release) {
              mode.releaseCalled = true;
              await mode.beforeRelease?.(bound[2]);
            }
            const result = monitorRead ? await query.all(...args) : await query.run(...args);
            if (renew) mode.onRenew?.();
            return result;
          };
        } });
        return wrap(db.prepare(sql));
      };
    } });
  } });
}
export default { async fetch(request, env) {
  const url = new URL(request.url);
  const now = Number(url.searchParams.get('now')) || Math.floor(Date.now() / 1000);
  if (url.pathname === '/__tick') {
    const mode = { fail: url.searchParams.has('fail'), delay: Number(url.searchParams.get('delay')) || 0 };
    try { return Response.json(await runTick(withDB(env, mode), now)); }
    catch (error) { return Response.json({ error: String(error) }, { status: 500 }); }
  }
  if (url.pathname === '/__atomic') {
    if (url.searchParams.has('reset')) globalThis.__aePoints.length = 0;
    wallNow = now * 1000;
    const mode = { failBatch: url.searchParams.get('failure') ?? '' };
    try { return Response.json({ tick: await runTick(withDB(env, mode), now), aePoints: globalThis.__aePoints.length }); }
    catch (error) { return Response.json({ error: String(error), aePoints: globalThis.__aePoints.length }, { status: 500 }); }
  }
  if (url.pathname === '/__race') {
    const results = await Promise.all([runTick(env, now), runTick(env, now)]);
    return Response.json(results);
  }
  if (url.pathname === '/__release-expired') {
    const mode = { beforeRelease: async (owner) => {
      await env.DB.prepare('UPDATE cron_tick_lease SET lease_until = ? WHERE id = 1 AND owner = ?')
        .bind(Math.floor(Date.now() / 1000) - 1, owner).run();
    } };
    const tick = await runTick(withDB(env, mode), now);
    return Response.json({ tick, releaseCalled: mode.releaseCalled === true });
  }
  if (url.pathname === '/__slow-race') {
    const gate = probeGate();
    let renewals = 0;
    let signalRenewed;
    const renewed = new Promise((resolve) => { signalRenewed = resolve; });
    const slow = runTick(withDB(env, { onRenew: () => { if (++renewals >= 3) signalRenewed(); } }), now);
    await Promise.race([gate.startedPromise, delay(5000).then(() => { throw new Error('probe barrier was not reached'); })]);
    wallNow += 50000;
    await Promise.race([renewed, delay(20000).then(() => { throw new Error('periodic lease renewal was not observed'); })]);
    wallNow += 20000;
    const contender = await runTick(env, now);
    gate.release();
    return Response.json({ slow: await slow, contender });
  }
  if (url.pathname === '/__lost-race') {
    const oldGate = probeGate();
    const slow = runTick(env, now);
    await Promise.race([oldGate.startedPromise, delay(5000).then(() => { throw new Error('old-owner probe barrier was not reached'); })]);
    await env.DB.prepare('UPDATE cron_tick_lease SET owner = ?, lease_until = ?, completed_minute = ? WHERE id = 1')
      .bind('stale-owner', Math.floor(Date.now() / 1000) - 1, now - 60).run();
    const newGate = probeGate();
    const contender = runTick(env, now);
    await Promise.race([newGate.startedPromise, delay(5000).then(() => { throw new Error('replacement-owner probe barrier was not reached'); })]);
    const active = await env.DB.prepare('SELECT owner, lease_until FROM cron_tick_lease WHERE id = 1').first();
    oldGate.release();
    const oldResult = await slow;
    const afterOldRelease = await env.DB.prepare('SELECT owner, lease_until FROM cron_tick_lease WHERE id = 1').first();
    newGate.release();
    return Response.json({ slow: oldResult, contender: await contender, activeOwner: active.owner, afterOldRelease });
  }
  /**
   * Three consecutive rounds in which the checker itself throws.
   *
   * Seeds an UP reading, then ticks three times with checkHttp throwing. Each
   * round must keep the last known status while the counter climbs, and the
   * third must settle to DOWN and produce a real event in a single write. The
   * old code only logged and continued, so the monitor sat at UP forever with
   * no event - the freeze this endpoint exists to catch.
   *
   * 检查器本身连续三轮抛错：先写入 UP，然后让 checkHttp 抛错并执行三次 tick。
   * 每轮须在计数增长时保留最后已知状态，第三轮须确定为 DOWN 并在一次写入中产生真实事件。
   * 旧代码只记录日志并继续，监控会永远停在 UP 且没有事件；此端点用于捕获这种冻结。
   */
  if (url.pathname === '/__checker-throws') {
    const start = Number(url.searchParams.get('now'));
    const id = 'tick-lease-monitor';
    /**
     * The entry's ts is written from Date.now(), not from the now argument, so
     * the wall clock has to move with the simulated minute. Without this the
     * first round stamps a much later ts and the due-check skips rounds two and
     * three, which looks exactly like a counter that stopped advancing.
     * 条目的 ts 来自 Date.now() 而非 now 参数，因此墙上时钟须随模拟分钟移动；
     * 否则第一轮时间戳会晚得多，使到期检查跳过第二、三轮，看起来像计数器停止增长。
     */
    wallNow = start * 1000;
    await env.DB.prepare("UPDATE live_state SET json = ?, updated_at = ? WHERE id = 'all'")
      .bind(JSON.stringify({ [id]: { st: 1, ts: start - 60, v: 5, code: 200, msg: 'fixture up', fails: 0 } }), start - 60).run();
    globalThis.__faults.http = 'throw';
    const rounds = [];
    try {
      for (let i = 0; i < 3; i++) {
        wallNow = (start + i * 60) * 1000;
        await runTick(env, start + i * 60);
        const json = JSON.parse((await env.DB.prepare("SELECT json FROM live_state WHERE id='all'").first()).json);
        rounds.push(json[id]);
      }
    } finally {
      globalThis.__faults.http = '';
    }
    // Scoped to this window: the earlier lease cases already wrote events for
    // this same monitor, and counting those would make the assertion depend on
    // how many of them happened to run before this one.
    // 只统计此窗口：先前租约案例已为同一监控写入事件，计入它们会使断言依赖之前运行了多少案例。
    const events = await env.DB.prepare('SELECT status, message FROM events WHERE monitor_id=? AND created_at>=? ORDER BY created_at')
      .bind(id, start).all();
    return Response.json({ rounds, events: events.results });
  }

  /**
   * A successful primary whose add-on throws (ExternalBudgetExceeded).
   *
   * The primary reading must be persisted - st, v and the ring point come
   * from checkHttp - and the monitor must not be marked DOWN over a
   * certificate check that never ran.
   *
   * 主检查成功而附加检查抛出 ExternalBudgetExceeded：必须保留主读数，st、v 和环点来自 checkHttp，
   * 不能因未执行的证书检查将监控标为 DOWN。
   */
  if (url.pathname === '/__addon-throws') {
    const start = Number(url.searchParams.get('now'));
    const id = 'tick-lease-monitor';
    wallNow = start * 1000;
    await env.DB.prepare('UPDATE monitors SET check_ssl = 1 WHERE id = ?').bind(id).run();
    globalThis.__faults.ssl = 'budget';
    try {
      await runTick(env, start);
    } finally {
      globalThis.__faults.ssl = '';
      await env.DB.prepare('UPDATE monitors SET check_ssl = 0 WHERE id = ?').bind(id).run();
    }
    const json = JSON.parse((await env.DB.prepare("SELECT json FROM live_state WHERE id='all'").first()).json);
    const ring = await env.DB.prepare('SELECT json FROM heartbeat_ring WHERE id = ?').bind(id).first();
    return Response.json({ entry: json[id], ring: ring ? JSON.parse(ring.json) : null });
  }

  /**
   * Defect 3: cron's firing instant jitters by a second.
   *
   * Seeds the monitor's last reading so that \`now - last === interval_sec - 1\` -
   * exactly the state a tick produces when it fires one second earlier than the
   * previous one. A strict \`>=\` comparison skips the monitor and only picks it up
   * on the *next* tick, so its real cadence silently doubles. The assertion is
   * the observable outcome: \`ts\` reaches \`now\`, which only a completed check
   * writes.
   *
   * Run twice, at \`now\` and \`now + 60\`, so the second tick proves the tolerance
   * does not make the monitor due again in a later minute by accident (and that
   * the completed-minute fence still admits the next minute normally).
   *
   * 缺陷 3：定时触发时间可能抖动一秒。预设上次读数使 now - last 恰好为 interval_sec - 1，
   * 即本次比上次早一秒的状态。严格 >= 会跳过监控并等到下一次 tick，实际间隔静默加倍。
   * 断言 ts 到达 now，只有完成的检查才会写该值。在 now 与 now + 60 各运行一次，
   * 证明容差不会使监控在后续分钟意外重复到期，且 completed-minute 栅栏正常允许下一分钟。
   */
  if (url.pathname === '/__due-tolerance') {
    const start = Number(url.searchParams.get('now'));
    const id = 'due-tolerance-monitor';
    const interval = 60;
    wallNow = start * 1000;
    const insert = \`INSERT INTO monitors (id, name, type, target, interval_sec, timeout_ms, created_at, updated_at)
       VALUES (?, ?, 'http', 'https://due.test/health', ?, 30000, ?, ?)\`;
    await env.DB.prepare(insert).bind(id, 'Due tolerance', interval, start - 600, start - 600).run();
    // One second SHORT of the interval: the jitter case.
    // 比间隔少一秒：触发时间抖动场景。
    const last = start - interval + 1;
    // Merged, not replaced: this row is shared with every other case in the file.
    // 合并而非替换：该行由文件中的其他案例共同使用。
    const previous = JSON.parse((await env.DB.prepare("SELECT json FROM live_state WHERE id='all'").first())?.json ?? '{}');
    previous[id] = { st: 1, ts: last, v: 5, code: 200, msg: 'fixture up', fails: 0 };
    await env.DB.prepare("UPDATE live_state SET json = ?, updated_at = ? WHERE id = 'all'")
      .bind(JSON.stringify(previous), last).run();
    try {
      await runTick(env, start);
      const afterFirst = JSON.parse((await env.DB.prepare("SELECT json FROM live_state WHERE id='all'").first()).json)[id];
      const ringFirst = await env.DB.prepare('SELECT json,updated_at FROM heartbeat_ring WHERE id=?').bind(id).first();
      // The next minute, where the monitor is now comfortably out of date.
      // 下一分钟，此时监控已明显超过检查间隔。
      wallNow = (start + 60) * 1000;
      await runTick(env, start + 60);
      const afterSecond = JSON.parse((await env.DB.prepare("SELECT json FROM live_state WHERE id='all'").first()).json)[id];
      const ringSecond = await env.DB.prepare('SELECT json,updated_at FROM heartbeat_ring WHERE id=?').bind(id).first();
      return Response.json({ last, interval, start, afterFirst, afterSecond, ringFirst, ringSecond });
    } finally {
      await env.DB.prepare('DELETE FROM monitors WHERE id = ?').bind(id).run();
      await env.DB.prepare('DELETE FROM heartbeat_ring WHERE id = ?').bind(id).run();
      await env.DB.prepare('DELETE FROM events WHERE monitor_id = ?').bind(id).run();
    }
  }

  if (url.pathname === '/__changed') {
    wallNow = now * 1000;
    const gate = probeGate();
    const running = runTick(withDB(env, {}), now);
    await Promise.race([gate.startedPromise, delay(5000).then(() => { throw new Error('snapshot probe barrier missing'); })]);
    await env.DB.prepare("UPDATE monitors SET target='https://changed.test' WHERE id='tick-lease-monitor'").run();
    gate.release();
    return Response.json({ tick: await running, aePoints: globalThis.__aePoints.length });
  }
  if (url.pathname === '/__expire') {
    const minute = Number(url.searchParams.get('minute'));
    await env.DB.prepare('UPDATE cron_tick_lease SET owner = ?, lease_until = ?, completed_minute = ? WHERE id = 1')
      .bind('stale-owner', Math.floor(Date.now() / 1000) - 1, minute - 60).run();
    return Response.json({ ok: true });
  }
  return Response.json({ error: 'not found' }, { status: 404 });
} };
`;

const bundled = await build({
  stdin: { contents: harness, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, format: 'esm', platform: 'neutral', target: 'es2022', write: false,
  external: ['cloudflare:sockets'], logLevel: 'error',
  plugins: [{ name: 'controlled-probe', setup(builder) {
    builder.onResolve({ filter: /(?:^|[/\\])http(?:\.ts)?$/ }, args => /[/\\]check[/\\]run\.ts$/.test(args.importer)
      ? { path: 'http-check', namespace: 'lease-fixture' } : null);
    builder.onLoad({ filter: /.*/, namespace: 'lease-fixture' }, () => ({ contents: `
      export async function checkHttp() {
        if (globalThis.__faults.http === 'throw') throw new TypeError("Cannot read properties of undefined (reading 'split')");
        const gate = globalThis.__cronLeaseProbe.next;
        if (gate) {
          globalThis.__cronLeaseProbe.next = null;
          gate.started();
          await gate.wait;
        }
        return { status: 1, latencyMs: 1, statusCode: 200, message: 'fixture ok' };
      }
    `, loader: 'js' }));
    /* 附加检查独立抛出预算异常，主检查仍返回成功读数。
     * Raise a budget error from the add-on while the primary check still succeeds. */
    builder.onResolve({ filter: /(?:^|[/\\])ssl(?:\.ts)?$/ }, args => /[/\\]check[/\\]run\.ts$/.test(args.importer)
      ? { path: 'ssl-check', namespace: 'lease-ssl-fixture' } : null);
    builder.onLoad({ filter: /.*/, namespace: 'lease-ssl-fixture' }, () => ({
      contents: `
      export function sslProviderKey() { return 'fixture'; }
      export async function checkSsl() {
        if (globalThis.__faults.ssl === 'budget') {
          const { ExternalBudgetExceeded } = await import('./backends/worker/src/lib/http/request-budget.ts');
          throw new ExternalBudgetExceeded();
        }
        return { status: 1, latencyMs: 1, statusCode: 0, message: 'cert ok', daysLeft: 60 };
      }
    `,
      loader: 'js',
      resolveDir: process.cwd(),
    }));
  } }, { name: 'stub-postgres', setup(builder) {
    builder.onResolve({ filter: /^postgres$/ }, () => ({ path: 'pg-stub', namespace: 'stub' }));
    builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: "export default function postgres() { throw new Error('postgres unavailable in D1 fixture'); }" }));
  } }],
});
const mf = new Miniflare({ modules: true, script: bundled.outputFiles[0].text, compatibilityDate: '2025-01-01', d1Databases: { DB: 'cron-lease-fixture' } });

try {
  const db = await mf.getD1Database('DB');
  await applyD1Migrations(db);
  await db.prepare('INSERT INTO monitors (id, name, type, target, interval_sec, timeout_ms, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind('tick-lease-monitor', 'Lease fixture', 'http', 'https://tick-lease.test/health', 60, 30000, Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000)).run();
  await db.prepare('INSERT INTO notifications (id, name, type, config_json, active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)')
    .bind('atomic-hook', 'Atomic fixture', 'webhook', JSON.stringify({ url: 'https://hooks.example.test/tick' }), Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000)).run();
  const request = async (path) => {
    const response = await mf.dispatchFetch(`http://localhost${path}`);
    const raw = await response.text();
    let body;
    try { body = JSON.parse(raw); } catch { body = raw; }
    assert(response.ok, `${path}: ${response.status} ${JSON.stringify(body)}`);
    return body;
  };
  const minute = Math.floor(Date.now() / 60_000) * 60;

  const failed = await mf.dispatchFetch(`http://localhost/__tick?now=${minute}&fail=1`);
  assert.equal(failed.status, 500);
  assert.equal((await request(`/__tick?now=${minute}`)).status, 'completed');

  const raceMinute = minute + 60;
  const race = await request(`/__race?now=${raceMinute}`);
  assert.equal(race.filter((result) => result.status === 'completed').length, 1);
  assert.equal(race.filter((result) => result.status === 'skipped').length, 1);
  assert(['leased', 'completed'].includes(race.find((result) => result.status === 'skipped').reason));
  assert.equal((await request(`/__tick?now=${raceMinute}`)).reason, 'completed');

  const retried = await request(`/__tick?now=${minute + 120}`);
  assert.equal(retried.status, 'completed');



  await request(`/__expire?minute=${minute + 180}`);
  assert.equal((await request(`/__tick?now=${minute + 180}`)).status, 'completed');

  const releaseMinute = minute + 240;
  const releaseRace = await request(`/__release-expired?now=${releaseMinute}`);
  assert.equal(releaseRace.releaseCalled, true);
  assert.deepEqual(releaseRace.tick, { status: 'skipped', reason: 'lease_lost' });
  const afterFailedRelease = await db.prepare('SELECT completed_minute FROM cron_tick_lease WHERE id = 1').first();
  assert.equal(afterFailedRelease.completed_minute, minute + 180, 'expired release must leave the completed-minute marker unchanged');

  const slowMinute = minute + 300;
  const slowRace = await request(`/__slow-race?now=${slowMinute}`);
  assert.equal(slowRace.slow.status, 'completed');
  assert.equal(slowRace.contender.reason, 'leased');

  const lostMinute = minute + 360;
  const lostRace = await request(`/__lost-race?now=${lostMinute}`);
  assert.equal(lostRace.contender.status, 'completed');
  assert.deepEqual(lostRace.slow, { status: 'skipped', reason: 'lease_lost' });
  assert.equal(lostRace.afterOldRelease.owner, lostRace.activeOwner, 'old owner release must leave the replacement lease intact');
  const final = await db.prepare('SELECT owner, completed_minute FROM cron_tick_lease WHERE id = 1').first();
  assert.equal(final.owner, null);
  assert.equal(final.completed_minute, lostMinute);

  const atomicMinute = minute + 420;
  const down = { st: 0, ts: atomicMinute - 120, v: 0, code: 0, msg: 'fixture down', fails: 3 };
  await db.prepare('INSERT INTO live_state (id, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET json=excluded.json, updated_at=excluded.updated_at')
    .bind('all', JSON.stringify({ 'tick-lease-monitor': down }), atomicMinute - 120).run();
  const ringBefore = await db.prepare('SELECT json FROM heartbeat_ring WHERE id = ?').bind('tick-lease-monitor').first();
  const beforeFailure = await mf.dispatchFetch(`http://localhost/__atomic?now=${atomicMinute}&failure=before&reset=1`);
  assert.equal(beforeFailure.status, 500);
  assert.equal((await beforeFailure.json()).aePoints, 0, 'precommit failure must not publish an Analytics Engine point');
  assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM events WHERE monitor_id=?').bind('tick-lease-monitor').first()).count, 0);
  assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM pending_notifications').first()).count, 0);
  assert.equal(JSON.parse((await db.prepare('SELECT json FROM live_state WHERE id=?').bind('all').first()).json)['tick-lease-monitor'].st, 0);
  assert.deepEqual(await db.prepare('SELECT json FROM heartbeat_ring WHERE id = ?').bind('tick-lease-monitor').first(), ringBefore);
  const recovered = await mf.dispatchFetch(`http://localhost/__atomic?now=${atomicMinute}`);
  assert.equal(recovered.status, 200);
  assert.equal((await recovered.clone().json()).aePoints, 1, 'committed check publishes its Analytics Engine point');
  assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM events WHERE monitor_id=?').bind('tick-lease-monitor').first()).count, 1);
  assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM pending_notifications').first()).count, 0, 'successful fake delivery drains the committed outbox');
  const committedRing = JSON.parse((await db.prepare('SELECT json FROM heartbeat_ring WHERE id = ?').bind('tick-lease-monitor').first()).json);

  const lostAckMinute = atomicMinute + 60;
  await db.prepare('UPDATE live_state SET json=? WHERE id=?')
    .bind(JSON.stringify({ 'tick-lease-monitor': { ...down, ts: lostAckMinute - 120 } }), 'all').run();
  const lostAck = await mf.dispatchFetch(`http://localhost/__atomic?now=${lostAckMinute}&failure=after`);
  assert.equal(lostAck.status, 500);
  assert.equal((await lostAck.json()).aePoints, 1, 'ambiguous failed tick does not publish a phantom point');
  assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM events WHERE monitor_id=?').bind('tick-lease-monitor').first()).count, 2);
  assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM pending_notifications').first()).count, 1);
  const ringAfterLostAck = JSON.parse((await db.prepare('SELECT json FROM heartbeat_ring WHERE id = ?').bind('tick-lease-monitor').first()).json);
  assert.equal(ringAfterLostAck.length, committedRing.length + 1);
  const retriedAck = await mf.dispatchFetch(`http://localhost/__atomic?now=${lostAckMinute}`);
  assert.equal(retriedAck.status, 200);
  assert.equal((await retriedAck.clone().json()).aePoints, 1, 'retry of a committed minute does not duplicate its Analytics Engine point');
  assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM events WHERE monitor_id=?').bind('tick-lease-monitor').first()).count, 2);
  assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM pending_notifications').first()).count, 0);
  assert.deepEqual(JSON.parse((await db.prepare('SELECT json FROM heartbeat_ring WHERE id = ?').bind('tick-lease-monitor').first()).json), ringAfterLostAck);

  const missingLeaseMinute = lostAckMinute + 60;
  await db.prepare('UPDATE live_state SET json=? WHERE id=?')
    .bind(JSON.stringify({ 'tick-lease-monitor': { ...down, ts: missingLeaseMinute - 120 } }), 'all').run();
  const missingLease = await request(`/__atomic?now=${missingLeaseMinute}&failure=delete-lease`);
  assert.deepEqual(missingLease, { tick: { status: 'skipped', reason: 'lease_lost' }, aePoints: 1 });
  assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM events WHERE monitor_id=?').bind('tick-lease-monitor').first()).count, 2);
  assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM pending_notifications').first()).count, 0);
  assert.equal(JSON.parse((await db.prepare('SELECT json FROM live_state WHERE id=?').bind('all').first()).json)['tick-lease-monitor'].st, 0);
  /* 检查器异常先计入重试，耗尽后进入 DOWN 并触发事件路径。
   * Count checker exceptions toward retries, then enter DOWN and the event path when retries are exhausted. */
  // Beyond every minute the earlier lease cases used: `runTick` refuses a minute
  // whose lease already carries `completed_minute`, and a silently skipped tick
  // here would look exactly like a counter that did not advance.
  // 使用晚于先前租约案例的分钟；runTick 会拒绝租约已有 completed_minute 的分钟，
  // 若此处静默跳过，看起来会和计数器未增长完全相同。
  const throwsMinute = minute + 700;
  const throws = await request(`/__checker-throws?now=${throwsMinute}`);
  assert.equal(throws.rounds.length, 3);
  assert.deepEqual(throws.rounds.slice(0, 2).map((entry) => entry.st), [1, 1], 'an incomplete round must not fake a status change');
  assert.deepEqual(throws.rounds.map((entry) => entry.fails), [1, 2, 3], 'each incomplete round counts');
  assert.match(throws.rounds[0].msg, /^check did not complete this minute/, 'the entry says the round did not complete');
  assert.equal(throws.rounds[0].v, 5, 'an incomplete round keeps the last measured latency');
  assert.equal(throws.rounds.slice(0, 2).map((entry) => entry.ts).join(','), [throwsMinute, throwsMinute + 60].join(','), 'ts advances so the monitor is not re-run in the same minute');
  assert.equal(throws.rounds[2].st, 0, 'three incomplete rounds settle to DOWN');
  assert.equal(throws.events.length, 1, 'settling writes exactly one transition event');
  assert.equal(throws.events[0].status, 0);
  assert.match(throws.events[0].message, /check did not complete/, 'the event says why, not just "down"');

  /* 附加检查失败不能丢弃成功的主检查读数。
   * An add-on failure must not discard a successful primary reading. */
  const addonMinute = minute + 1000;
  await db.prepare("UPDATE live_state SET json = ?, updated_at = ? WHERE id = 'all'")
    .bind(JSON.stringify({ 'tick-lease-monitor': { st: 1, ts: addonMinute - 60, v: 5, code: 200, msg: 'fixture up', fails: 0 } }), addonMinute - 60).run();
  const addonFailure = await request(`/__addon-throws?now=${addonMinute}`);
  assert.equal(addonFailure.entry.st, 1, 'the primary reading decides the status, not the failed add-on');
  assert.equal(addonFailure.entry.v, 1, 'the live latency comes from the primary check');
  assert.equal(addonFailure.entry.ts, addonMinute, 'the round counts as a completed check');
  assert.equal(addonFailure.entry.msg, 'fixture ok', 'the primary message is kept');
  assert.equal('ssl' in addonFailure.entry, false, 'a failed add-on contributes no reading rather than a fabricated one');
  assert.equal(addonFailure.ring.at(-1).up, 1, 'the primary reading reaches the heartbeat ring');

  /* 验证一秒调度余量与下一周期；最后执行以免影响前面的计数。
   * Check the one-second scheduling tolerance and next cycle last to avoid changing earlier counters. */
  // Past every minute the earlier cases used: `runTick` refuses a minute whose
  // lease already carries a later `completed_minute`, and a silently skipped
  // tick here would look exactly like a monitor that stayed not-due.
  // 使用晚于先前所有案例的分钟；runTick 会拒绝租约记录了更晚 completed_minute 的分钟，
  // 此处若静默跳过，看起来会像监控始终未到期。
  const dueMinute = minute + 1200;
  const due = await request(`/__due-tolerance?now=${dueMinute}`);
  assert.equal(due.last, due.start - due.interval + 1, 'the fixture is exactly one second short of the interval');
  assert.equal(
    due.afterFirst.ts,
    due.start,
    'a monitor one second short of its interval is still checked on this tick',
  );
  assert.equal(due.afterFirst.st, 1, 'and it records the real reading');
  assert.equal(due.afterSecond.ts, due.start + 60, 'the following minute checks on schedule, not twice per minute');
  assert.deepEqual(due.ringSecond, due.ringFirst, 'stable checks do not rewrite the transition row');
  assert.deepEqual(due.afterSecond.recent_checks, [due.start, due.start + 60]);
  assert.equal(due.afterSecond.recent_observation.t, due.start + 60);

  const beforeChanged = await db.prepare("SELECT json FROM live_state WHERE id='all'").first();
  const beforeChangedRing = await db.prepare("SELECT json FROM heartbeat_ring WHERE id='tick-lease-monitor'").first();
  const changed = await request(`/__changed?now=${dueMinute + 180}`);
  assert.deepEqual(changed.tick, { status: 'skipped', reason: 'monitors_changed' });
  assert.deepEqual(await db.prepare("SELECT json FROM live_state WHERE id='all'").first(), beforeChanged);
  assert.deepEqual(await db.prepare("SELECT json FROM heartbeat_ring WHERE id='tick-lease-monitor'").first(), beforeChangedRing);

  console.log('PASS cron lease: atomic race, completed-minute guard, retry after failure, expired owner, renewal, and lost-owner fencing');
  console.log('PASS cron loop: an incomplete checker settles after the retry budget; an add-on failure keeps the primary reading');
} finally {
  await mf.dispose();
}
