import { isActiveProbeType, type ActiveProbeType } from '../../../../../shared/probe-capabilities';
import {
  DOWN,
  MAX_RETRIES,
  PENDING,
  UP,
  WARN,
  type AddonReading,
  type DnsAddonReading,
  type Env,
  type Heartbeat,
  type LiveEntry,
  type LiveState,
  type Monitor,
  type RingHeartbeat,
  type Status,
} from '../../types';
import { latestAgentProbeObservation, loadProbeAgentStates, monitorProbeSource, probeAgentAvailable, pruneAgentProbeJobs, scheduleAgentProbeJobs } from '../agent/probes';
import { rollupAgentMetrics } from '../agent/rollup';
import { writeHeartbeat, writeHeartbeatBatch } from '../analytics-engine';
import { checkPush } from '../check/push';
import { runAddons, runCheck } from '../check/run';
import type { CheckResult } from '../check/types';
import { mapConcurrent } from '../concurrency';
import { getDB, withDBScope } from '../db/factory';
import { eventsSQL } from '../db/sql/events';
import { tickLeaseSQL } from '../db/sql/heartbeat';
import { liveStateSQL } from '../db/sql/live-state';
import {
  ExternalBudgetExceeded,
  ExternalRequestBudget,
  isWorkerCapacityError,
  WORKER_SUBREQUEST_LIMIT,
} from '../http/request-budget';
import { preserveAvailability, recordAvailability } from '../monitor/availability';
import {
  invalidateConfig,
  invalidateLive,
  loadLiveFresh,
  loadMonitors,
  loadPushHeartbeats,
  prepareAvailabilityDayWrites,
  prepareHeartbeatWrites,
} from '../monitor/store';
import { commitMonitorWrites, MonitorChanged } from '../monitor/writes';
import { prepareNotificationOutbox, retryPending } from '../notification/dispatch';
import type { NotifyEvent } from '../notification/message';
import { alertsSuppressed } from '../settings/maintenance';
import { readAll } from '../settings/store';
import { recordTickUsage } from '../settings/usage';
import { commitTickWrites, TickLeaseLost } from './tick-commit';

/** Must stay at or below the 6-connection cap for simultaneous egress. / 必须不超过同时外发连接的 6 条上限。 */
const CONCURRENCY = 6;

/**
 * Budget exhausted before this probe could run.
 *
 * Distinct from `source_available`: the source was never asked. Reusing that
 * entry would also zero `fails` and `ts` for a target that may have been DOWN
 * for hours.
 * 探测前预算耗尽；与来源不可用区分，复用后者会清掉已失败目标的 fails 和 ts。
 */
const WORKER_BUDGET_MSG = 'worker request budget exhausted; not checked this minute';

/**
 * Checker threw instead of returning a verdict; keep the last status and count incomplete rounds.
 * Three in a row settle to DOWN. / 检查器抛错时保留上次状态并计数，连续三轮转为 DOWN。
 */
const CHECK_INCOMPLETE_PREFIX = 'check did not complete this minute';

/** Tick lease lifetime; renewed every 15 s. / tick 租约时长，每 15 秒续期。 */
const TICK_LEASE_SECONDS = 60;
const TICK_RENEW_MS = 15_000;

type TickResult = { status: 'completed' } | { status: 'skipped'; reason: 'leased' | 'completed' | 'lease_lost' | 'monitors_changed' };

async function claimTickLease(env: Env, owner: string, minute: number): Promise<boolean> {
  const db = getDB(env);
  const wallNow = Math.floor(Date.now() / 1000);
  const result = await db.execute(tickLeaseSQL[db.type].claimTick, [owner, wallNow + TICK_LEASE_SECONDS, wallNow, minute]);
  return result.rowsAffected === 1;
}

async function renewTickLease(env: Env, owner: string): Promise<boolean> {
  const wallNow = Math.floor(Date.now() / 1000);
  const db = getDB(env);
  const result = await db.execute(tickLeaseSQL[db.type].renewTick, [wallNow + TICK_LEASE_SECONDS, owner, wallNow]);
  return result.rowsAffected === 1;
}

/**
 * One tick: due checks, ring and AE history, live_state, events and notifications.
 * Worker egress is metered across all of them; D1 usage is logged separately.
 * 一次 tick；外发请求统一计量，D1 用量单独记录。
 */
export function runTick(env: Env, now: number): Promise<TickResult> {
  return withDBScope(env, async (scopedEnv) => {
    /**
     * External-request high-water mark, read before the DB scope closes.
     * A metric, not part of `TickResult`: widening the status union would make
     * every caller carry a number it does not use.
     * 外部请求峰值；不并入 TickResult，避免调用方携带无用字段。
     */
    let peakSubrequests = 0;
    try {
      const result = await runTickScoped(scopedEnv, now, (budget) => {
        peakSubrequests = Math.max(peakSubrequests, WORKER_SUBREQUEST_LIMIT - budget.remaining);
      });
      return result;
    } finally {
      const usage = getDB(scopedEnv).getUsage?.();
      if (usage) {
        console.log(JSON.stringify({ event: 'tick_db_usage', ...usage }));
        /**
         * Persist usage in `finally`: a failed tick still spent its reads.
         * Await it because `withDBScope` closes the adapter on return. / 失败 tick 也消耗读取，故在 finally 持久化；作用域返回即关闭连接，必须 await。
         */
        await recordTickUsage(scopedEnv, now, usage, peakSubrequests);
      }
    }
  });
}

