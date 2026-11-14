import { HistoryNotice } from '@/components/charts/HistoryNotice';
import { loadTone, percentOf } from '@/lib/resource-metrics';
import { Drawer } from '@/components/ui/MotionOverlays';
import { TrendChart, type TrendPoint } from '@/components/charts/TrendChart';
import { useLocale } from '@/i18n/IntlProvider';
import { Button, DrawerBody, DrawerContent, DrawerFooter, DrawerHeader } from '@heroui/react';
import clsx from 'clsx';
import {
  AlertTriangle,
  BellRing,
  ChartSpline,
  ChevronRight,
  Cpu,
  Fingerprint,
  HardDrive,
  Loader2,
  MemoryStick,
  Network,
  Pencil,
  Radar,
  Timer
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslations } from 'use-intl';
import { Meter, Ring } from '../../components/ui/MetricMeters';
import { Segmented } from '../../components/ui/Segmented';
import { TONE_TEXT } from '../../components/ui/StatusDot';
import type { Tone } from '../../types/tone';
import { KeyValueList } from '../components/ConsolePrimitives';
import { CountryFlag, countryOf } from '../components/CountryFlag';
import { IconTile } from '../components/IconTile';
import { OsBadge } from '../components/OsBadge';
import { formatBytes, formatClock, formatRate } from '../format';
import { StatusPill } from '../monitors/MonitorIndicators';
import { agentsApi } from './api';
import type { AgentAlertRule, AgentDetailResponse, AgentInterface, AgentMount, FleetAgent } from './types';

function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return `${value.toFixed(1)}%`;
}

