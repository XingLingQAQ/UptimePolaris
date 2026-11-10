import { Drawer } from '@/components/ui/MotionOverlays';
import { TrendChart, type TrendPoint } from '@/components/charts/TrendChart';
import { AvailabilityRail } from '@/components/monitor/AvailabilityRail';
import { useLocale } from '@/i18n/IntlProvider';
import { Button, DrawerBody, DrawerContent, DrawerFooter, DrawerHeader } from '@heroui/react';
import clsx from 'clsx';
import { ArrowUpRight, CalendarClock, Loader2, Pause, Pencil, Play, ShieldCheck } from 'lucide-react';
import { useMemo } from 'react';
import { Link } from 'react-router';
import { useTranslations } from 'use-intl';
import { MonitorGlyph } from '../../components/monitor/MonitorGlyph';
import { useTimeAgo } from '../../hooks/useTimeAgo';
import type { Tone } from '../../types/tone';
import { KeyValueList } from '../components/ConsolePrimitives';
import { EventList } from '../components/EventList';
import { joinEvents } from '../components/event-presentation';
import { formatAvailability, formatClock, formatMs, formatPercent } from '../format';
import { useEvents } from '../useConsoleData';
import { CheckRail, StatusPill, TypeBadge } from './MonitorIndicators';
import { seriesStats } from './insights';
import { tagKey } from './options';
import { TYPE_LABEL, readingLabel, toneForStatus } from './presentation';
import type { AddonReading, OverviewMonitor } from './types';

/**
 * One monitor, in the detail its row has no room for.
 *
 * A drawer rather than a page: the operator opens it from the table to answer
 * "what is this one doing", and the table - with every other monitor - should
 * still be beside it when they close it. The public `/monitor/:id` page remains
 * one click away for the long view.
 *
 * Everything here is already in the overview response: the ring gives the last
 * checks and their latency, the rollup gives 90 days, the add-on readings give
 * the lifetimes. Only the event list is a second read, and it is the shared one
 * the header already holds.
 *
 * 从表格打开抽屉查看单个监控项的详情，关闭后仍可返回同一列表；公开 `/monitor/:id`
 * 详情页也可通过链接打开。数据均来自概览响应：圆环提供近期检查与延迟、汇总覆盖
 * 90 天、附加项提供有效期；只有事件列表需要第二次读取，且复用页头已有请求。
 */
export function MonitorQuickView({
  monitor,
  groupName,
  busy,
  onClose,
  onEdit,
  onToggle,
}: {
  monitor: OverviewMonitor | null;
  groupName?: string;
  busy: boolean;
  onClose: () => void;
  onEdit: () => void;
  onToggle: () => void;
}) {
  return (
    <Drawer isOpen={monitor !== null} onOpenChange={(open) => !open && onClose()} placement="right" size="lg" scrollBehavior="inside">
      <DrawerContent className="bg-[var(--polaris-panel)]">
        {monitor ? (
          <QuickViewBody monitor={monitor} groupName={groupName} busy={busy} onEdit={onEdit} onToggle={onToggle} />
        ) : null}
      </DrawerContent>
    </Drawer>
  );
}

