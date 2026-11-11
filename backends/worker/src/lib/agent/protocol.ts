/** Wire fields must match agent/src/rpc/protocol.rs. basicReport carries identity, report carries metrics; request IDs receive a persistence ACK. / 传输字段须与 agent/src/rpc/protocol.rs 一致。basicReport 传身份，report 传指标；带请求 ID 的消息收到持久化 ACK。 */

export interface BasicReportParams {
  /** Human label; the agent sends its hostname. / 供人识别的名称；Agent 发送主机名。 */
  name: string;
  /** Operating system, e.g. "linux" | "windows" | "macos" | ... / 操作系统，例如 "linux" | "windows" | "macos" | ... */
  os: string;
  /** Architecture, e.g. "x86_64", "aarch64", ... / 架构，例如 "x86_64"、"aarch64" 等。 */
  arch: string;
  /** Kernel version string, `uname -r` style. / 内核版本字符串，格式如 `uname -r`。 */
  kernel: string;
  cpu_model: string;
  cpu_cores: number;
  /** Total RAM in bytes; the agent samples it identically every frame. / 内存总量（字节）；Agent 每帧以相同方式采样。 */
  mem_total: number;
  version: string;
  /** Optional network identity; both publicIp and publicIpv6 are persisted. / 可选网络身份；publicIp 和 publicIpv6 均会持久化。 */
  publicIp?: string;
  publicIpv6?: string;
  isp?: string;
  region?: string;
  /** Virtualization, e.g. "physical" | "kvm" | "vmware" | "hyperv" | "docker" | "virtualbox" | "xen" | ... / 虚拟化类型，例如 "physical"、"kvm"、"vmware"、"hyperv"、"docker"、"virtualbox"、"xen" 等。 */
  virtualization?: string;
  /** Transport announced by the Agent. / Agent 声明的传输方式。 */
  transport: 'ws' | 'http';
  report_interval_secs: number;
  capabilities: string[];
}

export interface AgentInterfaceStat {
  name: string;
  /** Bytes/sec uplink over the previous sample window. / 上一个采样窗口的上行速率（字节/秒）。 */
  up_rate: number;
  /** Bytes/sec downlink over the previous sample window. / 上一个采样窗口的下行速率（字节/秒）。 */
  down_rate: number;
  /** Lifetime bytes sent since boot. / 自启动以来累计发送的字节数。 */
  total_up_bytes: number;
  /** Lifetime bytes received since boot. / 自启动以来累计接收的字节数。 */
  total_down_bytes: number;
}

export interface AgentMountStat {
  /** Mount point path ("/", "/boot", "C:\\", ...). / 挂载点路径（"/"、"/boot"、"C:\\" 等）。 */
  name: string;
  total_bytes: number;
  used_bytes: number;
  free_bytes: number;
  /** 0-100, rounded to 2 dp by the agent. / 0–100，由 Agent 四舍五入到小数点后两位。 */
  used_percent: number;
}

export interface ReportParams {
  observed_at: number;
  summaries: AgentMinuteSummary[];
  cpu: {
    /** 0-100, sampled since the previous frame. / 0–100，自上一帧以来采样。 */
    usage: number;
  };
  ram: { total: number; used: number };
  swap: { total: number; used: number };
  load: { load1: number; load5: number; load15: number };
  disk: { total: number; used: number };
  network: {
    /** Bytes/second, over the sampling window. / 采样窗口内的速率（字节/秒）。 */
    up: number;
    down: number;
    /** Lifetime cumulative bytes since boot. Monotonic. / 自启动以来累计的字节数，单调递增。 */
    totalUp: number;
    totalDown: number;
  };
  connections: { tcp: number; udp: number };
  /** Seconds since boot. / 自启动以来的秒数。 */
  uptime: number;
  /** Process count. / 进程数。 */
  process: number;
  /** Free-form note; the agent sets it to its own error state if any. / 自由文本备注；Agent 存在错误时将其设为自身错误状态。 */
  message: string;
  /** Null means no interface details were collected. / null 表示未采集网卡明细。 */
  interfaces: AgentInterfaceStat[] | null;
  /** Null means no mount details were collected. / null 表示未采集挂载点明细。 */
  mounts: AgentMountStat[] | null;
}

