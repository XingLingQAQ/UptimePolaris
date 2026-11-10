import { usePageConfig } from '@/components/context/PageConfigContext';
import { usePresentationView } from '@/components/context/PresentationViewContext';
import { getMonitorDetailPath } from '@/components/monitor/card-presentation';
import { MonitorGlyph } from '@/components/monitor/MonitorGlyph';
import { SparkLine } from '@/components/ui/MetricFigures';
import { useTimeAgo } from '@/hooks/useTimeAgo';
import type { ExpiryBadge, Heartbeat, Monitor } from '@/types/monitor';
import clsx from 'clsx';
import { CalendarClock, ChevronRight, ShieldCheck, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Link, useLocation } from 'react-router';
import { useTranslations } from 'use-intl';
import { HeartbeatRail } from './HeartbeatRail';
import {
  STATUS_INK,
  STATUS_KEY,
  monitorStatus,
  readingText,
  uptimeInk,
  uptimeText,
  type PublicStatus,
} from './status';

interface ItemProps {
  monitor: Monitor;
  heartbeats: Heartbeat[];
  uptime24h: number | null;
}

/** The wash a row takes for a moment when its state changes, in the new state's tone. / 状态变化时短暂显示的新状态色背景。 */
const FLASH: Record<PublicStatus, string> = {
  up: 'rgb(16 185 129 / 0.10)',
  down: 'rgb(239 68 68 / 0.13)',
  warn: 'rgb(245 158 11 / 0.13)',
  pending: 'rgb(245 158 11 / 0.13)',
  unknown: 'rgb(161 161 170 / 0.14)',
};

/**
 * The state a row flashes after it changes, for a moment.
 *
 * Only a change seen while the page is open flashes: the first render records
 * the state without announcing it, so a visitor who keeps the page up sees a
 * monitor go down or recover as the refresh lands.
 * 首次渲染只记录状态，不闪烁；页面打开后的变化才提示。
 */
function useStatusFlash(status: PublicStatus): PublicStatus | null {
  const previous = useRef(status);
  const [flash, setFlash] = useState<PublicStatus | null>(null);
  useEffect(() => {
    if (previous.current === status) return;
    previous.current = status;
    setFlash(status);
    const id = window.setTimeout(() => setFlash(null), 2600);
    return () => window.clearTimeout(id);
  }, [status]);
  return flash;
}

/** Unix seconds of the newest check, or null when there is none. / 最近一次检查的 Unix 秒数；没有检查时为 null。 */
function lastCheckAt(heartbeats: Heartbeat[]): number | null {
  const last = heartbeats[heartbeats.length - 1];
  if (!last) return null;
  const ms = new Date(last.time).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/** The glyph's corner light for a status. / 状态对应的图标角标指示灯。 */
function badgeFor(status: PublicStatus): 'up' | 'down' | 'pending' | 'idle' {
  if (status === 'up') return 'up';
  if (status === 'down') return 'down';
  if (status === 'warn' || status === 'pending') return 'pending';
  return 'idle';
}

/** Expiry chip; outer element carries the tone, inner the legible ink. / 到期徽标；外层带语义色，内层保证可读。 */
export function ExpiryTag({ badge }: { badge: ExpiryBadge }) {
  const text = `${badge.kind === 'ssl' ? 'SSL' : 'DOMAIN'} ${badge.days === null ? '—' : `${Math.round(badge.days)}d`}`;
  const Icon = badge.status === 1 ? (badge.kind === 'ssl' ? ShieldCheck : CalendarClock) : TriangleAlert;
  return (
    <span
      title={badge.message || undefined}
      className={clsx(badge.status === 2 ? 'text-warning' : badge.status === 0 ? 'text-danger' : undefined)}
    >
      <span
        className={clsx(
          'polaris-num inline-flex items-center gap-1 whitespace-nowrap [&>svg]:h-3 [&>svg]:w-3',
          badge.status === 2 ? 'text-warning-700' : badge.status === 0 ? 'text-danger-600' : 'text-[var(--polaris-ink-3)]',
        )}
      >
        <Icon aria-hidden="true" />
        {text}
      </span>
    </span>
  );
}

/** Tags as quiet pills: a dot in the tag's own colour, the words in ink. / 标签以低调胶囊显示：圆点使用标签颜色，文字使用正文色。 */
function Tags({ monitor, max = 3 }: { monitor: Monitor; max?: number }) {
  if (!monitor.tags?.length) return null;
  return (
    <>
      {monitor.tags.slice(0, max).map((tag) => (
        <span
          key={tag.id}
          className="inline-flex h-[18px] max-w-[10rem] shrink-0 items-center gap-1 truncate rounded-full border border-[var(--polaris-line)] px-1.5 text-[11px] text-[var(--polaris-ink-2)]"
        >
          <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: tag.color }} />
          <span className="truncate">
            {tag.name}
          </span>
        </span>
      ))}
      {monitor.tags.length > max ? <span data-full-text={monitor.tags.slice(max).map(tag => tag.name).join(', ')} className="text-[11px] text-[var(--polaris-ink-4)]">+{monitor.tags.length - max}</span> : null}
    </>
  );
}

