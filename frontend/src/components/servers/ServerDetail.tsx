import { HistoryNotice } from '@/components/charts/HistoryNotice';
import type { HistoryStatus } from '../../../../shared/contracts';
import { CountryFlag } from '@/admin/components/CountryFlag';
import { formatBytes, formatClock, formatRate } from '@/admin/format';
import { Ring } from '@/components/ui/MetricMeters';
import { Segmented } from '@/components/ui/Segmented';
import { TONE_TEXT } from '@/components/ui/StatusDot';
import { useLocale } from '@/i18n/IntlProvider';
import clsx from 'clsx';
import { ArrowDownUp, ChevronLeft, ChevronRight, Cpu, Download, GitCompareArrows, HardDrive, Info, LineChart, MemoryStick } from 'lucide-react';
import { lazy, Suspense, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useTranslations } from 'use-intl';
import type { PublicServer, PublicServerHistory } from '../../../../shared/public-servers';
import { COUNTRY_CENTRES, countryCode, regionLabel } from './geo';
import type { ChartRow, ChartSeries } from './HistoryChart';
import { historyWindow, publishesSeries, RANGES, useSeriesColors } from './history-model';
import { WorldMap } from './MapView';
import { historyCsv, known, loadTone, percentText, publishes, resourcePercent, type ResourceKind } from './model';
import { Identity, LiveTrend, NetRates, PinButton, Recency, StatusBadge, TagChips, uptimeText } from './ServerParts';
import type { LiveSample } from './useVisitorState';

const HistoryChart = lazy(() => import('./HistoryChart').then(module => ({ default: module.HistoryChart })));
const ICONS: Record<ResourceKind, ReactNode> = { cpu: <Cpu />, memory: <MemoryStick />, disk: <HardDrive /> };

/**
 * One machine: its live readings first, then its published history, then the facts that do not change minute to minute.
 * 单台机器：先显示实时读数，再显示已公开的历史，最后是不随分钟变化的信息。
 */