async function runTickScoped(
  env: Env,
  now: number,
  /** Receives the tick's budget so the caller can record its high-water mark. / 接收 tick 预算，供调用方记录峰值。 */
  onBudget?: (budget: ExternalRequestBudget) => void,
): Promise<TickResult> {
  const externalBudget = new ExternalRequestBudget();
  const owner = crypto.randomUUID();
  const minute = Math.floor(now / 60) * 60;
  if (!(await claimTickLease(env, owner, minute))) {
    const db = getDB(env);
    const state = await db.queryOne<{ owner: string | null; lease_until: number; completed_minute: number }>(
      'SELECT owner, lease_until, completed_minute FROM cron_tick_lease WHERE id = 1',
    );
    return { status: 'skipped', reason: state?.completed_minute !== undefined && state.completed_minute >= minute ? 'completed' : 'leased' };
  }

  let ownershipLost = false;
  let completed = false;
  let renewalInFlight: Promise<void> | null = null;
  const renewal = setInterval(() => {
    if (renewalInFlight || ownershipLost) return;
    renewalInFlight = renewTickLease(env, owner).then((owned) => {
      if (!owned) ownershipLost = true;
    }).catch(() => {
      ownershipLost = true;
    }).finally(() => {
      renewalInFlight = null;
    });
  }, TICK_RENEW_MS);
  const ensureOwned = async () => {
    if (ownershipLost || !(await renewTickLease(env, owner))) {
      ownershipLost = true;
      throw new TickLeaseLost();
    }
  };

  let outcome: TickResult = { status: 'completed' };
  let failure: unknown;
  let failed = false;
  try {
    await runClaimedTick(env, now, owner, ensureOwned, externalBudget);
    clearInterval(renewal);
    if (renewalInFlight) await renewalInFlight;
    completed = !ownershipLost && await renewTickLease(env, owner);
    if (!completed) {
      ownershipLost = true;
      outcome = { status: 'skipped', reason: 'lease_lost' };
    }
  } catch (error) {
    if (error instanceof TickLeaseLost) outcome = { status: 'skipped', reason: 'lease_lost' };
    else if (error instanceof MonitorChanged) {
      invalidateConfig();
      outcome = { status: 'skipped', reason: 'monitors_changed' };
    }
    else {
      failed = true;
      failure = error;
    }
  }

  clearInterval(renewal);
  if (renewalInFlight) await renewalInFlight;
  // Budget is final; report before release so release cost stays out of the peak.
  // 预算已确定；在释放前上报，排除释放本身的成本。
  onBudget?.(externalBudget);
  try {
    const db = getDB(env);
    const wallNow = Math.floor(Date.now() / 1000);
    const released = await db.execute(tickLeaseSQL[db.type].releaseTick, [completed ? 1 : 0, minute, owner, completed ? 1 : 0, wallNow]);
    if (completed && released.rowsAffected !== 1) outcome = { status: 'skipped', reason: 'lease_lost' };
  } catch (error) {
    if (!failed) {
      failed = true;
      failure = error;
    }
  }
  if (failed) throw failure;
  return outcome;
}

