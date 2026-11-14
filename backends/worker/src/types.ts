/** Network checks are active; Push and machine readings arrive from clients. / 网络检查主动执行；Push 和机器指标由客户端上报。 */
export type MonitorType = import('../../../shared/probe-capabilities').ActiveProbeType | 'push' | 'agent';

/** A configured check. `target` is interpreted per type. / 已配置的检查；`target` 的含义取决于类型。 */
export interface Monitor {
  id: string;
  /** Numeric identity for public routes and heartbeat keys; `id` remains the storage UUID. / 公共路由和心跳键使用的数字标识；`id` 仍为存储 UUID。 */
  num_id: number;
  name: string;
  type: MonitorType;
  /** HTTP URL, TCP/UDP host:port, or ICMP host. / HTTP URL、TCP/UDP 主机端口，或 ICMP 主机。 */
  target: string;
  method: string;
  /** e.g. "200-299" or "200,301,302". / 例如 "200-299" 或 "200,301,302"。 */
  expected_status: string;
  keyword: string | null;
  interval_sec: number;
  timeout_ms: number;
  /** Days-remaining threshold that flips an expiry add-on to WARN. / 过期附加检查转为 WARN 的剩余天数阈值。 */
  warn_days: number;
  /** Public CT certificate-expiry add-on, stored as 0/1; requires a hostname. / 公开 CT 证书到期附加检查，以 0/1 存储；需要主机名。 */
  check_ssl: number;
  /** Domain-registration-expiry add-on (RDAP). Same rules as `check_ssl`. / 域名注册到期附加检查（RDAP），规则同 `check_ssl`。 */
  check_domain: number;
  /** DoH add-on for hostname targets; failures contribute WARN, never DOWN. / 主机名目标的 DoH 附加检查；失败产生 WARN，不产生 DOWN。 */
  check_dns: number;
  /** Type-specific JSON; DNS add-on options live under the `dns` key. / 类型专属 JSON；DNS 附加选项位于 `dns` 键下。 */
  options_json: string;
  /** For type='push' only: the secret in the public push URL. NULL otherwise. / 仅用于 type='push'：公共 Push URL 中的密钥；其他类型为 NULL。 */
  push_token: string | null;
  /** Selected machine for Agent monitoring or Agent-sourced probes. / Agent 监控或 Agent 来源探测所关联的机器。 */
  agent_id: string | null;
  is_public: number;
  /** Group UUID, or null for ungrouped; group writes validate references and deletion clears them. / 分组 UUID，未分组时为 null；写入时验证引用，删除时清除引用。 */
  group_id: string | null;
  active: number;
  created_at: number;
  updated_at: number;
}

/** An enrolled machine, independent of its monitors. / 已登记的机器，与监控项独立。 */
export interface Agent {
  id: string;
  name: string;
  token: string;
  active: number;
  options_json: string;
  created_at: number;
  updated_at: number;
}

/** Latest Agent snapshot. Identity and metrics arrive separately; only metrics advance `reported_at`. / 最新 Agent 快照。身份与指标分别上报，只有指标更新 `reported_at`。 */
export interface MachineLive {
  agent_id: string;

  /* static, from basicReport / 静态信息，来自 basicReport */
  os: string | null;
  arch: string | null;
  kernel: string | null;
  cpu_model: string | null;
  cpu_cores: number | null;
  version: string | null;
  /** Network identity reported by the Agent. / Agent 上报的网络身份信息。 */
  public_ip: string | null;
  public_ipv6: string | null;
  isp: string | null;
  region: string | null;
  virtualization: string | null;
  /** 'ws' or 'http', as the agent last reported. NULL before any report. / Agent 最近上报的 'ws' 或 'http'；首次上报前为 NULL。 */
  transport: string | null;
  report_interval_secs: number | null;
  probe_capabilities?: string | null;

  /* dynamic, from report / 动态信息，来自 report */
  cpu_usage: number | null;
  mem_used: number | null;
  mem_total: number | null;
  swap_used: number | null;
  swap_total: number | null;
  load_1: number | null;
  load_5: number | null;
  load_15: number | null;
  disk_used: number | null;
  disk_total: number | null;
  net_up_rate: number | null;
  net_down_rate: number | null;
  net_up_total: number | null;
  net_down_total: number | null;
  connections_tcp: number | null;
  connections_udp: number | null;
  process_count: number | null;
  uptime: number | null;
  message: string | null;

  /** Serialized per-interface and per-mount details for the Agent detail view. / Agent 详情页使用的序列化网卡和挂载点明细。 */
  interfaces_json: string | null;
  mounts_json: string | null;

