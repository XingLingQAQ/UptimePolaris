
import { requestJson } from '@/api/client';
import { isRetryableApiError } from '@/api/errors';
import { Card, CardBody, CardHeader, Chip } from '@heroui/react';
import clsx from 'clsx';
import {
  Activity,
  AlertTriangle,
  Check,
  Clock,
  Cpu,
  HardDrive,
  Layers,
  MemoryStick,
  RefreshCw,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import useSWR from 'swr';
import { useTranslations } from 'use-intl';
import { AvailabilityRail } from '../monitor/AvailabilityRail';
import { PercentGauge } from './widgets/PercentGauge';
import { TimeSeriesChart } from './widgets/TimeSeriesChart';

/** One minute-bucketed row from /api/public/agent/detail/:numId. / /api/public/agent/detail/:numId 返回的一个分钟数据桶。 */
interface MachineHistoryBucket {
  bucket_ts: number;
  cpu_avg: number | null;
  cpu_max: number | null;
  mem_pct_avg: number | null;
  mem_pct_max: number | null;
  load_1_avg: number | null;
  load_5_avg: number | null;
  sample_count: number | null;
  duration_sec: number | null;
  quality: 'aggregate';
  net_up_bytes: number | null;
  net_down_bytes: number | null;
  network_duration_sec: number | null;
}

interface MachineLive {
  os: string | null;
  arch: string | null;
  kernel: string | null;
  cpu_model: string | null;
  cpu_cores: number | null;
  version: string | null;
  public_ipv6: string | null;
  report_interval_secs: number | null;
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
  /** Optional network and host metadata; missing values render as an em dash. / 可选的网络和主机元数据；缺失值显示为破折号。 */
  public_ip: string | null;
  isp: string | null;
  region: string | null;
  virtualization: string | null;

  transport: string | null;
  /** Serialized interface and mount snapshots; null means no detail was supplied. / 序列化的网络接口和挂载点快照；null 表示未提供详情。 */
  interfaces_json: string | null;
  mounts_json: string | null;
  reported_at: number | null;
  updated_at: number;
}

interface InterfaceRow {
  name: string;
  up_rate: number;
  down_rate: number;
  total_up_bytes: number;
  total_down_bytes: number;
}

interface MountRow {
  name: string;
  total_bytes: number;
  used_bytes: number;
  free_bytes: number;
  used_percent: number;
}

/** Parse the TEXT column to a typed array; invalid JSON becomes null. / 把 TEXT 列解析为数组；无效 JSON 变为 null。 */
function parseInterfaces(raw: string | null | undefined): InterfaceRow[] | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return null;
    return v.filter(
      (r): r is InterfaceRow =>
        r && typeof r === 'object' && typeof r.name === 'string',
    );
  } catch {
    return null;
  }
}

function parseMounts(raw: string | null | undefined): MountRow[] | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return null;
    return v.filter(
      (r): r is MountRow =>
        r && typeof r === 'object' && typeof r.name === 'string',
    );
  } catch {
    return null;
  }
}

interface AgentDetailResponse {
  now: number;
  monitor: { id: string; num_id: number; name: string; type: 'agent'; active: number };
  live: MachineLive | null;
  online: boolean | null;
  staleAfterSec: number;
  buckets: MachineHistoryBucket[];
  /** Per-day availability rows for the 90-day rail. / 90 天栏使用的每日可用率。 */
  availability?: Array<{ d: string; t: number; u: number; w: number; avg: number }>;
}

const fetcher = (url: string) => requestJson<AgentDetailResponse>(url);

/** One-second-friendly size formatter. 0 stays "0 B". / 适合每秒刷新的大小格式化函数；0 保持显示为“0 B”。 */
function formatBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  const s = v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2);
  return `${s} ${units[i]}`;
}