async function runClaimedTick(env: Env, now: number, tickOwner: string, ensureOwned: () => Promise<void>, externalBudget: ExternalRequestBudget): Promise<void> {
  await retryPending(env, now, externalBudget, 10);
  await ensureOwned();
  const monitors = await loadMonitors(env);
  await pruneAgentProbeJobs(env, now);
  if (monitors.length === 0) return;
  const probeAgents = await loadProbeAgentStates(env);
  await scheduleAgentProbeJobs(env, monitors, now, probeAgents);
  await ensureOwned();

  // Bypass the isolate cache: a stale `ts` makes a just-run monitor due again,
  // which turns overlapping ticks into duplicate checks and ring heartbeats.
  // 绕过 isolate 缓存；过期时间戳会让刚运行的监控再次到期，产生重复检查和心跳。
  const live = await loadLiveFresh(env);
  const maintenance = await alertsSuppressed(env, new Date(now * 1000));
  // Cron timestamps can differ by one second.
  // Cron 时间戳可能相差一秒。
  const DUE_TOLERANCE_SEC = 1;
  const due = monitors.filter((m) => {
    if (m.type === 'push' || live[m.id]?.alert_pending && !maintenance.suppressed) return true;
    const last = live[m.id]?.ts ?? 0;
    return now - last >= m.interval_sec - DUE_TOLERANCE_SEC;
  });

  /**
   * Agent readings arrive over WebSocket; roll them into live_state and this minute's history.
   * Runs even when `due` is empty. / Agent 观测经 WebSocket 到达，在此并入实时状态和本分钟历史；`due` 为空也执行。
   */
  const agentDue = due.filter((m) => m.type === 'agent');
  const candidateProbes = due.filter((m) => m.type !== 'agent').sort((a, b) => (live[a.id]?.ts ?? 0) - (live[b.id]?.ts ?? 0));
  const agentProbeResults = new Map<string, Awaited<ReturnType<typeof latestAgentProbeObservation>>>();
  const sourceAvailability = new Map<string, boolean>();
  const agentSourceMonitors = monitors.filter((monitor) =>
    isActiveProbeType(monitor.type) && monitorProbeSource(monitor).type === 'agent');
  for (const monitor of agentSourceMonitors) {
    const source = monitorProbeSource(monitor);
    if (source.type !== 'agent') continue;
    const available = probeAgentAvailable(probeAgents, source, monitor.type as ActiveProbeType, now, { ssl: Boolean(monitor.check_ssl), domain: Boolean(monitor.check_domain), dns: Boolean(monitor.check_dns) });
    sourceAvailability.set(monitor.id, available);
    if (available && due.includes(monitor)) {
      agentProbeResults.set(monitor.id, await latestAgentProbeObservation(env, monitor, live[monitor.id]?.ts ?? 0, now, live[monitor.id]?.ssl));
    }
  }
  const probeDue = candidateProbes.filter((monitor) => monitorProbeSource(monitor).type === 'worker' || (agentProbeResults.has(monitor.id) && agentProbeResults.get(monitor.id) !== null));
  const unknownSources = agentSourceMonitors.filter((monitor) =>
    sourceAvailability.get(monitor.id) !== true || due.includes(monitor) && agentProbeResults.get(monitor.id) == null);

  const unknownSourceEntry = (monitorId: string): LiveEntry => {
    const previous = live[monitorId];
    return {
      st: PENDING,
      ts: 0,
      v: null,
      code: 0,
      msg: 'source unavailable',
      fails: 0,
      source_available: false,
      ...(previous?.source_last_observed_at !== undefined ? { source_last_observed_at: previous.source_last_observed_at } : {}),
      ...(previous?.source_run_id ? { source_run_id: previous.source_run_id } : {}),
    };
  };

  // 每轮刷新 Agent 状态，沿用全局可用率记录。 / Refresh Agent state through the shared availability record.
  const anyAgent = agentDue.length > 0 || monitors.some((m) => m.type === 'agent');
  let agentEntries: Map<string, LiveEntry> = new Map();
  let agentAlerts: Awaited<ReturnType<typeof rollupAgentMetrics>>['alerts'] = [];
  if (anyAgent) {
    try {
      await ensureOwned();
      const r = await rollupAgentMetrics(env, now, live);
      agentEntries = r.entries;
      agentAlerts = r.alerts;
    } catch (e) {
      console.error(JSON.stringify({ event: 'agent_rollup_failed', err: String(e) }));
    }
  }

  /** Agent rows can be due without a probe; the early return needs all work empty. / Agent 到期不等于需要探测；提前返回必须以没有其他工作为前提。 */
  if (probeDue.length === 0) {
    if (agentEntries.size === 0 && unknownSources.length === 0) return;

    /** Merge agent entries without touching probe results; agent history is written by the rollup. / 合并 Agent 记录且不影响探测结果；Agent 历史由汇总写入。 */
    const next: LiveState = {};
    const ring = new Map<string, RingHeartbeat>();
    for (const monitor of unknownSources) next[monitor.id] = preserveAvailability(unknownSourceEntry(monitor.id), live[monitor.id]);
    /** Agent entries also get a ring point so the status chart has data; `ms` carries CPU %. / Agent 也写入环形点供状态图使用，`ms` 放 CPU 百分比。 */
    for (const [id, entry] of agentEntries) {
      next[id] = preserveAvailability(entry, live[id]);
      if (entry.ts <= 0) continue;
      ring.set(id, {
        t: Math.floor(now / 60) * 60,
        up: entry.st,
        ms: entry.v == null ? null : Math.round(entry.v * 100) / 100,
      });
    }
    const completedDays = recordAvailability(next, ring);
    await ensureOwned();
    const db = getDB(env);
    const agentAlertEvents = agentAlerts.map(agentAlertEvent);
    const alertEvents = applyMaintenanceToAlerts(monitors, live, next, agentAlertEvents, maintenance.suppressed, now);
    const outbox = await prepareNotificationOutbox(env, alertEvents, Math.floor(Date.now() / 1000));
    const writes = [
      { sql: liveStateSQL[db.type].merge, params: ['all', JSON.stringify(next), Math.floor(Date.now() / 1000)] },
      ...await prepareAvailabilityDayWrites(env, completedDays, Math.floor(Date.now() / 1000)),
      ...await prepareHeartbeatWrites(env, ring, live),
      ...agentAlerts.map((alert) => ({
        sql: eventsSQL[db.type].insert,
        params: [alert.monitor.id, alert.status, alert.message.slice(0, 512), alert.at],
      })),
      ...outbox,
    ];
    await commitTickWrites(getDB(env), tickOwner, Math.floor(Date.now() / 1000), writes, monitors);
    invalidateLive();
    if (alertEvents.length) await retryPending(env, Math.floor(Date.now() / 1000), externalBudget, 10);
    console.log(JSON.stringify({
      event: 'tick',
      checked: 0,
      agents: agentEntries.size,
      total: monitors.length,
      // Same as below: a held alert is correct silence, so count it.
      // 同下方：告警被暂缓时“没有通知”是正确的，故计数。
      ...(maintenance.suppressed ? { alerts_held: agentAlertEvents.length, maintenance: true } : {}),
    }));
    return;
  }

  /**
   * Every push monitor's last heartbeat, in one primary-key read.
   * Unconditional so the loop needs no second "which monitors are passive"
   * branch; this is also why the public push endpoint writes its own row
   * instead of `live_state`.
   * 一次读取所有 Push 心跳；公共端点写独立行而非 live_state。
   */
  const pushHeartbeats = await loadPushHeartbeats(env);

  /**
   * One snapshot per monitor: primary and add-ons run together so status, latency and add-ons describe the same minute.
   * Push is pure and takes the same downstream path. / 主检查与附加检查同批等待，保证三者属于同一分钟；Push 走相同下游路径。
   */
  const results = await mapConcurrent(probeDue, CONCURRENCY, async (m) => {
    /** Catch add-on failure on its own promise: `Promise.all` would reject the monitor and discard a successful primary. / 附加失败单独捕获，避免 Promise.all 丢弃已成功的主观测。 */
    const [primary, addons] = await Promise.all([
      monitorProbeSource(m).type === 'agent'
        ? Promise.resolve({
            status: agentProbeResults.get(m.id)!.status,
            latencyMs: agentProbeResults.get(m.id)!.latencyMs,
            statusCode: agentProbeResults.get(m.id)!.statusCode,
            message: agentProbeResults.get(m.id)!.message,
          })
        : m.type === 'push'
        ? checkPush(pushHeartbeats.get(m.id), m.interval_sec, now)
        : runCheck(m, externalBudget),
      monitorProbeSource(m).type === 'agent' ? Promise.resolve(agentProbeResults.get(m.id)!.addons) : runAddons(m, externalBudget, live[m.id]?.ssl).catch((error: unknown) => {
        console.error(JSON.stringify({ monitor: m.id, event: 'addon_check_failed', err: String(error) }));
        return {};
      }),
    ]);
    return { primary, addons };
  });
  await ensureOwned();

  const next: LiveState = {};
  for (const monitor of unknownSources) next[monitor.id] = preserveAvailability(unknownSourceEntry(monitor.id), live[monitor.id]);
  const nowSec = Math.floor(Date.now() / 1000);

  const maxRetries = (await readAll(env)).values['monitor.defaultRetries'] as number;
  const ring = new Map<string, RingHeartbeat>();

  /**
   * Agent entries merge ahead of probe writes, and their ring point uses the
   * same rollup verdict as `st`, so the chart and the badge cannot disagree.
   * Agent 记录先于探测写入合并；状态与环形点来自同一结论。
   */
  for (const [id, entry] of agentEntries) {
    next[id] = preserveAvailability(entry, live[id]);
    if (entry.ts <= 0) continue;
    ring.set(id, {
      t: Math.floor(now / 60) * 60,
      up: entry.st,
      ms: entry.v == null ? null : Math.round(entry.v * 100) / 100,
    });
  }

  /**
   * Collect notifications in the loop, send after it.
   *
   * They are produced by the same branch that writes the event row, so an event
   * and its notification cannot disagree. Sending afterwards gives one bounded
   * fan-out and keeps a slow provider from delaying `live_state`.
   * 通知与事件同一分支产生；循环后统一发送，慢渠道不阻塞 live_state。
   */
  const notifyEvents: NotifyEvent[] = [];
  const eventWrites: { sql: string; params: unknown[] }[] = [];
  const consumedProbeRuns: string[] = [];
  for (const alert of agentAlerts) notifyEvents.push(agentAlertEvent(alert));

  const historyPoints: Heartbeat[] = [];

  /**
   * First check, budget exhausted.
   *
   * There is no previous reading to keep, so the entry says what happened:
   * PENDING, no latency, `ts: 0`, and a message naming the budget, not the target.
   * 首次检查预算耗尽：PENDING、无延迟、`ts: 0`，消息说明预算而非目标。
   */
  const budgetSkippedEntry = (monitorId: string): LiveEntry => ({
    st: PENDING,
    ts: 0,
    v: null,
    code: 0,
    msg: WORKER_BUDGET_MSG,
    fails: 0,
    ...(live[monitorId]?.source_last_observed_at !== undefined
      ? { source_last_observed_at: live[monitorId]!.source_last_observed_at }
      : {}),
    ...(live[monitorId]?.source_run_id ? { source_run_id: live[monitorId]!.source_run_id } : {}),
  });

  const incompleteCheckEntry = (monitorId: string, reason: unknown): LiveEntry => {
    const previous = live[monitorId];
    const fails = (previous?.fails ?? 0) + 1;
    const settled = fails >= maxRetries;
    const detail = reason instanceof Error ? reason.message : String(reason);
    return {
      st: settled ? DOWN : previous?.st ?? PENDING,
      ts: nowSec,
      v: previous?.v ?? null,
      code: previous?.code ?? 0,
      msg: `${CHECK_INCOMPLETE_PREFIX}: ${detail}`.slice(0, 512),
      fails,
      ...(previous?.stable_st !== undefined ? { stable_st: previous.stable_st } : {}),
    };
  };

  for (let i = 0; i < probeDue.length; i++) {
    const m = probeDue[i];
    const r = results[i];
    if (r.status !== 'fulfilled') {
      if (r.reason instanceof ExternalBudgetExceeded) {
        /**
         * No budget, not an outage: keep `st`, `ts`, `v` and `fails` whole so retry
         * counts and UP state survive. `source_available` stays untouched because it
         * answers a different question; `unknownSourceEntry` would zero `fails` and
         * reset `ts`. Leaving `ts` also makes the next tick retry.
         * 预算耗尽不是故障：完整保留上次观测，source_available 不变，下一轮继续重试。
         */
        if (!live[m.id]) next[m.id] = budgetSkippedEntry(m.id);
        continue;
      }
      console.error(JSON.stringify({ monitor: m.id, event: 'check_failed', err: String(r.reason) }));
      const entry = incompleteCheckEntry(m.id, r.reason);
      next[m.id] = preserveAvailability(entry, live[m.id]);
      /** Nothing measured: no heartbeat or history point, but a real transition still fires. / 没有实际测量：不写心跳和历史点，但真实状态变化仍触发。 */
      const transition = transitionWrites(env, m, live[m.id], entry, {}, nowSec, maxRetries);
      eventWrites.push(...transition.rows);
      notifyEvents.push(...transition.notify);
      continue;
    }

    const { primary, addons } = r.value;
    const source = monitorProbeSource(m);
    if (source.type === 'worker' && isWorkerCapacityError(primary.message)) {
      /** Same as a thrown budget: keep the previous reading, or PENDING on first sighting. / 与抛出预算相同：保留上次观测，首次则写 PENDING。 */
      if (!live[m.id]) next[m.id] = budgetSkippedEntry(m.id);
      continue;
    }
    if (source.type === 'agent') {
      const observation = agentProbeResults.get(m.id);
      if (observation) consumedProbeRuns.push(observation.runId);
    }
    const { entry, heartbeat } = buildReading(primary, addons, live[m.id], nowSec, { maxRetries: m.type === 'push' ? 0 : maxRetries, recordLatency: m.type !== 'push' });
    const observation = agentProbeResults.get(m.id);
    if (observation) {
      entry.source_available = true;
      entry.source_last_observed_at = observation.observedAt;
      entry.source_run_id = observation.runId;
    }

    next[m.id] = preserveAvailability(entry, live[m.id]);
    ring.set(m.id, heartbeat);

    /** Report missing AE history once per tick, not once per monitor. / AE 历史缺失每 tick 报告一次，不按监控重复。 */
    historyPoints.push({
      monitorId: m.id,
      ts: nowSec,
      status: entry.st,
      latencyMs: heartbeat.ms ?? 0,
      statusCode: primary.statusCode,
      message: primary.message,
      addons,
    });

    const transition = transitionWrites(env, m, live[m.id], entry, addons, nowSec, maxRetries);
    eventWrites.push(...transition.rows);
    notifyEvents.push(...transition.notify);
  }

  const completedDays = recordAvailability(next, ring);

  // Commit current state, recent history, transitions and outbox as one write set.
  // 将当前状态、近期历史、状态变化和发件箱作为一个写入集合提交。
  await ensureOwned();
  const db = getDB(env);
  const alertEvents = applyMaintenanceToAlerts(monitors, live, next, notifyEvents, maintenance.suppressed, nowSec);
  const outbox = await prepareNotificationOutbox(env, alertEvents, nowSec);
  const commitWrites = [
    { sql: liveStateSQL[db.type].merge, params: ['all', JSON.stringify(next), nowSec] },
    ...await prepareAvailabilityDayWrites(env, completedDays, nowSec),
    ...await prepareHeartbeatWrites(env, ring, live),
    ...eventWrites,
    ...agentAlerts.map((alert) => ({
      sql: eventsSQL[db.type].insert,
      params: [alert.monitor.id, alert.status, alert.message.slice(0, 512), alert.at],
    })),
    ...consumedProbeRuns.map((runId) => ({
      sql: db.type === 'postgres'
        ? "UPDATE agent_probe_jobs SET consumed_at=$1 WHERE run_id=$2 AND state='completed' AND consumed_at IS NULL"
        : "UPDATE agent_probe_jobs SET consumed_at=? WHERE run_id=? AND state='completed' AND consumed_at IS NULL",
      params: [nowSec, runId],
    })),
    ...outbox,
  ];
  await commitTickWrites(getDB(env), tickOwner, Math.floor(Date.now() / 1000), commitWrites, monitors);
  invalidateLive();
  if (!env.UPTIME && historyPoints.length > 0) {
    console.log(JSON.stringify({
      event: 'history_disabled',
      reason: 'no Analytics Engine binding; live status still updates, history does not',
    }));
  } else {
    writeHeartbeatBatch(env, historyPoints, nowSec);
  }

  /** Send eligible outbox notifications after live state, history and transitions commit together. / 实时状态、历史和状态变化一起提交后，发送符合条件的发件箱通知。 */
  await ensureOwned();
  if (notifyEvents.length > 0) await retryPending(env, nowSec, externalBudget, 10);

  console.log(
    JSON.stringify({
      event: 'tick',
      checked: probeDue.length,
      agents: agentEntries.size,
      total: monitors.length,
      /**
       * Report held alerts: during maintenance, silence is correct, so the count is
       * the only thing that distinguishes a working window from broken delivery.
       * 上报暂缓告警；计数用于区分维护窗口正常与投递故障。
       */
      ...(maintenance.suppressed ? { alerts_held: notifyEvents.length, maintenance: true } : {}),
    }),
  );
}

