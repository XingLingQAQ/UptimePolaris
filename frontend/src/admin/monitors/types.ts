import type { DayStat } from '../../../../shared/contracts';

/** Active network checks and passive readings. / 主动网络检查与被动上报。 */
export type MonitorType = import('../../../../shared/backend-capabilities').MonitorType;

/** One add-on's reading: certificate or domain expiry. / 单个附加项的结果：证书或域名到期时间。 */
export interface AddonReading {
  st: 0 | 1 | 2;
  /** Days remaining. The only place a day count lives. / 剩余天数；天数只存放于此。 */
  days: number | null;
  msg: string;
  /** Unix seconds when this add-on was last checked. / 此附加项上次检查的 Unix 秒数。 */
  ts: number;
}

/** DNS add-on result; records are included for expected-value mismatches. / DNS 附加项结果；与预期值不匹配时包含记录。 */
export interface DnsReading {
  st: 0 | 1 | 2;
  msg: string;
  /** Unix seconds when the resolver was last queried. / 上次查询解析器的 Unix 秒数。 */
  ts: number;
  /** Values extracted from a mismatch message, capped by the Worker. / 从不匹配消息提取的值，由 Worker 限制数量。 */
  records?: string[];
}

/** Serialized monitor options; an enabled DNS add-on requires recordType. / 序列化的监控项选项；启用 DNS 附加项时需要 recordType。 */
export interface HttpOptions {
  headers?: Record<string, string>;
  body?: string;
  auth?: { type: 'basic' | 'bearer'; username?: string; password?: string; token?: string };
  jsonPath?: string;
  jsonExpected?: string;
  headerName?: string;
  headerExpected?: string;
  maxLatencyMs?: number;
}

export interface TcpOptions {
  /** Bytes written as soon as the socket opens, for protocols that speak first. / 套接字打开后立即发送的字节，用于客户端先发送数据的协议。 */
  send?: string;
  /** Substring the reply must contain. Empty means "any reply is enough". / 回复必须包含的子串；为空表示任意回复均可。 */
  expect?: string;
  encoding?: 'text' | 'hex';
}

export interface DnsOptions {
  recordType: 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT' | 'NS';
  expected?: string;
  resolver?: string;
}

/** Tag projection used by the console; tagKey distinguishes tag identity from join-row identity. / 控制台使用的标签投影；tagKey 区分标签标识和关联行标识。 */
export interface MonitorTag {
  id: string | number;
  name: string;
  color: string;
  /** The tag table's own id, when the entry also carries a join row's id. / 条目同时包含关联行 ID 时，标签表自身的 ID。 */
  tag_id?: string | number;
  monitor_id?: string | number;
  value?: string;
}

export interface Monitor {
  id: string;
  num_id: number;
  name: string;
  type: MonitorType;
  target: string;
  method: string;
  expected_status: string;
  keyword: string | null;
  interval_sec: number;
  timeout_ms: number;
  warn_days: number;
  active: number;
  /** Group UUID, or null for ungrouped. / 分组 UUID；null 表示未分组。 */
  group_id: string | null;
  /** Every tag on this monitor. Empty, never absent. / 监控项的全部标签；可以为空，但不会缺失。 */
  tags: MonitorTag[];
  /** Query public CT certificate records by hostname. HTTP/TCP only. / 按主机名查询公开 CT 证书记录，仅用于 HTTP/TCP。 */
  check_ssl: number;
  /** Look up domain registration expiry for the target's host. http/tcp only. / 查询目标主机域名的注册到期时间，仅用于 http/tcp。 */
  check_domain: number;
  /** Hostname-only DNS add-on; lookup failures contribute WARN independently of the transport result. / 仅针对主机名的 DNS 附加项；查询失败独立于传输结果产生 WARN。 */
   check_dns: number;
  /** Type-specific options, stored as a JSON string by the Worker. / 类型专用选项，由 Worker 存为 JSON 字符串。 */
  options_json: string;
  /** For type='push' only. / 仅用于 type='push'。 */
  push_token?: string | null;
  agent_id: string | null;
  is_public: number;
  created_at: number;
  updated_at: number;
  source?: 'worker' | 'server' | 'agent';
  source_id?: string;
  source_name?: string | null;
  source_available?: boolean;
  /** Available Agent source with no completed probe result yet. / Agent 来源可用，但尚无完成的探测结果。 */
  source_pending?: boolean;
  /** Unix seconds of the last completed agent observation, when there is one. / 最近一次完成的 Agent 观测时间，以 Unix 秒数表示；可能不存在。 */
  source_last_observed_at?: number | null;
}

export interface ProbeAgentSource {
  active: boolean;
  id: string;
  name: string;
  version: string | null;
  capabilities: string[];
  online: boolean;
  /** Whether the operator left this agent in probe rotation. / 操作人员是否让该 Agent 继续参与探测轮转。 */
  probe_enabled: boolean;
  /** Has this machine ever reported? A named row is not an installed agent. / 该机器是否曾上报？有名称的行不代表 Agent 已安装。 */
  installed: boolean;
}

