import { loadTone, percentOf } from '@/lib/resource-metrics';
import { useLocale } from '@/i18n/IntlProvider';
import clsx from 'clsx';
import { motion } from 'framer-motion';
import { useReducedMotion } from '@/lib/useReducedMotion';
import {
  Activity,
  ArrowUpCircle,
  CircleSlash,
  Clock,
  Earth,
  Flame,
  Gauge,
  Layers,
  ShieldAlert,
  WifiOff,
} from 'lucide-react';
import { useMemo, type ReactNode } from 'react';
import { useTranslations } from 'use-intl';
import { AnimatedNumber } from '../../components/ui/MetricFigures';
import { Meter } from '../../components/ui/MetricMeters';
import type { Tone } from '../../types/tone';
import { CountryFlag, countryOf } from '../components/CountryFlag';
import { OsBadge } from '../components/OsBadge';
import { PanelHeader } from '../components/Panel';
import { StatBand } from '../components/SummaryStats';
import { peakResourcePercent } from './resource-model';
import { formatBytes } from '../format';
import type { FleetAgent, FleetSummary } from './types';

/**
 * The fleet at a glance: six figures in one shared frame.
 *
 * All are derived from the fleet rows, so the strip and the table below cannot
 * disagree. Each cell has the same height and position, so the row reads as one
 * sentence rather than six widgets.
 * 所有数字来自同一批表格行，概览条与下方表格不会矛盾。
 */

/** The translator, as `useTranslations` returns it - accepts values for interpolation. / `useTranslations` 返回的翻译函数，接受插值参数。 */
type Translator = ReturnType<typeof useTranslations<'admin.agents'>>;

interface FleetOverviewProps {
  agents: FleetAgent[];
  summary: FleetSummary;
  now: number;
  stateFilter: string | null;
  onFilter: (bucket: string) => void;
}

type MachineState = 'online' | 'never' | 'offline' | 'paused';

function stateOf(agent: FleetAgent): MachineState {
  if (!agent.active) return 'paused';
  if (agent.online === true) return 'online';
  if (agent.last_reported_at === null) return 'never';
  return 'offline';
}

const STATE_ORDER: Record<MachineState, number> = { online: 0, never: 1, offline: 2, paused: 3 };

const STATE_FILL: Record<MachineState, string> = {
  online: 'bg-[var(--polaris-rail-up)]',
  never: 'bg-warning',
  offline: 'bg-danger',
  paused: 'bg-[var(--polaris-rail-empty)] ring-1 ring-inset ring-[var(--polaris-line)]',
};

const VALUE_INK: Record<'down' | 'warn' | 'none', string> = {
  down: 'text-danger-600',
  warn: 'text-warning-700',
  none: 'text-[var(--polaris-ink)]',
};

/** The family an OS string belongs to, for the mix: "Ubuntu 24.04" and "Ubuntu 22.04" are one row. / 系统字符串所属的系列，用于汇总；例如两个 Ubuntu 版本归为一行。 */
function familyOf(os: string | null): string {
  if (!os) return '?';
  return os.trim().split(/[\s/_-]+/)[0].toLowerCase() || '?';
}