export type MonitorCheckOutcome =
  | {
      status: 'checked';
      /** The primary checker's raw verdict. / 主检查器的原始结论。 */
      result: CheckResult;
      /** The entry as persisted, which folds in add-ons and the retry budget. / 已持久化的记录，合并了附加检查和重试预算。 */
      entry: LiveEntry;
      /** The ring point written for this check; absent when the checker threw. / 此次检查写入的环形点；检查器抛错时不存在。 */
      heartbeat?: RingHeartbeat;
      /** True when a status transition was appended to `events`. / 状态变化已追加到 `events` 时为 true。 */
      event: boolean;
      /** True when an alert row was queued for delivery. / 告警记录已入队等待投递时为 true。 */
      notified: boolean;
      /** True when a maintenance window held the alert. / 维护窗口暂缓告警时为 true。 */
      maintenance: boolean;
    }
  | { status: 'refused'; reason: 'push' | 'agent' | 'agent_source' }
  | { status: 'budget_exhausted' }
  | { status: 'superseded' };

export async function runMonitorCheck(env: Env, monitor: Monitor): Promise<MonitorCheckOutcome> {
  try {
    return await runMonitorCheckSnapshot(env, monitor);
  } catch (error) {
    if (error instanceof MonitorChanged) return { status: 'superseded' };
    throw error;
  }
}