/** Shape accepted by POST/PUT. Mirrors the Worker's validation. / POST/PUT 接受的数据结构，与 Worker 校验规则一致。 */
export interface MonitorInput {
  name: string;
  type: MonitorType;
  target: string;
  method?: string;
  expected_status?: string;
  keyword?: string | null;
  interval_sec?: number;
  timeout_ms?: number;
  warn_days?: number;
  active?: number;
  check_ssl?: number;
  check_domain?: number;
  check_dns?: number;
  /** Type-specific options, serialised by the form. / 类型专用选项，由表单序列化。 */
  options_json?: string;
  /** Read-only in the console; present so the response type is honest. / 在控制台中只读；列出该字段以准确表示响应类型。 */
  push_token?: string | null;
  /** For type='agent' only. / 仅用于 type='agent'。 */
  agent_id?: string | null;
  is_public?: boolean;
  /** Null clears the group; omission preserves it on update. / null 清除分组；更新时省略则保留原分组。 */
  group_id?: string | null;
  /** Replaces the complete tag set: [] clears it; omission preserves it on update. / 替换完整标签集合：[] 清空；更新时省略则保留原标签。 */
  tag_ids?: string[];
}

export interface CheckResult {
  status: 0 | 1 | 2;
  latencyMs: number;
  statusCode: number;
  message: string;
  daysLeft?: number;
}

/** Saved-check response; status includes retry policy and add-ons, while primary is the raw transport result. / 保存的检查响应；status 包含重试策略和附加项，primary 为原始传输结果。 */
export interface MonitorCheckResult {
  ok: true;
  monitor_id: string;
  /** The persisted badge: 0 down, 1 up, 2 warn, 4 pending. / 持久化状态：0 故障、1 正常、2 警告、4 待定。 */
  status: 0 | 1 | 2 | 4;
  latencyMs: number;
  statusCode: number;
  message: string;
  /** Epoch seconds the check completed at. / 检查完成时的 Unix 秒数。 */
  checked_at: number;
  /** The transport's own verdict, before add-ons and the retry budget. / 应用附加项和重试次数限制前的传输层原始结果。 */
  primary: CheckResult;
  /** True when this check produced a status transition in the event log. / 本次检查在事件日志中产生状态变更时为 true。 */
  event: boolean;
  /** True when an alert was queued for delivery. / 告警已加入发送队列时为 true。 */
  notified: boolean;
  /** True when a maintenance window held that alert (the check still ran). / 维护时段阻止该告警发送时为 true（检查仍会执行）。 */
  maintenance: boolean;
}

/** A monitor plus its live reading, as returned by /api/overview. / /api/overview 返回的监控项及其实时读数。 */
export interface OverviewMonitor extends Monitor {
  /** Null before a completed observation; 4 PENDING awaits retries, 2 WARN includes slow responses or add-on warnings. / 完成首次观测前为 null；4 PENDING 表示等待重试，2 WARN 包括响应缓慢或附加项警告。 */
  st: 0 | 1 | 2 | 4 | null;
  msg: string;
  /** Latency in milliseconds; expiry days are carried by the add-on readings. / 延迟，单位为毫秒；到期天数保存在附加项读数中。 */
  v: number;
  /** Unix seconds; 0 when the monitor has never been checked. / Unix 秒数；监控项从未检查时为 0。 */
  checked_at: number;
  push_last_received_at?: number | null;
  /** Availability over the whole retained history, 0-100. / 整个保留历史的可用率，范围 0–100。 */
  uptime: number;
  /** False until the first daily rollup, so the UI can show "—" not "100%". / 首次每日汇总前为 false，让界面显示“—”而不是“100%”。 */
  has_history: boolean;
  /** Last 90 daily rollups, oldest first. / 最近 90 次每日汇总，按时间从旧到新。 */
  days: DayStat[];
  /** Last checks, oldest first, one per check - what the rail draws. / 近期检查记录，每次检查一条，按时间从旧到新供状态条绘制。 */
  ring: RingHeartbeat[];
  /** Present only when `check_ssl` is on. / 仅在启用 `check_ssl` 时存在。 */
  ssl?: AddonReading;
  /** Present only when `check_domain` is on. / 仅在启用 `check_domain` 时存在。 */
  domain?: AddonReading;
  /** Present only when `check_dns` is on. / 仅在启用 `check_dns` 时存在。 */
  dns?: DnsReading;
  /** Type-specific options, stored as a JSON string by the Worker. / 类型专用选项，由 Worker 存为 JSON 字符串。 */
  options_json: string;
  /** For type='push' only. / 仅用于 type='push'。 */
  push_token?: string | null;
}

export interface OverviewCounts {
  total: number;
  up: number;
  warn: number;
  down: number;
  pending: number;
  paused: number;
}

/** Recent check observation; up carries status 0/1/2/4, and ms carries CPU percent for Agent monitors. / 近期检查观测；up 保存 0/1/2/4 状态，Agent 监控项的 ms 保存 CPU 百分比。 */
export interface RingHeartbeat {
  /** epoch seconds / Unix 秒数 */
  t: number;
  /** 1 up, 0 down, 2 warn, 4 pending / 1 正常、0 故障、2 警告、4 待定 */
  up: number;
  /** latency ms; CPU percent for agent monitors / 延迟毫秒数；Agent 监控项为 CPU 百分比 */
  ms: number | null;
}