export interface AgentMinuteSummary {
  bucket_ts: number;
  sample_count: number;
  cpu_samples: number;
  cpu_avg: number | null;
  cpu_max: number | null;
  mem_samples: number;
  mem_pct_avg: number | null;
  mem_pct_max: number | null;
  load_1_avg: number | null;
  load_5_avg: number | null;
  net_up_bytes: number | null;
  net_down_bytes: number | null;
  duration_sec: number;
  network_duration_sec: number;
}

/** Request IDs are echoed in ACKs; null or missing IDs denote notifications. / ACK 原样返回请求 ID；ID 为 null 或缺失表示通知。 */
export interface AgentRpcFrame {
  jsonrpc: string;
  id: unknown;
  method: string;
  params: unknown;
}

/** Narrow wire values before persistence; optional metrics are normalized separately from required fields. / 持久化前收窄传输值类型；可选指标与必填字段分别规范化。 */
export function asBasicReportParams(p: unknown): BasicReportParams | null {
  if (typeof p !== 'object' || p === null) return null;
  const o = p as Record<string, unknown>;
  if (typeof o.name !== 'string') return null;
  if (typeof o.os !== 'string') return null;
  if (typeof o.arch !== 'string') return null;
  if (typeof o.cpu_model !== 'string') return null;
  if (typeof o.cpu_cores !== 'number' || !Number.isFinite(o.cpu_cores)) return null;
  if (typeof o.kernel !== 'string' || typeof o.version !== 'string' || !o.version) return null;
  if (num(o.mem_total) === null || (o.transport !== 'ws' && o.transport !== 'http')) return null;
  const interval = positiveInteger(o.report_interval_secs);
  if (interval === undefined || interval > 1800) return null;
  if (!Array.isArray(o.capabilities) || o.capabilities.length > 16 || !o.capabilities.every((item) => typeof item === 'string' && /^[a-z][a-z0-9_]{0,31}$/.test(item))) return null;
  return {
    name: o.name,
    os: o.os,
    arch: o.arch,
    kernel: o.kernel,
    cpu_model: o.cpu_model,
    cpu_cores: o.cpu_cores,
    mem_total: o.mem_total as number,
    version: o.version,
    publicIp: typeof o.publicIp === 'string' ? o.publicIp : undefined,
    publicIpv6: typeof o.publicIpv6 === 'string' ? o.publicIpv6 : undefined,
    isp: typeof o.isp === 'string' ? o.isp : undefined,
    region: typeof o.region === 'string' ? o.region : undefined,
    virtualization:
      typeof o.virtualization === 'string' ? o.virtualization : undefined,
    transport: o.transport,
    report_interval_secs: interval,
    capabilities: [...new Set(o.capabilities as string[])],
  };
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function nonnegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

export function asReportParams(p: unknown): ReportParams | null {
  const o = obj(p);
  if (!o) return null;
  if (!Array.isArray(o.summaries) || o.summaries.length > 32) return null;

  const cpu = obj(o.cpu);
  const ram = obj(o.ram);
  const swap = obj(o.swap);
  const load = obj(o.load);
  const disk = obj(o.disk);
  const network = obj(o.network);
  const connections = obj(o.connections);
  if (!cpu || !ram || !swap || !load || !disk || !network || !connections) return null;

  const cpuUsage = num(cpu.usage);
  const ramTotal = num(ram.total);
  const ramUsed = num(ram.used);
  const swapTotal = num(swap.total);
  const swapUsed = num(swap.used);
  const load1 = num(load.load1);
  const load5 = num(load.load5);
  const load15 = num(load.load15);
  const diskTotal = num(disk.total);
  const diskUsed = num(disk.used);
  const netUp = num(network.up);
  const netDown = num(network.down);
  const totalUp = num(network.totalUp);
  const totalDown = num(network.totalDown);
  const connTcp = num(connections.tcp);
  const connUdp = num(connections.udp);
  const uptime = num(o.uptime);
  const process = num(o.process);
  const observedAt = num(o.observed_at);
  const summaries = asMinuteSummaries(o.summaries);
  const interfaces = asInterfaceArray(o.interfaces);
  const mounts = asMountArray(o.mounts);
  if (observedAt === null || !Number.isInteger(observedAt) || summaries === undefined ||
      interfaces === undefined || mounts === undefined || typeof o.message !== 'string') return null;

  if (
    cpuUsage === null || ramTotal === null || ramUsed === null ||
    swapTotal === null || swapUsed === null ||
    load1 === null || load5 === null || load15 === null ||
    diskTotal === null || diskUsed === null ||
    netUp === null || netDown === null || totalUp === null || totalDown === null ||
    connTcp === null || connUdp === null ||
    uptime === null || process === null
  ) {
    return null;
  }

  return {
    cpu: { usage: cpuUsage },
    ram: { total: ramTotal, used: ramUsed },
    swap: { total: swapTotal, used: swapUsed },
    load: { load1, load5, load15 },
    disk: { total: diskTotal, used: diskUsed },
    network: { up: netUp, down: netDown, totalUp, totalDown },
    connections: { tcp: connTcp, udp: connUdp },
    uptime,
    process,
    message: o.message,
    observed_at: observedAt,
    summaries,
    interfaces,
    mounts,
  };
}

function asMinuteSummary(value: unknown): AgentMinuteSummary | undefined {
  if (value === undefined || value === null) return undefined;
  const row = obj(value);
  if (!row) return undefined;
  const bucketTs = num(row.bucket_ts);
  const sampleCount = positiveInteger(row.sample_count);
  const durationSec = nonnegativeInteger(row.duration_sec);
  const networkDurationSec = nonnegativeInteger(row.network_duration_sec);
  const cpuSamples = num(row.cpu_samples);
  const memSamples = num(row.mem_samples);
  if (bucketTs === null || sampleCount === undefined || durationSec === undefined || networkDurationSec === undefined || cpuSamples === null || memSamples === null) return undefined;
  const nullableNumber = (v: unknown) => v === null ? null : num(v) ?? undefined;
  const values = [row.cpu_avg, row.cpu_max, row.mem_pct_avg, row.mem_pct_max, row.load_1_avg, row.load_5_avg, row.net_up_bytes, row.net_down_bytes].map(nullableNumber);
  if (values.some((v) => v === undefined)) return undefined;
  return {
    bucket_ts: bucketTs,
    sample_count: sampleCount,
    cpu_samples: cpuSamples,
    cpu_avg: values[0] as number | null,
    cpu_max: values[1] as number | null,
    mem_samples: memSamples,
    mem_pct_avg: values[2] as number | null,
    mem_pct_max: values[3] as number | null,
    load_1_avg: values[4] as number | null,
    load_5_avg: values[5] as number | null,
    net_up_bytes: values[6] as number | null,
    net_down_bytes: values[7] as number | null,
    duration_sec: durationSec,
    network_duration_sec: networkDurationSec,
  };
}

function asMinuteSummaries(value: unknown): AgentMinuteSummary[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (value.length > 32) return undefined;
  const summaries = value.map(asMinuteSummary);
  if (summaries.some((item) => item === undefined)) return undefined;
  return summaries as AgentMinuteSummary[];
}

function asInterfaceArray(v: unknown): AgentInterfaceStat[] | null | undefined {
  if (v === null) return null;
  if (!Array.isArray(v)) return undefined;
  const out: AgentInterfaceStat[] = [];
  for (const row of v) {
    const r = obj(row);
    if (!r) return undefined;
    const name = typeof r.name === 'string' ? r.name : null;
    const upRate = num(r.up_rate);
    const downRate = num(r.down_rate);
    const totalUp = num(r.total_up_bytes);
    const totalDown = num(r.total_down_bytes);
    if (name === null || upRate === null || downRate === null || totalUp === null || totalDown === null) return undefined;
    out.push({
      name,
      up_rate: upRate,
      down_rate: downRate,
      total_up_bytes: totalUp,
      total_down_bytes: totalDown,
    });
  }
  return out;
}

function asMountArray(v: unknown): AgentMountStat[] | null | undefined {
  if (v === null) return null;
  if (!Array.isArray(v)) return undefined;
  const out: AgentMountStat[] = [];
  for (const row of v) {
    const r = obj(row);
    if (!r) return undefined;
    const name = typeof r.name === 'string' ? r.name : null;
    const totalBytes = num(r.total_bytes);
    const usedBytes = num(r.used_bytes);
    const freeBytes = num(r.free_bytes);
    const usedPercent = num(r.used_percent);
    if (name === null || totalBytes === null || usedBytes === null || freeBytes === null || usedPercent === null) return undefined;
    out.push({
      name,
      total_bytes: totalBytes,
      used_bytes: usedBytes,
      free_bytes: freeBytes,
      used_percent: usedPercent,
    });
  }
  return out;
}
