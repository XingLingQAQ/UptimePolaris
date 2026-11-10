import { formatBytes, formatRate } from '@/admin/format';
import { AnimatedNumber, SparkLine } from '@/components/ui/MetricFigures';
import clsx from 'clsx';
import { Activity, ArrowDown, ArrowDownUp, ArrowUp, CheckCircle2, Cpu, Database, MemoryStick, ShieldAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useTranslations } from 'use-intl';
import type { PublicServer } from '../../../../shared/public-servers';
import { attentionOf, fleetSummary, known, percentText, resourcePercent, stateOf } from './model';
import { StateDot } from './ServerParts';
import { FLEET_SERIES, type LiveSeries } from './useVisitorState';

const DOT_LIMIT = 24;
const STATE_FILL = { online: 'bg-success', offline: 'bg-danger', unknown: 'bg-default-300' } as const;

/**
 * The fleet in one frame, in the console's overview grammar: label, one large figure, one small picture, one line.
 * Figures come from online machines; the pictures for CPU, memory and network are this tab's live samples.
 *
 * 使用控制台概览的同一语法展示机群：标签、一个大数字、一个小图和一行说明。数值来自在线机器，
 * CPU、内存和网络的小图是当前标签页采集的实时样本。
 */
export function FleetStrip({ servers, live, status, onStatus, href }: {
  servers: PublicServer[]; live: LiveSeries; status: string; onStatus: (status: string) => void; href: (id: string) => string;
}) {
  const t = useTranslations('presentation');
  const summary = fleetSummary(servers);
  const fleet = live[FLEET_SERIES] ?? [];
  const cpu = servers.some(server => server.cpu !== undefined);
  const memory = servers.some(server => server.memoryUsed !== undefined);
  const network = servers.some(server => server.upload !== undefined || server.download !== undefined);
  const traffic = servers.some(server => server.sent !== undefined || server.received !== undefined);
  const attention = servers.filter(server => attentionOf(server) === 'offline' || attentionOf(server) === 'critical');
  const spark = (values: Array<number | null>, max?: number) => values.filter(known).length >= 2
    ? <SparkLine values={values} min={0} max={max ?? Math.max(...values.filter(known)) * 1.15} height={28} className="text-[var(--polaris-chart)]" animate={false} label={t('liveTrend')} />
    : <span className="flex h-full items-end text-[11px] text-[var(--polaris-ink-4)]">{t('collecting')}</span>;
  const total = summary.upload === null || summary.download === null ? null : summary.upload + summary.download;

  return (
    <section aria-label={t('fleetOverview')} className="server-fleet-strip polaris-card">
      <Cell icon={<Activity />} label={t('statOnline')} value={<AnimatedNumber value={summary.online} />} suffix={`/ ${summary.total}`}
        onPress={() => onStatus(status === 'online' ? '' : 'online')} active={status === 'online'}
        visual={<MachineDots servers={servers} />}
        sub={`${t('offline')} ${summary.offline} · ${t('unknown')} ${summary.unknown}`} />
      {cpu ? <Cell icon={<Cpu />} label={t('averageCpu')} value={summary.cpu === null ? '—' : <AnimatedNumber value={summary.cpu} decimals={1} />} suffix={summary.cpu === null ? undefined : '%'}
        tone={summary.cpu} visual={spark(fleet.map(sample => sample.cpu), 100)} sub={t('cpuSamples', { n: summary.cpuSamples })} /> : null}
      {memory ? <Cell icon={<MemoryStick />} label={t('averageMemory')} value={summary.memory === null ? '—' : <AnimatedNumber value={summary.memory} decimals={1} />} suffix={summary.memory === null ? undefined : '%'}
        tone={summary.memory} visual={spark(fleet.map(sample => sample.memory), 100)} sub={t('cpuSamples', { n: summary.memorySamples })} /> : null}
      {network ? <Cell icon={<ArrowDownUp />} label={t('networkLive')} value={formatRate(total)}
        visual={spark(fleet.map(sample => sample.upload == null || sample.download == null ? null : sample.upload + sample.download))}
        sub={<span className="polaris-num inline-flex items-center gap-2.5"><span className="inline-flex items-center gap-0.5"><ArrowUp size={12} aria-hidden="true" className="text-[var(--polaris-ink-4)]" /><span className="sr-only">{t('upload')}</span>{formatRate(summary.upload)}</span><span className="inline-flex items-center gap-0.5"><ArrowDown size={12} aria-hidden="true" className="text-[var(--polaris-ink-4)]" /><span className="sr-only">{t('download')}</span>{formatRate(summary.download)}</span></span>} /> : null}
      {traffic ? <Cell icon={<Database />} label={t('trafficTotal')} value={formatBytes(summary.sent === null || summary.received === null ? null : summary.sent + summary.received)}
        visual={<SplitBar left={summary.sent} right={summary.received} />}
        sub={`${t('sent')} ${formatBytes(summary.sent)} · ${t('received')} ${formatBytes(summary.received)}`} /> : null}
      <Cell className="server-fleet-attention" icon={attention.length ? <ShieldAlert /> : <CheckCircle2 />} label={t('needsAttention')} value={<AnimatedNumber value={attention.length} />}
        tone={attention.length ? 100 : null}
        visual={attention.length ? <span className="flex h-full min-w-0 items-end gap-1.5 overflow-hidden">{attention.slice(0, 2).map(server => (
          <Link key={server.id} to={href(server.id)} title={server.name} className="inline-flex h-6 min-w-0 shrink items-center gap-1.5 rounded-md border border-[var(--polaris-line)] bg-[var(--polaris-card)] px-1.5 text-[11.5px] text-[var(--polaris-ink-2)] transition-colors hover:border-[var(--polaris-line-strong)] hover:text-[var(--polaris-ink)]">
            <StateDot server={server} className={server.online === true ? '!bg-danger !animate-none' : undefined} /><span className="truncate">{server.name}</span>
          </Link>))}{attention.length > 2 ? <span className="polaris-num shrink-0 pb-1 text-[11px] text-[var(--polaris-ink-4)]">+{attention.length - 2}</span> : null}</span>
          : <span className="flex h-full items-end text-[12px] text-success-700">{t('allClear')}</span>}
        sub={summary.hottest ? t('hottest', { name: summary.hottest.server.name, value: percentText(summary.hottest.value) }) : t('noReadings')} />
    </section>
  );
}

