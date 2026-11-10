import type { Agent, Env } from '../../types';
import { getDB, withDBScope } from '../db/factory';
import { agentLiveSQL } from '../db/sql/agent';
import { asBasicReportParams, asReportParams, type AgentRpcFrame } from './protocol';

export function isSupportedFrame(frame: unknown): frame is AgentRpcFrame {
  if (!frame || typeof frame !== 'object') return false;
  const value = frame as AgentRpcFrame;
  if (value.method === 'basicReport') return asBasicReportParams(value.params) !== null;
  if (value.method === 'report') {
    const params = asReportParams(value.params);
    if (!params) return false;
    return params.observed_at === undefined || Number.isInteger(params.observed_at);
  }
  return value.method === 'event';
}

export async function dispatchRpc(
  env: Env,
  monitor: Agent,
  msg: AgentRpcFrame,
): Promise<{ ack: boolean; ignored: boolean; deferred?: boolean }> {
  if (!isSupportedFrame(msg)) return { ack: false, ignored: false };
  switch (msg.method) {
    case 'basicReport': {
      const p = asBasicReportParams(msg.params);
      if (!p) {
        console.warn(JSON.stringify({ event: 'agent_bad_basicReport', monitor: monitor.id }));
        return { ack: false, ignored: false };
      }
      return { ack: true, ignored: !(await handleBasicReport(env, monitor.id, p)) };
    }
    case 'report': {
      const p = asReportParams(msg.params);
      if (!p) {
        console.warn(JSON.stringify({ event: 'agent_bad_report', monitor: monitor.id }));
        return { ack: false, ignored: false };
      }
      const now = Math.floor(Date.now() / 1000);
      if (p.observed_at !== undefined && p.observed_at > now + 300) return { ack: true, ignored: false, deferred: true };
      if (p.observed_at !== undefined && p.observed_at < now - 86_400) return { ack: true, ignored: true };
      return { ack: true, ignored: !(await handleReport(env, monitor.id, p)) };
    }
    case 'event':
      // Agent-side lifecycle event (shutdown, restart, sampler error). Not
      // folded into machine_live - it is informational, and the agent's
      // absence will show up via reported_at going stale on the next cron
      // tick regardless. Logging alone is the right amount of attention.
      // Agent 生命周期事件（关闭、重启、采样器错误）仅供参考，不合并到 machine_live。
      // Agent 离线后 reported_at 会在下次定时检查中自然过期，因此记录日志即可。
      console.log(
        JSON.stringify({ event: 'agent_event', monitor: monitor.id, params: msg.params }),
      );
      return { ack: true, ignored: false };
    default:
      // Reject methods unsupported by this handler.
      // 拒绝此处理器不支持的方法。
      console.warn(
        JSON.stringify({ event: 'agent_unknown_method', monitor: monitor.id, method: msg.method }),
      );
      return { ack: false, ignored: false };
  }
}

async function handleBasicReport(
  env: Env,
  monitorId: string,
  p: import('./protocol').BasicReportParams,
): Promise<boolean> {
  return withDBScope(env, (scopedEnv) => persistBasicReport(scopedEnv, monitorId, p));
}

async function persistBasicReport(
  env: Env,
  monitorId: string,
  p: import('./protocol').BasicReportParams,
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const db = getDB(env);
  if (!(await db.queryOne<{ active: number }>(agentLiveSQL[db.type].isActive, [monitorId]))?.active) return false;
  await db.execute(agentLiveSQL[db.type].upsertStatic, [
    monitorId,
    p.os,
    p.arch,
    p.kernel ?? null,
    p.cpu_model,
    p.cpu_cores,
    p.publicIp ?? null,
    p.publicIpv6 ?? null,
    p.isp ?? null,
    p.region ?? null,
    p.virtualization ?? null,
    // Missing transport is stored as unknown.
    // 未上报传输方式时保存为未知。
    p.transport ?? null,
    p.version ?? null,
    p.report_interval_secs ?? null,
    p.capabilities ? JSON.stringify(p.capabilities) : null,
    now,
  ]);
  return true;
}

async function handleReport(
  env: Env,
  monitorId: string,
  p: import('./protocol').ReportParams,
): Promise<boolean> {
  return withDBScope(env, (scopedEnv) => persistReport(scopedEnv, monitorId, p));
}

async function persistReport(
  env: Env,
  monitorId: string,
  p: import('./protocol').ReportParams,
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const db = getDB(env);
  if (!(await db.queryOne<{ active: number }>(agentLiveSQL[db.type].isActive, [monitorId]))?.active) return false;
  const observedAt = p.observed_at ?? now;
  if (!Number.isInteger(observedAt) || observedAt < now - 86_400 || observedAt > now + 300) return false;
  /**
   * Per-NIC / per-mount snapshots land as TEXT JSON. The guard already
   * narrowed them to a valid array or null; JSON.stringify(null) is the
   * string "null", and we want a genuine NULL in the column instead, so
   * the ternary short-circuits on null rather than letting String(...) run.
   * 网卡和挂载点快照作为 TEXT JSON 存储。前面的检查已将其收窄为有效数组或 null；
   * JSON.stringify(null) 会产生字符串 "null"，而此处需要真正的 SQL NULL，
   * 所以三元表达式在 null 时短路，不执行 String(...)。
   */
  const interfacesJson = p.interfaces == null ? null : JSON.stringify(p.interfaces);
  const mountsJson = p.mounts == null ? null : JSON.stringify(p.mounts);
  await db.execute(agentLiveSQL[db.type].upsertDynamic, [
    monitorId,
    p.cpu.usage,
    p.ram.used,
    p.ram.total,
    p.swap.used,
    p.swap.total,
    p.load.load1,
    p.load.load5,
    p.load.load15,
    p.disk.used,
    p.disk.total,
    p.network.up,
    p.network.down,
    p.network.totalUp,
    p.network.totalDown,
    p.connections.tcp,
    p.connections.udp,
    p.process,
    p.uptime,
    p.message ?? '',
    interfacesJson,
    mountsJson,
    observedAt,
    now, // updated_at / 更新时间
  ]);

  for (const summary of p.summaries ?? []) {
    // 仅接收对齐分钟且不晚于当前上报的有效历史摘要。
    // Accept only valid historical summaries aligned to a minute and no later than the current report.
    if (!Number.isInteger(summary.bucket_ts) || summary.bucket_ts % 60 !== 0 ||
      summary.bucket_ts < now - 86_400 || summary.bucket_ts > now + 300 ||
      summary.bucket_ts > observedAt || summary.duration_sec > 3600) continue;
    await db.execute(agentLiveSQL[db.type].upsertFinalized, [
      monitorId,
      summary.bucket_ts,
      summary.cpu_avg,
      summary.cpu_max,
      summary.mem_pct_avg,
      summary.mem_pct_max,
      summary.load_1_avg,
      summary.load_5_avg,
      summary.sample_count,
      summary.duration_sec,
      summary.net_up_bytes,
      summary.net_down_bytes,
      summary.network_duration_sec,
      monitorId,
    ]);
  }
  return true;
}