export function FleetOverview({ agents, summary, now, stateFilter, onFilter }: FleetOverviewProps) {
  const t = useTranslations('admin.agents');
  const ta = useTranslations('admin');

  const derived = useMemo(() => {
    const active = agents.filter((a) => a.active);
    const reporting = active.filter((a) => a.online === true);

    const cpus = reporting.map((a) => a.cpu_usage).filter((v): v is number => v !== null);
    const mems = reporting.map((a) => percentOf(a.mem_used, a.mem_total)).filter((v): v is number => v !== null);
    const disks = reporting.map((a) => percentOf(a.disk_used, a.disk_total)).filter((v): v is number => v !== null);
    const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

    // The single machine closest to a limit, named under the load figure. / 最接近资源上限的单台机器，名称显示在负载指标下。
    let busiest: { name: string; peak: number } | null = null;
    for (const agent of reporting) {
      const peak = peakResourcePercent(agent);
      if (peak !== null && (!busiest || peak > busiest.peak)) busiest = { name: agent.name, peak };
    }

    /*
      Report recency, bucketed by silence rather than by wall-clock: "how long
      ago" is the question, and absolute buckets would need relabelling hourly.

      上报新近程度按静默时长而非绝对时钟分桶：关注的是“多久以前”，
      而绝对时间桶需要每小时重新标注。
    */
    const buckets = [
      { key: '<1m', max: 60, count: 0 },
      { key: '1-5m', max: 300, count: 0 },
      { key: '5-30m', max: 1800, count: 0 },
      { key: '>30m', max: Infinity, count: 0 },
    ];
    for (const agent of active) {
      const silence = agent.last_reported_at === null ? Infinity : now - agent.last_reported_at;
      const bucket = buckets.find((b) => silence < b.max) ?? buckets[buckets.length - 1];
      bucket.count += 1;
    }

    const versions = { current: 0, behind: 0, unknown: 0 };
    const behindNames: string[] = [];
    for (const agent of agents) {
      if (agent.version_state === 'current') versions.current += 1;
      else if (agent.version_state === 'behind') {
        versions.behind += 1;
        behindNames.push(agent.name);
      } else versions.unknown += 1;
    }

    const mix = new Map<string, { os: string | null; n: number }>();
    let cores = 0;
    let memTotal = 0;
    let diskTotal = 0;
    for (const agent of agents) {
      const family = familyOf(agent.os);
      const row = mix.get(family) ?? { os: agent.os, n: 0 };
      row.n += 1;
      mix.set(family, row);
      cores += agent.cpu_cores ?? 0;
      memTotal += agent.mem_total ?? 0;
      diskTotal += agent.disk_total ?? 0;
    }

    return {
      activeCount: active.length,
      meanCpu: mean(cpus),
      meanMem: mean(mems),
      meanDisk: mean(disks),
      busiest,
      buckets,
      versions,
      behindNames,
      offlineNames: active.filter((a) => stateOf(a) === 'offline').map((a) => a.name),
      osMix: [...mix.values()].sort((a, b) => b.n - a.n),
      cores,
      memTotal,
      diskTotal,
    };
  }, [agents, now]);

  const attention = summary.offline + summary.neverReported;
  const fresh = derived.buckets[0].count;

  return (
    <StatBand className="grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
      <FleetCell
        icon={<Activity />}
        label={t('statHealth')}
        value={<AnimatedNumber value={summary.online} />}
        suffix={`/ ${summary.total}`}
        onPress={() => onFilter('online')}
        active={stateFilter === 'online'}
        visual={<MachineDots agents={agents} t={t} />}
        sub={[
          `${t('stateOffline')} ${summary.offline}`,
          `${t('stateNever')} ${summary.neverReported}`,
          ...(summary.paused ? [`${t('statePaused')} ${summary.paused}`] : []),
        ].join(' · ')}
      />

      <FleetCell
        icon={<Gauge />}
        label={t('statLoad')}
        aside={<span className="font-mono text-[10.5px] tracking-wide text-[var(--polaris-ink-4)]">CPU</span>}
        value={derived.meanCpu === null ? '—' : `${Math.round(derived.meanCpu)}%`}
        tone={loadTone(derived.meanCpu)}
        visual={
          <span className="grid h-full grid-cols-2 items-end gap-4">
            {[
              { key: 'mem', label: t('colMemory'), value: derived.meanMem },
              { key: 'disk', label: t('colDisk'), value: derived.meanDisk },
            ].map((metric) => (
              <span key={metric.key} className="flex min-w-0 flex-col gap-1.5">
                <span className="flex items-baseline justify-between gap-2 text-[11px] leading-none">
                  <span className="truncate text-[var(--polaris-ink-4)]">{metric.label}</span>
                  <span className="polaris-num font-medium text-[var(--polaris-ink-2)]">
                    {metric.value === null ? '—' : `${Math.round(metric.value)}%`}
                  </span>
                </span>
                <Meter
                  value={metric.value}
                  tone={loadTone(metric.value) === 'up' ? 'primary' : loadTone(metric.value)}
                />
              </span>
            ))}
          </span>
        }
        sub={
          derived.busiest ? (
            <span className="inline-flex items-center gap-1.5">
              <Flame size={12} className={derived.busiest.peak >= 90 ? 'text-danger-600' : 'text-[var(--polaris-ink-4)]'} />
              {derived.busiest.name} · {Math.round(derived.busiest.peak)}%
            </span>
          ) : (
            t('busyEmpty')
          )
        }
      />

      <FleetCell
        icon={<ShieldAlert />}
        label={t('statAttention')}
        value={<AnimatedNumber value={attention} />}
        tone={summary.offline ? 'down' : summary.neverReported ? 'warn' : 'up'}
        visual={
          <span className="flex h-full items-end gap-1.5">
            {(
              [
                { key: 'offline', label: t('stateOffline'), value: summary.offline, icon: <WifiOff />, ink: 'text-danger-600' },
                { key: 'never', label: t('stateNever'), value: summary.neverReported, icon: <Clock />, ink: 'text-warning-700' },
                { key: 'paused', label: t('statePaused'), value: summary.paused, icon: <CircleSlash />, ink: 'text-[var(--polaris-ink-2)]' },
              ] as const
            ).map((row) => {
              const on = stateFilter === row.key;
              return (
                <button
                  key={row.key}
                  type="button"
                  title={row.label}
                  aria-label={`${row.label}: ${row.value}`}
                  aria-pressed={on}
                  onClick={() => onFilter(row.key)}
                  className={clsx(
                    'inline-flex h-7 min-w-0 items-center gap-1.5 rounded-full border px-2.5 text-[12px] transition-colors [&>svg]:h-3.5 [&>svg]:w-3.5 [&>svg]:shrink-0',
                    on
                      ? 'border-[var(--polaris-ink)]/50 bg-[var(--polaris-active)]'
                      : 'border-[var(--polaris-line)] hover:border-[var(--polaris-line-strong)] hover:bg-[var(--polaris-hover)]',
                    row.value > 0 ? row.ink : 'text-[var(--polaris-ink-4)]',
                  )}
                >
                  {row.icon}
                  <span className="polaris-num font-semibold">{row.value}</span>
                </button>
              );
            })}
          </span>
        }
        sub={
          derived.offlineNames.length ? (
            <span data-full-text={derived.offlineNames.join(', ')}>
              {derived.offlineNames.slice(0, 2).join(', ')}
              {derived.offlineNames.length > 2 ? ` +${derived.offlineNames.length - 2}` : ''}
            </span>
          ) : (
            ta('stat.allClear')
          )
        }
      />

      <FleetCell
        icon={<Clock />}
        label={t('statRecency')}
        value={<AnimatedNumber value={fresh} />}
        suffix={`/ ${derived.activeCount}`}
        visual={<RecencyBars buckets={derived.buckets} />}
        sub={t('statRecencySub', { n: derived.activeCount })}
      />

      <FleetCell
        icon={<ArrowUpCircle />}
        label={t('statBehind')}
        aside={
          summary.latestVersion ? (
            <span className="rounded-[5px] bg-[var(--polaris-active)] px-1.5 py-px font-mono text-[10.5px] text-[var(--polaris-ink-2)]">
              v{summary.latestVersion}
            </span>
          ) : undefined
        }
        value={<AnimatedNumber value={derived.versions.behind} />}
        tone={derived.versions.behind ? 'warn' : 'up'}
        onPress={derived.versions.behind ? () => onFilter('behind') : undefined}
        active={stateFilter === 'behind'}
        visual={<VersionBar counts={derived.versions} t={t} />}
        sub={
          derived.behindNames.length ? (
            <span data-full-text={derived.behindNames.join(', ')}>
              {derived.behindNames.slice(0, 2).join(', ')}
              {derived.behindNames.length > 2 ? ` +${derived.behindNames.length - 2}` : ''}
            </span>
          ) : (
            `${t('versionCurrent')} ${derived.versions.current}`
          )
        }
      />

      <FleetCell
        icon={<Layers />}
        label={t('statTotal')}
        value={<AnimatedNumber value={agents.length} />}
        visual={
          <span className="flex h-full items-center gap-2.5 overflow-hidden">
            {derived.osMix.slice(0, 4).map((row) => (
              <span key={familyOf(row.os)} className="flex shrink-0 items-center gap-1" title={`${row.os ?? t('osUnknown')} · ${row.n}`}>
                <OsBadge os={row.os} size="sm" />
                <span className="polaris-num text-[12px] text-[var(--polaris-ink-3)]">×{row.n}</span>
              </span>
            ))}
            {derived.osMix.length > 4 ? (
              <span className="polaris-num text-[12px] text-[var(--polaris-ink-4)]">+{derived.osMix.length - 4}</span>
            ) : null}
          </span>
        }
        sub={[
          derived.cores ? t('cores', { n: derived.cores }) : null,
          derived.memTotal ? `${t('colMemory')} ${formatBytes(derived.memTotal)}` : null,
          derived.diskTotal ? `${t('colDisk')} ${formatBytes(derived.diskTotal)}` : null,
        ]
          .filter(Boolean)
          .join(' · ') || '—'}
      />
    </StatBand>
  );
}