export function ServerDetail({ server, history, historyStatus, historySampled, onRetryHistory, serverNow, now, samples, showHistory, accent, listHref, prev, next, pinned, onPin, selected, selectionFull, onSelect, onTag }: {
  historyStatus?: HistoryStatus; historySampled?: boolean; onRetryHistory: () => void;
  server: PublicServer; history: PublicServerHistory[]; serverNow: number; now: number; samples: LiveSample[] | undefined; showHistory: boolean; accent: string;
  listHref: string; prev: { href: string; name: string } | null; next: { href: string; name: string } | null;
  pinned: boolean; onPin: () => void; selected: boolean; selectionFull: boolean; onSelect: () => void; onTag: (id: string) => void;
}) {
  const t = useTranslations('presentation');
  const { locale } = useLocale();
  const country = countryCode(server.region);
  const centre = country ? COUNTRY_CENTRES[country] : undefined;
  const kinds = (['cpu', 'memory', 'disk'] as const).filter(kind => publishes(server, kind));
  const network = server.upload !== undefined || server.download !== undefined;
  const button = 'inline-flex h-8 items-center gap-1.5 rounded-lg border border-[var(--polaris-line)] bg-[var(--polaris-card)] px-2.5 text-[12.5px] text-[var(--polaris-ink-2)] transition-colors hover:border-[var(--polaris-line-strong)] hover:text-[var(--polaris-ink)] disabled:pointer-events-none disabled:opacity-40';
  return (
    <div className="server-detail flex flex-col gap-4">
      <nav aria-label={t('breadcrumb')} className="server-detail-nav flex flex-wrap items-center gap-2">
        <span className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-[var(--polaris-ink-3)]">
          <Link to={listHref} className="transition-colors hover:text-[var(--polaris-ink)]">{t('machines')}</Link>
          <ChevronRight size={12} aria-hidden="true" className="text-[var(--polaris-ink-4)]" />
          <span className="truncate text-[var(--polaris-ink)]" aria-current="page">{server.name}</span>
        </span>
        <span className="server-detail-actions ml-auto flex items-center gap-1.5">
          <button type="button" aria-pressed={selected} disabled={selectionFull && !selected} onClick={onSelect} className={clsx(button, selected && '!border-[var(--polaris-ink)]/40 !bg-[var(--polaris-active)] !text-[var(--polaris-ink)]')} title={selectionFull && !selected ? t('compareLimit') : undefined}>
            <GitCompareArrows size={14} aria-hidden="true" />{t(selected ? 'removeFromCompare' : 'addToCompare')}
          </button>
          <PinButton pinned={pinned} name={server.name} onToggle={onPin} className="h-8 w-8 border border-[var(--polaris-line)] bg-[var(--polaris-card)]" />
          {prev ? <Link to={prev.href} className={clsx(button, 'w-8 justify-center !px-0')} aria-label={t('previousMachine', { name: prev.name })} title={`${t('previousMachineShort')} (K)`}><ChevronLeft size={15} /></Link> : <button type="button" disabled className={clsx(button, 'w-8 justify-center !px-0')} aria-label={t('previousMachineShort')}><ChevronLeft size={15} /></button>}
          {next ? <Link to={next.href} className={clsx(button, 'w-8 justify-center !px-0')} aria-label={t('nextMachine', { name: next.name })} title={`${t('nextMachineShort')} (J)`}><ChevronRight size={15} /></Link> : <button type="button" disabled className={clsx(button, 'w-8 justify-center !px-0')} aria-label={t('nextMachineShort')}><ChevronRight size={15} /></button>}
        </span>
      </nav>

      <header className="server-detail-heading polaris-card flex flex-wrap items-center gap-x-6 gap-y-4 p-5">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <Identity server={server} size="lg" as="h1" className="min-w-0" />
            <StatusBadge server={server} />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2 pl-[52px] text-[12px] text-[var(--polaris-ink-3)] empty:hidden max-sm:pl-0">
            {server.group ? <span className="inline-flex h-5 items-center rounded-md bg-[var(--polaris-active)] px-1.5 text-[11px] text-[var(--polaris-ink-2)]">{server.group.name}</span> : null}
            <TagChips server={server} onTag={onTag} />
          </div>
        </div>
        <dl className="server-detail-facts grid grid-cols-3 gap-x-6 gap-y-1 text-right max-sm:w-full max-sm:text-left">
          {server.uptime !== undefined ? <Fact label={t('uptime')} value={uptimeText(server)} /> : null}
          {server.load !== undefined ? <Fact label={t('load')} value={known(server.load) ? server.load.toFixed(2) : '—'} /> : null}
          <Fact label={t('reported')} value={<Recency server={server} now={now} />} />
        </dl>
      </header>

      {kinds.length || network ? (
        <div className={clsx('server-detail-metrics grid grid-cols-1 gap-3 sm:grid-cols-2', kinds.length + (network ? 1 : 0) >= 4 ? 'xl:grid-cols-4' : 'xl:grid-cols-3')}>
          {kinds.map(kind => <Gauge key={kind} kind={kind} server={server} samples={samples} />)}
          {network ? (
            <div className="server-detail-network polaris-card flex min-w-0 flex-col gap-2 p-4">
              <span className="flex items-center gap-1.5 text-[12px] text-[var(--polaris-ink-3)]"><ArrowDownUp size={14} className="text-[var(--polaris-ink-4)]" aria-hidden="true" />{t(server.online === false ? 'lastNetworkReading' : 'networkLive')}</span>
              <NetRates server={server} className="!gap-4 text-[15px] font-semibold !text-[var(--polaris-ink)]" />
              <LiveTrend samples={samples} field="download" height={30} className={clsx('mt-auto', server.online === true ? 'text-[var(--polaris-chart)]' : 'text-[var(--polaris-ink-4)]')} />
            </div>
          ) : null}
        </div>
      ) : null}

      {showHistory && (server.cpu !== undefined || server.memoryUsed !== undefined || network) ? <History server={server} history={history} now={serverNow} accent={accent} status={historyStatus} sampled={historySampled} onRetry={onRetryHistory} /> : null}

      <section className="server-detail-system polaris-card p-5">
        <h2 className="mb-3 flex items-center gap-2 text-[14px] font-semibold tracking-[-0.01em] text-[var(--polaris-ink)]"><Info size={15} className="text-[var(--polaris-ink-4)]" aria-hidden="true" />{t('systemInfo')}</h2>
        <div className={clsx('grid grid-cols-1 gap-x-8 gap-y-5', centre && 'lg:grid-cols-[minmax(0,1fr)_minmax(260px,340px)]')}>
        <dl className="grid min-w-0 grid-cols-1 gap-x-8 sm:grid-cols-2">
          {server.os !== undefined ? <Row label={t('os')} value={server.os ?? '—'} /> : null}
          {server.arch !== undefined ? <Row label={t('arch')} value={server.arch ?? '—'} /> : null}
          {server.region !== undefined ? <Row label={t('region')} value={server.region ? <span className="inline-flex items-center gap-1.5">{country ? <CountryFlag code={country} size={14} /> : null}{regionLabel(server.region, locale)}</span> : '—'} /> : null}
          <Row label={t('group')} value={server.group?.name ?? t('ungrouped')} />
          {server.uptime !== undefined ? <Row label={t('uptime')} value={uptimeText(server)} /> : null}
          {server.load !== undefined ? <Row label={t('load')} value={known(server.load) ? server.load.toFixed(2) : '—'} /> : null}
          {server.memoryTotal !== undefined ? <Row label={t('memoryTotal')} value={formatBytes(server.memoryTotal)} /> : null}
          {server.diskTotal !== undefined ? <Row label={t('diskTotal')} value={formatBytes(server.diskTotal)} /> : null}
          {server.sent !== undefined ? <Row label={t('sentTotal')} value={formatBytes(server.sent)} /> : null}
          {server.received !== undefined ? <Row label={t('receivedTotal')} value={formatBytes(server.received)} /> : null}
          <Row label={t('lastReported')} value={known(server.reportedAt) && server.reportedAt > 0 ? new Date(server.reportedAt * 1000).toLocaleString() : t('noReport')} />
        </dl>
        {centre && country ? (
          <figure className="min-w-0 self-start rounded-[10px] bg-[var(--polaris-well)] p-3">
            <WorldMap compact markers={[{ key: country, lat: centre[0], lon: centre[1], count: 1, tone: server.online === true ? 'up' : server.online === false ? 'down' : 'idle', label: regionLabel(server.region, locale) ?? country }]} />
            <figcaption className="mt-2 flex items-center gap-1.5 text-[12px] text-[var(--polaris-ink-3)]"><CountryFlag code={country} size={14} />{regionLabel(server.region, locale)}</figcaption>
          </figure>
        ) : null}
        </div>
      </section>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: ReactNode }) {
  return <div className="min-w-0"><dt className="text-[11.5px] text-[var(--polaris-ink-4)]">{label}</dt><dd className="polaris-num mt-0.5 truncate text-[14px] font-semibold text-[var(--polaris-ink)] [&_time]:text-[14px]">{value}</dd></div>;
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return <div className="flex min-w-0 items-center justify-between gap-4 border-b border-[var(--polaris-line-soft)] py-2.5 text-[13px]"><dt className="shrink-0 text-[var(--polaris-ink-3)]">{label}</dt><dd className="polaris-num min-w-0 truncate text-right text-[var(--polaris-ink)]">{value}</dd></div>;
}

