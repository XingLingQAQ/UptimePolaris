import { HistoryNotice } from '@/components/charts/HistoryNotice';

import { requestJson } from '@/api/client';
import { ApiError, isRetryableApiError } from '@/api/errors';
import { useApiErrorMessage } from '@/api/useApiErrorMessage';
import type { TrendPoint } from '@/components/charts/TrendChart';
import { usePageConfig } from '@/components/context/PageConfigContext';
import { AvailabilityRail } from '@/components/monitor/AvailabilityRail';
import { MonitorGlyph } from '@/components/monitor/MonitorGlyph';
import { HeartbeatRail } from '@/components/status-page/HeartbeatRail';
import {
  STATUS_DOT,
  STATUS_INK,
  STATUS_KEY,
  beatStatus,
  monitorStatus,
  uptimeInk,
  uptimeText,
  type PublicStatus,
} from '@/components/status-page/status';
import { useRefreshTimer } from '@/components/status-page/useRefreshTimer';
import { revalidateData, useConfig, useMonitor } from '@/components/status-page/useStatusPageData';
import { AnimatedNumber } from '@/components/ui/MetricFigures';
import { Meter, Ring } from '@/components/ui/MetricMeters';
import { useTimeAgo } from '@/hooks/useTimeAgo';
import { statusPagePath } from '@/lib/public-navigation';
import type { DnsBadge, ExpiryBadge, Heartbeat, Monitor } from '@/types/monitor';
import clsx from 'clsx';
import { ArrowDown, ArrowLeft, ArrowUp, CalendarClock, CloudOff, RotateCw, ShieldCheck, TriangleAlert } from 'lucide-react';
import { Suspense, lazy, useCallback, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import useSWR from 'swr';
import { useFormatter, useLocale, useTranslations } from 'use-intl';
import type { DayStat, HistoryStatus } from '../../../../shared/contracts';

/** Lazy-load machine details and the latency chart only when the current monitor can display them. / 仅在当前监控项可显示机器详情和延迟图表时延迟加载。 */
const TrendChart = lazy(() =>
  import('@/components/charts/TrendChart').then((m) => ({ default: m.TrendChart })),
);
const AgentDetailContent = lazy(() =>
  import('@/components/agent/AgentDetailContent').then((m) => ({ default: m.AgentDetailContent })),
);

/** Placeholder with the chart's own height, so the lazy chunk cannot shift the page. / 使用与图表相同高度的占位符，避免延迟加载导致页面位移。 */
function ChartSkeleton({ height }: { height: number }) {
  return <div className="polaris-well animate-pulse rounded-xl" style={{ height }} aria-hidden="true" />;
}

interface MonitorDetailContentProps {
  monitorId: string;
}

/**
 * One monitor's public page.
 *
 * An agent monitor has a different payload altogether - a machine snapshot
 * plus minute buckets rather than heartbeats - so it keeps its own detail view.
 * Every probe-type monitor gets this page: the state and the day's figures up
 * top, the response-time chart, the recent checks, the 90-day record, what has
 * changed, and the add-ons.
 *
 * Agent 监控项使用机器快照及分钟桶而非心跳，因而有独立详情视图。
 * 各探测类监控项使用此公开页面：顶部展示状态和当日指标，随后展示响应时间图表、
 * 近期检查、90 天记录、状态变化及附加项。
 */
export function MonitorDetailContent({ monitorId }: MonitorDetailContentProps) {
  const t = useTranslations();
  const apiErrorMessage = useApiErrorMessage();
  const navigate = useNavigate();
  const { search } = useLocation();
  const pageConfig = usePageConfig();
  const { revalidate: refreshConfig, error: configError } = useConfig();
  const homePath = statusPagePath(pageConfig.pageId, pageConfig.defaultPageId, search);

  const { monitor, monitoringData, isLoading, error } = useMonitor(monitorId);
  const [refreshError, setRefreshError] = useState<unknown>(null);
  const refresh = useCallback(async () => {
    try {
      await revalidateData(pageConfig.pageId, undefined, refreshConfig);
      setRefreshError(null);
    } catch (failure) {
      setRefreshError(failure);
      throw failure;
    }
  }, [pageConfig.pageId, refreshConfig]);
  const timer = useRefreshTimer(refresh, 60_000);
  const accessError = [error, configError, refreshError].find(
    (failure) => failure instanceof ApiError && [401, 403, 404].includes(failure.status),
  );
  const currentError = accessError ?? error ?? configError ?? refreshError;

  const handleBack = () => {
    if (window.history.state?.idx > 0) void navigate(-1);
    else void navigate(homePath);
  };

  const back = (
    <button
      type="button"
      onClick={handleBack}
      className="mb-6 inline-flex items-center gap-1.5 text-[13px] text-[var(--polaris-ink-3)] transition-colors hover:text-[var(--polaris-ink)]"
    >
      <ArrowLeft size={14} />
      {t('page.backMonitor')}
    </button>
  );

  if (isLoading && !monitor) {
    return (
      <div className="pt-8 pb-6">
        {back}
        <div className="flex items-center gap-4">
          <span className="h-12 w-12 animate-pulse rounded-xl bg-[var(--polaris-active)]" />
          <span className="flex flex-col gap-2">
            <span className="h-6 w-56 animate-pulse rounded bg-[var(--polaris-active)]" />
            <span className="h-3.5 w-36 animate-pulse rounded bg-[var(--polaris-active)]" />
          </span>
        </div>
        <div className="mt-8 h-28 animate-pulse rounded-xl bg-[var(--polaris-well)]" />
        <div className="mt-5 h-72 animate-pulse rounded-xl bg-[var(--polaris-well)]" />
      </div>
    );
  }

  if (!monitor || accessError) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 text-center">
        <p className="text-[15px] text-[var(--polaris-ink-3)]">
          {currentError ? apiErrorMessage(currentError) : t('error.monitorNotFound')}
        </p>
        <button
          type="button"
          onClick={handleBack}
          className="h-9 rounded-lg bg-[var(--polaris-ink)] px-4 text-[13px] font-medium text-[var(--polaris-canvas)] transition-opacity hover:opacity-85"
        >
          {t('page.back')}
        </button>
      </div>
    );
  }

  return (
    <div className="pt-8 pb-6">
      {back}
      {currentError ? (
        <div role="status" className="mb-5 flex flex-wrap items-center gap-2 text-[13px] text-[var(--polaris-ink-2)]">
          <CloudOff size={16} aria-hidden="true" />
          <span>{t('timer.staleData')}</span>
          <button type="button" className="underline underline-offset-4" onClick={timer.refresh} disabled={timer.refreshing}>
            {t('timer.refreshNow')}
          </button>
        </div>
      ) : null}
      {monitor.type === 'agent' ? (
        <Suspense fallback={<div className="polaris-well h-72 animate-pulse rounded-xl" aria-hidden="true" />}>
          <AgentDetailContent numId={monitor.id} monitorName={monitor.name} target={monitor.url} />
        </Suspense>
      ) : (
        <ProbeDetail
          monitor={monitor}
          heartbeats={monitoringData.heartbeatList[monitor.id] || []}
          uptime24h={monitoringData.uptimeList[`${monitor.id}_24`] ?? null}
        />
      )}
    </div>
  );
}