/** One strip cell; draws its own hairlines and keeps a fixed 28px picture slot. / 概览条单元格；自绘细线，图片槽固定 28px。 */
function FleetCell({
  icon,
  label,
  aside,
  value,
  suffix,
  tone,
  visual,
  sub,
  onPress,
  active,
}: {
  icon: ReactNode;
  label: string;
  aside?: ReactNode;
  value: ReactNode;
  suffix?: string;
  tone?: Tone;
  visual: ReactNode;
  sub: ReactNode;
  onPress?: () => void;
  active?: boolean;
}) {
  const Tag = onPress ? 'button' : 'div';
  const ink = tone === 'down' ? VALUE_INK.down : tone === 'warn' ? VALUE_INK.warn : VALUE_INK.none;
  return (
    <Tag
      type={onPress ? 'button' : undefined}
      onClick={onPress}
      aria-pressed={onPress ? Boolean(active) : undefined}
      className={clsx(
        'relative -mt-px -ml-px flex min-w-0 flex-col border-t border-l border-[var(--polaris-line-soft)] px-5 pt-4 pb-4 text-left transition-colors',
        onPress && 'cursor-pointer hover:bg-[var(--polaris-hover)]',
        active && 'bg-[var(--polaris-hover)]',
      )}
    >
      {active ? (
        <span aria-hidden="true" className="absolute inset-x-5 bottom-0 h-0.5 rounded-full bg-[var(--polaris-ink)]" />
      ) : null}
      <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-[var(--polaris-ink-3)]">
        <span aria-hidden="true" className="inline-flex text-[var(--polaris-ink-4)] [&>svg]:h-3.5 [&>svg]:w-3.5">
          {icon}
        </span>
        <span className="truncate">{label}</span>
        {aside ? <span className="ml-auto flex shrink-0 items-center">{aside}</span> : null}
      </span>
      <span className="mt-2 flex min-w-0 items-baseline gap-1.5">
        <span className={clsx('polaris-num text-[26px] leading-none font-semibold tracking-[-0.02em]', ink)}>{value}</span>
        {suffix ? <span className="polaris-num truncate text-[13px] text-[var(--polaris-ink-4)]">{suffix}</span> : null}
      </span>
      <span className="mt-4 block h-7 min-w-0">{visual}</span>
      <span className="mt-3 block min-w-0 truncate text-[12px] text-[var(--polaris-ink-3)]">{sub}</span>
    </Tag>
  );
}

