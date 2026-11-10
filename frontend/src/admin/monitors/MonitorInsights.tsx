import { TrendChart, type TrendPoint } from '@/components/charts/TrendChart';
import { useLocale } from '@/i18n/IntlProvider';
import clsx from 'clsx';
import { CalendarClock, ChartSpline, ShieldCheck } from 'lucide-react';
import { memo, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useTranslations } from 'use-intl';
import { Meter } from '../../components/ui/MetricMeters';
import { Segmented } from '../../components/ui/Segmented';
import { useTimeAgo } from '../../hooks/useTimeAgo';
import { joinEvents } from '../components/event-presentation';
import { EventList } from '../components/EventList';
import { TimelineArt } from '../components/illustrations';
import { PanelHeader } from '../components/Panel';
import { formatAvailability, formatClock, formatDay, formatMs } from '../format';
import { useEvents } from '../useConsoleData';
import type { ExpiryItem } from './insights';
import { currentLatency, expiries, fleetDays, recentLatency, seriesStats } from './insights';
import type { OverviewMonitor } from './types';

/**
 * Overview and event cards, drawn from data already on the page.
 *
 * Memoised: a drawer toggle re-renders the page, and without it every toggle
 * rebuilt the recharts tree and reformatted dates. The parent passes a stable
 * `onOpenMonitor` so the memo actually holds.
 * 使用 memo；否则抽屉开关会重建图表树，父级需传稳定回调。
 */
export const MonitorInsights = memo(function MonitorInsights({
  monitors,
  onOpenMonitor,
}: {
  monitors: OverviewMonitor[];
  onOpenMonitor: (id: string) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
      <PerformanceCard monitors={monitors} />
      <ActivityCard monitors={monitors} onOpenMonitor={onOpenMonitor} />
    </div>
  );
});

type Metric = 'latency' | 'availability';
type Range = 'recent' | 'days';

