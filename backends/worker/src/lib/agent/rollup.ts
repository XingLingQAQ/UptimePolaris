import { DOWN, PENDING, UP, WARN, parseOptions, type AgentOptions, type Env, type LiveEntry, type LiveState, type MachineLive, type Monitor } from '../../types';
import { getDB } from '../db/factory';
import { agentLiveSQL } from '../db/sql/agent';
import { agentIsOnline, agentStaleAfterSec } from './liveness';

export { AGENT_STALE_SEC, agentIsOnline, agentStaleAfterSec } from './liveness';

export interface AgentRollupResult {
  entries: Map<string, LiveEntry>;
  alerts: { monitor: Monitor; rule: string; phase: 'entry' | 'recovery' | 'liveness'; status: 0 | 1 | 2; prevStatus: 0 | 1 | 2; message: string; at: number }[];
}

/** 汇总 Agent 在线状态、资源告警和每分钟可用性。 / Aggregate Agent liveness, resource alerts, and per-minute availability. */
export async function rollupAgentMetrics(env: Env, now: number, previousLiveState?: LiveState): Promise<AgentRollupResult> {
  const db = getDB(env);
  const monitors = await db.query<Monitor>("SELECT * FROM monitors WHERE type='agent' AND active=1");
  const rows = await db.query<MachineLive & {
    agent_active: number;
    report_interval_secs: number | null;
    version: string | null;
  }>(agentLiveSQL[db.type].allLive);
  const byId = new Map(rows.map((row) => [row.agent_id, row]));
  const entries = new Map<string, LiveEntry>();
  const alerts: AgentRollupResult['alerts'] = [];

  for (const monitor of monitors) {
    const live = byId.get(monitor.agent_id ?? '');
    if (!live || live.reported_at === null) {
      entries.set(monitor.id, { st: PENDING, ts: 0, v: 0, code: 0, msg: 'waiting for first agent report', fails: 0 });
      continue;
    }
    const staleAfterSec = agentStaleAfterSec(live.report_interval_secs);
    const online = live.agent_active === 1 && agentIsOnline(live.reported_at, now, staleAfterSec) === true;
    const age = Math.max(0, now - live.reported_at);
    const previous = previousLiveState?.[monitor.id];
    const options = parseOptions<AgentOptions>(monitor.options_json);
    const alertState = { ...(previous?.resource_alerts ?? {}) };
    const resourceValues: Record<string, number | null> = {
      cpu: live.cpu_usage,
      memory: live.mem_total && live.mem_total > 0 && live.mem_used != null ? live.mem_used / live.mem_total * 100 : null,
      disk: live.disk_total && live.disk_total > 0 && live.disk_used != null ? live.disk_used / live.disk_total * 100 : null,
      load: live.load_1,
    };
    let resourceWarn = false;
    if (!online) {
      for (const key of Object.keys(alertState)) delete alertState[key];
    } else {
      const configured = Object.entries(options.alerts ?? {}).filter(([, rule]) => rule?.enabled);
      const enabledRules = new Set(configured.map(([rule]) => rule));
      for (const rule of Object.keys(alertState)) if (!enabledRules.has(rule)) delete alertState[rule];
      for (const [rule, threshold] of configured) {
        if (applyResourceRule(monitor, { ...live, reported_at: live.reported_at }, rule, threshold, resourceValues[rule], alertState, alerts)) resourceWarn = true;
      }
    }
    const entry: LiveEntry = {
      st: online ? resourceWarn ? WARN : UP : DOWN,
      ts: live.reported_at,
      v: online ? live.cpu_usage : null,
      code: 0,
      msg: online ? resourceWarn ? 'agent resource threshold exceeded' : (live.message ?? '').slice(0, 512) : `agent not reporting for ${age}s`,
      fails: 0,
      resource_alerts: alertState,
    };
    entries.set(monitor.id, entry);
    if ((!previous || previous.ts === 0) ? !online : online !== (previous.st !== DOWN)) {
      alerts.push({
        monitor, rule: 'liveness', phase: 'liveness', status: online ? UP : DOWN,
        prevStatus: previous?.st === WARN || previous?.st === DOWN ? previous.st : UP,
        message: online ? 'agent reporting resumed' : entry.msg,
        at: now,
      });
    }
    for (const alert of alerts.filter((item) => item.monitor.id === monitor.id && item.phase !== 'liveness')) {
      if (alert.phase === 'recovery') alert.status = resourceWarn ? WARN : UP;
      else alert.prevStatus = previous?.st === WARN ? WARN : UP;
    }
  }

  return { entries, alerts };
}

function applyResourceRule(monitor: Monitor, live: MachineLive & { reported_at: number; report_interval_secs: number | null }, rule: string, threshold: NonNullable<AgentOptions['alerts']>['cpu'], value: number | null | undefined, states: NonNullable<LiveEntry['resource_alerts']>, alerts: AgentRollupResult['alerts']): boolean {
  if (!threshold?.enabled) { delete states[rule]; return false; }
  if (value == null || !Number.isFinite(value)) {
    if (states[rule]?.active) {
      states[rule] = { ...states[rule], since: 0, observed_at: 0 };
    } else delete states[rule];
    return states[rule]?.active === true;
  }
  const state = states[rule];
  const priorObserved = state?.observed_at ?? 0;
  // 同一份上报可能被多个 tick 读取，不能重复推进持续时间。
  // Multiple ticks may read the same report; do not advance duration twice.
  if (priorObserved === live.reported_at) {
    return state?.active === true;
  }
  const continuous = priorObserved > 0 && live.reported_at > priorObserved && live.reported_at - priorObserved <= Math.max(60, (live.report_interval_secs ?? 30) * 2);
  const active = state?.active === true;
  // 已触发的告警使用恢复阈值，避免数值在边界附近反复切换。
  // Active alerts use the recovery threshold to avoid flapping at the boundary.
  const breached = value >= (active ? threshold.threshold * threshold.recovery_pct / 100 : threshold.threshold);
  if (!breached) {
    if (active) alerts.push({ monitor, rule, phase: 'recovery', status: UP, prevStatus: WARN, message: `${rule} recovered to ${value.toFixed(1)}`, at: live.reported_at });
    if (active && state) states[rule] = { since: 0, last_alert: state.last_alert, active: false, observed_at: live.reported_at };
    else delete states[rule];
    return false;
  }
  const since = continuous && state?.since ? state.since : live.reported_at;
  const sustained = live.reported_at - since >= threshold.duration_sec;
  states[rule] = { since, last_alert: state?.last_alert ?? 0, active: active || sustained, observed_at: live.reported_at };
  if (sustained && !active) {
    states[rule].last_alert = live.reported_at;
    alerts.push({ monitor, rule, phase: 'entry', status: WARN, prevStatus: UP, message: `${rule} ${value.toFixed(1)} exceeded ${threshold.threshold}`, at: live.reported_at });
  }
  return states[rule]?.active === true;
}
