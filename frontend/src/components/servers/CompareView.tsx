import { formatBytes, formatClock, formatRate } from '@/admin/format';
import { Meter } from '@/components/ui/MetricMeters';
import { Segmented } from '@/components/ui/Segmented';
import { useLocale } from '@/i18n/IntlProvider';
import { ApiError } from '@/api/errors';
import clsx from 'clsx';
import { ArrowLeft, GitCompareArrows, X } from 'lucide-react';
import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useTranslations } from 'use-intl';
import type { PublicServer } from '../../../../shared/public-servers';
import { regionLabel } from './geo';
import type { ChartRow } from './HistoryChart';
import { known, loadTone, percentText, publishes, resourcePercent, sortValue, type DetailResponse } from './model';
import { historyWindow, publishesSeries, RANGES, useSeriesColors } from './history-model';
import { Recency, StatusBadge, uptimeText } from './ServerParts';
import { useServerData } from './useServerData';

const HistoryChart = lazy(() => import('./HistoryChart').then(module => ({ default: module.HistoryChart })));
const detailPath = (id: string | undefined) => id ? `/api/public/servers/${encodeURIComponent(id)}` : null;

type Metric = { key: string; label: string; value: (server: PublicServer) => ReactNode; rank?: (server: PublicServer) => number | null; shown: (server: PublicServer) => boolean };

/**
 * Two to four machines side by side: the same readings in one row each, then their histories on shared axes.
 * The highest reading in a row is marked, because in a comparison that is usually the question.
 *
 * 并排对比 2–4 台机器：同一读数位于同一行，再在共享坐标轴上叠加历史。每行标出最高值，因为对比时通常要找它。
 */
