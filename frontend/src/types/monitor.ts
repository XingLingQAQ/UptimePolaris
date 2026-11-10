export interface Heartbeat {
  status: 0 | 1 | 2 | 4;
  /** ISO-8601 with a `Z`; parse it with `new Date(...)` in any timezone. / 带 `Z` 的 ISO-8601 时间，可在任意时区使用 `new Date(...)` 解析。 */
  time: string;
  msg: string;
  ping: number | null; // latency in ms / 延迟毫秒数
}

export interface UptimeData {
  [key: string]: number | null; // Format: "{monitorId}_{hours}" -> availability ratio / 格式：监控项 ID 与小时数组成的键对应可用率
}

export interface MonitorTag {
  id: number;
  monitor_id: number;
  tag_id: number;
  name: string;
  color: string;
}

/** Certificate or domain expiry; days is null when no date was read. / 证书或域名到期信息；未读取到日期时 days 为 null。 */
export interface ExpiryBadge {
  kind: 'ssl' | 'domain';
  /** Days remaining, or null when the add-on could not read a date. / 剩余天数；附加项无法读取日期时为 null。 */
  days: number | null;
  /** 1 up, 2 warn, 0 down - the add-on's own status, not the monitor's. / 附加项自身的状态：1 正常、2 警告、0 故障。 */
  status: 0 | 1 | 2;
  /** The add-on's message, for a tooltip. / 附加项消息，用于提示框。 */
  message: string;
}

/** DNS add-on result; absent before the first observation. / DNS 附加项结果；首次观测前不存在。 */
export interface DnsBadge {
  /** 1 up, 2 warn, 0 down - the add-on's own status, not the monitor's. / 附加项自身的状态：1 正常、2 警告、0 故障。 */
  st: 0 | 1 | 2;
  /** The resolver's last answer, in words. / 解析器最近一次应答的文字描述。 */
  msg: string;
  /** Unix seconds when the resolver was last queried. / 上次查询解析器的 Unix 秒数。 */
  ts: number;
  hostname?: string;
  recordType?: string;
  rcode?: string;
  latencyMs?: number;
  records?: string[];
}

export interface Monitor {
  id: number;
  name: string;
  sendUrl: number; // 0: no, 1: yes / 0 否，1 是
  type: import('../../../shared/probe-capabilities').ActiveProbeType | 'push' | 'agent';
  url?: string;
  /** One badge per enabled expiry add-on with a completed reading. / 每个已启用且完成读取的到期附加项对应一个标记。 */
  expiryBadges?: ExpiryBadge[];
  /** Latest DNS add-on result supplied by the Worker. / Worker 提供的最新 DNS 附加项结果。 */
  dns?: DnsBadge;
  source?: 'worker' | 'server' | 'agent';
  sourceId?: string;
  sourceName?: string | null;
  sourceAvailable?: boolean;
  /** The Agent source is available but has no completed probe result yet. / Agent 来源可用，但尚无完成的探测结果。 */
  sourcePending?: boolean;
  /** Unix seconds of the last completed agent observation, when there is one. / 最近一次完成的 Agent 观测时间，以 Unix 秒数表示；可能不存在。 */
  sourceLastObservedAt?: number | null;
  pushLastReceivedAt?: number | null;
  intervalSec?: number;
  tags?: MonitorTag[];
}

export interface MonitorGroup {
  id: number;
  /** Null marks the ungrouped bucket; the UI supplies the localized label. / null 表示未分组，界面负责提供本地化标签。 */
  name: string | null;
  /** True on the synthetic bucket that holds monitors with no group. / 汇总未分组监控项的虚拟分组为 true。 */
  isUngrouped?: boolean;
  weight: number;
  monitorList: Monitor[];
}

export interface HeartbeatData {
  [key: string]: Heartbeat[]; // key is monitor ID / 键为监控项 ID
}

export interface MonitoringData {
  heartbeatList: HeartbeatData;
  uptimeList: UptimeData;
  uptimeCoverage?: UptimeData;
}

/**
 * Incident Message (Maintenance) / 事件消息（维护）
 */
export interface Incident {
  id: number;
  style: 'info' | 'warning' | 'danger' | 'primary' | 'light' | 'dark';
  // info -> primary
  // light -> default
  // dark -> secondary
  title: string;
  content: string;
  pin: number | boolean;
  createdDate: string;
  lastUpdatedDate: string | null;
  active?: boolean;
  status_page_id?: number;
}

/**
 * Monitor Response / 监控项响应
 */
export interface MonitorResponse {
  success: boolean;
  monitorGroups: MonitorGroup[];
  data: MonitoringData;
}

/**
 * `warn` is a filter of its own: an add-on complaining (certificate, domain
 * registration, DNS, a latency bound) is a different answer from "the check is
 * retrying", and the public page can now tell them apart.
 *
 * `warn` 单独筛选附加项警告（证书、域名、DNS 或延迟），与正在重试的检查区分。
 */
export type MonitorFilterStatus = 'all' | 'up' | 'down' | 'warn' | 'pending';