/** A resource as the console draws it on a machine: a ring against 100%, the figure, and what it is out of. / 与控制台一致的资源读数：相对 100% 的圆环、数值及总量。 */
function Gauge({ kind, server, samples }: { kind: ResourceKind; server: PublicServer; samples: LiveSample[] | undefined }) {
  const t = useTranslations('presentation');
  const value = resourcePercent(server, kind);
  const tone = server.online === true ? loadTone(value) : 'idle';
  const detail = kind === 'memory' ? `${formatBytes(server.memoryUsed)} / ${formatBytes(server.memoryTotal)}` : kind === 'disk' ? `${formatBytes(server.diskUsed)} / ${formatBytes(server.diskTotal)}` : null;
  return (
    <div className="server-detail-gauge polaris-card flex min-w-0 items-center gap-3.5 p-4">
      <Ring value={(value ?? 0) / 100} size={60} stroke={6} tone={tone === 'up' ? 'primary' : tone} label={`${t(kind)}: ${percentText(value)}`}>
        <span className="text-[var(--polaris-ink-4)] [&>svg]:h-4 [&>svg]:w-4">{ICONS[kind]}</span>
      </Ring>
      <div className="min-w-0 flex-1">
        <p className="text-[12px] text-[var(--polaris-ink-3)]">{t(kind)}</p>
        <p className={clsx('polaris-num text-[20px] leading-tight font-semibold tracking-tight', tone === 'up' || tone === 'idle' ? 'text-[var(--polaris-ink)]' : TONE_TEXT[tone], server.online !== true && '!text-[var(--polaris-ink-3)]')}>{percentText(value)}</p>
        {detail ? <p className="polaris-num truncate text-[11.5px] text-[var(--polaris-ink-4)]">{detail}</p>
          : kind === 'cpu' ? <LiveTrend samples={samples} field="cpu" max={100} height={18} className={server.online === true ? 'mt-1 text-[var(--polaris-chart)]' : 'mt-1 text-[var(--polaris-ink-4)]'} /> : null}
      </div>
    </div>
  );
}

