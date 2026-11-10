import { isActiveProbeType, type ActiveProbeType } from '../../../../../shared/probe-capabilities';
/** Read-only diagnostics for agent probe jobs: assigned monitors and recent runs. / Agent 探测任务的只读诊断：分配的监控和最近运行。 */

import type { Env } from '../../types';
import { getDB } from '../db/factory';

/** One monitor this agent is the probe source for. / 以此 Agent 为探测来源的一个监控。 */
export interface AgentProbeTarget {
  monitor_id: string;
  num_id: number;
  name: string;
  type: ActiveProbeType;
  target: string;
  interval_sec: number;
  active: boolean;
}

/** One recent job, as the dialog shows it. / 弹窗展示的一条近期任务。 */
export interface AgentProbeJobRow {
  run_id: string;
  monitor_id: string;
  monitor_name: string | null;
  probe_type: string;
  state: 'pending' | 'leased' | 'completed' | 'expired';
  attempts: number;
  scheduled_at: number;
  completed_at: number | null;
  latency_ms: number | null;
  status: number | null;
  message: string | null;
}

export interface AgentProbeReport {
  targets: AgentProbeTarget[];
  jobs: AgentProbeJobRow[];
}

/** Monitors whose `check_source` names this agent; parsed in JS to avoid dialect JSON differences. / 检查源指向此机器的监控；在 JS 中解析以避开方言差异。 */
export async function loadAgentProbeTargets(env: Env, agentId: string): Promise<AgentProbeTarget[]> {
  const db = getDB(env);
  const rows = await db.query<Record<string, unknown>>(
    db.type === 'postgres'
      ? "SELECT id, num_id, name, type, target, interval_sec, active, options_json FROM monitors WHERE type IN ('http','tcp','udp','icmp') AND options_json LIKE $1 ORDER BY name"
      : "SELECT id, num_id, name, type, target, interval_sec, active, options_json FROM monitors WHERE type IN ('http','tcp','udp','icmp') AND options_json LIKE ? ORDER BY name",
    [`%${agentId}%`],
  );
  const out: AgentProbeTarget[] = [];
  for (const row of rows) {
    let source: unknown;
    try {
      source = (JSON.parse(String(row.options_json ?? '{}')) as { check_source?: { type?: string; agent_id?: string } }).check_source;
    } catch {
      continue;
    }
    const selection = source as { type?: string; agent_id?: string } | undefined;
    if (selection?.type !== 'agent' || selection.agent_id !== agentId) continue;
    if (!isActiveProbeType(String(row.type))) continue;
    const type = row.type as ActiveProbeType;
    out.push({
      monitor_id: String(row.id),
      num_id: Number(row.num_id) || 0,
      name: String(row.name),
      type,
      target: String(row.target ?? ''),
      interval_sec: Number(row.interval_sec) || 60,
      active: Number(row.active) === 1,
    });
  }
  return out;
}

/** Recent jobs, newest first; the left join keeps deleted monitors visible. / 最近任务，最新在前；左连接保留已删除监控的记录。 */
export async function loadAgentProbeJobs(env: Env, agentId: string, limit: number): Promise<AgentProbeJobRow[]> {
  const db = getDB(env);
  const rows = await db.query<Record<string, unknown>>(
    db.type === 'postgres'
      ? `SELECT j.run_id, j.monitor_id, m.name AS monitor_name, j.probe_type, j.state, j.attempts,
                j.scheduled_at, j.completed_at, j.latency_ms, j.status, j.message
           FROM agent_probe_jobs j LEFT JOIN monitors m ON m.id = j.monitor_id
          WHERE j.agent_id = $1
          ORDER BY j.scheduled_at DESC LIMIT $2`
      : `SELECT j.run_id, j.monitor_id, m.name AS monitor_name, j.probe_type, j.state, j.attempts,
                j.scheduled_at, j.completed_at, j.latency_ms, j.status, j.message
           FROM agent_probe_jobs j LEFT JOIN monitors m ON m.id = j.monitor_id
          WHERE j.agent_id = ?
          ORDER BY j.scheduled_at DESC LIMIT ?`,
    [agentId, limit],
  );
  return rows.map((row) => ({
    run_id: String(row.run_id),
    monitor_id: String(row.monitor_id),
    monitor_name: row.monitor_name == null ? null : String(row.monitor_name),
    probe_type: String(row.probe_type ?? ''),
    state: toState(row.state),
    attempts: Number(row.attempts) || 0,
    scheduled_at: Number(row.scheduled_at) || 0,
    completed_at: row.completed_at == null ? null : Number(row.completed_at),
    latency_ms: row.latency_ms == null ? null : Number(row.latency_ms),
    status: row.status == null ? null : Number(row.status),
    message: row.message == null ? null : String(row.message),
  }));
}

function toState(value: unknown): AgentProbeJobRow['state'] {
  return value === 'leased' || value === 'completed' || value === 'expired' ? value : 'pending';
}