async function runMonitorCheckSnapshot(env: Env, monitor: Monitor): Promise<MonitorCheckOutcome> {
  /**
   * Push waits to be contacted; agent sources report asynchronously. Neither has
   * a synchronous check, and running one from the Worker would bypass the source
   * the operator chose or invent a verdict.
   * Push 与 Agent 来源都没有同步检查；不能凭空判定或绕过所选来源。
   */
  if (monitor.type === 'push') return { status: 'refused', reason: 'push' };
  if (monitor.type === 'agent') return { status: 'refused', reason: 'agent' };
  if (monitorProbeSource(monitor).type === 'agent') return { status: 'refused', reason: 'agent_source' };

  const budget = new ExternalRequestBudget();
  let primary: CheckResult;
  let addons: { ssl?: AddonReading; domain?: AddonReading; dns?: DnsAddonReading };
  try {
    const previousSsl = monitor.check_ssl ? (await loadLiveFresh(env))[monitor.id]?.ssl : undefined;
    /** Primary and add-ons share one settings snapshot; keep add-on failure isolated. / 主检查与附加检查共用设置快照；附加失败单独处理。 */
    [primary, addons] = await Promise.all([
      runCheck(monitor, budget),
      runAddons(monitor, budget, previousSsl).catch((error: unknown) => {
        console.error(JSON.stringify({ monitor: monitor.id, event: 'addon_check_failed', err: String(error) }));
        return {};
      }),
    ]);
  } catch (error) {
    /**
     * Budget exhausted before the check: write nothing. Unlike a tick, there is no
     * other monitor to protect, and a fabricated PENDING/DOWN would be a verdict
     * the check never reached.
     * 检查前预算耗尽：没有结论，不写数据。
     */
    if (error instanceof ExternalBudgetExceeded) return { status: 'budget_exhausted' };
    console.error(JSON.stringify({ monitor: monitor.id, event: 'check_failed', err: String(error) }));

    /**
     * Checker threw: keep the last status and climb `fails`, matching the tick
     * path so the badge and the eventual DOWN transition cannot disagree.
     * 检查器抛错：保留上次状态并累加 fails，与 tick 路径一致。
     */
    const nowSec = Math.floor(Date.now() / 1000);
    const live = await loadLiveFresh(env);
    const prev = live[monitor.id];
    const maintenance = await alertsSuppressed(env, new Date(nowSec * 1000));
    const maxRetries = (await readAll(env)).values['monitor.defaultRetries'] as number;
    const fails = (prev?.fails ?? 0) + 1;
    const settled = fails >= maxRetries;
    const detail = error instanceof Error ? error.message : String(error);
    const entry: LiveEntry = {
      st: settled ? DOWN : prev?.st ?? PENDING,
      ts: nowSec,
      v: prev?.v ?? null,
      code: prev?.code ?? 0,
      msg: `${CHECK_INCOMPLETE_PREFIX}: ${detail}`.slice(0, 512),
      fails,
      ...(prev?.stable_st !== undefined ? { stable_st: prev.stable_st } : {}),
    };
    const preserved = preserveAvailability(entry, prev);
    const eventWrites = transitionWrites(env, monitor, prev, preserved, {}, nowSec, maxRetries);
    const alertEvents = eventWrites.notify;
    const queueable = applyMaintenanceToAlerts([monitor], live, { [monitor.id]: preserved }, alertEvents, maintenance.suppressed, nowSec);
    const db = getDB(env);
    const outbox = await prepareNotificationOutbox(env, queueable, nowSec);
    await commitMonitorWrites(db, monitor, nowSec, [
      { sql: liveStateSQL[db.type].merge, params: ['all', JSON.stringify({ [monitor.id]: preserved }), nowSec] },
      ...eventWrites.rows,
      ...outbox,
    ]);
    invalidateLive();
    if (queueable.length) await retryPending(env, nowSec, budget, 10);
    return {
      status: 'checked',
      result: { status: preserved.st, latencyMs: preserved.v ?? 0, statusCode: preserved.code, message: preserved.msg },
      entry: preserved,
      event: eventWrites.rows.length > 0,
      notified: outbox.length > 0,
      maintenance: maintenance.suppressed,
    };
  }

  if (isWorkerCapacityError(primary.message)) return { status: 'budget_exhausted' };

  const nowSec = Math.floor(Date.now() / 1000);
  /** Read after the probe so a concurrent tick cannot cost a minute of availability. / 探测后读取，避免并发 tick 丢失一分钟可用率。 */
  const live = await loadLiveFresh(env);
  const prev = live[monitor.id];
  const maintenance = await alertsSuppressed(env, new Date(nowSec * 1000));
  const maxRetries = (await readAll(env)).values['monitor.defaultRetries'] as number;

  const { entry, heartbeat } = buildReading(primary, addons, prev, nowSec, { maxRetries });
  const preserved = preserveAvailability(entry, prev);
  const ring = new Map([[monitor.id, heartbeat]]);
  const completedDays = recordAvailability({ [monitor.id]: preserved }, ring);
  const eventWrites = transitionWrites(env, monitor, prev, preserved, addons, nowSec, maxRetries);
  const queueable = applyMaintenanceToAlerts([monitor], live, { [monitor.id]: preserved }, eventWrites.notify, maintenance.suppressed, nowSec);

  const db = getDB(env);
  const outbox = await prepareNotificationOutbox(env, queueable, nowSec);
  await commitMonitorWrites(db, monitor, nowSec, [
    { sql: liveStateSQL[db.type].merge, params: ['all', JSON.stringify({ [monitor.id]: preserved }), nowSec] },
    ...await prepareAvailabilityDayWrites(env, completedDays, nowSec),
    ...await prepareHeartbeatWrites(env, ring, live),
    ...eventWrites.rows,
    ...outbox,
  ]);
  invalidateLive();
  try {
    writeHeartbeat(env, {
      monitorId: monitor.id,
      ts: nowSec,
      status: preserved.st,
      latencyMs: heartbeat.ms ?? 0,
      statusCode: primary.statusCode,
      message: primary.message,
      addons,
    });
  } catch (error) {
    console.error(JSON.stringify({ event: 'history_write_failed', monitor: monitor.id, err: String(error) }));
  }
  if (queueable.length) await retryPending(env, nowSec, budget, 10);

  return {
    status: 'checked',
    result: primary,
    entry: preserved,
    heartbeat,
    event: eventWrites.rows.length > 0,
    notified: outbox.length > 0,
    maintenance: maintenance.suppressed,
  };
}