function History({ server, history, now, accent, status, sampled, onRetry }: { server: PublicServer; history: PublicServerHistory[]; now: number; accent: string; status?: HistoryStatus; sampled?: boolean; onRetry: () => void }) {
  const t = useTranslations('presentation');
  const { locale } = useLocale();
  const colors = useSeriesColors(accent);
  const [hours, setHours] = useState<(typeof RANGES)[number]>(24);
  const rows = useMemo<ChartRow[]>(() => historyWindow(history, now, hours).sort((a, b) => a.ts - b.ts)
    .map(point => ({ t: point.ts, cpu: known(point.cpu) ? point.cpu : null, memory: known(point.memory) ? point.memory : null, upload: known(point.upload) ? point.upload : null, download: known(point.download) ? point.download : null })), [history, now, hours]);
  const time = (value: number) => formatClock(value, locale);
  const tip = (value: number) => new Date(value * 1000).toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const charts: Array<{ key: string; title: string; series: ChartSeries[]; rate: boolean; wide?: boolean }> = [
    ...(publishesSeries(server, 'cpu') ? [{ key: 'cpu', title: t('cpuHistory'), series: [{ key: 'cpu', label: t('cpu'), color: colors.accent }], rate: false }] : []),
    ...(publishesSeries(server, 'memory') ? [{ key: 'memory', title: t('memoryHistory'), series: [{ key: 'memory', label: t('memory'), color: colors.green }], rate: false }] : []),
    ...(publishesSeries(server, 'upload') || publishesSeries(server, 'download') ? [{ key: 'network', title: t('networkHistory'), rate: true, wide: true, series: [
      ...(publishesSeries(server, 'download') ? [{ key: 'download', label: t('download'), color: colors.accent }] : []),
      ...(publishesSeries(server, 'upload') ? [{ key: 'upload', label: t('upload'), color: colors.green }] : []),
    ] }] : []),
  ];
  const download = () => {
    const blob = new Blob([historyCsv(server, historyWindow(history, now, hours))], { type: 'text/csv' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${server.name.replace(/[^\w.-]+/g, '_')}-${hours}h.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  };
  return (
    <section className="server-detail-history polaris-card p-5" aria-label={t('history')}>
      <div className="server-history-heading mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 className="flex items-center gap-2 text-[14px] font-semibold tracking-[-0.01em] text-[var(--polaris-ink)]"><LineChart size={15} className="text-[var(--polaris-ink-4)]" aria-hidden="true" />{t('history')}</h2>
        <span className="polaris-num text-[12px] text-[var(--polaris-ink-4)]">{t('historyPoints', { n: rows.length })}</span>
        <span className="ml-auto flex items-center gap-2">
          <Segmented label={t('historyRange')} value={String(hours)} onChange={value => setHours(Number(value) as (typeof RANGES)[number])} options={RANGES.map(value => ({ value: String(value), label: t('hoursRange', { n: value }) }))} />
          <button type="button" onClick={download} disabled={!rows.length} className="inline-flex h-[30px] items-center gap-1.5 rounded-lg border border-[var(--polaris-line)] px-2.5 text-[12px] text-[var(--polaris-ink-2)] transition-colors hover:border-[var(--polaris-line-strong)] hover:text-[var(--polaris-ink)] disabled:opacity-40"><Download size={13} aria-hidden="true" />CSV</button>
        </span>
      </div>
      <HistoryNotice status={status} sampled={sampled} onRetry={onRetry} />
      {!rows.length && status && status !== 'ready' ? null : !rows.length ? <p className="rounded-[10px] bg-[var(--polaris-well)] px-4 py-10 text-center text-[12.5px] text-[var(--polaris-ink-3)]">{t('noHistory')}</p> : (
        <div className="grid grid-cols-1 gap-x-6 gap-y-5 lg:grid-cols-2">
          {charts.map(chart => (
            <div key={chart.key} className={clsx('min-w-0', chart.wide && 'lg:col-span-2')}>
              <div className="mb-1 flex items-center gap-3 text-[12.5px]">
                <span className="font-medium text-[var(--polaris-ink-2)]">{chart.title}</span>
                <span className="ml-auto flex items-center gap-3">{chart.series.map(item => <span key={item.key} className="inline-flex items-center gap-1.5 text-[11.5px] text-[var(--polaris-ink-3)]"><span aria-hidden="true" className="h-2 w-2 rounded-[3px]" style={{ backgroundColor: item.color }} />{item.label}</span>)}</span>
              </div>
              <Suspense fallback={<div className="polaris-shimmer rounded-lg" style={{ height: 190 }} />}>
                <HistoryChart rows={rows} series={chart.series} label={chart.title} format={chart.rate ? value => formatRate(value) : value => `${Math.round(value)}%`} formatTime={time} formatTip={tip} domain={chart.rate ? undefined : [0, 100]} height={chart.wide ? 210 : 190} />
              </Suspense>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

