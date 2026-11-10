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
  /** Monitors this agent is the probe source for. / 以此 Agent 为探测来源的监控。 */
  probe_targets: AgentProbeTarget[];
  /** The most recent probe runs, newest first. / 最近的探测运行记录，最新的排在前面。 */
  probe_jobs: AgentProbeJobRow[];
  /** Per-machine credential, exposed only by the authenticated detail route. / 每台机器的凭据，仅通过需认证的详情路由返回。 */
  install: { token: string } | null;
}

const RESOURCES: readonly AlertResource[] = ['cpu', 'memory', 'disk', 'load'];

const d1 = {
  monitor: "SELECT id, options_json, token FROM agents WHERE id = ?",
  history: `SELECT (bucket_ts / 300) * 300 AS ts,
                  AVG(cpu_avg) AS cpu, AVG(mem_pct_avg) AS mem_pct,
                  AVG(net_up_bytes) AS net_up, AVG(net_down_bytes) AS net_down
             FROM machine_history
            WHERE agent_id = ? AND bucket_ts >= ? AND quality = 'aggregate'
            GROUP BY (bucket_ts / 300)
            ORDER BY ts DESC
            LIMIT 288`,
} as const;

type DetailSQL = { [K in keyof typeof d1]: string };

const postgres: DetailSQL = {
  monitor: "SELECT id, options_json, token FROM agents WHERE id = $1",
  // AVG(bigint) is numeric on PG and arrives as a string; the caller converts.
  // PG 中 AVG(bigint) 的结果为 numeric，以字符串返回；由调用方转换。
  history: `SELECT (bucket_ts / 300) * 300 AS ts,
                  AVG(cpu_avg) AS cpu, AVG(mem_pct_avg) AS mem_pct,
                  AVG(net_up_bytes) AS net_up, AVG(net_down_bytes) AS net_down
             FROM machine_history
            WHERE agent_id = $1 AND bucket_ts >= $2 AND quality = 'aggregate'
            GROUP BY (bucket_ts / 300)
            ORDER BY ts DESC
            LIMIT 288`,
};

const detailSQL: Record<'d1' | 'postgres', DetailSQL> = {
  d1,
  postgres,
};

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
    detailSQL[db.type].monitor,
    [agentId],
  );
  if (!monitor) return null;

  const agent = (await loadFleet(env, now)).find((row) => row.id === agentId);
  if (!agent) return null;

  const monitors = await db.query<{ id: string; name: string; options_json: string }>(
    db.type === 'postgres' ? "SELECT id,name,options_json FROM monitors WHERE agent_id=$1 AND type='agent'" : "SELECT id,name,options_json FROM monitors WHERE agent_id=? AND type='agent'", [agentId]);
  const liveState: LiveState = monitors.length ? await loadLiveFresh(env) : {};

  const [rows, probeTargets, probeJobs] = await Promise.all([
    db.query<Record<string, unknown>>(detailSQL[db.type].history, [agentId, now - 86_400]),
    loadAgentProbeTargets(env, agentId),
    // One screenful. The full history is a diagnostic endpoint of its own, and
    // a dialog that rendered hundreds of rows would be unreadable anyway.
    // 只取一屏数据。完整历史有独立的诊断端点，弹窗显示数百行也难以阅读。
    loadAgentProbeJobs(env, agentId, 12),
  ]);

  // Selected newest-first so the cap keeps the most recent 288 buckets.
  // 按最新优先选择，使上限保留最近的 288 个时间桶。
  const history = rows.reverse().map((row) => ({
    ts: toNumber(row.ts) ?? 0,
    cpu: toNumber(row.cpu),
    mem_pct: toNumber(row.mem_pct),
    net_up: toNumber(row.net_up),
    net_down: toNumber(row.net_down),
  }));

  return {
    agent,
    mounts: agent.mounts,
    interfaces: agent.interfaces,
    alerts: monitors.flatMap(row => alertRules(parseOptions<AgentOptions>(row.options_json), liveState, row)),
    history,
    probe_targets: probeTargets,
    probe_jobs: probeJobs,
    install: { token: monitor.token },
  };
}
