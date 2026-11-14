import type { HistoryStatus } from '../../../../../shared/contracts';
import { loadAgentDaily, queryAgentHistory, type AgentHistoryBucket } from './history';
/** Agent detail: fleet row, mounts, interfaces, alert rules, a day of history. / Agent 详情：集群记录、挂载点、网卡、告警规则及一天的历史。 */

import { parseOptions, type AgentOptions, type Env, type LiveState } from '../../types';
import { getDB } from '../db/factory';
import { loadLiveFresh } from '../monitor/store';
import { loadFleet, type FleetAgent } from './fleet';
import { loadAgentProbeJobs, loadAgentProbeTargets, type AgentProbeJobRow, type AgentProbeTarget } from './probe-jobs';

export type AlertResource = 'cpu' | 'memory' | 'disk' | 'load';

export interface AgentAlertRule {
  monitor_id: string;
  monitor_name: string;
  resource: AlertResource;
  enabled: boolean;
  threshold: number;
  duration_sec: number;
  active: boolean;
}

export interface AgentHistoryPoint {
  ts: number;
  cpu: number | null;
  mem_pct: number | null;
  net_up: number | null;
  net_down: number | null;
}

export interface AgentDetail {
  agent: FleetAgent;
  mounts: FleetAgent['mounts'];
  interfaces: FleetAgent['interfaces'];
  alerts: AgentAlertRule[];
  history: AgentHistoryPoint[];
  history_status: HistoryStatus;
  history_sampled: boolean;
  history_daily: AgentHistoryPoint[];
  history_daily_sampled: boolean;
  /** Monitors this agent is the probe source for. / 以此 Agent 为探测来源的监控。 */
  probe_targets: AgentProbeTarget[];
  /** The most recent probe runs, newest first. / 最近的探测运行记录，最新的排在前面。 */
  probe_jobs: AgentProbeJobRow[];
  /** Per-machine credential, exposed only by the authenticated detail route. / 每台机器的凭据，仅通过需认证的详情路由返回。 */
  install: { token: string } | null;
}

const RESOURCES: readonly AlertResource[] = ['cpu', 'memory', 'disk', 'load'];

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function alertRules(options: AgentOptions, liveState: LiveState, monitor: { id: string; name: string }): AgentAlertRule[] {
  const configured = options.alerts;
  if (typeof configured !== 'object' || configured === null) return [];
  const state = liveState[monitor.id]?.resource_alerts;
  const out: AgentAlertRule[] = [];
  for (const resource of RESOURCES) {
    const rule = configured[resource];
    if (typeof rule !== 'object' || rule === null) continue;
    out.push({
      monitor_id: monitor.id,
      monitor_name: monitor.name,
      resource,
      enabled: rule.enabled === true,
      threshold: toNumber(rule.threshold) ?? 0,
      duration_sec: toNumber(rule.duration_sec) ?? 0,
      active: state?.[resource]?.active === true,
    });
  }
  return out;
}

/** Null when the id is not an agent monitor. / ID 不是 Agent 监控时返回 null。 */
export async function loadAgentDetail(env: Env, agentId: string, now: number): Promise<AgentDetail | null> {
  const db = getDB(env);
  const monitor = await db.queryOne<{ id: string; options_json: string | null; token: string }>(
    db.type === 'postgres' ? "SELECT id, options_json, token FROM agents WHERE id = $1" : "SELECT id, options_json, token FROM agents WHERE id = ?",
    [agentId],
  );
  if (!monitor) return null;

  const agent = (await loadFleet(env, now)).find((row) => row.id === agentId);
  if (!agent) return null;

  const monitors = await db.query<{ id: string; name: string; options_json: string }>(
    db.type === 'postgres' ? "SELECT id,name,options_json FROM monitors WHERE agent_id=$1 AND type='agent'" : "SELECT id,name,options_json FROM monitors WHERE agent_id=? AND type='agent'", [agentId]);
  const liveState: LiveState = monitors.length ? await loadLiveFresh(env) : {};

  const [recent, daily, probeTargets, probeJobs] = await Promise.all([
    queryAgentHistory(env, agentId, now - 86_400, now),
    loadAgentDaily(env, agentId),
    loadAgentProbeTargets(env, agentId),
    // One screenful. The full history is a diagnostic endpoint of its own, and
    // a dialog that rendered hundreds of rows would be unreadable anyway.
    // 只取一屏数据。完整历史有独立的诊断端点，弹窗显示数百行也难以阅读。
    loadAgentProbeJobs(env, agentId, 12),
  ]);

  const history = aggregateAgentHistory(recent.points);

  return {
    agent,
    mounts: agent.mounts,
    interfaces: agent.interfaces,
    alerts: monitors.flatMap(row => alertRules(parseOptions<AgentOptions>(row.options_json), liveState, row)),
    history,
    history_status: recent.status,
    history_sampled: recent.sampled,
    history_daily: daily.map(day => ({ ts: Date.parse(`${day.d}T00:00:00Z`) / 1000, cpu: day.cpu_avg, mem_pct: day.mem_pct_avg,
      net_up: day.network_duration_sec && day.net_up_bytes != null ? day.net_up_bytes / day.network_duration_sec : null,
      net_down: day.network_duration_sec && day.net_down_bytes != null ? day.net_down_bytes / day.network_duration_sec : null })),
    history_daily_sampled: daily.some(day => day.sampled),
    probe_targets: probeTargets,
    probe_jobs: probeJobs,
    install: { token: monitor.token },
  };
}

export function aggregateAgentHistory(buckets: AgentHistoryBucket[]): AgentHistoryPoint[] {
  const groups = new Map<number, AgentHistoryBucket[]>();
  for (const point of buckets) {
    const ts = Math.floor(point.bucket_ts / 300) * 300;
    groups.set(ts, [...(groups.get(ts) ?? []), point]);
  }
  return [...groups].sort(([a], [b]) => a - b).slice(-288).map(([ts, rows]) => {
    const average = (field: 'cpu_avg' | 'mem_pct_avg', weight: 'cpu_samples' | 'mem_samples') => {
      let sum = 0, samples = 0;
      for (const row of rows) if (row[field] != null && row[weight] > 0) {
        sum += row[field]! * row[weight]; samples += row[weight];
      }
      return samples > 0 ? sum / samples : null;
    };
    const rate = (field: 'net_up_bytes' | 'net_down_bytes') => {
      let bytes = 0, seconds = 0;
      for (const row of rows) if (row[field] != null && row.network_duration_sec != null && row.network_duration_sec > 0) {
        bytes += row[field]!; seconds += row.network_duration_sec;
      }
      return seconds > 0 ? bytes / seconds : null;
    };
    return { ts, cpu: average('cpu_avg', 'cpu_samples'), mem_pct: average('mem_pct_avg', 'mem_samples'), net_up: rate('net_up_bytes'), net_down: rate('net_down_bytes') };
  });
}