/** The status word, its tone class kept on the outside for the same reason as `ExpiryTag`. / 状态文字的色调类保留在外层，原因与 `ExpiryTag` 相同。 */
function StatusWord({ status }: { status: PublicStatus }) {
  const t = useTranslations();
  return (
    <span className={clsx(status === 'down' && 'text-danger', status === 'pending' && 'text-warning')}>
      <span className={clsx('font-medium', STATUS_INK[status])}>{t(STATUS_KEY[status])}</span>
    </span>
  );
}

/** Everything about a monitor's state that fits on one grey line. / 一条灰色信息行内可容纳的监控状态信息。 */
function MetaLine({ monitor, heartbeats, status }: { monitor: Monitor; heartbeats: Heartbeat[]; status: PublicStatus }) {
  const t = useTranslations();
  const presentation = usePresentationView();
  const ago = useTimeAgo();
  const reading = readingText(monitor, heartbeats);
  const checked = monitor.type === 'push' ? monitor.pushLastReceivedAt : lastCheckAt(heartbeats);
  const parts: React.ReactNode[] = [];
  if (reading && status !== 'down' && presentation?.showLatency !== false) parts.push(<span key="reading" className="polaris-num">{reading}</span>);
  if (presentation?.showExpiry !== false) for (const badge of monitor.expiryBadges ?? []) parts.push(<ExpiryTag key={badge.kind} badge={badge} />);
  if (monitor.dns && monitor.dns.ts > 0 && monitor.dns.st !== 1) {
    parts.push(
      <span key="dns" title={monitor.dns.msg} className="text-warning">
        <span className="text-warning-700">DNS ✕</span>
      </span>,
    );
  }
  if (monitor.sourceAvailable === false) {
    parts.push(
      <span key="source" className="text-[var(--polaris-ink-3)]">
        {t('common.form.sourceUnavailableBadge')}
      </span>,
    );
  } else if (monitor.source === 'agent' && (monitor.sourceName || monitor.sourceId)) {
    parts.push(
      <span key="source" className="text-[var(--polaris-ink-4)]">
        Agent · {monitor.sourceName ?? monitor.sourceId}
      </span>,
    );
  }
  if (checked) {
    parts.push(
      <span key="ago" className="hidden text-[var(--polaris-ink-4)] sm:inline" title={monitor.type === 'push' ? t('common.quick.lastPush') : undefined}>
        {ago(checked)}
      </span>,
    );
  }

  return (
    <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12px] text-[var(--polaris-ink-3)]">
      <StatusWord status={status} />
      {parts.map((part, index) => (
        <span key={index} className="flex items-center gap-1.5">
          <span aria-hidden="true" className="text-[var(--polaris-ink-4)]">
            ·
          </span>
          {part}
        </span>
      ))}
    </div>
  );
}