function ProbeDetail({ monitor, heartbeats, uptime24h }: { monitor: Monitor; heartbeats: Heartbeat[]; uptime24h: number | null }) {
  const t = useTranslations();
  const apiErrorMessage = useApiErrorMessage();
  const locale = useLocale();
  const ago = useTimeAgo();
  const isPush = monitor.type === 'push';
  const status = monitorStatus(monitor, heartbeats);
  const ratio = monitor.sourceAvailable === false ? null : uptime24h;

  const { data: longRange, error: historyError, mutate: reloadHistory } = useSWR<{ days?: DayStat[]; uptime?: number; history?: { t: number; up: number; ms: number | null }[]; history_status?: HistoryStatus; history_sampled?: boolean }>(
    `/api/public/monitors/${monitor.id}`,
    (url: string) => requestJson<{ days: DayStat[] }>(url),
    { revalidateOnFocus: false, refreshInterval: 60_000, shouldRetryOnError: isRetryableApiError, errorRetryCount: 2 },
  );
  const days = longRange?.days ?? [];

  const series = useMemo<TrendPoint[]>(() => {
    const points = longRange?.history;
    const rows = points === undefined ? heartbeats.map(beat => ({
      t: Date.parse(beat.time) / 1000, up: beat.status, ms: beat.ping,
    })) : [...new Map([
      ...heartbeats.map(beat => { const t = Date.parse(beat.time) / 1000; return [t, { t, up: beat.status, ms: null }] as const; }),
      ...points.map(point => [point.t, point] as const),
    ]).values()].sort((a, b) => a.t - b.t);
    const interval = Math.max(1, monitor.intervalSec ?? 60);
    return rows.flatMap((point, index) => {
      const reading: TrendPoint = { t: point.t, value: isPush || ![1, 2].includes(point.up) ? null : point.ms,
        note: point.up === 0 ? t('node.offline') : undefined };
      return index && point.t - rows[index - 1].t > interval * 1.5
        ? [{ t: rows[index - 1].t + interval, value: null }, reading] : [reading];
    }).filter(point => Number.isFinite(point.t));
  }, [heartbeats, longRange?.history, monitor.intervalSec, isPush, t]);
  const bands = useMemo(() => {
    const step = series.length > 1 ? Math.max(30, (series[series.length - 1].t - series[0].t) / series.length) : 60;
    return series.filter((point) => point.note).map((point) => ({ x1: point.t - step / 2, x2: point.t + step / 2 }));
  }, [series]);

  const pings = series.map((point) => point.value).filter((v): v is number => v !== null);
  const avg = pings.length ? pings.reduce((a, b) => a + b, 0) / pings.length : null;
  const sorted = [...pings].sort((a, b) => a - b);
  const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] : null;
  const latest = heartbeats.length ? heartbeats[heartbeats.length - 1] : undefined;
  const ms = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : `${Math.round(v)}ms`);

  const changes = useMemo(() => transitions(heartbeats).slice(0, 8), [heartbeats]);
  const first = heartbeats.length ? Date.parse(heartbeats[0].time) / 1000 : undefined;
  const last = heartbeats.length ? Date.parse(heartbeats[heartbeats.length - 1].time) / 1000 : undefined;
  const clock = (sec: number) => new Date(sec * 1000).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });

  return (
    <>
      <header className="flex flex-col gap-5 sm:flex-row sm:items-center">
        <div className="flex min-w-0 items-center gap-4">
          <MonitorGlyph type={monitor.type} target={monitor.url ?? ''} monitorId={monitor.id} size="lg" />
          <div className="min-w-0">
            <h1 className="truncate text-[24px] leading-tight font-semibold tracking-[-0.025em] sm:text-[28px]">{monitor.name}</h1>
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-[var(--polaris-ink-3)]">
              <span className={clsx('flex items-center gap-1.5', status === 'down' && 'text-danger')}>
                <span className={clsx('h-2 w-2 rounded-full', STATUS_DOT[status], status === 'down' && 'polaris-halo')} />
                <span className={clsx('font-medium', STATUS_INK[status])}>{t(STATUS_KEY[status])}</span>
              </span>
              {monitor.url ? (
                <>
                  <span className="text-[var(--polaris-ink-4)]">·</span>
                  <span className="min-w-0 truncate font-mono text-[12px]">{monitor.url}</span>
                </>
              ) : null}
              {monitor.sourceAvailable === false ? (
                <>
                  <span className="text-[var(--polaris-ink-4)]">·</span>
                  <span>{t('common.form.sourceUnavailableBadge')}</span>
                </>
              ) : null}
            </div>
            {monitor.tags?.length ? (
              <div className="mt-2 flex flex-wrap gap-1">
                {monitor.tags.map((tag) => (
                  <span
                    key={tag.id}
                    className="inline-flex h-5 items-center gap-1 rounded-full border border-[var(--polaris-line)] px-2 text-[11.5px] text-[var(--polaris-ink-2)]"
                  >
                    <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: tag.color }} />
                    {tag.name}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        </div>
        {ratio !== null ? (
          <div className="flex items-center gap-3 sm:ml-auto">
            <Ring
              value={ratio}
              size={64}
              stroke={6}
              tone={ratio * 100 < 95 ? 'down' : ratio * 100 < 99 ? 'warn' : 'up'}
            >
              <span className="polaris-num text-[11px] font-semibold text-[var(--polaris-ink)]">
                <AnimatedNumber value={Math.min(100, ratio * 100)} decimals={ratio >= 0.9995 ? 0 : 1} suffix="%" />
              </span>
            </Ring>
            <div className="flex flex-col">
              <span className="text-[12px] text-[var(--polaris-ink-3)]">{t('common.col.uptime')}</span>
              <span className="text-[11px] text-[var(--polaris-ink-4)]">24h</span>
            </div>
          </div>
        ) : null}
      </header>

      {/* The figures, in one frame. / 将指标放在同一框架中。 */}
      <div className="polaris-card mt-8 grid grid-cols-2 overflow-hidden lg:grid-cols-5">
        {[
          {
            label: t(isPush ? 'common.quick.lastPush' : 'common.quick.current'),
            value: isPush ? (monitor.pushLastReceivedAt ? ago(monitor.pushLastReceivedAt) : '—') :
              status === 'down' || latest?.ping === null || latest?.ping === undefined ? (
                '—'
              ) : (
                <AnimatedNumber value={Math.round(latest.ping)} suffix="ms" />
              ),
            ink: undefined,
          },
          {
            label: t(isPush ? 'common.quick.pushTimeout' : 'common.quick.avgLatency'),
            value: isPush ? (monitor.intervalSec ? `${monitor.intervalSec}s` : '—') : avg === null ? '—' : <AnimatedNumber value={Math.round(avg)} suffix="ms" />,
            ink: undefined,
            sub: !isPush && p95 !== null ? `P95${longRange?.history_sampled ? ' ≈' : ''} ${ms(p95)}` : undefined,
          },
          {
            label: `${t('common.col.uptime')} · 24h`,
            value: ratio === null ? uptimeText(ratio) : <AnimatedNumber value={Math.min(100, ratio * 100)} decimals={2} suffix="%" />,
            ink: uptimeInk(ratio),
          },
          {
            label: t('detail.availability90d'),
            value:
              days.length && longRange?.uptime != null ? <AnimatedNumber value={longRange.uptime} decimals={2} suffix="%" /> : '—',
            ink: undefined,
          },
          {
            label: t(isPush ? 'common.quick.pushChecks' : 'common.quick.recentChecks'),
            value: <AnimatedNumber value={heartbeats.length} />,
            ink: undefined,
            sub: changes.length ? `${changes.length} · ${t('common.quick.events')}` : undefined,
          },
        ].map((cell) => (
          <div key={cell.label} className="-mt-px -ml-px min-w-0 border-t border-l border-[var(--polaris-line-soft)] px-5 py-4">
            <p className="truncate text-[12px] text-[var(--polaris-ink-3)]">{cell.label}</p>
            <p className={clsx('polaris-num mt-1 truncate text-[24px] leading-tight font-semibold tracking-[-0.02em]', cell.ink ?? 'text-[var(--polaris-ink)]')}>
              {cell.value}
            </p>
            {cell.sub ? <p className="polaris-num mt-0.5 truncate text-[12px] text-[var(--polaris-ink-4)]">{cell.sub}</p> : null}
          </div>
        ))}
      </div>

      {/* Response time over the retained checks. / 保留的检查记录中的响应时间。 */}
      {!isPush ? <section className="polaris-card mt-5 p-5">
        <div className="mb-4 flex items-baseline gap-2">
          <h2 className="text-[14px] font-semibold">{t('common.insights.metricLatency')}</h2>
          <span className="polaris-num text-[12px] text-[var(--polaris-ink-4)]">{pings.length}</span>
        </div>
        <HistoryNotice status={historyError ? 'unavailable' : longRange?.history_status} sampled={longRange?.history_sampled} onRetry={() => void reloadHistory()} />
        {pings.length > 1 ? (
          <Suspense fallback={<ChartSkeleton height={260} />}>
            <TrendChart
              data={series}
              label={t('common.insights.metricLatency')}
              format={(v) => `${Math.round(v)}ms`}
              formatX={clock}
              formatTip={(v) => new Date(v * 1000).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' })}
              bands={bands}
              height={260}
            />
          </Suspense>
        ) : null}
        {pings.length > 1 ? (
          <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 border-t border-[var(--polaris-line-soft)] pt-4 sm:grid-cols-4">
            {[
              { label: t('common.insights.statNow'), value: status === 'down' ? null : (latest?.ping ?? null) },
              { label: t('common.insights.statAvg'), value: avg },
              { label: longRange?.history_sampled ? 'P95 ≈' : 'P95', value: p95 },
              { label: t('common.insights.statMax'), value: sorted.length ? sorted[sorted.length - 1] : null },
            ].map((figure) => (
              <div key={figure.label} className="min-w-0">
                <p className="text-[12px] text-[var(--polaris-ink-3)]">{figure.label}</p>
                <p className="polaris-num mt-0.5 text-[16px] font-semibold tracking-[-0.01em]">{ms(figure.value)}</p>
              </div>
            ))}
          </div>
        ) : longRange?.history_status === 'unconfigured' || longRange?.history_status === 'unavailable' || historyError ? null : (
          <div className="polaris-well polaris-grid-bg flex h-[260px] items-center justify-center text-[12.5px] text-[var(--polaris-ink-3)]">
            {t('detail.noData')}
          </div>
        )}
      </section> : null}

      {/* Recent checks and the 90-day record. / 近期检查和 90 天记录。 */}
      <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-2">
        <section className="polaris-card p-5">
          <h2 className="mb-3 text-[14px] font-semibold">{t(isPush ? 'common.quick.pushChecks' : 'common.quick.recentChecks')}</h2>
          <HeartbeatRail beats={heartbeats} max={60} height="h-8" />
          <div className="polaris-num mt-2 flex justify-between text-[11px] text-[var(--polaris-ink-4)]">
            <span>{first ? clock(first) : ''}</span>
            <span>{last ? clock(last) : ''}</span>
          </div>
          {isPush ? <p className="mt-3 text-[12.5px] leading-relaxed text-[var(--polaris-ink-3)]">{t(monitor.pushLastReceivedAt ? 'common.quick.pushHint' : 'common.quick.pushWaiting')}</p> : null}
        </section>
        <section className="polaris-card p-5">
          <div className="mb-3 flex items-baseline gap-2">
            <h2 className="text-[14px] font-semibold">{t('detail.availability90d')}</h2>
            {days.length > 0 && longRange?.uptime != null ? (
              <span className="polaris-num ml-auto text-[13px] font-semibold">{longRange.uptime.toFixed(2)}%</span>
            ) : null}
          </div>
          {historyError ? <div role="alert" className="mb-3 text-[12.5px] text-danger-600"><p>{apiErrorMessage(historyError)}</p><button type="button" className="mt-2 underline underline-offset-4" onClick={() => void reloadHistory()}>{t('timer.refreshNow')}</button></div> : null}
          {!historyError || longRange ? <AvailabilityRail days={days} emptyLabel={t('detail.noAvailability')} /> : null}
          <div className="mt-2 flex justify-between text-[11px] text-[var(--polaris-ink-4)]">
            <span>{t('common.quick.daysStart')}</span>
            <span>{t('common.quick.daysEnd')}</span>
          </div>
        </section>
      </div>

      {/*
        Status changes get the full width, in two columns.

        This was a 1.4fr/1fr split with the add-ons beside it, which made the one
        block an operator scans during an incident the *narrowest* thing on the
        page. Full width fixes the truncation but reads as sparse - a row is a
        status, a short message and a time, so one per line leaves most of the
        card empty. Two columns keep the message whole and use the width.

        Columns rather than rows because the order is "newest first": filling
        left to right keeps the newest entry top-left, where a two-row split
        would put the second-newest under the first and read as a timeline that
        skips sideways.

        状态变化使用全宽两列。此前与附加项按 1.4fr/1fr 分栏，使事件中最需浏览的区块
        成为页面最窄部分；全宽解决截断，但状态、短消息和时间每行一条会留出太多空白。
        双列既能显示完整消息又利用宽度。按列而非行处理“最新优先”：从左到右填充
        使最新项位于左上，避免次新项在第一项下方而时间线又横向跳转。
      */}
      <section className="polaris-card mt-5 p-5">
        <h2 className="mb-2 text-[14px] font-semibold">{t('common.quick.events')}</h2>
        {changes.length === 0 ? (
          <p className="py-6 text-center text-[12.5px] text-[var(--polaris-ink-4)]">{t('common.quick.noEvents')}</p>
        ) : (
          <ul className="-mx-2 grid grid-cols-1 gap-x-6 lg:grid-cols-2">
            {changes.map((change, index) => (
              <ChangeRow key={`${change.beat.time}-${change.status}`} status={change.status} beat={change.beat} index={index} />
            ))}
          </ul>
        )}
      </section>

      {monitor.expiryBadges?.length || monitor.dns ? (
        <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-2">
          {monitor.expiryBadges?.length ? (
            <section className="polaris-card p-5">
              <h2 className="mb-3 text-[14px] font-semibold">{t('common.form.addons')}</h2>
              <div className="flex flex-col gap-2">
                {monitor.expiryBadges.map((badge) => (
                  <ExpiryCard key={badge.kind} badge={badge} />
                ))}
              </div>
            </section>
          ) : null}
          {monitor.dns ? <DnsCard dns={monitor.dns} /> : null}
        </div>
      ) : null}
    </>
  );
}

/** Status transitions within the retained checks, newest first. / 保留检查记录中的状态变化，按时间从新到旧。 */
function transitions(beats: Heartbeat[]): Array<{ status: PublicStatus; beat: Heartbeat }> {
  const out: Array<{ status: PublicStatus; beat: Heartbeat }> = [];
  let previous: PublicStatus | null = null;
  for (const beat of beats) {
    const status = beatStatus(beat);
    if (previous !== null && status !== previous) out.push({ status, beat });
    previous = status;
  }
  return out.reverse();
}

const CHANGE_ICON: Record<PublicStatus, typeof ArrowUp> = {
  up: ArrowUp,
  down: ArrowDown,
  warn: TriangleAlert,
  pending: RotateCw,
  unknown: TriangleAlert,
};

function ChangeRow({ status, beat, index }: { status: PublicStatus; beat: Heartbeat; index: number }) {
  const t = useTranslations();
  const format = useFormatter();
  const Icon = CHANGE_ICON[status];
  const when = new Date(beat.time);
  return (
    <li className="polaris-rise flex items-start gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-[var(--polaris-hover)]" style={{ animationDelay: `${60 + Math.min(index, 6) * 25}ms` }}>
      <span
        className={clsx(
          'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-[var(--polaris-line)] [&>svg]:h-3 [&>svg]:w-3',
          STATUS_INK[status],
        )}
      >
        <Icon strokeWidth={2.25} />
      </span>
      <span className="min-w-0 flex-1">
        <span className={clsx('block text-[13px] font-medium', STATUS_INK[status])}>{t(STATUS_KEY[status])}</span>
        {beat.msg ? <span className="block truncate text-[12px] text-[var(--polaris-ink-3)]" title={beat.msg}>{beat.msg}</span> : null}
      </span>
      <time dateTime={Number.isFinite(when.getTime()) ? when.toISOString() : undefined} className="polaris-num shrink-0 pt-px text-[11.5px] text-[var(--polaris-ink-4)]">
        {Number.isFinite(when.getTime()) ? format.relativeTime(when, Date.now()) : beat.time}
      </time>
    </li>
  );
}

function ExpiryCard({ badge }: { badge: ExpiryBadge }) {
  const t = useTranslations();
  const tone = badge.status === 0 ? 'down' : badge.status === 2 ? 'warn' : 'up';
  const Icon = badge.kind === 'ssl' ? ShieldCheck : CalendarClock;
  const pct = badge.days === null ? 0 : Math.max(0, Math.min(100, (badge.days / 90) * 100));
  return (
    <div className={clsx('polaris-well px-4 py-3', tone === 'warn' && 'text-warning', tone === 'down' && 'text-danger')}>
      <div className="flex items-center gap-2.5">
        <Icon size={15} className={tone === 'up' ? 'text-[var(--polaris-ink-4)]' : tone === 'warn' ? 'text-warning-700' : 'text-danger-600'} />
        <span className="text-[12.5px] text-[var(--polaris-ink-3)]">
          {badge.kind === 'ssl' ? t('common.insights.kindSsl') : t('common.insights.kindDomain')}
        </span>
        <span
          className={clsx(
            'polaris-num ml-auto text-[13px] font-semibold',
            tone === 'up' ? 'text-[var(--polaris-ink)]' : tone === 'warn' ? 'text-warning-700' : 'text-danger-600',
          )}
        >
          {`${badge.kind === 'ssl' ? 'SSL' : 'DOMAIN'} ${badge.days === null ? '—' : `${Math.round(badge.days)}d`}`}
        </span>
      </div>
      <Meter value={badge.days === null ? null : pct} tone={tone === 'up' ? 'primary' : tone} className="mt-2" />
      {badge.message ? <p className="mt-2 truncate text-[11.5px] text-[var(--polaris-ink-4)]" title={badge.message}>{badge.message}</p> : null}
    </div>
  );
}

/** The latest resolver observation, including successful answers. / 解析器最近一次观测，包括成功应答。 */
function DnsCard({ dns }: { dns: DnsBadge }) {
  const t = useTranslations();
  /* Without the explicit locale the timestamp follows the browser's language,
     not the page's - an English browser showed English times on a Chinese page.
     必须显式使用页面语言，否则时间戳跟随浏览器语言，例如中文页面在英文浏览器中显示英文时间。 */
  const locale = useLocale();
  const tone = dns.st === 1 ? 'up' : dns.st === 2 ? 'warn' : 'down';
  const label = dns.st === 1 ? t('detail.dnsUp') : dns.st === 2 ? t('detail.dnsWarn') : t('detail.dnsDown');
  return (
    <section className="polaris-card p-5" aria-label={t('detail.dns')}>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h2 className="text-[14px] font-semibold">{t('detail.dns')}</h2>
        <span className={clsx('text-[12.5px]', tone === 'up' ? 'text-success-700' : tone === 'warn' ? 'text-warning-700' : 'text-danger-600')}>
          {label}
        </span>
        {dns.ts > 0 ? (
          <span className="polaris-num ml-auto text-[11.5px] text-[var(--polaris-ink-4)]" title={new Date(dns.ts * 1000).toLocaleString(locale)}>
            {t('detail.dnsCheckedAt', { time: new Date(dns.ts * 1000).toLocaleTimeString(locale) })}
          </span>
        ) : null}
      </div>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
        {[
          { label: t('detail.dnsHostname'), value: dns.hostname },
          { label: t('detail.dnsRecordType'), value: dns.recordType },
          { label: t('detail.dnsResponseCode'), value: dns.rcode },
          { label: t('detail.dnsLatency'), value: dns.latencyMs != null ? `${Math.round(dns.latencyMs)}ms` : undefined },
        ].map((item) => (
          <div key={item.label} className="min-w-0">
            <dt className="text-[12px] text-[var(--polaris-ink-3)]">{item.label}</dt>
            <dd className="polaris-num mt-1 break-all text-[12.5px] text-[var(--polaris-ink-2)]">{item.value ?? '—'}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-4 border-t border-[var(--polaris-line-soft)] pt-3">
        <h3 className="text-[12px] font-medium text-[var(--polaris-ink-3)]">{t('detail.dnsRecords')}</h3>
        {dns.records && dns.records.length > 0 ? (
          <ul className="mt-2 flex flex-col gap-1.5">
            {dns.records.map((record, index) => (
              <li key={`${index}-${record}`} className="rounded-md bg-[var(--polaris-well)] px-3 py-2">
                <code className="block break-all whitespace-pre-wrap text-[12px] text-[var(--polaris-ink-2)]">{record}</code>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-[12px] leading-relaxed text-[var(--polaris-ink-4)]">
            {dns.records === undefined ? t('detail.dnsRecordsPending') : t('detail.dnsNoRecords')}
          </p>
        )}
      </div>
      {dns.msg ? <p className="mt-3 break-words text-[12px] leading-relaxed text-[var(--polaris-ink-3)]">{dns.msg}</p> : null}
    </section>
  );
}
