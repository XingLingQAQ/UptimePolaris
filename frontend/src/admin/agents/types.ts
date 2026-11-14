import type { HistoryStatus } from '../../../../shared/contracts';
/** One mount point, as the agent reported it. / Agent 上报的单个挂载点。 */
export interface AgentMount {
  name: string;
  total: number;
  used: number;
  free: number;
  used_percent: number;
}

/** One network interface's current rates and lifetime counters. / 单个网络接口的当前速率和累计计数。 */
export interface AgentInterface {
  name: string;
  up_rate: number;
  down_rate: number;
  total_up: number;
  total_down: number;
}

/** One resource alert rule, with whether it is firing right now. / 单条资源告警规则及其当前触发状态。 */
export interface AgentAlertRule {
  resource: 'cpu' | 'memory' | 'disk' | 'load';
  enabled: boolean;
  threshold: number;
  duration_sec: number;
  active: boolean;
}

/** One 5-minute bucket of the last 24 hours. Nulls are gaps, not zeroes. / 过去 24 小时内的一个 5 分钟数据桶；null 表示缺失，而非零。 */
export interface AgentHistoryPoint {
  ts: number;
  cpu: number | null;
  mem_pct: number | null;
  net_up: number | null;
  net_down: number | null;
}

/** Fleet row; online is null before the first metrics report. / Agent 列表行；首次上报指标前 online 为 null。 */
export interface FleetAgent {
  group_id: string | null;
  tags: Array<{ id: string; name: string; color: string }>;
  id: string;
  name: string;
  is_public: number;
  active: boolean;
  created_at: number;
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
  version: string | null;
  report_interval_secs: number | null;
  /** Capabilities the agent announced, e.g. `probe_http`, `commands`. / Agent 声明的能力，例如 `probe_http`、`commands`。 */
  capabilities: string[];
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
  online: boolean | null;
  last_reported_at: number | null;
  stale_for_sec: number | null;
  version_state: 'current' | 'behind' | 'unknown' | 'not_reported';
  /** Monitors that name this agent as their probe source. / 以该 Agent 为探测来源的监控项。 */
  probe_target_count: number;
  /** Whether the operator left this agent in probe rotation. / 操作人员是否让该 Agent 继续参与探测轮转。 */
  probe_enabled: boolean;
  /** Populated by the Agent detail response. / 由 Agent 详情响应填充。 */
  mounts?: AgentMount[];
  interfaces?: AgentInterface[];
}

export type BatchCommandAction = 're_report' | 'check_update' | 'upgrade' | 'restart';

export interface BatchCommandResult {
  id: string;
  ok: boolean;
  /** One of the command error codes, when this machine failed. / 机器执行失败时的命令错误码之一。 */
  error?: string;
}

/** A monitor this agent performs checks for. / 由该 Agent 执行检查的监控项。 */
export interface AgentProbeTarget {
  monitor_id: string;
  num_id: number;
  name: string;
  type: import('../../../../shared/probe-capabilities').ActiveProbeType;
  target: string;
  interval_sec: number;
  active: boolean;
}

/** One recent probe run, as recorded by the scheduler. / 调度器记录的一次近期探测。 */
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

export interface AgentDetailResponse {
  agent: FleetAgent;
  /** This agent's own credential, shown once at install time. / 该 Agent 自身的凭据，仅在安装时显示一次。 */
  install?: { token: string } | null;
  mounts?: AgentMount[];
  interfaces?: AgentInterface[];
  alerts?: AgentAlertRule[];
  history?: AgentHistoryPoint[];
  history_status?: HistoryStatus;
  history_sampled?: boolean;
  history_daily?: AgentHistoryPoint[];
  history_daily_sampled?: boolean;
  probe_targets?: AgentProbeTarget[];
  probe_jobs?: AgentProbeJobRow[];
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

/** Command result: ok is null while pending, 1 for success and 0 for failure. / 命令结果：等待中 ok 为 null，成功为 1，失败为 0。 */
export interface AgentCommandRecord {
  id: string;
  agent_id: string;
  action: 'upgrade' | 'restart' | 're_report' | 'check_update';
  queued_at: number;
  state: 'pending' | 'leased' | 'completed' | 'expired';
  attempts: number;
  ok: number | null;
  message: string | null;
  completed_at: number | null;
  issued_by: string | null;
}