function formatUptime(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return '—';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function usedPercent(mount: AgentMount): number | null {
  if (Number.isFinite(mount.used_percent)) return mount.used_percent;
  return percentOf(mount.used, mount.total);
}

/** Relative time with the same buckets as the fleet row. / 相对时间，与 Agent 列表行使用相同区间。 */
function formatAgo(
  seconds: number | null,
  t: ReturnType<typeof useTranslations<'admin.agents'>>,
): string {
  if (seconds === null) return t('never');
  if (seconds < 90) return t('agoSeconds', { n: Math.max(0, Math.round(seconds)) });
  if (seconds < 5400) return t('agoMinutes', { n: Math.round(seconds / 60) });
  if (seconds < 172800) return t('agoHours', { n: Math.round(seconds / 3600) });
  return t('agoDays', { n: Math.round(seconds / 86400) });
}

const ALERT_RESOURCE_KEY: Record<AgentAlertRule['resource'], string> = {
  cpu: 'colCpu',
  memory: 'colMemory',
  disk: 'colDisk',
  load: 'alertResourceLoad',
};

/** 机器详情包含资源、近期历史、探测任务和告警规则。 / Show machine resources, recent history, probe jobs, and alert rules. */
export function AgentDetailDialog({
  agent,
  onClose,
  onEdit,
}: {
  agent: FleetAgent | null;
  onClose: () => void;
  onEdit: (agent: FleetAgent) => void;
}) {
  const t = useTranslations('admin.agents');
  const { locale } = useLocale();
  const open = agent !== null;
  const [detail, setDetail] = useState<AgentDetailResponse | null>(null);
  const detailRequest = useRef<AbortController | null>(null);
  const [detailState, setDetailState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const probeEnabled = (detail?.agent ?? agent)?.probe_enabled !== false;

  const memPercent = agent ? percentOf(agent.mem_used, agent.mem_total) : null;
  const diskPercent = agent ? percentOf(agent.disk_used, agent.disk_total) : null;
  const mounts = detail?.mounts ?? agent?.mounts ?? [];
  const interfaces = detail?.interfaces ?? agent?.interfaces ?? [];
  const alerts = detail?.alerts ?? [];
  const probeTargets = detail?.probe_targets ?? [];
  const probeJobs = detail?.probe_jobs ?? [];

  const refresh = useCallback(async (id: string) => {
    detailRequest.current?.abort();
    const controller = new AbortController();
    detailRequest.current = controller;
    const { signal } = controller;
    setDetailState('loading');
    try {
      const response = await agentsApi.agentDetail(id, signal);
      if (signal.aborted) return;
      setDetail(response);
      setDetailState('ready');
    } catch {
      if (signal.aborted) return;
      setDetail(null);
      setDetailState('error');
    }
  }, []);

  useEffect(() => {
    if (!agent) return;
    setDetail(null);
    void refresh(agent.id);
    return () => detailRequest.current?.abort();
  }, [agent?.id, refresh]);
  const liveState: 'online' | 'offline' | 'never' | 'paused' = !agent
    ? 'never'
    : !agent.active
      ? 'paused'
      : agent.online === true
        ? 'online'
        : agent.online === false
          ? 'offline'
          : 'never';
  const liveTone: Tone = liveState === 'online' ? 'up' : liveState === 'offline' ? 'down' : 'idle';
  const liveLabel = t(
    liveState === 'online' ? 'stateOnline' : liveState === 'offline' ? 'stateOffline' : liveState === 'never' ? 'stateNever' : 'statePaused',
  );

  return (
    /*
      A drawer, matching the monitor editor: both are "open a row and work on
      it", and a centred modal next to a right-hand drawer made the console
      feel like two different applications.

      使用与监控编辑器一致的抽屉：两者都是打开一行进行操作；
      若一个使用居中模态框、另一个使用右侧抽屉，会让控制台看起来像两个应用。
    */
    <Drawer
      isOpen={open}
      onClose={onClose}
      placement="right"
      size="xl"
      scrollBehavior="inside"
      classNames={{ base: 'bg-[var(--polaris-canvas)]' }}
    >
      <DrawerContent>
        <DrawerHeader className="flex items-start gap-3.5 border-b border-[var(--polaris-line)] bg-[var(--polaris-card)] py-4 pr-12">
          {agent ? <OsBadge os={agent.os} size="lg" /> : null}
          <div className="flex min-w-0 flex-col gap-1">
            <span className="flex flex-wrap items-center gap-2">
              <span className="truncate text-medium font-semibold">{agent?.name ?? ''}</span>
              {agent ? <StatusPill tone={liveTone} label={liveLabel} pulse={liveState === 'offline'} /> : null}
            </span>
            <span className="truncate text-tiny font-normal text-default-500">
              {agent ? [agent.os, agent.arch, agent.kernel].filter(Boolean).join(' · ') || t('never') : ''}
            </span>
            {agent ? (
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-tiny font-normal text-default-400">
                {agent.region ? (
                  <span className="flex items-center gap-1.5">
                    <CountryFlag code={countryOf(agent.region)} size={14} />
                    {agent.region}
                  </span>
                ) : null}
                {agent.isp ? <span>{agent.isp}</span> : null}
                {agent.last_reported_at !== null ? (
                  <span title={new Date(agent.last_reported_at * 1000).toLocaleString(locale)}>
                    {t('colReport')} · {formatAgo(agent.stale_for_sec, t)}
                  </span>
                ) : null}
              </span>
            ) : null}
          </div>
        </DrawerHeader>

        <DrawerBody className="polaris-scroll-x min-h-0 gap-4 py-5">
          {agent ? (
            <>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Gauge
                  icon={<Cpu />}
                  label={t('colCpu')}
                  percent={agent.cpu_usage}
                  detail={agent.cpu_cores ? t('cores', { n: agent.cpu_cores }) : undefined}
                />
                <Gauge
                  icon={<MemoryStick />}
                  label={t('colMemory')}
                  percent={memPercent}
                  detail={`${formatBytes(agent.mem_used)} / ${formatBytes(agent.mem_total)}`}
                />
                <Gauge
                  icon={<HardDrive />}
                  label={t('colDisk')}
                  percent={diskPercent}
                  detail={`${formatBytes(agent.disk_used)} / ${formatBytes(agent.disk_total)}`}
                />
              </div>

              {detailState === 'error' ? (
                <p className="flex items-center gap-2 rounded-xl border border-warning/25 bg-warning/10 px-3.5 py-2.5 text-tiny text-warning-700">
                  <AlertTriangle size={14} className="shrink-0" />
                  {t('detailFailed')}
                </p>
              ) : null}

              {detailState === 'ready' ? (
                <TrendCard detail={detail} t={t} onRetry={() => { if (agent) void refresh(agent.id); }} />
              ) : detailState === 'loading' ? (
                <div className="polaris-card flex h-[17rem] items-center justify-center">
                  <Loader2 size={18} className="animate-spin text-default-300" />
                </div>
              ) : null}

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Section icon={<Fingerprint />} title={t('sectionIdentity')}>
                  <KeyValueList
                    items={[
                      { label: t('fieldVersion'), value: agent.version ?? '—', mono: true },
                      { label: t('fieldKernel'), value: agent.kernel ?? '—' },
                      { label: t('fieldCpuModel'), value: agent.cpu_model ?? '—' },
                      { label: t('fieldVirtualization'), value: agent.virtualization ?? '—' },
                      { label: t('fieldArch'), value: agent.arch ?? '—' },
                    ]}
                  />
                </Section>

                <Section icon={<Network />} title={t('sectionNetwork')}>
                  <KeyValueList
                    items={[
                      { label: t('fieldPublicIpv4'), value: agent.public_ip ?? '—', mono: true },
                      { label: t('fieldPublicIpv6'), value: agent.public_ipv6 ?? '—', mono: true },
                      { label: t('fieldIsp'), value: agent.isp ?? '—' },
                      { label: t('fieldRegion'), value: agent.region ?? '—' },
                      { label: t('fieldTransport'), value: agent.transport ?? '—', mono: true },
                    ]}
                  />
                </Section>
              </div>

              <Section icon={<Timer />} title={t('sectionRuntime')}>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                  {[
                    { label: t('fieldUptime'), value: formatUptime(agent.uptime_sec) },
                    { label: t('fieldLoad'), value: agent.load_1 === null ? '—' : agent.load_1.toFixed(2) },
                    { label: t('fieldProcesses'), value: agent.process_count === null ? '—' : String(agent.process_count) },
                    {
                      label: t('fieldConnections'),
                      value:
                        agent.connections_tcp === null && agent.connections_udp === null
                          ? '—'
                          : `${agent.connections_tcp ?? 0} / ${agent.connections_udp ?? 0}`,
                      hint: 'TCP / UDP',
                    },
                    {
                      label: t('fieldReportInterval'),
                      value: agent.report_interval_secs === null ? '—' : `${agent.report_interval_secs}s`,
                    },
                  ].map((cell) => (
                    <div key={cell.label} className="polaris-well px-3 py-2.5">
                      <p className="truncate text-[11px] text-default-400">{cell.label}</p>
                      <p className="mt-0.5 truncate text-small font-semibold tabular-nums" title={cell.hint}>
                        {cell.value}
                      </p>
                    </div>
                  ))}
                </div>
              </Section>

              {/*
                Disks and interfaces, stacked one per row.

                They used to sit in a two-column grid. Grid items stretch to the
                row's height by default, so opening one disclosure made the other
                card grow to match it - the untouched one looked like it had
                opened too. Stacking them removes the shared row height, so each
                opens on its own and a long mount list gets the full width to
                print paths on.

                磁盘与网络接口逐行堆叠。原双列网格会让展开一张卡片时同一行的另一张
                也被拉高，看起来像同时展开；垂直堆叠使各卡独立展开，长挂载路径也有完整宽度。
              */}
              {detailState === 'ready' ? (
                <div className="flex flex-col gap-4">
                  <Disclosure
                    key={`mounts-${agent.id}`}
                    icon={<HardDrive />}
                    title={t('sectionDisks')}
                    count={mounts.length}
                    summary={
                      mounts.some((mount) => (usedPercent(mount) ?? 0) > 90)
                        ? t('diskAboveThreshold', {
                            n: mounts.filter((mount) => (usedPercent(mount) ?? 0) > 90).length,
                          })
                        : undefined
                    }
                  >
                    {mounts.length === 0 ? (
                      <p className="px-3.5 py-3 text-tiny text-default-500">{t('mountsNone')}</p>
                    ) : (
                      mounts.map((mount) => <MountRow key={mount.name} mount={mount} />)
                    )}
                  </Disclosure>

                  <Disclosure key={`nics-${agent.id}`} icon={<Network />} title={t('sectionInterfaces')} count={interfaces.length}>
                    {interfaces.length === 0 ? (
                      <p className="px-3.5 py-3 text-tiny text-default-500">{t('interfacesNone')}</p>
                    ) : (
                      interfaces.map((nic) => <InterfaceRow key={nic.name} nic={nic} />)
                    )}
                  </Disclosure>
                </div>
              ) : null}

              {/*
                What this machine probes.

                Placed above the alert rules because it answers the question the
                fleet row raises: an agent can be perfectly healthy while every
                check it performs is failing, and before this section nothing on
                screen connected the two.

                探测内容放在告警规则前：Agent 健康不代表它执行的检查正常，
                此区段将两者关联起来。
              */}
              {detailState === 'ready' ? (
                <ProbeJobsSection probeEnabled={probeEnabled} probeTargets={probeTargets} probeJobs={probeJobs} />
              ) : null}

              {detailState === 'ready' ? (
                <AlertRulesSection alerts={alerts} />
              ) : null}


            </>
          ) : null}
        </DrawerBody>

        <DrawerFooter className="border-t border-[var(--polaris-line)] bg-[var(--polaris-card)]">
          <Button variant="flat" startContent={<Pencil size={15} />} onPress={() => agent && onEdit(agent)}>
            {t('editTitle')}
          </Button>
          <Button variant="light" onPress={onClose}>
            {t('close')}
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}

/** A labelled proportion as a ring, with its absolute figures underneath. / 带标签的比例圆环，下方显示绝对数值。 */
function Gauge({
  icon,
  label,
  percent,
  detail,
}: {
  icon: ReactNode;
  label: string;
  percent: number | null;
  detail?: string;
}) {
  const clamped = percent === null || !Number.isFinite(percent) ? null : Math.max(0, Math.min(100, percent));
  const level = loadTone(percent);

  return (
    <div className="polaris-card flex items-center gap-3.5 p-3.5">
      <Ring value={(clamped ?? 0) / 100} size={60} stroke={6} tone={level} label={`${label}: ${formatPercent(percent)}`}>
        <span className="text-default-500 [&>svg]:h-4 [&>svg]:w-4">{icon}</span>
      </Ring>
      <div className="min-w-0">
        <p className="text-tiny text-default-500">{label}</p>
        <p className={clsx('text-xl leading-tight font-semibold tracking-tight', level === 'idle' ? 'text-default-400' : TONE_TEXT[level])}>
          {formatPercent(percent)}
        </p>
        {detail ? <p className="truncate text-[11px] text-default-400 tabular-nums">{detail}</p> : null}
      </div>
    </div>
  );
}

type TrendMetric = 'cpu' | 'mem' | 'net';

/** 近期资源和每日归档。 / Recent resources and daily archives. */
function TrendCard({
  detail,
  t,
  onRetry,
}: {
  detail: AgentDetailResponse | null;
  onRetry: () => void;
  t: ReturnType<typeof useTranslations<'admin.agents'>>;
}) {
  const { locale } = useLocale();
  const [metric, setMetric] = useState<TrendMetric>('cpu');
  const [range, setRange] = useState('recent');
  const labels = useTranslations('detail');
  const history = range === 'daily' ? detail?.history_daily ?? [] : detail?.history ?? [];
  const sampled = range === 'daily' ? detail?.history_daily_sampled : detail?.history_sampled;

  const points = useMemo<TrendPoint[]>(() => history.flatMap((point, index) => {
    const reading = { t: point.ts, value: metric === 'cpu' ? point.cpu : metric === 'mem' ? point.mem_pct
      : point.net_up === null || point.net_down === null ? null : point.net_up + point.net_down };
    const interval = range === 'daily' ? 86400 : 300;
    return index && point.ts - history[index - 1].ts > interval * 1.5
      ? [{ t: history[index - 1].ts + interval, value: null }, reading] : [reading];
  }), [history, metric, range]);
  const last = lastFinite(points.map((p) => p.value));
  const format = metric === 'net' ? formatRate : formatPercent;

  return (
    <section className="polaris-card p-4">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <IconTile icon={<ChartSpline />} size="sm" />
        <div className="min-w-0">
          <h3 className="text-small font-semibold">{range === 'daily' ? labels('historyDaily') : t('sectionTrend')}</h3>
          {range === 'recent' ? <p className="text-[11px] text-default-400">
            {t('trendNow')} · <span className="font-semibold text-default-600 tabular-nums">{format(last)}</span>
          </p> : null}
        </div>
        <Segmented
          className="ml-auto"
          label={t('sectionTrend')}
          value={metric}
          onChange={setMetric}
          options={[
            { value: 'cpu', label: t('colCpu') },
            { value: 'mem', label: t('colMemory') },
            { value: 'net', label: t('sectionNetwork') },
          ]}
        />
      </div>
      {detail?.history_daily !== undefined ? (
        <div className="mb-3">
          <Segmented
            label={t('sectionTrend')}
            value={range}
            onChange={setRange}
            options={[
              { value: 'recent', label: labels('historyRecent') },
              { value: 'daily', label: labels('historyDaily') },
            ]}
          />
        </div>
      ) : null}
      <HistoryNotice status={range === 'daily' ? undefined : detail?.history_status} sampled={sampled} onRetry={onRetry} />
      {points.some((p) => p.value !== null) ? (
        <TrendChart
          data={points}
          label={metric === 'cpu' ? t('colCpu') : metric === 'mem' ? t('colMemory') : t('sectionNetwork')}
          format={(v) => format(v)}
          formatX={(v) => range === 'daily' ? new Date(v * 1000).toLocaleDateString(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' }) : formatClock(v, locale)}
          formatTip={(v) => range === 'daily'
            ? new Date(v * 1000).toLocaleDateString(locale, { dateStyle: 'medium', timeZone: 'UTC' })
            : new Date(v * 1000).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' })}
          domain={metric === 'net' ? undefined : [0, 100]}
          height={190}
        />
      ) : range !== 'daily' && detail?.history_status && detail.history_status !== 'ready' ? null : (
        <p className="polaris-well py-10 text-center text-tiny text-default-500">{t('trendNoData')}</p>
      )}
    </section>
  );
}

/** A collapsed-by-default card for the extra detail the row has no room for. / 默认折叠的卡片，展示列表行放不下的额外详情。 */
function Disclosure({
  icon,
  title,
  count,
  summary,
  children,
}: {
  icon: ReactNode;
  title: string;
  count?: number;
  summary?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="polaris-card overflow-hidden">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2.5 px-4 py-3 text-left transition-colors hover:bg-default-100/50"
      >
        <IconTile icon={icon} hue="default" size="sm" />
        <span className="text-small font-semibold">{title}</span>
        {count !== undefined ? <span className="text-tiny text-default-400 tabular-nums">{count}</span> : null}
        {summary ? <span className="text-tiny font-medium text-danger-600">{summary}</span> : null}
        <ChevronRight
          size={15}
          className={clsx('ml-auto shrink-0 text-default-400 transition-transform', open && 'rotate-90')}
        />
      </button>
      {open ? <div className="polaris-divide border-t border-[var(--polaris-line-soft)]">{children}</div> : null}
    </section>
  );
}

function MountRow({ mount }: { mount: AgentMount }) {
  const percent = usedPercent(mount);
  const mountTone: Tone =
    percent === null || !Number.isFinite(percent) ? 'idle' : percent > 90 ? 'down' : percent > 75 ? 'warn' : 'up';

  return (
    <div className="flex flex-col gap-1.5 px-4 py-2.5">
      <div className="flex items-baseline gap-3">
        <span className="min-w-0 truncate font-mono text-[11.5px]" title={mount.name}>
          {mount.name}
        </span>
        <span className="ml-auto shrink-0 text-[11px] text-default-400 tabular-nums">
          {formatBytes(mount.used)} / {formatBytes(mount.total)}
        </span>
        <span className={clsx('w-12 shrink-0 text-right text-tiny font-semibold tabular-nums', TONE_TEXT[mountTone])}>
          {formatPercent(percent)}
        </span>
      </div>
      <Meter value={percent} tone={mountTone === 'up' ? 'primary' : mountTone} />
    </div>
  );
}

function InterfaceRow({ nic }: { nic: AgentInterface }) {
  const t = useTranslations('admin.agents');
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-4 py-2.5">
      <span className="min-w-0 truncate font-mono text-[11.5px]" title={nic.name}>
        {nic.name}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-2 font-mono text-[11px] text-default-600 tabular-nums">
        <span>{t('nicRateUp', { rate: formatRate(nic.up_rate) })}</span>
        <span>{t('nicRateDown', { rate: formatRate(nic.down_rate) })}</span>
      </span>
      <span className="w-full text-[11px] text-default-400 tabular-nums">
        {t('nicTotalUp', { value: formatBytes(nic.total_up) })} · {t('nicTotalDown', { value: formatBytes(nic.total_down) })}
      </span>
    </div>
  );
}

function AlertRuleRow({
  rule,
  t,
}: {
  rule: AgentAlertRule;
  t: ReturnType<typeof useTranslations<'admin.agents'>>;
}) {
  const label = t(ALERT_RESOURCE_KEY[rule.resource] ?? 'alertResourceLoad');
  const threshold = Number.isFinite(rule.threshold)
    ? rule.resource === 'load'
      ? rule.threshold.toFixed(2)
      : formatPercent(rule.threshold)
    : '—';
  const status = !rule.enabled ? t('alertDisabled') : rule.active ? t('alertActive') : t('alertQuiet');
  const statusTone: Tone = !rule.enabled ? 'idle' : rule.active ? 'down' : 'up';

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-3.5 py-2.5">
      <span className="w-16 shrink-0 text-tiny text-default-500">{label}</span>
      <span className="text-small font-semibold tabular-nums">{threshold}</span>
      <span className="text-tiny text-default-400">
        {t('alertDuration', { s: Number.isFinite(rule.duration_sec) ? rule.duration_sec : 0 })}
      </span>
      <StatusPill className="ml-auto" tone={statusTone} label={status} pulse={rule.enabled && rule.active} />
    </div>
  );
}

function lastFinite(values: Array<number | null>): number | null {
  for (let index = values.length - 1; index >= 0; index--) {
    const value = values[index];
    if (value !== null && Number.isFinite(value)) return value;
  }
  return null;
}

function Section({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="flex items-center gap-2 text-small font-semibold">
        <span className="text-default-400 [&>svg]:h-4 [&>svg]:w-4">{icon}</span>
        {title}
      </h3>
      {children}
    </section>
  );
}

function ProbeJobsSection({ probeEnabled, probeTargets, probeJobs }: {
  probeEnabled: boolean;
  probeTargets: NonNullable<AgentDetailResponse['probe_targets']>;
  probeJobs: NonNullable<AgentDetailResponse['probe_jobs']>;
}) {
  const t = useTranslations('admin.agents');
  return (<Section icon={<Radar />} title={t('sectionProbes')}>
    {!probeEnabled ? (<p className="polaris-well px-3.5 py-3 text-tiny text-default-500">{t('probeDisabledHint')}</p>) : null}
    {probeTargets.length === 0 ? (<p className="polaris-well px-3.5 py-3 text-tiny text-default-500">{t('probesNone')}</p>) : (<div className="polaris-well polaris-divide overflow-hidden">
      {probeTargets.map((target) => (<div key={target.monitor_id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3.5 py-2.5">
        <span className="text-tiny font-medium">{target.name}</span>
        <span className="shrink-0 font-mono text-[10.5px] uppercase tracking-wide text-[var(--polaris-ink-4)]">
          {target.type}
        </span>
        <span className="min-w-0 truncate font-mono text-[11px] text-default-500" title={target.target}>
          {target.target}
        </span>
        {!target.active ? (<StatusPill tone="idle" label={t('probePaused')} />) : null}
        <span className="ml-auto shrink-0 font-mono text-[11px] text-default-400 tabular-nums">
          {t('probeEvery', { sec: target.interval_sec })}
        </span>
      </div>))}
    </div>)}

    {/* 过期可能来自超时、重试耗尽或配置变化。 / Expiry can reflect timeouts, exhausted retries, or configuration changes. */}
    {probeJobs.length > 0 ? (<ul className="polaris-divide mt-2 overflow-hidden rounded-medium border border-[var(--polaris-line-soft)]">
      {probeJobs.slice(0, 6).map((row) => {
        const tone: Tone = row.state === 'completed'
          ? (row.status === 1 ? 'up' : 'down')
          : row.state === 'expired' ? 'idle' : 'pending';
        return (<li key={row.run_id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3.5 py-2.5">
          <span className="text-tiny">{row.monitor_name ?? row.monitor_id}</span>
          <StatusPill tone={tone} label={t(row.state === 'completed'
            ? (row.status === 1 ? 'probeOk' : 'probeFailed')
            : row.state === 'expired' ? 'probeExpired' : 'probePending')} />
          {row.attempts > 1 ? (<span className="text-tiny text-default-400">{t('probeAttempts', { n: row.attempts })}</span>) : null}
          <span className="ml-auto shrink-0 font-mono text-[11px] text-default-400 tabular-nums">
            {row.latency_ms === null ? '' : `${Math.round(row.latency_ms)}ms`}
            {row.completed_at ? ` · ${formatClock(row.completed_at)}` : ''}
          </span>
          {row.message ? (<span className="w-full truncate text-tiny text-default-400" title={row.message}>
            {row.message}
          </span>) : null}
        </li>);
      })}
    </ul>) : null}
  </Section>);
}

function AlertRulesSection({ alerts }: {
  alerts: NonNullable<AgentDetailResponse['alerts']>;
}) {
  const t = useTranslations('admin.agents');
  return (<Section icon={<BellRing />} title={t('sectionAlerts')}>
    {alerts.length === 0 ? (<p className="polaris-well px-3.5 py-3 text-tiny text-default-500">{t('alertsNone')}</p>) : (<div className="polaris-well polaris-divide overflow-hidden">
      {alerts.map((rule) => (<AlertRuleRow key={rule.resource} rule={rule} t={t} />))}
    </div>)}
  </Section>);
}