function PerformanceCard({ monitors }: { monitors: OverviewMonitor[] }) {
  const t = useTranslations('admin.insights');
  const { locale } = useLocale();
  const [metric, setMetric] = useState<Metric>('latency');
  const [range, setRange] = useState<Range>('recent');

  const recent = useMemo(() => recentLatency(monitors), [monitors]);
  const days = useMemo(() => fleetDays(monitors), [monitors]);
  const now = useMemo(() => currentLatency(monitors), [monitors]);

  /*
    Availability only exists per day, so the range control is a latency-only
    choice and disappears with it rather than offering a "recent availability"
    the data cannot draw.

    可用率只有按日数据，因此范围控件仅用于延迟；切换到可用率时隐藏，
    避免提供数据无法绘制的“近期可用率”。
  */
  const view: 'recent' | 'daysLatency' | 'daysAvailability' =
    metric === 'availability' ? 'daysAvailability' : range === 'recent' ? 'recent' : 'daysLatency';

  const { points, bands } = useMemo(() => {
    if (view === 'recent') {
      const pts: TrendPoint[] = recent.map((b) => ({
        t: b.t,
        value: b.avg,
        note: b.failures ? t('failedNote', { n: b.failures, total: b.checks }) : undefined,
      }));
      return { points: pts, bands: mergeBands(recent.filter((b) => b.failures > 0).map((b) => b.t), 60) };
    }
    if (view === 'daysLatency') {
      return { points: days.map((d) => ({ t: d.t, value: d.latency })), bands: [] };
    }
    return {
      points: days.map((d) => ({ t: d.t, value: d.availability })),
      bands: mergeBands(
        days.filter((d) => d.availability !== null && d.availability < 99).map((d) => d.t),
        86400,
      ),
    };
  }, [days, recent, t, view]);

  const stats = useMemo(() => seriesStats(points.map((p) => p.value)), [points]);
  const isLatency = view !== 'daysAvailability';
  const format = isLatency ? formatMs : (v: number) => formatAvailability(v);
  const formatX = view === 'recent' ? (v: number) => formatClock(v, locale) : (v: number) => formatDay(v, locale);
  const formatTip =
    view === 'recent'
      ? (v: number) => new Date(v * 1000).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' })
      : (v: number) => new Date(v * 1000).toLocaleDateString(locale, { dateStyle: 'medium', timeZone: 'UTC' });

  // Availability is read near its ceiling; a zero baseline would flatten every
  // real dip into a line at the top of the card.
  // 可用率通常接近上限；若从零开始绘制，每次真实下降都会被压成卡片顶部的一条线。
  const floor = isLatency
    ? undefined
    : ([Math.max(0, Math.floor(Math.min(stats.min ?? 99, 99.5) - 0.5)), 100] as [number, number]);

  const figures = isLatency
    ? [
        ...(view === 'recent' ? [{ label: t('statNow'), value: formatMs(now) }] : []),
        { label: t('statAvg'), value: formatMs(stats.avg) },
        { label: 'P95', value: formatMs(stats.p95) },
        { label: t('statMax'), value: formatMs(stats.max) },
      ]
    : [
        { label: t('statAvg'), value: formatAvailability(stats.avg) },
        { label: t('statLowest'), value: formatAvailability(stats.min) },
        { label: t('statDays'), value: String(points.filter((p) => p.value !== null).length) },
      ];

  const hasData = points.some((p) => p.value !== null);

  return (
    <section className="polaris-card flex min-w-0 flex-col p-5 xl:col-span-2">
      <PanelHeader
        title={t('title')}
        description={t('subtitle')}
        className="mb-3"
        actions={
          <Segmented
            label={t('title')}
            value={metric}
            onChange={setMetric}
            options={[
              { value: 'latency', label: t('metricLatency') },
              { value: 'availability', label: t('metricAvailability') },
            ]}
          />
        }
      />

      <div className="mb-4 flex flex-wrap items-end gap-x-8 gap-y-2">
        {figures.map((figure) => (
          <div key={figure.label} className="min-w-[4.5rem]">
            <p className="text-[12px] text-[var(--polaris-ink-3)]">{figure.label}</p>
            <p className="polaris-num mt-0.5 text-[18px] leading-6 font-semibold tracking-[-0.01em] text-[var(--polaris-ink)]">{figure.value}</p>
          </div>
        ))}
        {isLatency ? (
          <Segmented
            className="ml-auto"
            label={t('metricLatency')}
            value={range}
            onChange={setRange}
            options={[
              { value: 'recent', label: t('rangeRecent') },
              { value: 'days', label: t('range90') },
            ]}
          />
        ) : null}
      </div>

      {hasData ? (
        <TrendChart
          data={points}
          label={isLatency ? t('chartLatency') : t('chartAvailability')}
          format={format}
          formatX={formatX}
          formatTip={formatTip}
          bands={bands}
          domain={floor}
          height={240}
        />
      ) : (
        <div className="polaris-well polaris-grid-bg flex h-[240px] flex-col items-center justify-center gap-2 px-6 text-center">
          <ChartSpline size={20} className="text-[var(--polaris-ink-4)]" aria-hidden="true" />
          <p className="max-w-sm text-[12.5px] text-[var(--polaris-ink-3)]">{isLatency && view === 'recent' ? t('noLatency') : t('noDays')}</p>
        </div>
      )}
    </section>
  );
}

/** Merge per-bucket failure marks into contiguous bands. / 将每个数据桶的故障标记合并为连续色带。 */
function mergeBands(starts: number[], width: number): Array<{ x1: number; x2: number }> {
  const out: Array<{ x1: number; x2: number }> = [];
  for (const start of [...starts].sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    if (last && start <= last.x2) last.x2 = start + width;
    else out.push({ x1: start, x2: start + width });
  }
  return out;
}

type ActivityTab = 'events' | 'expiry';