  /** Unix seconds of the last `report` frame, NULL until one arrives. / 最近 `report` 帧的 Unix 秒数；收到前为 NULL。 */
  reported_at: number | null;
  /** Unix seconds of the last write of any kind. NOT NULL in the schema. / 最近一次任意写入的 Unix 秒数；结构中为 NOT NULL。 */
  updated_at: number;
}


export interface MachineHistory {
  agent_id: string;
  bucket_ts: number;
  cpu_avg: number | null;
  cpu_max: number | null;
  mem_pct_avg: number | null;
  mem_pct_max: number | null;
  load_1_avg: number | null;
  load_5_avg: number | null;
  sample_count: number | null;
  duration_sec: number | null;
  network_duration_sec: number | null;
  quality: 'aggregate';
  net_up_bytes: number | null;
  net_down_bytes: number | null;
}

/** Status-page section; sorted by weight, then name. / 状态页分区；先按权重，再按名称排序。 */
export interface MonitorGroup {
  id: string;
  name: string;
  weight: number;
  created_at: number;
  updated_at: number;
}

/** Group UUIDs accepted by a notification channel. An empty scope accepts every monitor. / 通知渠道接受的分组 UUID；空范围接受所有监控。 */
export type NotificationScope = string[];

/** Reusable monitor label; color is validated as #RRGGBB. / 可复用的监控标签；颜色验证为 #RRGGBB。 */
export interface Tag {
  id: string;
  name: string;
  color: string;
  created_at: number;
  updated_at: number;
}

/** Public tag projection: numeric join/monitor IDs, but a UUID `tag_id` for writes. / 公共标签数据使用数字关联和监控 ID，写入时使用 UUID `tag_id`。 */
export interface MonitorTag {
  /** The join row's integer identity, used as a React key by the status page. / 关联行的整数标识，用作状态页的 React key。 */
  id: number;
  /** The monitor's `num_id`. / 监控的 `num_id`。 */
  monitor_id: number;
  /** The tag's UUID - what `tag_ids` on a monitor write is matched against. / 标签 UUID，用于匹配监控写入的 `tag_ids`。 */
  tag_id: string;
  name: string;
  color: string;
}

/** Option shapes shared by API validation and probe readers. / API 验证和探测器读取共用的选项结构。 */
export interface HttpOptions {
  headers?: Record<string, string>;
  body?: string;
  auth?: { type: 'basic' | 'bearer'; username?: string; password?: string; token?: string };
  jsonPath?: string;
  jsonExpected?: string;
  headerName?: string;
  headerExpected?: string;
  maxLatencyMs?: number;
  check_source?: ProbeSource;
}
export interface TcpOptions {
  /** Bytes to write immediately after connecting, e.g. Redis PING. / 连接后立即发送的字节，例如 Redis PING。 */
  send?: string;
  /** Substring the response must contain, e.g. "SSH-2.0" or "+PONG". / 响应必须包含的子串，例如 "SSH-2.0" 或 "+PONG"。 */
  expect?: string;
  check_source?: ProbeSource;
}
export type ProbeSource = { type: 'worker' } | { type: 'agent'; agent_id: string };
export interface DnsOptions {
  recordType: 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT' | 'NS';
  /** Substring any answer must contain. Empty means "any answer at all". / 应答必须包含的子串；为空表示接受任意应答。 */
  expected?: string;
  /** DoH endpoint. Defaults to DEFAULT_DOH_RESOLVER. / DoH 端点，默认为 DEFAULT_DOH_RESOLVER。 */
  resolver?: string;
}
export interface PushOptions {
  // Push uses the interval and token columns.
  // Push 使用 interval 和 token 列。
}
export interface AgentOptions {
  alerts?: {
    cpu?: ResourceThreshold;
    memory?: ResourceThreshold;
    disk?: ResourceThreshold;
    load?: ResourceThreshold;
  };
}

export interface AgentMachineOptions {
  probe_enabled?: boolean;
}

export interface ResourceThreshold {
  enabled: boolean;
  threshold: number;
  duration_sec: number;
  recovery_pct: number;
}

/** Primary options by monitor type; DNS options are a nested add-on block. / 各监控类型的主要选项；DNS 选项位于嵌套的附加配置中。 */
export interface OptionsByType {
  http: HttpOptions;
  tcp: TcpOptions;
  push: PushOptions;
  agent: AgentOptions;
}