/** Per-second rate variant of formatBytes. / formatBytes 的每秒速率版本。 */
function formatRate(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${formatBytes(n)}/s`;
}

/** The shape `useTranslations()` returns, narrowed to what this file uses. / `useTranslations()` 返回类型在本文件中的精简形式。 */
type TFn = (key: string, values?: Record<string, string | number | Date>) => string;

/** Format at most two time units. / 最多显示两个时间单位。 */
function formatUptimeSeconds(sec: number | null | undefined, t: TFn): string {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return '—';
  const minutes = Math.floor(sec / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days >= 1) {
    return `${t('detail.days', { count: days })} ${t('detail.hours', { count: hours % 24 })}`;
  }
  if (hours >= 1) {
    return `${t('detail.hours', { count: hours })} ${t('detail.minutes', { count: minutes % 60 })}`;
  }
  if (minutes >= 1) {
    return t('detail.minutes', { count: minutes });
  }
  return t('detail.secondsAgo', { n: Math.max(0, Math.floor(sec)) });
}

/** "3 seconds ago" / "now", computed against the response's `now`. / 基于响应中的 `now` 计算“3 秒前”或“刚刚”。 */
function formatReportAgo(
  reportedAt: number | null | undefined,
  now: number,
  t: TFn,
): string {
  if (reportedAt == null || reportedAt <= 0) return '—';
  const delta = Math.max(0, now - reportedAt);
  if (delta < 5) return t('detail.now');
  if (delta < 60) return t('detail.secondsAgo', { n: delta });
  return t('detail.minutesAgo', { n: Math.floor(delta / 60) });
}

/** A labelled row inside the system-info list. Static, two-line safe. / 系统信息列表中带标签的一行；静态显示且可容纳两行。 */
function InfoRow({
  label,
  value,
  children,
}: {
  label: string;
  value?: string | number;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-tiny text-default-500">{label}</span>
      {children ?? (
        <span className="truncate font-mono text-small tabular-nums">{value}</span>
      )}
    </div>
  );
}

/** Map the wire virtualization string to a translated chip; unknown values stay grey. / 把虚拟化类型映射为翻译标签；未知值显示为灰色。 */
function VirtChip({ virt, t }: { virt: string | null | undefined; t: TFn }) {
  if (!virt) return <span className="truncate font-mono text-small tabular-nums">—</span>;
  const key = virt.toLowerCase();
  const known: Record<string, { label: string; tone: 'physical' | 'virtual' | 'unknown' }> = {
    physical: { label: t('detail.virtPhysical'), tone: 'physical' },
    kvm: { label: t('detail.virtKvm'), tone: 'virtual' },
    vmware: { label: t('detail.virtVmware'), tone: 'virtual' },
    hyperv: { label: t('detail.virtHyperv'), tone: 'virtual' },
    'hyper-v': { label: t('detail.virtHyperv'), tone: 'virtual' },
    docker: { label: t('detail.virtDocker'), tone: 'virtual' },
    virtualbox: { label: t('detail.virtVirtualbox'), tone: 'virtual' },
    xen: { label: t('detail.virtXen'), tone: 'virtual' },
    unknown: { label: t('detail.virtUnknown'), tone: 'unknown' },
  };
  const hit = known[key];
  const className = clsx(
    'px-1.5 py-0.5 text-tiny font-mono tabular-nums rounded-small border',
    hit?.tone === 'physical' && 'border-success/30 bg-success/10 text-success',
    hit?.tone === 'virtual' && 'border-primary/30 bg-primary/10 text-primary',
    (!hit || hit.tone === 'unknown') &&
      'border-default-300 bg-default-100 text-default-600',
  );
  return <span className={className}>{hit ? hit.label : virt}</span>;
}

/** One header metric; `value2` pairs related numbers like up/down. / 头部指标；`value2` 用于成对数值，如上下行。 */
function HeaderStat({
  icon,
  label,
  value,
  value2,
}: {
  icon?: React.ReactNode;
  label: string;
  value: string;
  value2?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5 bg-content1 px-4 py-2.5">
      <span className="flex items-center gap-1.5 text-tiny text-default-500">
        {icon}
        {label}
      </span>
      <span className="font-mono text-small font-medium tabular-nums">
        {value}
        {value2 ? <span className="ml-2 text-default-500">{value2}</span> : null}
      </span>
    </div>
  );
}

interface AgentDetailContentProps {
  /** Public numeric monitor id used by `/monitor/:id`, not the UUID. / `/monitor/:id` 使用的公开数字 ID，不是 UUID。 */
  numId: number;
  /** Monitor name, fed back from the parent so the heading never flickers. / 父组件传回的监控名称，避免标题闪烁。 */
  monitorName?: string;
  /** Target (host:port line), shown under the name when present. / 目标（host:port）；存在时显示在名称下方。 */
  target?: string;
}

export function AgentDetailContent({ numId, monitorName, target }: AgentDetailContentProps) {
  // Top-level catalog: `detail.*` is not under the admin namespace. / 顶层词表：`detail.*` 不在 admin 命名空间。
  const t = useTranslations();
  const { data, error, isLoading } = useSWR<AgentDetailResponse>(
    `/api/public/agent/detail/${numId}?minutes=60`,
    fetcher,
    { refreshInterval: 15_000, revalidateOnFocus: false, dedupingInterval: 5_000, shouldRetryOnError: isRetryableApiError, errorRetryCount: 2 },
  );

  /** Tick the relative time locally; no refetch needed. / 本地刷新相对时间；无需重新请求。 */
  const [nowTick, setNowTick] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const h = setInterval(() => setNowTick(Math.floor(Date.now() / 1000)), 1_000);
    return () => clearInterval(h);
  }, []);

  const live = data?.live ?? null;
  const resolvedName = monitorName ?? data?.monitor.name ?? '';
  const online = live?.reported_at == null
    ? null
    : nowTick - live.reported_at <= (data?.staleAfterSec ?? 30);
  const isUp = online === true;
  const isDown = online === false;

  const cpuPct = live?.cpu_usage ?? null;
  const memPct =
    live?.mem_used != null && live?.mem_total ? (live.mem_used / live.mem_total) * 100 : null;
  const diskPct =
    live?.disk_used != null && live?.disk_total
      ? (live.disk_used / live.disk_total) * 100
      : null;

  /**
   * Network is a rate, not a counter.
   *
   * `machine_history` stores byte totals, so charting totals would be a line that
   * only climbs; the delta between adjacent buckets is what a viewer wants.
   * 历史存的是字节总量；画总量只会一路上涨，必须画相邻桶差值。
   */
  const series = useMemo(() => {
    const buckets = data?.buckets ?? [];
    const now = data?.now ?? Math.floor(Date.now() / 1000);
    const rows = new Map(buckets.map((b) => [b.bucket_ts, b]));
    const start = Math.floor((now - 59 * 60) / 60) * 60;
    const timeline = Array.from({ length: 60 }, (_, i) => rows.get(start + i * 60));
    const cpu = timeline.map((b, i) => ({ ts: start + i * 60, value: b?.quality === 'aggregate' ? b.cpu_avg : null }));
    const mem = timeline.map((b, i) => ({ ts: start + i * 60, value: b?.quality === 'aggregate' ? b.mem_pct_avg : null }));
    const load = timeline.map((b, i) => ({ ts: start + i * 60, value: b?.quality === 'aggregate' ? b.load_1_avg : null }));
    const net = timeline.map((b, i) => ({
      ts: start + i * 60,
      value: b?.quality === 'aggregate' && b.network_duration_sec && b.net_up_bytes != null && b.net_down_bytes != null
        ? (b.net_up_bytes + b.net_down_bytes) / b.network_duration_sec
        : null,
    }));
    return { cpu, mem, load, net };
  }, [data?.buckets]);

  const interfaces = useMemo(
    () => parseInterfaces(live?.interfaces_json),
    [live?.interfaces_json],
  );
  const mounts = useMemo(() => parseMounts(live?.mounts_json), [live?.mounts_json]);

  if (isLoading) {
    return (
      <div className="py-1">
        <div className="mx-auto flex max-w-6xl flex-col gap-4">
          <div className="h-8 w-64 rounded-large bg-default-100" />
          <div className="h-40 rounded-large bg-default-100" />
          <div className="h-64 rounded-large bg-default-100" />
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="py-1">
        <div className="mx-auto flex max-w-6xl flex-col items-center gap-4 py-16">
          <AlertTriangle className="text-danger" size={32} />
          <p className="text-default-500">{t('error.requestData')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="py-1">
      <div className="mx-auto flex max-w-6xl flex-col gap-4">
          {/* ------------------------------------------------ header / 页头 */}
          {/*
            Identity, state and the four numbers that change every tick, in one
            block.

            These four used to be a separate footer card at the very bottom,
            which read as a stray strip: the values an operator checks most
            often - is it alive, how long has it been up, when did it last
            report - sat furthest from the name they belong to. They are the
            header's second row now, divided from the identity line so the
            grouping still reads as two things rather than five.

            身份、状态和每次更新变化的四个数字合在一个区块。它们以前单独放在最底部
            页脚卡片中，使操作人员常看的在线、运行时长和最近上报时间远离对应名称。
            现在作为页头第二行，与身份行分隔，使整体仍读作两组而非五个独立对象。
          */}
          <Card>
            <CardHeader className="flex flex-wrap items-center justify-between gap-3 px-5 pt-4 pb-3">
              <div className="flex min-w-0 items-center gap-3">
                <span
                  className={clsx(
                    'flex h-10 w-10 shrink-0 items-center justify-center rounded-full',
                    isUp ? 'bg-success/15 text-success' : isDown ? 'bg-danger/15 text-danger' : 'bg-default-100 text-default-500',
                  )}
                >
                  <Cpu size={18} />
                </span>
                <div className="min-w-0">
                  <h1 className="truncate text-xl font-semibold">{resolvedName}</h1>
                  {target ? <p className="truncate text-tiny text-default-500">{target}</p> : null}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {/* Uptime beside the badge: "up, and for how long" is one fact. / 运行时间放在状态徽章旁，因为“在线及其持续时间”是一条信息。 */}
                <span className="hidden font-mono text-tiny tabular-nums text-default-500 sm:inline">
                  {t('detail.uptime')} {formatUptimeSeconds(live?.uptime, t)}
                </span>
                <Chip
                  size="sm"
                  variant="flat"
                  className={clsx(isUp ? 'text-success' : isDown ? 'text-danger' : 'text-default-500')}
                  startContent={isUp ? <Check size={12} /> : isDown ? <AlertTriangle size={12} /> : undefined}
                >
                  {online === null ? t('detail.unknown') : isUp ? t('detail.up') : t('detail.down')}
                </Chip>
              </div>
            </CardHeader>
            <div className="grid grid-cols-2 gap-px border-t border-divider bg-divider sm:grid-cols-4">
              <HeaderStat
                icon={<RefreshCw size={12} />}
                label={t('detail.network')}
                value={`↓ ${formatRate(live?.net_down_rate)}`}
                value2={`↑ ${formatRate(live?.net_up_rate)}`}
              />
              <HeaderStat
                icon={<Activity size={12} />}
                label={t('detail.connections')}
                value={`TCP ${live?.connections_tcp ?? '—'}`}
                value2={`UDP ${live?.connections_udp ?? '—'}`}
              />
              <HeaderStat
                icon={<Layers size={12} />}
                label={t('detail.processes')}
                value={live?.process_count != null ? String(live.process_count) : '—'}
              />
              <HeaderStat
                icon={<Clock size={12} />}
                label={t('detail.lastReport')}
                value={formatReportAgo(live?.reported_at, nowTick, t)}
              />
            </div>
          </Card>

          {/* -------------------------------------------- identity + gauges / 身份信息与仪表 */}
          {/*
            Facts on the left, utilisation on the right, and the split is the
            point.

            This was one narrow info list beside three gauges, which left the
            gauges adrift in a 318px card and ran the list nine rows deep -
            "which machine is this" and "how hard is it working" are two
            questions, and they were interleaved down a single column.

            The facts are grouped now (the machine, then where it sits on the
            network), and the gauges sit in one row sharing a baseline.

            左侧放身份信息、右侧放利用率，重点在于区分这两类问题。此前窄信息列表
            位于三个仪表旁，列表长达九行，仪表散落在 318px 卡片中，
            “机器是谁”和“负载多高”混在同一列。现在将机器与网络信息分组，
            仪表在一行共用基线。
          */}
          <Card>
            {/*
              `grid-cols-1`, not a bare `grid`, and it is load-bearing.

              A grid with no explicit columns gets `auto` tracks, which size to
              their content's min-content width and cannot shrink below it. On
              a 420px viewport this column resolved to 371.9px inside a 293px
              card, so the gauge row overflowed and the third ring was clipped
              by the card's `overflow-hidden` - invisible, because a clipped
              element still reports a position.

              Tailwind's `grid-cols-1` is `repeat(1, minmax(0, 1fr))`: the
              `minmax(0, ...)` is what allows the shrink. The `lg:` override
              then replaces it at desktop.

              必须使用 `grid-cols-1` 而非只有 `grid`。未显式指定列时，auto 轨道
              按内容最小宽度计算且不能继续收缩；420px 视口中该列在 293px 卡片内
              达到 371.9px，仪表行溢出，第三个圆环被 `overflow-hidden` 裁掉；
              被裁元素仍报告位置，使问题不易发现。Tailwind 的 `grid-cols-1` 是
              `repeat(1, minmax(0, 1fr))`，其中 minmax 的 0 允许收缩；
              桌面尺寸再由 `lg:` 规则覆盖。
            */}
            <CardBody className="grid grid-cols-1 gap-6 px-5 py-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] lg:gap-8">
              <div className="grid grid-cols-1 gap-x-8 gap-y-5 sm:grid-cols-2">
                <section className="flex flex-col gap-2">
                  <h2 className="text-tiny font-medium tracking-wide text-default-400 uppercase">
                    {t('detail.machine')}
                  </h2>
                  <InfoRow label={t('detail.os')} value={live?.os ?? '—'} />
                  <InfoRow label={t('detail.agentVersion')} value={live?.version ?? '—'} />
                  <InfoRow label={t('detail.arch')} value={live?.arch ?? '—'} />
                  <InfoRow label={t('detail.cpuModel')} value={live?.cpu_model ?? '—'} />
                  <InfoRow
                    label={t('detail.cpuCores')}
                    value={live?.cpu_cores != null ? String(live.cpu_cores) : '—'}
                  />
                  <InfoRow label={t('detail.virtualization')}>
                    <VirtChip virt={live?.virtualization} t={t} />
                  </InfoRow>
                </section>
                <section className="flex flex-col gap-2">
                  <h2 className="text-tiny font-medium tracking-wide text-default-400 uppercase">
                    {t('detail.networkLocation')}
                  </h2>
                  <InfoRow label={t('detail.publicIp')} value={live?.public_ip ?? '—'} />
                  <InfoRow label={t('detail.isp')} value={live?.isp ?? '—'} />
                  <InfoRow label={t('detail.region')} value={live?.region ?? '—'} />
                  {/* Display the reported transport without inferring why WebSocket is unavailable. / 显示上报的传输方式，不推测 WebSocket 不可用的原因。 */}
                  <InfoRow label={t('detail.transport')}>
                    <Chip
                      size="sm"
                      variant="flat"
                      className={clsx(
                        'font-mono',
                        live?.transport === 'http' ? 'text-warning' : 'text-default-600',
                      )}
                    >
                      {live?.transport ? live.transport.toUpperCase() : t('detail.unknown')}
                    </Chip>
                  </InfoRow>
                  {live?.transport === 'http' ? (
                    <p className="text-tiny text-warning">{t('detail.transportFallback')}</p>
                  ) : null}
                </section>
              </div>

              {/*
                Three rings in a row, at 80px rather than 96.

                A **grid**, not `justify-around`. The rings are equal but their
                sub-labels are not - "10.7 GB / 15.6 GB" is half again as wide
                as "16 cores" - so content-sized flex items produced visibly
                uneven gaps (measured: 51px then 66px). Three equal columns
                space the rings themselves evenly, which is what the eye reads
                as aligned.

                `min-w-0` on the *children*, and that placement is the whole
                fix. A grid track defaults to `minmax(auto, 1fr)`, so each
                column refused to shrink below its sub-label's min-content
                width: on a 420px viewport the row resolved to 372px inside a
                293px card and the third ring sat at 429px, clipped inside the
                card's scroll container. `min-w-0` lets the track shrink and
                the label truncate instead.

                96px rings beside a nine-row list read as the page's subject;
                at this size in a row they read as readings on a dashboard,
                which is what they are.

                三个圆环一行显示，尺寸使用 80px 而非 96px。使用等宽网格而非
                `justify-around`：圆环大小相同但副标签宽度不同，“10.7 GB / 15.6 GB”
                比“16 cores”宽约一半，按内容分配的 flex 间距实测为 51px 和 66px；
                等宽三列使圆环自身等距。`min-w-0` 必须放在子元素上：默认轨道
                `minmax(auto, 1fr)` 不能小于副标签最小内容宽度；420px 视口中该行
                在 293px 卡片内达到 372px，第三个圆环位于 429px 并被滚动容器裁剪。
                子元素的 `min-w-0` 允许轨道收缩并截断标签。96px 圆环与九行列表并列
                时像页面主体，80px 的一行圆环则更像仪表板读数。
              */}
              <div className="grid grid-cols-3 gap-2 lg:content-center lg:border-l lg:border-divider lg:pl-6">
                <div className="flex min-w-0 justify-center">
                  <PercentGauge
                    value={cpuPct ?? 0}
                    label={t('detail.cpuUsage')}
                    sub={live?.cpu_cores ? `${live.cpu_cores} ${t('detail.cores')}` : undefined}
                    size={80}
                  />
                </div>
                <div className="flex min-w-0 justify-center">
                  <PercentGauge
                    value={memPct ?? 0}
                    label={t('detail.memory')}
                    sub={
                      live?.mem_used != null && live?.mem_total != null
                        ? `${formatBytes(live.mem_used)} / ${formatBytes(live.mem_total)}`
                        : undefined
                    }
                    size={80}
                  />
                </div>
                <div className="flex min-w-0 justify-center">
                  <PercentGauge
                    value={diskPct ?? 0}
                    label={t('detail.disk')}
                    sub={
                      live?.disk_used != null && live?.disk_total != null
                        ? `${formatBytes(live.disk_used)} / ${formatBytes(live.disk_total)}`
                        : undefined
                    }
                    size={80}
                  />
                </div>
              </div>
            </CardBody>
          </Card>

          {/* ------------------------------------------------- last hour / 最近一小时 */}
          <Card>
            <CardBody className="gap-4 px-5 py-5">
              <h2 className="text-small font-semibold">{t('detail.lastHour')}</h2>
              {/* `grid-cols-1` for the same reason as the identity card: a bare
                  grid's `auto` tracks cannot shrink below their content, and a
                  recharts container has a min-content width of its own.
                  与身份卡相同，使用 `grid-cols-1`：普通 grid 的 auto 轨道不能小于内容，
                  而 Recharts 容器本身有最小内容宽度。 */}
              <div className="grid grid-cols-1 gap-x-6 gap-y-8 sm:grid-cols-2 sm:gap-y-10">
                <section>
                  <p className="mb-2 flex items-center gap-2 text-tiny text-default-500">
                    <Cpu size={12} /> {t('detail.cpuUsage')}
                  </p>
                  <TimeSeriesChart
                    data={series.cpu}
                    label={t('detail.cpuUsage')}
                    color="primary"
                    yMax={100}
                    formatValue={(v) => `${v.toFixed(1)}%`}
                  />
                </section>
                <section>
                  <p className="mb-2 flex items-center gap-2 text-tiny text-default-500">
                    <MemoryStick size={12} /> {t('detail.memory')}
                  </p>
                  <TimeSeriesChart
                    data={series.mem}
                    label={t('detail.memory')}
                    color="success"
                    yMax={100}
                    formatValue={(v) => `${v.toFixed(1)}%`}
                  />
                </section>
                <section>
                  <p className="mb-2 flex items-center gap-2 text-tiny text-default-500">
                    <RefreshCw size={12} /> {t('detail.network')}
                  </p>
                  <TimeSeriesChart
                    data={series.net}
                    label={t('detail.network')}
                    color="warning"
                    yMax="auto"
                    formatValue={(v) => formatRate(v)}
                    formatY={(v) => formatBytes(v)}
                  />
                </section>
                <section>
                  <p className="mb-2 flex items-center gap-2 text-tiny text-default-500">
                    <HardDrive size={12} /> {t('detail.load')}
                  </p>
                  <TimeSeriesChart
                    data={series.load}
                    label={t('detail.load')}
                    color="danger"
                    yMax="auto"
                    formatValue={(v) => v.toFixed(2)}
                  />
                </section>
              </div>
            </CardBody>
          </Card>

          {/* --------------------------------- per-NIC + per-mount / 按网卡和挂载点 */}
          {/*
            Side by side rather than stacked.

            Two short tables one above the other left most of a 1120px card
            empty and pushed the 90-day rail below the fold for no reason. They
            answer sibling questions - what is this box talking to, and what is
            it storing - so they read better as two columns.

            两张表并排而非堆叠：上下排列会让 1120px 卡片大部分留空，
            还会无故将 90 天状态条推到首屏以下。它们分别回答机器与谁通信及存储什么，
            是并列问题，双列更易阅读。
          */}
          <Card>
            <CardBody className="grid grid-cols-1 gap-6 px-5 py-5 lg:grid-cols-2 lg:gap-8">
              <section>
                <h2 className="mb-3 text-small font-semibold">{t('detail.interfaces')}</h2>
                {interfaces === null ? (
                  <p className="text-small text-default-400">{t('detail.noInterfaces')}</p>
                ) : interfaces.length === 0 ? (
                  <p className="text-small text-default-400">—</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-small">
                      <thead>
                        <tr className="border-b border-divider text-left text-tiny text-default-500">
                          <th className="pb-2 pr-4 font-medium">{t('detail.name')}</th>
                          <th className="pb-2 pr-4 font-medium">{t('detail.rate')}</th>
                          <th className="pb-2 font-medium">{t('detail.cumulative')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {interfaces.map((nic) => (
                          <tr key={nic.name} className="border-b border-divider/50 last:border-0">
                            <td className="py-2 pr-4 font-mono tabular-nums">{nic.name}</td>
                            <td className="py-2 pr-4 font-mono tabular-nums">
                              <span className="text-success">↓ {formatRate(nic.down_rate)}</span>
                              {' '}
                              <span className="text-warning">↑ {formatRate(nic.up_rate)}</span>
                            </td>
                            <td className="py-2 font-mono tabular-nums text-default-600">
                              ↓ {formatBytes(nic.total_down_bytes)} / ↑ {formatBytes(nic.total_up_bytes)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
              <section>
                <h2 className="mb-3 text-small font-semibold">{t('detail.disks')}</h2>
                {mounts === null ? (
                  <p className="text-small text-default-400">{t('detail.noMounts')}</p>
                ) : mounts.length === 0 ? (
                  <p className="text-small text-default-400">—</p>
                ) : (
                  <div className="flex flex-col gap-3">
                    {/*
                      A bar per mount rather than a third numeric column.
                      "89.2%" beside "178 GB / 200 GB" asks the reader to do the
                      comparison in their head; a bar makes a filling disk the
                      thing you notice, which is the reason anyone opens this
                      page.

                      每个挂载点显示进度条而非第三个数字列；单看“89.2%”和
                      “178 GB / 200 GB”需要心算比较，进度条能突出接近满载的磁盘，
                      而这正是用户打开页面的原因。
                    */}
                    {mounts.map((m) => {
                      const pct = Math.max(0, Math.min(100, m.used_percent));
                      const tone =
                        pct >= 90 ? 'bg-danger' : pct >= 70 ? 'bg-warning' : 'bg-success';
                      return (
                        <div key={m.name} className="flex flex-col gap-1">
                          <div className="flex items-baseline justify-between gap-3">
                            <code className="truncate font-mono text-small">{m.name}</code>
                            <span className="shrink-0 font-mono text-tiny tabular-nums text-default-500">
                              {formatBytes(m.used_bytes)} / {formatBytes(m.total_bytes)}
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-default-100">
                              <div
                                className={clsx('h-full rounded-full transition-all', tone)}
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                            <span className="w-12 shrink-0 text-right font-mono text-tiny tabular-nums">
                              {pct.toFixed(1)}%
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            </CardBody>
          </Card>

          {/* ----------------------------------------- 90-day availability / 90 天可用率 */}
          <Card>
            <CardBody className="gap-3 px-5 py-4">
              <h2 className="text-small font-semibold">{t('detail.availability90d')}</h2>
              <AvailabilityRail
                days={data.availability ?? []}
                emptyLabel={t('detail.noAvailability')}
              />
            </CardBody>
          </Card>
      </div>
    </div>
  );
}