/** Lights in the 28px slot fit two rows of ten; past that a proportional bar keeps its shape. / 28px 区域可容纳两行、每行十个状态灯；超过后改用比例条保持形状。 */
const DOT_LIMIT = 20;

/** One light per machine in state order; large fleets collapse to one bar. / 每台机器一个状态灯；大集群折叠为一个条。 */
function MachineDots({ agents, t }: { agents: FleetAgent[]; t: Translator }) {
  const reduced = useReducedMotion();
  const label: Record<MachineState, string> = {
    online: t('stateOnline'),
    never: t('stateNever'),
    offline: t('stateOffline'),
    paused: t('statePaused'),
  };
  const sorted = useMemo(
    () =>
      agents
        .map((agent) => ({ agent, state: stateOf(agent) }))
        .sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state]),
    [agents],
  );

  if (sorted.length === 0) {
    return <span className="flex h-full items-end"><span className="h-1.5 w-full rounded-full bg-[var(--polaris-rail-empty)]" /></span>;
  }

  if (sorted.length > DOT_LIMIT) {
    const counts = (['online', 'never', 'offline', 'paused'] as const)
      .map((state) => ({ state, n: sorted.filter((row) => row.state === state).length }))
      .filter((row) => row.n > 0);
    return (
      <span className="flex h-full items-end">
        <span className="flex h-1.5 w-full gap-[2px] overflow-hidden rounded-full">
          {counts.map((row) => (
            <span
              key={row.state}
              title={`${label[row.state]} · ${row.n}`}
              className={clsx('h-full first:rounded-l-full last:rounded-r-full', STATE_FILL[row.state])}
              style={{ width: `${(row.n / sorted.length) * 100}%` }}
            />
          ))}
        </span>
      </span>
    );
  }

  return (
    <span className="flex h-full flex-wrap content-end gap-[3px]">
      {sorted.map(({ agent, state }, index) => (
        <motion.span
          key={agent.id}
          title={`${agent.name} · ${label[state]}`}
          className={clsx('h-3 w-3 rounded-[3px]', STATE_FILL[state])}
          initial={reduced ? false : { opacity: 0, scale: 0.4 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.25, delay: index * 0.025, ease: [0.22, 1, 0.36, 1] }}
        />
      ))}
    </span>
  );
}