function ActivityCard({
  monitors,
  onOpenMonitor,
}: {
  monitors: OverviewMonitor[];
  onOpenMonitor: (id: string) => void;
}) {
  const t = useTranslations('admin');
  const [tab, setTab] = useState<ActivityTab>('events');
  const events = useEvents(30);
  const rows = useMemo(
    () => joinEvents(events.data?.events ?? [], monitors).slice(0, 6),
    [events.data, monitors],
  );
  const lapses = useMemo(() => expiries(monitors).slice(0, 6), [monitors]);

  return (
    <section className="polaris-card flex min-w-0 flex-col p-5">
      <PanelHeader
        title={t('insights.activity')}
        className="mb-3"
        actions={
          <Segmented
            label={t('insights.activity')}
            value={tab}
            onChange={setTab}
            options={[
              { value: 'events', label: t('insights.tabEvents') },
              { value: 'expiry', label: t('insights.tabExpiry') },
            ]}
          />
        }
      />

      <div className="-mx-3 flex min-h-[240px] flex-1 flex-col">
        {tab === 'events' ? (
          rows.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center text-center">
              <TimelineArt />
              <p className="mt-3 text-[12.5px] text-[var(--polaris-ink-3)]">{t('console.eventsEmpty')}</p>
            </div>
          ) : (
            <EventList
              dense
              rows={rows}
              onPick={(row) => {
                if (row.monitor) onOpenMonitor(row.monitor_id);
              }}
            />
          )
        ) : lapses.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
            <ShieldCheck size={22} className="text-[var(--polaris-ink-4)]" aria-hidden="true" />
            <p className="max-w-xs text-[12.5px] text-[var(--polaris-ink-3)]">{t('insights.expiryEmpty')}</p>
          </div>
        ) : (
          <ul className="flex flex-col">
            {lapses.map((item) => (
              <ExpiryRow key={`${item.monitor.id}:${item.kind}`} item={item} onOpen={() => onOpenMonitor(item.monitor.id)} />
            ))}
          </ul>
        )}
      </div>

      {tab === 'events' && rows.length > 0 ? (
        <Link
          to="/admin/settings#settings-events"
          className="mt-3 self-start text-[12.5px] font-medium text-[var(--polaris-ink-2)] hover:text-[var(--polaris-ink)] hover:underline"
        >
          {t('console.viewAll')}
        </Link>
      ) : null}
    </section>
  );
}

/** One certificate or domain lifetime; bar scale is 90 days, tone follows the add-on verdict. / 单个证书/域名剩余时间；横条按 90 天，色调跟随附加检查结论。 */
function ExpiryRow({ item, onOpen }: { item: ExpiryItem; onOpen: () => void }) {
  const t = useTranslations('admin.insights');
  const ago = useTimeAgo();
  const expired = item.days !== null && item.days <= 0;
  const tone = item.st === 0 || expired ? 'down' : item.st === 2 ? 'warn' : 'up';
  const label =
    item.st === 0 && !expired
      ? t('checkFailed')
      : item.days === null
        ? t('unknownDays')
        : expired
          ? t('expired')
          : t('daysLeft', { n: Math.round(item.days) });

  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-[var(--polaris-hover)]"
      >
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-[var(--polaris-line)] text-[var(--polaris-ink-3)]">
          {item.kind === 'ssl' ? <ShieldCheck size={14} /> : <CalendarClock size={14} />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="truncate text-[13px] font-medium text-[var(--polaris-ink)]">{item.monitor.name}</span>
            <span className="shrink-0 text-[11.5px] text-[var(--polaris-ink-4)]">
              {item.kind === 'ssl' ? t('kindSsl') : t('kindDomain')}
            </span>
          </span>
          <Meter
            value={item.days === null ? null : Math.min(100, (Math.max(0, item.days) / 90) * 100)}
            tone={tone === 'up' ? 'primary' : tone}
            className="mt-2"
          />
        </span>
        <span className="flex shrink-0 flex-col items-end">
          <span
            className={clsx(
              'polaris-num text-[12.5px] font-semibold',
              tone === 'down' ? 'text-danger-600' : tone === 'warn' ? 'text-warning-700' : 'text-[var(--polaris-ink)]',
            )}
          >
            {label}
          </span>
          <span className="text-[11px] text-[var(--polaris-ink-4)]">{ago(item.checkedAt)}</span>
        </span>
      </button>
    </li>
  );
}
