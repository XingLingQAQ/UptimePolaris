/**
 * Agent fleet rows: one join instead of N+1 reads.
 *
 * D1 bills per row read, so liveness, capabilities and probe state come back
 * with the row. Version-behind is resolved on the server from the release
 * manifest, so an unpublished manifest reads as unknown, not "needs upgrade".
 * 一次联表取代 N+1；版本落后由服务端按发布清单判断，清单缺失时显示未知。
 */

import type { AgentMachineOptions, Env } from '../../types';
import { parseOptions } from '../../types';
import { getDB } from '../db/factory';
import { cachedAgentRelease, latestAgentRelease } from './release';
import { agentIsOnline, agentStaleAfterSec } from './liveness';
import { loadAgentTagLinks } from '../presentation/taxonomy';

export interface FleetAgent {
  id: string;
  name: string;
  is_public: number;
  group_id: string | null;
  tags: { id: string; name: string; color: string }[];
  /** Monitor row's own fields - an agent is a monitor of type `agent`. / 监控记录自身的字段；Agent 是类型为 `agent` 的监控。 */
  active: boolean;
  created_at: number;
  /** Identity, from the agent's `basicReport`. Null until it first reports. / 来自 Agent `basicReport` 的身份信息；首次上报前为 null。 */
  os: string | null;
  arch: string | null;
  kernel: string | null;
  cpu_model: string | null;
  cpu_cores: number | null;
  public_ip: string | null;
  public_ipv6: string | null;
  isp: string | null;
  region: string | null;
  virtualization: string | null;
  transport: string | null;
  /** The agent binary's own version, as it reported. / Agent 二进制文件自行上报的版本。 */
  version: string | null;
  report_interval_secs: number | null;
  /** Parsed capabilities array, shared by command and probe checks. / 解析后的能力数组，命令和探测检查共用。 */
  capabilities: string[];
  /** Live metrics, from the agent's `report`. / 来自 Agent `report` 的实时指标。 */
  cpu_usage: number | null;
  mem_used: number | null;
  mem_total: number | null;
  disk_used: number | null;
  disk_total: number | null;
  load_1: number | null;
  uptime_sec: number | null;
  process_count: number | null;
  connections_tcp: number | null;
  connections_udp: number | null;
  /** Per-mount and per-NIC snapshots, parsed from their JSON columns. / 从 JSON 列解析的挂载点和网卡快照。 */
  mounts: FleetMount[];
  interfaces: FleetInterface[];
  /** Liveness tri-state: `true` online, `false` offline, `null` never reported.
   * Collapsing `null` into `false` would make a freshly enrolled agent look
   * silent and send the operator to investigate instead of wait.
   * 在线三态；把“从未上报”并入离线会误导排查。 */
  online: boolean | null;
  last_reported_at: number | null;
  /** Seconds of silence, or null when it has never reported. / 距离上次上报的秒数；从未上报时为 null。 */
  stale_for_sec: number | null;
  /** `behind` needs `latest_version`; null when the manifest is unavailable. / `behind` 需要 `latest_version`；清单不可用时为 null。 */
  version_state: 'current' | 'behind' | 'unknown' | 'not_reported';
  /** HTTP/TCP monitors using this machine. / 使用此机器探测的 HTTP/TCP 监控数。 */
  probe_target_count: number;
  /** Whether the machine is in probe rotation, distinct from its target count. / 机器是否参与探测，与目标数量不同。 */
  probe_enabled: boolean;
}

export interface FleetMount {
  name: string;
  total: number;
  used: number;
  free: number;
  used_percent: number;
}

export interface FleetInterface {
  name: string;
  up_rate: number;
  down_rate: number;
  total_up: number;
  total_down: number;
}