/** One monitor row: mark, name and state, recent checks, daily availability. / 单条监控行：图标、名称状态、最近检查、当日可用率。 */
export function MonitorRow({ monitor, heartbeats, uptime24h }: ItemProps) {
  const presentation = usePresentationView();
  const { pageId } = usePageConfig();
  const { search } = useLocation();
  const status = monitorStatus(monitor, heartbeats);
  const ratio = monitor.sourceAvailable === false ? null : uptime24h;
  const flash = useStatusFlash(status);

  return (
    <li>
      <Link
        to={getMonitorDetailPath(monitor.id, pageId, search)}
        style={flash ? ({ '--polaris-flash': FLASH[flash] } as CSSProperties) : undefined}
        className={clsx(
          'group grid grid-cols-1 gap-3 px-4 transition-colors hover:bg-[var(--polaris-hover)] active:bg-[var(--polaris-active)] sm:px-5 md:grid-cols-[minmax(0,1fr)_minmax(0,300px)_4.75rem_1rem] md:items-center md:gap-6',
          presentation?.density === 'compact' ? 'py-2' : presentation?.density === 'comfortable' ? 'py-5' : 'py-3.5',
          flash && 'polaris-flash',
        )}
      >
        <div className="flex min-w-0 items-center gap-3">
          <span className="transition-[scale] duration-200 group-hover:scale-105">
            <MonitorGlyph type={monitor.type} target={monitor.url ?? ''} monitorId={monitor.id} badge={badgeFor(status)} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1.5">
              <h3 className="truncate text-[14px] font-medium text-[var(--polaris-ink)]">{monitor.name}</h3>
              <span className="hidden min-w-0 items-center gap-1 sm:flex">
                <Tags monitor={monitor} max={2} />
              </span>
            </div>
            <MetaLine monitor={monitor} heartbeats={heartbeats} status={status} />
          </div>
        </div>

        <div className="flex items-center gap-4 md:contents">
          {presentation?.showHistory !== false && <HeartbeatRail beats={heartbeats} max={40} className="min-w-0 flex-1" />}
          {presentation?.showAvailability !== false && <div className="w-[4.75rem] shrink-0 text-right">
            <span className={clsx('polaris-num block text-[13.5px] font-semibold', uptimeInk(ratio))}>{uptimeText(ratio)}</span>
            <span className="block text-[11px] text-[var(--polaris-ink-4)]">24h</span>
          </div>}
        </div>

        <ChevronRight
          size={16}
          aria-hidden="true"
          className="hidden text-[var(--polaris-ink-4)] transition-transform group-hover:translate-x-0.5 group-hover:text-[var(--polaris-ink-2)] md:block"
        />
      </Link>
    </li>
  );
}

/** One monitor card for the grid view. / 网格视图中的单张监控卡片。 */
export function MonitorTile({ monitor, heartbeats, uptime24h }: ItemProps) {
  const presentation = usePresentationView();
  const { pageId } = usePageConfig();
  const { search } = useLocation();
  const status = monitorStatus(monitor, heartbeats);
  const ratio = monitor.sourceAvailable === false ? null : uptime24h;
  const flash = useStatusFlash(status);
  const series = useMemo(
    () => heartbeats.slice(-60).map((beat) => ((beat.status !== 1 && beat.status !== 2) || beat.ping === null ? null : beat.ping)),
    [heartbeats],
  );
  const hasLine = monitor.type !== 'push' && series.filter((value) => value !== null).length > 1;

  return (
    <li className="min-w-0">
      <Link
        to={getMonitorDetailPath(monitor.id, pageId, search)}
        style={flash ? ({ '--polaris-flash': FLASH[flash] } as CSSProperties) : undefined}
        className={clsx(
          'polaris-card polaris-card-press group flex h-full flex-col gap-4 transition-[translate,box-shadow,border-color] duration-200 hover:-translate-y-0.5',
          presentation?.density === 'compact' ? 'p-3' : presentation?.density === 'comfortable' ? 'p-6' : 'p-4',
          flash && 'polaris-flash',
        )}
      >
        <div className="flex items-start gap-3">
          <span className="transition-[scale] duration-200 group-hover:scale-105">
            <MonitorGlyph type={monitor.type} target={monitor.url ?? ''} monitorId={monitor.id} badge={badgeFor(status)} />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-[14px] font-medium text-[var(--polaris-ink)]">{monitor.name}</h3>
            <MetaLine monitor={monitor} heartbeats={heartbeats} status={status} />
          </div>
          {presentation?.showAvailability !== false && <div className="shrink-0 text-right">
            <span className={clsx('polaris-num block text-[15px] leading-5 font-semibold', uptimeInk(ratio))}>{uptimeText(ratio)}</span>
            <span className="block text-[11px] text-[var(--polaris-ink-4)]">24h</span>
          </div>}
        </div>

        {presentation?.showLatency === false || monitor.type === 'push' ? null : hasLine ? (
          <SparkLine values={series} height={44} className="text-[var(--polaris-chart)]" />
        ) : (
          <div className="h-11 rounded-lg bg-[var(--polaris-well)]" aria-hidden="true" />
        )}

        {presentation?.showHistory !== false && <HeartbeatRail beats={heartbeats} max={30} height="h-5" />}

        {monitor.tags?.length ? (
          <div className="flex flex-wrap items-center gap-1">
            <Tags monitor={monitor} max={4} />
          </div>
        ) : null}
      </Link>
    </li>
  );
}