function QuickViewBody({
  monitor: m,
  groupName,
  busy,
  onEdit,
  onToggle,
}: {
  monitor: OverviewMonitor;
  groupName?: string;
  busy: boolean;
  onEdit: () => void;
  onToggle: () => void;
}) {
  const t = useTranslations('admin');
  const { locale } = useLocale();
  const ago = useTimeAgo();
  const events = useEvents(50);
  const paused = m.active === 0;
  const isPush = m.type === 'push';
  const reportedAt = isPush ? m.push_last_received_at ?? 0 : m.checked_at;
  const tone: Tone = paused ? 'idle' : toneForStatus(m.st);

  const statusLabel = paused
    ? t('status.paused')
    : m.st === null
      ? t('status.unknown')
      : t(`status.${m.st === 1 ? 'up' : m.st === 4 ? 'pending' : m.st === 2 ? 'warn' : 'down'}`);

  // The ring's `ms` is a latency for http/tcp and CPU percent for agent rows;
  // push monitors measure nothing, so they get the status rail alone.
  // HTTP/TCP 的 `ms` 表示延迟，Agent 表示 CPU 百分比；Push 监控项只显示状态条。
  const measures = m.type !== 'push';
  const series = useMemo<TrendPoint[]>(
    () =>
      (m.ring ?? []).map((beat) => {
        const ms = (beat as { ms?: number | null }).ms;
        return {
          t: beat.t,
          value: beat.up !== 0 && typeof ms === 'number' && Number.isFinite(ms) ? ms : null,
          note: beat.up === 0 ? t('status.down') : undefined,
        };
      }),
    [m.ring, t],
  );
  const failures = useMemo(
    () =>
      (m.ring ?? [])
        .filter((beat) => beat.up === 0)
        .map((beat) => ({ x1: beat.t - m.interval_sec / 2, x2: beat.t + m.interval_sec / 2 })),
    [m.interval_sec, m.ring],
  );
  const stats = useMemo(() => seriesStats(series.map((p) => p.value)), [series]);
  const isCpu = m.type === 'agent';
  const fmt = isCpu ? (v: number) => formatPercent(v, 0) : formatMs;

  const ownEvents = useMemo(
    () => joinEvents((events.data?.events ?? []).filter((e) => e.monitor_id === m.id), [m]).slice(0, 5),
    [events.data, m],
  );

  const figures = [
    {
      label: t(isPush ? 'quick.lastPush' : 'quick.current'),
      value: isPush ? (m.push_last_received_at ? ago(m.push_last_received_at) : '—') : paused || m.checked_at === 0 || (m.st === 0 && !m.v) ? '—' : (readingLabel(m.v, m.st, m.type) ?? '—'),
    },
    ...(!isPush ? [{ label: isCpu ? t('quick.avgCpu') : t('quick.avgLatency'), value: measures ? fmt(stats.avg ?? Number.NaN) : '—' }] : []),
    { label: t('col.uptime'), value: m.has_history ? formatAvailability(m.uptime) : '—' },
    { label: t(isPush ? 'quick.pushTimeout' : 'quick.interval'), value: isPush ? `${m.interval_sec}s` : t('quick.everySec', { n: m.interval_sec }) },
  ];

  return (
    <>
      <DrawerHeader className="flex flex-col gap-3.5 border-b border-[var(--polaris-line)] px-6 pt-5 pb-4">
        <div className="flex items-center gap-3.5 pr-6">
          <MonitorGlyph type={m.type} target={m.target} monitorId={m.num_id} size="lg" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[16px] font-semibold tracking-[-0.01em]">{m.name}</p>
            <p className="mt-0.5 truncate font-mono text-[11.5px] font-normal text-[var(--polaris-ink-3)]" title={m.type === 'push' ? undefined : m.target}>
              {m.type === 'push' ? t('list.pushInbound') : m.target || TYPE_LABEL[m.type]}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusPill tone={tone} label={statusLabel} pulse={!paused && m.st === 0} />
          <TypeBadge type={m.type} />
          {m.tags?.map((tag) => (
            <span
              key={tagKey(tag)}
              className="inline-flex h-[22px] items-center gap-1 rounded-full border border-[var(--polaris-line)] px-2 text-[11.5px] font-normal text-[var(--polaris-ink-2)]"
            >
              <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: tag.color }} />
              {tag.name}
            </span>
          ))}
          {reportedAt > 0 ? (
            <span className="ml-auto text-[12px] font-normal text-[var(--polaris-ink-4)]">
              {t(isPush ? 'quick.lastPush' : 'quick.lastCheck')} · {ago(reportedAt)}
            </span>
          ) : null}
        </div>
      </DrawerHeader>

      <DrawerBody className="polaris-scroll-x min-h-0 gap-4 px-6 py-5">
        {m.st === 0 && m.msg && !paused ? (
          <p className="rounded-[10px] border border-danger/20 bg-danger/[0.04] px-3.5 py-2.5 text-[13px] text-danger-600">{m.msg}</p>
        ) : null}

        <div className={clsx('polaris-card grid grid-cols-2 overflow-hidden', isPush ? 'sm:grid-cols-3' : 'sm:grid-cols-4')}>
          {figures.map((figure) => (
            <div key={figure.label} className="-mt-px -ml-px border-t border-l border-[var(--polaris-line-soft)] px-4 py-3">
              <p className="truncate text-[12px] text-[var(--polaris-ink-3)]">{figure.label}</p>
              <p className="polaris-num mt-1 truncate text-[18px] leading-6 font-semibold tracking-[-0.01em]">{figure.value}</p>
            </div>
          ))}
        </div>

        <section className="polaris-card p-4">
          <div className="mb-3 flex items-baseline gap-2">
            <h3 className="text-[13.5px] font-semibold">{t(isPush ? 'quick.pushChecks' : 'quick.recentChecks')}</h3>
            <span className="polaris-num text-[12px] text-[var(--polaris-ink-4)]">{m.ring?.length ?? 0}</span>
          </div>
          {measures && series.some((p) => p.value !== null) ? (
            <TrendChart
              data={series}
              label={isCpu ? t('quick.cpuSeries') : t('insights.metricLatency')}
              format={fmt}
              formatX={(v) => formatClock(v, locale)}
              formatTip={(v) => new Date(v * 1000).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' })}
              bands={failures}
              domain={isCpu ? [0, 100] : undefined}
              height={180}
            />
          ) : null}
          <CheckRail ring={m.ring ?? []} emptyLabel={t('list.noHistory')} max={60} className={measures ? 'mt-3' : undefined} />
          {isPush ? <p className="mt-3 text-[12.5px] leading-relaxed text-[var(--polaris-ink-3)]">{t(m.push_last_received_at ? 'quick.pushHint' : 'quick.pushWaiting')}</p> : null}
        </section>

        <section className="polaris-card p-4">
          <div className="mb-3 flex items-baseline gap-2">
            <h3 className="text-[13.5px] font-semibold">{t('quick.days90')}</h3>
            {m.has_history ? (
              <span className="polaris-num ml-auto text-[13.5px] font-semibold">{formatAvailability(m.uptime)}</span>
            ) : null}
          </div>
          <AvailabilityRail days={m.days ?? []} emptyLabel={t('list.noHistory')} />
          <div className="mt-1.5 flex justify-between text-[11px] text-[var(--polaris-ink-4)]">
            <span>{t('quick.daysStart')}</span>
            <span>{t('quick.daysEnd')}</span>
          </div>
        </section>

        {m.check_ssl === 1 || m.check_domain === 1 || (m.check_dns === 1 && m.dns) ? (
          <section className="polaris-card p-4">
            <h3 className="mb-3 text-[13.5px] font-semibold">{t('form.addons')}</h3>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {m.check_ssl === 1 ? (
                <AddonCard icon={<ShieldCheck />} label={t('insights.kindSsl')} reading={m.ssl} warnDays={m.warn_days} />
              ) : null}
              {m.check_domain === 1 ? (
                <AddonCard icon={<CalendarClock />} label={t('insights.kindDomain')} reading={m.domain} warnDays={m.warn_days} />
              ) : null}
            </div>
            {m.check_dns === 1 && m.dns ? (
              <div className="polaris-well mt-2 px-3.5 py-2.5">
                <p className="flex items-center gap-2 text-[12.5px]">
                  <span className="font-medium">DNS</span>
                  <span className={clsx(m.dns.st === 1 ? 'text-success-700' : 'text-warning-700')}>
                    {m.dns.st === 1 ? t('status.up') : m.dns.msg || t('status.warn')}
                  </span>
                </p>
                {m.dns.records?.length ? (
                  <p className="mt-1 font-mono text-[11px] break-all text-default-500">{m.dns.records.join(', ')}</p>
                ) : null}
              </div>
            ) : null}
          </section>
        ) : null}

        <section className="polaris-card p-4">
          <h3 className="mb-2 text-[13.5px] font-semibold">{t('quick.events')}</h3>
          {ownEvents.length === 0 ? (
            <p className="py-3 text-[12.5px] text-[var(--polaris-ink-4)]">{t('quick.noEvents')}</p>
          ) : (
            <EventList rows={ownEvents} dense className="-mx-3" />
          )}
        </section>

        <KeyValueList
          items={[
            { label: t('form.type'), value: t(`type.${m.type}`) },
            ...(m.type === 'push' ? [] : [{ label: t('quick.target'), value: m.target || '—', mono: true }]),
            ...(!isPush ? [{ label: t('quick.timeout'), value: formatMs(m.timeout_ms) }] : []),
            { label: t('form.group'), value: groupName ?? t('quick.ungrouped') },
            ...(!isPush ? [{
              label: t('form.probeSource'),
              value: m.source === 'agent'
                ? `Agent · ${m.source_name ?? m.source_id ?? ''}${m.source_pending ? ` (${t('form.sourcePendingBadge')})` : m.source_available === false ? ` (${t('form.sourceUnavailableBadge')})` : ''}`
                : t(m.source === 'server' ? 'form.serverSource' : 'form.workerSource'),
            }] : []),
            ...(m.source === 'agent' && m.source_last_observed_at
              ? [{ label: t('quick.lastProbe'), value: formatClock(m.source_last_observed_at, locale) }]
              : []),
            {
              label: t('quick.created'),
              value: new Date(m.created_at * 1000).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' }),
            },
          ]}
        />
      </DrawerBody>

      <DrawerFooter className="border-t border-[var(--polaris-line)] px-6 py-3.5">
        {m.is_public !== 0 ? <Button
          as={Link}
          to={`/monitor/${m.num_id}`}
          size="sm"
          variant="light"
          className="mr-auto text-[var(--polaris-ink-2)]"
          endContent={<ArrowUpRight size={14} />}
        >
          {t('quick.openPublic')}
        </Button> : <span className="mr-auto text-tiny text-default-500">{t('list.private')}</span>}
        <Button
          size="sm"
          variant="bordered"
          startContent={busy ? <Loader2 className="animate-spin" size={15} /> : paused ? <Play size={15} /> : <Pause size={15} />}
          isDisabled={busy}
          onPress={onToggle}
        >
          {paused ? t('action.resume') : t('action.pause')}
        </Button>
        <Button size="sm" color="primary" startContent={<Pencil size={14} />} onPress={onEdit}>
          {t('action.edit')}
        </Button>
      </DrawerFooter>
    </>
  );
}