function finite(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Malformed agent JSON reads as "nothing reported", never as a failed load. / Agent JSON 格式错误按“未上报”处理，不使加载失败。 */
export function parseMounts(json: unknown): FleetMount[] {
  if (typeof json !== 'string' || json === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: FleetMount[] = [];
  for (const row of parsed) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as Record<string, unknown>;
    const total = finite(r.total_bytes);
    const used = finite(r.used_bytes);
    const free = finite(r.free_bytes);
    const usedPercent = finite(r.used_percent);
    if (typeof r.name !== 'string' || total === null || used === null || free === null || usedPercent === null) continue;
    out.push({ name: r.name, total, used, free, used_percent: usedPercent });
  }
  return out;
}

export function parseInterfaces(json: unknown): FleetInterface[] {
  if (typeof json !== 'string' || json === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: FleetInterface[] = [];
  for (const row of parsed) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as Record<string, unknown>;
    const upRate = finite(r.up_rate);
    const downRate = finite(r.down_rate);
    const totalUp = finite(r.total_up_bytes);
    const totalDown = finite(r.total_down_bytes);
    if (typeof r.name !== 'string' || upRate === null || downRate === null || totalUp === null || totalDown === null) continue;
    out.push({ name: r.name, up_rate: upRate, down_rate: downRate, total_up: totalUp, total_down: totalDown });
  }
  return out;
}

export interface FleetSummary {
  total: number;
  online: number;
  offline: number;
  neverReported: number;
  paused: number;
  behind: number;
  latestVersion: string | null;
}

/** `x.y.z` compared numerically; a prerelease or junk reads as older. / 按数值比较 `x.y.z`；预发布版本或无效值视为较旧。 */
function versionAtLeast(actual: string | null, expected: string | null): boolean {
  if (!actual || !expected) return false;
  const parse = (v: string): number[] | null => {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
  };
  const a = parse(actual);
  const b = parse(expected);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** 包含暂停和从未上报的机器。 / Include paused machines and those that have never reported. */
export async function loadFleet(env: Env, now: number): Promise<FleetAgent[]> {
  void latestAgentRelease().catch(() => undefined);
  const db = getDB(env);
  const sql = `
    SELECT m.id, m.name, m.active, m.created_at, m.options_json, m.group_id, m.is_public,
           ml.os, ml.arch, ml.kernel, ml.cpu_model, ml.cpu_cores,
           ml.public_ip, ml.public_ipv6, ml.isp, ml.region, ml.virtualization,
           ml.transport, ml.version, ml.report_interval_secs, ml.probe_capabilities,
           ml.cpu_usage, ml.mem_used, ml.mem_total, ml.disk_used, ml.disk_total,
           ml.load_1, ml.uptime, ml.process_count,
           ml.connections_tcp, ml.connections_udp, ml.interfaces_json, ml.mounts_json,
           ml.reported_at
      FROM agents m
      LEFT JOIN machine_live ml ON ml.agent_id = m.id
     WHERE 1=1
     ORDER BY m.name`;
  const rows = await db.query<Record<string, unknown>>(sql);
  /** Probe target counts parsed from options_json in one pass. / 一次遍历 options_json 统计探测目标。 */
  const sourceRows = await db.query<Record<string, unknown>>(
    db.type === 'postgres'
      ? "SELECT options_json FROM monitors WHERE type IN ('http','tcp','udp','icmp') AND options_json LIKE '%\"agent\"%'"
      : "SELECT options_json FROM monitors WHERE type IN ('http','tcp','udp','icmp') AND options_json LIKE '%\"agent\"%'",
  );
  const probeTargets = new Map<string, number>();
  for (const row of sourceRows) {
    let source: unknown;
    try {
      source = (JSON.parse(String(row.options_json ?? '{}')) as { check_source?: { type?: string; agent_id?: string } }).check_source;
    } catch {
      continue;
    }
    const selection = source as { type?: string; agent_id?: string } | undefined;
    if (selection?.type !== 'agent' || typeof selection.agent_id !== 'string') continue;
    probeTargets.set(selection.agent_id, (probeTargets.get(selection.agent_id) ?? 0) + 1);
  }
  const latest = cachedAgentRelease()?.version ?? null;
  const tags = await loadAgentTagLinks(env);

  return rows.map((row) => {
    const reportedAt = toNumber(row.reported_at);
    const online = agentIsOnline(reportedAt, now, agentStaleAfterSec(toNumber(row.report_interval_secs)));

    let versionState: FleetAgent['version_state'];
    if (row.version === null || row.version === undefined) versionState = 'not_reported';
    else if (latest === null) versionState = 'unknown';
    else versionState = versionAtLeast(String(row.version), latest) ? 'current' : 'behind';

    /*
      Capabilities are announced, not derived from the version.

      The same reasoning as `COMMAND_CAPABILITY` in commands.ts: what an agent can
      do is a fact only the agent knows, and a version table would have to be kept
      in step with three separate version numbers.
      能力由 Agent 声明，而非从版本推导。与 commands.ts 的 `COMMAND_CAPABILITY`
      原因相同：只有 Agent 自身知道其能力，版本表还须与三个不同版本号保持同步。
    */
    let capabilities: string[] = [];
    try {
      const parsed: unknown = JSON.parse(String(row.probe_capabilities ?? '[]'));
      if (Array.isArray(parsed)) capabilities = parsed.filter((entry): entry is string => typeof entry === 'string');
    } catch {
      // A malformed value reads as "announces nothing", which fails closed - the
      // agent is then simply not offered commands or agent-sourced probes.
      // 格式错误按“未声明任何能力”处理，安全关闭命令和 Agent 来源探测。
    }

    return {
      id: String(row.id),
      name: String(row.name),
      is_public: Number(row.is_public),
      group_id: row.group_id == null ? null : String(row.group_id),
      tags: tags.filter(tag => tag.agent_id === row.id).map(({id,name,color}) => ({id,name,color})),
      active: Number(row.active) === 1,
      created_at: toNumber(row.created_at) ?? 0,
      os: row.os == null ? null : String(row.os),
      arch: row.arch == null ? null : String(row.arch),
      kernel: row.kernel == null ? null : String(row.kernel),
      cpu_model: row.cpu_model == null ? null : String(row.cpu_model),
      cpu_cores: toNumber(row.cpu_cores),
      public_ip: row.public_ip == null ? null : String(row.public_ip),
      public_ipv6: row.public_ipv6 == null ? null : String(row.public_ipv6),
      isp: row.isp == null ? null : String(row.isp),
      region: row.region == null ? null : String(row.region),
      virtualization: row.virtualization == null ? null : String(row.virtualization),
      transport: row.transport == null ? null : String(row.transport),
      version: row.version == null ? null : String(row.version),
      report_interval_secs: toNumber(row.report_interval_secs),
      capabilities,
      cpu_usage: toNumber(row.cpu_usage),
      mem_used: toNumber(row.mem_used),
      mem_total: toNumber(row.mem_total),
      disk_used: toNumber(row.disk_used),
      disk_total: toNumber(row.disk_total),
      load_1: toNumber(row.load_1),
      uptime_sec: toNumber(row.uptime),
      process_count: toNumber(row.process_count),
      connections_tcp: toNumber(row.connections_tcp),
      connections_udp: toNumber(row.connections_udp),
      mounts: parseMounts(row.mounts_json),
      interfaces: parseInterfaces(row.interfaces_json),
      online,
      last_reported_at: reportedAt,
      stale_for_sec: reportedAt === null ? null : Math.max(0, now - reportedAt),
      version_state: versionState,
      probe_target_count: probeTargets.get(String(row.id)) ?? 0,
      probe_enabled: parseOptions<AgentMachineOptions>(String(row.options_json ?? '{}')).probe_enabled !== false,
    };
  });
}

/** Summary counts derived from the loaded rows, not a second query. / 汇总数由已加载行推导，不另查询。 */
export function summariseFleet(agents: FleetAgent[], latestVersion: string | null = null): FleetSummary {
  return {
    total: agents.length,
    online: agents.filter((a) => a.active && a.online === true).length,
    offline: agents.filter((a) => a.active && a.online === false).length,
    neverReported: agents.filter((a) => a.online === null).length,
    paused: agents.filter((a) => !a.active).length,
    behind: agents.filter((a) => a.version_state === 'behind').length,
    latestVersion,
  };
}

/** Convenience for a caller that wants both in one call. / 方便调用方一次获取列表和汇总。 */
export async function loadFleetWithSummary(
  env: Env,
  now: number,
): Promise<{ agents: FleetAgent[]; summary: FleetSummary }> {
  const agents = await loadFleet(env, now);
  const latest = cachedAgentRelease()?.version ?? null;
  return { agents, summary: summariseFleet(agents, latest) };
}
