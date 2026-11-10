import { formatRate } from '@/admin/format';
import { useLocale } from '@/i18n/IntlProvider';
import { useReducedMotion } from '@/lib/useReducedMotion';
import clsx from 'clsx';
import { X } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import type { PublicServer } from '../../../../shared/public-servers';
import { attentionOf, fleetSummary, percentText } from './model';
import { Identity, LiveTrend, NetRates, Recency, ResourceLine, StatusBadge, uptimeText } from './ServerParts';
import type { LiveSeries } from './useVisitorState';

const PAGE_MS = 12_000;
const TILE_HEIGHT = 212;
const GAP = 16;
const RANK = { offline: 0, critical: 1, warning: 2 } as const;

/**
 * The wall display: every machine large enough to read across a room, machines needing a look first,
 * paging on its own when they do not fit one screen. Esc leaves.
 *
 * 墙板模式：机器以远处可读的尺寸显示，需要关注的排在最前；一屏放不下时自动翻页，按 Esc 退出。
 */
export function WallView({ servers, live, now, title, icon, updatedAt, onExit }: {
  servers: PublicServer[]; live: LiveSeries; now: number; title: string; icon: React.ReactNode; updatedAt: number | null; onExit: () => void;
}) {
  const t = useTranslations('presentation');
  const { locale } = useLocale();
  const reduced = useReducedMotion();
  const grid = useRef<HTMLDivElement>(null);
  const [capacity, setCapacity] = useState(12);
  const [page, setPage] = useState(0);
  const [clock, setClock] = useState(() => new Date());
  const summary = fleetSummary(servers);
  const ordered = useMemo(() => [...servers].sort((a, b) => {
    const left = attentionOf(a), right = attentionOf(b);
    return (left ? RANK[left] : 9) - (right ? RANK[right] : 9) || a.name.localeCompare(b.name, locale, { numeric: true });
  }), [servers, locale]);
  const pages = Math.max(1, Math.ceil(ordered.length / capacity));
  const current = Math.min(page, pages - 1);

  useLayoutEffect(() => {
    const node = grid.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const columns = Math.max(1, Math.floor((node.clientWidth + GAP) / (300 + GAP)));
      const rows = Math.max(1, Math.floor((node.clientHeight + GAP) / (TILE_HEIGHT + GAP)));
      setCapacity(columns * rows);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    measure();
    return () => observer.disconnect();
  }, []);
  useEffect(() => { const timer = window.setInterval(() => setClock(new Date()), 1000); return () => window.clearInterval(timer); }, []);
  useEffect(() => {
    if (pages < 2) return;
    const timer = window.setInterval(() => setPage(value => (value + 1) % pages), PAGE_MS);
    return () => window.clearInterval(timer);
  }, [pages]);

  return (
    <div className="server-wall fixed inset-0 z-50 flex flex-col bg-[var(--polaris-canvas)] text-[var(--polaris-ink)]" role="region" aria-label={t('wallMode')}>
      <header className="flex flex-wrap items-center gap-x-8 gap-y-3 border-b border-[var(--polaris-line)] px-6 py-4 sm:px-8">
        <span className="flex min-w-0 items-center gap-3">{icon}<span className="truncate text-[18px] font-semibold tracking-[-0.02em]">{title}</span></span>
        <dl className="flex flex-wrap items-baseline gap-x-8 gap-y-2">
          <WallFact label={t('statOnline')} value={`${summary.online}/${summary.total}`} tone={summary.offline ? 'text-danger-600' : undefined} />
          {servers.some(server => server.cpu !== undefined) ? <WallFact label={t('averageCpu')} value={percentText(summary.cpu)} /> : null}
          {servers.some(server => server.upload !== undefined || server.download !== undefined) ? <WallFact label={t('networkLive')} value={`${formatRate(summary.upload)} / ${formatRate(summary.download)}`} /> : null}
          <WallFact label={t('needsAttention')} value={String(summary.attention)} tone={summary.attention ? 'text-danger-600' : 'text-success-700'} />
        </dl>
        <span className="ml-auto flex items-center gap-4">
          <time className="polaris-num text-[26px] font-semibold tracking-[-0.02em]" dateTime={clock.toISOString()}>{clock.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
          <button type="button" onClick={onExit} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[var(--polaris-line)] px-3 text-[13px] text-[var(--polaris-ink-2)] transition-colors hover:border-[var(--polaris-line-strong)] hover:text-[var(--polaris-ink)]">
            <X size={15} aria-hidden="true" />{t('exitWall')}<kbd className="polaris-kbd ml-1">Esc</kbd>
          </button>
        </span>
      </header>
      <div ref={grid} className="min-h-0 flex-1 overflow-hidden px-6 py-5 sm:px-8">
        <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gridAutoRows: TILE_HEIGHT }} aria-live="polite">
          {ordered.slice(current * capacity, (current + 1) * capacity).map(server => (
            <article key={server.id} className={clsx('polaris-card flex min-w-0 flex-col gap-3 p-4', attentionOf(server) === 'offline' && 'border-danger/35 bg-danger/[0.035]', attentionOf(server) === 'critical' && 'border-warning/45')}>
              <div className="flex items-start gap-2"><Identity server={server} as="h3" className="min-w-0 flex-1" /><StatusBadge server={server} /></div>
              <div className="flex flex-col gap-2.5">{(['cpu', 'memory', 'disk'] as const).map(kind => <ResourceLine key={kind} kind={kind} server={server} detail={false} />)}</div>
              {server.cpu !== undefined ? <LiveTrend samples={live[server.id]} field="cpu" max={100} height={22} className={server.online === true ? 'text-[var(--polaris-chart)]' : 'text-[var(--polaris-ink-4)]'} /> : null}
              <div className="mt-auto flex items-center gap-3 text-[12px] text-[var(--polaris-ink-3)]">
                <NetRates server={server} />
                {server.uptime !== undefined ? <span className="polaris-num">{uptimeText(server)}</span> : null}
                <Recency server={server} now={now} className="ml-auto" />
              </div>
            </article>
          ))}
        </div>
      </div>
      <footer className="flex items-center gap-4 border-t border-[var(--polaris-line)] px-6 py-2.5 text-[12px] text-[var(--polaris-ink-3)] sm:px-8">
        <span className="polaris-num">{t('wallPage', { page: current + 1, total: pages })}</span>
        {pages > 1 ? <span className="relative h-1 flex-1 overflow-hidden rounded-full bg-[var(--polaris-active)]"><span key={`${current}:${pages}`} className={clsx('server-wall-progress absolute inset-y-0 left-0 rounded-full bg-[var(--polaris-ink)] opacity-50', reduced && 'is-static')} style={{ animationDuration: `${PAGE_MS}ms` }} /></span> : <span className="flex-1" />}
        {updatedAt ? <span className="polaris-num">{t('updatedAt', { time: new Date(updatedAt).toLocaleTimeString(locale) })}</span> : null}
      </footer>
    </div>
  );
}

function WallFact({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return <div className="flex items-baseline gap-2"><dt className="text-[12px] text-[var(--polaris-ink-3)]">{label}</dt><dd className={clsx('polaris-num text-[18px] font-semibold tracking-[-0.01em]', tone)}>{value}</dd></div>;
}