/** Default resolver for JSON-format DoH queries. / JSON 格式 DoH 查询的默认解析器。 */
export const DEFAULT_DOH_RESOLVER = 'https://cloudflare-dns.com/dns-query';

/** Reads an option object; absent, malformed or non-object JSON yields {}. Does not validate fields. / 读取选项对象；缺失、格式错误或非对象 JSON 返回 {}，不验证字段。 */
export function parseOptions<T>(json: string | null | undefined): T {
  if (!json) return {} as T;
  try {
    const v = JSON.parse(json) as unknown;
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return {} as T;
    return v as T;
  } catch {
    return {} as T;
  }
}

export const UP = 1;
export const DOWN = 0;
export const WARN = 2;
/** Primary failure awaiting retries; WARN can also represent a slow successful response or an add-on warning. / 主要检查失败后等待重试；WARN 也可表示成功但缓慢的响应或附加检查警告。 */
export const PENDING = 4;

/** Consecutive active-probe failures before DOWN; Push expiry bypasses retries. / 主动探测连续失败达到此次数后判定 DOWN；Push 过期不经重试。 */
export const MAX_RETRIES = 3;

export type Status = typeof UP | typeof DOWN | typeof WARN | typeof PENDING;

/** Check observation for Analytics Engine and the database ring. / 写入 Analytics Engine 和数据库环形缓冲区的检查观测值。 */
export interface Heartbeat {
  monitorId: string;
  /** epoch seconds / Unix 时间戳（秒） */
  ts: number;
  status: Status;
  latencyMs: number;
  statusCode: number;
  message: string;
}

/** Expiry add-on reading, independent of the primary transport status. / 过期附加检查的观测值，独立于主传输状态。 */
export interface AddonReading {
  tls_valid?: boolean;
  /** SSL 来源、主机及 UTC 日期标识；持久化后跨进程复用当天结果。 / SSL source, host and UTC date key; persisted to reuse the day's reading across processes. */
  checkKey?: string;
  revoked?: boolean;
  /** 1 up, 2 warn, 0 down - the same encoding as the primary reading. / 1 为正常、2 为警告、0 为故障，与主检查编码相同。 */
  st: typeof UP | typeof DOWN | typeof WARN;
  /** Days remaining, or null when no expiry date was read. / 剩余天数；未读取到到期日期时为 null。 */
  days: number | null;
  /** Human-readable detail, e.g. issuer and expiry date. / 供人阅读的详情，例如颁发者和到期日期。 */
  msg: string;
  /** When this add-on was last checked. / 此附加检查最近一次执行的时间。 */
  ts: number;
}

/** DNS add-on reading; failed lookups are mapped to WARN. / DNS 附加检查的观测值；查询失败映射为 WARN。 */
export interface DnsAddonReading {
  /** 1 up, 2 warn - 0 is never produced here, by design. / 1 为正常、2 为警告；设计上不会产生 0。 */
  st: Status;
  /** Human-readable detail: the RCODE, the missing record type, etc. / 供人阅读的详情，如 RCODE 或缺失的记录类型。 */
  msg: string;
  /** When this add-on was last checked. / 此附加检查最近一次执行的时间。 */
  ts: number;
  hostname?: string;
  recordType?: string;
  rcode?: string;
  latencyMs?: number;
  /** Resolver answers from successful and failed expectation checks. / 预期检查成功或失败时的解析器应答。 */
  records?: string[];
}

/**
 * Live status for one monitor. All monitors share a single D1 row.
 * Deliberately flat and small so the JSON stays cheap to rewrite.
 * 单个监控的实时状态。所有监控共用一条 D1 行；结构保持扁平且精简，降低 JSON 重写成本。
 */