function AddonCard({
  icon,
  label,
  reading,
  warnDays,
}: {
  icon: React.ReactNode;
  label: string;
  reading: AddonReading | undefined;
  warnDays: number;
}) {
  const t = useTranslations('admin');
  const ago = useTimeAgo();
  const days = reading?.days ?? null;
  const fresh = reading && reading.ts > 0;
  const tone = !fresh ? 'idle' : reading.st === 0 || (days !== null && days <= 0) ? 'down' : reading.st === 2 ? 'warn' : 'up';

  return (
    <div className="polaris-well flex items-start gap-3 px-3.5 py-3">
      <span
        className={clsx(
          'mt-0.5 inline-flex shrink-0 [&>svg]:h-4 [&>svg]:w-4',
          tone === 'down' ? 'text-danger-600' : tone === 'warn' ? 'text-warning-700' : 'text-[var(--polaris-ink-4)]',
        )}
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[12px] text-[var(--polaris-ink-3)]">{label}</p>
        <p
          className={clsx(
            'polaris-num text-[14px] font-semibold whitespace-nowrap',
            tone === 'down' ? 'text-danger-600' : tone === 'warn' ? 'text-warning-700' : 'text-[var(--polaris-ink)]',
          )}
        >
          {!fresh
            ? t('list.neverChecked')
            : days === null
              ? t('insights.unknownDays')
              : days <= 0
                ? t('insights.expired')
                : t('insights.daysLeft', { n: Math.round(days) })}
        </p>
        {fresh ? (
          <p className="mt-0.5 truncate text-[11px] text-[var(--polaris-ink-4)]">
            {t('quick.warnAt', { n: warnDays })} · {ago(reading.ts)}
          </p>
        ) : null}
      </div>
    </div>
  );
}