function transitionWrites(
  env: Env,
  monitor: Monitor,
  prev: LiveEntry | undefined,
  next: LiveEntry,
  addons: { ssl?: AddonReading; domain?: AddonReading; dns?: DnsAddonReading },
  nowSec: number,
  maxRetries: number,
): { rows: { sql: string; params: unknown[] }[]; notify: NotifyEvent[] } {
  if (prev ? prev.st === next.st : next.st !== DOWN && next.st !== WARN) return { rows: [], notify: [] };
  const message = transitionMessage(next.msg, addons, next.st, prev?.st ?? UP, { maxRetries });
  const db = getDB(env);
  const transition = notificationTransition(prev, next);
  return {
    rows: [{ sql: eventsSQL[db.type].insert, params: [monitor.id, next.st, message, nowSec] }],
    notify: transition
      ? [{
          monitorName: monitor.name,
          monitorTarget: monitor.target,
          monitorType: monitor.type,
          monitorId: monitor.id,
          status: transition.status,
          prevStatus: transition.prevStatus,
          message,
          statusCode: next.code,
          latencyMs: next.v,
          at: nowSec,
          groupId: monitor.group_id,
        }]
      : [],
  };
}

function agentAlertEvent(alert: Awaited<ReturnType<typeof rollupAgentMetrics>>['alerts'][number]): NotifyEvent {
  return { monitorName: alert.monitor.name, monitorTarget: alert.monitor.target, monitorType: 'agent', monitorId: alert.monitor.id, eventKey: alert.phase === 'liveness' ? `${alert.prevStatus}->${alert.status}` : `resource:${alert.rule}:${alert.phase}`, status: alert.status, prevStatus: alert.prevStatus, message: alert.message, at: alert.at, groupId: alert.monitor.group_id };
}