export interface LiveEntry {
  /** Overall verdict: DOWN, WARN, PENDING, or UP. / 总体结果：DOWN、WARN、PENDING 或 UP。 */
  st: Status;
  /** unix seconds of the last completed check / 最近完成检查的 Unix 秒数 */
  ts: number;
  /** Latency in milliseconds, or null without an observation; expiry days live in the add-on readings. / 延迟（毫秒），无观测值时为 null；剩余天数保存在附加检查观测值中。 */
  v: number | null;
  code: number;
  /** primary check's message / 主检查的消息 */
  msg: string;
  /** consecutive failures, for retry/notification logic / 连续失败次数，用于重试和通知逻辑 */
  fails: number;
  source_available?: boolean;
  /** unix seconds of the last observation the agent actually completed. / Agent 实际完成的最近观测的 Unix 秒数。 */
  source_last_observed_at?: number;
  source_run_id?: string;
  /** Last non-PENDING status, used when retrying resolves or confirms. / 最近的非 PENDING 状态，用于重试恢复或确认故障时。 */
  stable_st?: 0 | 1 | 2;
  /** An abnormal status whose notification was held during maintenance. / 维护期间被暂缓通知的异常状态。 */
  alert_pending?: boolean;
  /** present only when the monitor has check_ssl on / 仅在监控启用 check_ssl 时存在 */
  ssl?: AddonReading;
  /** present only when the monitor has check_domain on / 仅在监控启用 check_domain 时存在 */
  domain?: AddonReading;
  /** present only when the monitor has check_dns on / 仅在监控启用 check_dns 时存在 */
  dns?: DnsAddonReading;
  resource_alerts?: Record<string, { since: number; last_alert: number; active: boolean; observed_at?: number }>;
  availability?: {
    /** The minute the window's newest slot belongs to. / 窗口中最新时间槽所属的分钟。 */
    endMinute: number;
    /** Packed 1440 minute slots: 0 unobserved, 1 down, 2 up, 3 warn, 4 pending. / 打包的 1440 个分钟槽：0 未观测、1 故障、2 正常、3 警告、4 待确认。 */
    minutes: string;
    daily: [string, number, number, number] | null;
  };
}

export type LiveState = Record<string, LiveEntry>;

export type { DayStat } from '../../../shared/contracts';

/** Recent observation in `heartbeat_ring`, stored as one JSON row per monitor. `up` carries the full status code. / `heartbeat_ring` 中的近期观测，每个监控存为一行 JSON；`up` 包含完整状态码。 */
export interface RingHeartbeat {
  /** epoch seconds / Unix 时间戳（秒） */
  t: number;
  /** status: 1 up, 0 down, 2 warn, 4 pending / 状态：1 正常、0 故障、2 警告、4 待确认 */
  up: number;
  /** latency ms (CPU percent for agent monitors) / 延迟（毫秒）；Agent 监控为 CPU 百分比 */
  ms: number | null;
}

/** How many heartbeats to keep per monitor. The UI renders at most 100. / 每个监控保留的心跳数；界面最多显示 100 个。 */
export const RING_SIZE = 100;

export interface Env {
  DB: D1Database;
  SETUP_CONFIG?: DurableObjectNamespace;
  AUTOMATIC_NOTIFICATIONS_DISABLED?: string;
  /** Required for Worker setup; query credentials are only needed for SQL backfill. / Worker 初始化必需；查询凭据仅用于 SQL 回填。 */
  UPTIME?: AnalyticsEngineDataset;
  /** Built SPA assets; omitted by runtime harnesses that serve no asset directory. / 构建后的 SPA 资源；不提供资源目录的运行时测试可省略。 */
  ASSETS?: Fetcher;
  /** Installed theme assets in R2; optional when serving only the built-in UI. / R2 中已安装的主题资源；仅提供内置界面时可选。 */
  THEMES?: R2Bucket;
  CF_ACCOUNT_ID: string;
  CF_API_TOKEN: string;
  /**
   * 部署数据库类型；请求作用域中的值可能来自已保存的初始化选择。
   * Deployment database type; request-scoped values may come from the saved setup selection.
   */
  DATABASE_TYPE?: 'd1' | 'postgres';
  /**
   * PostgreSQL 连接 URL；生产部署使用 Secret，请求作用域也可由选库记录解密获得。
   * PostgreSQL URL; use a deployment secret in production, or resolve it from the encrypted setup selection.
   */
  DATABASE_URL?: string;
  /**
   * Which plan the usage panel compares against.
   *
   * A Worker cannot probe its own plan, so this is declared. Absent means
   * `free`, which is the conservative default: it shows the tighter ceiling and
   * therefore overstates usage rather than hiding it.
   * 用量面板比较的套餐。Worker 无法自行探测套餐，须通过配置声明；未设置时默认为
   * 保守的 `free`，显示较低上限，从而高估用量而非掩盖用量。
   */
  USAGE_PLAN?: 'free' | 'paid';
  /** Management credential accepted as `Authorization: Bearer <token>`; browsers use a session cookie. / 管理凭据通过 `Authorization: Bearer <token>` 提供；浏览器使用会话 Cookie。 */
  ADMIN_TOKEN: string;
  /** PBKDF2 iteration count as a Worker variable; defaults are defined in auth.ts. / 作为 Worker 变量配置的 PBKDF2 迭代次数；默认值定义在 auth.ts 中。 */
  PBKDF2_ITERATIONS?: string;
}