export function CompareView({ ids, servers, now, interval, refreshKey, onRefreshingChange, showHistory, accent, backHref, hrefOf, onRemove }: {
  ids: string[]; servers: PublicServer[]; now: number; interval: number; showHistory: boolean; accent: string;
  refreshKey: number; onRefreshingChange: (refreshing: boolean) => void;
  backHref: string; hrefOf: (id: string) => string; onRemove: (id: string) => void;
}) {
  const t = useTranslations('presentation');
  const { locale } = useLocale();
  const colors = useSeriesColors(accent);
  const [hours, setHours] = useState<(typeof RANGES)[number]>(6);
  const available = ids.filter(id => servers.some(server => server.id === id));
  const loads = [
    useServerData<DetailResponse>(showHistory && available.length >= 2 ? detailPath(available[0]) : null, interval, refreshKey),
    useServerData<DetailResponse>(showHistory && available.length >= 2 ? detailPath(available[1]) : null, interval, refreshKey),
    useServerData<DetailResponse>(showHistory && available.length >= 2 ? detailPath(available[2]) : null, interval, refreshKey),
    useServerData<DetailResponse>(showHistory && available.length >= 2 ? detailPath(available[3]) : null, interval, refreshKey),
  ];
  const denied = (error: unknown) => error instanceof ApiError && [401, 403, 404].includes(error.status);
  const picked = available.filter((_, index) => !denied(loads[index].error)).map(id => servers.find(server => server.id === id)!);
  const failed = available.filter((_, index) => loads[index].error && !denied(loads[index].error));
  const refreshing = loads.some(load => load.refreshing);
  useEffect(() => { onRefreshingChange(refreshing); }, [refreshing, onRefreshingChange]);
  useEffect(() => () => onRefreshingChange(false), [onRefreshingChange]);
  const retry = () => { for (const load of loads) if (load.error && !denied(load.error)) void load.refresh(); };
  const color = (id: string) => colors.compare[ids.indexOf(id) % colors.compare.length];

  const metrics = ([
    { key: 'status', label: t('status'), value: server => <StatusBadge server={server} />, shown: () => true },
    ...(['cpu', 'memory', 'disk'] as const).map<Metric>(kind => ({ key: kind, label: t(kind), shown: server => publishes(server, kind), rank: server => resourcePercent(server, kind),
      value: server => { const value = resourcePercent(server, kind); const tone = server.online === true ? loadTone(value) : 'idle'; return <span className="flex w-full max-w-[11rem] flex-col gap-1.5"><span className="polaris-num">{percentText(value)}{kind !== 'cpu' && known(kind === 'memory' ? server.memoryUsed : server.diskUsed) ? <span className="ml-1.5 text-[11px] font-normal text-[var(--polaris-ink-4)]">{formatBytes(kind === 'memory' ? server.memoryUsed : server.diskUsed)} / {formatBytes(kind === 'memory' ? server.memoryTotal : server.diskTotal)}</span> : null}</span><Meter value={value} tone={tone === 'up' ? 'primary' : tone} /></span>; } })),
    { key: 'load', label: t('load'), shown: server => server.load !== undefined, rank: server => sortValue(server, 'load'), value: server => known(server.load) ? server.load.toFixed(2) : '—' },
    { key: 'upload', label: t('upload'), shown: server => server.upload !== undefined, rank: server => known(server.upload) ? server.upload : null, value: server => formatRate(server.upload) },
    { key: 'download', label: t('download'), shown: server => server.download !== undefined, rank: server => known(server.download) ? server.download : null, value: server => formatRate(server.download) },
    { key: 'sent', label: t('sentTotal'), shown: server => server.sent !== undefined, rank: server => known(server.sent) ? server.sent : null, value: server => formatBytes(server.sent) },
    { key: 'received', label: t('receivedTotal'), shown: server => server.received !== undefined, rank: server => known(server.received) ? server.received : null, value: server => formatBytes(server.received) },
    { key: 'uptime', label: t('uptime'), shown: server => server.uptime !== undefined, rank: server => sortValue(server, 'uptime'), value: server => uptimeText(server) },
    { key: 'os', label: t('os'), shown: server => server.os !== undefined, value: server => [server.os, server.arch].filter(Boolean).join(' · ') || '—' },
    { key: 'region', label: t('region'), shown: server => server.region !== undefined, value: server => regionLabel(server.region, locale) ?? '—' },
    { key: 'group', label: t('group'), shown: () => true, value: server => server.group?.name ?? t('ungrouped') },
    { key: 'reported', label: t('reported'), shown: () => true, value: server => <Recency server={server} now={now} /> },
  ] satisfies Metric[] as Metric[]).filter(metric => picked.some(metric.shown));

  const histories = picked.map(server => ({ server, detail: loads.find(load => load.data?.server.id === server.id)?.data }));
  const serverNow = loads.find(load => load.data)?.data?.now ?? now;
  const charts = (['cpu', 'memory', 'download', 'upload'] as const).filter(key => picked.some(server => publishesSeries(server, key)));
  const rowsFor = (key: (typeof charts)[number]) => {
    const merged = new Map<number, ChartRow>();
    for (const { server, detail } of histories) {
      if (!detail || !publishesSeries(server, key) || !publishesSeries(detail.server, key)) continue;
      for (const point of historyWindow(detail.history, serverNow, hours)) {
        const row = merged.get(point.ts) ?? { t: point.ts, ...Object.fromEntries(picked.map(item => [item.id, null])) } as ChartRow;
        row[server.id] = known(point[key]) ? point[key]! : null;
        merged.set(point.ts, row);
      }
    }
    return [...merged.values()].sort((a, b) => a.t - b.t);
  };
  const time = (value: number) => formatClock(value, locale);
  const tip = (value: number) => new Date(value * 1000).toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const titles = { cpu: t('cpuHistory'), memory: t('memoryHistory'), download: t('downloadHistory'), upload: t('uploadHistory') };

  return (
    <div className="server-comparison flex min-w-0 flex-col gap-4">
      <div className="server-comparison-heading flex flex-wrap items-center gap-3">
        <Link to={backHref} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[var(--polaris-line)] bg-[var(--polaris-card)] px-2.5 text-[12.5px] text-[var(--polaris-ink-2)] transition-colors hover:border-[var(--polaris-line-strong)] hover:text-[var(--polaris-ink)]"><ArrowLeft size={14} aria-hidden="true" />{t('back')}</Link>
        <h1 className="flex items-center gap-2 text-[18px] font-semibold tracking-[-0.02em] text-[var(--polaris-ink)]"><GitCompareArrows size={17} className="text-[var(--polaris-ink-4)]" aria-hidden="true" />{t('compareTitle', { n: picked.length })}</h1>
      </div>
      {picked.length < ids.length ? <p role="status" className="text-[13px] text-[var(--polaris-ink-3)]">{t('compareUnavailable')}</p> : null}
      {picked.length < 2 ? (
        <div className="polaris-card px-6 py-14 text-center text-[13px] text-[var(--polaris-ink-3)]">{t('compareNeedTwo')}<div className="mt-4"><Link to={backHref} className="server-button">{t('back')}</Link></div></div>
      ) : (
        <>
          <div className="server-table-scroll polaris-card polaris-scroll-x min-w-0 max-w-full overflow-x-auto" role="region" aria-label={t('compareTitle', { n: picked.length })} tabIndex={0}>
            <table className="polaris-table server-compare" style={{ minWidth: 140 + picked.length * 220 }}>
              <thead>
                <tr>
                  <th className="server-compare-label w-36"><span className="sr-only">{t('metric')}</span></th>
                  {picked.map(server => (
                    <th key={server.id} scope="col" className="!h-auto !py-3">
                      <span className="flex items-center gap-2">
                        <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ backgroundColor: color(server.id) }} />
                        <Link to={hrefOf(server.id)} className="server-compare-name min-w-0 text-[13px] font-semibold text-[var(--polaris-ink)] hover:underline">{server.name}</Link>
                        <button type="button" onClick={() => onRemove(server.id)} aria-label={t('removeFromCompareNamed', { name: server.name })} className="server-compare-remove ml-auto inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--polaris-ink-4)] hover:bg-[var(--polaris-hover)] hover:text-[var(--polaris-ink)]"><X size={13} /></button>
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {metrics.map(metric => <CompareRow key={metric.key} metric={metric} picked={picked} />)}
              </tbody>
            </table>
          </div>
          {showHistory && charts.length ? (
            <section className="server-compare-history polaris-card min-w-0 p-5" aria-label={t('history')}>
              <div className="server-compare-history-heading mb-4 flex flex-wrap items-center gap-3">
                <h2 className="text-[14px] font-semibold tracking-[-0.01em] text-[var(--polaris-ink)]">{t('history')}</h2>
                <span className="server-compare-legend flex min-w-0 flex-wrap items-center gap-3">{picked.map(server => <span key={server.id} className="inline-flex min-w-0 items-center gap-1.5 text-[11.5px] text-[var(--polaris-ink-3)]"><span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-[3px]" style={{ backgroundColor: color(server.id) }} /><span className="[overflow-wrap:anywhere]">{server.name}</span></span>)}</span>
                <Segmented className="ml-auto" label={t('historyRange')} value={String(hours)} onChange={value => setHours(Number(value) as (typeof RANGES)[number])} options={RANGES.map(value => ({ value: String(value), label: t('hoursRange', { n: value }) }))} />
              </div>
              {failed.length ? <div role="alert" className="mb-4 flex flex-wrap items-center gap-2 rounded-lg bg-[var(--polaris-well)] p-3 text-[13px] text-[var(--polaris-ink-2)]">
                <p className="min-w-0 flex-1 [overflow-wrap:anywhere]">{t('compareHistoryFailed', { names: failed.map(id => servers.find(server => server.id === id)!.name).join('、') })}</p>
                <button type="button" className="server-button" disabled={refreshing} onClick={retry}>{t('retry')}</button>
              </div> : null}
              {loads.some(load => load.refreshing && !load.data) ? <div className="polaris-shimmer h-[190px] rounded-lg" role="status" aria-label={t('loading')} /> : (
                <div className="grid grid-cols-1 gap-x-6 gap-y-5 lg:grid-cols-2">
                  {charts.map(key => <HistoryCard key={key} metric={key} rows={rowsFor(key)} series={picked.filter(server => publishesSeries(server, key)).map(server => ({ key: server.id, label: server.name, color: color(server.id) }))} title={titles[key]} failed={failed.length > 0} time={time} tip={tip} />)}
                </div>
              )}
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}

function CompareRow({ metric, picked }: {
  metric: Metric;
  picked: PublicServer[];
}) {
  const t = useTranslations('presentation');
  const ranks = metric.rank ? picked.map(server => metric.shown(server) ? metric.rank!(server) : null) : [];
  const top = ranks.filter(known).length > 1 ? Math.max(...ranks.filter(known)) : null;
  return (<tr key={metric.key}>
    <th scope="row" className="server-compare-label !h-auto !py-2.5 text-[12.5px] !font-normal text-[var(--polaris-ink-3)]">{metric.label}</th>
    {picked.map((server, index) => (<td key={server.id} className={clsx('polaris-num text-[13px] text-[var(--polaris-ink)]', top !== null && ranks[index] === top && 'server-compare-top')}>
      {metric.shown(server) ? metric.value(server) : <span className="text-[var(--polaris-ink-4)]">{t('notPublished')}</span>}
    </td>))}
  </tr>);
}

function HistoryCard({ metric: key, rows, series, title, failed, time, tip }: {
  metric: 'cpu' | 'memory' | 'download' | 'upload';
  rows: ChartRow[];
  series: Array<{
    key: string;
    label: string;
    color: string;
  }>;
  title: string;
  failed: boolean;
  time: (value: number) => string;
  tip: (value: number) => string;
}) {
  const t = useTranslations('presentation');
  return (<div key={key} className="min-w-0">
    <p className="mb-1 text-[12.5px] font-medium text-[var(--polaris-ink-2)]">{title}</p>
    {rows.length ? <Suspense fallback={<div className="polaris-shimmer rounded-lg" style={{ height: 190 }} />}>
      <HistoryChart rows={rows} series={series} label={title} format={key === 'cpu' || key === 'memory' ? value => `${Math.round(value)}%` : value => formatRate(value)} formatTime={time} formatTip={tip} domain={key === 'cpu' || key === 'memory' ? [0, 100] : undefined} height={190} />
    </Suspense> : failed ? null : <p className="flex h-[190px] items-center justify-center rounded-[10px] bg-[var(--polaris-well)] text-[12.5px] text-[var(--polaris-ink-3)]">{t('noHistory')}</p>}
  </div>);
}