function applyMaintenanceToAlerts(
  monitors: Monitor[],
  previous: LiveState,
  next: LiveState,
  events: NotifyEvent[],
  suppressed: boolean,
  now: number,
): NotifyEvent[] {
  const notifications = events.filter((event) => !(previous[event.monitorId!]?.alert_pending && event.status === UP));
  const notified = new Set(notifications.map((event) => event.monitorId));
  for (const monitor of monitors) {
    const entry = next[monitor.id];
    if (!entry) continue;
    const pending = previous[monitor.id]?.alert_pending === true;
    if (entry.st === UP) {
      delete entry.alert_pending;
    } else if (suppressed) {
      if (pending || notified.has(monitor.id)) entry.alert_pending = true;
    } else if (pending) {
      if (entry.st === PENDING || entry.ts <= 0) {
        entry.alert_pending = true;
        continue;
      }
      delete entry.alert_pending;
      if (!notified.has(monitor.id)) notifications.push({
        monitorName: monitor.name,
        monitorTarget: monitor.target,
        monitorType: monitor.type,
        monitorId: monitor.id,
        status: entry.st,
        message: entry.msg,
        at: now,
        eventKey: 'maintenance-ended',
        statusCode: entry.code,
        latencyMs: entry.v,
        groupId: monitor.group_id,
      });
    }
  }
  return suppressed ? [] : notifications;
}