const RECENCY_FILL = ['bg-[var(--polaris-rail-up)]', 'bg-warning/60', 'bg-warning', 'bg-danger'];

/** How long ago each machine last reported, in four buckets with their labels under them. / 各机器距上次上报的时间分为四个桶，标签显示在下方。 */
function RecencyBars({ buckets }: { buckets: Array<{ key: string; count: number }> }) {
  const reduced = useReducedMotion();
  // Scale to the tallest bucket, never below 1, so one machine still draws a column. / 按最高桶缩放，下限为 1，确保只有一台机器时仍绘制柱形。
  const max = Math.max(1, ...buckets.map((b) => b.count));
  return (
    <span className="grid h-full grid-cols-4 gap-2">
      {buckets.map((bucket, index) => (
        <span key={bucket.key} className="flex min-w-0 flex-col justify-end gap-1" title={`${bucket.key} · ${bucket.count}`}>
          <span className="flex h-[14px] items-end">
            <motion.span
              className={clsx('block w-full rounded-[3px]', bucket.count > 0 ? RECENCY_FILL[index] : 'bg-[var(--polaris-rail-empty)]')}
              initial={reduced ? false : { height: 0 }}
              animate={{ height: bucket.count > 0 ? Math.max(4, (bucket.count / max) * 14) : 2 }}
              transition={{ duration: 0.45, delay: index * 0.05, ease: [0.22, 1, 0.36, 1] }}
            />
          </span>
          <span className="truncate text-center font-mono text-[10px] leading-none text-[var(--polaris-ink-4)]">
            {bucket.key}
            {bucket.count ? <span className="ml-0.5 text-[var(--polaris-ink-2)]">{bucket.count}</span> : null}
          </span>
        </span>
      ))}
    </span>
  );
}

/** Version state as one proportional bar, with its legend under it. / 版本状态汇总为一条比例条，图例置于下方。 */
function VersionBar({ counts, t }: { counts: { current: number; behind: number; unknown: number }; t: Translator }) {
  const segments = [
    { key: 'current', n: counts.current, fill: 'bg-[var(--polaris-rail-up)]', label: t('versionCurrent') },
    { key: 'behind', n: counts.behind, fill: 'bg-warning', label: t('versionBehind') },
    { key: 'unknown', n: counts.unknown, fill: 'bg-default-300', label: t('versionUnknown') },
  ];
  const total = Math.max(1, counts.current + counts.behind + counts.unknown);
  return (
    <span className="flex h-full flex-col justify-end gap-2">
      <span className="flex h-1.5 w-full gap-[2px] overflow-hidden rounded-full bg-[var(--polaris-rail-empty)]">
        {segments.map((segment) =>
          segment.n > 0 ? (
            <span
              key={segment.key}
              className={clsx('h-full first:rounded-l-full last:rounded-r-full', segment.fill)}
              style={{ width: `${(segment.n / total) * 100}%` }}
            />
          ) : null,
        )}
      </span>
      <span className="flex min-w-0 gap-3 text-[11px] leading-none text-[var(--polaris-ink-3)]">
        {segments.map((segment) => (
          <span key={segment.key} className={clsx('flex min-w-0 items-center gap-1', segment.n === 0 && 'opacity-50')}>
            <span className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', segment.fill)} />
            <span className="truncate">{segment.label}</span>
            <span className="polaris-num font-medium text-[var(--polaris-ink-2)]">{segment.n}</span>
          </span>
        ))}
      </span>
    </span>
  );
}