function Cell({ icon, label, value, suffix, tone, visual, sub, onPress, active, className }: {
  icon: ReactNode; label: string; value: ReactNode; suffix?: string; tone?: number | null; visual: ReactNode; sub: ReactNode; onPress?: () => void; active?: boolean; className?: string;
}) {
  const Tag = onPress ? 'button' : 'div';
  const ink = known(tone) ? tone >= 90 ? 'text-danger-600' : tone >= 75 ? 'text-warning-700' : '' : '';
  return (
    <Tag type={onPress ? 'button' : undefined} onClick={onPress} aria-pressed={onPress ? Boolean(active) : undefined}
      className={clsx('server-fleet-cell relative -mt-px -ml-px flex min-w-0 flex-col border-t border-l border-[var(--polaris-line-soft)] px-5 pt-4 pb-4 text-left transition-colors',
        onPress && 'cursor-pointer hover:bg-[var(--polaris-hover)]', active && 'bg-[var(--polaris-hover)]', className)}>
      {active ? <span aria-hidden="true" className="absolute inset-x-5 bottom-0 h-0.5 rounded-full bg-[var(--polaris-ink)]" /> : null}
      <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-[var(--polaris-ink-3)]">
        <span aria-hidden="true" className="inline-flex text-[var(--polaris-ink-4)] [&>svg]:h-3.5 [&>svg]:w-3.5">{icon}</span>
        <span className="truncate">{label}</span>
      </span>
      <span className="server-fleet-value mt-2 flex min-w-0 items-baseline gap-1">
        <span className={clsx('polaris-num text-[26px] leading-none font-semibold tracking-[-0.02em] text-[var(--polaris-ink)]', ink)}>{value}</span>
        {suffix ? <span className="polaris-num truncate text-[13px] text-[var(--polaris-ink-4)]">{suffix}</span> : null}
      </span>
      <span className="server-fleet-visual mt-4 block h-7 min-w-0">{visual}</span>
      <span className="server-fleet-sub mt-3 block min-w-0 truncate text-[12px] text-[var(--polaris-ink-3)]">{sub}</span>
    </Tag>
  );
}

/** One light per machine while they fit, then a proportional bar. / 机器较少时每台一个指示灯，否则改用比例条。 */
function MachineDots({ servers }: { servers: PublicServer[] }) {
  if (!servers.length) return <span className="flex h-full items-end"><span className="h-1.5 w-full rounded-full bg-[var(--polaris-rail-empty)]" /></span>;
  if (servers.length > DOT_LIMIT) {
    const counts = (['online', 'offline', 'unknown'] as const).map(state => [state, servers.filter(server => stateOf(server) === state).length] as const).filter(([, n]) => n);
    return <span className="flex h-full items-end"><span className="flex h-1.5 w-full gap-[2px] overflow-hidden rounded-full">{counts.map(([state, n]) => <span key={state} className={clsx('h-full first:rounded-l-full last:rounded-r-full', STATE_FILL[state])} style={{ flex: n }} />)}</span></span>;
  }
  return <span className="flex h-full flex-wrap content-end gap-[3px]">{servers.map(server => <span key={server.id} title={server.name} className={clsx('h-3 w-3 rounded-[3px]', STATE_FILL[stateOf(server)], server.online === true && (resourcePercent(server, 'cpu') ?? 0) >= 90 && '!bg-warning')} />)}</span>;
}

function SplitBar({ left, right }: { left: number | null; right: number | null }) {
  if (left === null || right === null || (!left && !right)) return <span className="flex h-full items-end"><span className="h-1.5 w-full rounded-full bg-[var(--polaris-rail-empty)]" /></span>;
  return <span className="flex h-full items-end"><span className="flex h-1.5 w-full gap-[2px] overflow-hidden rounded-full"><span className="h-full rounded-l-full bg-[var(--polaris-chart)]" style={{ flex: left }} /><span className="h-full rounded-r-full bg-success" style={{ flex: right }} /></span></span>;
}