export function buildReading(
  primary: CheckResult,
  addons: { ssl?: AddonReading; domain?: AddonReading; dns?: DnsAddonReading },
  prev: LiveEntry | undefined,
  nowSec: number,
  opts?: { maxRetries?: number; recordLatency?: boolean },
): { entry: LiveEntry; heartbeat: RingHeartbeat } {
  const maxRetries = opts?.maxRetries ?? MAX_RETRIES;
  const fails = primary.status === DOWN ? (prev?.fails ?? 0) + 1 : 0;
  const hasWarning = primary.status === WARN ||
    [addons.ssl, addons.domain, addons.dns].some((addon) => addon && addon.st !== UP);
  let st: Status;
  if (primary.status === DOWN && fails >= maxRetries) st = DOWN;
  else if (hasWarning) st = WARN;
  else if (primary.status === DOWN) st = PENDING;
  else st = UP;

  const entry: LiveEntry = {
    st,
    ts: nowSec,
    v: opts?.recordLatency === false ? null : Math.round(primary.latencyMs * 100) / 100,
    code: primary.statusCode,
    msg: primary.message.slice(0, 512),
    fails,
    stable_st: st === PENDING
      ? (prev?.st === PENDING ? stableStatus(prev.stable_st) ?? addonStableStatus(prev) : stableStatus(prev?.st) ?? UP)
      : st,
    ...(addons.ssl ? { ssl: addons.ssl } : {}),
    ...(addons.domain ? { domain: addons.domain } : {}),
    ...(addons.dns ? { dns: addons.dns } : {}),
  };
  return { entry, heartbeat: { t: nowSec, up: st, ms: opts?.recordLatency === false ? null : Math.round(primary.latencyMs) } };
}

/** Use the add-on message when it caused the worse status; otherwise the primary. / 附加检查导致状态恶化时用其消息，否则用主检查消息。 */
export function transitionMessage(
  primaryMsg: string,
  addons: { ssl?: AddonReading; domain?: AddonReading; dns?: DnsAddonReading },
  next: Status,
  prev: Status,
  /** Resolved retry budget; falls back to `MAX_RETRIES`. / 解析后的重试预算，缺省用 `MAX_RETRIES`。 */
  opts?: { maxRetries?: number },
): string {
  const maxRetries = opts?.maxRetries ?? MAX_RETRIES;
  /** DNS is WARN-capped, so it never matches the DOWN test below. / DNS 上限为 WARN，不会命中下方 DOWN 判断。 */
  const blamed = next === WARN
    ? [addons.ssl, addons.domain].find((a) => a && a.st !== UP)
    : [addons.ssl, addons.domain].find((a) => a && a.st === DOWN);
  const base = (blamed?.msg || primaryMsg).slice(0, 512);

  /** PENDING events are diagnostic only and never notify; text stays English because every locale reads it. / PENDING 只写诊断事件、不发通知；所有语言都会读取，故用英语。 */
  if (next === PENDING) {
    return `${prev === UP ? 'first failure' : 'still failing'}, retrying: ${base}`.slice(0, 512);
  }
  if (prev === PENDING && next === DOWN) {
    return `gave up after ${maxRetries} retries: ${base}`.slice(0, 512);
  }
  return base;
}

export function initialLive(): LiveEntry {
  return { st: DOWN, ts: 0, v: 0, code: 0, msg: '', fails: 0 };
}

function addonStableStatus(entry: LiveEntry): 0 | 1 | 2 {
  return entry.ssl?.st !== undefined && entry.ssl.st !== UP ||
    entry.domain?.st !== undefined && entry.domain.st !== UP ||
    entry.dns?.st !== undefined && entry.dns.st !== UP ? WARN : UP;
}

function stableStatus(status: number | undefined): 0 | 1 | 2 | undefined {
  return status === UP || status === WARN || status === DOWN ? status : undefined;
}

export function notificationTransition(
  prev: LiveEntry | undefined,
  next: LiveEntry,
): { status: 0 | 1 | 2; prevStatus: 0 | 1 | 2 } | null {
  if (next.st === PENDING) return null;
  const stableNext = stableStatus(next.st);
  if (stableNext === undefined) return null;
  const stablePrev = prev?.st === PENDING
    ? stableStatus(prev.stable_st) ?? addonStableStatus(prev)
    : stableStatus(prev?.st) ?? UP;
  if (stablePrev === stableNext) return null;
  if (stableNext === DOWN || stableNext === WARN || stablePrev === DOWN || stablePrev === WARN) {
    return { status: stableNext, prevStatus: stablePrev };
  }
  return null;
}