/** Region and proximity-to-limit row; country comes from the agent's own report. / 地区和接近上限的机器；国家来自 Agent 自报。 */
export function FleetInsights({ agents, onOpen }: { agents: FleetAgent[]; onOpen: (agent: FleetAgent) => void }) {
  const t = useTranslations('admin.agents');
  const { locale } = useLocale();

  const regions = useMemo(() => {
    const names = (() => {
      try {
        return new Intl.DisplayNames([locale], { type: 'region' });
      } catch {
        return null;
      }
    })();
    const counts = new Map<string, { code: string | null; online: number; total: number }>();
    for (const agent of agents) {
      const code = countryOf(agent.region);
      const key = code ?? '?';
      const row = counts.get(key) ?? { code, online: 0, total: 0 };
      row.total += 1;
      if (agent.active && agent.online === true) row.online += 1;
      counts.set(key, row);
    }
    return [...counts.values()]
      .sort((a, b) => b.total - a.total || (a.code ?? 'zz').localeCompare(b.code ?? 'zz'))
      .map((row) => ({ ...row, name: row.code ? (names?.of(row.code) ?? row.code) : t('regionUnknown') }));
  }, [agents, locale, t]);

  const busiest = useMemo(
    () =>
      agents
        .filter((a) => a.active && a.online === true)
        .map((a) => {
          const cpu = a.cpu_usage;
          const mem = percentOf(a.mem_used, a.mem_total);
          const disk = percentOf(a.disk_used, a.disk_total);
          return { agent: a, cpu, mem, disk, peak: peakResourcePercent(a) };
        })
        .filter((row): row is typeof row & { peak: number } => row.peak !== null)
        .sort((a, b) => b.peak - a.peak)
        .slice(0, 4),
    [agents],
  );

  const widest = Math.max(1, ...regions.map((row) => row.total));

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
      <section className="polaris-card p-5">
        <PanelHeader icon={<Earth />} title={t('regionTitle')} description={t('regionHint')} className="mb-3" />
        <ul className="flex flex-col">
          {regions.slice(0, 6).map((row) => (
            <li key={row.code ?? 'unknown'} className="flex items-center gap-3 rounded-lg px-1.5 py-2">
              <CountryFlag code={row.code} size={18} />
              <span className="w-28 shrink-0 truncate text-[13px] text-[var(--polaris-ink)]">{row.name}</span>
              <div className="flex h-1.5 flex-1 gap-[2px] overflow-hidden rounded-full bg-[var(--polaris-rail-empty)]">
                {row.online > 0 ? (
                  <span className="h-full rounded-l-full bg-[var(--polaris-rail-up)]" style={{ width: `${(row.online / widest) * 100}%` }} />
                ) : null}
                {row.total - row.online > 0 ? (
                  <span
                    className={clsx('h-full bg-default-300', row.online === 0 && 'rounded-l-full')}
                    style={{ width: `${((row.total - row.online) / widest) * 100}%` }}
                  />
                ) : null}
              </div>
              <span className="polaris-num w-14 shrink-0 text-right text-[12px] text-[var(--polaris-ink-4)]">
                <span className="font-semibold text-[var(--polaris-ink)]">{row.online}</span> / {row.total}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="polaris-card p-5">
        <PanelHeader icon={<Flame />} title={t('busyTitle')} description={t('busyHint')} className="mb-3" />
        {busiest.length === 0 ? (
          <p className="py-6 text-center text-[12.5px] text-[var(--polaris-ink-4)]">{t('busyEmpty')}</p>
        ) : (
          <ul className="flex flex-col">
            {busiest.map(({ agent, cpu, mem, disk }) => (
              <li key={agent.id}>
                <button
                  type="button"
                  onClick={() => onOpen(agent)}
                  className="flex w-full items-center gap-3 rounded-lg px-1.5 py-2 text-left transition-colors hover:bg-[var(--polaris-hover)]"
                >
                  <OsBadge os={agent.os} size="sm" />
                  <span className="w-28 shrink-0 truncate text-[13px] font-medium text-[var(--polaris-ink)]">{agent.name}</span>
                  <span className="grid flex-1 grid-cols-3 gap-4">
                    {[
                      { key: 'cpu', label: 'CPU', value: cpu },
                      { key: 'mem', label: t('colMemory'), value: mem },
                      { key: 'disk', label: t('colDisk'), value: disk },
                    ].map((metric) => (
                      <span key={metric.key} className="flex min-w-0 flex-col gap-1.5">
                        <span className="flex items-baseline justify-between gap-1 text-[11px] leading-none">
                          <span className="truncate text-[var(--polaris-ink-4)]">{metric.label}</span>
                          <span className="polaris-num font-medium text-[var(--polaris-ink-2)]">
                            {metric.value === null ? '—' : `${Math.round(metric.value)}%`}
                          </span>
                        </span>
                        <Meter value={metric.value} tone={loadTone(metric.value) === 'up' ? 'primary' : loadTone(metric.value)} />
                      </span>
                    ))}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
